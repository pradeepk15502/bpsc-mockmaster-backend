import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminLogin, buyPlan, call, makeCtx, makeSellable, sendWebhook, studentLogin, TRE_CS, webhookBody, type Ctx, type Session } from './helpers.js';
import { reconcilePayments } from '../src/modules/payments.js';

let ctx: Ctx; let superA: Session; let finance: Session; let support: Session;
beforeAll(async () => {
  ctx = await makeCtx(); superA = await adminLogin(ctx, 'SUPER_ADMIN'); finance = await adminLogin(ctx, 'FINANCE_ADMIN'); support = await adminLogin(ctx, 'SUPPORT_ADMIN');
  await makeSellable(ctx, superA);
});
afterAll(async () => { await ctx.close(); });

const order = async (s: Session, key = randomUUID()) => call(ctx, 'POST', '/api/payments/orders', { s, body: { plan: 'TRE', parts: [TRE_CS], idempotencyKey: key } });
const ents = async (s: Session) => (await call(ctx, 'GET', '/api/entitlements', { s })).json.entitlements;

describe('Razorpay order → Checkout → server verification', () => {
  it('prices on the server and is idempotent per key', async () => {
    const s = await studentLogin(ctx); const key = randomUUID();
    const a = await order(s, key); const b = await order(s, key);
    expect(a.status).toBe(200); expect(b.json.paymentId).toBe(a.json.paymentId); expect(ctx.rzp.orders.size).toBe(1);
    expect(a.json.amountPaise).toBe(Math.round((59900 - 17970) * 1.18)); expect(a.json.checkout.key).toBe('rzp_test_KEY');
    expect(JSON.stringify(a.json)).not.toContain('test_key_secret');
  });
  it('ignores any price the client sends', async () => {
    const s = await studentLogin(ctx);
    const r = await call(ctx, 'POST', '/api/payments/orders', { s, body: { plan: 'TRE', parts: [TRE_CS], idempotencyKey: randomUUID(), amountPaise: 100, price: 1 } });
    expect(r.json.amountPaise).toBe(Math.round((59900 - 17970) * 1.18));
  });
  it('activates only after a valid signature AND Razorpay confirms capture; double verify is idempotent', async () => {
    const s = await studentLogin(ctx);
    const o = await order(s); const pay = ctx.rzp.pay(o.json.checkout.order_id);
    const body = { paymentId: o.json.paymentId, razorpay_order_id: pay.order_id, razorpay_payment_id: pay.id, razorpay_signature: ctx.rzp.checkoutSignature(pay.order_id, pay.id) };
    const [v1, v2] = await Promise.all([call(ctx, 'POST', '/api/payments/verify', { s, body }), call(ctx, 'POST', '/api/payments/verify', { s, body })]);
    expect(v1.json.status).toBe('SUCCESS'); expect(v2.json.status).toBe('SUCCESS');
    const e = await ents(s); expect(e).toHaveLength(1); expect(e[0]).toMatchObject({ status: 'ACTIVE', daysLeft: 90, mode: 'PRACTICE' });
    expect((await ctx.db.query('SELECT count(*)::int n FROM purchases WHERE payment_id=$1', [o.json.paymentId])).rows[0].n).toBe(1);
  });
  it('frontend "success" with a forged signature activates nothing', async () => {
    const s = await studentLogin(ctx);
    const o = await order(s); const pay = ctx.rzp.pay(o.json.checkout.order_id);
    const r = await call(ctx, 'POST', '/api/payments/verify', { s, body: { paymentId: o.json.paymentId, razorpay_order_id: pay.order_id, razorpay_payment_id: pay.id, razorpay_signature: 'f'.repeat(64) } });
    expect(r.status).toBe(400); expect(r.json.error.code).toBe('SIGNATURE_INVALID'); expect(await ents(s)).toHaveLength(0);
  });
  it('a valid signature for a payment that is not captured stays PENDING (no entitlement)', async () => {
    const s = await studentLogin(ctx);
    const o = await order(s); const pay = ctx.rzp.pay(o.json.checkout.order_id, 'created');
    const r = await call(ctx, 'POST', '/api/payments/verify', { s, body: { paymentId: o.json.paymentId, razorpay_order_id: pay.order_id, razorpay_payment_id: pay.id, razorpay_signature: ctx.rzp.checkoutSignature(pay.order_id, pay.id) } });
    expect(r.json.status).toBe('PENDING'); expect(r.json.message).toMatch(/do not need to pay again/); expect(await ents(s)).toHaveLength(0);
  });
  it('blocks buying the same active plan twice', async () => {
    const s = await studentLogin(ctx); await buyPlan(ctx, s);
    const r = await order(s); expect(r.json.error.code).toBe('ALREADY_ACTIVE');
  });
  it("a student cannot read or verify another student's payment", async () => {
    const a = await studentLogin(ctx); const b = await studentLogin(ctx);
    const o = await order(a);
    expect((await call(ctx, 'GET', `/api/payments/${o.json.paymentId}`, { s: b })).status).toBe(404);
    const pay = ctx.rzp.pay(o.json.checkout.order_id);
    const r = await call(ctx, 'POST', '/api/payments/verify', { s: b, body: { paymentId: o.json.paymentId, razorpay_order_id: pay.order_id, razorpay_payment_id: pay.id, razorpay_signature: ctx.rzp.checkoutSignature(pay.order_id, pay.id) } });
    expect(r.status).toBe(404); expect(await ents(b)).toHaveLength(0);
  });
  it('gateway outage at order time: clear message, payment marked FAILED, nothing charged', async () => {
    const s = await studentLogin(ctx); ctx.rzp.down = true;
    const r = await order(s); ctx.rzp.down = false;
    expect(r.status).toBe(502); expect(r.json.error.message).toMatch(/not been charged/);
  });
});

