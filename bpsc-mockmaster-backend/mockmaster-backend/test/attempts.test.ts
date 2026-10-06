import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminLogin, buyPlan, call, makeCtx, makeSellable, publishTodayMock, studentLogin, TRE_CS, type Ctx, type Session } from './helpers.js';
import { expireDueAttempts } from '../src/modules/attempts.js';

let ctx: Ctx; let superA: Session; let content: Session; let mockId: string;
const T0 = '2026-10-05T04:30:00Z';
beforeAll(async () => {
  ctx = await makeCtx(); superA = await adminLogin(ctx, 'SUPER_ADMIN'); content = await adminLogin(ctx, 'CONTENT_ADMIN');
  await makeSellable(ctx, superA, { bankTimes: 4 });
  mockId = (await publishTodayMock(ctx, content)).mockId;
});
afterAll(async () => { await ctx.close(); });

async function paidStudent() { const s = await studentLogin(ctx); await buyPlan(ctx, s); return s; }
async function start(s: Session) { const r = await call(ctx, 'POST', '/api/attempts', { s, body: { mockId } }); return r; }
const save = (s: Session, id: string, answers: any[]) => call(ctx, 'PUT', `/api/attempts/${id}/answers`, { s, body: { answers } });
const ans = (position: number, selected: string | null, version: number) => ({ position, selected, marked: false, timeSpentSec: 20, version });

