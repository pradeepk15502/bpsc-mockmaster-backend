import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminLogin, call, makeCtx, nextMobile, studentLogin, type Ctx } from './helpers.js';
import { hashPassword } from '../src/lib/crypto.js';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeCtx(); });
afterAll(async () => { await ctx.close(); });

describe('OTP authentication', () => {
  it('sends a code but never returns it, and signs in with secure cookies', async () => {
    const m = nextMobile();
    const r = await call(ctx, 'POST', '/api/auth/otp/request', { body: { mobile: m } });
    expect(r.status).toBe(200); expect(JSON.stringify(r.json)).not.toMatch(/\b\d{6}\b/);
    expect(r.json).toEqual({ sent: true, resendAfterSec: 60, expiresInSec: 300 });
    const code = ctx.otp.lastCode('+91' + m)!;
    const v = await call(ctx, 'POST', '/api/auth/otp/verify', { body: { mobile: m, code, name: 'Asha' } });
    expect(v.status).toBe(200); expect(v.json.created).toBe(true); expect(v.json.user.mobile).not.toContain(m.slice(0, 6));
    const sid = v.res.cookies.find((c: any) => c.name === 'mm_sid')!;
    expect(sid.httpOnly).toBe(true); expect(sid.secure).toBe(true); expect(sid.sameSite).toBe('Lax');
    const row = await ctx.db.query('SELECT token_hash FROM sessions LIMIT 1');
    expect(row.rows[0].token_hash).not.toBe(sid.value);          // token stored only as an HMAC
  });
  it('requires a name for new accounts without burning the code', async () => {
    const m = nextMobile(); await call(ctx, 'POST', '/api/auth/otp/request', { body: { mobile: m } });
    const code = ctx.otp.lastCode('+91' + m)!;
    expect((await call(ctx, 'POST', '/api/auth/otp/verify', { body: { mobile: m, code } })).json.error.code).toBe('NAME_REQUIRED');
    expect((await call(ctx, 'POST', '/api/auth/otp/verify', { body: { mobile: m, code, name: 'Ravi' } })).status).toBe(200);
  });
  it('enforces the resend cooldown', async () => {
    const m = nextMobile();
    expect((await call(ctx, 'POST', '/api/auth/otp/request', { body: { mobile: m } })).status).toBe(200);
    const again = await call(ctx, 'POST', '/api/auth/otp/request', { body: { mobile: m } });
    expect(again.status).toBe(429); expect(again.json.error.code).toBe('OTP_COOLDOWN'); expect(again.res.headers['retry-after']).toBeDefined();
  });
  it('limits OTP requests per mobile per hour', async () => {
    const m = nextMobile(); let last = 0;
    for (let i = 0; i < 6; i++) { await ctx.deps.limiter.reset('otp_cooldown', '+91' + m); last = (await call(ctx, 'POST', '/api/auth/otp/request', { body: { mobile: m }, ip: '10.2.0.' + i })).status; }
    expect(last).toBe(429);
  });
  it('locks the code after 5 wrong guesses (brute-force protection) and rejects expired codes', async () => {
    const m = nextMobile(); await call(ctx, 'POST', '/api/auth/otp/request', { body: { mobile: m } });
    const code = ctx.otp.lastCode('+91' + m)!; const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await call(ctx, 'POST', '/api/auth/otp/verify', { body: { mobile: m, code: wrong, name: 'X Y' } })).json.error.code).toBe('OTP_INVALID');
    expect((await call(ctx, 'POST', '/api/auth/otp/verify', { body: { mobile: m, code, name: 'X Y' } })).json.error.code).toBe('OTP_LOCKED');
    const m2 = nextMobile(); await call(ctx, 'POST', '/api/auth/otp/request', { body: { mobile: m2 } });
    ctx.clock.advance(6 * 60_000);
    expect((await call(ctx, 'POST', '/api/auth/otp/verify', { body: { mobile: m2, code: ctx.otp.lastCode('+91' + m2), name: 'X Y' } })).json.error.code).toBe('OTP_INVALID');
  });
  it('blocks verification floods per mobile', async () => {
    const m = nextMobile(); let last = 0;
    for (let i = 0; i < 12; i++) last = (await call(ctx, 'POST', '/api/auth/otp/verify', { body: { mobile: m, code: '123456', name: 'X Y' }, ip: '10.3.0.' + i })).status;
    expect(last).toBe(429);
  });
});

