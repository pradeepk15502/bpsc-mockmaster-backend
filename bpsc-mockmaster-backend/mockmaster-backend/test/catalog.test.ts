import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminLogin, call, makeCtx, seedBank, studentLogin, TRE_CS, type Ctx, type Session } from './helpers.js';

let ctx: Ctx; let superA: Session; let superB: Session; let content: Session;
beforeAll(async () => { ctx = await makeCtx(); superA = await adminLogin(ctx, 'SUPER_ADMIN'); superB = await adminLogin(ctx, 'SUPER_ADMIN'); content = await adminLogin(ctx, 'CONTENT_ADMIN'); });
afterAll(async () => { await ctx.close(); });

const avail = async () => (await call(ctx, 'POST', '/api/catalog/availability', { body: { selection: TRE_CS } })).json;
const reasons = async (mode = 'PRACTICE') => (await call(ctx, 'POST', '/api/admin/availability', { s: superA, body: { selection: TRE_CS, mode } })).json.reasons as string[];

describe('catalog never markets a pending configuration as official', () => {
  it('shows pending verification and no official pattern for seeded configs', async () => {
    const r = await call(ctx, 'GET', '/api/catalog');
    const l = r.json.tre.find((x: any) => x.key === '11-12');
    expect(l.verification).toBe('PENDING_VERIFICATION'); expect(l.officialPattern).toBeNull(); expect(l.verificationLabel).toMatch(/Pending/);
    expect(r.json.tre.find((x: any) => x.key === '1-5').configured).toBe(false);
  });
});

describe('content availability gate', () => {
  it('starts as Coming Soon with join-waitlist, never purchasable', async () => {
    const a = await avail();
    expect(a).toMatchObject({ state: 'COMING_SOON', canPurchase: false, canJoinWaitlist: true, price: null });
    expect(await reasons()).toEqual(expect.arrayContaining(['SALE_NOT_ENABLED', 'CONFIG_PENDING_VERIFICATION', 'INSUFFICIENT_REVIEWED_QUESTIONS', 'NO_ACTIVE_PRICE']));
  });
  it('refuses to create a payment order for a cohort that cannot be served (no gateway call)', async () => {
    const s = await studentLogin(ctx);
    const before = ctx.rzp.calls.length;
    const r = await call(ctx, 'POST', '/api/payments/orders', { s, body: { plan: 'TRE', parts: [TRE_CS], idempotencyKey: randomUUID() } });
    expect(r.status).toBe(409); expect(r.json.error.code).toBe('NOT_AVAILABLE'); expect(r.json.error.details.canJoinWaitlist).toBe(true);
    expect(ctx.rzp.calls.length).toBe(before);
    expect((await call(ctx, 'POST', '/api/waitlist', { s, body: { selection: TRE_CS } })).json.joined).toBe(true);
  });
  it('admin cannot switch the sale on until config, price and reviewed content are all ready', async () => {
    let r = await call(ctx, 'PUT', '/api/admin/sales', { s: superA, body: { selection: TRE_CS, mode: 'PRACTICE', enabled: true } });
    expect(r.status).toBe(409); expect(r.json.error.code).toBe('NOT_SERVABLE');
    await call(ctx, 'POST', '/api/admin/configs/TRE_1112_V1/mark-practice', { s: superA, body: { reason: 'Practice launch until official notification is verified' } });
    await ctx.db.query("UPDATE pricing_plans SET active=true WHERE id='PL_TRE_1112_CS_90'");
    expect(await reasons()).toEqual(['SALE_NOT_ENABLED', 'INSUFFICIENT_REVIEWED_QUESTIONS']);
    await seedBank(ctx, 'BP_TRE_1112_CS_PRACTICE', 1);                       // only 1 mock worth; 2 required in tests
    expect(await reasons()).toContain('INSUFFICIENT_REVIEWED_QUESTIONS');
    await seedBank(ctx, 'BP_TRE_1112_CS_PRACTICE', 1);
    expect(await reasons()).toEqual(['SALE_NOT_ENABLED']);
    r = await call(ctx, 'PUT', '/api/admin/sales', { s: superA, body: { selection: TRE_CS, mode: 'PRACTICE', enabled: true } });
    expect(r.status).toBe(200);
    const a = await avail(); expect(a.state).toBe('AVAILABLE'); expect(a.modeLabel).toMatch(/not an official BPSC paper/); expect(a.price.totalPaise).toBeGreaterThan(0);
  });
  it('Official Pattern mode is refused while the configuration is not officially verified', async () => {
    expect(await reasons('OFFICIAL')).toContain('OFFICIAL_MODE_NEEDS_VERIFIED_CONFIG');
    const r = await call(ctx, 'PUT', '/api/admin/sales', { s: superA, body: { selection: TRE_CS, mode: 'OFFICIAL', enabled: true } });
    expect(r.status).toBe(409);
  });
  it('a language without reviewed content stays Coming Soon (Urdu)', async () => {
    const r = await call(ctx, 'POST', '/api/admin/availability', { s: superA, body: { selection: { ...TRE_CS, treLanguage: 'ur' } } });
    expect(r.json.reasons).toContain('INSUFFICIENT_REVIEWED_QUESTIONS');
  });
});

