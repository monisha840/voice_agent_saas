/**
 * The email transport layer's front door. Features import getEmailSender() and renderBasicEmail() from here and know
 * nothing about Resend, headers or retries — the same shape as adapters/ai/index.ts and adapters/telephony/index.ts.
 */
import { getConfig } from "../../config/env.js";
import { MockEmailSender } from "./mock.email.provider.js";
import { ReliableEmailSender } from "./reliable-email.js";
import { ResendEmailProvider } from "./resend.email.provider.js";
import type { IEmailSender } from "./email.interface.js";

export type { IEmailSender, EmailMessage, EmailKind, EmailAddress, SendResult } from "./email.interface.js";
export type { ProviderCallOptions } from "../ai/provider-common.js";
export { renderBasicEmail, escapeHtml } from "./template.js";
export { maskEmail } from "./address.js";
export { MockEmailSender, sentEmails, sentEmailsTo, lastSentEmail, clearSentEmails, type RecordedEmail } from "./mock.email.provider.js";
export { ResendEmailProvider, type ResendRequest, type ResendSendBody } from "./resend.email.provider.js";
export { ReliableEmailSender } from "./reliable-email.js";

let cached: IEmailSender | null = null;

/**
 * Returns the configured email sender. Selection is explicit via EMAIL_PROVIDER ("mock" | "resend") — never silently
 * switched at runtime, and the sender in use is fixed at process start, so a real message cannot escape from a
 * development environment.
 *
 * The sender is returned wrapped in the reliability layer (timeout, cancellation, circuit breaker, and retry of
 * transient failures only for messages that carry an idempotencyKey; see reliable-email.ts), so callers and future
 * adapters get it for free.
 */
export function getEmailSender(): IEmailSender {
  if (cached) return cached;
  const { email } = getConfig();
  // Explicit opt-in only. Never a fallback in either direction; a missing key fails here, loudly, not silently
  // (startup validation refuses EMAIL_PROVIDER=resend without its credentials in production, and a send attempted
  // without them throws ProviderConfigError rather than quietly dropping the message).
  cached = new ReliableEmailSender(email.provider === "resend" ? new ResendEmailProvider() : new MockEmailSender());
  return cached;
}

/** Test seam: install (or clear with null) the sender used by every feature. */
export function setEmailSender(sender: IEmailSender | null): void {
  cached = sender;
}
