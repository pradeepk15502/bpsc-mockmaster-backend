import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { audit } from '../lib/audit.js';
import { exec, many, one, tx, type Queryable } from '../lib/db.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { examDate } from '../lib/time.js';
import { LIMITS } from '../lib/ratelimit.js';
import { actorOf, noStore, parse, studentOf } from '../http.js';
import { adminGuard, studentGuard } from './sessions.js';
import { cohortBase, normSubject, OPTS, type ConfigSection, type Selection } from '../domain/types.js';

export const LEVELS = ['1-5', '6-8', '9-10', '11-12'];
export const PAPERS = ['P1', 'P2'];

export const SelectionSchema = z.object({
  examType: z.enum(['TRE', 'STET']),
  level: z.enum(['1-5', '6-8', '9-10', '11-12']).nullish(),
  paper: z.enum(['P1', 'P2']).nullish(),
  subjectId: z.string().min(1).max(40),
  otherSubjectName: z.string().trim().min(2).max(80).nullish(),
  treLanguage: z.string().min(2).max(10).nullish(),
}).superRefine((s, ctx) => {
  if (s.examType === 'TRE' && (!s.level || !s.treLanguage)) ctx.addIssue({ code: 'custom', message: 'TRE needs a class level and an exam language' });
  if (s.examType === 'STET' && !s.paper) ctx.addIssue({ code: 'custom', message: 'STET needs a paper' });
  if (s.subjectId === 'other' && !s.otherSubjectName) ctx.addIssue({ code: 'custom', message: 'Enter the subject name' });
}).transform(s => ({
  examType: s.examType, level: s.examType === 'TRE' ? s.level! : null, paper: s.examType === 'STET' ? s.paper! : null,
  subjectId: s.subjectId, otherSubjectName: s.subjectId === 'other' ? s.otherSubjectName!.replace(/\s+/g, ' ') : null,
  treLanguage: s.examType === 'TRE' ? s.treLanguage! : null,
}) as Selection);

export const verificationLabel = (s: string) => s === 'OFFICIALLY_VERIFIED' ? 'Officially verified' : s === 'PRACTICE_CONFIGURATION' ? 'Practice configuration — not an official BPSC pattern' : 'Pending official verification';

export async function activeConfig(c: Queryable, examType: string, key: string) {
  return one(c, `SELECT * FROM exam_configs WHERE exam_type=$1 AND ${examType === 'TRE' ? 'level' : 'paper'}=$2 AND status='ACTIVE' ORDER BY version DESC LIMIT 1`, [examType, key]);
}
export const configUsable = (cfg: any) => !!(cfg && cfg.status === 'ACTIVE' && Array.isArray(cfg.sections) && cfg.sections.length > 0 && (cfg.duration_minutes || cfg.practice?.durationMinutes));

/** Syllabus subject for a selection: listed subject, or the admin-linked syllabus for an "Other" subject name. */
export async function syllabusSubjectFor(c: Queryable, sel: Selection): Promise<string | null> {
  if (sel.subjectId !== 'other') return sel.subjectId;
  const r = await one(c, 'SELECT subject_id FROM other_subject_syllabus WHERE other_key=$1', [normSubject(sel.otherSubjectName)]);
  return r?.subject_id ?? null;
}
/** The subject id that questions of a section are stored under. */
export function sectionSubject(role: string, syllabusSubjectId: string, treLanguage: string | null) {
  return role === 'LANGUAGE' ? 'lang-' + treLanguage : role === 'GS' ? 'gs' : role === 'TEACHING' ? 'teaching' : syllabusSubjectId;
}

export async function getSettings(c: Queryable, key: string) { return (await one(c, 'SELECT value FROM settings WHERE key=$1', [key]))?.value; }

