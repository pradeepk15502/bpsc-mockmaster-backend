import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { exec, many, one, tx } from '../lib/db.js';
import { conflict, notFound } from '../lib/errors.js';
import { LIMITS } from '../lib/ratelimit.js';
import { examDate } from '../lib/time.js';
import { actorOf, parse } from '../http.js';
import { adminGuard, requirePerm } from './sessions.js';
import { SelectionSchema } from './catalog.js';
import { approveMockIfReady, createGenerationJob, createMock, publishMock, questionOps, replaceQuestion, retryFailedBatches, runChecks } from './content-core.js';
import { groups, summary } from '../domain/validator.js';
import { audit } from '../lib/audit.js';
import { OPTS } from '../domain/types.js';

const TriIn = z.object({ hi: z.string().max(4000), en: z.string().max(4000), hl: z.string().max(4000) });
const EditIn = z.object({
  content: z.object({ q: TriIn, opts: z.record(z.enum(OPTS), TriIn), why: z.record(z.enum(OPTS), TriIn), exp: TriIn, concept: TriIn, tip: TriIn }),
  correctOption: z.enum(OPTS), topic: z.string().min(1).max(200).optional(), subtopic: z.string().min(1).max(200).optional(), difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
  reason: z.string().trim().min(3).max(500),
});
const idParam = (req: any) => parse(z.string().min(3).max(160).regex(/^[A-Za-z0-9_\-]+$/), req.params.id);