describe('no double charging', () => {
  it('a second tab / retry reuses the open checkout instead of creating a second order', async () => {
    const s = await studentLogin(ctx);
    const a = await order(s); const b = await order(s);
    expect(b.json.paymentId).toBe(a.json.paymentId); expect(b.json.checkout.order_id).toBe(a.json.checkout.order_id);
  });
  it('if two payments for the same plan are both captured, only one plan is created and the extra payment is flagged for refund', async () => {
    const s = await studentLogin(ctx);
    const a = await order(s);
    await ctx.db.query("UPDATE payments SET created_at = created_at - interval '1 hour' WHERE id=$1", [a.json.paymentId]);     // old abandoned checkout
    const b = await order(s); expect(b.json.paymentId).not.toBe(a.json.paymentId);
    const pa = ctx.rzp.pay(a.json.checkout.order_id); const pb = ctx.rzp.pay(b.json.checkout.order_id);
    await Promise.all([sendWebhook(ctx, webhookBody('payment.captured', pa), 'evt_' + randomUUID()), sendWebhook(ctx, webhookBody('payment.captured', pb), 'evt_' + randomUUID())]);
    expect(await ents(s)).toHaveLength(1);
    const flagged = await ctx.db.query("SELECT count(*)::int n FROM audit_logs WHERE action='DUPLICATE_PAYMENT_NEEDS_REFUND' AND entity_id = ANY($1)", [[a.json.paymentId, b.json.paymentId]]);
    expect(flagged.rows[0].n).toBe(1);
  });
});

