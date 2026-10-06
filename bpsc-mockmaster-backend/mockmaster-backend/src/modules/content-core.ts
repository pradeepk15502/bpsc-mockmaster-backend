/**
 * Content pipeline (architecture frozen from the approved prototype):
 *   Admin → mock (DRAFT, frozen config snapshot + blueprint) → generation job → queue → worker
 *   → reviewed-bank reuse first, Claude for the rest (batches, retries, schema validation)
 *   → AI_GENERATED → REVIEW → REVIEWED → VALIDATED (23 checks) → mock validation → APPROVED → PUBLISHED (frozen).
 */
import type { Deps } from '../deps.js';
import { GeneratedBatch, toContent } from '../domain/contract.js';
import { fingerprintOf, jaccard, pct, semanticOf } from '../domain/text.js';
import { cohortBase, normSubject, OPTS, type ConfigSection, type ConfigSnapshot, type MockSection, type OptKey, type QuestionContent, type Selection } from '../domain/types.js';
import { checkQuestion, groups, ruleFor, summary, VALIDATOR_VERSION, type BlueprintRule, type Check } from '../domain/validator.js';
import { audit, SYSTEM, type Actor } from '../lib/audit.js';
import { exec, many, one, tx, type Queryable } from '../lib/db.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { activeConfig, blueprintCompliance, configUsable, getSettings, sectionSubject, syllabusSubjectFor } from './catalog.js';
import { notify } from './notify.js';
import { can, type Action } from './rbac.js';

// ------------------------------------------------------------------ mocks
export function buildSnapshot(cfg: any, mode: 'PRACTICE' | 'OFFICIAL'): ConfigSnapshot {
  const negOn = mode === 'PRACTICE' ? !!cfg.practice.negativeMarkingEnabled : !!cfg.negative_marking;
  const sections: MockSection[] = (cfg.sections as ConfigSection[]).slice().sort((a, b) => a.order - b.order).map(s => ({
    id: s.id, name: s.name, kind: s.kind, role: s.role, qualifying: s.kind === 'QUALIFYING', marksPerQuestion: s.marksPerQuestion,
    negativeMarks: negOn ? (mode === 'PRACTICE' ? cfg.practice.negativeMarks : s.negativeMarks) : 0,
    qualifyingPercent: s.kind === 'QUALIFYING' ? (mode === 'PRACTICE' ? s.practiceQualifyingPercent : s.qualifyingPercent) : null,
    qualifyingSource: s.kind === 'QUALIFYING' ? (mode === 'PRACTICE' ? (s.practiceQualifyingPercent == null ? 'PENDING' : 'PRACTICE') : (s.qualifyingPercent == null ? 'PENDING' : 'OFFICIAL')) : null,
    count: mode === 'PRACTICE' ? s.practiceCount : s.questionCount,
  }));
  return {
    configId: cfg.id, version: cfg.version, verificationStatus: cfg.verification_status, mode, examType: cfg.exam_type,
    optionKeys: OPTS.slice(0, cfg.option_count) as OptKey[], durationMinutes: mode === 'PRACTICE' ? cfg.practice.durationMinutes : cfg.duration_minutes,
    negativeMarkingEnabled: negOn, passPercent: cfg.exam_type === 'STET' ? (mode === 'PRACTICE' ? cfg.practice.passPercent ?? null : cfg.pass_percent ?? null) : null,
    sections, totalQuestions: sections.reduce((a, s) => a + s.count, 0),
  };
}

const slug = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'other';
export const mockIdOf = (sel: Selection, date: string, cfgVersion: number, subjectCode: string) =>
  ['mock', sel.examType.toLowerCase(), (sel.examType === 'TRE' ? sel.level! : sel.paper!).replace('-', '').toLowerCase(), subjectCode, ...(sel.examType === 'TRE' ? [sel.treLanguage] : []), date.replace(/-/g, ''), 'v' + cfgVersion].join('_');

async function autoDraftBlueprint(c: Queryable, cfg: any, subjectId: string, mode: 'PRACTICE' | 'OFFICIAL') {
  const topics = await many(c, 'SELECT name, subtopics FROM topics WHERE subject_id=$1 ORDER BY sort', [subjectId]);
  const rules: BlueprintRule[] = [];
  for (const s of (cfg.sections as ConfigSection[]).slice().sort((a, b) => a.order - b.order)) {
    const n = mode === 'PRACTICE' ? s.practiceCount : s.questionCount;
    if (s.role === 'SUBJECT' && topics.length) {
      const slots: [string, string][] = []; topics.forEach(t => (t.subtopics as string[]).forEach(st => slots.push([t.name, st])));
      const per = new Map<string, number>(); for (let i = 0; i < n; i++) { const k = slots[i % slots.length].join('|'); per.set(k, (per.get(k) ?? 0) + 1); }
      for (const [k, v] of per) { const [t, st] = k.split('|'); rules.push({ sectionId: s.id, topic: t, subtopic: st, count: v }); }
    } else rules.push({ sectionId: s.id, topic: '*', subtopic: '*', count: n });
  }
  const id = `BP_${cfg.id}_${subjectId.toUpperCase()}_${mode}`;
  return one(c, `INSERT INTO blueprints (id, config_id, subject_id, mode, difficulty, rules) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (config_id, subject_id, mode) DO UPDATE SET id = blueprints.id RETURNING *`,
    [id, cfg.id, subjectId, mode, { EASY: 30, MEDIUM: 50, HARD: 20 }, JSON.stringify(rules)]);
}

export async function createMock(deps: Deps, c: Queryable, sel: Selection, date: string, mode: 'PRACTICE' | 'OFFICIAL', actor: Actor) {
  const cfg = await activeConfig(c, sel.examType, (sel.examType === 'TRE' ? sel.level : sel.paper)!);
  if (!configUsable(cfg)) throw conflict('NO_ACTIVE_CONFIG', 'There is no active configuration with sections for this exam.');
  if (mode === 'OFFICIAL' && cfg.verification_status !== 'OFFICIALLY_VERIFIED') throw conflict('CONFIG_NOT_VERIFIED', 'Official Pattern mocks need an officially verified configuration.');
  if (cfg.verification_status === 'PENDING_VERIFICATION') throw conflict('CONFIG_PENDING_VERIFICATION', 'Verify this configuration or mark it as a practice configuration first.');
  const syl = await syllabusSubjectFor(c, sel);
  if (!syl) throw conflict('OTHER_SUBJECT_NOT_MAPPED', 'Link this "Other" subject to a syllabus first.');
  let bp = await one(c, 'SELECT * FROM blueprints WHERE config_id=$1 AND subject_id=$2 AND mode=$3', [cfg.id, syl, mode]);
  if (!bp) bp = await autoDraftBlueprint(c, cfg, syl, mode);
  if (!blueprintCompliance(cfg.sections, bp, mode).ok) throw conflict('BLUEPRINT_INCOMPLETE', `Blueprint ${bp.id} does not add up to the configured section counts.`);
  const base = cohortBase(sel);
  const existing = await one(c, 'SELECT * FROM mocks WHERE cohort_base=$1 AND mock_date=$2', [base, date]);
  if (existing) return { mock: existing, created: false };
  const subj = sel.subjectId === 'other' ? null : await one(c, 'SELECT code FROM subjects WHERE id=$1', [sel.subjectId]);
  const code = sel.subjectId === 'other' ? 'oth-' + slug(normSubject(sel.otherSubjectName)) : subj?.code ?? sel.subjectId;
  const id = mockIdOf(sel, date, cfg.version, code);
  const no = (await one<{ n: number }>(c, 'SELECT count(*)::int n FROM mocks WHERE cohort_base=$1', [base]))!.n + 1;
  const snap = buildSnapshot(cfg, mode);
  const m = await one(c, `INSERT INTO mocks (id, cohort_base, cohort_key, mock_no, mock_date, exam_type, level, paper, subject_id, other_subject_key, other_subject_name, syllabus_subject_id,
      tre_language, mode, config_id, config_snapshot, blueprint_id, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'DRAFT',$18)
      ON CONFLICT (cohort_base, mock_date) DO NOTHING RETURNING *`,
    [id, base, base + '|' + cfg.id, no, date, sel.examType, sel.level, sel.paper, sel.subjectId, sel.subjectId === 'other' ? normSubject(sel.otherSubjectName) : null,
      sel.otherSubjectName ?? null, syl, sel.treLanguage, mode, cfg.id, snap, bp.id, actor.name ?? 'system']);
  if (!m) return { mock: await one(c, 'SELECT * FROM mocks WHERE cohort_base=$1 AND mock_date=$2', [base, date]), created: false };
  await audit(c, actor, 'MOCK_CREATED', 'Mock', id, null, 'DRAFT', `${mode} · ${cfg.id} (${cfg.verification_status})`);
  return { mock: m, created: true };
}

