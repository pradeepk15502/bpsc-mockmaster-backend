import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Deps } from '../deps.js';
import { exec, one, type Queryable } from '../lib/db.js';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { hmacHex, randomToken, safeEqual } from '../lib/crypto.js';
import { can, type Action } from './rbac.js';
import { LIMITS } from '../lib/ratelimit.js';

type Kind = 'STUDENT' | 'ADMIN';
export const COOKIES = { STUDENT: { sid: 'mm_sid', csrf: 'mm_csrf' }, ADMIN: { sid: 'mm_asid', csrf: 'mm_acsrf' } } as const;
export const LIFETIME = {
  STUDENT: { absoluteMs: 30 * 86400_000, idleMs: 7 * 86400_000 },
  ADMIN: { absoluteMs: 12 * 3600_000, idleMs: 60 * 60_000 },
} as const;
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const tokenHash = (deps: Deps, token: string) => hmacHex(deps.cfg.SESSION_PEPPER, token);

function cookieOpts(deps: Deps, maxAgeSec: number, httpOnly: boolean) {
  return {
    path: '/', httpOnly, sameSite: 'lax' as const, maxAge: maxAgeSec,
    secure: deps.cfg.NODE_ENV !== 'development',
    ...(deps.cfg.COOKIE_DOMAIN ? { domain: deps.cfg.COOKIE_DOMAIN } : {}),
  };
}

/** New random session (never reuses a token: no session fixation). Token is stored only as an HMAC. */
export async function createSession(deps: Deps, c: Queryable, kind: Kind, subjectId: string, req: FastifyRequest, reply: FastifyReply) {
  const now = deps.clock.now(); const life = LIFETIME[kind];
  const token = randomToken(32); const csrf = randomToken(24);
  // Revoke whatever session this browser presented before (re-login).
  const prev = req.cookies?.[COOKIES[kind].sid];
  if (prev) await exec(c, 'UPDATE sessions SET revoked_at=$2 WHERE token_hash=$1 AND revoked_at IS NULL', [tokenHash(deps, prev), now]);
  await exec(c, `INSERT INTO sessions (token_hash, csrf_token, subject_type, subject_id, created_at, last_seen_at, expires_at, idle_expires_at, ip, user_agent)
                 VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9)`,
    [tokenHash(deps, token), csrf, kind, subjectId, now, new Date(now.getTime() + life.absoluteMs), new Date(now.getTime() + life.idleMs), req.ip, String(req.headers['user-agent'] ?? '').slice(0, 300)]);
  const maxAge = Math.floor(life.absoluteMs / 1000);
  reply.setCookie(COOKIES[kind].sid, token, cookieOpts(deps, maxAge, true));
  reply.setCookie(COOKIES[kind].csrf, csrf, cookieOpts(deps, maxAge, false)); // readable by the SPA, echoed in X-CSRF-Token
  return { csrfToken: csrf };
}

export async function destroySession(deps: Deps, kind: Kind, req: FastifyRequest, reply: FastifyReply) {
  const t = req.cookies?.[COOKIES[kind].sid];
  if (t) await exec(deps.db, 'UPDATE sessions SET revoked_at=$2 WHERE token_hash=$1 AND revoked_at IS NULL', [tokenHash(deps, t), deps.clock.now()]);
  reply.clearCookie(COOKIES[kind].sid, { path: '/' }); reply.clearCookie(COOKIES[kind].csrf, { path: '/' });
}

async function load(deps: Deps, kind: Kind, req: FastifyRequest) {
  const token = req.cookies?.[COOKIES[kind].sid];
  if (!token) throw unauthorized();
  const now = deps.clock.now();
  const join = kind === 'STUDENT'
    ? `SELECT s.*, u.name, u.status AS subject_status, NULL::text AS role FROM sessions s JOIN users u ON u.id = s.subject_id`
    : `SELECT s.*, a.name, a.status AS subject_status, a.role FROM sessions s JOIN admin_users a ON a.id = s.subject_id`;
  const s = await one(deps.db, `${join} WHERE s.token_hash=$1 AND s.subject_type=$2`, [tokenHash(deps, token), kind]);
  if (!s || s.revoked_at || s.expires_at <= now || s.idle_expires_at <= now) throw unauthorized('Your session has expired. Please sign in again.');
  if (s.subject_status !== 'ACTIVE') throw forbidden('This account is not active. Please contact support.');
  if (UNSAFE.has(req.method) && !safeEqual(String(req.headers['x-csrf-token'] ?? ''), s.csrf_token)) throw new AppError(403, 'CSRF_FAILED', 'Security check failed. Please refresh the page and try again.');
  if (now.getTime() - new Date(s.last_seen_at).getTime() > 60_000) {
    const idle = new Date(Math.min(now.getTime() + LIFETIME[kind].idleMs, new Date(s.expires_at).getTime()));
    await exec(deps.db, 'UPDATE sessions SET last_seen_at=$2, idle_expires_at=$3 WHERE id=$1', [s.id, now, idle]);
  }
  return s;
}

export function studentGuard(deps: Deps) {
  return async (req: FastifyRequest) => {
    const s = await load(deps, 'STUDENT', req);
    req.student = { kind: 'STUDENT', sessionId: s.id, userId: s.subject_id, name: s.name, csrf: s.csrf_token };
    if (req.method === 'GET') await deps.limiter.hit('read', s.subject_id, LIMITS.readPerUser);
  };
}
export function adminGuard(deps: Deps, action?: Action) {
  return async (req: FastifyRequest) => {
    const s = await load(deps, 'ADMIN', req);
    req.admin = { kind: 'ADMIN', sessionId: s.id, adminId: s.subject_id, name: s.name, role: s.role, csrf: s.csrf_token };
    await deps.limiter.hit('admin', s.subject_id, LIMITS.adminPerUser);
    if (action && !can(s.role, action)) throw forbidden(`Your role (${s.role}) does not allow this action.`);
  };
}
/** Explicit check inside handlers that need more than one permission. */
export function requirePerm(req: FastifyRequest, action: Action) {
  if (!req.admin || !can(req.admin.role, action)) throw forbidden(`Your role (${req.admin?.role ?? 'none'}) does not allow this action.`);
}