describe('sessions', () => {
  it('requires CSRF header for state-changing requests', async () => {
    const s = await studentLogin(ctx);
    const r = await call(ctx, 'PATCH', '/api/me', { body: { name: 'New Name' }, headers: { cookie: s.cookie } });
    expect(r.status).toBe(403); expect(r.json.error.code).toBe('CSRF_FAILED');
    expect((await call(ctx, 'PATCH', '/api/me', { s, body: { name: 'New Name' } })).status).toBe(200);
  });
  it('logs out (session revoked server-side) and expires idle / old sessions', async () => {
    const s = await studentLogin(ctx);
    expect((await call(ctx, 'GET', '/api/me', { s })).status).toBe(200);
    expect((await call(ctx, 'POST', '/api/auth/logout', { s })).status).toBe(200);
    expect((await call(ctx, 'GET', '/api/me', { s })).status).toBe(401);
    const s2 = await studentLogin(ctx);
    ctx.clock.advance(8 * 86400_000);                               // > 7 days idle
    expect((await call(ctx, 'GET', '/api/me', { s: s2 })).status).toBe(401);
  });
  it('suspended students lose access immediately', async () => {
    const s = await studentLogin(ctx);
    await ctx.db.query("UPDATE users SET status='SUSPENDED' WHERE mobile=$1", ['+91' + s.mobile]);
    expect((await call(ctx, 'GET', '/api/me', { s })).status).toBe(403);
  });
});

describe('admin authentication', () => {
  it('locks an admin account after 5 failed passwords and uses one generic error', async () => {
    await ctx.db.query("INSERT INTO admin_users (name, email, password_hash, role) VALUES ('L','lock@example.test',$1,'CONTENT_ADMIN')", [await hashPassword('right password here')]);
    for (let i = 0; i < 5; i++) expect((await call(ctx, 'POST', '/api/admin/auth/login', { body: { email: 'lock@example.test', password: 'nope' }, ip: '10.4.0.' + i })).json.error.code).toBe('LOGIN_FAILED');
    expect((await call(ctx, 'POST', '/api/admin/auth/login', { body: { email: 'lock@example.test', password: 'right password here' }, ip: '10.4.1.1' })).json.error.code).toBe('ACCOUNT_LOCKED');
    expect((await call(ctx, 'POST', '/api/admin/auth/login', { body: { email: 'nobody@example.test', password: 'x' }, ip: '10.4.1.2' })).json.error.code).toBe('LOGIN_FAILED');
  });
  it('a disabled admin with the right password gets the same answer as a wrong password', async () => {
    await ctx.db.query("INSERT INTO admin_users (name, email, password_hash, role, status) VALUES ('D','disabled@example.test',$1,'CONTENT_ADMIN','DISABLED')", [await hashPassword('right password here')]);
    const r = await call(ctx, 'POST', '/api/admin/auth/login', { body: { email: 'disabled@example.test', password: 'right password here' }, ip: '10.4.2.1' });
    expect(r.status).toBe(401); expect(r.json.error.code).toBe('LOGIN_FAILED');
  });
  it('parallel OTP requests for one number send a single SMS', async () => {
    const m = nextMobile(); let sent = 0; const orig = ctx.otp.send.bind(ctx.otp); (ctx.otp as any).send = async (a: string, b: string) => { sent++; return orig(a, b); };
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => call(ctx, 'POST', '/api/auth/otp/request', { body: { mobile: m }, ip: '10.6.0.' + i })));
    (ctx.otp as any).send = orig;
    expect(rs.filter(r => r.status === 200)).toHaveLength(1); expect(sent).toBe(1);
  });
  it('student sessions cannot call admin APIs and admin sessions expire after 1h idle', async () => {
    const s = await studentLogin(ctx);
    expect((await call(ctx, 'GET', '/api/admin/configs', { s })).status).toBe(401);
    const a = await adminLogin(ctx, 'SUPER_ADMIN');
    expect((await call(ctx, 'GET', '/api/admin/configs', { s: a })).status).toBe(200);
    ctx.clock.advance(61 * 60_000);
    expect((await call(ctx, 'GET', '/api/admin/configs', { s: a })).status).toBe(401);
  });
});