/** Slot plan: blueprint rules expanded per section; difficulty assigned by largest remainder to match the blueprint mix. */
export function planSlots(snap: ConfigSnapshot, bp: { rules: BlueprintRule[]; difficulty: Record<string, number> }) {
  const out: { n: number; sectionId: string; topic: string; subtopic: string; difficulty: 'EASY' | 'MEDIUM' | 'HARD' }[] = [];
  let n = 0;
  for (const sec of snap.sections) {
    const slots: BlueprintRule[] = []; bp.rules.filter(r => r.sectionId === sec.id).forEach(r => { for (let i = 0; i < r.count; i++) slots.push(r); });
    while (slots.length < sec.count) slots.push({ sectionId: sec.id, topic: '*', subtopic: '*', count: 1 });
    const total = sec.count; const levels = ['EASY', 'MEDIUM', 'HARD'] as const;
    const exact = levels.map(l => (bp.difficulty[l] ?? 0) * total / 100); const base = exact.map(Math.floor);
    let rest = total - base.reduce((a, b) => a + b, 0);
    exact.map((x, i) => [x - base[i], i] as const).sort((a, b) => b[0] - a[0]).forEach(([, i]) => { if (rest > 0) { base[i]++; rest--; } });
    const diffs: ('EASY' | 'MEDIUM' | 'HARD')[] = []; levels.forEach((l, i) => { for (let k = 0; k < base[i]; k++) diffs.push(l); });
    // interleave so each topic gets a spread of difficulty
    const order = diffs.map((d, i) => ({ d, k: (i * 7919) % (diffs.length || 1) })).sort((a, b) => a.k - b.k).map(x => x.d);
    slots.slice(0, sec.count).forEach((r, i) => { n++; out.push({ n, sectionId: sec.id, topic: r.topic, subtopic: r.subtopic, difficulty: order[i] ?? 'MEDIUM' }); });
  }
  return out;
}

export async function createGenerationJob(deps: Deps, c: Queryable, mockId: string, actor: Actor) {
  const m = await one(c, 'SELECT * FROM mocks WHERE id=$1 FOR UPDATE', [mockId]);
  if (!m) throw notFound('Mock');
  const key = `generate:${m.cohort_key}:${m.mock_date}`;
  const prev = await one(c, 'SELECT * FROM generation_jobs WHERE idempotency_key=$1', [key]);
  if (prev) return { job: prev, created: false };                     // idempotent: a second Generate returns the same job
  if (m.status !== 'DRAFT') throw conflict('INVALID_STATE', `Questions can only be generated for a DRAFT mock (current: ${m.status}).`);
  const bp = await one(c, 'SELECT * FROM blueprints WHERE id=$1', [m.blueprint_id]);
  const slots = planSlots(m.config_snapshot, bp);
  const size = (await getSettings(c, 'generation'))?.batchSize ?? 5;
  const job = await one(c, `INSERT INTO generation_jobs (idempotency_key, mock_id, status, batch_size, total, created_by, created_at) VALUES ($1,$2,'QUEUED',$3,$4,$5,$6) RETURNING *`,
    [key, m.id, size, slots.length, actor.name ?? 'system', deps.clock.now()]);
  let b = 0;
  for (const sec of (m.config_snapshot as ConfigSnapshot).sections) {
    const ss = slots.filter(s => s.sectionId === sec.id);
    for (let i = 0; i < ss.length; i += size) { b++; await exec(c, `INSERT INTO generation_batches (job_id, n, section_id, slots, status) VALUES ($1,$2,$3,$4,'PENDING')`, [job.id, b, sec.id, JSON.stringify(ss.slice(i, i + size))]); }
  }
  await exec(c, "UPDATE mocks SET status='GENERATING', job_id=$2 WHERE id=$1", [m.id, job.id]);
  await audit(c, actor, 'GENERATION_REQUESTED', 'Mock', m.id, 'DRAFT', 'GENERATING', `${slots.length} questions in ${b} batches`);
  return { job, created: true };
}

// ------------------------------------------------------------------ generation worker
class BudgetExceeded extends Error {}
const isUnavailable = (e: any) => !!(e && (e.name === 'APIConnectionError' || e.name === 'APIConnectionTimeoutError' || (typeof e.status === 'number' && (e.status >= 500 || e.status === 429))));

async function tokensUsedToday(deps: Deps): Promise<number> {
  const since = new Date(deps.clock.now().getTime() - 86400_000);
  return (await one<{ n: number }>(deps.db, 'SELECT COALESCE(sum(tokens_in + tokens_out),0)::bigint n FROM generation_batches WHERE updated_at >= $1', [since]))!.n;
}

/** Pool-first: a reviewed bank question not yet used in this cohort's mocks (or this job). */
async function pickFromPool(c: Queryable, m: any, sec: MockSection, slot: any, exclude: string[]) {
  const subjectId = sectionSubject(sec.role, m.syllabus_subject_id, m.tre_language);
  return one(c, `SELECT * FROM questions q WHERE in_pool AND status='PUBLISHED' AND NOT content_needed AND section=$1 AND subject_id=$2 AND option_count=$3
        AND ($4::text IS NULL OR exam_lang=$4) AND ($5='*' OR topic=$5) AND ($6='*' OR subtopic=$6) AND NOT (origin_id = ANY($7::text[]))
        AND NOT EXISTS (SELECT 1 FROM mock_questions mq JOIN mocks mm ON mm.id = mq.mock_id JOIN questions u ON u.id = mq.question_id
                        WHERE mm.cohort_base = $8 AND u.origin_id = q.origin_id)
      ORDER BY (difficulty = $9) DESC, published_at, id LIMIT 1`,
    [sec.id, subjectId, m.config_snapshot.optionKeys.length, sec.role === 'LANGUAGE' ? m.tre_language : null, slot.topic, slot.subtopic, exclude, m.cohort_base, slot.difficulty]);
}

