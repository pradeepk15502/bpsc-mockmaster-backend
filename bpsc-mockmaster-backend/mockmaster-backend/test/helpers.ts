import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import pino from 'pino';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { Deps, Jobs } from '../src/deps.js';
import { ConsoleOtpSender } from '../src/adapters/otp.js';
import type { RazorpayClient, RzpOrder, RzpPayment, RzpRefund } from '../src/adapters/razorpay.js';
import type { GenRequest, GenResult, QuestionGenerator } from '../src/adapters/claude.js';
import { createPool, type Db } from '../src/lib/db.js';
import { RateLimiter } from '../src/lib/ratelimit.js';
import { FakeClock } from '../src/lib/time.js';
import { hashPassword, hmacHex } from '../src/lib/crypto.js';
import { seedReference } from '../src/db/reference-data.js';
import { fingerprintOf, semanticOf } from '../src/domain/text.js';

const env = JSON.parse(readFileSync('.test-runtime/env.json', 'utf8'));
export const SECRETS = { key: 'rzp_test_KEY', secret: 'test_key_secret_123', webhook: 'test_webhook_secret_456' };

// ------------------------------------------------------------ fakes for third parties (never for our own DB / queue)
export class FakeRazorpay implements RazorpayClient {
  orders = new Map<string, RzpOrder>(); payments = new Map<string, RzpPayment>(); refunds: RzpRefund[] = []; down = false; calls: string[] = [];
  private n = 0;
  private guard(op: string) { this.calls.push(op); if (this.down) throw new Error('Razorpay HTTP 503'); }
  async createOrder(i: { amount: number; currency: string; receipt: string }) { this.guard('createOrder'); const o = { id: `order_T${++this.n}`, amount: i.amount, currency: i.currency, status: 'created', receipt: i.receipt }; this.orders.set(o.id, o); return o; }
  async fetchPayment(id: string) { this.guard('fetchPayment'); const p = this.payments.get(id); if (!p) throw new Error('not found'); return { ...p }; }
  async fetchOrderPayments(orderId: string) { this.guard('fetchOrderPayments'); return [...this.payments.values()].filter(p => p.order_id === orderId).map(p => ({ ...p })); }
  async capture(id: string) { this.guard('capture'); const p = this.payments.get(id)!; p.status = 'captured'; return { ...p }; }
  async refund(id: string, amount: number) { this.guard('refund'); const r = { id: `rfnd_T${++this.n}`, payment_id: id, amount, status: 'processed' }; this.refunds.push(r); this.payments.get(id)!.status = 'refunded'; return r; }
  /** Simulates the student completing Checkout. */
  pay(orderId: string, status: RzpPayment['status'] = 'captured', amount?: number): RzpPayment {
    const o = this.orders.get(orderId)!; const p: RzpPayment = { id: `pay_T${++this.n}`, order_id: orderId, amount: amount ?? o.amount, currency: 'INR', status, error_description: status === 'failed' ? 'Bank declined' : null };
    this.payments.set(p.id, p); return p;
  }
  checkoutSignature(orderId: string, paymentId: string) { return hmacHex(SECRETS.secret, `${orderId}|${paymentId}`); }
}

/** Deterministic Claude stand-in: returns schema-valid questions; failure modes are scripted per test. */
export class FakeGenerator implements QuestionGenerator {
  calls = 0; requests: GenRequest[] = [];
  failWhen: (req: GenRequest, call: number) => 'unavailable' | 'malformed' | null = () => null;
  static uniq = 0;
  async generate(req: GenRequest): Promise<GenResult> {
    this.calls++; this.requests.push(req);
    const f = this.failWhen(req, this.calls);
    if (f === 'unavailable') { const e: any = new Error('overloaded'); e.status = 529; throw e; }
    if (f === 'malformed') return { raw: { items: [{ slot: 1, nonsense: true }] }, usage: { inputTokens: 100, outputTokens: 10 } };
    const items = req.slots.map(s => {
      const u = ++FakeGenerator.uniq; const tri = (t: string) => ({ hi: `${t} (हिन्दी ${u})`, en: `${t} ${u}`, hinglish: `${t} hinglish ${u}` });
      const opts: any = {}, why: any = {};
      req.optionKeys.forEach((k, i) => { opts[k] = tri(`Generated option ${k} for item ${u} choice${i}`); why[k] = { hi: k === 'A' ? `सही — ${u}` : `गलत — ${u}`, en: k === 'A' ? `Correct — reason ${u}` : `Wrong — reason ${k} ${u}`, hinglish: k === 'A' ? `Sahi — ${u}` : `Galat — ${u}` }; });
      return { slot: s.slot, topic: s.topic === '*' ? 'General' : s.topic, subtopic: s.subtopic === '*' ? 'General' : s.subtopic, difficulty: s.difficulty,
        question: tri(`Generated question number ${u} about ${s.topic} ${s.subtopic} uniquetoken${u}marker`), options: opts, correctOption: 'A',
        concept: tri(`Concept ${u}`), explanation: tri(`Explanation for question ${u} in full detail`), optionReasons: why, examTip: tri(`Tip ${u}`) };
    });
    return { raw: { items }, usage: { inputTokens: 1000, outputTokens: 2000 } };
  }
}