describe('webhooks', () => {
  it('scenario 8 — payment succeeds, browser closes, webhook arrives later and activates', async () => {
    const s = await studentLogin(ctx); const o = await order(s);
    const pay = ctx.rzp.pay(o.json.checkout.order_id);
    expect(await ents(s)).toHaveLength(0);                                  // no verify call ever happened
    ctx.clock.advance(10 * 60_000);
    const r = await sendWebhook(ctx, webhookBody('payment.captured', pay), 'evt_' + randomUUID());
    expect(r.json.result).toBe('activated'); expect(await ents(s)).toHaveLength(1);
    const p = (await ctx.db.query('SELECT status, verified_via FROM payments WHERE id=$1', [o.json.paymentId])).rows[0];
    expect(p).toEqual({ status: 'SUCCESS', verified_via: 'WEBHOOK' });
  });
  it('scenario 9 — the same webhook twice (and concurrently) is processed once', async () => {
    const s = await studentLogin(ctx); const o = await order(s); const pay = ctx.rzp.pay(o.json.checkout.order_id);
    const raw = webhookBody('payment.captured', pay); const id = 'evt_' + randomUUID();
    const rs = await Promise.all([sendWebhook(ctx, raw, id), sendWebhook(ctx, raw, id), sendWebhook(ctx, raw, id)]);
    expect(rs.map(r => r.status)).toEqual([200, 200, 200]);
    expect(rs.filter(r => r.json.result === 'activated')).toHaveLength(1);
    expect(rs.filter(r => r.json.result === 'duplicate')).toHaveLength(2);
    // a different event id for the same payment (order.paid after payment.captured) also cannot double-activate
    const r2 = await sendWebhook(ctx, webhookBody('order.paid', pay), 'evt_' + randomUUID()); expect(r2.json.result).toBe('already_settled');
    expect(await ents(s)).toHaveLength(1);
  });
  it('rejects an unsigned / tampered webhook and audits it', async () => {
    const s = await studentLogin(ctx); const o = await order(s); const pay = ctx.rzp.pay(o.json.checkout.order_id);
    const r = await sendWebhook(ctx, webhookBody('payment.captured', pay), 'evt_x', 'bad');
    expect(r.status).toBe(400); expect(await ents(s)).toHaveLength(0);
    const a = await ctx.db.query("SELECT count(*)::int n FROM audit_logs WHERE action='WEBHOOK_SIGNATURE_INVALID'"); expect(a.rows[0].n).toBeGreaterThan(0);
  });
  it('amount mismatch is never activated', async () => {
    const s = await studentLogin(ctx); const o = await order(s); const pay = ctx.rzp.pay(o.json.checkout.order_id, 'captured', 100);
    const r = await sendWebhook(ctx, webhookBody('payment.captured', pay), 'evt_' + randomUUID());
    expect(r.json.result).toBe('mismatch'); expect(await ents(s)).toHaveLength(0);
  });
  it('payment.failed marks FAILED; a later capture in the same Checkout still activates', async () => {
    const s = await studentLogin(ctx); const o = await order(s);
    const f = ctx.rzp.pay(o.json.checkout.order_id, 'failed');
    expect((await sendWebhook(ctx, webhookBody('payment.failed', f), 'evt_' + randomUUID())).json.result).toBe('failed');
    const ok = ctx.rzp.pay(o.json.checkout.order_id);
    expect((await sendWebhook(ctx, webhookBody('payment.captured', ok), 'evt_' + randomUUID())).json.result).toBe('activated');
  });
});

describe('reconciliation worker', () => {
  it('settles a captured payment whose webhook was lost, expires abandoned checkouts', async () => {
    const s = await studentLogin(ctx); const o = await order(s); ctx.rzp.pay(o.json.checkout.order_id);
    const s2 = await studentLogin(ctx); const o2 = await order(s2);
    ctx.clock.advance(2 * 3600_000);
    const r = await reconcilePayments(ctx.deps);
    expect(r.activated).toBeGreaterThanOrEqual(1); expect(r.expired).toBeGreaterThanOrEqual(1);
    expect(await ents(s)).toHaveLength(1);
    expect((await ctx.db.query('SELECT status FROM payments WHERE id=$1', [o2.json.paymentId])).rows[0].status).toBe('EXPIRED');
    const again = await reconcilePayments(ctx.deps); expect(again.activated).toBe(0);              // idempotent
  });
  it('captures an authorized-but-uncaptured payment', async () => {
    const s = await studentLogin(ctx); const o = await order(s); ctx.rzp.pay(o.json.checkout.order_id, 'authorized');
    ctx.clock.advance(5 * 60_000);
    await reconcilePayments(ctx.deps); expect(await ents(s)).toHaveLength(1);
  });
});