function qRow(m: any, sec: MockSection, id: string, origin: string, slot: any, content: QuestionContent, correct: string, src: { source_type: string; source_exam?: any; source_year?: any; source_document?: any; source_url?: any }, jobId: string, topic: string, subtopic: string, difficulty: string) {
  return {
    id, origin_id: origin, status: 'AI_GENERATED', exam_type: m.exam_type, level: m.level, paper: m.paper, section: sec.id,
    subject_id: sectionSubject(sec.role, m.syllabus_subject_id, m.tre_language), exam_lang: sec.role === 'LANGUAGE' ? m.tre_language : null,
    topic, subtopic, difficulty, correct_option: correct, option_count: m.config_snapshot.optionKeys.length, content,
    source_type: src.source_type, source_exam: src.source_exam ?? null, source_year: src.source_year ?? null, source_document: src.source_document ?? null, source_url: src.source_url ?? null,
    fingerprint: fingerprintOf(content.q.en, content.q.hi), semantic_hash: semanticOf(content.q.en, content.q.hi), generated_for: m.id, job_id: jobId, slot: slot.n,
  };
}
async function insertQuestion(c: Queryable, r: any, now: Date) {
  await exec(c, `INSERT INTO questions (id, origin_id, version, status, exam_type, level, paper, section, subject_id, exam_lang, topic, subtopic, difficulty, correct_option, option_count, content,
      source_type, source_exam, source_year, source_document, source_url, content_needed, in_pool, fingerprint, semantic_hash, generated_for, job_id, created_at, updated_at)
    VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,false,$22,$23,$24,$25,$26,$26)`,
    [r.id, r.origin_id, r.status, r.exam_type, r.level, r.paper, r.section, r.subject_id, r.exam_lang, r.topic, r.subtopic, r.difficulty, r.correct_option, r.option_count, r.content,
      r.source_type, r.source_exam, r.source_year, r.source_document, r.source_url, !!r.content_needed, r.fingerprint, r.semantic_hash, r.generated_for, r.job_id, now]);
}
export const questionIdFor = (mockId: string, n: number) => 'Q_' + mockId.replace(/^mock_/, '').toUpperCase() + '_' + String(n).padStart(4, '0');
const filterContent = (content: QuestionContent, keys: OptKey[]): QuestionContent => {
  const opts: any = {}, why: any = {}; for (const k of keys) { if ((content.opts as any)[k]) opts[k] = (content.opts as any)[k]; if ((content.why as any)[k]) why[k] = (content.why as any)[k]; }
  return { ...content, opts, why };
};

async function runBatch(deps: Deps, job: any, m: any, b: any) {
  const snap: ConfigSnapshot = m.config_snapshot; const sec = snap.sections.find(s => s.id === b.section_id)!;
  const now = deps.clock.now(); const rows: any[] = []; const remaining: any[] = [];
  const used = (await many(deps.db, 'SELECT origin_id FROM questions WHERE job_id=$1', [job.id])).map(r => r.origin_id);
  for (const slot of b.slots) {
    const src = await pickFromPool(deps.db, m, sec, slot, used.concat(rows.map(r => r.origin_id)));
    if (src) {
      // Reuse keeps the original provenance (an AI item stays AI_GENERATED, a sourced PYQ keeps its source). Needs review again for this mock.
      rows.push(qRow(m, sec, questionIdFor(m.id, slot.n), src.origin_id, slot, filterContent(src.content, snap.optionKeys), src.correct_option,
        { source_type: src.source_type, source_exam: src.source_exam, source_year: src.source_year, source_document: src.source_document, source_url: src.source_url }, job.id, src.topic, src.subtopic, src.difficulty));
    } else remaining.push(slot);
  }
  let usage = { inputTokens: 0, outputTokens: 0 };
  if (remaining.length) {
    const budget = deps.cfg.GENERATION_DAILY_TOKEN_BUDGET;
    if ((await tokensUsedToday(deps)) >= budget) throw new BudgetExceeded('Daily generation token budget reached.');
    const subjName = (await one(deps.db, 'SELECT name FROM subjects WHERE id=$1', [m.syllabus_subject_id]))?.name ?? m.syllabus_subject_id;
    const res = await deps.generator.generate({
      exam: m.exam_type, levelOrPaper: m.level ?? m.paper, subject: subjName, sectionName: sec.name, sectionRole: sec.role, treLanguage: m.tre_language, optionKeys: snap.optionKeys,
      slots: remaining.map(s => ({ slot: s.n, section: sec.id, topic: s.topic, subtopic: s.subtopic, difficulty: s.difficulty })),
    });
    usage = res.usage;
    await exec(deps.db, 'UPDATE generation_batches SET tokens_in = tokens_in + $2, tokens_out = tokens_out + $3, updated_at=$4 WHERE id=$1', [b.id, usage.inputTokens, usage.outputTokens, now]);
    await exec(deps.db, 'UPDATE generation_jobs SET tokens_in = tokens_in + $2, tokens_out = tokens_out + $3 WHERE id=$1', [job.id, usage.inputTokens, usage.outputTokens]);
    const parsed = GeneratedBatch.safeParse(res.raw);
    if (!parsed.success) throw new Error('Claude response failed schema validation: ' + parsed.error.issues.slice(0, 3).map(i => i.path.join('.') + ' ' + i.message).join('; '));
    for (const slot of remaining) {
      const item = parsed.data.items.find(i => i.slot === slot.n);
      if (!item) throw new Error(`Claude response is missing slot ${slot.n}`);
      if ((slot.topic !== '*' && item.topic !== slot.topic) || (slot.subtopic !== '*' && item.subtopic !== slot.subtopic)) throw new Error(`Slot ${slot.n} came back for the wrong syllabus node`);
      const content = toContent(item, snap.optionKeys);
      const id = questionIdFor(m.id, slot.n);
      // AI output is always labelled AI_GENERATED with no exam/year — it can never pose as a previous-year question.
      rows.push(qRow(m, sec, id, id, slot, content, item.correctOption, { source_type: 'AI_GENERATED' }, job.id, item.topic, item.subtopic, item.difficulty));
    }
  }
  await tx(deps.db, async c => {
    for (const r of rows) await insertQuestion(c, r, now);
    await exec(c, "UPDATE generation_batches SET status='DONE', error=NULL, question_ids=$2, updated_at=$3 WHERE id=$1", [b.id, rows.sort((a, b2) => a.slot - b2.slot).map(r => r.id), now]);
  });
}