describe('official configuration verification workflow', () => {
  const src = { sourceDocument: 'BPSC TRE 4.0 Advertisement No. XX/2026 (test fixture)', sourceUrl: 'https://bpsc.bih.nic.in/test-fixture.pdf' };
  it('needs a submitted source, a different SUPER_ADMIN, and matching source details', async () => {
    expect((await call(ctx, 'POST', '/api/admin/configs/STET_P2_V1/verify', { s: superA, body: src })).json.error.code).toBe('NOT_SUBMITTED');
    expect((await call(ctx, 'POST', '/api/admin/configs/STET_P2_V1/submit-verification', { s: content, body: src })).status).toBe(200);
    expect((await call(ctx, 'POST', '/api/admin/configs/STET_P2_V1/verify', { s: content, body: src })).status).toBe(403);       // CONTENT_ADMIN cannot verify
    expect((await call(ctx, 'POST', '/api/admin/configs/STET_P2_V1/verify', { s: superA, body: { ...src, sourceUrl: 'https://example.com/other.pdf' } })).json.error.code).toBe('SOURCE_MISMATCH');
    expect((await call(ctx, 'POST', '/api/admin/configs/STET_P2_V1/verify', { s: superA, body: src })).status).toBe(200);
    const row = (await ctx.db.query("SELECT * FROM exam_configs WHERE id='STET_P2_V1'")).rows[0];
    expect(row).toMatchObject({ verification_status: 'OFFICIALLY_VERIFIED', source_document: src.sourceDocument, source_url: src.sourceUrl });
    expect(row.verified_by).toBeTruthy(); expect(row.verified_at).toBeTruthy();
    const cat = (await call(ctx, 'GET', '/api/catalog')).json.stet.find((x: any) => x.key === 'P2');
    expect(cat.officialPattern.source).toBe(src.sourceDocument);
  });
  it('the submitter cannot verify their own submission', async () => {
    await call(ctx, 'POST', '/api/admin/configs/STET_P1_V1/submit-verification', { s: superB, body: src });
    expect((await call(ctx, 'POST', '/api/admin/configs/STET_P1_V1/verify', { s: superB, body: src })).json.error.code).toBe('SAME_PERSON');
  });
  it('verified configurations are immutable: a change is a new version (DRAFT, pending)', async () => {
    expect((await call(ctx, 'POST', '/api/admin/configs/STET_P2_V1/mark-practice', { s: superA, body: { reason: 'downgrade attempt' } })).json.error.code).toBe('ALREADY_VERIFIED');
    const body = { examType: 'STET', paper: 'P2', optionCount: 4, durationMinutes: 150, negativeMarking: false, practice: { durationMinutes: 15, negativeMarkingEnabled: false, negativeMarks: 0 },
      sections: [{ id: 'subject', name: 'Subject', kind: 'NORMAL', role: 'SUBJECT', order: 1, questionCount: 100, marksPerQuestion: 1, negativeMarks: 0, qualifyingPercent: null, practiceCount: 10, practiceQualifyingPercent: null }] };
    const r = await call(ctx, 'POST', '/api/admin/configs', { s: superA, body });
    expect(r.json.config).toMatchObject({ id: 'STET_P2_V2', status: 'DRAFT', verification_status: 'PENDING_VERIFICATION' });
    expect((await call(ctx, 'POST', '/api/admin/configs', { s: content, body })).status).toBe(403);
  });
  it('the database allows only one ACTIVE configuration per exam / level', async () => {
    await expect(ctx.db.query("INSERT INTO exam_configs (id, exam_type, paper, version, status, option_count, sections, practice) VALUES ('STET_P2_X', 'STET', 'P2', 99, 'ACTIVE', 4, '[]', '{}')")).rejects.toThrow(/exam_configs_one_active/);
  });
  it('every change is in the append-only audit log', async () => {
    const a = (await call(ctx, 'GET', '/api/admin/audit?entity=ExamConfig', { s: superA })).json.audit.map((x: any) => x.action);
    expect(a).toEqual(expect.arrayContaining(['CONFIG_SUBMITTED_FOR_VERIFICATION', 'CONFIG_VERIFIED', 'CONFIG_MARKED_PRACTICE', 'CONFIG_CREATED']));
    expect((await call(ctx, 'GET', '/api/admin/audit', { s: content })).status).toBe(403);
  });
});