export class RecordingJobs implements Jobs {
  generation: string[] = []; expiries: { attemptId: string; at: Date }[] = [];
  async enqueueGeneration(id: string) { this.generation.push(id); }
  async scheduleAttemptExpiry(attemptId: string, at: Date) { this.expiries.push({ attemptId, at }); }
  async close() {}
}

// ------------------------------------------------------------ per-file environment (real PostgreSQL + Redis)
export interface Ctx { app: FastifyInstance; deps: Deps; db: Db; clock: FakeClock; otp: ConsoleOtpSender; rzp: FakeRazorpay; gen: FakeGenerator; jobs: RecordingJobs; close(): Promise<void> }

export async function makeCtx(opts: { minReadyMocks?: number; now?: string } = {}): Promise<Ctx> {
  const dbName = 't_' + randomUUID().replace(/-/g, '').slice(0, 16);
  const admin = new pg.Client({ connectionString: `postgres://mm@127.0.0.1:${env.pgPort}/postgres` });
  await admin.connect(); await admin.query(`CREATE DATABASE ${dbName} TEMPLATE mm_template`); await admin.end();
  const url = `postgres://mm@127.0.0.1:${env.pgPort}/${dbName}`;
  const cfg = loadConfig({
    NODE_ENV: 'test', DATABASE_URL: url, REDIS_URL: `redis://127.0.0.1:${env.redisPort}`, SESSION_PEPPER: 'x'.repeat(40), OTP_PEPPER: 'y'.repeat(40),
    RAZORPAY_KEY_ID: SECRETS.key, RAZORPAY_KEY_SECRET: SECRETS.secret, RAZORPAY_WEBHOOK_SECRET: SECRETS.webhook, OTP_PROVIDER: 'console',
    QUEUE_PREFIX: 'mm-' + dbName, PUBLIC_APP_ORIGIN: 'https://app.example.test', GENERATION_DAILY_TOKEN_BUDGET: '10000000',
  } as any);
  const db = createPool(url, 30);
  const redis = new Redis({ port: env.redisPort, host: '127.0.0.1', maxRetriesPerRequest: null });
  const clock = new FakeClock(new Date(opts.now ?? '2026-10-05T04:30:00Z'));   // 10:00 IST
  const otp = new ConsoleOtpSender(() => {}); const rzp = new FakeRazorpay(); const gen = new FakeGenerator(); const jobs = new RecordingJobs();
  const deps: Deps = { cfg, db, redis, clock, log: pino({ level: 'silent' }), otp, razorpay: rzp, generator: gen, jobs, limiter: new RateLimiter(redis, cfg.QUEUE_PREFIX) };
  await seedReference(db);
  await db.query(`UPDATE settings SET value=$1 WHERE key='availability'`, [{ minReadyMocks: opts.minReadyMocks ?? 2 }]);
  const app = await buildApp(deps); await app.ready();
  return { app, deps, db, clock, otp, rzp, gen, jobs, async close() { await app.close(); await db.end(); redis.disconnect(); } };
}

// ------------------------------------------------------------ HTTP helpers
export interface Session { cookie: string; csrf: string }
const cookieHeader = (res: any) => (res.cookies as any[]).map(c => `${c.name}=${c.value}`).join('; ');
export async function call(ctx: Ctx, method: string, url: string, o: { s?: Session; body?: unknown; headers?: Record<string, string>; ip?: string } = {}) {
  const res = await ctx.app.inject({ method: method as any, url, payload: o.body as any, remoteAddress: o.ip ?? '10.0.0.1',
    headers: { ...(o.s ? { cookie: o.s.cookie, 'x-csrf-token': o.s.csrf } : {}), ...(o.headers ?? {}) } });
  let json: any = null; try { json = res.json(); } catch { /* html */ }
  return { status: res.statusCode, json, res };
}

