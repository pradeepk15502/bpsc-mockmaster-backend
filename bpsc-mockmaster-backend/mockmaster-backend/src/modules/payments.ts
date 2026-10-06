import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { verifyCheckoutSignature, verifyWebhookSignature, type RzpPayment } from '../adapters/razorpay.js';
import { audit, SYSTEM, type Actor } from '../lib/audit.js';
import { sha256 } from '../lib/crypto.js';
import { exec, many, one, tx, type Queryable } from '../lib/db.js';
import { AppError, badRequest, conflict, notFound } from '../lib/errors.js';
import { LIMITS } from '../lib/ratelimit.js';
import { examDate } from '../lib/time.js';
import { actorOf, noStore, parse, studentOf, Uuid } from '../http.js';
import { adminGuard, studentGuard } from './sessions.js';
import { availability, getSettings, quote, SelectionSchema, syllabusSubjectFor } from './catalog.js';
import { cohortBase, normSubject, type Selection } from '../domain/types.js';
import { logEvent } from './events.js';
import { notify } from './notify.js';

const WEBHOOK_ACTOR: Actor = { type: 'WEBHOOK', name: 'Razorpay webhook', role: 'SYSTEM' };
const RECON_ACTOR: Actor = { type: 'SYSTEM', name: 'Payment reconciliation worker', role: 'SYSTEM' };

const OrderIn = z.object({
  plan: z.enum(['TRE', 'STET', 'BOTH']),
  parts: z.array(SelectionSchema).min(1).max(2),
  questionLang: z.enum(['hi', 'en', 'hl']).default('en'),
  explanationLang: z.enum(['hi', 'en', 'hl']).default('hl'),
  idempotencyKey: z.string().uuid(),
}).superRefine((b, ctx) => {
  const types = b.parts.map(p => p.examType).sort().join(',');
  if (b.plan === 'BOTH' ? types !== 'STET,TRE' : types !== b.plan) ctx.addIssue({ code: 'custom', message: 'Plan and selected exams do not match' });
});
const VerifyIn = z.object({ paymentId: Uuid, razorpay_order_id: z.string().min(1).max(64), razorpay_payment_id: z.string().min(1).max(64), razorpay_signature: z.string().min(1).max(256) });

const titleOf = (p: Selection) => p.examType === 'TRE'
  ? `TRE · Class ${p.level} · ${p.subjectId === 'other' ? p.otherSubjectName + ' (Other)' : p.subjectId} · ${p.treLanguage}`
  : `STET · ${p.paper} · ${p.subjectId === 'other' ? p.otherSubjectName + ' (Other)' : p.subjectId}`;

/**
 * The ONLY place an entitlement is created. Called after (a) a verified Checkout signature + Razorpay confirms
 * capture, (b) a signed webhook, or (c) reconciliation against the Razorpay API. Idempotent: unique payment_id on
 * purchases and unique (payment_id, cohort_base) on entitlements make double activation impossible.
 */
