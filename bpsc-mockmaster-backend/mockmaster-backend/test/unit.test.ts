import { describe, it, expect } from 'vitest';
import { checkQuestion, summary } from '../src/domain/validator.js';
import { score } from '../src/domain/scoring.js';
import { planSlots, buildSnapshot } from '../src/modules/content-core.js';
import { verifyCheckoutSignature, verifyWebhookSignature } from '../src/adapters/razorpay.js';
import { hmacHex, hashPassword, verifyPassword } from '../src/lib/crypto.js';
import { normalizeMobile } from '../src/modules/auth.js';
import { loadConfig } from '../src/config.js';
import { GeneratedBatch, toContent } from '../src/domain/contract.js';
import { cohortBase } from '../src/domain/types.js';
import { examDate } from '../src/lib/time.js';
import { CONFIGS, BLUEPRINTS } from '../src/db/reference-data.js';

const tri = (s: string) => ({ hi: s + ' हि', en: s, hl: s + ' hl' });
const goodQ = () => ({
  id: 'Q1', section: 'subject', subject_id: 'cs', topic: 'DBMS', subtopic: 'SQL', difficulty: 'EASY', question_type: 'MCQ_SINGLE', correct_option: 'B',
  content: { q: tri('Which SQL command removes all rows but keeps the table?'), opts: { A: tri('DROP'), B: tri('TRUNCATE'), C: tri('ALTER'), D: tri('REVOKE'), E: tri('RENAME') },
    why: { A: tri('Wrong — drops table'), B: tri('Correct — keeps structure'), C: tri('Wrong — alters'), D: tri('Wrong — privileges'), E: tri('Wrong — renames') }, exp: tri('TRUNCATE keeps structure.'), concept: tri('DDL'), tip: tri('tip') },
  source_type: 'AI_GENERATED', source_exam: null, source_year: null, source_document: null, current_affairs: null, content_needed: false, fingerprint: 'fp',
});
const ctx = { optionKeys: ['A', 'B', 'C', 'D', 'E'] as any, syllabus: [{ name: 'DBMS', subtopics: ['SQL'] }], expectedSubjectId: 'cs', blueprint: null, inMock: false, bankDuplicates: [] };

describe('validator (23 checks)', () => {
  it('passes a complete question and runs exactly 23 checks', () => {
    const c = checkQuestion(goodQ() as any, ctx); expect(c).toHaveLength(23); expect(summary(c)).not.toBe('FAIL');
  });
  it('fails a draft slot that was never written (check 23)', () => {
    const q: any = { ...goodQ(), content_needed: true }; expect(checkQuestion(q, ctx).find(x => x.n === 23)!.status).toBe('FAIL');
  });
  it('fails placeholder / simulated text', () => {
    const q: any = goodQ(); q.content.q.en = '[Simulated] question'; expect(summary(checkQuestion(q, ctx))).toBe('FAIL');
  });
  it('fails an AI item that claims an exam year, and a PYQ without a source document', () => {
    expect(checkQuestion({ ...goodQ(), source_exam: 'BPSC TRE', source_year: 2023 } as any, ctx).find(x => x.n === 20)!.status).toBe('FAIL');
    expect(checkQuestion({ ...goodQ(), source_type: 'PREVIOUS_YEAR', source_exam: 'BPSC TRE', source_year: 2023 } as any, ctx).find(x => x.n === 20)!.status).toBe('FAIL');
  });
  it('fails wrong option count, reason contradicting the key, missing translation, off-syllabus topic, duplicates', () => {
    const q: any = goodQ(); delete q.content.opts.E; delete q.content.why.E;
    expect(checkQuestion(q, ctx).find(x => x.n === 1)!.status).toBe('FAIL');
    const q2: any = goodQ(); q2.content.why.A = tri('Correct — oops'); expect(checkQuestion(q2, ctx).find(x => x.n === 12)!.status).toBe('FAIL');
    const q3: any = goodQ(); q3.content.q.hl = ''; expect(checkQuestion(q3, ctx).find(x => x.n === 14)!.status).toBe('FAIL');
    expect(checkQuestion({ ...goodQ(), topic: 'Astronomy' } as any, ctx).find(x => x.n === 7)!.status).toBe('FAIL');
    expect(checkQuestion(goodQ() as any, { ...ctx, bankDuplicates: ['Q9'] }).find(x => x.n === 18)!.status).toBe('FAIL');
  });
});

