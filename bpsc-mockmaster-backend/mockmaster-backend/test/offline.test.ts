/** Scenario 4 (lost internet) + scenario 5 (refresh) using the real browser queue against the real HTTP server. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnswerQueue, fetchSender, remainingFromServer, type StorageLike } from '../client/answer-queue.js';
import { adminLogin, buyPlan, call, makeCtx, makeSellable, publishTodayMock, studentLogin, type Ctx, type Session } from './helpers.js';

let ctx: Ctx; let base = ''; let mockId = '';
class MemStorage implements StorageLike { m = new Map<string, string>(); getItem(k: string) { return this.m.get(k) ?? null; } setItem(k: string, v: string) { this.m.set(k, v); } removeItem(k: string) { this.m.delete(k); } }

beforeAll(async () => {
  ctx = await makeCtx(); const superA = await adminLogin(ctx, 'SUPER_ADMIN'); const content = await adminLogin(ctx, 'CONTENT_ADMIN');
  await makeSellable(ctx, superA); mockId = (await publishTodayMock(ctx, content)).mockId;
  await ctx.app.listen({ port: 0, host: '127.0.0.1' }); base = `http://127.0.0.1:${(ctx.app.server.address() as any).port}`;
});
afterAll(async () => { await ctx.close(); });

async function setup() {
  const s = await studentLogin(ctx); await buyPlan(ctx, s);
  const a = (await call(ctx, 'POST', '/api/attempts', { s, body: { mockId } })).json;
  let offline = false; let sent = 0;
  const real = fetchSender(base, () => s.csrf);
  // Browser fetch with cookies; "offline" makes every request fail like a dropped network.
  const g: any = globalThis; const origFetch = g.fetch;
  const send = async (id: string, answers: any[]) => {
    if (offline) throw new TypeError('Failed to fetch');
    sent++;
    g.fetch = (u: string, init: any) => origFetch(u, { ...init, headers: { ...init.headers, cookie: s.cookie } });
    try { return await real(id, answers); } finally { g.fetch = origFetch; }
  };
  const timers: (() => void)[] = [];
  return { s, a, send, setOffline: (v: boolean) => { offline = v; }, sentCount: () => sent, timers, schedule: (fn: () => void) => { timers.push(fn); return 0 as any; } };
}
const serverAnswers = async (s: Session, id: string) => (await call(ctx, 'GET', `/api/attempts/${id}`, { s })).json.answers;

describe('offline answer queue', () => {
  it('scenario 4 — answers made offline are kept, retried and reconciled when the network returns', async () => {
    const t = await setup(); const store = new MemStorage();
    const q = new AnswerQueue(t.a.attemptId, store, t.send, () => {}, t.schedule);
    q.record(1, 'A', false, 10); await q.flush();
    expect(q.pendingCount).toBe(0);
    t.setOffline(true);
    q.record(2, 'B', false, 15); q.record(2, 'C', true, 25); q.record(3, 'D', false, 5);
    await q.flush();
    expect(q.state).toBe('offline'); expect(q.pendingCount).toBe(2); expect(t.timers.length).toBeGreaterThan(0);
    expect((await serverAnswers(t.s, t.a.attemptId)).map((x: any) => x.position)).toEqual([1]);
    t.setOffline(false);
    t.timers.shift()!(); await q.flush();                                  // backoff timer fires / `online` event
    expect(q.pendingCount).toBe(0); expect(q.state).toBe('idle');
    const sa = await serverAnswers(t.s, t.a.attemptId);
    expect(sa.map((x: any) => [x.position, x.selected, x.marked])).toEqual([[1, 'A', false], [2, 'C', true], [3, 'D', false]]);
  });
  it('scenario 5 — a refresh while offline loses nothing: the queue is persisted and versions keep increasing', async () => {
    const t = await setup(); const store = new MemStorage();
    const q1 = new AnswerQueue(t.a.attemptId, store, t.send, () => {}, t.schedule);
    q1.record(4, 'B', false, 5); await q1.flush();                         // server has v1
    t.setOffline(true); q1.record(4, 'E', false, 9); await q1.flush();     // v2 pending, then the page reloads
    t.setOffline(false);
    const q2 = new AnswerQueue(t.a.attemptId, store, t.send, () => {}, t.schedule);
    q2.syncFromServer(await serverAnswers(t.s, t.a.attemptId));
    expect(q2.pendingCount).toBe(1); await q2.flush();
    q2.record(5, 'A', false, 3); await q2.flush();
    const sa = await serverAnswers(t.s, t.a.attemptId);
    const v4 = sa.find((x: any) => x.position === 4); expect(v4.selected).toBe('E');
    expect(sa.find((x: any) => x.position === 5).version).toBeGreaterThan(v4.version);
  });
  it('a stale queued answer from an old tab cannot overwrite a newer server answer', async () => {
    const t = await setup(); const storeOld = new MemStorage(); const storeNew = new MemStorage();
    const oldTab = new AnswerQueue(t.a.attemptId, storeOld, t.send, () => {}, t.schedule);
    t.setOffline(true); oldTab.record(6, 'B', false, 1); await oldTab.flush(); t.setOffline(false);       // old tab: v1 stuck offline
    const newTab = new AnswerQueue(t.a.attemptId, storeNew, t.send, () => {}, t.schedule);
    newTab.syncFromServer(await serverAnswers(t.s, t.a.attemptId)); newTab.record(6, 'D', false, 2); newTab.record(6, 'C', false, 3); await newTab.flush();
    await oldTab.flush();                                                  // old tab reconnects later
    expect(oldTab.pendingCount).toBe(0);                                   // server told it a newer version exists
    expect((await serverAnswers(t.s, t.a.attemptId)).find((x: any) => x.position === 6).selected).toBe('C');
  });
  it('when time is up the queue closes instead of retrying forever; the countdown is display-only', async () => {
    const t = await setup(); const q = new AnswerQueue(t.a.attemptId, new MemStorage(), t.send, () => {}, t.schedule);
    ctx.clock.advance(16 * 60_000);
    q.record(1, 'A', false, 1); await q.flush();
    expect(q.state).toBe('closed'); expect(q.closedReason).toBe('TIME_UP');
    ctx.clock.advance(-16 * 60_000);
    expect(remainingFromServer({ serverNow: '2026-10-05T04:30:00Z', serverExpiresAt: '2026-10-05T04:45:00Z' }, 1_000, 61_000)).toBe(840);
  });
});