export async function finalizePayment(deps: Deps, c: Queryable, paymentId: string, rzp: RzpPayment, via: 'CHECKOUT_VERIFY' | 'WEBHOOK' | 'RECONCILIATION', actor: Actor) {
  const p = await one(c, 'SELECT * FROM payments WHERE id=$1 FOR UPDATE', [paymentId]);
  if (!p) throw notFound('Payment');
  if (p.status === 'SUCCESS') return { status: 'SUCCESS', duplicate: true };
  if (p.status === 'REFUNDED') return { status: 'REFUNDED', duplicate: true };
  if (rzp.status !== 'captured') return { status: p.status, notCaptured: true };
  if (rzp.order_id !== p.razorpay_order_id || rzp.amount !== p.amount_paise || rzp.currency !== p.currency) {
    await audit(c, actor, 'PAYMENT_MISMATCH', 'Payment', p.id, { order: p.razorpay_order_id, amount: p.amount_paise }, { order: rzp.order_id, amount: rzp.amount }, 'Not activated — needs finance review');
    return { status: p.status, mismatch: true };
  }
  const now = deps.clock.now();
  await exec(c, `UPDATE payments SET status='SUCCESS', razorpay_payment_id=$2, signature_verified = signature_verified OR $3, verified_at=$4, verified_via=$5, updated_at=$4, failure_reason=NULL WHERE id=$1`,
    [p.id, rzp.id, via === 'CHECKOUT_VERIFY', now, via]);
  const spec = p.spec;
  const pur = await one(c, `INSERT INTO purchases (user_id, payment_id, plan, amount_paise, created_at) VALUES ($1,$2,$3,$4,$5)
                            ON CONFLICT (payment_id) DO UPDATE SET plan = purchases.plan RETURNING id`, [p.user_id, p.id, spec.plan, p.amount_paise, now]);
  const expires = new Date(now.getTime() + spec.durationDays * 86400_000);
  const duplicates: string[] = [];
  for (const part of spec.parts as any[]) {
    // Serialise activations for this student + cohort across concurrent payments.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ent:${p.user_id}:${part.cohortBase}`]);
    const already = await one(c, "SELECT id FROM entitlements WHERE user_id=$1 AND cohort_base=$2 AND status='ACTIVE' AND expires_at > $3 AND payment_id <> $4", [p.user_id, part.cohortBase, now, p.id]);
    if (already) { duplicates.push(part.cohortBase); continue; }
    await exec(c, `INSERT INTO entitlements (user_id, purchase_id, payment_id, plan_type, exam_type, level, paper, subject_id, subject_type, other_subject_name, other_subject_key,
                     tre_language, question_lang, explanation_lang, mode, status, cohort_base, purchased_at, activated_at, expires_at, duration_days)
                   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'ACTIVE',$16,$17,$17,$18,$19) ON CONFLICT (payment_id, cohort_base) DO NOTHING`,
      [p.user_id, pur!.id, p.id, spec.plan, part.examType, part.level, part.paper, part.subjectId, part.subjectId === 'other' ? 'OTHER' : 'LISTED', part.otherSubjectName,
        part.subjectId === 'other' ? normSubject(part.otherSubjectName) : null, part.treLanguage, spec.questionLang, spec.explanationLang, part.mode, part.cohortBase, now, expires, spec.durationDays]);
  }
  if (duplicates.length) {
    // Money was captured twice for the same plan: keep the first plan, flag this payment for a refund.
    await audit(c, actor, 'DUPLICATE_PAYMENT_NEEDS_REFUND', 'Payment', p.id, null, duplicates, 'Student already had an active plan for this cohort');
    await notify(c, { audience: 'admin', type: 'refund', title: 'Duplicate payment — refund needed', message: `${spec.label} · ₹${(p.amount_paise / 100).toFixed(2)} · payment ${p.id}` }, now);
    await notify(c, { audience: 'student', userId: p.user_id, type: 'purchase', title: 'Duplicate payment received', message: 'You already had this plan. The extra payment will be refunded to your original payment method.' }, now);
  }
  await logEvent(c, p.user_id, 'PAYMENT_SUCCESS', { paymentId: p.id, via }, now);
  await logEvent(c, p.user_id, 'PLAN_ACTIVATED', { paymentId: p.id }, now);
  await notify(c, { audience: 'student', userId: p.user_id, type: 'purchase', title: 'Purchase successful', message: `${spec.label} is active for ${spec.durationDays} days.`, purchaseId: pur!.id }, now);
  await notify(c, { audience: 'admin', type: 'purchase', title: 'New purchase', message: `${spec.label} · ₹${(p.amount_paise / 100).toFixed(2)}`, purchaseId: pur!.id }, now);
  await audit(c, actor, 'PAYMENT_VERIFIED', 'Payment', p.id, p.status, 'SUCCESS', `via ${via} · ${rzp.id}`);
  return { status: 'SUCCESS', duplicate: false };
}

