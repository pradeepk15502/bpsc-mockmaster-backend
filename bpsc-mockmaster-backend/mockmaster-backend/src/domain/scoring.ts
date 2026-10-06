/** Deterministic scoring from the frozen mock snapshot + the student's saved answers. Never uses AI. Ported from the prototype. */
import { pct, r2 } from './text.js';
import type { ConfigSnapshot, Tr } from './types.js';

export interface Thresholds { weak: number; ni: number; good: number; minSample: number }
export interface FrozenMeta { id: string; position: number; section: string; topic: string; subtopic: string; difficulty: string; correct: string }
export interface AnswerIn { selected: string | null; marked: boolean; timeSpentSec: number }

const T = (hi: string, en: string, hl: string): Tr => ({ hi, en, hl });
const secs = (s: number) => { s = Math.round(s || 0); return s >= 60 ? Math.floor(s / 60) + 'm ' + (s % 60) + 's' : s + 's'; };

export function label(p: number, total: number, th: Thresholds) {
  if (total < (th.minSample || 1)) return 'LIMITED';
  return p < th.weak ? 'WEAK' : p < th.ni ? 'NEEDS_IMPROVEMENT' : p < th.good ? 'GOOD' : 'STRONG';
}

export function score(snap: ConfigSnapshot, questions: FrozenMeta[], answers: Record<string, AnswerIn>, th: Thresholds) {
  const secMap: Record<string, any> = {};
  const sections = snap.sections.map(s => (secMap[s.id] = { id: s.id, name: s.name, kind: s.kind, role: s.role, qualifying: s.kind === 'QUALIFYING', mpq: s.marksPerQuestion, neg: s.negativeMarks, qualifyingPercent: s.qualifyingPercent, qualifyingSource: s.qualifyingSource, total: 0, attempted: 0, correct: 0, wrong: 0, unattempted: 0, raw: 0, negApplied: 0, score: 0, max: 0, timeSec: 0 }));
  const topicMap: Record<string, any> = {}, subMap: Record<string, any> = {}, diffMap: Record<string, any> = {}; const per: any[] = [];
  for (const q of [...questions].sort((a, b) => a.position - b.position)) {
    const a = answers[q.id]; const sel = a?.selected ?? null; const s = secMap[q.section]; if (!s) continue;
    const res = !sel ? 'SKIPPED' : sel === q.correct ? 'CORRECT' : 'WRONG'; const t = a?.timeSpentSec ?? 0;
    s.total++; s.max += s.mpq; s.timeSec += t;
    if (res === 'SKIPPED') s.unattempted++; else s.attempted++;
    if (res === 'CORRECT') { s.correct++; s.raw += s.mpq; }
    if (res === 'WRONG') { s.wrong++; if (snap.negativeMarkingEnabled && s.neg) s.negApplied += s.neg; }
    const tk = q.section + '|' + q.topic; const tp = topicMap[tk] ?? (topicMap[tk] = { name: q.topic, section: q.section, total: 0, attempted: 0, correct: 0, wrong: 0, weakSubs: [], timeSec: 0 });
    tp.total++; tp.timeSec += t; if (res !== 'SKIPPED') tp.attempted++; if (res === 'CORRECT') tp.correct++; if (res === 'WRONG') tp.wrong++;
    if (res !== 'CORRECT' && q.subtopic && !tp.weakSubs.includes(q.subtopic)) tp.weakSubs.push(q.subtopic);
    const sk = tk + '|' + q.subtopic; const sp = subMap[sk] ?? (subMap[sk] = { name: q.subtopic, topic: q.topic, total: 0, correct: 0 }); sp.total++; if (res === 'CORRECT') sp.correct++;
    const d = diffMap[q.difficulty] ?? (diffMap[q.difficulty] = { level: q.difficulty, total: 0, attempted: 0, correct: 0 }); d.total++; if (res !== 'SKIPPED') d.attempted++; if (res === 'CORRECT') d.correct++;
    per.push({ qid: q.id, n: q.position, section: q.section, topic: q.topic, subtopic: q.subtopic, difficulty: q.difficulty, selected: sel, correct: q.correct, result: res, timeSpent: t, marked: !!a?.marked });
  }
  sections.forEach(s => { s.score = r2(s.raw - s.negApplied); });
  const topics = Object.values(topicMap); topics.forEach((t: any) => { t.avgTime = t.total ? Math.round(t.timeSec / t.total) : 0; });
  return finish({ mode: snap.mode, negativeMarkingEnabled: snap.negativeMarkingEnabled, passPercent: snap.passPercent, examType: snap.examType, sections, topics, subtopics: Object.values(subMap), difficulty: ['EASY', 'MEDIUM', 'HARD'].map(k => diffMap[k]).filter(Boolean), perQuestion: per, timeSec: per.reduce((a, p) => a + p.timeSpent, 0), thresholds: { ...th } });
}