let mob = 7000000000;
export const nextMobile = () => String(++mob);
export async function studentLogin(ctx: Ctx, mobile = nextMobile(), name = 'Test Student'): Promise<Session & { mobile: string }> {
  const r1 = await call(ctx, 'POST', '/api/auth/otp/request', { body: { mobile }, ip: '10.1.' + (mob % 250) + '.1' });
  if (r1.status !== 200) throw new Error('otp request failed ' + JSON.stringify(r1.json));
  const code = ctx.otp.lastCode('+91' + mobile)!;
  const r2 = await call(ctx, 'POST', '/api/auth/otp/verify', { body: { mobile, code, name }, ip: '10.1.' + (mob % 250) + '.1' });
  if (r2.status !== 200) throw new Error('otp verify failed ' + JSON.stringify(r2.json));
  return { cookie: cookieHeader(r2.res), csrf: r2.json.csrfToken, mobile };
}
let adm = 0;
export async function adminLogin(ctx: Ctx, role: string): Promise<Session & { id: string }> {
  const email = `admin${++adm}.${role.toLowerCase()}@example.test`; const pw = 'correct horse battery staple';
  const row = await ctx.db.query('INSERT INTO admin_users (name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id', [`${role} ${adm}`, email, await hashPassword(pw), role]);
  const r = await call(ctx, 'POST', '/api/admin/auth/login', { body: { email, password: pw }, ip: '10.9.0.' + adm });
  if (r.status !== 200) throw new Error('admin login failed ' + JSON.stringify(r.json));
  return { cookie: cookieHeader(r.res), csrf: r.json.csrfToken, id: row.rows[0].id };
}

// ------------------------------------------------------------ content fixtures (TEST FIXTURES — never shipped as data)
let fx = 0;
const tri = (s: string) => ({ hi: `${s} (हिन्दी)`, en: s, hl: `${s} (hinglish)` });
export function fixtureContent(keys: string[], label: string) {
  const u = ++fx; const opts: any = {}, why: any = {};
  keys.forEach((k, i) => { opts[k] = tri(`Fixture option ${k} ${label} number ${u} variant ${i}`); why[k] = { hi: k === 'A' ? 'सही' : 'गलत', en: k === 'A' ? `Correct — fixture ${u}` : `Wrong — fixture ${u} ${k}`, hl: k === 'A' ? 'Sahi' : 'Galat' }; });
  return { q: tri(`Test fixture question ${label} serial ${u} zq${u}w`), opts, why, exp: tri(`Fixture explanation ${u}`), concept: tri(`Fixture concept ${u}`), tip: tri(`Fixture tip ${u}`) };
}
/** Inserts reviewed, published bank questions covering every rule of a blueprint `times` times. */
export async function seedBank(ctx: Ctx, bpId: string, times: number, opts: { treLanguage?: string; syllabusSubject?: string } = {}) {
  const bp = (await ctx.db.query('SELECT b.*, c.sections, c.option_count, c.exam_type, c.level, c.paper FROM blueprints b JOIN exam_configs c ON c.id=b.config_id WHERE b.id=$1', [bpId])).rows[0];
  const keys = ['A', 'B', 'C', 'D', 'E'].slice(0, bp.option_count);
  const diffs = ['EASY', 'MEDIUM', 'HARD'];
  let n = 0;
  for (const r of bp.rules) {
    const sec = bp.sections.find((s: any) => s.id === r.sectionId);
    const subject = sec.role === 'LANGUAGE' ? 'lang-' + (opts.treLanguage ?? 'hi') : sec.role === 'GS' ? 'gs' : sec.role === 'TEACHING' ? 'teaching' : (opts.syllabusSubject ?? bp.subject_id);
    for (let i = 0; i < r.count * times; i++) {
      const id = `FIX_${bpId}_${++n}_${fx}`; const content = fixtureContent(keys, `${r.topic}/${r.subtopic}`);
      await ctx.db.query(`INSERT INTO questions (id, origin_id, status, exam_type, level, paper, section, subject_id, exam_lang, topic, subtopic, difficulty, correct_option, option_count, content, source_type,
          in_pool, fingerprint, semantic_hash, published_by, published_at, review, validation) VALUES ($1,$1,'PUBLISHED',$2,$3,$4,$5,$6,$7,$8,$9,$10,'A',$11,$12,'ORIGINAL',true,$13,$14,'fixture',now(),$15,$16)`,
        [id, bp.exam_type, bp.level, bp.paper, r.sectionId, subject, sec.role === 'LANGUAGE' ? (opts.treLanguage ?? 'hi') : null, r.topic === '*' ? 'General' : r.topic, r.subtopic === '*' ? 'General' : r.subtopic,
          diffs[(n + i) % 3], bp.option_count, content, fingerprintOf(content.q.en), semanticOf(content.q.en), { by: 'fixture' }, { result: 'PASSED' }]);
    }
  }
  return n;
}

