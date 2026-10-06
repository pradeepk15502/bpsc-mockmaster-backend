import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { audit } from '../lib/audit.js';
import { hashPassword, hmacHex, otpCode, safeEqual, verifyPassword } from '../lib/crypto.js';
import { exec, one, tx } from '../lib/db.js';
import { AppError, badRequest, forbidden } from '../lib/errors.js';
import { LIMITS } from '../lib/ratelimit.js';
import { actorOf, noStore, parse, studentOf } from '../http.js';
import { adminGuard, createSession, destroySession, studentGuard } from './sessions.js';
import { ROLES } from './rbac.js';
import { logEvent } from './events.js';

const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const ADMIN_MAX_FAILS = 5;
const ADMIN_LOCK_MS = 15 * 60_000;
// A real scrypt hash of a random string: verifying against it keeps timing similar when the email is unknown.
let DUMMY_HASH: Promise<string> | null = null;

/** Accepts 10-digit Indian mobiles with optional +91 / 91 / 0 prefix; returns E.164 or null. */
export function normalizeMobile(input: unknown): string | null {
  let d = String(input ?? '').replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? '+91' + d : null;
}
export const maskMobile = (m: string | null) => (m ? m.slice(0, 3) + ' ' + '•'.repeat(6) + m.slice(-4) : null);

const OtpRequest = z.object({ mobile: z.string().max(20) });
const OtpVerify = z.object({ mobile: z.string().max(20), code: z.string().regex(/^\d{6}$/), name: z.string().trim().min(2).max(80).optional(), email: z.email().max(200).optional() });
const AdminLogin = z.object({ email: z.email().max(200), password: z.string().min(1).max(200) });
const MeUpdate = z.object({ name: z.string().trim().min(2).max(80).optional(), email: z.email().max(200).nullable().optional(), uiLang: z.enum(['hi', 'en', 'hl']).optional() });
const NewAdmin = z.object({ name: z.string().trim().min(2).max(80), email: z.email().max(200), role: z.enum(ROLES), password: z.string().min(12).max(200) });