describe('server-authoritative attempt', () => {
  it("today's mock is listed with server facts only, and a plan-less student cannot start it", async () => {
    const s = await paidStudent();
    const t = (await call(ctx, 'GET', '/api/mocks/today', { s })).json;
    expect(t.items[0]).toMatchObject({ state: 'available', mock: { totalQuestions: 15, durationMinutes: 15, mode: 'PRACTICE' } });
    expect(t.items[0].mock.modeLabel).toMatch(/not an official BPSC paper/);
    const nobody = await studentLogin(ctx);
    expect((await start(nobody)).status).toBe(403);
  });
  it('returns serverStartedAt / serverExpiresAt / serverNow / remainingSeconds; two tabs get one attempt', async () => {
    const s = await paidStudent();
    const [a, b] = await Promise.all([start(s), start(s)]);
    expect(a.json.attemptId).toBe(b.json.attemptId);
    expect(a.json.remainingSeconds).toBe(900);
    expect(new Date(a.json.serverExpiresAt).getTime() - new Date(a.json.serverStartedAt).getTime()).toBe(15 * 60_000);
    expect(a.json.serverNow).toBe(new Date(T0).toISOString());
    expect(ctx.jobs.expiries.find(e => e.attemptId === a.json.attemptId)!.at.toISOString()).toBe(a.json.serverExpiresAt);
  });
  it('question security — the test paper carries no answers, explanations, reasons or internal ids', async () => {
    const s = await paidStudent(); const a = (await start(s)).json;
    const p = await call(ctx, 'GET', `/api/attempts/${a.attemptId}/paper`, { s });
    expect(p.json.questions).toHaveLength(15);
    const raw = JSON.stringify(p.json);
    for (const bad of ['correct', 'explanation', 'optionReasons', '"why"', '"exp"', 'concept', 'examTip', '"tip"', 'validation', 'review', 'sourceType', 'FIX_', 'Q_TRE', 'fingerprint'])
      expect(raw.includes(bad), bad).toBe(false);
    expect(Object.keys(p.json.questions[0]).sort()).toEqual(['options', 'position', 'section', 'text']);
    expect(Object.keys(p.json.questions[0].options)).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect((await call(ctx, 'GET', `/api/attempts/${a.attemptId}/review`, { s })).json.error.code).toBe('NOT_SUBMITTED');
    expect((await call(ctx, 'GET', `/api/attempts/${a.attemptId}/result`, { s })).json.error.code).toBe('NOT_SUBMITTED');
  });
  it('scenario 3 — an older answer arriving after a newer one never overwrites it', async () => {
    const s = await paidStudent(); const a = (await start(s)).json;
    expect((await save(s, a.attemptId, [ans(1, 'C', 5)])).json.results[0]).toEqual({ position: 1, accepted: true, serverVersion: 5 });
    expect((await save(s, a.attemptId, [ans(1, 'B', 4)])).json.results[0]).toEqual({ position: 1, accepted: false, serverVersion: 5 });
    // racing requests: highest version wins whatever the arrival order
    await Promise.all([save(s, a.attemptId, [ans(2, 'A', 9)]), save(s, a.attemptId, [ans(2, 'D', 7)]), save(s, a.attemptId, [ans(2, 'B', 8)])]);
    const st = (await call(ctx, 'GET', `/api/attempts/${a.attemptId}`, { s })).json;
    expect(st.answers.find((x: any) => x.position === 1)).toMatchObject({ selected: 'C', version: 5 });
    expect(st.answers.find((x: any) => x.position === 2)).toMatchObject({ selected: 'A', version: 9 });
  });
  it('rejects options that do not exist and positions outside the mock', async () => {
    const s = await paidStudent(); const a = (await start(s)).json;
    expect((await save(s, a.attemptId, [ans(99, 'A', 1)])).json.error.code).toBe('INVALID_QUESTION');
    expect((await save(s, a.attemptId, [{ ...ans(1, 'A', 1), selected: 'F' }])).status).toBe(400);
  });
  it('scenario 5 — refresh: state and remaining time come back from the server', async () => {
    const s = await paidStudent(); const a = (await start(s)).json;
    await save(s, a.attemptId, [ans(3, 'B', 1), ans(4, null, 2)]);
    ctx.clock.advance(120_000);
    const again = await start(s);                                         // the student reopens the test
    expect(again.json.resumed).toBe(true); expect(again.json.attemptId).toBe(a.attemptId); expect(again.json.remainingSeconds).toBe(780);
    const st = (await call(ctx, 'GET', `/api/attempts/${a.attemptId}`, { s })).json;
    expect(st.answers.map((x: any) => [x.position, x.selected])).toEqual([[3, 'B'], [4, null]]);
    ctx.clock.set(T0);
  });
  it('scenario 6 — timer reaches zero: late saves are refused, the attempt is auto-submitted with answers saved before the deadline', async () => {
    const s = await paidStudent(); const a = (await start(s)).json;
    await save(s, a.attemptId, [ans(1, 'A', 1)]);
    ctx.clock.advance(15 * 60_000 + 5_000);
    const late = await save(s, a.attemptId, [ans(2, 'A', 2)]);
    expect(late.status).toBe(409); expect(late.json.error.code).toBe('TIME_UP');
    const r = (await call(ctx, 'GET', `/api/attempts/${a.attemptId}/result`, { s })).json;
    expect(r.status).toBe('AUTO_SUBMITTED'); expect(r.result.total.attempted).toBe(1); expect(r.timeSpentSec).toBe(900);
    ctx.clock.set(T0);
  });
  it('scenario 7 — browser closed: the server sweeper auto-submits at expiry', async () => {
    const s = await paidStudent(); const a = (await start(s)).json;
    await save(s, a.attemptId, [ans(1, 'A', 1), ans(2, 'A', 2)]);
    ctx.clock.advance(14 * 60_000); expect(await expireDueAttempts(ctx.deps)).toBe(0);
    ctx.clock.advance(61_000);
    expect(await expireDueAttempts(ctx.deps)).toBeGreaterThanOrEqual(1);
    const row = (await ctx.db.query('SELECT status, submission_type, submitted_at, server_expires_at FROM attempts WHERE id=$1', [a.attemptId])).rows[0];
    expect(row.status).toBe('AUTO_SUBMITTED'); expect(row.submission_type).toBe('AUTO'); expect(row.submitted_at.getTime()).toBe(row.server_expires_at.getTime());
    ctx.clock.set(T0);
  });
  it('scenarios 1 & 2 — simultaneous submissions by two students, and double submit by one, are exact and idempotent', async () => {
    const s1 = await paidStudent(); const s2 = await paidStudent();
    const a1 = (await start(s1)).json; const a2 = (await start(s2)).json;
    await save(s1, a1.attemptId, [1, 2, 3, 4, 5].map((p, i) => ans(p, 'A', i + 1)));   // fixtures: key is A
    await save(s2, a2.attemptId, [1, 2, 3].map((p, i) => ans(p, 'B', i + 1)));
    const gen0 = ctx.gen.calls;
    const rs = await Promise.all([
      call(ctx, 'POST', `/api/attempts/${a1.attemptId}/submit`, { s: s1, body: {} }), call(ctx, 'POST', `/api/attempts/${a1.attemptId}/submit`, { s: s1, body: {} }),
      call(ctx, 'POST', `/api/attempts/${a2.attemptId}/submit`, { s: s2, body: {} }), call(ctx, 'POST', `/api/attempts/${a2.attemptId}/submit`, { s: s2, body: {} }),
    ]);
    expect(rs.map(r => r.status)).toEqual([200, 200, 200, 200]);
    expect(rs.filter(r => r.json.duplicate).length).toBe(2);
    const r1 = (await call(ctx, 'GET', `/api/attempts/${a1.attemptId}/result`, { s: s1 })).json.result;
    const r2 = (await call(ctx, 'GET', `/api/attempts/${a2.attemptId}/result`, { s: s2 })).json.result;
    expect(r1.total).toMatchObject({ correct: 5, wrong: 0, attempted: 5 }); expect(r2.total).toMatchObject({ correct: 0, wrong: 3, attempted: 3 });
    const ev = await ctx.db.query("SELECT count(*)::int n FROM events WHERE type='TEST_SUBMITTED' AND attempt_id=$1", [a1.attemptId]); expect(ev.rows[0].n).toBe(1);
    expect((await save(s1, a1.attemptId, [ans(6, 'A', 99)])).json.error.code).toBe('ALREADY_SUBMITTED');
    expect((await start(s1)).json.error.code).toBe('ALREADY_SUBMITTED');
    expect(ctx.gen.calls).toBe(gen0);                                         // Claude is never called on submit / result
    const rv = (await call(ctx, 'GET', `/api/attempts/${a1.attemptId}/review`, { s: s1 })).json.questions;
    expect(rv[0]).toMatchObject({ correctOption: 'A', yourAnswer: 'A', result: 'CORRECT' });
    expect(rv[0].explanation.en).toBeTruthy(); expect(rv[0].source.label).not.toMatch(/previous year/i);
  });
  it("scenario 10 — another student's attempt id is indistinguishable from a missing one on every endpoint", async () => {
    const owner = await paidStudent(); const other = await paidStudent();
    const a = (await start(owner)).json; const id = a.attemptId;
    for (const [m, u, body] of [['GET', `/api/attempts/${id}`], ['GET', `/api/attempts/${id}/paper`], ['PUT', `/api/attempts/${id}/answers`, { answers: [ans(1, 'A', 1)] }], ['POST', `/api/attempts/${id}/heartbeat`],
      ['POST', `/api/attempts/${id}/submit`, {}], ['GET', `/api/attempts/${id}/result`], ['GET', `/api/attempts/${id}/review`], ['POST', `/api/attempts/${id}/explanations`, { position: 1, action: 'open' }]] as any[]) {
      const r = await call(ctx, m, u, { s: other, body });
      expect(r.status, `${m} ${u}`).toBe(404);
    }
    expect((await call(ctx, 'GET', `/api/attempts/${id}`, { s: owner })).json.status).toBe('IN_PROGRESS');
    expect((await call(ctx, 'GET', '/api/attempts', { s: other })).json.attempts.some((x: any) => x.attemptId === id)).toBe(false);
  });
  it('scenario 11 — expired plan cannot start a mock, but an attempt started before expiry finishes normally', async () => {
    const s = await paidStudent(); const a = (await start(s)).json;
    await ctx.db.query("UPDATE entitlements SET expires_at=$2 WHERE user_id=(SELECT user_id FROM attempts WHERE id=$1)", [a.attemptId, new Date(Date.parse(T0) - 1000)]);
    expect((await save(s, a.attemptId, [ans(1, 'A', 1)])).status).toBe(200);
    expect((await call(ctx, 'POST', `/api/attempts/${a.attemptId}/submit`, { s, body: {} })).json.status).toBe('SUBMITTED');
    const s2 = await paidStudent();
    await ctx.db.query("UPDATE entitlements SET expires_at=$2 WHERE user_id=(SELECT id FROM users WHERE mobile=$1)", ['+91' + (s2 as any).mobile, new Date(Date.parse(T0) - 1000)]);
    const r = await start(s2); expect(r.status).toBe(403); expect(r.json.error.message).toMatch(/expired/);
    expect((await call(ctx, 'GET', '/api/mocks/today', { s: s2 })).json.items[0].state).toBe('blocked');
  });
  it("scenario 13 — unpublished mocks cannot be opened; future mocks cannot be started today", async () => {
    const s = await paidStudent();
    const draft = await call(ctx, 'POST', '/api/admin/mocks', { s: content, body: { selection: TRE_CS, mode: 'PRACTICE', date: '2026-10-06' } });
    const r = await call(ctx, 'POST', '/api/attempts', { s, body: { mockId: draft.json.mock.id } });
    expect(r.status).toBe(404);
    expect((await call(ctx, 'POST', '/api/attempts', { s, body: { mockId: 'mock_does_not_exist' } })).status).toBe(404);
  });
  it('rate-limits answer saves per attempt', async () => {
    const s = await paidStudent(); const a = (await start(s)).json; let last = 0;
    for (let i = 1; i <= 185; i++) { last = (await save(s, a.attemptId, [ans(1, 'A', i)])).status; if (last === 429) break; }
    expect(last).toBe(429);
  });
});
