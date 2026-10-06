import { hmacHex, safeEqual } from '../lib/crypto.js';

export interface RzpOrder { id: string; amount: number; currency: string; status: string; receipt?: string }
export interface RzpPayment { id: string; order_id: string; amount: number; currency: string; status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed'; error_description?: string | null }
export interface RzpRefund { id: string; payment_id: string; amount: number; status: string }

export interface RazorpayClient {
  createOrder(i: { amount: number; currency: string; receipt: string; notes: Record<string, string> }): Promise<RzpOrder>;
  fetchPayment(paymentId: string): Promise<RzpPayment>;
  fetchOrderPayments(orderId: string): Promise<RzpPayment[]>;
  capture(paymentId: string, amount: number, currency: string): Promise<RzpPayment>;
  refund(paymentId: string, amount: number, notes: Record<string, string>): Promise<RzpRefund>;
}

/** Checkout handler signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string, keySecret: string): boolean {
  return safeEqual(hmacHex(keySecret, `${orderId}|${paymentId}`), String(signature || ''));
}
/** Webhook signature: HMAC_SHA256(raw request body, webhook_secret) in X-Razorpay-Signature. */
export function verifyWebhookSignature(rawBody: Buffer | string, signature: string, webhookSecret: string): boolean {
  return safeEqual(hmacHex(webhookSecret, rawBody), String(signature || ''));
}

/** Razorpay REST v1 over HTTPS with basic auth. Server-side only. */
export class HttpRazorpayClient implements RazorpayClient {
  constructor(private keyId: string, private keySecret: string, private fetchImpl: typeof fetch = fetch, private base = 'https://api.razorpay.com/v1') {}
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15_000);
    try {
      const res = await this.fetchImpl(this.base + path, {
        method, signal: ctl.signal,
        headers: { authorization: 'Basic ' + Buffer.from(`${this.keyId}:${this.keySecret}`).toString('base64'), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json: any = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Razorpay ${method} ${path} failed: HTTP ${res.status} ${json?.error?.code ?? ''} ${json?.error?.description ?? ''}`.trim());
      return json as T;
    } finally { clearTimeout(t); }
  }
  createOrder(i: { amount: number; currency: string; receipt: string; notes: Record<string, string> }) { return this.call<RzpOrder>('POST', '/orders', { ...i, payment_capture: 1 }); }
  fetchPayment(id: string) { return this.call<RzpPayment>('GET', `/payments/${encodeURIComponent(id)}`); }
  async fetchOrderPayments(orderId: string) { return (await this.call<{ items: RzpPayment[] }>('GET', `/orders/${encodeURIComponent(orderId)}/payments`)).items ?? []; }
  capture(id: string, amount: number, currency: string) { return this.call<RzpPayment>('POST', `/payments/${encodeURIComponent(id)}/capture`, { amount, currency }); }
  refund(id: string, amount: number, notes: Record<string, string>) { return this.call<RzpRefund>('POST', `/payments/${encodeURIComponent(id)}/refund`, { amount, notes }); }
}