// ---------------- pricing (server-side only; the client never sends a price) ----------------
export async function quote(c: Queryable, plan: string, scope: { level?: string | null; paper?: string | null; subjectId?: string | null }, today: string) {
  const rows = await many(c, `SELECT * FROM pricing_plans WHERE active AND plan=$1 AND (start_date IS NULL OR start_date <= $2) AND (end_date IS NULL OR end_date >= $2)
      AND (level IS NULL OR level IS NOT DISTINCT FROM $3) AND (paper IS NULL OR paper IS NOT DISTINCT FROM $4) AND (subject_id IS NULL OR subject_id IS NOT DISTINCT FROM $5)`,
    [plan, today, scope.level ?? null, scope.paper ?? null, scope.subjectId ?? null]);
  if (!rows.length) return null;
  const spec = (p: any) => (p.level ? 1 : 0) + (p.paper ? 1 : 0) + (p.subject_id ? 2 : 0);
  const p = rows.sort((a, b) => spec(b) - spec(a) || String(a.id).localeCompare(String(b.id)))[0];
  const discount = Math.round(p.base_price_paise * Number(p.discount_pct) / 100); const net = p.base_price_paise - discount;
  const tax = Math.round(net * Number(p.tax_pct) / 100);
  return { planId: p.id as string, plan: p.plan as string, basePaise: p.base_price_paise as number, discountPaise: discount, discountPct: Number(p.discount_pct), netPaise: net, taxPaise: tax, taxPct: Number(p.tax_pct), totalPaise: net + tax, durationDays: p.duration_days as number };
}

// ---------------- availability gate ----------------
export type Availability = { state: 'AVAILABLE' | 'COMING_SOON'; cohortBase: string; mode: 'PRACTICE' | 'OFFICIAL'; config: any | null; reasons: string[]; coverage?: any[] };

/**
 * A cohort can be sold only when ALL hold: an admin enabled the sale, the configuration is usable and its
 * verification allows the sale mode, a compliant blueprint exists, enough reviewed questions exist for
 * `minReadyMocks` mocks, the subject/language are active, and a price is active.
 * Otherwise the student sees "Coming soon / Join waitlist" and no payment can be created.
 */
export async function availability(c: Queryable, sel: Selection, today: string, opts: { assumeSaleEnabled?: boolean; modeOverride?: 'PRACTICE' | 'OFFICIAL'; plan?: string } = {}): Promise<Availability> {
  const base = cohortBase(sel); const reasons: string[] = [];
  const sale = await one(c, 'SELECT * FROM sale_controls WHERE cohort_base=$1', [base]);
  const mode: 'PRACTICE' | 'OFFICIAL' = opts.modeOverride ?? sale?.mode ?? 'PRACTICE';
  if (!opts.assumeSaleEnabled && !sale?.enabled) reasons.push('SALE_NOT_ENABLED');
  const cfg = await activeConfig(c, sel.examType, (sel.examType === 'TRE' ? sel.level : sel.paper)!);
  if (!configUsable(cfg)) reasons.push('NO_ACTIVE_CONFIG');
  else if (mode === 'OFFICIAL' && cfg.verification_status !== 'OFFICIALLY_VERIFIED') reasons.push('OFFICIAL_MODE_NEEDS_VERIFIED_CONFIG');
  else if (mode === 'PRACTICE' && cfg.verification_status === 'PENDING_VERIFICATION') reasons.push('CONFIG_PENDING_VERIFICATION');
  if (sel.examType === 'TRE') {
    const lang = await one(c, 'SELECT * FROM tre_languages WHERE code=$1', [sel.treLanguage]);
    if (!lang?.active || !lang.levels.includes(sel.level)) reasons.push('LANGUAGE_INACTIVE');
  }
  const syl = await syllabusSubjectFor(c, sel);
  if (!syl) reasons.push('OTHER_SUBJECT_NOT_MAPPED');
  else {
    const subj = await one(c, 'SELECT * FROM subjects WHERE id=$1', [syl]);
    const offered = subj && subj.active && (sel.examType === 'TRE' ? subj.tre_levels.includes(sel.level) : subj.stet_papers.includes(sel.paper));
    if (!offered) reasons.push('SUBJECT_INACTIVE');
  }
  let coverage: any[] | undefined;
  if (configUsable(cfg) && syl) {
    const bp = await one(c, 'SELECT * FROM blueprints WHERE config_id=$1 AND subject_id=$2 AND mode=$3', [cfg.id, syl, mode]);
    if (!bp) reasons.push('NO_BLUEPRINT');
    else {
      const comp = blueprintCompliance(cfg.sections, bp, mode);
      if (!comp.ok) reasons.push('BLUEPRINT_INCOMPLETE');
      const minMocks = (await getSettings(c, 'availability'))?.minReadyMocks ?? 7;
      coverage = [];
      for (const r of bp.rules as any[]) {
        const sec = (cfg.sections as ConfigSection[]).find(s => s.id === r.sectionId); if (!sec) continue;
        const subjectId = sectionSubject(sec.role, syl, sel.treLanguage ?? null);
        const n = (await one<{ n: number }>(c, `SELECT count(*)::int n FROM questions WHERE in_pool AND status='PUBLISHED' AND content_needed = false AND section=$1 AND subject_id=$2
            AND ($3='*' OR topic=$3) AND ($4='*' OR subtopic=$4) AND option_count=$5 AND ($6::text IS NULL OR exam_lang=$6)`,
          [r.sectionId, subjectId, r.topic, r.subtopic, cfg.option_count, sec.role === 'LANGUAGE' ? sel.treLanguage : null]))!.n;
        coverage.push({ sectionId: r.sectionId, topic: r.topic, subtopic: r.subtopic, needed: r.count * minMocks, available: n });
      }
      if (coverage.some(x => x.available < x.needed)) reasons.push('INSUFFICIENT_REVIEWED_QUESTIONS');
    }
  }
  const pr = await quote(c, opts.plan ?? sel.examType, { level: sel.level, paper: sel.paper, subjectId: sel.subjectId === 'other' ? null : sel.subjectId }, today);
  if (!pr) reasons.push('NO_ACTIVE_PRICE');
  return { state: reasons.length ? 'COMING_SOON' : 'AVAILABLE', cohortBase: base, mode, config: cfg, reasons, coverage };
}

