import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminLogin, call, makeCtx, TRE_CS, type Ctx, type Session } from './helpers.js';
import { processGenerationJob } from '../src/modules/content-core.js';

let ctx: Ctx; let superA: Session; let content: Session; let reviewer: Session;
beforeAll(async () => {
  ctx = await makeCtx(); superA = await adminLogin(ctx, 'SUPER_ADMIN'); content = await adminLogin(ctx, 'CONTENT_ADMIN'); reviewer = await adminLogin(ctx, 'QUESTION_REVIEWER');
  await call(ctx, 'POST', '/api/admin/configs/TRE_1112_V1/mark-practice', { s: superA, body: { reason: 'Practice launch until official notification is verified' } });
});
afterAll(async () => { await ctx.close(); });
const relogin = async () => { superA = await adminLogin(ctx, 'SUPER_ADMIN'); content = await adminLogin(ctx, 'CONTENT_ADMIN'); reviewer = await adminLogin(ctx, 'QUESTION_REVIEWER'); };

async function newMock(date: string) {
  const r = await call(ctx, 'POST', '/api/admin/mocks', { s: content, body: { selection: TRE_CS, mode: 'PRACTICE', date } });
  expect(r.status).toBe(200); return r.json.mock.id as string;
}
async function generate(mockId: string) { const g = await call(ctx, 'POST', `/api/admin/mocks/${mockId}/generate`, { s: content }); expect(g.status).toBe(200); return g.json.jobId as string; }
const mockRow = async (id: string) => (await ctx.db.query('SELECT * FROM mocks WHERE id=$1', [id])).rows[0];

describe('generation pipeline (Claude adapter, batches, retries)', () => {
  it('generates through the worker into review; AI items are labelled AI_GENERATED; a second Generate is idempotent', async () => {
    const id = await newMock('2026-10-05');
    expect(await call(ctx, 'POST', '/api/admin/mocks', { s: content, body: { selection: TRE_CS, mode: 'OFFICIAL', date: '2026-10-06' } }).then(r => r.json.error.code)).toBe('CONFIG_NOT_VERIFIED');
    const job = await generate(id);
    expect(ctx.jobs.generation).toContain(job);
    expect(await processGenerationJob(ctx.deps, job, { backoffMs: 0 })).toBe('COMPLETED');
    expect(ctx.gen.calls).toBe(4);                                         // 3 + 4 + 8 slots in batches of 5 → 4 batches
    const m = await mockRow(id); expect(m.status).toBe('REVIEW'); expect(m.question_ids).toHaveLength(15);
    const qs = (await ctx.db.query('SELECT status, source_type, source_exam, source_year FROM questions WHERE id = ANY($1)', [m.question_ids])).rows;
    expect(qs.every(q => q.status === 'AI_GENERATED' && q.source_type === 'AI_GENERATED' && q.source_exam === null && q.source_year === null)).toBe(true);
    const again = await call(ctx, 'POST', `/api/admin/mocks/${id}/generate`, { s: content });
    expect(again.json.jobId).toBe(job); expect(again.json.duplicate).toBe(true); expect(ctx.gen.calls).toBe(4);
    const j = (await call(ctx, 'GET', `/api/admin/jobs/${job}`, { s: content })).json;
    expect(j.job.tokensIn).toBe(4000); expect(j.job.tokensOut).toBe(8000);
  });
  it('the database refuses an AI-generated question that claims an exam year (never a fake PYQ)', async () => {
    const q = (await ctx.db.query("SELECT id FROM questions WHERE source_type='AI_GENERATED' LIMIT 1")).rows[0];
    await expect(ctx.db.query("UPDATE questions SET source_exam='BPSC TRE', source_year=2023 WHERE id=$1", [q.id])).rejects.toThrow(/check constraint/);
    await expect(ctx.db.query("UPDATE questions SET source_type='PREVIOUS_YEAR' WHERE id=$1", [q.id])).rejects.toThrow(/check constraint/);
  });
  it('scenario 14 — partial Claude failure: good batches are kept, only failed batches are retried', async () => {
    const id = await newMock('2026-10-06');
    ctx.gen.failWhen = req => (req.sectionRole === 'GS' ? 'unavailable' : null);
    const before = ctx.gen.calls; const job = await generate(id);
    expect(await processGenerationJob(ctx.deps, job, { backoffMs: 0 })).toBe('PARTIAL_FAILED');
    expect(ctx.gen.calls - before).toBe(3 + 3);                            // 3 good batches + GS batch tried 3 times
    const bs = (await ctx.db.query('SELECT section_id, status, tries FROM generation_batches WHERE job_id=$1 ORDER BY n', [job])).rows;
    expect(bs.find(b => b.section_id === 'gs')).toMatchObject({ status: 'FAILED', tries: 3 });
    expect(bs.filter(b => b.status === 'DONE')).toHaveLength(3);
    const pub = await call(ctx, 'POST', `/api/admin/mocks/${id}/publish`, { s: content }); expect(pub.status).toBe(409);
    const view = (await call(ctx, 'GET', `/api/admin/jobs/${job}`, { s: content })).json;
    expect(view.batches.find((b: any) => b.section === 'gs').error).toBe('This batch could not be generated.');       // human message for non-super admins
    ctx.gen.failWhen = () => null; const mid = ctx.gen.calls;
    expect((await call(ctx, 'POST', `/api/admin/jobs/${job}/retry-failed`, { s: content })).json.requeued).toBe(1);
    expect(await processGenerationJob(ctx.deps, job, { backoffMs: 0 })).toBe('COMPLETED');
    expect(ctx.gen.calls - mid).toBe(1);
    expect((await mockRow(id)).question_ids).toHaveLength(15);
  });
  it('Claude fully unavailable → CLAUDE_UNAVAILABLE, mock back to DRAFT; malformed JSON is rejected and retried', async () => {
    const id = await newMock('2026-10-07');
    ctx.gen.failWhen = () => 'unavailable';
    expect(await processGenerationJob(ctx.deps, await generate(id), { backoffMs: 0 })).toBe('CLAUDE_UNAVAILABLE');
    expect((await mockRow(id)).status).toBe('DRAFT');
    const id2 = await newMock('2026-10-08');
    ctx.gen.failWhen = (_r, n) => (n % 2 === 1 ? 'malformed' : null);       // every other call returns junk
    expect(await processGenerationJob(ctx.deps, await generate(id2), { backoffMs: 0 })).toBe('COMPLETED');
    const tries = (await ctx.db.query('SELECT tries FROM generation_batches b JOIN generation_jobs j ON j.id=b.job_id WHERE j.mock_id=$1', [id2])).rows.map(r => r.tries);
    expect(tries.some(t => t > 1)).toBe(true);
    ctx.gen.failWhen = () => null;
  });
  it('stops at the daily token budget', async () => {
    const id = await newMock('2026-10-09');
    const old = ctx.deps.cfg.GENERATION_DAILY_TOKEN_BUDGET; (ctx.deps.cfg as any).GENERATION_DAILY_TOKEN_BUDGET = 1;
    expect(await processGenerationJob(ctx.deps, await generate(id), { backoffMs: 0 })).toBe('BUDGET_EXCEEDED');
    (ctx.deps.cfg as any).GENERATION_DAILY_TOKEN_BUDGET = old;
  });
});