export async function processGenerationJob(deps: Deps, jobId: string, opts: { backoffMs?: number } = {}) {
  const maxTries = ((await getSettings(deps.db, 'generation'))?.maxTries ?? 3) as number;
  const backoff = opts.backoffMs ?? 2000;
  const job = await one(deps.db, 'SELECT * FROM generation_jobs WHERE id=$1', [jobId]);
  if (!job || ['COMPLETED'].includes(job.status)) return job?.status ?? 'MISSING';
  // Single runner per job across worker replicas.
  const lock = await deps.redis.set(`${deps.cfg.QUEUE_PREFIX}:lock:gen:${jobId}`, '1', 'EX', 1800, 'NX');
  if (!lock) return 'LOCKED';
  try {
    await exec(deps.db, "UPDATE generation_jobs SET status='RUNNING', started_at=COALESCE(started_at,$2), error=NULL WHERE id=$1", [jobId, deps.clock.now()]);
    const m = await one(deps.db, 'SELECT * FROM mocks WHERE id=$1', [job.mock_id]);
    const batches = await many(deps.db, "SELECT * FROM generation_batches WHERE job_id=$1 AND status IN ('PENDING','RETRYING','RUNNING') ORDER BY n", [jobId]);
    let unavailable = 0, budget = false;
    for (const b of batches) {
      for (;;) {
        const tries = (await one<{ tries: number }>(deps.db, "UPDATE generation_batches SET status='RUNNING', tries = tries + 1, updated_at=$2 WHERE id=$1 RETURNING tries", [b.id, deps.clock.now()]))!.tries;
        try { await runBatch(deps, job, m, b); break; }
        catch (e: any) {
          const msg = String(e?.message ?? e).slice(0, 500);
          if (e instanceof BudgetExceeded) { budget = true; await exec(deps.db, "UPDATE generation_batches SET status='FAILED', error=$2, updated_at=$3 WHERE id=$1", [b.id, msg, deps.clock.now()]); break; }
          if (tries < maxTries) {
            await exec(deps.db, "UPDATE generation_batches SET status='RETRYING', error=$2, updated_at=$3 WHERE id=$1", [b.id, `Try ${tries} failed: ${msg}`, deps.clock.now()]);
            if (backoff) await new Promise(r => setTimeout(r, backoff * Math.pow(2, tries - 1)));   // exponential backoff
            continue;
          }
          if (isUnavailable(e)) unavailable++;
          await exec(deps.db, "UPDATE generation_batches SET status='FAILED', error=$2, updated_at=$3 WHERE id=$1", [b.id, `Failed after ${tries} tries: ${msg}`, deps.clock.now()]);
          break;
        }
      }
      if (budget) { await exec(deps.db, "UPDATE generation_batches SET status='FAILED', error='Daily generation token budget reached', updated_at=$2 WHERE job_id=$1 AND status IN ('PENDING','RETRYING')", [jobId, deps.clock.now()]); break; }
    }
    return await finishJob(deps, jobId, { unavailable, budget });
  } finally {
    await deps.redis.del(`${deps.cfg.QUEUE_PREFIX}:lock:gen:${jobId}`);
  }
}

async function finishJob(deps: Deps, jobId: string, info: { unavailable: number; budget: boolean }) {
  const now = deps.clock.now();
  return tx(deps.db, async c => {
    const job = await one(c, 'SELECT * FROM generation_jobs WHERE id=$1 FOR UPDATE', [jobId]);
    const m = await one(c, 'SELECT * FROM mocks WHERE id=$1 FOR UPDATE', [job.mock_id]);
    const bs = await many(c, 'SELECT * FROM generation_batches WHERE job_id=$1 ORDER BY n', [jobId]);
    const failed = bs.filter(b => b.status === 'FAILED');
    if (failed.length) {
      const all = failed.length === bs.length;
      const status = info.budget ? 'BUDGET_EXCEEDED' : all && info.unavailable === failed.length ? 'CLAUDE_UNAVAILABLE' : all ? 'FAILED' : 'PARTIAL_FAILED';
      const error = status === 'CLAUDE_UNAVAILABLE' ? 'Claude is unavailable. No questions were generated; retry when the API recovers.'
        : status === 'BUDGET_EXCEEDED' ? 'The daily generation budget was reached. Completed batches are saved; retry the failed batches tomorrow or raise the budget.'
        : `${failed.length} of ${bs.length} batches failed. ${bs.length - failed.length} batches are saved — retry only the failed batches.`;
      await exec(c, 'UPDATE generation_jobs SET status=$2, error=$3, finished_at=$4 WHERE id=$1', [jobId, status, error, now]);
      if (all && !bs.some(b => b.status === 'DONE')) await exec(c, "UPDATE mocks SET status='DRAFT' WHERE id=$1", [m.id]);
      await notify(c, { audience: 'admin', type: 'jobFailed', title: status === 'CLAUDE_UNAVAILABLE' ? 'Claude unavailable' : 'Generation job needs attention', message: `${m.id} · ${error}`, mockId: m.id }, now);
      await audit(c, SYSTEM, 'GENERATION_' + status, 'GenerationJob', jobId, 'RUNNING', status, error);
      return status;
    }
    const ids = bs.flatMap(b => b.question_ids as string[]);
    await exec(c, "UPDATE generation_jobs SET status='COMPLETED', error=NULL, finished_at=$2 WHERE id=$1", [jobId, now]);
    await exec(c, "UPDATE mocks SET question_ids=$2, status='VALIDATING' WHERE id=$1", [m.id, ids]);
    const reuse = await reuseAgainstPrevious(c, { ...m, question_ids: ids });
    await exec(c, "UPDATE mocks SET reuse=$2, reuse_decision=$3 WHERE id=$1", [m.id, JSON.stringify(reuse), reuse.length ? null : 'NONE_FOUND']);
    const v = await validateMock(c, (await one(c, 'SELECT * FROM mocks WHERE id=$1', [m.id]))!);
    await exec(c, "UPDATE mocks SET validation=$2, status='REVIEW' WHERE id=$1", [m.id, v]);
    await notify(c, { audience: 'admin', type: 'reviewPending', title: 'Questions ready for review', message: `${m.id} · ${ids.length} questions`, mockId: m.id }, now);
    await audit(c, SYSTEM, 'GENERATION_COMPLETED', 'GenerationJob', jobId, 'RUNNING', 'COMPLETED', `${ids.length} questions → REVIEW`);
    return 'COMPLETED';
  });
}

export async function retryFailedBatches(deps: Deps, c: Queryable, jobId: string, actor: Actor) {
  const job = await one(c, 'SELECT * FROM generation_jobs WHERE id=$1 FOR UPDATE', [jobId]); if (!job) throw notFound('Generation job');
  const n = await exec(c, "UPDATE generation_batches SET status='PENDING', tries=0, error=NULL WHERE job_id=$1 AND status='FAILED'", [jobId]);
  if (!n) throw conflict('NOTHING_TO_RETRY', 'This job has no failed batches.');
  await exec(c, "UPDATE generation_jobs SET status='QUEUED', error=NULL, finished_at=NULL WHERE id=$1", [jobId]);
  await exec(c, "UPDATE mocks SET status='GENERATING' WHERE id=$1 AND status IN ('DRAFT','GENERATING')", [job.mock_id]);
  await audit(c, actor, 'GENERATION_RETRY_FAILED', 'GenerationJob', jobId, job.status, 'QUEUED', `${n} failed batch(es) re-queued`);
  return n;
}

