/**
 * The two transactional e-mails behind account recovery: the password-reset link and the address-verification link.
 *
 * Everything about transport, templating, retries and the circuit breaker belongs to adapters/email; this module is
 * only the account-recovery flows' use of it. What it adds is one rule those flows cannot do without:
 *
 *   A SEND IS DISPATCHED, NEVER AWAITED.
 *
 * The port's own contract says delivery "MUST NOT be a precondition for the security action it accompanies" and
 * that "a failed send is never allowed to leak whether an address exists". Awaiting it would break both: a provider
 * call is a network round trip, so `POST /auth/forgot-password` would be measurably slower for an address that has
 * an account than for one that does not - a timing oracle, and enumeration safety is the one property that
 * endpoint must not lose. Composing the message happens inside the dispatched task too, so NOTHING about the mail
 * is on the request's critical path: the caller's latency is its database work and nothing else. A rejection
 * (ProviderRequestError / ProviderConfigError / CircuitOpenError) is caught and logged here, so it can neither
 * surface to the caller nor become an unhandled rejection.
 *
 * `settleOutbox()` exists because of that: tests need a point at which the dispatched sends have finished, and then
 * read the mock provider's own outbox (sentEmails / sentEmailsTo) rather than anything invented here.
 *
 * A token appears ONLY in `text` / `html`. `kind`, `subject` and `idempotencyKey` are derived from the action and
 * the token ROW id, never from the token itself, so every field that is logged is safe to log - and because each
 * re-issue mints a new row, each re-issue carries a NEW idempotency key, which matters: the provider (and the mock)
 * collapses a repeated key, so reusing one would silently swallow the second mail.
 */
import { getEmailSender, maskEmail, renderBasicEmail, type EmailMessage } from "../../adapters/email/index.js";
import { getConfig } from "../../config/env.js";
import { logger } from "../../shared/logger.js";

/** Base of every link in these messages. Validated at startup (absolute, https and not localhost in production). */
export function appBaseUrl(): string {
  return getConfig().appBaseUrl;
}

/** A link into the web app. The token is base64url, but it is URL-encoded anyway. */
export function appLink(path: string, token: string): string {
  return `${appBaseUrl()}${path}?token=${encodeURIComponent(token)}`;
}

/* ---- dispatch without awaiting ---- */

const inFlight = new Set<Promise<void>>();

type Envelope = Pick<EmailMessage, "to" | "subject" | "kind" | "idempotencyKey">;
type Body = Parameters<typeof renderBasicEmail>[0];

function dispatch(envelope: Envelope, body: Body): void {
  const task = (async () => {
    try {
      const rendered = renderBasicEmail(body);
      await getEmailSender().send({ ...envelope, text: rendered.text, html: rendered.html });
    } catch (err) {
      // The recipient is masked: a password-reset log line naming a full address is a privacy leak in an ops log,
      // and this is exactly the flow where that matters. Bodies and subjects are never logged at all.
      logger.error("recovery-mail: send failed (the account action still stands)", {
        kind: envelope.kind,
        to: maskEmail(envelope.to.email),
        idempotencyKey: envelope.idempotencyKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
  inFlight.add(task);
  void task.finally(() => inFlight.delete(task));
}

/**
 * TEST ONLY: waits for every dispatched send to settle, so delivery can be asserted through the mock provider's
 * outbox. Settles in rounds so a send that dispatched another cannot be missed.
 */
export async function settleOutbox(): Promise<void> {
  for (let i = 0; i < 5 && inFlight.size > 0; i++) await Promise.allSettled([...inFlight]);
}

/* ---- the two messages ---- */

const FOOTER = "You are receiving this because someone used this address on a Voice AI account.";

/** Returns immediately: composition and delivery happen afterwards. */
export function sendPasswordResetEmail(input: {
  to: string;
  name: string;
  token: string;
  /** The token ROW id. Safe to log, unique per re-issue, and never the token itself. */
  tokenId: string;
  ttlMinutes: number;
}): void {
  dispatch(
    {
      to: { email: input.to, name: input.name },
      subject: "Reset your Voice AI password",
      kind: "password-reset",
      idempotencyKey: `password-reset:${input.tokenId}`,
    },
    {
      heading: "Reset your password",
      paragraphs: [
        `Hello ${input.name},`,
        "Someone asked to reset the password for the Voice AI account registered to this address. Use the link below to choose a new one.",
        `The link works once and expires in ${input.ttlMinutes} minutes. If you did not ask for it you can ignore this e-mail - your password has not changed and nobody has been signed in.`,
        "Choosing a new password signs out every device that is currently signed in to your account.",
      ],
      cta: { label: "Choose a new password", url: appLink("/reset-password", input.token) },
      footer: FOOTER,
    },
  );
}

/** Returns immediately: composition and delivery happen afterwards. */
export function sendEmailVerificationEmail(input: {
  to: string;
  name: string;
  token: string;
  tokenId: string;
  ttlHours: number;
}): void {
  dispatch(
    {
      to: { email: input.to, name: input.name },
      subject: "Confirm your e-mail address",
      kind: "email-verification",
      idempotencyKey: `email-verification:${input.tokenId}`,
    },
    {
      heading: "Confirm your e-mail address",
      paragraphs: [
        `Hello ${input.name},`,
        "Confirm that this address belongs to you so we can use it to reach you about your Voice AI account - including if you ever need to reset your password.",
        `The link works once and expires in ${input.ttlHours} hours.`,
      ],
      cta: { label: "Confirm this address", url: appLink("/verify-email", input.token) },
      footer: FOOTER,
    },
  );
}