function finish(r: any) {
  const th = r.thresholds; const tot: any = { correct: 0, wrong: 0, unattempted: 0, attempted: 0, raw: 0, score: 0, max: 0, total: 0, negApplied: 0 };
  r.sections.forEach((s: any) => { s.accuracy = pct(s.correct, s.attempted); s.pct = pct(s.score, s.max); s.avgTime = s.total ? Math.round(s.timeSec / s.total) : 0; for (const k of Object.keys(tot)) tot[k] += s[k] || 0; });
  tot.raw = r2(tot.raw); tot.score = r2(tot.score); tot.accuracy = pct(tot.correct, tot.attempted); tot.pct = pct(tot.score, tot.max); tot.timeSec = r.timeSec || 0; tot.avgTime = tot.total ? Math.round(tot.timeSec / tot.total) : 0;
  r.total = tot;
  r.quals = r.sections.filter((s: any) => s.qualifying).map((s: any) => { const p = s.qualifyingPercent; return { name: s.name, score: s.score, max: s.max, pct: s.pct, percent: p, source: s.qualifyingSource || (p == null ? 'PENDING' : 'OFFICIAL'), status: p == null ? 'PENDING' : s.pct >= p ? 'PASS' : 'FAIL' }; });
  if (r.examType === 'STET' || (!r.quals.length && r.sections.every((s: any) => s.kind === 'NORMAL'))) { const p = r.passPercent; r.overallPass = { percent: p, status: p == null ? 'PENDING' : tot.pct >= p ? 'PASS' : 'FAIL' }; }
  const ms = r.sections.filter((s: any) => s.kind === 'MERIT'); const useMerit = ms.length > 0; const parts = useMerit ? ms : r.sections.filter((s: any) => !s.qualifying);
  r.merit = { isMerit: useMerit, score: r2(parts.reduce((a: number, s: any) => a + s.score, 0)), max: parts.reduce((a: number, s: any) => a + s.max, 0), parts: parts.map((s: any) => s.name).join(' + '), rows: parts.map((s: any) => ({ name: s.name, score: s.score, max: s.max })) };
  r.merit.pct = pct(r.merit.score, r.merit.max);
  r.topics.forEach((t: any) => { t.pct = pct(t.correct, t.total); t.accuracy = pct(t.correct, t.attempted); t.label = label(t.pct, t.total, th); });
  r.subtopics.forEach((t: any) => { t.pct = pct(t.correct, t.total); t.label = label(t.pct, t.total, th); });
  r.difficulty.forEach((d: any) => { d.accuracy = pct(d.correct, d.attempted); });
  r.insights = insights(r);
  // No percentile / rank: a single-cohort practice mock does not support a statistically honest one.
  return r;
}