async function markFailed(deps: Deps, c: Queryable, paymentId: string, status: 'FAILED' | 'EXPIRED', reason: string, actor: Actor) {
  const n = await exec(c, `UPDATE payments SET status=$2, failure_reason=$3, updated_at=$4 WHERE id=$1 AND status IN ('CREATED','PENDING')`, [paymentId, status, reason.slice(0, 300), deps.clock.now()]);
  if (n) await audit(c, actor, status === 'FAILED' ? 'PAYMENT_FAILED' : 'PAYMENT_EXPIRED', 'Payment', paymentId, null, status, reason);
  return n > 0;
}

async function applyRefund(deps: Deps, c: Queryable, p: any, refundId: string, reason: string, revoke: boolean, actor: Actor) {
  const now = deps.clock.now();
  await exec(c, "UPDATE payments SET status='REFUNDED', refund_id=$2, refunded_at=$3, updated_at=$3, refunded_paise=amount_paise WHERE id=$1", [p.id, refundId, now]);
  if (revoke) await exec(c, "UPDATE entitlements SET status='REFUNDED' WHERE payment_id=$1 AND status='ACTIVE'", [p.id]);
  await notify(c, { audience: 'student', userId: p.user_id, type: 'refund', title: 'Refund processed', message: `₹${(p.amount_paise / 100).toFixed(2)} has been refunded to your original payment method.` }, now);
  await audit(c, actor, 'REFUND_PROCESSED', 'Payment', p.id, 'SUCCESS', 'REFUNDED', `${reason} · refund ${refundId}${revoke ? ' · access revoked' : ''}`);
}

/** Worker job: settles CREATED / PENDING payments against the Razorpay API (webhook delayed or lost). */
export async function reconcilePayments(deps: Deps, opts: { minAgeMs?: number } = {}) {
  const now = deps.clock.now(); const minAge = opts.minAgeMs ?? 2 * 60_000;
  // Open payments, plus recently FAILED ones (a later retry inside the same Checkout can still be captured).
  const rows = await many(deps.db, `SELECT id, razorpay_order_id, created_at FROM payments WHERE razorpay_order_id IS NOT NULL
                                     AND (status IN ('CREATED','PENDING') OR (status='FAILED' AND updated_at >= $3))
                                     AND created_at <= $1 AND created_at >= $2 ORDER BY created_at LIMIT 200`,
    [new Date(now.getTime() - minAge), new Date(now.getTime() - 7 * 86400_000), new Date(now.getTime() - 86400_000)]);
  const out = { checked: rows.length, activated: 0, failed: 0, expired: 0, errors: 0 };
  for (const r of rows) {
    try {
      const list = await deps.razorpay.fetchOrderPayments(r.razorpay_order_id);
      let captured = list.find(x => x.status === 'captured');
      const authorized = list.find(x => x.status === 'authorized');
      if (!captured && authorized) { try { captured = await deps.razorpay.capture(authorized.id, authorized.amount, authorized.currency); } catch { /* retry next run */ } }
      if (captured && captured.status === 'captured') {
        const res = await tx(deps.db, c => finalizePayment(deps, c, r.id, captured!, 'RECONCILIATION', RECON_ACTOR));
        if (res.status === 'SUCCESS' && !res.duplicate) out.activated++;
        continue;
      }
      const age = now.getTime() - new Date(r.created_at).getTime();
      if (list.length && list.every(x => x.status === 'failed') && age > 30 * 60_000) { if (await tx(deps.db, c => markFailed(deps, c, r.id, 'FAILED', list[list.length - 1].error_description || 'Payment failed at the bank', RECON_ACTOR))) out.failed++; }
      else if (!list.length && age > 60 * 60_000) { if (await tx(deps.db, c => markFailed(deps, c, r.id, 'EXPIRED', 'Checkout was not completed', RECON_ACTOR))) out.expired++; }
    } catch (e) { out.errors++; deps.log.warn({ err: e, paymentId: r.id }, 'reconciliation failed for payment'); }
  }
  return out;
}