export function blueprintCompliance(sections: ConfigSection[], bp: any, mode: string) {
  const rows = sections.map(s => { const sum = (bp.rules as any[]).filter(r => r.sectionId === s.id).reduce((a, r) => a + (r.count || 0), 0); const target = mode === 'PRACTICE' ? s.practiceCount : s.questionCount; return { id: s.id, name: s.name, sum, target, ok: sum === target }; });
  const dsum = (bp.difficulty.EASY ?? 0) + (bp.difficulty.MEDIUM ?? 0) + (bp.difficulty.HARD ?? 0);
  return { rows, diffOk: dsum === 100, dsum, ok: rows.every(r => r.ok) && dsum === 100 };
}

const STUDENT_MESSAGE = {
  AVAILABLE: 'Available now.',
  COMING_SOON: 'Coming soon. We only sell a mock series once its questions are reviewed and ready. Join the waitlist and we will tell you when it opens.',
};

// ---------------- config input ----------------
const SectionIn = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/), name: z.string().min(1).max(80), kind: z.enum(['QUALIFYING', 'MERIT', 'NORMAL']), role: z.enum(['LANGUAGE', 'GS', 'SUBJECT', 'TEACHING']),
  order: z.number().int().min(1), questionCount: z.number().int().min(1).max(500), marksPerQuestion: z.number().positive().max(10), negativeMarks: z.number().min(0).max(10),
  qualifyingPercent: z.number().min(0).max(100).nullable(), practiceCount: z.number().int().min(1).max(200), practiceQualifyingPercent: z.number().min(0).max(100).nullable(),
});
const ConfigIn = z.object({
  examType: z.enum(['TRE', 'STET']), level: z.enum(['1-5', '6-8', '9-10', '11-12']).nullish(), paper: z.enum(['P1', 'P2']).nullish(),
  optionCount: z.union([z.literal(4), z.literal(5)]), durationMinutes: z.number().int().min(5).max(600).nullable(), negativeMarking: z.boolean(),
  sections: z.array(SectionIn).min(1).max(10), practice: z.object({ durationMinutes: z.number().int().min(5).max(180), negativeMarkingEnabled: z.boolean(), negativeMarks: z.number().min(0).max(10), passPercent: z.number().min(0).max(100).nullable().optional() }),
  passPercent: z.number().min(0).max(100).nullable().optional(), notes: z.string().max(2000).optional(),
}).refine(c => (c.examType === 'TRE' ? !!c.level && !c.paper : !!c.paper && !c.level), 'TRE needs level, STET needs paper');
const SourceIn = z.object({ sourceDocument: z.string().trim().min(3).max(300), sourceUrl: z.url().refine(u => u.startsWith('https://'), 'Must be an https URL'), note: z.string().max(2000).optional() });
const SaleIn = z.object({ selection: SelectionSchema, mode: z.enum(['PRACTICE', 'OFFICIAL']), enabled: z.boolean(), note: z.string().max(500).optional() });

