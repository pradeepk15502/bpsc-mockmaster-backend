/**
 * Question quality validator — the 23 deterministic checks from the approved prototype, ported to TypeScript.
 * Each check returns PASS / WARN / FAIL / NA. A question with any FAIL cannot be validated or published.
 */
import { jaccard, triOk, words } from './text.js';
import { LANG_KEYS, LANG_NAME, OPTS, type OptKey, type QuestionContent } from './types.js';

export const VALIDATOR_VERSION = 'QV-5 · 23 checks';
export type CheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'NA';
export interface Check { n: number; label: string; status: CheckStatus; detail: string }
export interface BlueprintRule { sectionId: string; topic: string; subtopic: string; count: number }
export interface QInput {
  id: string; section: string; subject_id: string; topic: string; subtopic: string; difficulty: string; question_type: string;
  correct_option: string; content: QuestionContent; source_type: string; source_exam: string | null; source_year: number | null;
  source_document: string | null; current_affairs: any; content_needed: boolean; fingerprint: string;
}
export interface CheckCtx {
  optionKeys: OptKey[];
  /** syllabus of the question's subject when it is a catalog subject (checks 7/8) */
  syllabus: { name: string; subtopics: string[] }[] | null;
  /** when the question sits in a mock's SUBJECT section, the subject it must belong to (check 6) */
  expectedSubjectId: string | null;
  /** blueprint rules of the mock, or null when not assigned to a mock (check 19) */
  blueprint: BlueprintRule[] | null; inMock: boolean;
  /** ids of established questions of another lineage with the same fingerprint / concept hash (check 18) */
  bankDuplicates: string[];
}
const SOURCE_TYPES = ['ORIGINAL', 'PREVIOUS_YEAR', 'AI_GENERATED', 'ADMIN_CREATED', 'IMPORTED'];
const VERIFIERS: Record<string, (p: Record<string, number>) => string> = {
  subnet_hosts: p => String(Math.pow(2, 32 - p.prefix) - 2),
  py_floordiv: p => String(Math.floor(p.a / p.b)),
};
export const ruleFor = (rules: BlueprintRule[] | null, q: { section: string; topic: string; subtopic: string }) =>
  rules ? rules.find(r => r.sectionId === q.section && (r.topic === '*' || r.topic === q.topic) && (r.subtopic === '*' || r.subtopic === q.subtopic)) ?? null : null;