describe('scoring', () => {
  const cfg = { ...CONFIGS.find(c => c.id === 'TRE_1112_V1')!, version: 1, verification_status: 'PRACTICE_CONFIGURATION', practice: { durationMinutes: 15, negativeMarkingEnabled: true, negativeMarks: 0.25 }, negative_marking: false };
  it('scores from frozen data with negative marking only when configured', () => {
    const snap = buildSnapshot(cfg, 'PRACTICE');
    expect(snap.totalQuestions).toBe(15); expect(snap.optionKeys).toEqual(['A', 'B', 'C', 'D', 'E']);
    const qs = Array.from({ length: 15 }, (_, i) => ({ id: 'q' + i, position: i + 1, section: i < 3 ? 'language' : i < 7 ? 'gs' : 'subject', topic: 'T', subtopic: 'S', difficulty: 'EASY', correct: 'A' }));
    const ans: any = { q0: { selected: 'A', marked: false, timeSpentSec: 10 }, q1: { selected: 'B', marked: false, timeSpentSec: 10 }, q8: { selected: 'A', marked: false, timeSpentSec: 5 } };
    const r = score(snap, qs, ans, { weak: 50, ni: 70, good: 85, minSample: 3 });
    expect(r.total.correct).toBe(2); expect(r.total.wrong).toBe(1); expect(r.total.unattempted).toBe(12);
    expect(r.total.score).toBe(1.75); expect(r).not.toHaveProperty('percentile'); expect(r).not.toHaveProperty('rank');
    expect(r.quals[0].status).toBe('FAIL');            // language qualifying 30% practice threshold
  });
  it('plans slots matching the blueprint and difficulty mix', () => {
    const snap = buildSnapshot(cfg, 'PRACTICE'); const bp = BLUEPRINTS[0];
    const slots = planSlots(snap, bp as any);
    expect(slots).toHaveLength(15); expect(new Set(slots.map(s => s.n)).size).toBe(15);
    const d = (l: string) => slots.filter(s => s.difficulty === l).length;
    expect(d('EASY') + d('MEDIUM') + d('HARD')).toBe(15);
  });
});

describe('crypto, signatures, config guard rails', () => {
  it('verifies Razorpay checkout and webhook signatures (and rejects tampering)', () => {
    const sig = hmacHex('sec', 'order_1|pay_1');
    expect(verifyCheckoutSignature('order_1', 'pay_1', sig, 'sec')).toBe(true);
    expect(verifyCheckoutSignature('order_1', 'pay_2', sig, 'sec')).toBe(false);
    const raw = Buffer.from('{"a":1}'); expect(verifyWebhookSignature(raw, hmacHex('wh', raw), 'wh')).toBe(true);
    expect(verifyWebhookSignature(Buffer.from('{"a":2}'), hmacHex('wh', raw), 'wh')).toBe(false);
  });
  it('hashes admin passwords with scrypt', async () => {
    const h = await hashPassword('a long password!'); expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('a long password!', h)).toBe(true); expect(await verifyPassword('wrong', h)).toBe(false);
  });
  it('normalises Indian mobile numbers', () => {
    expect(normalizeMobile('98765 43210')).toBe('+919876543210'); expect(normalizeMobile('+91-9876543210')).toBe('+919876543210');
    expect(normalizeMobile('12345')).toBeNull(); expect(normalizeMobile('5876543210')).toBeNull();
  });
  const base = { DATABASE_URL: 'x', REDIS_URL: 'y', SESSION_PEPPER: 'p'.repeat(40), OTP_PEPPER: 'o'.repeat(40), RAZORPAY_KEY_ID: 'rzp_live_x', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w' };
  const prod = { ...base, NODE_ENV: 'production', OTP_PROVIDER: 'msg91', MSG91_AUTH_KEY: 'k', MSG91_TEMPLATE_ID: 't', PUBLIC_APP_ORIGIN: 'https://mockmaster.example', LEGAL_ENTITY_NAME: 'X', SUPPORT_EMAIL: 'a@b.c', BUSINESS_ADDRESS: 'addr', GRIEVANCE_OFFICER: 'g', ANTHROPIC_API_KEY: 'k' };
  it('refuses demo/console OTP, test Razorpay keys and missing legal details in production', () => {
    expect(() => loadConfig({ ...prod, OTP_PROVIDER: 'console' } as any)).toThrow(/console/);
    expect(() => loadConfig({ ...prod, RAZORPAY_KEY_ID: 'rzp_test_1' } as any)).toThrow(/Test Razorpay/);
    expect(() => loadConfig({ ...prod, LEGAL_ENTITY_NAME: '' } as any)).toThrow(/LEGAL_ENTITY_NAME/);
    expect(() => loadConfig({ ...prod, PUBLIC_APP_ORIGIN: 'http://mockmaster.example' } as any)).toThrow(/https/);
    expect(loadConfig(prod as any).isProd).toBe(true);
  });
});

describe('contract & helpers', () => {
  it('rejects malformed Claude output and option sets that do not match the configuration', () => {
    expect(GeneratedBatch.safeParse({ items: [{ slot: 1 }] }).success).toBe(false);
    const t = { hi: 'a', en: 'b', hinglish: 'c' };
    const item = { slot: 1, topic: 'x', subtopic: 'y', difficulty: 'EASY', question: t, options: { A: t, B: t, C: t, D: t }, correctOption: 'A', concept: t, explanation: t, optionReasons: { A: t, B: t, C: t, D: t }, examTip: t } as any;
    expect(() => toContent(item, ['A', 'B', 'C', 'D', 'E'])).toThrow(/does not match/);
    expect(toContent(item, ['A', 'B', 'C', 'D']).q).toEqual({ hi: 'a', en: 'b', hl: 'c' });
  });
  it('builds cohort keys and exam-zone dates', () => {
    expect(cohortBase({ examType: 'TRE', level: '11-12', subjectId: 'cs', treLanguage: 'hi' })).toBe('TRE|11-12|cs|hi');
    expect(cohortBase({ examType: 'STET', paper: 'P2', subjectId: 'other', otherSubjectName: '  Home   Science ' })).toBe('STET|P2|other:home science|-');
    expect(examDate(new Date('2026-10-04T19:00:00Z'), 'Asia/Kolkata')).toBe('2026-10-05');
  });
});
