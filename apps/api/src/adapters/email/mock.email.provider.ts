/**
 * Mock email sender — the default (EMAIL_PROVIDER=mock), and the reason the product is fully exercisable with no
 * credentials: an invite, a password reset or a verification can be issued, and the link that would have been mailed
 * can be read back, without an email account existing anywhere.
 *
 * It never claims a real delivery. Every message is kept in memory (the outbox below) and announced with ONE
 * structured log line that carries the kind, a masked recipient and the sizes — never the subject, the body or the
 * token inside it, exactly as the contract requires of a real adapter.
 *
 * Tests read the outbox with sentEmails() / lastSentEmail() and reset it with clearSentEmails(). The outbox is
 * process-wide on purpose: routes use the cached sender from getEmailSender(), so a test must not need to get hold of
 * that instance to assert on what it sent.
 */
import { logger } from "../../shared/logger.js";
import { maskEmail } from "./address.js";
import type { EmailMessage, IEmailSender, SendResult } from "./email.interface.js";
import type { ProviderCallOptions } from "../ai/provider-common.js";

export interface RecordedEmail {
  /** Exactly what the caller handed to send(), bodies included: this is the development inbox. */
  message: EmailMessage;
  providerMessageId: string;
  at: Date;
}

/** Bounded: a dev server runs for days, and an unbounded outbox would hold every token ever issued. */
const MAX_RECORDED = 200;

const outbox: RecordedEmail[] = [];
/** idempotencyKey -> the id the first send got, so a repeat collapses the way a real provider's would. */
const byIdempotencyKey = new Map<string, string>();
let counter = 0;

/** Every message recorded by the mock sender, oldest first. */
export function sentEmails(): readonly RecordedEmail[] {
  return [...outbox];
}

/** The most recent message, or undefined when nothing has been sent. */
export function lastSentEmail(): RecordedEmail | undefined {
  return outbox[outbox.length - 1];
}

/** Messages recorded for one recipient (address compared case-insensitively), oldest first. */
export function sentEmailsTo(email: string): RecordedEmail[] {
  const wanted = email.trim().toLowerCase();
  return outbox.filter((r) => r.message.to.email.trim().toLowerCase() === wanted);
}

/** Empties the outbox (and the idempotency memory). Tests should call this before the action they assert on. */
export function clearSentEmails(): void {
  outbox.length = 0;
  byIdempotencyKey.clear();
}

export class MockEmailSender implements IEmailSender {
  readonly name = "mock";

  async send(message: EmailMessage, opts?: ProviderCallOptions): Promise<SendResult> {
    const existing = message.idempotencyKey ? byIdempotencyKey.get(message.idempotencyKey) : undefined;
    if (existing) {
      // A real provider collapses a repeat of the same key instead of mailing twice; so does this one, so that
      // behaviour is exercisable locally.
      logger.info("email.send collapsed as a duplicate by the mock provider (nothing was delivered)", {
        provider: this.name,
        kind: message.kind,
        to: maskEmail(message.to.email),
        idempotencyKey: message.idempotencyKey,
        providerMessageId: existing,
        callId: opts?.callId,
      });
      return { providerMessageId: existing, accepted: true };
    }

    const providerMessageId = `mock-email-${++counter}`;
    outbox.push({ message, providerMessageId, at: new Date() });
    if (outbox.length > MAX_RECORDED) outbox.splice(0, outbox.length - MAX_RECORDED);
    if (message.idempotencyKey) byIdempotencyKey.set(message.idempotencyKey, providerMessageId);

    logger.info("email.send recorded by the mock provider (nothing was delivered)", {
      provider: this.name,
      kind: message.kind,
      to: maskEmail(message.to.email),
      // Sizes only. The subject can name the organization and the body carries the token.
      subjectChars: message.subject.length,
      textChars: message.text.length,
      htmlChars: message.html?.length ?? 0,
      idempotencyKey: message.idempotencyKey,
      providerMessageId,
      callId: opts?.callId,
    });
    return { providerMessageId, accepted: true };
  }
}