export function catalogRoutes(app: FastifyInstance, deps: Deps) {
  const today = () => examDate(deps.clock.now(), deps.cfg.TZ_EXAM);

  // ---------------- public catalog ----------------
  app.get('/api/catalog', async (_req, reply) => {
    reply.header('cache-control', 'public, max-age=60');
    const cfgs = await many(deps.db, "SELECT DISTINCT ON (exam_type, level, paper) * FROM exam_configs WHERE status='ACTIVE' ORDER BY exam_type, level, paper, version DESC");
    const subjects = await many(deps.db, "SELECT id, name, display_name, stet_papers, tre_levels FROM subjects WHERE active AND origin <> 'OTHER_REQUEST' ORDER BY name");
    const langs = await many(deps.db, 'SELECT code, name, native, levels FROM tre_languages WHERE active ORDER BY sort');
    const exam = (examType: string, key: string) => {
      const c = cfgs.find(x => x.exam_type === examType && (examType === 'TRE' ? x.level : x.paper) === key);
      return {
        key, configured: configUsable(c),
        verification: c ? c.verification_status : 'PENDING_VERIFICATION', verificationLabel: verificationLabel(c?.verification_status ?? 'PENDING_VERIFICATION'),
        // The official pattern is only described as official when it was verified against a source document.
        officialPattern: c && c.verification_status === 'OFFICIALLY_VERIFIED' ? { sections: c.sections.map((s: any) => ({ name: s.name, questions: s.questionCount })), durationMinutes: c.duration_minutes, options: c.option_count, source: c.source_document } : null,
        subjects: subjects.filter(s => (examType === 'TRE' ? s.tre_levels : s.stet_papers).includes(key)).map(s => ({ id: s.id, name: s.display_name || s.name })),
      };
    };
    return { tre: LEVELS.map(l => ({ ...exam('TRE', l), languages: langs.filter(x => x.levels.includes(l)).map(x => ({ code: x.code, name: x.name, native: x.native })) })), stet: PAPERS.map(p => exam('STET', p)) };
  });

  app.post('/api/catalog/availability', async (req, reply) => {
    noStore(reply);
    await deps.limiter.hit('public', req.ip, LIMITS.publicPerIp);
    const sel = parse(SelectionSchema, (req.body as any)?.selection ?? req.body);
    const a = await availability(deps.db, sel, today());
    const price = a.state === 'AVAILABLE' ? await quote(deps.db, sel.examType, { level: sel.level, paper: sel.paper, subjectId: sel.subjectId === 'other' ? null : sel.subjectId }, today()) : null;
    return {
      state: a.state, canPurchase: a.state === 'AVAILABLE', canJoinWaitlist: a.state !== 'AVAILABLE', message: STUDENT_MESSAGE[a.state],
      mode: a.mode, modeLabel: a.mode === 'OFFICIAL' ? 'Official pattern mock (verified configuration)' : 'Practice mock — not an official BPSC paper',
      verificationLabel: a.config ? verificationLabel(a.config.verification_status) : verificationLabel('PENDING_VERIFICATION'),
      price: price ? { totalPaise: price.totalPaise, basePaise: price.basePaise, discountPaise: price.discountPaise, taxPaise: price.taxPaise, durationDays: price.durationDays } : null,
    };
  });

  app.post('/api/waitlist', { preHandler: studentGuard(deps) }, async req => {
    const sel = parse(SelectionSchema, (req.body as any)?.selection);
    const base = cohortBase(sel);
    await exec(deps.db, `INSERT INTO waitlist (user_id, cohort_base, selection, other_subject_name) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, cohort_base) DO NOTHING`,
      [studentOf(req).userId, base, sel, sel.otherSubjectName]);
    return { joined: true };
  });

  // ---------------- admin: configuration verification workflow ----------------
  app.get('/api/admin/configs', { preHandler: adminGuard(deps, 'config.view') }, async () => ({ configs: await many(deps.db, 'SELECT * FROM exam_configs ORDER BY exam_type, level, paper, version DESC') }));

  app.post('/api/admin/configs', { preHandler: adminGuard(deps, 'config.edit') }, async req => {
    const b = parse(ConfigIn, req.body); const key = (b.examType === 'TRE' ? b.level : b.paper)!;
    const ids = new Set(b.sections.map(s => s.id)); if (ids.size !== b.sections.length) throw badRequest('DUPLICATE_SECTION', 'Section ids must be unique.');
    return tx(deps.db, async c => {
      const v = ((await one<{ v: number }>(c, `SELECT COALESCE(max(version),0)::int v FROM exam_configs WHERE exam_type=$1 AND ${b.examType === 'TRE' ? 'level' : 'paper'}=$2`, [b.examType, key]))!.v) + 1;
      const id = `${b.examType}_${key.replace('-', '')}_V${v}`;
      const row = await one(c, `INSERT INTO exam_configs (id, exam_type, level, paper, version, status, option_count, duration_minutes, negative_marking, sections, practice, pass_percent, notes)
        VALUES ($1,$2,$3,$4,$5,'DRAFT',$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [id, b.examType, b.level ?? null, b.paper ?? null, v, b.optionCount, b.durationMinutes, b.negativeMarking, JSON.stringify(b.sections), JSON.stringify(b.practice), b.passPercent ?? null, b.notes ?? null]);
      await audit(c, actorOf(req), 'CONFIG_CREATED', 'ExamConfig', id, null, 'DRAFT · PENDING_VERIFICATION');
      return { config: row };
    });
  });

  app.post('/api/admin/configs/:id/activate', { preHandler: adminGuard(deps, 'config.edit') }, async req => {
    const id = (req.params as any).id;
    return tx(deps.db, async c => {
      const cfg = await one(c, 'SELECT * FROM exam_configs WHERE id=$1 FOR UPDATE', [id]); if (!cfg) throw notFound('Configuration');
      if (cfg.status !== 'DRAFT') throw conflict('INVALID_STATE', `Only a DRAFT configuration can be activated (current: ${cfg.status}).`);
      await exec(c, `UPDATE exam_configs SET status='RETIRED' WHERE exam_type=$1 AND level IS NOT DISTINCT FROM $2 AND paper IS NOT DISTINCT FROM $3 AND status='ACTIVE'`, [cfg.exam_type, cfg.level, cfg.paper]);
      await exec(c, "UPDATE exam_configs SET status='ACTIVE' WHERE id=$1", [id]);
      await audit(c, actorOf(req), 'CONFIG_ACTIVATED', 'ExamConfig', id, 'DRAFT', 'ACTIVE', 'Existing mocks keep their frozen configuration snapshot');
      return { ok: true };
    });
  });

  app.post('/api/admin/configs/:id/submit-verification', { preHandler: adminGuard(deps, 'config.submit') }, async req => {
    const id = (req.params as any).id; const b = parse(SourceIn, req.body);
    return tx(deps.db, async c => {
      const cfg = await one(c, 'SELECT * FROM exam_configs WHERE id=$1 FOR UPDATE', [id]); if (!cfg) throw notFound('Configuration');
      if (cfg.verification_status === 'OFFICIALLY_VERIFIED') throw conflict('ALREADY_VERIFIED', 'This configuration is already verified. Create a new version to change it.');
      await exec(c, 'UPDATE exam_configs SET source_document=$2, source_url=$3, submitted_by=$4, submitted_at=$5, notes=COALESCE($6, notes) WHERE id=$1',
        [id, b.sourceDocument, b.sourceUrl, req.admin!.adminId, deps.clock.now(), b.note ?? null]);
      await audit(c, actorOf(req), 'CONFIG_SUBMITTED_FOR_VERIFICATION', 'ExamConfig', id, cfg.verification_status, 'PENDING_VERIFICATION', `${b.sourceDocument} · ${b.sourceUrl}`);
      return { ok: true };
    });
  });

  // Four-eyes: the SUPER_ADMIN who verifies must not be the person who entered / submitted the source.
  app.post('/api/admin/configs/:id/verify', { preHandler: adminGuard(deps, 'config.verify') }, async req => {
    const id = (req.params as any).id; const b = parse(SourceIn, req.body);
    return tx(deps.db, async c => {
      const cfg = await one(c, 'SELECT * FROM exam_configs WHERE id=$1 FOR UPDATE', [id]); if (!cfg) throw notFound('Configuration');
      if (!cfg.submitted_by) throw conflict('NOT_SUBMITTED', 'Submit the official source document for verification first.');
      if (cfg.submitted_by === req.admin!.adminId) throw conflict('SAME_PERSON', 'A different admin must verify the configuration against the official document.');
      if (cfg.source_document !== b.sourceDocument || cfg.source_url !== b.sourceUrl) throw conflict('SOURCE_MISMATCH', 'The source you checked does not match the submitted source document / URL.');
      if (!configUsable({ ...cfg, status: 'ACTIVE' })) throw conflict('INCOMPLETE', 'The configuration has no sections or duration.');
      await exec(c, "UPDATE exam_configs SET verification_status='OFFICIALLY_VERIFIED', verified_by=$2, verified_at=$3 WHERE id=$1", [id, req.admin!.name + ' (' + req.admin!.adminId + ')', deps.clock.now()]);
      await audit(c, actorOf(req), 'CONFIG_VERIFIED', 'ExamConfig', id, cfg.verification_status, 'OFFICIALLY_VERIFIED', b.note ?? `${b.sourceDocument}`);
      return { ok: true };
    });
  });

  app.post('/api/admin/configs/:id/mark-practice', { preHandler: adminGuard(deps, 'config.verify') }, async req => {
    const id = (req.params as any).id; const b = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    return tx(deps.db, async c => {
      const cfg = await one(c, 'SELECT * FROM exam_configs WHERE id=$1 FOR UPDATE', [id]); if (!cfg) throw notFound('Configuration');
      if (cfg.verification_status === 'OFFICIALLY_VERIFIED') throw conflict('ALREADY_VERIFIED', 'Verified configurations cannot be downgraded. Create a new version.');
      await exec(c, "UPDATE exam_configs SET verification_status='PRACTICE_CONFIGURATION' WHERE id=$1", [id]);
      await audit(c, actorOf(req), 'CONFIG_MARKED_PRACTICE', 'ExamConfig', id, cfg.verification_status, 'PRACTICE_CONFIGURATION', b.reason);
      return { ok: true };
    });
  });

  // ---------------- admin: sale controls (launch scope) ----------------
  app.post('/api/admin/availability', { preHandler: adminGuard(deps, 'config.view') }, async req => {
    const b = parse(z.object({ selection: SelectionSchema, mode: z.enum(['PRACTICE', 'OFFICIAL']).optional() }), req.body);
    const a = await availability(deps.db, b.selection, today(), { modeOverride: b.mode });
    return { state: a.state, cohortBase: a.cohortBase, mode: a.mode, reasons: a.reasons, coverage: a.coverage, configId: a.config?.id ?? null };
  });
  app.get('/api/admin/sales', { preHandler: adminGuard(deps, 'config.view') }, async () => ({
    sales: await many(deps.db, `SELECT s.*, (SELECT count(*)::int FROM waitlist w WHERE w.cohort_base = s.cohort_base) AS waitlist FROM sale_controls s ORDER BY cohort_base`),
    waitlistDemand: await many(deps.db, 'SELECT cohort_base, count(*)::int AS n FROM waitlist GROUP BY cohort_base ORDER BY n DESC LIMIT 100'),
  }));
  app.put('/api/admin/sales', { preHandler: adminGuard(deps, 'sales.edit') }, async req => {
    const b = parse(SaleIn, req.body); const base = cohortBase(b.selection);
    return tx(deps.db, async c => {
      if (b.enabled) {
        const a = await availability(c, b.selection, today(), { assumeSaleEnabled: true, modeOverride: b.mode });
        if (a.state !== 'AVAILABLE') throw conflict('NOT_SERVABLE', 'This cohort cannot be put on sale yet.', { reasons: a.reasons, coverage: a.coverage });
      }
      const prev = await one(c, 'SELECT * FROM sale_controls WHERE cohort_base=$1', [base]);
      await exec(c, `INSERT INTO sale_controls (cohort_base, mode, enabled, updated_by, updated_at, note) VALUES ($1,$2,$3,$4,$5,$6)
                     ON CONFLICT (cohort_base) DO UPDATE SET mode=$2, enabled=$3, updated_by=$4, updated_at=$5, note=$6`,
        [base, b.mode, b.enabled, req.admin!.name, deps.clock.now(), b.note ?? null]);
      await audit(c, actorOf(req), b.enabled ? 'SALE_ENABLED' : 'SALE_DISABLED', 'Cohort', base, prev ? `${prev.enabled ? 'ON' : 'OFF'} ${prev.mode}` : null, `${b.enabled ? 'ON' : 'OFF'} ${b.mode}`, b.note ?? null);
      return { ok: true, cohortBase: base };
    });
  });
  void OPTS;
}