export function contentRoutes(app: FastifyInstance, deps: Deps) {
  const today = () => examDate(deps.clock.now(), deps.cfg.TZ_EXAM);

  // ---------------- mocks ----------------
  app.post('/api/admin/mocks', { preHandler: adminGuard(deps, 'mock.manage') }, async req => {
    const b = parse(z.object({ selection: SelectionSchema, date: z.iso.date().optional(), mode: z.enum(['PRACTICE', 'OFFICIAL']) }), req.body);
    const date = b.date ?? today();
    if (date < today()) throw conflict('PAST_DATE', 'Mocks cannot be created for past dates.');
    const r = await tx(deps.db, c => createMock(deps, c, b.selection, date, b.mode, actorOf(req)));
    return { mock: summarizeMock(r.mock), created: r.created };
  });
  app.get('/api/admin/mocks', { preHandler: adminGuard(deps, 'mock.view') }, async req => {
    const q = parse(z.object({ date: z.iso.date().optional(), status: z.string().max(20).optional() }), req.query);
    const rows = await many(deps.db, 'SELECT * FROM mocks WHERE ($1::date IS NULL OR mock_date=$1) AND ($2::text IS NULL OR status=$2) ORDER BY mock_date DESC, id LIMIT 200', [q.date ?? null, q.status ?? null]);
    return { mocks: rows.map(summarizeMock) };
  });
  app.get('/api/admin/mocks/:id', { preHandler: adminGuard(deps, 'mock.view') }, async req => {
    const m = await one(deps.db, 'SELECT * FROM mocks WHERE id=$1', [idParam(req)]); if (!m) throw notFound('Mock');
    const qs = m.question_ids.length ? await many(deps.db, 'SELECT id, status, section, topic, subtopic, difficulty, source_type, content_needed, validation FROM questions WHERE id = ANY($1::text[])', [m.question_ids]) : [];
    const job = m.job_id ? await one(deps.db, 'SELECT * FROM generation_jobs WHERE id=$1', [m.job_id]) : null;
    return { mock: { ...summarizeMock(m), validation: m.validation, reuse: m.reuse, reuseDecision: m.reuse_decision },
      questions: (m.question_ids as string[]).map((id, i) => { const q = qs.find(x => x.id === id); return q ? { n: i + 1, id, status: q.status, section: q.section, topic: q.topic, subtopic: q.subtopic, difficulty: q.difficulty, sourceType: q.source_type, contentNeeded: q.content_needed, validation: q.validation?.result ?? null } : { n: i + 1, id, missing: true }; }),
      job: job ? { id: job.id, status: job.status, error: job.error, tokensIn: job.tokens_in, tokensOut: job.tokens_out } : null };
  });

  app.post('/api/admin/mocks/:id/generate', { preHandler: adminGuard(deps, 'question.generate') }, async req => {
    await deps.limiter.hit('generate', req.admin!.adminId, LIMITS.generatePerAdmin);
    const r = await tx(deps.db, c => createGenerationJob(deps, c, idParam(req), actorOf(req)));
    if (r.created) await deps.jobs.enqueueGeneration(r.job.id);
    return { jobId: r.job.id, status: r.job.status, duplicate: !r.created };
  });
  app.get('/api/admin/jobs/:id', { preHandler: adminGuard(deps, 'mock.view') }, async req => {
    const id = parse(z.string().uuid(), (req.params as any).id);
    const job = await one(deps.db, 'SELECT * FROM generation_jobs WHERE id=$1', [id]); if (!job) throw notFound('Generation job');
    const bs = await many(deps.db, 'SELECT n, section_id, status, tries, error, jsonb_array_length(slots) AS size, tokens_in, tokens_out FROM generation_batches WHERE job_id=$1 ORDER BY n', [id]);
    const technical = req.admin!.role === 'SUPER_ADMIN';
    return { job: { id: job.id, mockId: job.mock_id, status: job.status, error: job.error, total: job.total, tokensIn: job.tokens_in, tokensOut: job.tokens_out, createdAt: job.created_at, finishedAt: job.finished_at },
      batches: bs.map(b => ({ n: b.n, section: b.section_id, status: b.status, tries: b.tries, size: b.size, ...(technical ? { error: b.error, tokensIn: b.tokens_in, tokensOut: b.tokens_out } : { error: b.error ? 'This batch could not be generated.' : null }) })) };
  });
  app.post('/api/admin/jobs/:id/retry-failed', { preHandler: adminGuard(deps, 'question.generate') }, async req => {
    const id = parse(z.string().uuid(), (req.params as any).id);
    const n = await tx(deps.db, c => retryFailedBatches(deps, c, id, actorOf(req)));
    await deps.jobs.enqueueGeneration(id);
    return { requeued: n };
  });

  /** "Process Questions" — bulk review then validate every open question of the mock (permissions checked per step). */
  app.post('/api/admin/mocks/:id/process', { preHandler: adminGuard(deps, 'question.review') }, async req => {
    const b = parse(z.object({ step: z.enum(['review', 'validate', 'all']).default('all'), note: z.string().max(500).optional() }), req.body);
    const id = idParam(req); const actor = actorOf(req);
    const m = await one(deps.db, 'SELECT * FROM mocks WHERE id=$1', [id]); if (!m) throw notFound('Mock');
    if (!['REVIEW', 'VALIDATING'].includes(m.status)) throw conflict('INVALID_STATE', `This mock is ${m.status}; questions can be processed while it is in review.`);
    const out = { reviewed: 0, validated: 0, failedValidation: [] as string[], needsWriting: [] as string[], skipped: [] as string[] };
    for (const qid of m.question_ids as string[]) {
      const q = await one(deps.db, 'SELECT status, content_needed FROM questions WHERE id=$1', [qid]);
      if (q.content_needed) { out.needsWriting.push(qid); continue; }
      if (b.step !== 'validate' && ['AI_GENERATED', 'DRAFT', 'REVIEW'].includes(q.status)) { await tx(deps.db, c => questionOps.approve(deps, c, qid, actor, b.note ?? 'Bulk review')); out.reviewed++; }
      if (b.step !== 'review') {
        requirePerm(req, 'question.validate');
        const cur = await one(deps.db, 'SELECT status FROM questions WHERE id=$1', [qid]);
        if (cur.status === 'REVIEWED') { const v = await tx(deps.db, c => questionOps.validate(deps, c, qid, actor)); if (v.result === 'FAILED') out.failedValidation.push(qid); else out.validated++; }
        else if (!['VALIDATED', 'PUBLISHED'].includes(cur.status)) out.skipped.push(qid);
      }
    }
    return out;
  });
  app.post('/api/admin/mocks/:id/reuse-decision', { preHandler: adminGuard(deps, 'mock.manage') }, async req => {
    const b = parse(z.object({ decision: z.literal('ALLOWED'), reason: z.string().trim().min(3).max(300) }), req.body); const id = idParam(req);
    return tx(deps.db, async c => {
      const m = await one(c, 'SELECT reuse_decision FROM mocks WHERE id=$1 FOR UPDATE', [id]); if (!m) throw notFound('Mock');
      await exec(c, 'UPDATE mocks SET reuse_decision=$2 WHERE id=$1', [id, b.decision]);
      await audit(c, actorOf(req), 'REUSE_ALLOWED', 'Mock', id, m.reuse_decision, b.decision, b.reason);
      return { ok: true };
    });
  });
  app.post('/api/admin/mocks/:id/replace-question', { preHandler: adminGuard(deps, 'mock.manage') }, async req => {
    const b = parse(z.object({ questionId: z.string().min(3).max(160) }), req.body);
    return tx(deps.db, c => replaceQuestion(deps, c, idParam(req), b.questionId, actorOf(req)));
  });
  app.post('/api/admin/mocks/:id/validate', { preHandler: adminGuard(deps, 'mock.manage') }, async req => tx(deps.db, c => approveMockIfReady(deps, c, idParam(req), actorOf(req))));
  app.post('/api/admin/mocks/:id/publish', { preHandler: adminGuard(deps, 'mock.publish') }, async req => tx(deps.db, c => publishMock(deps, c, idParam(req), actorOf(req))));
  app.post('/api/admin/mocks/:id/close', { preHandler: adminGuard(deps, 'mock.manage') }, async req => {
    const id = idParam(req);
    return tx(deps.db, async c => {
      const m = await one(c, 'SELECT status FROM mocks WHERE id=$1 FOR UPDATE', [id]); if (!m) throw notFound('Mock');
      if (m.status !== 'PUBLISHED') throw conflict('INVALID_STATE', 'Only a published mock can be closed.');
      await exec(c, "UPDATE mocks SET status='CLOSED' WHERE id=$1", [id]);
      await audit(c, actorOf(req), 'MOCK_CLOSED', 'Mock', id, 'PUBLISHED', 'CLOSED', 'In-progress attempts may still finish within their time');
      return { ok: true };
    });
  });

  // ---------------- questions ----------------
  app.get('/api/admin/questions/:id', { preHandler: adminGuard(deps, 'question.view') }, async req => {
    const q = await one(deps.db, 'SELECT * FROM questions WHERE id=$1', [idParam(req)]); if (!q) throw notFound('Question');
    const checks = await runChecks(deps.db, q);
    return { question: q, precheck: { result: summary(checks), groups: groups(checks), ...(req.admin!.role === 'SUPER_ADMIN' ? { checks } : {}) } };
  });
  const op = (path: string, perm: 'question.review' | 'question.validate' | 'question.publish' | 'question.edit', fn: (c: any, id: string, req: any) => Promise<any>) =>
    app.post(`/api/admin/questions/:id/${path}`, { preHandler: adminGuard(deps, perm) }, async req => {
      const id = idParam(req);
      const res = await tx(deps.db, c => fn(c, id, req));
      const q = await one(deps.db, 'SELECT id, status, version, validation FROM questions WHERE id=$1', [res?.id ?? id]);
      return { question: { id: q.id, status: q.status, version: q.version, validation: q.validation ? { result: q.validation.result, groups: q.validation.groups } : null }, ...(res && typeof res === 'object' ? { result: res } : {}) };
    });
  op('open', 'question.review', (c, id, req) => questionOps.open(deps, c, id, actorOf(req)).then(() => null));
  op('approve', 'question.review', (c, id, req) => questionOps.approve(deps, c, id, actorOf(req), parse(z.object({ note: z.string().max(500).optional() }), req.body).note).then(() => null));
  op('reject', 'question.review', (c, id, req) => questionOps.reject(deps, c, id, actorOf(req), parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body).reason).then(() => null));
  op('validate', 'question.validate', (c, id, req) => questionOps.validate(deps, c, id, actorOf(req)).then(() => null));
  op('publish', 'question.publish', (c, id, req) => questionOps.publish(deps, c, id, actorOf(req)).then(() => null));
  op('revise', 'question.edit', (c, id, req) => questionOps.revise(deps, c, id, actorOf(req)));
  op('archive', 'question.edit', (c, id, req) => questionOps.archive(deps, c, id, actorOf(req)).then(() => null));
  app.put('/api/admin/questions/:id', { preHandler: adminGuard(deps, 'question.edit') }, async req => {
    const b = parse(EditIn, req.body); const id = idParam(req);
    await tx(deps.db, c => questionOps.edit(deps, c, id, actorOf(req), { content: b.content as any, correctOption: b.correctOption, topic: b.topic, subtopic: b.subtopic, difficulty: b.difficulty }, b.reason));
    const q = await one(deps.db, 'SELECT id, status, version FROM questions WHERE id=$1', [id]);
    return { question: q };
  });
}

function summarizeMock(m: any) {
  return { id: m.id, cohortBase: m.cohort_base, date: m.mock_date, status: m.status, mode: m.mode, configId: m.config_id, verification: m.config_snapshot?.verificationStatus,
    questions: m.question_ids?.length ?? 0, totalQuestions: m.config_snapshot?.totalQuestions, durationMinutes: m.config_snapshot?.durationMinutes, assigned: m.assigned_count, publishedAt: m.published_at };
}