export const TRE_CS = { examType: 'TRE', level: '11-12', subjectId: 'cs', treLanguage: 'hi' } as const;

/** Makes TRE 11-12 CS Hindi sellable in PRACTICE mode the proper way: practice config decision, price, bank, sale switch. */
export async function makeSellable(ctx: Ctx, superA: Session, opts: { bankTimes?: number } = {}) {
  await call(ctx, 'POST', '/api/admin/configs/TRE_1112_V1/mark-practice', { s: superA, body: { reason: 'Launch as practice pattern until the official notification is verified' } });
  await ctx.db.query("UPDATE pricing_plans SET active=true WHERE id='PL_TRE_1112_CS_90'");
  await seedBank(ctx, 'BP_TRE_1112_CS_PRACTICE', opts.bankTimes ?? 3);
  const r = await call(ctx, 'PUT', '/api/admin/sales', { s: superA, body: { selection: TRE_CS, mode: 'PRACTICE', enabled: true } });
  if (r.status !== 200) throw new Error('enable sale failed ' + JSON.stringify(r.json));
}

export async function buyPlan(ctx: Ctx, s: Session, sel: any = TRE_CS) {
  const o = await call(ctx, 'POST', '/api/payments/orders', { s, body: { plan: sel.examType, parts: [sel], idempotencyKey: randomUUID() } });
  if (o.status !== 200) throw new Error('order failed ' + JSON.stringify(o.json));
  const pay = ctx.rzp.pay(o.json.checkout.order_id);
  const v = await call(ctx, 'POST', '/api/payments/verify', { s, body: { paymentId: o.json.paymentId, razorpay_order_id: pay.order_id, razorpay_payment_id: pay.id, razorpay_signature: ctx.rzp.checkoutSignature(pay.order_id, pay.id) } });
  if (v.json?.status !== 'SUCCESS') throw new Error('verify failed ' + JSON.stringify(v.json));
  return { paymentId: o.json.paymentId as string, rzpPaymentId: pay.id, orderId: pay.order_id };
}

/** Admin pipeline: create today's mock → generate (bank reuse) → process → validate → publish. */
export async function publishTodayMock(ctx: Ctx, content: Session, date?: string) {
  const { processGenerationJob } = await import('../src/modules/content-core.js');
  const c = await call(ctx, 'POST', '/api/admin/mocks', { s: content, body: { selection: TRE_CS, mode: 'PRACTICE', ...(date ? { date } : {}) } });
  if (c.status !== 200) throw new Error('create mock ' + JSON.stringify(c.json));
  const mockId = c.json.mock.id;
  const g = await call(ctx, 'POST', `/api/admin/mocks/${mockId}/generate`, { s: content });
  if (g.status !== 200) throw new Error('generate ' + JSON.stringify(g.json));
  await processGenerationJob(ctx.deps, g.json.jobId, { backoffMs: 0 });
  const p = await call(ctx, 'POST', `/api/admin/mocks/${mockId}/process`, { s: content, body: { step: 'all' } });
  if (p.status !== 200 || p.json.failedValidation.length) throw new Error('process ' + JSON.stringify(p.json));
  const v = await call(ctx, 'POST', `/api/admin/mocks/${mockId}/validate`, { s: content });
  if (!v.json.approved) throw new Error('validate ' + JSON.stringify(v.json.validation.checks.filter((x: any) => x.status !== 'PASS')));
  const pub = await call(ctx, 'POST', `/api/admin/mocks/${mockId}/publish`, { s: content });
  if (pub.status !== 200) throw new Error('publish ' + JSON.stringify(pub.json));
  return { mockId, jobId: g.json.jobId as string };
}

export function webhookBody(event: string, entity: any, extra: any = {}) { return JSON.stringify({ entity: 'event', event, payload: { payment: { entity }, ...extra } }); }
export async function sendWebhook(ctx: Ctx, raw: string, eventId: string, sig?: string) {
  return call(ctx, 'POST', '/api/webhooks/razorpay', { body: raw, headers: { 'content-type': 'application/json', 'x-razorpay-signature': sig ?? hmacHex(SECRETS.webhook, raw), 'x-razorpay-event-id': eventId }, ip: '52.66.0.1' });
}
