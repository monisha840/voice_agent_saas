/**
 * IEmailSender — the only transactional-email contract the application depends on.
 *
 * Provider-neutral by design, exactly like the AI and telephony ports: an adapter translates these types to and from
 * its own wire format and reports failures as ProviderRequestError / ProviderConfigError (shared/errors.ts). Selection
 * is explicit via EMAIL_PROVIDER ("mock" | ...), never silently switched at runtime, so the product runs end to end
 * with no credentials (the mock sender records what WOULD have been sent).
 *
 * Security rules that callers and adapters must both honour:
 *  - A credential (invite token, reset token, verification token) appears ONLY inside `text`/`html`. It must never be
 *    put in `kind`, `idempotencyKey`, `subject` or any field that is logged. Adapters must not log bodies.
 *  - Delivery is best-effort and MUST NOT be a precondition for the security action it accompanies. A failed send is
 *    never allowed to leak whether an address exists: callers answer the same way either way.
 */
import type { ProviderCallOptions } from "../ai/provider-common.js";

/** What a message is for. A stable key for logging, metrics and template choice — never a secret. */
export type EmailKind = "invite" | "password-reset" | "email-verification";

export interface EmailAddress {
  email: string;
  /** Display name. Optional: plain addresses are always acceptable. */
  name?: string;
}

export interface EmailMessage {
  to: EmailAddress;
  subject: string;
  /**
   * Plain-text body, REQUIRED and treated as the source of truth. A text-only email must always be usable on its own,
   * so no link or instruction may exist solely in `html`.
   */
  text: string;
  html?: string;
  replyTo?: EmailAddress;
  kind: EmailKind;
  /**
   * Stable key a provider may use to collapse duplicate sends (a retried request must not email twice).
   * Derived from the action, never from the token itself, and safe to log.
   */
  idempotencyKey?: string;
}

export interface SendResult {
  /** The provider's id for the message, when it gives one. Safe to log. */
  providerMessageId: string | null;
  /** True when the provider accepted the message for delivery. Acceptance is not proof of delivery. */
  accepted: boolean;
}

export interface IEmailSender {
  /** Adapter name for logs and metrics ("mock", "resend", ...). */
  readonly name: string;
  send(message: EmailMessage, opts?: ProviderCallOptions): Promise<SendResult>;
}