describe('refunds', () => {
  beforeAll(async () => { superA = await adminLogin(ctx, 'SUPER_ADMIN'); finance = await adminLogin(ctx, 'FINANCE_ADMIN'); support = await adminLogin(ctx, 'SUPPORT_ADMIN'); });   // earlier tests moved the clock past admin idle expiry
  it('only FINANCE / SUPER admins refund; access is revoked; refund webhook afterwards is a no-op', async () => {
    const s = await studentLogin(ctx); const b = await buyPlan(ctx, s);
    expect((await call(ctx, 'POST', `/api/admin/payments/${b.paymentId}/refund`, { s: support, body: { reason: 'Duplicate purchase' } })).status).toBe(403);
    const r = await call(ctx, 'POST', `/api/admin/payments/${b.paymentId}/refund`, { s: finance, body: { reason: 'Duplicate purchase' } });
    expect(r.status).toBe(200); expect(r.json.accessRevoked).toBe(true);
    expect((await ents(s))[0].status).toBe('REFUNDED');
    expect((await call(ctx, 'POST', `/api/admin/payments/${b.paymentId}/refund`, { s: finance, body: { reason: 'Duplicate purchase' } })).json.duplicate).toBe(true);
    const wh = JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_x', payment_id: b.rzpPaymentId, amount: 1 } } } });
    expect((await sendWebhook(ctx, wh, 'evt_' + randomUUID())).json.result).toBe('already_refunded');
    expect(ctx.rzp.refunds).toHaveLength(1);
  });
  it('a refund whose Razorpay call times out is not retried blindly (no double refund)', async () => {
    const s = await studentLogin(ctx); const b = await buyPlan(ctx, s);
    ctx.rzp.down = true;
    const r1 = await call(ctx, 'POST', `/api/admin/payments/${b.paymentId}/refund`, { s: finance, body: { reason: 'Student asked within window' } });
    ctx.rzp.down = false;
    expect(r1.status).toBe(502); expect(r1.json.error.message).toMatch(/may or may not/);
    const r2 = await call(ctx, 'POST', `/api/admin/payments/${b.paymentId}/refund`, { s: finance, body: { reason: 'Student asked within window' } });
    expect(r2.json.error.code).toBe('REFUND_IN_PROGRESS');
  });
  it('partial refunds from the dashboard add up; access is revoked once the full amount is refunded', async () => {
    const s = await studentLogin(ctx); const b = await buyPlan(ctx, s);
    const amt = (await ctx.db.query('SELECT amount_paise FROM payments WHERE id=$1', [b.paymentId])).rows[0].amount_paise;
    const half = Math.floor(amt / 2);
    const wh = (id: string, a: number) => JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id, payment_id: b.rzpPaymentId, amount: a } } } });
    expect((await sendWebhook(ctx, wh('rf_p1', half), 'evt_' + randomUUID())).json.result).toBe('partial_refund');
    expect((await ents(s))[0].status).toBe('ACTIVE');
    expect((await sendWebhook(ctx, wh('rf_p2', amt - half), 'evt_' + randomUUID())).json.result).toBe('refunded');
    expect((await ents(s))[0].status).toBe('REFUNDED');
  });
  it('a refund made in the Razorpay dashboard arrives by webhook and revokes access', async () => {
    const s = await studentLogin(ctx); const b = await buyPlan(ctx, s);
    const amt = (await ctx.db.query('SELECT amount_paise FROM payments WHERE id=$1', [b.paymentId])).rows[0].amount_paise;
    const wh = JSON.stringify({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_dash', payment_id: b.rzpPaymentId, amount: amt } } } });
    expect((await sendWebhook(ctx, wh, 'evt_' + randomUUID())).json.result).toBe('refunded');
    expect((await ents(s))[0].status).toBe('REFUNDED');
  });
  it('audit trail covers verification, refund and reconciliation', async () => {
    const acts = (await call(ctx, 'GET', '/api/admin/audit?entity=Payment', { s: superA })).json.audit.map((x: any) => x.action);
    expect(acts).toEqual(expect.arrayContaining(['PAYMENT_VERIFIED', 'REFUND_PROCESSED', 'PAYMENT_SIGNATURE_INVALID', 'PAYMENT_MISMATCH', 'PAYMENT_EXPIRED']));
  });
});