describe('review → validate → publish', () => {
  let mockId: string;
  it('scenario 12 — a reviewer can review and validate but cannot publish (server-side)', async () => {
    mockId = (await ctx.db.query("SELECT id FROM mocks WHERE mock_date='2026-10-05'")).rows[0].id;
    const p = await call(ctx, 'POST', `/api/admin/mocks/${mockId}/process`, { s: reviewer, body: { step: 'all' } });
    expect(p.status).toBe(200); expect(p.json.reviewed).toBe(15); expect(p.json.validated).toBe(15);
    expect((await call(ctx, 'POST', `/api/admin/mocks/${mockId}/validate`, { s: reviewer })).status).toBe(403);
    const v = await call(ctx, 'POST', `/api/admin/mocks/${mockId}/validate`, { s: content }); expect(v.json.approved).toBe(true);
    const r = await call(ctx, 'POST', `/api/admin/mocks/${mockId}/publish`, { s: reviewer });
    expect(r.status).toBe(403); expect((await mockRow(mockId)).status).toBe('APPROVED');
    const qid = (await mockRow(mockId)).question_ids[0];
    expect((await call(ctx, 'POST', `/api/admin/questions/${qid}/publish`, { s: reviewer })).status).toBe(403);
    expect((await call(ctx, 'POST', `/api/admin/mocks/${mockId}/generate`, { s: reviewer })).status).toBe(403);
    const pub = await call(ctx, 'POST', `/api/admin/mocks/${mockId}/publish`, { s: content });
    expect(pub.status).toBe(200);
    expect((await call(ctx, 'POST', `/api/admin/mocks/${mockId}/publish`, { s: content })).json.duplicate).toBe(true);
    expect((await ctx.db.query('SELECT count(*)::int n FROM mock_questions WHERE mock_id=$1', [mockId])).rows[0].n).toBe(15);
  });
  it('scenario 15 — a question failing validation blocks approval and publication until fixed', async () => {
    const id = (await ctx.db.query("SELECT id FROM mocks WHERE mock_date='2026-10-06'")).rows[0].id;
    const qid = (await mockRow(id)).question_ids[2];
    const q = (await ctx.db.query('SELECT content, correct_option FROM questions WHERE id=$1', [qid])).rows[0];
    const bad = structuredClone(q.content); bad.why.A.en = 'Wrong — contradicts the key';            // A is the key
    expect((await call(ctx, 'PUT', `/api/admin/questions/${qid}`, { s: content, body: { content: bad, correctOption: 'A', reason: 'test edit' } })).status).toBe(200);
    const p = await call(ctx, 'POST', `/api/admin/mocks/${id}/process`, { s: content, body: { step: 'all' } });
    expect(p.json.failedValidation).toEqual([qid]);
    const v = await call(ctx, 'POST', `/api/admin/mocks/${id}/validate`, { s: content });
    expect(v.json.approved).toBe(false);
    expect(v.json.validation.checks.find((c: any) => c.label.startsWith('Per-question')).status).toBe('FAIL');
    expect((await call(ctx, 'POST', `/api/admin/mocks/${id}/publish`, { s: content })).json.error.code).toBe('INVALID_STATE');
    const det = (await call(ctx, 'GET', `/api/admin/questions/${qid}`, { s: content })).json;
    expect(det.question.validation.groups.find((g: any) => g.name === 'Correct answer').status).toBe('FAIL');
    // fix → back through review and validation → publish
    expect((await call(ctx, 'PUT', `/api/admin/questions/${qid}`, { s: content, body: { content: q.content, correctOption: 'A', reason: 'fix reason text' } })).status).toBe(200);
    await call(ctx, 'POST', `/api/admin/mocks/${id}/process`, { s: content, body: { step: 'all' } });
    expect((await call(ctx, 'POST', `/api/admin/mocks/${id}/validate`, { s: content })).json.approved).toBe(true);
    expect((await call(ctx, 'POST', `/api/admin/mocks/${id}/publish`, { s: content })).status).toBe(200);
  });
  it('scenario 16 — a published question is never edited; its revision goes through review; frozen mocks keep the original', async () => {
    const qid = (await mockRow(mockId)).question_ids[0];
    const before = (await ctx.db.query('SELECT frozen FROM mock_questions WHERE mock_id=$1 AND position=1', [mockId])).rows[0].frozen;
    const orig = (await ctx.db.query('SELECT content FROM questions WHERE id=$1', [qid])).rows[0].content;
    expect((await call(ctx, 'PUT', `/api/admin/questions/${qid}`, { s: content, body: { content: orig, correctOption: 'A', reason: 'try edit' } })).json.error.code).toBe('USE_REVISION');
    const rv = await call(ctx, 'POST', `/api/admin/questions/${qid}/revise`, { s: content });
    const nid = rv.json.question.id; expect(nid).not.toBe(qid); expect(rv.json.question.status).toBe('REVIEW');
    const changed = structuredClone(orig); changed.exp.en = 'Improved explanation text for the revision'; changed.q.en = orig.q.en + ' (clarified)';
    expect((await call(ctx, 'PUT', `/api/admin/questions/${nid}`, { s: content, body: { content: changed, correctOption: 'A', reason: 'clarify stem' } })).status).toBe(200);
    expect((await ctx.db.query('SELECT status FROM questions WHERE id=$1', [qid])).rows[0].status).toBe('PUBLISHED');   // original stays live meanwhile
    await call(ctx, 'POST', `/api/admin/questions/${nid}/approve`, { s: reviewer, body: {} });
    await call(ctx, 'POST', `/api/admin/questions/${nid}/validate`, { s: reviewer });
    expect((await call(ctx, 'POST', `/api/admin/questions/${nid}/publish`, { s: reviewer })).status).toBe(403);
    expect((await call(ctx, 'POST', `/api/admin/questions/${nid}/publish`, { s: content })).json.question.status).toBe('PUBLISHED');
    const old = (await ctx.db.query('SELECT status, replaced_by, in_pool FROM questions WHERE id=$1', [qid])).rows[0];
    expect(old).toEqual({ status: 'ARCHIVED', replaced_by: nid, in_pool: false });
    const after = (await ctx.db.query('SELECT frozen FROM mock_questions WHERE mock_id=$1 AND position=1', [mockId])).rows[0].frozen;
    expect(after).toEqual(before);
  });
  it('replacement with no reviewed content creates an empty draft that blocks publishing (never placeholder text)', async () => {
    await relogin();
    const id = (await ctx.db.query("SELECT id FROM mocks WHERE mock_date='2026-10-08'")).rows[0].id;
    const qid = (await mockRow(id)).question_ids[5];
    const r = await call(ctx, 'POST', `/api/admin/mocks/${id}/replace-question`, { s: content, body: { questionId: qid } });
    expect(r.status).toBe(200);
    const nq = (await ctx.db.query('SELECT status, content_needed, content FROM questions WHERE id=$1', [r.json.id])).rows[0];
    if (!r.json.fromBank) { expect(nq.content_needed).toBe(true); expect(nq.content.q.en).toBe(''); }
    const p = await call(ctx, 'POST', `/api/admin/mocks/${id}/process`, { s: content, body: { step: 'all' } });
    if (!r.json.fromBank) expect(p.json.needsWriting).toContain(r.json.id);
    expect((await call(ctx, 'POST', `/api/admin/mocks/${id}/validate`, { s: content })).json.approved).toBe(r.json.fromBank);
  });
  it('technical details (raw validator checks) are only shown to SUPER_ADMIN', async () => {
    const qid = (await mockRow(mockId)).question_ids[1];
    expect((await call(ctx, 'GET', `/api/admin/questions/${qid}`, { s: content })).json.precheck.checks).toBeUndefined();
    expect((await call(ctx, 'GET', `/api/admin/questions/${qid}`, { s: superA })).json.precheck.checks).toHaveLength(23);
  });
});
