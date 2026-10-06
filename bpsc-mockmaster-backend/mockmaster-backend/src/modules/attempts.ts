import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { score, type AnswerIn, type FrozenMeta } from '../domain/scoring.js';
import { LANG_KEYS, type ConfigSnapshot } from '../domain/types.js';
import { exec, many, one, tx, type Queryable } from '../lib/db.js';
import { AppError, conflict, forbidden, notFound } from '../lib/errors.js';
import { LIMITS } from '../lib/ratelimit.js';
import { examDate } from '../lib/time.js';
import { noStore, parse, studentOf, Uuid } from '../http.js';
import { studentGuard } from './sessions.js';
import { getSettings, verificationLabel } from './catalog.js';
import { logEvent } from './events.js';
import { notify } from './notify.js';

/** Network grace for a save that left the browser just before expiry. The server clock decides; the browser timer is display only. */
const SAVE_GRACE_MS = 3_000;

const AnswerItem = z.object({
  position: z.number().int().min(1).max(1000),
  selected: z.enum(['A', 'B', 'C', 'D', 'E']).nullable(),
  marked: z.boolean().default(false),
  timeSpentSec: z.number().int().min(0).max(36_000).default(0),
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
const SaveIn = z.object({ answers: z.array(AnswerItem).min(1).max(200) });
const SubmitIn = z.object({ answers: z.array(AnswerItem).max(200).optional() });

export function timerState(a: any, now: Date) {
  const exp = new Date(a.server_expires_at).getTime();
  return {
    attemptId: a.id, status: a.status,
    serverStartedAt: new Date(a.server_started_at).toISOString(), serverExpiresAt: new Date(exp).toISOString(), serverNow: now.toISOString(),
    remainingSeconds: a.status === 'IN_PROGRESS' ? Math.max(0, Math.floor((exp - now.getTime()) / 1000)) : 0,
  };
}

async function loadOwned(c: Queryable, attemptId: string, userId: string, lock = '') {
  // Object-level authorization: the attempt must belong to the signed-in student. Someone else's id looks exactly like a missing one.
  const a = await one(c, `SELECT * FROM attempts WHERE id=$1 AND user_id=$2 ${lock}`, [attemptId, userId]);
  if (!a) throw notFound('Attempt');
  return a;
}

/**
 * Atomic, idempotent finalisation. Row lock serialises submit / auto-submit / sweeper; the second caller sees a
 * non-IN_PROGRESS status and gets the stored result back. Scoring uses the frozen mock snapshot only.
 */
export async function finalizeAttempt(deps: Deps, c: Queryable, attemptId: string, requested: 'MANUAL' | 'AUTO') {
  const a = await one(c, 'SELECT * FROM attempts WHERE id=$1 FOR UPDATE', [attemptId]);
  if (!a) throw notFound('Attempt');
  if (a.status !== 'IN_PROGRESS') return { attempt: a, duplicate: true };
  const now = deps.clock.now(); const exp = new Date(a.server_expires_at);
  const auto = requested === 'AUTO' || now.getTime() >= exp.getTime();
  const end = new Date(Math.min(now.getTime(), exp.getTime()));
  const m = await one(c, 'SELECT config_snapshot, cohort_base, id FROM mocks WHERE id=$1', [a.mock_id]);
  const snap: ConfigSnapshot = m.config_snapshot;
  const qs = await many(c, 'SELECT position, question_id, frozen FROM mock_questions WHERE mock_id=$1 ORDER BY position', [a.mock_id]);
  const ans = await many(c, 'SELECT * FROM attempt_answers WHERE attempt_id=$1', [attemptId]);
  const meta: FrozenMeta[] = qs.map(q => ({ id: q.question_id, position: q.position, section: q.frozen.section, topic: q.frozen.topic, subtopic: q.frozen.subtopic, difficulty: q.frozen.difficulty, correct: q.frozen.correct }));
  const amap: Record<string, AnswerIn> = {}; for (const x of ans) amap[x.question_id] = { selected: x.selected_option, marked: x.marked, timeSpentSec: x.time_spent_sec };
  const th = (await getSettings(c, 'thresholds')) ?? { weak: 50, ni: 70, good: 85, minSample: 3 };
  const result = score(snap, meta, amap, th);
  // Students see positions, not internal question ids.
  for (const p of result.perQuestion) { const x = ans.find(r => r.question_id === p.qid); p.changes = x?.changes ?? 0; p.answeredAt = x?.answered_at ?? null; delete p.qid; }
  const spent = Math.min(Math.round((end.getTime() - new Date(a.server_started_at).getTime()) / 1000), snap.durationMinutes * 60);
  const remaining = Math.max(0, Math.floor((exp.getTime() - end.getTime()) / 1000));
  const st = auto ? 'AUTO_SUBMITTED' : 'SUBMITTED';
  const upd = await one(c, `UPDATE attempts SET status=$2, submission_type=$3, submitted_at=$4, time_spent_sec=$5, remaining_sec=$6, result=$7 WHERE id=$1 RETURNING *`,
    [attemptId, st, auto ? 'AUTO' : 'MANUAL', end, spent, remaining, result]);
  await logEvent(c, a.user_id, auto ? 'TEST_AUTO_SUBMITTED' : 'TEST_SUBMITTED', { attemptId, mockId: a.mock_id }, end);
  await notify(c, { audience: 'student', userId: a.user_id, type: 'resultReady', title: 'Result ready', message: `${result.total.score}/${result.total.max}${auto ? ' (auto-submitted when time ran out)' : ''}`, mockId: a.mock_id }, now);
  return { attempt: upd, duplicate: false };
}

/** Worker: auto-submit every attempt whose server time is over — even if the browser was closed. */
export async function expireDueAttempts(deps: Deps, limit = 500) {
  const due = await many(deps.db, "SELECT id FROM attempts WHERE status='IN_PROGRESS' AND server_expires_at <= $1 ORDER BY server_expires_at LIMIT $2", [deps.clock.now(), limit]);
  let n = 0;
  for (const r of due) { const res = await tx(deps.db, c => finalizeAttempt(deps, c, r.id, 'AUTO')); if (!res.duplicate) n++; }
  return n;
}

async function ensureFinalIfExpired(deps: Deps, a: any) {
  if (a.status === 'IN_PROGRESS' && new Date(a.server_expires_at).getTime() <= deps.clock.now().getTime()) return (await tx(deps.db, c => finalizeAttempt(deps, c, a.id, 'AUTO'))).attempt;
  return a;
}

/** Applies a batch of answer saves. A save only wins over the stored row when its version is higher (old requests never overwrite newer answers). */
async function applySaves(deps: Deps, c: Queryable, a: any, items: z.infer<typeof AnswerItem>[]) {
  const snap: ConfigSnapshot = (await one(c, 'SELECT config_snapshot FROM mocks WHERE id=$1', [a.mock_id])).config_snapshot;
  const pos = await many(c, 'SELECT position, question_id FROM mock_questions WHERE mock_id=$1', [a.mock_id]);
  const byPos = new Map(pos.map(p => [p.position, p.question_id]));
  const now = deps.clock.now(); const results: { position: number; accepted: boolean; serverVersion: number }[] = [];
  // Highest version per position inside this batch wins locally too.
  const latest = new Map<number, z.infer<typeof AnswerItem>>();
  for (const it of items) { const cur = latest.get(it.position); if (!cur || it.version > cur.version) latest.set(it.position, it); }
  for (const it of latest.values()) {
    const qid = byPos.get(it.position);
    if (!qid) throw new AppError(400, 'INVALID_QUESTION', `Question ${it.position} is not part of this mock.`);
    if (it.selected && !snap.optionKeys.includes(it.selected)) throw new AppError(400, 'INVALID_OPTION', `Option ${it.selected} does not exist for this mock.`);
    const r = await one(c, `INSERT INTO attempt_answers (attempt_id, question_id, selected_option, marked, time_spent_sec, answered_at, version, changes, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8)
        ON CONFLICT (attempt_id, question_id) DO UPDATE SET
          selected_option = EXCLUDED.selected_option, marked = EXCLUDED.marked, time_spent_sec = EXCLUDED.time_spent_sec,
          answered_at = CASE WHEN EXCLUDED.selected_option IS DISTINCT FROM attempt_answers.selected_option THEN EXCLUDED.answered_at ELSE attempt_answers.answered_at END,
          changes = attempt_answers.changes + CASE WHEN attempt_answers.selected_option IS NOT NULL AND EXCLUDED.selected_option IS DISTINCT FROM attempt_answers.selected_option THEN 1 ELSE 0 END,
          version = EXCLUDED.version, updated_at = EXCLUDED.updated_at
        WHERE attempt_answers.version < EXCLUDED.version
        RETURNING version`,
      [a.id, qid, it.selected, it.marked, Math.min(it.timeSpentSec, snap.durationMinutes * 60), it.selected ? now : null, it.version, now]);
    if (r) results.push({ position: it.position, accepted: true, serverVersion: r.version });
    else { const cur = await one(c, 'SELECT version FROM attempt_answers WHERE attempt_id=$1 AND question_id=$2', [a.id, qid]); results.push({ position: it.position, accepted: false, serverVersion: cur.version }); }
  }
  for (const it of items) if (!latest.has(it.position) || latest.get(it.position) !== it) results.push({ position: it.position, accepted: false, serverVersion: latest.get(it.position)!.version });
  // (no write to the attempts row here: saves hold a FOR SHARE lock on it, and concurrent saves would deadlock)
  return results;
}

export function attemptRoutes(app: FastifyInstance, deps: Deps) {
  const today = () => examDate(deps.clock.now(), deps.cfg.TZ_EXAM);
  const guard = studentGuard(deps);

  app.get('/api/mocks/today', { preHandler: guard }, async (req, reply) => {
    noStore(reply);
    const u = studentOf(req); const now = deps.clock.now(); const d = today();
    const ents = await many(deps.db, 'SELECT * FROM entitlements WHERE user_id=$1 ORDER BY activated_at DESC', [u.userId]);
    const out = [];
    for (const e of ents) {
      const active = e.status === 'ACTIVE' && new Date(e.expires_at) > now;
      const status = e.status === 'ACTIVE' && !active ? 'EXPIRED' : e.status;
      const m = await one(deps.db, "SELECT * FROM mocks WHERE cohort_base=$1 AND mock_date=$2 AND status IN ('PUBLISHED','CLOSED')", [e.cohort_base, d]);
      const mine = m ? await one(deps.db, 'SELECT * FROM attempts WHERE user_id=$1 AND mock_id=$2', [u.userId, m.id]) : null;
      let state: string;
      if (mine && mine.status !== 'IN_PROGRESS') state = 'attempted';
      else if (mine && new Date(mine.server_expires_at) > now) state = 'resumable';           // a started attempt may finish even if the plan expired meanwhile
      else if (!active) state = 'blocked';
      else if (!m) state = 'unavailable';
      else if (m.status === 'CLOSED') state = 'closed';
      else state = 'available';
      const snap: ConfigSnapshot | undefined = m?.config_snapshot;
      out.push({ entitlementId: e.id, planStatus: status, examType: e.exam_type, level: e.level, paper: e.paper, subjectId: e.subject_id, otherSubjectName: e.other_subject_name, treLanguage: e.tre_language, expiresAt: e.expires_at,
        state, attemptId: mine?.id ?? null,
        mock: m ? { mockId: m.id, date: m.mock_date, totalQuestions: snap!.totalQuestions, durationMinutes: snap!.durationMinutes, mode: m.mode, modeLabel: m.mode === 'OFFICIAL' ? 'Official pattern mock' : 'Practice mock — not an official BPSC paper', verificationLabel: verificationLabel(snap!.verificationStatus), negativeMarking: snap!.negativeMarkingEnabled } : null });
    }
    return { date: d, items: out };
  });

  app.post('/api/attempts', { preHandler: guard }, async (req, reply) => {
    noStore(reply);
    const u = studentOf(req);
    await deps.limiter.hit('attempt_start', u.userId, LIMITS.attemptStartPerUser);
    const b = parse(z.object({ mockId: z.string().min(5).max(160) }), req.body);
    const now = deps.clock.now();
    const m = await one(deps.db, 'SELECT * FROM mocks WHERE id=$1', [b.mockId]);
    // Unpublished (draft / review / approved) mocks are indistinguishable from missing ones.
    if (!m || !['PUBLISHED', 'CLOSED'].includes(m.status)) throw notFound('Mock');
    const existing = await one(deps.db, 'SELECT * FROM attempts WHERE user_id=$1 AND mock_id=$2', [u.userId, m.id]);
    if (existing) {
      const a = await ensureFinalIfExpired(deps, existing);
      if (a.status !== 'IN_PROGRESS') throw conflict('ALREADY_SUBMITTED', 'You have already submitted this mock. Open your result instead.', { attemptId: a.id });
      await logEvent(deps.db, u.userId, 'MOCK_RESUMED', { attemptId: a.id, mockId: m.id }, now);
      return { ...timerState(a, now), resumed: true };
    }
    if (m.status === 'CLOSED') throw conflict('MOCK_CLOSED', 'This mock is closed.');
    if (m.mock_date !== today()) throw conflict('MOCK_NOT_TODAY', "Only today's mock can be started.");
    const ent = await one(deps.db, "SELECT * FROM entitlements WHERE user_id=$1 AND cohort_base=$2 AND status='ACTIVE' AND expires_at > $3 ORDER BY expires_at DESC LIMIT 1", [u.userId, m.cohort_base, now]);
    if (!ent) {
      const any = await one(deps.db, 'SELECT status, expires_at FROM entitlements WHERE user_id=$1 AND cohort_base=$2 ORDER BY expires_at DESC LIMIT 1', [u.userId, m.cohort_base]);
      throw forbidden(any ? 'Your plan for this mock has expired or is no longer active.' : 'This mock is not part of your plan.');
    }
    const snap: ConfigSnapshot = m.config_snapshot;
    const a = await tx(deps.db, async c => {
      const row = await one(c, `INSERT INTO attempts (user_id, mock_id, entitlement_id, status, opened_at, server_started_at, server_expires_at, last_heartbeat_at)
          VALUES ($1,$2,$3,'IN_PROGRESS',$4,$4,$5,$4) ON CONFLICT (user_id, mock_id) DO NOTHING RETURNING *`,
        [u.userId, m.id, ent.id, now, new Date(now.getTime() + snap.durationMinutes * 60_000)]);
      if (row) await logEvent(c, u.userId, 'MOCK_STARTED', { attemptId: row.id, mockId: m.id }, now);
      return row ?? one(c, 'SELECT * FROM attempts WHERE user_id=$1 AND mock_id=$2', [u.userId, m.id]);   // two tabs started at once: one attempt
    });
    await deps.jobs.scheduleAttemptExpiry(a.id, new Date(a.server_expires_at));
    return { ...timerState(a, now), resumed: false };
  });

  app.get('/api/attempts/:id', { preHandler: guard }, async (req, reply) => {
    noStore(reply);
    const u = studentOf(req); const id = parse(Uuid, (req.params as any).id);
    const a = await ensureFinalIfExpired(deps, await loadOwned(deps.db, id, u.userId));
    const ans = await many(deps.db, `SELECT mq.position, aa.selected_option, aa.marked, aa.time_spent_sec, aa.version FROM attempt_answers aa
                                     JOIN mock_questions mq ON mq.mock_id=$2 AND mq.question_id=aa.question_id WHERE aa.attempt_id=$1 ORDER BY mq.position`, [a.id, a.mock_id]);
    return { ...timerState(a, deps.clock.now()), answers: ans.map(x => ({ position: x.position, selected: x.selected_option, marked: x.marked, timeSpentSec: x.time_spent_sec, version: x.version })) };
  });

  /** Student test paper: question text, options and position only. No correct option, explanation, reasons, review or generation data. */
  app.get('/api/attempts/:id/paper', { preHandler: guard }, async (req, reply) => {
    noStore(reply);
    const u = studentOf(req); const id = parse(Uuid, (req.params as any).id);
    const a = await loadOwned(deps.db, id, u.userId);
    const m = await one(deps.db, 'SELECT config_snapshot FROM mocks WHERE id=$1', [a.mock_id]);
    const snap: ConfigSnapshot = m.config_snapshot;
    const qs = await many(deps.db, 'SELECT position, frozen FROM mock_questions WHERE mock_id=$1 ORDER BY position', [a.mock_id]);
    const bad = /\[\s*simulated|\(simulated\)|सिम्युलेटेड|simulated ai|placeholder|lorem ipsum/i;
    return {
      ...timerState(a, deps.clock.now()),
      optionKeys: snap.optionKeys, durationMinutes: snap.durationMinutes, negativeMarking: snap.negativeMarkingEnabled,
      sections: snap.sections.map(s => ({ id: s.id, name: s.name, count: s.count, marksPerQuestion: s.marksPerQuestion, negativeMarks: s.negativeMarks })),
      questions: qs.map(r => {
        const c = r.frozen.content; const text: any = {}; const opts: any = {};
        for (const l of LANG_KEYS) text[l] = c.q?.[l] ?? '';
        for (const k of snap.optionKeys) { opts[k] = {}; for (const l of LANG_KEYS) opts[k][l] = c.opts?.[k]?.[l] ?? ''; }
        const ok = (text.en || text.hi) && snap.optionKeys.every(k => opts[k].en || opts[k].hi) && !bad.test(JSON.stringify(text) + JSON.stringify(opts));
        // Integrity failure: the question is reported unavailable — never filled in with substitute text.
        return ok ? { position: r.position, section: r.frozen.section, text, options: opts } : { position: r.position, section: r.frozen.section, unavailable: true };
      }),
    };
  });

  app.put('/api/attempts/:id/answers', { preHandler: guard }, async (req, reply) => {
    noStore(reply);
    const u = studentOf(req); const id = parse(Uuid, (req.params as any).id);
    await deps.limiter.hit('answer_save', id, LIMITS.answerSavePerAttempt);
    const b = parse(SaveIn, req.body);
    const res = await tx(deps.db, async c => {
      const a = await loadOwned(c, id, u.userId, 'FOR SHARE');   // waits for an in-flight submit; never races it
      if (a.status !== 'IN_PROGRESS') return { closed: a };
      const now = deps.clock.now().getTime(); const exp = new Date(a.server_expires_at).getTime();
      if (now >= exp + SAVE_GRACE_MS) return { expired: a };
      return { results: await applySaves(deps, c, a, b.answers), a };
    });
    if ('closed' in res) throw conflict('ALREADY_SUBMITTED', 'This test has already been submitted.', { attemptId: id, status: res.closed!.status });
    if ('expired' in res) { await tx(deps.db, c => finalizeAttempt(deps, c, id, 'AUTO')); throw conflict('TIME_UP', 'Time is up. Your test was submitted automatically with the answers saved before the deadline.', { attemptId: id }); }
    await exec(deps.db, "UPDATE attempts SET last_heartbeat_at=$2 WHERE id=$1 AND status='IN_PROGRESS'", [id, deps.clock.now()]);
    return { ...timerState(res.a, deps.clock.now()), results: res.results };
  });

  app.post('/api/attempts/:id/heartbeat', { preHandler: guard }, async (req, reply) => {
    noStore(reply);
    const u = studentOf(req); const id = parse(Uuid, (req.params as any).id);
    await deps.limiter.hit('heartbeat', id, LIMITS.heartbeatPerAttempt);
    const a = await ensureFinalIfExpired(deps, await loadOwned(deps.db, id, u.userId));
    if (a.status === 'IN_PROGRESS') await exec(deps.db, 'UPDATE attempts SET last_heartbeat_at=$2 WHERE id=$1', [a.id, deps.clock.now()]);
    return timerState(a, deps.clock.now());
  });

  app.post('/api/attempts/:id/submit', { preHandler: guard }, async (req, reply) => {
    noStore(reply);
    const u = studentOf(req); const id = parse(Uuid, (req.params as any).id);
    await deps.limiter.hit('submit', id, LIMITS.submitPerAttempt);
    const b = parse(SubmitIn, req.body);
    const out = await tx(deps.db, async c => {
      const a = await loadOwned(c, id, u.userId, 'FOR UPDATE');
      if (a.status === 'IN_PROGRESS' && b.answers?.length && deps.clock.now().getTime() < new Date(a.server_expires_at).getTime() + SAVE_GRACE_MS) await applySaves(deps, c, a, b.answers);
      return finalizeAttempt(deps, c, id, 'MANUAL');
    });
    return { ...timerState(out.attempt, deps.clock.now()), duplicate: out.duplicate, submittedAt: out.attempt.submitted_at, submissionType: out.attempt.submission_type };
  });

  app.get('/api/attempts/:id/result', { preHandler: guard }, async (req, reply) => {
    noStore(reply);
    const u = studentOf(req); const id = parse(Uuid, (req.params as any).id);
    const a = await ensureFinalIfExpired(deps, await loadOwned(deps.db, id, u.userId));
    if (a.status === 'IN_PROGRESS') throw conflict('NOT_SUBMITTED', 'Submit the test to see your result.');
    const m = await one(deps.db, 'SELECT mode, config_snapshot, mock_date FROM mocks WHERE id=$1', [a.mock_id]);
    return { attemptId: a.id, status: a.status, submissionType: a.submission_type, submittedAt: a.submitted_at, timeSpentSec: a.time_spent_sec, mockDate: m.mock_date,
      mode: m.mode, verificationLabel: verificationLabel(m.config_snapshot.verificationStatus), result: a.result };
  });

  /** Post-submission review: now (and only now) the correct option, explanation, concept, option reasons and tip are returned. */
  app.get('/api/attempts/:id/review', { preHandler: guard }, async (req, reply) => {
    noStore(reply);
    const u = studentOf(req); const id = parse(Uuid, (req.params as any).id);
    const a = await ensureFinalIfExpired(deps, await loadOwned(deps.db, id, u.userId));
    if (a.status === 'IN_PROGRESS') throw conflict('NOT_SUBMITTED', 'Explanations unlock after you submit.');
    const qs = await many(deps.db, 'SELECT position, question_id, frozen FROM mock_questions WHERE mock_id=$1 ORDER BY position', [a.mock_id]);
    const ans = await many(deps.db, 'SELECT question_id, selected_option, marked FROM attempt_answers WHERE attempt_id=$1', [a.id]);
    return { attemptId: a.id, questions: qs.map(r => {
      const f = r.frozen; const x = ans.find(y => y.question_id === r.question_id);
      return { position: r.position, section: f.section, topic: f.topic, subtopic: f.subtopic, difficulty: f.difficulty, question: f.content.q, options: f.content.opts, correctOption: f.correct,
        explanation: f.content.exp, concept: f.content.concept, optionReasons: f.content.why, examTip: f.content.tip,
        // Provenance shown honestly: AI items are never labelled as previous-year questions.
        source: f.sourceType === 'PREVIOUS_YEAR' ? { label: 'Previous year question', exam: f.sourceExam, year: f.sourceYear } : f.sourceType === 'AI_GENERATED' ? { label: 'Practice question (AI-assisted, reviewed by our team)' } : { label: 'Practice question' },
        yourAnswer: x?.selected_option ?? null, marked: !!x?.marked, result: !x?.selected_option ? 'SKIPPED' : x.selected_option === f.correct ? 'CORRECT' : 'WRONG' };
    }) };
  });

  app.post('/api/attempts/:id/explanations', { preHandler: guard }, async req => {
    const u = studentOf(req); const id = parse(Uuid, (req.params as any).id);
    await deps.limiter.hit('events', u.userId, LIMITS.eventsPerUser);
    const b = parse(z.object({ position: z.number().int().min(1).max(1000), action: z.enum(['open', 'close']) }), req.body);
    const a = await loadOwned(deps.db, id, u.userId);
    if (a.status === 'IN_PROGRESS') throw conflict('NOT_SUBMITTED', 'Explanations unlock after you submit.');
    const q = await one(deps.db, 'SELECT question_id FROM mock_questions WHERE mock_id=$1 AND position=$2', [a.mock_id, b.position]); if (!q) throw notFound('Question');
    const now = deps.clock.now();
    if (b.action === 'open') {
      await exec(deps.db, 'INSERT INTO explanation_views (user_id, attempt_id, mock_id, question_id, opened_at) VALUES ($1,$2,$3,$4,$5)', [u.userId, a.id, a.mock_id, q.question_id, now]);
      await logEvent(deps.db, u.userId, 'EXPLANATION_OPENED', { attemptId: a.id, mockId: a.mock_id, questionId: q.question_id }, now);
    } else {
      await exec(deps.db, `UPDATE explanation_views SET closed_at=$4, duration_sec = LEAST(1800, GREATEST(1, EXTRACT(EPOCH FROM ($4 - opened_at))::int))
                           WHERE id = (SELECT id FROM explanation_views WHERE user_id=$1 AND attempt_id=$2 AND question_id=$3 AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1)`, [u.userId, a.id, q.question_id, now]);
      await logEvent(deps.db, u.userId, 'EXPLANATION_CLOSED', { attemptId: a.id, mockId: a.mock_id, questionId: q.question_id }, now);
    }
    return { ok: true };
  });

  app.get('/api/attempts', { preHandler: guard }, async (req, reply) => {
    noStore(reply);
    const rows = await many(deps.db, `SELECT a.id, a.status, a.submitted_at, a.result->'total' AS total, m.mock_date, m.mode, m.exam_type, m.level, m.paper, m.subject_id
                                      FROM attempts a JOIN mocks m ON m.id = a.mock_id WHERE a.user_id=$1 ORDER BY a.opened_at DESC LIMIT 200`, [studentOf(req).userId]);
    return { attempts: rows.map(r => ({ attemptId: r.id, status: r.status, submittedAt: r.submitted_at, date: r.mock_date, mode: r.mode, examType: r.exam_type, level: r.level, paper: r.paper, subjectId: r.subject_id,
      score: r.total ? { score: r.total.score, max: r.total.max, accuracy: r.total.accuracy } : null })) };
  });
}
