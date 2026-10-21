/**
 * Real Resend email adapter.
 *
 *   POST https://api.resend.com/emails
 *   Authorization: Bearer <RESEND_API_KEY>
 *   Content-Type: application/json
 *   Idempotency-Key: <message.idempotencyKey>        (sent only when the caller provided one)
 *   { from, to: ["Name <a@b>"], subject, text, html?, reply_to? }  ->  200 { "id": "..." }
 *
 * Reference: https://resend.com/docs/api-reference/emails/send-email
 *
 * Chosen because it needs nothing but `fetch`: one JSON POST, a bearer token, an idempotency header and an id in the
 * response. No SDK, no signing, no SMTP library — so it matches how this repo already talks to Sarvam and Exotel, and
 * adds no dependency.
 *
 * This file contains ALL Resend-specific request/response shapes. Nothing outside `adapters/email/` may import them.
 * Timeouts, retries and the circuit breaker are applied around it by the factory (adapters/email/index.ts).
 */
import { getConfig } from "../../config/env.js";
import { badResponse, httpFailure, transportFailure } from "../ai/provider-errors.js";
import { ProviderConfigError, ProviderRequestError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import { formatAddress, isEmailAddress, maskEmail } from "./address.js";
import type { EmailAddress, EmailMessage, IEmailSender, SendResult } from "./email.interface.js";
import type { ProviderCallOptions } from "../ai/provider-common.js";

const RESEND_URL = "https://api.resend.com/emails";
const PROVIDER = "resend";
const OPERATION = "email.send";
/** Backstop only, for use without the reliability wrapper; the wrapper passes its own (shorter) signal. */
const FALLBACK_TIMEOUT_MS = 20_000;
/** A header value, so it is kept to characters that cannot restructure the request. Resend allows up to 256. */
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,256}$/;
/** EMAIL_FROM / EMAIL_REPLY_TO may be a bare address or `Name <address>`; the address part is what gets checked. */
const CONFIGURED_ADDRESS = /^(?:(?<name>[^<>@\r\n,;:"]*)<(?<bracketed>[^\s<>,;:"]+)>|(?<bare>[^\s<>,;:"]+))$/;

/** Exactly what goes on the wire. */
export interface ResendSendBody {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  reply_to?: string;
}

export interface ResendRequest {
  url: string;
  headers: Record<string, string>;
  body: ResendSendBody;
}

function invalid(what: string): ProviderRequestError {
  return new ProviderRequestError(PROVIDER, `${PROVIDER} ${OPERATION} was not attempted: ${what}`, undefined, {
    category: "invalid_request",
    operation: OPERATION,
  });
}

/** A configured address is a deployment setting, so a malformed one is a configuration error, not a request error. */
function configuredAddress(raw: string, varName: string): string {
  const m = CONFIGURED_ADDRESS.exec(raw);
  const address = m?.groups?.bracketed ?? m?.groups?.bare;
  if (!address || !isEmailAddress(address)) {
    throw new ProviderConfigError(PROVIDER, `${varName} is not a usable address: expected "name@example.com" or "Name <name@example.com>"`);
  }
  const name = (m?.groups?.name ?? "").trim();
  return name ? formatAddress({ email: address, name }) : address;
}

/** A recipient comes from user data, so a malformed one is a permanent request error and is never retried. */
function recipient(addr: EmailAddress, what: string): string {
  const email = addr.email.trim();
  if (!isEmailAddress(email)) throw invalid(`the ${what} address is not a valid email address`);
  return formatAddress({ email, name: addr.name });
}

export class ResendEmailProvider implements IEmailSender {
  readonly name = PROVIDER;

  private assertConfigured() {
    const { email } = getConfig();
    const missing = (
      [
        ["RESEND_API_KEY", email.resendApiKey],
        ["EMAIL_FROM", email.from],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missing.length > 0) {
      throw new ProviderConfigError(
        PROVIDER,
        `Resend is not configured. Missing: ${missing.join(", ")}. Set EMAIL_PROVIDER=mock to develop/demo without an email provider.`,
      );
    }
    return email;
  }

  /**
   * Builds the exact request. Pure (no I/O) so tests can assert the shape — and the absence of anything secret in the
   * header set — without credentials or network.
   */
  buildRequest(message: EmailMessage): ResendRequest {
    const email = this.assertConfigured();
    if (!message.text.trim()) throw invalid("the plain-text body is empty, and text is the message");
    if (!message.subject.trim()) throw invalid("the subject is empty");

    const headers: Record<string, string> = {
      Authorization: `Bearer ${email.resendApiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (message.idempotencyKey !== undefined) {
      if (!IDEMPOTENCY_KEY.test(message.idempotencyKey)) {
        throw invalid("the idempotency key is not a plain token of letters, digits, '.', '_', ':' or '-' (max 256)");
      }
      // Resend collapses a repeat of this key instead of sending twice; without it a retry would mail twice, which is
      // why the reliability wrapper refuses to retry a message that has no key.
      headers["Idempotency-Key"] = message.idempotencyKey;
    }

    const replyTo = message.replyTo ? recipient(message.replyTo, "reply-to") : email.replyTo ? configuredAddress(email.replyTo, "EMAIL_REPLY_TO") : "";
    const body: ResendSendBody = {
      from: configuredAddress(email.from, "EMAIL_FROM"),
      to: [recipient(message.to, "recipient")],
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
    };
    return { url: RESEND_URL, headers, body };
  }

  async send(message: EmailMessage, opts?: ProviderCallOptions): Promise<SendResult> {
    const { url, headers, body } = this.buildRequest(message);

    logger.info("email.send: requesting", {
      provider: PROVIDER,
      kind: message.kind,
      to: maskEmail(message.to.email),
      idempotencyKey: message.idempotencyKey,
      hasHtml: Boolean(message.html),
      callId: opts?.callId,
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: opts?.signal ?? AbortSignal.timeout(FALLBACK_TIMEOUT_MS),
      });
    } catch (err) {
      throw transportFailure(PROVIDER, OPERATION, err);
    }

    if (!response.ok) throw httpFailure(PROVIDER, OPERATION, response);

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw badResponse(PROVIDER, OPERATION, "not JSON", err);
    }

    const id = extractMessageId(json);
    if (!id) throw badResponse(PROVIDER, OPERATION, "no message id");
    return { providerMessageId: id, accepted: true };
  }
}

/** Resend answers `{ id }`; tolerate a `{ data: { id } }` envelope rather than fail a delivered message. */
function extractMessageId(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.id === "string" && obj.id) return obj.id;
  const data = obj.data as Record<string, unknown> | undefined;
  if (data && typeof data.id === "string" && data.id) return data.id;
  return null;
}