// ------------------------------------------------------------------ duplicate / reuse checks
async function reuseAgainstPrevious(c: Queryable, m: any) {
  const prev = await many(c, `SELECT mq.mock_id, mq.question_id, mq.frozen FROM mock_questions mq JOIN mocks mm ON mm.id = mq.mock_id WHERE mm.cohort_base=$1 AND mm.id <> $2`, [m.cohort_base, m.id]);
  const qs = await many(c, 'SELECT id, origin_id, fingerprint, semantic_hash, content, topic, correct_option FROM questions WHERE id = ANY($1::text[])', [m.question_ids]);
  const out: any[] = [];
  m.question_ids.forEach((id: string, i: number) => {
    const q = qs.find(x => x.id === id); if (!q) return;
    for (const p of prev) {
      const f = p.frozen; const how = f.originId === q.origin_id ? 'same question reused' : f.fingerprint === q.fingerprint ? 'same wording' : f.semanticHash === q.semantic_hash ? 'same concept words' : jaccard(q.content.q.en, f.content.q.en) >= 0.7 ? 'similar wording' : null;
      if (how) { out.push({ qid: id, n: i + 1, prev: p.mock_id, how }); break; }
    }
  });
  return out;
}

// ------------------------------------------------------------------ question validation context
export async function checkContext(c: Queryable, q: any) {
  const m = await one(c, "SELECT * FROM mocks WHERE $1 = ANY(question_ids) AND status <> 'CLOSED' ORDER BY created_at DESC LIMIT 1", [q.id]);
  let optionKeys: OptKey[];
  if (m) optionKeys = (m.config_snapshot as ConfigSnapshot).optionKeys;
  else { const cfg = q.exam_type ? await activeConfig(c, q.exam_type, q.exam_type === 'TRE' ? q.level : q.paper) : null; optionKeys = OPTS.slice(0, cfg?.option_count ?? q.option_count) as OptKey[]; }
  const sec = m ? (m.config_snapshot as ConfigSnapshot).sections.find(s => s.id === q.section) : null;
  const topics = await many(c, 'SELECT name, subtopics FROM topics WHERE subject_id=$1', [q.subject_id]);
  const bp = m ? await one(c, 'SELECT rules FROM blueprints WHERE id=$1', [m.blueprint_id]) : null;
  const dups = (await many(c, `SELECT id FROM questions WHERE id <> $1 AND origin_id <> $2 AND status IN ('VALIDATED','PUBLISHED') AND NOT content_needed AND (fingerprint=$3 OR semantic_hash=$4) LIMIT 5`,
    [q.id, q.origin_id, q.fingerprint, q.semantic_hash])).map(r => r.id);
  return { optionKeys, syllabus: topics.length ? topics.map(t => ({ name: t.name, subtopics: t.subtopics })) : null, expectedSubjectId: sec?.role === 'SUBJECT' ? m.syllabus_subject_id : null, blueprint: bp?.rules ?? null, inMock: !!m, bankDuplicates: dups };
}
export async function runChecks(c: Queryable, q: any): Promise<Check[]> { return checkQuestion(q, await checkContext(c, q)); }

// ------------------------------------------------------------------ mock-level validation (before approve / publish)
export async function validateMock(c: Queryable, m: any) {
  const snap: ConfigSnapshot = m.config_snapshot; const checks: { label: string; status: string; detail: string }[] = [];
  const add = (label: string, status: string, detail = 'OK') => checks.push({ label, status, detail });
  const qs = m.question_ids.length ? await many(c, 'SELECT * FROM questions WHERE id = ANY($1::text[])', [m.question_ids]) : [];
  const byId = new Map(qs.map(q => [q.id, q])); const ordered = (m.question_ids as string[]).map(id => byId.get(id)).filter(Boolean) as any[];
  const num = (q: any) => 'Q' + ((m.question_ids as string[]).indexOf(q.id) + 1);
  const cfg = await one(c, 'SELECT * FROM exam_configs WHERE id=$1', [m.config_id]);
  add(`Configuration (${m.config_id})`, cfg && cfg.status !== 'DRAFT' ? 'PASS' : 'FAIL', cfg ? cfg.status : 'missing');
  add('Official data policy', cfg?.verification_status === 'OFFICIALLY_VERIFIED' ? 'PASS' : m.mode === 'PRACTICE' && cfg?.verification_status === 'PRACTICE_CONFIGURATION' ? 'WARN' : 'FAIL',
    (cfg?.verification_status ?? 'missing') + (m.mode === 'PRACTICE' ? ' — allowed for Practice Mode only' : ' — Official Pattern Mode requires a verified configuration'));
  add(`Question count (${snap.totalQuestions} in ${m.mode.toLowerCase()} mode)`, ordered.length === snap.totalQuestions ? 'PASS' : 'FAIL', `${ordered.length} found`);
  const bad = snap.sections.filter(s => ordered.filter(q => q.section === s.id).length !== s.count).map(s => s.name);
  add('All sections present with configured counts', bad.length ? 'FAIL' : 'PASS', bad.length ? 'Mismatch: ' + bad.join(', ') : 'OK');
  const optBad = ordered.filter(q => Object.keys(q.content.opts ?? {}).sort().join('') !== snap.optionKeys.join('')).map(num);
  add(`Option count matches configuration (${snap.optionKeys.join('–')})`, optBad.length ? 'FAIL' : 'PASS', optBad.join(', ') || 'OK');
  if (m.exam_type === 'TRE') {
    const lb = ordered.filter(q => snap.sections.some(s => s.id === q.section && s.role === 'LANGUAGE') && q.exam_lang !== m.tre_language).map(num);
    add(`Language section matches TRE exam language (${m.tre_language})`, lb.length ? 'FAIL' : 'PASS', lb.join(', ') || 'OK');
  }
  const bp = await one(c, 'SELECT * FROM blueprints WHERE id=$1', [m.blueprint_id]);
  if (!bp) add('Blueprint attached', 'FAIL', 'No blueprint');
  else {
    const comp = blueprintCompliance(cfg.sections, bp, m.mode);
    add(`Blueprint totals match sections (${bp.id})`, comp.ok ? 'PASS' : 'FAIL', comp.rows.filter(r => !r.ok).map(r => `${r.name} ${r.sum}/${r.target}`).join(', ') || 'OK');
    const used = new Map<number, number>(); const off: string[] = [];
    ordered.forEach(q => { const r = ruleFor(bp.rules, q); if (!r) off.push(num(q)); else { const k = bp.rules.indexOf(r); used.set(k, (used.get(k) ?? 0) + 1); } });
    const over = (bp.rules as any[]).some((r, i) => (used.get(i) ?? 0) !== r.count);
    add('Every question maps to a blueprint rule & rule counts met', off.length || over ? 'FAIL' : 'PASS', off.length ? 'Off-blueprint: ' + off.join(', ') : over ? 'Per-rule counts differ from blueprint' : 'OK');
    const dist: Record<string, number> = { EASY: 0, MEDIUM: 0, HARD: 0 }; ordered.forEach(q => { dist[q.difficulty] = (dist[q.difficulty] ?? 0) + 1; });
    const dev = ['EASY', 'MEDIUM', 'HARD'].map(k => Math.abs(pct(dist[k], ordered.length || 1) - bp.difficulty[k]));
    add(`Difficulty mix vs blueprint (${bp.difficulty.EASY}/${bp.difficulty.MEDIUM}/${bp.difficulty.HARD})`, Math.max(...dev) <= 20 ? 'PASS' : 'WARN', 'Actual ' + ['EASY', 'MEDIUM', 'HARD'].map(k => pct(dist[k], ordered.length || 1) + '%').join(' / '));
  }
  const qf: string[] = [], qw: string[] = [];
  for (const q of ordered) { const s = summary(await runChecks(c, q)); if (s === 'FAIL') qf.push(num(q)); else if (s === 'WARN') qw.push(num(q)); }
  add('Per-question quality validator (23 checks each)', qf.length ? 'FAIL' : qw.length ? 'WARN' : 'PASS', qf.length ? 'Failed: ' + qf.join(', ') : qw.length ? 'Warnings: ' + qw.join(', ') : 'All passed');
  const fp = new Set<string>(); const dupIn: string[] = []; ordered.forEach(q => { if (fp.has(q.fingerprint)) dupIn.push(num(q)); fp.add(q.fingerprint); });
  add('No duplicate questions inside this mock', dupIn.length ? 'FAIL' : 'PASS', dupIn.join(', ') || 'OK');
  const reuse = m.reuse ?? [];
  add('Reuse vs previous mocks', !reuse.length ? 'PASS' : m.reuse_decision === 'ALLOWED' ? 'WARN' : 'FAIL', !reuse.length ? 'No similar questions in previous mocks' : m.reuse_decision === 'ALLOWED' ? `${reuse.length} similar — reuse allowed by admin` : `${reuse.length} similar to previous mocks — decision pending`);
  const pend = ordered.filter(q => q.status !== 'VALIDATED' && q.status !== 'PUBLISHED').map(num);
  add('All questions reviewed and validated', pend.length ? 'WARN' : 'PASS', pend.length ? 'Not yet reviewed/validated: ' + pend.join(', ') : 'OK');
  return { ok: !checks.some(x => x.status === 'FAIL'), approvedAll: !pend.length && ordered.length > 0, checks, version: VALIDATOR_VERSION };
}

