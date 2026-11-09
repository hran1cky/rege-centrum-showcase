// Online card payment for permanentky via Stripe Checkout (cards, Apple Pay, Google Pay).
// Plain HTTPS calls to the Stripe API, no SDK. Prices always come from the server catalogue, never from the browser.
// Webhook events are trusted only with a valid Stripe-Signature (HMAC-SHA256 over "timestamp.body", 5-minute window).
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CheckoutInput { orderId: number; amountCents: number; name: string; email: string; successUrl: string; cancelUrl: string }
export interface StripeEvent { id: string; type: string; data: { object: { id: string; payment_status?: string; amount_total?: number; metadata?: Record<string, string> } } }
export interface Payments {
  configured: boolean;
  createCheckout(input: CheckoutInput): Promise<{ id: string; url: string }>;
  /** returns the parsed event, or null when the signature is missing, wrong or too old */
  verifyEvent(rawBody: Buffer, signature: string | undefined, nowSec?: number): StripeEvent | null;
}

export class PaymentError extends Error { status = 502; }

export function createPayments(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Payments {
  const key = env.STRIPE_SECRET_KEY?.trim() ?? '';
  const whSecret = env.STRIPE_WEBHOOK_SECRET?.trim() ?? '';
  return {
    configured: Boolean(key && whSecret),

    async createCheckout(i) {
      const form = new URLSearchParams({
        mode: 'payment',
        locale: 'sk',
        customer_email: i.email,
        client_reference_id: String(i.orderId),
        'metadata[order_id]': String(i.orderId),
        'payment_intent_data[metadata][order_id]': String(i.orderId),
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'eur',
        'line_items[0][price_data][unit_amount]': String(i.amountCents),
        'line_items[0][price_data][product_data][name]': i.name,
        success_url: i.successUrl,
        cancel_url: i.cancelUrl
      });
      const res = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `order-${i.orderId}` },
        body: form,
        signal: AbortSignal.timeout(15_000)
      });
      const body = await res.json().catch(() => ({})) as { id?: string; url?: string; error?: { message?: string } };
      if (!res.ok || !body.id || !body.url) {
        console.error('Stripe checkout zlyhal:', res.status, body.error?.message);
        throw new PaymentError('Platbu sa nepodarilo spustiť, skúste to prosím znova.');
      }
      return { id: body.id, url: body.url };
    },

    verifyEvent(rawBody, signature, nowSec = Math.floor(Date.now() / 1000)) {
      if (!whSecret || !signature) return null;
      const parts = signature.split(',').map(p => p.trim().split('=') as [string, string]);
      const t = Number(parts.find(([k]) => k === 't')?.[1]);
      const given = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
      if (!Number.isFinite(t) || !given.length || Math.abs(nowSec - t) > 300) return null;
      const expected = createHmac('sha256', whSecret).update(`${t}.`).update(rawBody).digest();
      const ok = given.some(v => { const b = Buffer.from(v, 'hex'); return b.length === expected.length && timingSafeEqual(b, expected); });
      if (!ok) return null;
      try { return JSON.parse(rawBody.toString('utf8')) as StripeEvent; } catch { return null; }
    }
  };
}
