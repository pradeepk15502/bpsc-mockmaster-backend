/** Production build test: compile, boot the compiled server with NODE_ENV=production against real PostgreSQL/Redis. */
import { execSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const env = JSON.parse(readFileSync('.test-runtime/env.json', 'utf8'));
let dbUrl = ''; const port = 18000 + Math.floor(Math.random() * 1000);
const prodEnv = () => ({
  ...process.env, NODE_ENV: 'production', PORT: String(port), DATABASE_URL: dbUrl, REDIS_URL: `redis://127.0.0.1:${env.redisPort}`,
  SESSION_PEPPER: 's'.repeat(64), OTP_PEPPER: 'o'.repeat(64), RAZORPAY_KEY_ID: 'rzp_live_placeholder', RAZORPAY_KEY_SECRET: 'k', RAZORPAY_WEBHOOK_SECRET: 'w',
  OTP_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't', PUBLIC_APP_ORIGIN: 'https://mockmaster.example', ANTHROPIC_API_KEY: 'k',
  LEGAL_ENTITY_NAME: 'Example Edu Pvt Ltd', SUPPORT_EMAIL: 'support@mockmaster.example', BUSINESS_ADDRESS: 'Patna, Bihar', GRIEVANCE_OFFICER: 'A. Officer', QUEUE_PREFIX: 'prodtest',
});
beforeAll(async () => {
  execSync('npm run build', { stdio: 'pipe' });
  const name = 'prod_' + randomUUID().replace(/-/g, '').slice(0, 12);
  const c = new pg.Client({ connectionString: `postgres://mm@127.0.0.1:${env.pgPort}/postgres` }); await c.connect(); await c.query(`CREATE DATABASE ${name}`); await c.end();
  dbUrl = `postgres://mm@127.0.0.1:${env.pgPort}/${name}`;
}, 120_000);

describe('production build', () => {
  it('migrations run from the compiled output', () => {
    const out = execSync('node dist/src/db/migrate.js', { env: prodEnv() }).toString();
    expect(out).toMatch(/001_init.sql/);
  });
  it('compiled server boots in production mode and serves health, readiness and legal pages', async () => {
    const p = spawn('node', ['dist/src/server.js'], { env: prodEnv(), stdio: 'pipe' });
    try {
      let ok = false;
      for (let i = 0; i < 50 && !ok; i++) { try { ok = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok; } catch { await new Promise(r => setTimeout(r, 200)); } }
      expect(ok).toBe(true);
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
      const res = await fetch(`http://127.0.0.1:${port}/legal/contact`); const html = await res.text();
      expect(html).toContain('support@mockmaster.example'); expect(res.headers.get('strict-transport-security')).toContain('max-age');
      const otp = await fetch(`http://127.0.0.1:${port}/api/auth/otp/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mobile":"9876543210"}' });
      expect(otp.status).toBe(502);                        // real MSG91 adapter is wired (fake key → provider error), no demo code fallback
      const oj: any = await otp.json(); delete oj.requestId; expect(JSON.stringify(oj)).not.toMatch(/\d{6}/);
    } finally { p.kill('SIGTERM'); }
  });
  it('refuses to boot with demo OTP or test payment keys', () => {
    for (const bad of [{ OTP_PROVIDER: 'console' }, { RAZORPAY_KEY_ID: 'rzp_test_abc' }]) {
      let code = 0; try { execSync('node dist/src/server.js', { env: { ...prodEnv(), ...bad }, stdio: 'pipe', timeout: 15_000 }); } catch (e: any) { code = e.status; }
      expect(code).not.toBe(0);
    }
  });
});
afterAll(() => {});