export function checkQuestion(q: QInput, ctx: CheckCtx): Check[] {
  const c = q.content; const out: Check[] = [];
  const add = (n: number, label: string, status: CheckStatus, detail = '') => out.push({ n, label, status, detail });
  const opt = (k: string) => (c.opts as any)?.[k] ?? {};
  const why = (k: string) => (c.why as any)?.[k] ?? {};
  const keys = OPTS.filter(k => (c.opts as any)?.[k]);
  const expected = ctx.optionKeys.length; const qEn = String(c.q?.en ?? '');

  add(1, `Exactly one correct answer (${expected} options per config)`, keys.includes(q.correct_option as OptKey) && keys.length === expected && keys.every(k => ctx.optionKeys.includes(k)) ? 'PASS' : 'FAIL',
    !keys.includes(q.correct_option as OptKey) ? `Key ${q.correct_option} not among options` : keys.length !== expected ? `${keys.length} options found` : `Key ${q.correct_option}`);
  const en = keys.map(k => String(opt(k).en || '').trim().toLowerCase());
  add(2, 'No duplicate options', en.some((t, i) => t && en.indexOf(t) !== i) ? 'FAIL' : 'PASS');
  let semi = ''; keys.forEach((a, i) => keys.forEach((b, j) => { if (j > i && !semi && words(opt(a).en).length > 1 && jaccard(opt(a).en, opt(b).en) >= 0.8) semi = a + '/' + b; }));
  add(3, 'No semantically duplicate options', semi ? 'WARN' : 'PASS', semi ? `Options ${semi} look alike` : '');
  const ct = String(opt(q.correct_option).en || '').toLowerCase();
  add(4, 'No answer leakage in stem', ct.length >= 5 && qEn.toLowerCase().includes(ct) ? 'WARN' : 'PASS');
  add(5, 'No ambiguous wording', /\b(always|never|best|probably|usually|may be)\b/i.test(qEn) ? 'WARN' : 'PASS', /\b(always|never|best)\b/i.test(qEn) ? 'Absolute/subjective word in stem' : '');
  add(6, 'Correct subject', ctx.expectedSubjectId == null || q.subject_id === ctx.expectedSubjectId ? 'PASS' : 'FAIL', q.subject_id);
  const top = ctx.syllabus ? ctx.syllabus.find(t => t.name === q.topic) : null;
  add(7, 'Correct topic (in syllabus)', !q.topic ? 'FAIL' : ctx.syllabus ? (top ? 'PASS' : 'FAIL') : 'PASS', q.topic);
  add(8, 'Correct subtopic (in syllabus)', !q.subtopic ? 'FAIL' : ctx.syllabus ? (top && top.subtopics.includes(q.subtopic) ? 'PASS' : 'FAIL') : 'PASS', q.subtopic);
  add(9, 'Correct difficulty tag', ['EASY', 'MEDIUM', 'HARD'].includes(q.difficulty) ? 'PASS' : 'FAIL', q.difficulty);
  const dig = (s: unknown) => (String(s || '').match(/\d+/g) || []).join(',');
  add(10, 'Translation consistency (numbers match)', dig(c.q?.en) === dig(c.q?.hi) && (!c.q?.hl || dig(c.q?.en) === dig(c.q?.hl)) ? 'PASS' : 'WARN');
  add(11, 'Explanation consistency (all languages + concept)', triOk(c.exp) ? (c.concept?.en ? 'PASS' : 'WARN') : 'FAIL',
    !triOk(c.exp) ? 'Explanation missing in ' + LANG_KEYS.filter(l => !(c.exp as any)?.[l]).map(l => LANG_NAME[l]).join(', ') : c.concept?.en ? '' : 'Concept line missing');
  const mis = keys.filter(k => { const t = String(why(k).en || ''); return k === q.correct_option ? !/^correct/i.test(t) : !/^wrong/i.test(t); });
  add(12, 'Correct option matches explanation', mis.length ? 'FAIL' : 'PASS', mis.length ? 'Reason contradicts key for ' + mis.join(', ') : '');
  const noReason = keys.filter(k => !triOk(why(k)));
  add(13, 'Every option has a reason', noReason.length ? 'FAIL' : 'PASS', noReason.length ? 'Missing for ' + noReason.join(', ') : '');
  const missT: string[] = []; if (!triOk(c.q)) missT.push('stem'); keys.forEach(k => { if (!triOk(opt(k))) missT.push('option ' + k); });
  add(14, 'No missing translation', missT.length ? 'FAIL' : 'PASS', missT.join(', '));
  const ca = q.current_affairs;
  add(15, 'Current-affairs claims sourced', q.question_type === 'CURRENT_AFFAIRS' ? (ca && ca.eventDate && ca.source && ca.sourceDate && ca.verifiedAt ? 'PASS' : 'FAIL') : 'NA',
    q.question_type === 'CURRENT_AFFAIRS' ? 'Needs eventDate, source, sourceDate, verifiedAt' : 'Not a current-affairs item');
  const ver = (kind: string): [CheckStatus, string] => {
    const v = c.verify; if (!v || v.kind !== kind || !VERIFIERS[v.fn]) return ['NA', 'No computable answer'];
    const got = VERIFIERS[v.fn](v.params); const exp = String(opt(q.correct_option).en || '').trim();
    return [got === exp ? 'PASS' : 'FAIL', `Computed ${got} vs key ${exp}`];
  };
  const m16 = ver('MATH'), m17 = ver('CODE');
  add(16, 'Mathematical answer valid', m16[0], m16[1]); add(17, 'Programming output valid', m17[0], m17[1]);
  add(18, 'No duplicate fingerprint', ctx.bankDuplicates.length ? 'FAIL' : 'PASS', ctx.bankDuplicates.length ? 'Matches ' + ctx.bankDuplicates.slice(0, 3).join(', ') : q.fingerprint);
  add(19, 'Blueprint compliance', ctx.inMock ? (ctx.blueprint ? (ruleFor(ctx.blueprint, q) ? 'PASS' : 'FAIL') : 'WARN') : 'NA',
    ctx.inMock ? (ctx.blueprint ? (ruleFor(ctx.blueprint, q) ? 'Matches blueprint' : `No rule for ${q.section} › ${q.topic} › ${q.subtopic}`) : 'Mock has no blueprint') : 'Not yet assigned to a mock');
  let prov: CheckStatus = 'PASS', pd = q.source_type;
  if (!SOURCE_TYPES.includes(q.source_type)) { prov = 'FAIL'; pd = 'Unknown source type'; }
  else if (q.source_type === 'PREVIOUS_YEAR') { const miss = (['source_exam', 'source_year', 'source_document'] as const).filter(k => !q[k]); if (miss.length) { prov = 'FAIL'; pd = 'Previous-year label needs ' + miss.join(', '); } }
  else if (q.source_type === 'AI_GENERATED' && (q.source_exam || q.source_year)) { prov = 'FAIL'; pd = 'AI-generated item must not claim an exam/year source'; }
  else if (q.source_type === 'IMPORTED' && !q.source_document) { prov = 'WARN'; pd = 'Import file not recorded'; }
  add(20, 'Source / provenance available', prov, pd);
  const oe = keys.map(k => String(opt(k).en || '')); const allAbove = oe.some(t => /\b(all|none) of the above\b/i.test(t));
  const ln = oe.map(t => t.length); const cl = String(opt(q.correct_option).en || '').length; const others = ln.filter((_, i) => keys[i] !== q.correct_option);
  const avgO = others.length ? others.reduce((a, b) => a + b, 0) / others.length : cl;
  add(21, 'No suspicious option pattern', allAbove || (cl > 40 && cl > avgO * 1.8) ? 'WARN' : 'PASS', allAbove ? 'Uses all/none of the above' : cl > 40 && cl > avgO * 1.8 ? 'Correct option is much longer than the others' : '');
  const untr = !!(c.q?.hi && c.q?.en && c.q.hi.trim() === c.q.en.trim() && /[a-z]{4}/i.test(c.q.en));
  const short = LANG_KEYS.filter(l => (c.q as any)?.[l] && c.q?.en && (c.q as any)[l].length < c.q.en.length * 0.35);
  add(22, 'Language / naturalness', untr || short.length ? 'WARN' : 'PASS', untr ? 'Hindi text is identical to English' : short.length ? 'Very short ' + short.map(l => LANG_NAME[l]).join(', ') + ' version' : '');
  const ph = /\[\s*simulated|\(simulated\)|सिम्युलेटेड|simulated ai|lorem ipsum|placeholder/i.test(JSON.stringify([c.q, c.opts, c.exp]));
  add(23, 'Real question content present', q.content_needed || ph || !(c.q?.en || c.q?.hi) ? 'FAIL' : 'PASS',
    q.content_needed ? 'Draft slot — question has not been written yet' : ph ? 'Placeholder text detected' : !(c.q?.en || c.q?.hi) ? 'No question text' : '');
  return out;
}
export const summary = (checks: Check[]): 'PASS' | 'WARN' | 'FAIL' => checks.some(c => c.status === 'FAIL') ? 'FAIL' : checks.some(c => c.status === 'WARN') ? 'WARN' : 'PASS';

/** Human-readable grouping used by the admin review screen. */
const VGROUPS: [string, number[]][] = [['Question content', [23]], ['Correct answer', [1, 12, 16, 17]], ['Options valid', [2, 3, 21]], ['Explanation valid', [11, 13]], ['Syllabus mapping', [6, 7, 8, 9]], ['Translation', [10, 14, 22]], ['Duplicate check', [18]], ['Blueprint compliance', [19]], ['Wording & answer leakage', [4, 5]], ['Source / provenance', [15, 20]]];
export function groups(checks: Check[]) {
  return VGROUPS.map(([name, ns]) => {
    const cs = checks.filter(c => ns.includes(c.n));
    const status = cs.some(c => c.status === 'FAIL') ? 'FAIL' : cs.some(c => c.status === 'WARN') ? 'WARN' : cs.every(c => c.status === 'NA') ? 'NA' : 'PASS';
    return { name, status, notes: cs.filter(c => c.status === 'FAIL' || c.status === 'WARN').map(c => c.label + (c.detail ? ': ' + c.detail : '')) };
  });
}