// ------------------------------------------------------------------ question state machine
export const QFLOW: Record<string, string[]> = { DRAFT: ['REVIEW', 'ARCHIVED'], AI_GENERATED: ['REVIEW', 'ARCHIVED'], REVIEW: ['REVIEWED', 'REJECTED'], REVIEWED: ['VALIDATING', 'REVIEW'], VALIDATING: ['VALIDATED', 'VALIDATION_FAILED'], VALIDATION_FAILED: ['REVIEW'], VALIDATED: ['PUBLISHED', 'REVIEW'], PUBLISHED: ['ARCHIVED'], REJECTED: ['REVIEW', 'ARCHIVED'], ARCHIVED: ['REVIEW'] };
const QPERM: Record<string, Action> = { REVIEW: 'question.review', REVIEWED: 'question.review', REJECTED: 'question.review', VALIDATING: 'question.validate', VALIDATED: 'question.validate', VALIDATION_FAILED: 'question.validate', PUBLISHED: 'question.publish', ARCHIVED: 'question.edit' };

async function move(c: Queryable, deps: Deps, q: any, to: string, actor: Actor, action: string, reason?: string) {
  if (!(QFLOW[q.status] ?? []).includes(to)) throw conflict('INVALID_TRANSITION', `A ${q.status} question cannot move to ${to}.`);
  const perm = QPERM[to]; if (perm && !can(actor.role ?? '', perm)) throw forbidden(`Your role (${actor.role}) cannot move a question to ${to}.`);
  await exec(c, 'UPDATE questions SET status=$2, updated_at=$3 WHERE id=$1', [q.id, to, deps.clock.now()]);
  await audit(c, actor, action, 'Question', q.id, q.status, to, reason ?? null);
  q.status = to;
}
const lockQ = async (c: Queryable, id: string) => { const q = await one(c, 'SELECT * FROM questions WHERE id=$1 FOR UPDATE', [id]); if (!q) throw notFound('Question'); return q; };

