import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminLogin, buyPlan, call, makeCtx, makeSellable, studentLogin, type Ctx, type Session } from './helpers.js';
import { ROLES } from '../src/modules/rbac.js';

let ctx: Ctx; const admins: Record<string, Session> = {};
beforeAll(async () => { ctx = await makeCtx(); for (const r of ROLES) admins[r] = await adminLogin(ctx, r); });
afterAll(async () => { await ctx.close(); });

describe('HTTP hardening', () => {
  it('sends security headers and allows CORS only for the configured origin', async () => {
    const r = await call(ctx, 'GET', '/healthz', { headers: { origin: 'https://app.example.test' } });
    expect(r.res.headers['x-content-type-options']).toBe('nosniff'); expect(r.res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.res.headers['access-control-allow-origin']).toBe('https://app.example.test'); expect(r.res.headers['access-control-allow-credentials']).toBe('true');
    const evil = await call(ctx, 'GET', '/healthz', { headers: { origin: 'https://evil.example' } });
    expect(evil.res.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('never leaks stack traces, SQL or secrets in errors', async () => {
    const bad = await call(ctx, 'POST', '/api/auth/otp/request', { body: '{not json', headers: { 'content-type': 'application/json' } });
    expect(bad.status).toBe(400); expect(JSON.stringify(bad.json)).not.toMatch(/at .*\.ts|SyntaxError|stack/);
    const v = await call(ctx, 'POST', '/api/auth/otp/request', { body: { mobile: 123 } });
    expect(v.json.error.code).toBe('VALIDATION_FAILED');
    const s = await studentLogin(ctx);
    const r = await call(ctx, 'GET', '/api/attempts/not-a-uuid', { s }); expect(r.status).toBe(400);
  });
  it('rejects oversized bodies', async () => {
    const r = await call(ctx, 'POST', '/api/support', { body: JSON.stringify({ message: 'x'.repeat(300_000) }), headers: { 'content-type': 'application/json' } });
    expect(r.status).toBe(413);
  });
  it('no response anywhere contains a backend secret', async () => {
    const s = await studentLogin(ctx);
    const outs = await Promise.all(['/api/catalog', '/api/me', '/api/entitlements', '/api/payments', '/legal/privacy'].map(u => call(ctx, 'GET', u, { s })));
    const blob = outs.map(o => o.res.body).join('');
    for (const secret of ['test_key_secret_123', 'test_webhook_secret_456', 'x'.repeat(40), 'y'.repeat(40)]) expect(blob).not.toContain(secret);
  });
});

describe('server-side admin permissions (role matrix)', () => {
  const matrix: [string, string, any, string[]][] = [
    ['GET', '/api/admin/audit', undefined, ['SUPER_ADMIN']],
    ['GET', '/api/admin/payments', undefined, ['SUPER_ADMIN', 'FINANCE_ADMIN', 'SUPPORT_ADMIN']],
    ['GET', '/api/admin/students', undefined, ['SUPER_ADMIN', 'SUPPORT_ADMIN']],
    ['GET', '/api/admin/configs', undefined, ['SUPER_ADMIN', 'CONTENT_ADMIN']],
    ['POST', '/api/admin/payments/reconcile', {}, ['SUPER_ADMIN', 'FINANCE_ADMIN']],
    ['PUT', '/api/admin/sales', { selection: { examType: 'STET', paper: 'P2', subjectId: 'cs' }, mode: 'PRACTICE', enabled: false }, ['SUPER_ADMIN']],
    ['GET', '/api/admin/waitlist', undefined, ['SUPER_ADMIN', 'CONTENT_ADMIN', 'SUPPORT_ADMIN']],
    ['POST', '/api/admin/admins', { name: 'New Person', email: 'np@example.test', role: 'SUPPORT_ADMIN', password: 'a very long password' }, ['SUPER_ADMIN']],
  ];
  for (const [m, u, body, allowed] of matrix) {
    it(`${m} ${u} → only ${allowed.join(', ')}`, async () => {
      for (const r of ROLES) {
        const res = await call(ctx, m, u, { s: admins[r], body });
        if (allowed.includes(r)) expect(res.status, r).not.toBe(403); else expect(res.status, r).toBe(403);
      }
    });
  }
});

describe('account deletion, support and legal pages', () => {
  it('serves the legal pages without unsupported claims', async () => {
    for (const p of ['terms', 'privacy', 'refund', 'contact', 'delete-account']) {
      const r = await call(ctx, 'GET', '/legal/' + p); expect(r.status).toBe(200); expect(r.res.headers['content-type']).toContain('text/html');
      expect(r.res.body).toMatch(/pending legal review/);
    }
    const t = (await call(ctx, 'GET', '/legal/terms')).res.body;
    expect(t).toMatch(/not affiliated with/); expect(t).toMatch(/do not publish ranks or percentiles/);
  });
  it('support form works signed out and is rate-limited', async () => {
    const ok = await call(ctx, 'POST', '/api/support', { body: { name: 'Asha K', contact: '9876543210', category: 'PAYMENT', message: 'Money deducted, plan not active' }, ip: '10.50.0.1' });
    expect(ok.status).toBe(200);
    let last = 0; for (let i = 0; i < 6; i++) last = (await call(ctx, 'POST', '/api/support', { body: { name: 'Asha K', contact: '9876543210', category: 'OTHER', message: 'hello there' }, ip: '10.50.0.2' })).status;
    expect(last).toBe(429);
  });
  it('deletion request → admin completes → personal data removed, sessions revoked, payments kept', async () => {
    await makeSellable(ctx, admins.SUPER_ADMIN);
    const s = await studentLogin(ctx); await buyPlan(ctx, s);
    expect((await call(ctx, 'POST', '/api/account/deletion-request', { s, body: { confirm: true, reason: 'done with exam' } })).json.status).toBe('REQUESTED');
    expect((await call(ctx, 'POST', '/api/account/deletion-request', { s, body: { confirm: true } })).json.duplicate).toBe(true);
    const ex = await call(ctx, 'GET', '/api/account/export', { s }); expect(ex.json.user.mobile).toBe('+91' + (s as any).mobile);
    const reqId = (await call(ctx, 'GET', '/api/admin/deletion-requests', { s: admins.SUPPORT_ADMIN })).json.requests[0].id;
    expect((await call(ctx, 'POST', `/api/admin/deletion-requests/${reqId}/complete`, { s: admins.CONTENT_ADMIN })).status).toBe(403);
    expect((await call(ctx, 'POST', `/api/admin/deletion-requests/${reqId}/complete`, { s: admins.SUPPORT_ADMIN })).status).toBe(200);
    expect((await call(ctx, 'GET', '/api/me', { s })).status).toBe(401);
    const u = (await ctx.db.query("SELECT name, mobile, email, status FROM users WHERE status='DELETED'")).rows[0];
    expect(u).toEqual({ name: 'Deleted user', mobile: null, email: null, status: 'DELETED' });
    expect((await ctx.db.query("SELECT count(*)::int n FROM payments p JOIN users u ON u.id=p.user_id WHERE u.status='DELETED'")).rows[0].n).toBe(1);
  });
});
