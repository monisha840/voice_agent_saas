/**
 * The invitation email: the ONE place an invite token is turned into a link and handed to the email port.
 *
 * Security rules this file exists to concentrate:
 *  - The raw token appears only in the rendered `text`/`html` body and in the URL inside it. It is never logged,
 *    never audited, never put in `subject`, `kind` or `idempotencyKey` (that key is derived from the invitation row
 *    id, which is not a credential).
 *  - Delivery is best-effort: `sendInviteEmail` NEVER throws. The invitation row already exists (and the seat-cap
 *    triggers have already run) by the time it is called, so a provider outage must not undo it. The caller gets a
 *    status back and decides what to record.
 *  - A failure cannot leak whether an address exists: the status describes the PROVIDER, never the recipient, and
 *    the only endpoints that see it are authenticated ones that already know the address.
 */
import { getEmailSender, maskEmail, renderBasicEmail } from "../../adapters/email/index.js";
import type { OrgRole } from "../../auth/context.js";
import { getConfig } from "../../config/env.js";
import { logger } from "../../shared/logger.js";

/**
 * What happened to the invitation email. Safe to log, to audit and to return to an authenticated operator.
 *  - "sent"            a real provider accepted the message for delivery (acceptance is not proof of delivery).
 *  - "failed"          the provider refused it or the call threw. The invitation still exists; resend it.
 *  - "not-configured"  EMAIL_PROVIDER is the mock, so nothing actually left the server. The link is returned to the
 *                      caller in this case ONLY, because there is no other way for the invitee to receive it.
 */
export type InviteDelivery = "sent" | "failed" | "not-configured";

/** Reads as "... to join Acme as an administrator". */
const ROLE_LABEL: Record<OrgRole, string> = {
  OWNER: "an owner",
  ADMIN: "an administrator",
  MANAGER: "a manager",
  AGENT: "an agent",
};

/** The absolute link the invitee clicks. The token is the credential, so this string is treated as one. */
export function inviteUrl(token: string): string {
  const base = getConfig().appBaseUrl.replace(/\/+$/, "");
  return `${base}/accept-invite?token=${encodeURIComponent(token)}`;
}

/** UTC, minute precision - an email is read in an unknown timezone, so the zone is spelled out. */
function expiryWording(expiresAt: Date): string {
  const iso = expiresAt.toISOString();
  return `${iso.slice(0, 10)} at ${iso.slice(11, 16)} UTC`;
}

export interface InviteEmailInput {
  /** The invitation row id - used as the idempotency key, so a retried request cannot email twice. */
  invitationId: string;
  email: string;
  role: OrgRole;
  expiresAt: Date;
  organizationName: string;
  /** Display name of the person who invited them; null for a system flow. */
  invitedByName: string | null;
  /** The raw token. NEVER logged, audited or returned from this module. */
  token: string;
}

/**
 * Sends the invitation. Resolves to a status and never rejects - the invitation exists either way.
 */
export async function sendInviteEmail(input: InviteEmailInput): Promise<InviteDelivery> {
  const sender = getEmailSender();
  const inviter = input.invitedByName?.trim() || "An administrator";
  const expires = expiryWording(input.expiresAt);
  const { text, html } = renderBasicEmail({
    heading: `Join ${input.organizationName}`,
    paragraphs: [
      `${inviter} invited you to join ${input.organizationName} as ${ROLE_LABEL[input.role]}.`,
      `Use the link below to set your name and password. It works once and expires on ${expires}.`,
      `If you were not expecting this invitation, ignore this email - nothing happens until the link is used.`,
    ],
    cta: { label: "Accept the invitation", url: inviteUrl(input.token) },
    footer: "You are receiving this because someone invited this address to an organization on the Voice AI console.",
  });

  try {
    const result = await sender.send({
      to: { email: input.email },
      subject: `You have been invited to join ${input.organizationName}`,
      text,
      html,
      kind: "invite",
      /*
       * Derived from the invitation row, never from the token: safe for a provider to log, and it is what makes a
       * retried request deliver once. It must also be NEW for every message: both the Resend adapter and the mock
       * collapse a repeated key, so a resend that reused it would silently mail nothing. Resending issues a new
       * invitation row (users.service.ts), so a new id - and therefore a new key - comes with it.
       */
      idempotencyKey: `invite:${input.invitationId}`,
    });
    if (!result.accepted) {
      logger.warn("invite email: provider did not accept the message", {
        invitationId: input.invitationId,
        provider: sender.name,
        to: maskEmail(input.email),
      });
      return "failed";
    }
    // The mock records what WOULD have been sent; saying "sent" would tell an operator a lie.
    return sender.name === "mock" ? "not-configured" : "sent";
  } catch (err) {
    /*
     * ProviderRequestError, ProviderConfigError and CircuitOpenError are the expected failures (the breaker fails
     * fast while a provider is down). Anything else is caught too, deliberately: the invitation row and the seat it
     * holds are already committed, so no error from the transport may propagate and look like a failed invite.
     * Logged with no URL, no token and no body - the row id, the adapter, a masked recipient and the message.
     */
    logger.error("invite email: send failed", {
      invitationId: input.invitationId,
      provider: sender.name,
      to: maskEmail(input.email),
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
}