export const questionOps = {
  async open(deps: Deps, c: Queryable, id: string, actor: Actor) {
    const q = await lockQ(c, id);
    if (q.status === 'AI_GENERATED' || q.status === 'DRAFT') await move(c, deps, q, 'REVIEW', actor, 'REVIEW_STARTED', 'Reviewer opened question');
    return q;
  },
  async approve(deps: Deps, c: Queryable, id: string, actor: Actor, note?: string) {
    const q = await this.open(deps, c, id, actor);
    if (q.content_needed) throw conflict('CONTENT_NEEDED', 'This question has not been written yet. Edit it first.');
    await move(c, deps, q, 'REVIEWED', actor, 'REVIEWER_APPROVED', note ?? 'Reviewed');
    await exec(c, 'UPDATE questions SET review=$2 WHERE id=$1', [id, { by: actor.name, byId: actor.id, role: actor.role, at: deps.clock.now(), note: note ?? null }]);
    return q;
  },
  async reject(deps: Deps, c: Queryable, id: string, actor: Actor, reason: string) {
    let q = await lockQ(c, id);
    if (q.status === 'AI_GENERATED' || q.status === 'DRAFT') q = await this.open(deps, c, id, actor);
    if (['VALIDATION_FAILED', 'REVIEWED', 'VALIDATED'].includes(q.status)) await move(c, deps, q, 'REVIEW', actor, 'RETURNED_TO_REVIEW', 'Rejecting');
    await move(c, deps, q, 'REJECTED', actor, 'QUESTION_REJECTED', reason);
    await exec(c, 'UPDATE questions SET rejection=$2, in_pool=false WHERE id=$1', [id, { by: actor.name, at: deps.clock.now(), reason }]);
  },
  async validate(deps: Deps, c: Queryable, id: string, actor: Actor) {
    const q = await lockQ(c, id);
    if (q.status !== 'REVIEWED') throw conflict('INVALID_TRANSITION', q.status === 'VALIDATED' ? 'Already validated.' : 'Only reviewed questions can be validated.');
    await move(c, deps, q, 'VALIDATING', actor, 'VALIDATION_STARTED');
    const checks = await runChecks(c, q); const res = summary(checks);
    const v = { result: res === 'FAIL' ? 'FAILED' : 'PASSED', runAt: deps.clock.now(), version: VALIDATOR_VERSION, by: actor.name, checks, groups: groups(checks) };
    await exec(c, 'UPDATE questions SET validation=$2 WHERE id=$1', [id, v]);
    await move(c, deps, q, res === 'FAIL' ? 'VALIDATION_FAILED' : 'VALIDATED', actor, res === 'FAIL' ? 'VALIDATION_FAILED' : 'VALIDATION_PASSED', checks.filter(x => x.status === 'FAIL').map(x => `#${x.n} ${x.label}`).join('; ') || 'All checks passed');
    return v;
  },
  /** Direct publish of a single validated question into the reviewed bank (mock publish does this for its questions). */
  async publish(deps: Deps, c: Queryable, id: string, actor: Actor) {
    const q = await lockQ(c, id);
    if (q.status !== 'VALIDATED') throw conflict('INVALID_TRANSITION', 'Only a validated question can be published (Reviewed ✓ · Validated ✓).');
    await move(c, deps, q, 'PUBLISHED', actor, 'QUESTION_PUBLISHED', `Reviewed ✓ · Validated ✓ (${q.validation?.version ?? ''})`);
    await exec(c, 'UPDATE questions SET in_pool=true, published_by=$2, published_at=$3 WHERE id=$1', [id, actor.name, deps.clock.now()]);
    if (q.revision_of) {
      await exec(c, "UPDATE questions SET status='ARCHIVED', in_pool=false, replaced_by=$2, updated_at=$3 WHERE id=$1 AND status='PUBLISHED'", [q.revision_of, id, deps.clock.now()]);
      await audit(c, actor, 'QUESTION_REPLACED_BY_REVISION', 'Question', q.revision_of, 'PUBLISHED', 'ARCHIVED', `Replaced by ${id}. Published mocks keep their frozen copy.`);
    }
  },
  /** Published questions are never edited: a new revision is created and goes through review again. */
  async revise(deps: Deps, c: Queryable, id: string, actor: Actor) {
    const q = await lockQ(c, id);
    if (q.status !== 'PUBLISHED') throw conflict('INVALID_TRANSITION', 'Only published questions are revised. Edit unpublished questions directly.');
    const open = await one(c, "SELECT id FROM questions WHERE revision_of=$1 AND status NOT IN ('ARCHIVED','REJECTED','PUBLISHED')", [id]);
    if (open) return { id: open.id, existing: true };
    const v = (await one<{ v: number }>(c, 'SELECT max(version)::int v FROM questions WHERE origin_id=$1', [q.origin_id]))!.v + 1;
    let nid = `${q.origin_id}_V${v}`; let k = v; while (await one(c, 'SELECT 1 FROM questions WHERE id=$1', [nid])) nid = `${q.origin_id}_V${++k}`;
    await exec(c, `INSERT INTO questions (id, origin_id, version, status, exam_type, level, paper, section, subject_id, exam_lang, topic, subtopic, difficulty, question_type, correct_option, option_count, content,
        source_type, source_exam, source_year, source_document, source_url, current_affairs, content_needed, in_pool, fingerprint, semantic_hash, revision_of, created_at, updated_at)
      SELECT $2, origin_id, $3, 'REVIEW', exam_type, level, paper, section, subject_id, exam_lang, topic, subtopic, difficulty, question_type, correct_option, option_count, content,
        source_type, source_exam, source_year, source_document, source_url, current_affairs, false, false, fingerprint, semantic_hash, id, $4, $4 FROM questions WHERE id=$1`, [id, nid, v, deps.clock.now()]);
    await audit(c, actor, 'REVISION_CREATED', 'Question', nid, null, 'REVIEW', `Revision of ${id}; ${id} stays live until the revision is published`);
    return { id: nid, existing: false };
  },
  async edit(deps: Deps, c: Queryable, id: string, actor: Actor, patch: { content: QuestionContent; correctOption: string; topic?: string; subtopic?: string; difficulty?: string }, reason: string) {
    const q = await lockQ(c, id);
    if (q.status === 'PUBLISHED') throw conflict('USE_REVISION', 'Published questions cannot be edited. Create a revision instead.');
    if (q.status === 'ARCHIVED') throw conflict('INVALID_TRANSITION', 'Restore the question before editing.');
    const keys = Object.keys(patch.content.opts).sort().join('');
    if (keys.length !== q.option_count) throw conflict('OPTION_COUNT', `This question needs exactly ${q.option_count} options.`);
    if (q.source_type === 'AI_GENERATED') { /* stays AI_GENERATED — editing never turns AI content into a PYQ */ }
    await exec(c, `UPDATE questions SET content=$2, correct_option=$3, topic=COALESCE($4,topic), subtopic=COALESCE($5,subtopic), difficulty=COALESCE($6,difficulty), content_needed=false,
        fingerprint=$7, semantic_hash=$8, version=version+1, status='REVIEW', review=NULL, validation=NULL, updated_at=$9 WHERE id=$1`,
      [id, patch.content, patch.correctOption, patch.topic ?? null, patch.subtopic ?? null, patch.difficulty ?? null, fingerprintOf(patch.content.q.en, patch.content.q.hi), semanticOf(patch.content.q.en, patch.content.q.hi), deps.clock.now()]);
    await audit(c, actor, 'QUESTION_EDITED', 'Question', id, q.status, 'REVIEW', reason);
  },
  async archive(deps: Deps, c: Queryable, id: string, actor: Actor) {
    const q = await lockQ(c, id);
    await move(c, deps, q, 'ARCHIVED', actor, 'QUESTION_ARCHIVED', 'Hidden from future mocks');
    await exec(c, 'UPDATE questions SET in_pool=false WHERE id=$1', [id]);
  },
};

// ------------------------------------------------------------------ approve / publish mocks
export async function approveMockIfReady(deps: Deps, c: Queryable, mockId: string, actor: Actor) {
  const m = await one(c, 'SELECT * FROM mocks WHERE id=$1 FOR UPDATE', [mockId]); if (!m) throw notFound('Mock');
  if (!['REVIEW', 'VALIDATING', 'APPROVED'].includes(m.status)) throw conflict('INVALID_STATE', `Mock is ${m.status}.`);
  const v = await validateMock(c, m);
  const approved = v.ok && v.approvedAll;
  await exec(c, 'UPDATE mocks SET validation=$2, status=$3, approved_by=$4, approved_at=$5 WHERE id=$1',
    [mockId, v, approved ? 'APPROVED' : 'REVIEW', approved ? actor.name : null, approved ? deps.clock.now() : null]);
  if (approved && m.status !== 'APPROVED') await audit(c, actor, 'MOCK_APPROVED', 'Mock', mockId, m.status, 'APPROVED', 'Mock validation passed; all questions reviewed and validated');
  return { approved, validation: v };
}