export function authRoutes(app: FastifyInstance, deps: Deps) {
  const otpHash = (mobile: string, code: string) => hmacHex(deps.cfg.OTP_PEPPER, `${mobile}|${code}`);

  // ---------------- students: OTP ----------------
  app.post('/api/auth/otp/request', async (req, reply) => {
    noStore(reply);
    const body = parse(OtpRequest, req.body);
    const mobile = normalizeMobile(body.mobile);
    if (!mobile) throw badRequest('INVALID_MOBILE', 'Enter a valid 10-digit Indian mobile number.');
    await deps.limiter.hit('otp_req_ip', req.ip, LIMITS.otpRequestPerIp);
    // Cooldown is claimed atomically BEFORE sending, so parallel requests cannot send two SMS.
    if (!(await deps.limiter.claimCooldown('otp_cooldown', mobile, LIMITS.otpResendCooldownSec))) {
      const wait = await deps.limiter.ttlSec('otp_cooldown', mobile) || LIMITS.otpResendCooldownSec;
      throw new AppError(429, 'OTP_COOLDOWN', `Please wait ${wait} seconds before requesting a new code.`, { retryAfterSec: wait });
    }
    await deps.limiter.hit('otp_req_mobile', mobile, LIMITS.otpRequestPerMobile);
    const now = deps.clock.now(); const code = otpCode();
    const row = await tx(deps.db, async c => {
      await exec(c, 'UPDATE otp_requests SET consumed_at=$2 WHERE mobile=$1 AND consumed_at IS NULL', [mobile, now]); // only the newest code works
      return one<{ id: string }>(c, 'INSERT INTO otp_requests (mobile, code_hash, created_at, expires_at, ip) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [mobile, otpHash(mobile, code), now, new Date(now.getTime() + OTP_TTL_MS), req.ip]);
    });
    try { await deps.otp.send(mobile, code); }
    catch (e) {
      req.log.error({ err: e }, 'otp send failed');
      await exec(deps.db, 'UPDATE otp_requests SET consumed_at=$2 WHERE id=$1', [row!.id, now]);
      await deps.limiter.reset('otp_cooldown', mobile);                       // let the student try again
      throw new AppError(502, 'OTP_SEND_FAILED', 'We could not send the code right now. Please try again in a minute.');
    }
    // Same response whether or not the number is registered. The code itself is never returned.
    return { sent: true, resendAfterSec: LIMITS.otpResendCooldownSec, expiresInSec: OTP_TTL_MS / 1000 };
  });

  app.post('/api/auth/otp/verify', async (req, reply) => {
    noStore(reply);
    const body = parse(OtpVerify, req.body);
    const mobile = normalizeMobile(body.mobile);
    if (!mobile) throw badRequest('INVALID_MOBILE', 'Enter a valid 10-digit Indian mobile number.');
    await deps.limiter.hit('otp_ver_ip', req.ip, LIMITS.otpVerifyPerIp);
    await deps.limiter.hit('otp_ver_mobile', mobile, LIMITS.otpVerifyPerMobile);
    const now = deps.clock.now();
    const invalid = () => badRequest('OTP_INVALID', 'The code is incorrect or has expired. Please check it or request a new code.');

    const result = await tx(deps.db, async c => {
      const otp = await one(c, 'SELECT * FROM otp_requests WHERE mobile=$1 AND consumed_at IS NULL AND expires_at > $2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE', [mobile, now]);
      if (!otp) return { err: invalid() };
      if (otp.attempts >= OTP_MAX_ATTEMPTS) { await exec(c, 'UPDATE otp_requests SET consumed_at=$2 WHERE id=$1', [otp.id, now]); return { err: badRequest('OTP_LOCKED', 'Too many wrong attempts. Please request a new code.') }; }
      if (!safeEqual(otp.code_hash, otpHash(mobile, body.code))) {
        await exec(c, 'UPDATE otp_requests SET attempts = attempts + 1 WHERE id=$1', [otp.id]);
        return { err: invalid() };
      }
      let user = await one(c, 'SELECT * FROM users WHERE mobile=$1', [mobile]);
      if (!user && !body.name) return { err: badRequest('NAME_REQUIRED', 'Please enter your name to create your account.') };
      await exec(c, 'UPDATE otp_requests SET consumed_at=$2 WHERE id=$1', [otp.id, now]);
      let created = false;
      if (!user) {
        user = await one(c, 'INSERT INTO users (name, email, mobile, created_at) VALUES ($1,$2,$3,$4) RETURNING *', [body.name, body.email ?? null, mobile, now]);
        created = true;
      }
      if (user.status !== 'ACTIVE') return { err: forbidden('This account is not active. Please contact support.') };
      await exec(c, 'UPDATE users SET last_login_at=$2 WHERE id=$1', [user.id, now]);
      await logEvent(c, user.id, created ? 'REGISTERED' : 'LOGIN', {}, now);
      const s = await createSession(deps, c, 'STUDENT', user.id, req, reply);
      return { user, created, csrfToken: s.csrfToken };
    });
    if ('err' in result) throw result.err;
    return { user: publicUser(result.user), created: result.created, csrfToken: result.csrfToken };
  });

  app.post('/api/auth/logout', { preHandler: studentGuard(deps) }, async (req, reply) => {
    await destroySession(deps, 'STUDENT', req, reply);
    await logEvent(deps.db, studentOf(req).userId, 'LOGOUT', {}, deps.clock.now());
    return { ok: true };
  });
  /** Sign out on every device. */
  app.post('/api/auth/logout-all', { preHandler: studentGuard(deps) }, async (req, reply) => {
    await exec(deps.db, "UPDATE sessions SET revoked_at=$2 WHERE subject_type='STUDENT' AND subject_id=$1 AND revoked_at IS NULL", [studentOf(req).userId, deps.clock.now()]);
    await destroySession(deps, 'STUDENT', req, reply);
    return { ok: true };
  });

  app.get('/api/me', { preHandler: studentGuard(deps) }, async (req, reply) => {
    noStore(reply);
    const u = await one(deps.db, 'SELECT * FROM users WHERE id=$1', [studentOf(req).userId]);
    return { user: publicUser(u), csrfToken: studentOf(req).csrf };
  });
  app.patch('/api/me', { preHandler: studentGuard(deps) }, async req => {
    const b = parse(MeUpdate, req.body); const id = studentOf(req).userId;
    try {
      const u = await one(deps.db, `UPDATE users SET name=COALESCE($2,name), email=CASE WHEN $3::boolean THEN $4 ELSE email END, ui_lang=COALESCE($5,ui_lang) WHERE id=$1 RETURNING *`,
        [id, b.name ?? null, b.email !== undefined, b.email ?? null, b.uiLang ?? null]);
      return { user: publicUser(u) };
    } catch (e: any) {
      if (e?.code === '23505') throw badRequest('EMAIL_IN_USE', 'This email is already linked to another account.');
      throw e;
    }
  });

  // ---------------- admins: email + password (scrypt), lockout ----------------
  app.post('/api/admin/auth/login', async (req, reply) => {
    noStore(reply);
    const b = parse(AdminLogin, req.body); const email = b.email.toLowerCase();
    await deps.limiter.hit('adm_login_ip', req.ip, LIMITS.adminLoginPerIp);
    await deps.limiter.hit('adm_login_email', email, LIMITS.adminLoginPerEmail);
    const now = deps.clock.now();
    const a = await one(deps.db, 'SELECT * FROM admin_users WHERE lower(email)=$1', [email]);
    const fail = () => new AppError(401, 'LOGIN_FAILED', 'Email or password is incorrect.');
    if (!a) { DUMMY_HASH ??= hashPassword('dummy-' + Math.random()); await verifyPassword(b.password, await DUMMY_HASH); throw fail(); }
    if (a.locked_until && new Date(a.locked_until) > now) throw new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed sign-in attempts. Try again in 15 minutes.');
    // A disabled account answers exactly like a wrong password (no signal that the password was right).
    if (a.status !== 'ACTIVE' || !(await verifyPassword(b.password, a.password_hash))) {
      // Atomic increment: parallel guesses cannot read the same counter.
      const r = await one<{ failed_logins: number }>(deps.db, 'UPDATE admin_users SET failed_logins = failed_logins + 1 WHERE id=$1 RETURNING failed_logins', [a.id]);
      const lock = r!.failed_logins >= ADMIN_MAX_FAILS;
      if (lock) await exec(deps.db, 'UPDATE admin_users SET failed_logins=0, locked_until=$2 WHERE id=$1', [a.id, new Date(now.getTime() + ADMIN_LOCK_MS)]);
      await audit(deps.db, { type: 'ADMIN', id: a.id, name: a.name, role: a.role, ip: req.ip, requestId: req.id }, lock ? 'ADMIN_LOCKED' : 'ADMIN_LOGIN_FAILED', 'AdminUser', a.id, null, null, null);
      throw fail();
    }
    const out = await tx(deps.db, async c => {
      await exec(c, 'UPDATE admin_users SET failed_logins=0, locked_until=NULL WHERE id=$1', [a.id]);
      await audit(c, { type: 'ADMIN', id: a.id, name: a.name, role: a.role, ip: req.ip, requestId: req.id }, 'ADMIN_LOGIN', 'AdminUser', a.id);
      return createSession(deps, c, 'ADMIN', a.id, req, reply);
    });
    return { admin: { name: a.name, email: a.email, role: a.role }, csrfToken: out.csrfToken };
  });
  app.post('/api/admin/auth/logout', { preHandler: adminGuard(deps) }, async (req, reply) => { await destroySession(deps, 'ADMIN', req, reply); return { ok: true }; });
  app.get('/api/admin/me', { preHandler: adminGuard(deps) }, async (req, reply) => { noStore(reply); return { admin: { name: req.admin!.name, role: req.admin!.role }, csrfToken: req.admin!.csrf }; });

  app.post('/api/admin/admins', { preHandler: adminGuard(deps, 'admin.manage') }, async req => {
    const b = parse(NewAdmin, req.body);
    const hash = await hashPassword(b.password);
    try {
      const a = await tx(deps.db, async c => {
        const row = await one(c, 'INSERT INTO admin_users (name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, name, email, role', [b.name, b.email.toLowerCase(), hash, b.role]);
        await audit(c, actorOf(req), 'ADMIN_CREATED', 'AdminUser', row.id, null, b.role);
        return row;
      });
      return { admin: a };
    } catch (e: any) { if (e?.code === '23505') throw badRequest('EMAIL_IN_USE', 'An admin with this email already exists.'); throw e; }
  });
}

export function publicUser(u: any) {
  return { name: u.name, studentCode: u.student_code, mobile: maskMobile(u.mobile), email: u.email, uiLang: u.ui_lang, status: u.status };
}