function insights(r: any) {
  const th = r.thresholds; const min = th.minSample || 1;
  const ts = r.topics.filter((t: any) => t.total >= min); const secs2 = r.sections.filter((s: any) => s.total >= min);
  const pick = (list: any[], dir: number) => list.slice().sort((a, b) => dir * (a.pct - b.pct) || b.total - a.total)[0];
  const weakest = ts.length ? pick(ts, 1) : null, strongest = ts.length ? pick(ts, -1) : null;
  const wSec = secs2.length ? pick(secs2, 1) : null, sSec = secs2.length ? pick(secs2, -1) : null;
  const mostIncorrect = r.topics.slice().sort((a: any, b: any) => b.wrong - a.wrong)[0];
  const accList = ts.filter((t: any) => t.attempted > 0).sort((a: any, b: any) => b.accuracy - a.accuracy);
  const ord: Record<string, number> = { HARD: 0, MEDIUM: 1, EASY: 2 };
  const difficultQs = r.perQuestion.filter((p: any) => p.result === 'WRONG').sort((a: any, b: any) => ord[a.difficulty] - ord[b.difficulty]).slice(0, 3).map((p: any) => p.n);
  const sug: Tr[] = [];
  if (weakest) { const subs = weakest.weakSubs?.length ? weakest.weakSubs.join(', ') : weakest.name; sug.push(T(`सबसे कमजोर Topic: ${weakest.name} (${weakest.pct}%)। अगले अभ्यास में ${subs} पर ध्यान दें।`, `Weakest topic: ${weakest.name} (${weakest.pct}%). Focus on ${subs} in your next practice session.`, `Sabse weak topic: ${weakest.name} (${weakest.pct}%). Agli practice mein ${subs} par focus karein.`)); }
  else if (wSec) sug.push(T(`हर topic में ${min} से कम प्रश्न थे, इसलिए topic-स्तर पर निष्कर्ष नहीं। Section-स्तर पर सबसे कमजोर: ${wSec.name} (${wSec.pct}%)।`, `Each topic had fewer than ${min} questions, so no topic-level verdict yet (limited data). Section level: weakest is ${wSec.name} (${wSec.pct}%).`, `Har topic mein ${min} se kam sawal the — topic verdict abhi nahi. Section level par weakest: ${wSec.name} (${wSec.pct}%).`));
  if (strongest && strongest !== weakest) sug.push(T(`सबसे मजबूत Topic: ${strongest.name} (${strongest.pct}%) — साप्ताहिक revision से बनाए रखें।`, `Strongest topic: ${strongest.name} (${strongest.pct}%) — keep it sharp with a short weekly revision.`, `Strongest topic: ${strongest.name} (${strongest.pct}%) — weekly revision se maintain karein.`));
  const avg = r.total.avgTime; const slowT = r.topics.filter((t: any) => t.avgTime && avg && t.avgTime > avg * 1.4).sort((a: any, b: any) => b.avgTime - a.avgTime)[0];
  if (slowT) sug.push(T(`${slowT.name} के प्रश्नों में औसतन ${secs(slowT.avgTime)} लगे (कुल औसत ${secs(avg)}) — समयबद्ध सेट का अभ्यास करें।`, `${slowT.name} questions took ${secs(slowT.avgTime)} on average vs ${secs(avg)} overall — practise timed sets for this topic.`, `${slowT.name} mein average ${secs(slowT.avgTime)} lage (overall ${secs(avg)}) — timed practice karein.`));
  const hard = r.difficulty.find((d: any) => d.level === 'HARD'); if (hard && hard.attempted >= min && hard.accuracy < 60) sug.push(T(`Hard प्रश्नों में सटीकता ${hard.accuracy}% — पहले concept दोहराएँ।`, `Accuracy on Hard questions is ${hard.accuracy}% — revise the underlying concepts before timed practice.`, `Hard questions ki accuracy ${hard.accuracy}% — pehle concept revise karein.`));
  if (r.total.unattempted > 0) sug.push(T(`${r.total.unattempted} प्रश्न छोड़े गए — उनकी पूरी व्याख्या पढ़ें।`, `${r.total.unattempted} questions were skipped — read their full explanations in the review.`, `${r.total.unattempted} sawal chhode — review mein explanation padhein.`));
  (r.quals || []).filter((q: any) => q.status === 'FAIL').forEach((q: any) => sug.push(T(`${q.name} qualifying threshold से नीचे है — रोज़ अभ्यास जोड़ें।`, `${q.name} is below its qualifying threshold — add daily practice for this section.`, `${q.name} qualifying se neeche hai — roz practice karein.`)));
  return { weakest, strongest: strongest !== weakest ? strongest : null, wSec, sSec, mostIncorrect: mostIncorrect?.wrong ? mostIncorrect : null, highestAcc: accList[0] ?? null, difficultQs, suggestions: sug };
}
