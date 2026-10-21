/**
 * Decorator that puts the shared reliability layer (adapters/ai/reliability.ts: per-attempt timeout, cancellation,
 * bounded retry of transient failures, circuit breaker) around ANY email sender, the same way reliable-providers.ts
 * does for STT / LLM / TTS. The factory (index.ts) applies it, so no feature and no future adapter re-implements it.
 *
 * The one email-specific rule — and the reason this is not just reused verbatim:
 *
 *   A send is retried ONLY when the message carries an idempotencyKey.
 *
 * A transactional email is worth retrying (a 500 or a dropped connection must not cost someone their password reset),
 * but a retry is not free: a request that failed after the provider accepted it would be delivered twice, and the
 * second copy of a reset link is both confusing and a wider window for the token. With an idempotencyKey the provider
 * collapses the repeat; without one, one attempt is all that is safe. Everything else still applies to every send:
 * the timeout bounds it, cancellation stops it, and the breaker fails fast while the provider is down instead of
 * holding up the request that triggered it (delivery is best-effort and must never block the security action).
 */
import { getConfig } from "../../config/env.js";
import { getCircuitBreaker, InMemoryCircuitBreaker } from "../ai/circuit-breaker.js";
import { callWithReliability } from "../ai/reliability.js";
import type { EmailMessage, IEmailSender, SendResult } from "./email.interface.js";
import type { ProviderCallOptions } from "../ai/provider-common.js";

const OPERATION = "email.send";

export class ReliableEmailSender implements IEmailSender {
  constructor(private readonly inner: IEmailSender) {}

  get name(): string {
    return this.inner.name;
  }

  send(message: EmailMessage, opts?: ProviderCallOptions): Promise<SendResult> {
    const { email, providers } = getConfig();
    const provider = this.inner.name;
    // Named apart from the AI providers' breakers: an email outage must not open a circuit on a voice provider that
    // happens to share a name, or the other way round.
    const breakerName = `email:${provider}`;
    return callWithReliability(
      {
        provider,
        operation: OPERATION,
        timeoutMs: email.timeoutMs,
        totalBudgetMs: Math.max(email.timeoutMs, providers.totalBudgetMs),
        retry: {
          maxAttempts: message.idempotencyKey ? providers.maxAttempts : 1,
          baseDelayMs: providers.retryBaseDelayMs,
          maxDelayMs: providers.retryMaxDelayMs,
        },
        breaker: getCircuitBreaker(
          breakerName,
          () => new InMemoryCircuitBreaker(breakerName, { failureThreshold: providers.breakerFailureThreshold, cooldownMs: providers.breakerCooldownMs }),
        ),
        signal: opts?.signal,
        callId: opts?.callId,
      },
      (signal) => this.inner.send(message, { ...opts, signal }),
    );
  }
}