export function paymentRoutes(app: FastifyInstance, deps: Deps) {
  const today = () => examDate(deps.clock.now(), deps.cfg.TZ_EXAM);

  app.post('/api/payments/orders', { preHandler: studentGuard(deps) }, async (req, reply) => {
    noStore(reply);
    const u = studentOf(req);
    await deps.limiter.hit('pay_create', u.userId, LIMITS.paymentCreatePerUser);
    const b = parse(OrderIn, req.body);
    const prev = await one(deps.db, 'SELECT * FROM payments WHERE user_id=$1 AND idempotency_key=$2', [u.userId, b.idempotencyKey]);
    if (prev) {
      if (prev.status !== 'CREATED' || !prev.razorpay_order_id) throw conflict('ORDER_CLOSED', 'This checkout is no longer open. Please start again.');
      return orderResponse(deps, prev);
    }
    const now = deps.clock.now(); const parts: any[] = [];
    for (const sel of b.parts) {
      const a = await availability(deps.db, sel, today());
      // Content availability gate: never take money for a cohort that cannot be served.
      if (a.state !== 'AVAILABLE') throw conflict('NOT_AVAILABLE', 'This mock series is not open for purchase yet. You can join the waitlist instead.', { canJoinWaitlist: true });
      const owned = await one(deps.db, "SELECT id FROM entitlements WHERE user_id=$1 AND cohort_base=$2 AND status='ACTIVE' AND expires_at > $3", [u.userId, a.cohortBase, now]);
      if (owned) throw conflict('ALREADY_ACTIVE', 'You already have an active plan for this exam and subject.');
      // One open checkout per cohort: a second tab / retry reuses it instead of creating a second chargeable order.
      const open = await one(deps.db, `SELECT * FROM payments WHERE user_id=$1 AND status IN ('CREATED','PENDING') AND created_at > $2
                                        AND EXISTS (SELECT 1 FROM jsonb_array_elements(spec->'parts') p WHERE p->>'cohortBase' = $3) ORDER BY created_at DESC LIMIT 1`,
        [u.userId, new Date(now.getTime() - 30 * 60_000), a.cohortBase]);
      if (open?.status === 'CREATED' && open.razorpay_order_id && open.spec.parts.length === b.parts.length) return orderResponse(deps, open);
      if (open) throw conflict('CHECKOUT_OPEN', 'A payment for this plan is already in progress. If money was deducted it will be confirmed automatically — please do not pay again.', { paymentId: open.id });
      parts.push({ ...sel, cohortBase: cohortBase(sel), mode: a.mode, configId: a.config.id, syllabusSubjectId: await syllabusSubjectFor(deps.db, sel) });
    }
    const single = b.parts.length === 1 ? b.parts[0] : null;
    const price = await quote(deps.db, b.plan, single ? { level: single.level, paper: single.paper, subjectId: single.subjectId === 'other' ? null : single.subjectId } : {}, today());
    if (!price) throw conflict('NOT_AVAILABLE', 'This plan has no active price right now.', { canJoinWaitlist: true });
    const label = `${b.plan} · ${b.parts.map(titleOf).join(' + ')}`;
    const spec = { plan: b.plan, parts, durationDays: price.durationDays, questionLang: b.questionLang, explanationLang: b.explanationLang, label };
    let p: any;
    try {
      p = await tx(deps.db, async c => {
        const row = await one(c, `INSERT INTO payments (user_id, idempotency_key, amount_paise, currency, status, spec, price_breakdown, created_at, updated_at)
                                  VALUES ($1,$2,$3,'INR','CREATED',$4,$5,$6,$6) RETURNING *`, [u.userId, b.idempotencyKey, price.totalPaise, spec, price, now]);
        await logEvent(c, u.userId, 'PURCHASE_CREATED', { paymentId: row.id }, now);
        return row;
      });
    } catch (e: any) {
      if (e?.code === '23505') { const again = await one(deps.db, 'SELECT * FROM payments WHERE user_id=$1 AND idempotency_key=$2', [u.userId, b.idempotencyKey]); if (again?.razorpay_order_id) return orderResponse(deps, again); throw conflict('IN_PROGRESS', 'Checkout is being prepared. Please retry.'); }
      throw e;
    }
    let order;
    try { order = await deps.razorpay.createOrder({ amount: p.amount_paise, currency: 'INR', receipt: p.id, notes: { paymentId: p.id } }); }
    catch (e) {
      req.log.error({ err: e }, 'razorpay order failed');
      await exec(deps.db, "UPDATE payments SET status='FAILED', failure_reason='Could not create gateway order', updated_at=$2 WHERE id=$1", [p.id, now]);
      throw new AppError(502, 'GATEWAY_UNAVAILABLE', 'The payment gateway is not responding. You have not been charged. Please try again.');
    }
    if (order.amount !== p.amount_paise) throw new AppError(502, 'GATEWAY_MISMATCH', 'The payment gateway returned an unexpected amount. You have not been charged.');
    p = await one(deps.db, 'UPDATE payments SET razorpay_order_id=$2, updated_at=$3 WHERE id=$1 RETURNING *', [p.id, order.id, now]);
    return orderResponse(deps, p);
  });

  /** Called by the frontend after Checkout. It never activates anything by itself: the server re-checks with Razorpay. */
  app.post('/api/payments/verify', { preHandler: studentGuard(deps) }, async (req, reply) => {
    noStore(reply);
    const u = studentOf(req);
    await deps.limiter.hit('pay_verify', u.userId, LIMITS.paymentVerifyPerUser);
    const b = parse(VerifyIn, req.body);
    const p = await one(deps.db, 'SELECT * FROM payments WHERE id=$1 AND user_id=$2', [b.paymentId, u.userId]);
    if (!p) throw notFound('Payment');
    if (p.status === 'SUCCESS') return statusResponse(deps, p.id);
    if (p.razorpay_order_id !== b.razorpay_order_id || !verifyCheckoutSignature(b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature, deps.cfg.RAZORPAY_KEY_SECRET)) {
      await audit(deps.db, actorOf(req), 'PAYMENT_SIGNATURE_INVALID', 'Payment', p.id, null, null, 'Checkout signature verification failed');
      throw badRequest('SIGNATURE_INVALID', 'We could not verify this payment. If money was deducted, it will be confirmed automatically or refunded.');
    }
    let rzp: RzpPayment | null = null;
    try {
      rzp = await deps.razorpay.fetchPayment(b.razorpay_payment_id);
      if (rzp.status === 'authorized') rzp = await deps.razorpay.capture(rzp.id, rzp.amount, rzp.currency);
    } catch (e) { req.log.warn({ err: e }, 'razorpay fetch failed during verify'); }
    if (rzp && rzp.status === 'captured') {
      await tx(deps.db, c => finalizePayment(deps, c, p.id, rzp!, 'CHECKOUT_VERIFY', actorOf(req)));
    } else {
      // Signature fine but capture not confirmed yet: webhook / reconciliation will settle it.
      await exec(deps.db, "UPDATE payments SET status='PENDING', signature_verified=true, updated_at=$2 WHERE id=$1 AND status='CREATED'", [p.id, deps.clock.now()]);
    }
    return statusResponse(deps, p.id);
  });

  app.get('/api/payments/:id', { preHandler: studentGuard(deps) }, async (req, reply) => {
    noStore(reply);
    const id = parse(Uuid, (req.params as any).id);
    const p = await one(deps.db, 'SELECT id FROM payments WHERE id=$1 AND user_id=$2', [id, studentOf(req).userId]);
    if (!p) throw notFound('Payment');
    return statusResponse(deps, id);
  });
  app.get('/api/payments', { preHandler: studentGuard(deps) }, async (req, reply) => {
    noStore(reply);
    const rows = await many(deps.db, 'SELECT id, status, amount_paise, spec, created_at, refunded_at FROM payments WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100', [studentOf(req).userId]);
    return { payments: rows.map(r => ({ id: r.id, status: r.status, amountPaise: r.amount_paise, label: r.spec.label, createdAt: r.created_at, refundedAt: r.refunded_at })) };
  });

  app.get('/api/entitlements', { preHandler: studentGuard(deps) }, async (req, reply) => {
    noStore(reply);
    const now = deps.clock.now();
    const rows = await many(deps.db, 'SELECT * FROM entitlements WHERE user_id=$1 ORDER BY activated_at DESC', [studentOf(req).userId]);
    return { entitlements: rows.map(e => publicEntitlement(e, now)) };
  });
  app.patch('/api/entitlements/:id', { preHandler: studentGuard(deps) }, async req => {
    const id = parse(Uuid, (req.params as any).id);
    const b = parse(z.object({ questionLang: z.enum(['hi', 'en', 'hl']).optional(), explanationLang: z.enum(['hi', 'en', 'hl']).optional() }), req.body);
    // Only display preferences are editable. Dates, status and scope are server-controlled.
    const e = await one(deps.db, 'UPDATE entitlements SET question_lang=COALESCE($3,question_lang), explanation_lang=COALESCE($4,explanation_lang) WHERE id=$1 AND user_id=$2 RETURNING *',
      [id, studentOf(req).userId, b.questionLang ?? null, b.explanationLang ?? null]);
    if (!e) throw notFound('Plan');
    return { entitlement: publicEntitlement(e, deps.clock.now()) };
  });

  // ---------------- Razorpay webhook (signed, deduplicated by event id, processed atomically) ----------------
  app.post('/api/webhooks/razorpay', async (req, reply) => {
    await deps.limiter.hit('webhook', req.ip, LIMITS.webhookPerIp);
    const raw: Buffer | undefined = (req as any).rawBody;
    const sig = String(req.headers['x-razorpay-signature'] ?? '');
    if (!raw || !verifyWebhookSignature(raw, sig, deps.cfg.RAZORPAY_WEBHOOK_SECRET)) {
      await audit(deps.db, { ...WEBHOOK_ACTOR, ip: req.ip }, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook', null);
      return reply.status(400).send({ error: { code: 'SIGNATURE_INVALID', message: 'Invalid signature.' } });
    }
    const body: any = req.body; const eventId = String(req.headers['x-razorpay-event-id'] ?? '') || 'sha256:' + sha256(raw.toString('utf8'));
    const result = await tx(deps.db, async c => {
      const ins = await one(c, 'INSERT INTO webhook_events (event_id, event_type, received_at, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (event_id) DO NOTHING RETURNING event_id',
        [eventId, String(body?.event ?? 'unknown'), deps.clock.now(), body]);
      if (!ins) return 'duplicate';
      const res = await handleWebhook(deps, c, body);
      await exec(c, 'UPDATE webhook_events SET processed_at=$2, result=$3 WHERE event_id=$1', [eventId, deps.clock.now(), res]);
      return res;
    });
    return { ok: true, result };
  });

  // ---------------- admin ----------------
  app.get('/api/admin/payments', { preHandler: adminGuard(deps, 'payment.view') }, async req => {
    const q = parse(z.object({ status: z.string().max(20).optional() }), req.query);
    const rows = await many(deps.db, `SELECT p.id, p.status, p.amount_paise, p.razorpay_order_id, p.razorpay_payment_id, p.verified_via, p.created_at, p.refunded_at, p.spec->>'label' AS label, u.student_code, u.name
                                      FROM payments p JOIN users u ON u.id = p.user_id WHERE ($1::text IS NULL OR p.status=$1) ORDER BY p.created_at DESC LIMIT 200`, [q.status ?? null]);
    return { payments: rows };
  });
  app.post('/api/admin/payments/reconcile', { preHandler: adminGuard(deps, 'payment.reconcile') }, async req => {
    const r = await reconcilePayments(deps, { minAgeMs: 0 });
    await audit(deps.db, actorOf(req), 'PAYMENTS_RECONCILED', 'Payment', null, null, r);
    return r;
  });
  app.post('/api/admin/payments/:id/refund', { preHandler: adminGuard(deps, 'payment.refund') }, async req => {
    const id = parse(Uuid, (req.params as any).id);
    const b = parse(z.object({ reason: z.string().trim().min(5).max(300), revokeAccess: z.boolean().optional() }), req.body);
    const policy = await getSettings(deps.db, 'refundPolicy');
    const revoke = b.revokeAccess ?? policy !== 'KEEP';
    // Step 1 (short transaction): claim the refund so a double click / second admin cannot send a second one.
    const p = await tx(deps.db, async c => {
      const row = await one(c, 'SELECT * FROM payments WHERE id=$1 FOR UPDATE', [id]);
      if (!row) throw notFound('Payment');
      if (row.status === 'REFUNDED') return { duplicate: true } as any;
      if (row.status !== 'SUCCESS' || !row.razorpay_payment_id) throw conflict('NOT_REFUNDABLE', `Only successful payments can be refunded (current: ${row.status}).`);
      if (row.refund_requested_at && deps.clock.now().getTime() - new Date(row.refund_requested_at).getTime() < 15 * 60_000)
        throw conflict('REFUND_IN_PROGRESS', 'A refund for this payment was requested in the last 15 minutes. Check the Razorpay dashboard; this page updates automatically when Razorpay confirms.');
      await exec(c, 'UPDATE payments SET refund_requested_at=$2 WHERE id=$1', [id, deps.clock.now()]);
      await audit(c, actorOf(req), 'REFUND_REQUESTED', 'Payment', id, 'SUCCESS', null, b.reason);
      return row;
    });
    if (p.duplicate) return { ok: true, duplicate: true };
    // Step 2: call Razorpay with no database lock held.
    let refund;
    try { refund = await deps.razorpay.refund(p.razorpay_payment_id, p.amount_paise - (p.refunded_paise ?? 0), { paymentId: p.id, reason: b.reason.slice(0, 200) }); }
    catch (e) {
      req.log.error({ err: e }, 'refund failed');
      throw new AppError(502, 'GATEWAY_UNCONFIRMED', 'Razorpay did not confirm the refund. It may or may not have gone through — check the Razorpay dashboard before trying again. If it went through, this payment updates automatically.');
    }
    // Step 3: record it (the refund.processed webhook settles it too if this step fails).
    return tx(deps.db, async c => {
      const row = await one(c, 'SELECT * FROM payments WHERE id=$1 FOR UPDATE', [id]);
      if (row.status === 'REFUNDED') return { ok: true, refundId: refund.id, accessRevoked: revoke };
      await applyRefund(deps, c, row, refund.id, b.reason, revoke, actorOf(req));
      return { ok: true, refundId: refund.id, accessRevoked: revoke };
    });
  });
}

async function handleWebhook(deps: Deps, c: Queryable, body: any): Promise<string> {
  const ev = String(body?.event ?? '');
  const pay: RzpPayment | undefined = body?.payload?.payment?.entity;
  if ((ev === 'payment.captured' || ev === 'order.paid') && pay) {
    const p = await one(c, 'SELECT id FROM payments WHERE razorpay_order_id=$1', [pay.order_id]);
    if (!p) return 'unknown_order';
    const r = await finalizePayment(deps, c, p.id, pay, 'WEBHOOK', WEBHOOK_ACTOR);
    return r.duplicate ? 'already_settled' : r.status === 'SUCCESS' ? 'activated' : r.mismatch ? 'mismatch' : 'ignored';
  }
  if (ev === 'payment.authorized' && pay) {
    // Orders are created with auto-capture; a separate payment.captured event follows. Record only.
    const n = await exec(c, "UPDATE payments SET status='PENDING', updated_at=$2 WHERE razorpay_order_id=$1 AND status='CREATED'", [pay.order_id, deps.clock.now()]);
    return n ? 'pending' : 'ignored';
  }
  if (ev === 'payment.failed' && pay) {
    const p = await one(c, 'SELECT id FROM payments WHERE razorpay_order_id=$1', [pay.order_id]);
    if (!p) return 'unknown_order';
    // A failed attempt does not close the order: the student may retry in the same Checkout. Mark PENDING→FAILED only
    // when nothing has succeeded; reconciliation will still upgrade it if a later attempt is captured.
    return (await markFailed(deps, c, p.id, 'FAILED', pay.error_description || 'Payment failed', WEBHOOK_ACTOR)) ? 'failed' : 'ignored';
  }
  if (ev === 'refund.processed') {
    const rf = body?.payload?.refund?.entity;
    const p = rf ? await one(c, 'SELECT * FROM payments WHERE razorpay_payment_id=$1 FOR UPDATE', [rf.payment_id]) : null;
    if (!p) return 'unknown_payment';
    if (p.status === 'REFUNDED') return 'already_refunded';
    if (p.status !== 'SUCCESS') return 'ignored';
    const total = (await one<{ refunded_paise: number }>(c, 'UPDATE payments SET refunded_paise = refunded_paise + $2 WHERE id=$1 RETURNING refunded_paise', [p.id, rf.amount]))!.refunded_paise;
    if (total < p.amount_paise) { await audit(c, WEBHOOK_ACTOR, 'PARTIAL_REFUND_RECORDED', 'Payment', p.id, null, `${total}/${p.amount_paise}`, 'Partial refund from the Razorpay dashboard — access unchanged'); return 'partial_refund'; }
    const policy = await getSettings(c, 'refundPolicy');
    await applyRefund(deps, c, p, rf.id, 'Refund issued from the Razorpay dashboard', policy !== 'KEEP', WEBHOOK_ACTOR);
    return 'refunded';
  }
  return 'ignored';
}

function orderResponse(deps: Deps, p: any) {
  return { paymentId: p.id, label: p.spec.label, amountPaise: p.amount_paise, currency: p.currency, breakdown: p.price_breakdown,
    checkout: { key: deps.cfg.RAZORPAY_KEY_ID, order_id: p.razorpay_order_id, amount: p.amount_paise, currency: p.currency, name: 'BPSC MockMaster', description: p.spec.label } };
}
async function statusResponse(deps: Deps, id: string) {
  const p = await one(deps.db, 'SELECT * FROM payments WHERE id=$1', [id]);
  const ents = p.status === 'SUCCESS' ? await many(deps.db, 'SELECT * FROM entitlements WHERE payment_id=$1', [id]) : [];
  const msg: Record<string, string> = {
    SUCCESS: 'Payment verified. Your plan is active.', PENDING: 'Payment received by the gateway — confirming with the bank. This usually takes under a minute; you do not need to pay again.',
    CREATED: 'Waiting for payment.', FAILED: 'Payment failed. If money was deducted, it will be returned by your bank.', EXPIRED: 'This checkout expired.', REFUNDED: 'This payment was refunded.', CANCELLED: 'Payment cancelled.',
  };
  return { paymentId: p.id, status: p.status, message: msg[p.status] ?? p.status, entitlements: ents.map(e => publicEntitlement(e, deps.clock.now())) };
}
export function publicEntitlement(e: any, now: Date) {
  const status = e.status === 'ACTIVE' && new Date(e.expires_at) <= now ? 'EXPIRED' : e.status;
  return { id: e.id, planType: e.plan_type, examType: e.exam_type, level: e.level, paper: e.paper, subjectId: e.subject_id, otherSubjectName: e.other_subject_name, treLanguage: e.tre_language,
    mode: e.mode, status, activatedAt: e.activated_at, expiresAt: e.expires_at, daysLeft: Math.max(0, Math.ceil((new Date(e.expires_at).getTime() - now.getTime()) / 86400_000)),
    questionLang: e.question_lang, explanationLang: e.explanation_lang };
}
void SYSTEM;