export async function publishMock(deps: Deps, c: Queryable, mockId: string, actor: Actor) {
  const m = await one(c, 'SELECT * FROM mocks WHERE id=$1 FOR UPDATE', [mockId]); if (!m) throw notFound('Mock');
  if (m.status === 'PUBLISHED' || m.status === 'CLOSED') return { ok: true, duplicate: true, eligible: m.assigned_count };
  if (m.status !== 'APPROVED') throw conflict('INVALID_STATE', `Only an APPROVED mock can be published (current: ${m.status}).`);
  // Lock the questions first: an edit committed after validation could otherwise be frozen unreviewed.
  const qs = await many(c, 'SELECT * FROM questions WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE', [m.question_ids]);
  const v = await validateMock(c, m);
  if (!v.ok || !v.approvedAll) throw conflict('VALIDATION_FAILED', 'The mock no longer passes validation.', { checks: v.checks.filter(x => x.status !== 'PASS') });
  const cfg = await one(c, 'SELECT verification_status FROM exam_configs WHERE id=$1', [m.config_id]);
  if (m.mode === 'OFFICIAL' && cfg.verification_status !== 'OFFICIALLY_VERIFIED') throw conflict('CONFIG_NOT_VERIFIED', 'Official Pattern mocks need an officially verified configuration.');
  const now = deps.clock.now(); const snap: ConfigSnapshot = m.config_snapshot;
  if (qs.some(q => q.status !== 'VALIDATED' && q.status !== 'PUBLISHED')) throw conflict('VALIDATION_FAILED', 'A question changed after approval. Review and validate it again.');
  const byId = new Map(qs.map(q => [q.id, q]));
  let pos = 0;
  for (const id of m.question_ids as string[]) {
    const q = byId.get(id)!; pos++;
    if (q.status === 'VALIDATED') {
      await exec(c, "UPDATE questions SET status='PUBLISHED', in_pool=true, published_by=$2, published_at=$3, updated_at=$3 WHERE id=$1", [id, actor.name, now]);
      await audit(c, actor, 'QUESTION_PUBLISHED', 'Question', id, 'VALIDATED', 'PUBLISHED', `via mock ${mockId}`);
    }
    // Frozen copy: every attempt of this mock reads exactly this, whatever happens to the question later.
    const frozen = { section: q.section, topic: q.topic, subtopic: q.subtopic, difficulty: q.difficulty, correct: q.correct_option, content: filterContent(q.content, snap.optionKeys),
      sourceType: q.source_type, sourceExam: q.source_exam, sourceYear: q.source_year, originId: q.origin_id, fingerprint: q.fingerprint, semanticHash: q.semantic_hash };
    await exec(c, 'INSERT INTO mock_questions (mock_id, position, question_id, version, frozen) VALUES ($1,$2,$3,$4,$5)', [mockId, pos, id, q.version, frozen]);
  }
  const elig = await many(c, `SELECT DISTINCT ON (e.user_id) e.user_id, e.id FROM entitlements e JOIN users u ON u.id = e.user_id
                              WHERE e.cohort_base=$1 AND e.status='ACTIVE' AND e.expires_at > $2 AND u.status='ACTIVE'`, [m.cohort_base, now]);
  await exec(c, "UPDATE mocks SET status='PUBLISHED', validation=$2, published_by=$3, published_at=$4, assigned_count=$5 WHERE id=$1", [mockId, v, actor.name, now, elig.length]);
  for (const e of elig) await notify(c, { audience: 'student', userId: e.user_id, type: 'todayMock', title: "Today's mock is ready", message: `${snap.totalQuestions} questions · ${snap.durationMinutes} min`, mockId }, now);
  await audit(c, actor, 'MOCK_PUBLISHED', 'Mock', mockId, 'APPROVED', 'PUBLISHED (snapshot frozen)', `${elig.length} eligible students`);
  return { ok: true, duplicate: false, eligible: elig.length };
}

/** Replace one question in a mock under review: reviewed bank first, otherwise an empty draft a person must write. Never placeholder text. */
export async function replaceQuestion(deps: Deps, c: Queryable, mockId: string, qid: string, actor: Actor) {
  const m = await one(c, 'SELECT * FROM mocks WHERE id=$1 FOR UPDATE', [mockId]); if (!m) throw notFound('Mock');
  if (!['REVIEW', 'VALIDATING'].includes(m.status)) throw conflict('INVALID_STATE', 'Questions can only be replaced while the mock is in review.');
  const idx = (m.question_ids as string[]).indexOf(qid); if (idx < 0) throw notFound('Question in this mock');
  const old = await one(c, 'SELECT * FROM questions WHERE id=$1', [qid]);
  const snap: ConfigSnapshot = m.config_snapshot; const sec = snap.sections.find(s => s.id === old.section)!;
  const base = qid.replace(/_R\d+$/, ''); let k = 1; while (await one(c, 'SELECT 1 FROM questions WHERE id=$1', [`${base}_R${k}`])) k++;
  const nid = `${base}_R${k}`;
  const inUse = (await many(c, 'SELECT origin_id FROM questions WHERE id = ANY($1::text[])', [m.question_ids])).map(r => r.origin_id);
  const src = await pickFromPool(c, m, sec, { topic: old.topic, subtopic: '*', difficulty: old.difficulty }, inUse);
  const now = deps.clock.now();
  if (src) await insertQuestion(c, qRow(m, sec, nid, src.origin_id, { n: idx + 1 }, filterContent(src.content, snap.optionKeys), src.correct_option, src, m.job_id, src.topic, src.subtopic, src.difficulty), now);
  else {
    const E = { hi: '', en: '', hl: '' }; const opts: any = {}, why: any = {}; snap.optionKeys.forEach(o => { opts[o] = E; why[o] = E; });
    await insertQuestion(c, { ...qRow(m, sec, nid, nid, { n: idx + 1 }, { q: E, opts, why, exp: E, concept: E, tip: E }, snap.optionKeys[0], { source_type: 'ADMIN_CREATED' }, m.job_id, old.topic, old.subtopic, old.difficulty), status: 'DRAFT', content_needed: true, fingerprint: 'empty-' + nid, semantic_hash: 'empty-' + nid }, now);
  }
  const ids = [...m.question_ids]; ids[idx] = nid;
  await exec(c, "UPDATE mocks SET question_ids=$2, status='REVIEW' WHERE id=$1", [mockId, ids]);
  await exec(c, "UPDATE questions SET status='ARCHIVED', replaced_by=$2, updated_at=$3 WHERE id=$1 AND status <> 'PUBLISHED'", [qid, nid, now]);
  await audit(c, actor, 'QUESTION_REPLACED', 'Mock', mockId, qid, nid, src ? 'From reviewed bank' : 'Empty draft — needs writing');
  return { id: nid, fromBank: !!src };
}

/** Daily planner: tomorrow's mock + generation job for every cohort with paying students. Humans still review before publish. */
export async function planDailyMocks(deps: Deps, date: string) {
  const cohorts = await many(deps.db, `SELECT DISTINCT ON (cohort_base) cohort_base, exam_type, level, paper, subject_id, other_subject_name, tre_language, mode
                                       FROM entitlements WHERE status='ACTIVE' AND expires_at > $1 ORDER BY cohort_base, activated_at DESC`, [new Date(date + 'T00:00:00Z')]);
  const out = { cohorts: cohorts.length, created: 0, queued: 0, errors: [] as string[] };
  for (const e of cohorts) {
    const sel: Selection = { examType: e.exam_type, level: e.level, paper: e.paper, subjectId: e.subject_id, otherSubjectName: e.other_subject_name, treLanguage: e.tre_language };
    try {
      const jobId = await tx(deps.db, async c => {
        const r = await createMock(deps, c, sel, date, e.mode, SYSTEM);
        if (r.created) out.created++;
        if (r.mock.status !== 'DRAFT') return null;
        const j = await createGenerationJob(deps, c, r.mock.id, SYSTEM);
        return j.created ? j.job.id : null;
      });
      if (jobId) { await deps.jobs.enqueueGeneration(jobId); out.queued++; }
    } catch (err: any) {
      out.errors.push(`${e.cohort_base}: ${err?.message ?? err}`);
      await notify(deps.db, { audience: 'admin', type: 'jobFailed', title: 'Daily mock could not be prepared', message: `${e.cohort_base} · ${date} · ${err?.message ?? err}` }, deps.clock.now());
    }
  }
  return out;
}
