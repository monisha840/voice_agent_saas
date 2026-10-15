/**
 * Provider-independent payment boundary. A real gateway (Razorpay, Cashfree, PayU, ...) is NOT integrated in this
 * milestone; the application depends only on this interface so one can be added without touching plans,
 * entitlements, metering or the state machine.
 *
 * Contract for an adapter:
 *   - `createCheckout` returns a hosted-checkout URL. The application never receives or stores card numbers, CVVs,
 *     UPI PINs or any payment credential - only provider references.
 *   - `verifyWebhook` receives the RAW request body and headers and MUST verify the provider's signature in constant
 *     time before returning anything. It returns a VerifiedPaymentEvent or throws. Nothing downstream accepts an
 *     unverified event: the event type below is only constructible by an adapter.
 *   - `organizationId` and `planKey` in an event come from metadata the application attached to the checkout and the
 *     provider signed; they are never taken from an unsigned payload.
 *
 * Handling (payment-events.service.ts) is idempotent on (provider, eventId) and applies at most one state change.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ValidationError } from "../../shared/errors.js";

export interface CheckoutInput {
  organizationId: string;
  planKey: string;
  amountPaise: number;
  currency: "INR";
  successUrl: string;
  cancelUrl: string;
}

export interface CheckoutSession {
  providerReference: string;
  checkoutUrl: string;
}

export type VerifiedPaymentEventType = "payment_succeeded" | "payment_failed" | "subscription_canceled";

export interface VerifiedPaymentEvent {
  provider: string;
  /** The provider's unique event id (the idempotency key). */
  eventId: string;
  type: VerifiedPaymentEventType;
  organizationId: string;
  planKey?: string;
  periodStart?: Date;
  periodEnd?: Date;
  amountPaise?: number;
  currency?: string;
  occurredAt: Date;
  /** SHA-256 of the raw body, stored for reconciliation (the body itself is not stored). */
  payloadDigest: string;
}

export interface PaymentProvider {
  readonly name: string;
  createCheckout(input: CheckoutInput): Promise<CheckoutSession>;
  verifyWebhook(rawBody: string, headers: Record<string, string | undefined>): VerifiedPaymentEvent;
}

export class WebhookVerificationError extends Error {
  constructor(message = "Webhook signature verification failed") {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

const mockEventSchema = z.object({
  id: z.string().min(1).max(255),
  type: z.enum(["payment_succeeded", "payment_failed", "subscription_canceled"]),
  organizationId: z.string().uuid(),
  planKey: z.string().min(1).max(40).optional(),
  periodStart: z.string().datetime().optional(),
  periodEnd: z.string().datetime().optional(),
  amountPaise: z.number().int().min(0).optional(),
  currency: z.string().length(3).optional(),
  occurredAt: z.string().datetime(),
});

/**
 * Test adapter: signs/verifies with HMAC-SHA256 over the raw body (header `x-mock-signature`, hex). It exists so the
 * verification and idempotency paths are exercised; it charges nothing and refuses to run in production.
 */
export function createMockPaymentProvider(secret: string): PaymentProvider & { sign(rawBody: string): string } {
  if (process.env.NODE_ENV === "production") throw new Error("The mock payment provider cannot be used in production");
  if (secret.length < 16) throw new Error("mock payment provider secret must be at least 16 characters");
  const sign = (rawBody: string) => createHmac("sha256", secret).update(rawBody).digest("hex");
  return {
    name: "mock",
    sign,
    async createCheckout(input) {
      return { providerReference: `mock_${input.organizationId.slice(0, 8)}_${input.planKey}`, checkoutUrl: "about:blank#mock-checkout" };
    },
    verifyWebhook(rawBody, headers) {
      const given = headers["x-mock-signature"] ?? "";
      const expected = sign(rawBody);
      const a = Buffer.from(given, "hex");
      const b = Buffer.from(expected, "hex");
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookVerificationError();
      let json: unknown;
      try {
        json = JSON.parse(rawBody);
      } catch {
        throw new WebhookVerificationError("Malformed webhook body");
      }
      const parsed = mockEventSchema.safeParse(json);
      if (!parsed.success) throw new WebhookVerificationError("Unrecognised webhook payload");
      const e = parsed.data;
      // Signature was valid, content is not: a validation error for the caller, not a verification failure or a 500.
      if (e.periodStart && e.periodEnd && new Date(e.periodEnd).getTime() <= new Date(e.periodStart).getTime()) {
        throw new ValidationError("periodEnd must be after periodStart");
      }
      return {
        provider: "mock",
        eventId: e.id,
        type: e.type,
        organizationId: e.organizationId,
        planKey: e.planKey,
        periodStart: e.periodStart ? new Date(e.periodStart) : undefined,
        periodEnd: e.periodEnd ? new Date(e.periodEnd) : undefined,
        amountPaise: e.amountPaise,
        currency: e.currency,
        occurredAt: new Date(e.occurredAt),
        payloadDigest: createHmac("sha256", "digest").update(rawBody).digest("hex"),
      };
    },
  };
}
