/** End-to-end through the real BullMQ queues and worker process code (real Redis). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminLogin, buyPlan, call, makeCtx, makeSellable, publishTodayMock, studentLogin, TRE_CS, type Ctx } from './helpers.js';
import { BullJobs } from '../src/queues.js';
import { startWorkers } from '../src/worker.js';
import { planDailyMocks } from '../src/modules/content-core.js';
import { addDaysToDate, examDate } from '../src/lib/time.js';

let ctx: Ctx; let w: Awaited<ReturnType<typeof startWorkers>>;
const until = async (fn: () => Promise<boolean>, ms = 15_000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 100)); } return false; };

beforeAll(async () => {
  ctx = await makeCtx({ now: new Date().toISOString() });                 // BullMQ delays use real time
  ctx.deps.jobs = new BullJobs(ctx.deps.redis, ctx.deps.cfg.QUEUE_PREFIX);
  await ctx.app.close(); const { buildApp } = await import('../src/app.js'); ctx.app = await buildApp(ctx.deps); await ctx.app.ready();
  w = await startWorkers(ctx.deps);
});
afterAll(async () => { await Promise.all(w.workers.map(x => x.close())); await w.maint.close(); await ctx.deps.jobs.close(); await ctx.close(); });

describe('workers', () => {
  it('generation runs through the queue; the attempt expiry job auto-submits with the browser closed', async () => {
    const superA = await adminLogin(ctx, 'SUPER_ADMIN'); const content = await adminLogin(ctx, 'CONTENT_ADMIN');
    await makeSellable(ctx, superA);
    const create = await call(ctx, 'POST', '/api/admin/mocks', { s: content, body: { selection: TRE_CS, mode: 'PRACTICE' } });
    const g = await call(ctx, 'POST', `/api/admin/mocks/${create.json.mock.id}/generate`, { s: content });
    expect(await until(async () => (await ctx.db.query('SELECT status FROM generation_jobs WHERE id=$1', [g.json.jobId])).rows[0].status === 'COMPLETED')).toBe(true);
    // finish the human steps and publish
    await call(ctx, 'POST', `/api/admin/mocks/${create.json.mock.id}/process`, { s: content, body: { step: 'all' } });
    await call(ctx, 'POST', `/api/admin/mocks/${create.json.mock.id}/validate`, { s: content });
    expect((await call(ctx, 'POST', `/api/admin/mocks/${create.json.mock.id}/publish`, { s: content })).status).toBe(200);
    const s = await studentLogin(ctx); await buyPlan(ctx, s);
    const a = (await call(ctx, 'POST', '/api/attempts', { s, body: { mockId: create.json.mock.id } })).json;
    // shorten this attempt to 1 s and re-schedule its expiry job, then walk away
    const exp = new Date(Date.now() + 1000);
    await ctx.db.query('UPDATE attempts SET server_expires_at=$2 WHERE id=$1', [a.attemptId, exp]);
    await ctx.deps.redis.del(`${ctx.deps.cfg.QUEUE_PREFIX}:attempts:expire-${a.attemptId}`);
    await (ctx.deps.jobs as BullJobs).scheduleAttemptExpiry(a.attemptId + '', exp).catch(() => {});
    ctx.clock.set(new Date(Date.now() + 5_000));
    expect(await until(async () => (await ctx.db.query('SELECT status FROM attempts WHERE id=$1', [a.attemptId])).rows[0].status === 'AUTO_SUBMITTED')).toBe(true);
  });
  it('daily planner prepares tomorrow\'s mock and queues generation for cohorts with paying students (idempotent)', async () => {
    const d = addDaysToDate(examDate(ctx.clock.now(), 'Asia/Kolkata'), 1);
    const r1 = await planDailyMocks(ctx.deps, d); expect(r1.created).toBe(1); expect(r1.queued).toBe(1); expect(r1.errors).toEqual([]);
    const r2 = await planDailyMocks(ctx.deps, d); expect(r2.created).toBe(0); expect(r2.queued).toBe(0);
  });
});
