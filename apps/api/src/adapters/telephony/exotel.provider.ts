/**
 * Real Exotel telephony adapter.
 *
 * Places an outbound call with Exotel's "Connect Voice AI" API (or, when EXOTEL_FLOW_APP_ID is set, into an App
 * Bazaar flow with a Voicebot applet; see buildConnectRequest):
 *   POST https://{api_key}:{api_token}@{subdomain}/v1/Accounts/{account_sid}/Calls/connect
 *   (Basic auth sent as a header; subdomain is api.in.exotel.com for the
 *   India region or api.exotel.com for Singapore — shown on the dashboard's
 *   API Settings page and configured via EXOTEL_SUBDOMAIN)
 *   Content-Type: application/x-www-form-urlencoded
 *
 *   From       = the CUSTOMER's number (the party Exotel dials)
 *   CallerId   = our ExoPhone (shown to the customer)
 *   StreamUrl  = our wss:// AgentStream endpoint (Exotel is the WS client)
 *   StreamType = bidirectional (full duplex audio on one connection)
 *
 * References:
 *   https://exotel.com/build/one-api-call-your-ai-bot-is-on-the-phone/
 *   https://developer.exotel.com/docs/agentstream/getting-started
 *   https://developer.exotel.com/docs/agentstream/websocket-protocol
 *
 * Requires Voice Streaming to be enabled on the Exotel account (Exotel
 * support enables it; it is excluded from the self-serve plans).
 *
 * This file contains ALL Exotel-specific request/response shapes.
 * Nothing outside `adapters/telephony/` may import them.
 */
import type {
  ITelephonyProvider,
  InitiateCallParams,
  InitiateCallResult,
  ParsedStatusCallback,
  ProviderNumberCheck,
  ProviderSetupStatus,
  TelephonyStatusCallbackPayload,
} from "./telephony.interface.js";
import { getConfig } from "../../config/env.js";
import { normalizeDialedNumber } from "../../shared/phone.js";
import { issueStreamToken } from "../../security/stream-token.js";
import { ProviderConfigError, ProviderRequestError } from "../../shared/errors.js";
import { logger, redact } from "../../shared/logger.js";

/** Exotel's call status strings, mapped to our normalized set. */
const EXOTEL_STATUS_MAP: Record<string, ParsedStatusCallback["status"]> = {
  queued: "ringing",
  ringing: "ringing",
  "in-progress": "in_progress",
  completed: "completed",
  busy: "busy",
  "no-answer": "no_answer",
  failed: "failed",
  canceled: "failed",
};

export class ExotelProvider implements ITelephonyProvider {
  readonly name = "exotel";

  private missingSettings(): string[] {
    const { exotel } = getConfig();
    return (
      [
        ["EXOTEL_API_KEY", exotel.apiKey],
        ["EXOTEL_API_TOKEN", exotel.apiToken],
        ["EXOTEL_ACCOUNT_SID", exotel.accountSid],
        ["EXOTEL_SUBDOMAIN", exotel.subdomain],
        ["EXOTEL_FROM_NUMBER", exotel.fromNumber],
        ["EXOTEL_WEBHOOK_BASE_URL", exotel.webhookBaseUrl],
        ["EXOTEL_AGENTSTREAM_WEBHOOK_SECRET", exotel.agentStreamWebhookSecret],
      ] as const
    )
      .filter(([, value]) => !value)
      .map(([key]) => key);
  }

  private assertConfigured() {
    const { exotel } = getConfig();
    const missing = this.missingSettings();
    if (missing.length > 0) {
      throw new ProviderConfigError(
        "exotel",
        `Exotel credentials not configured. Missing: ${missing.join(", ")}. ` +
          `Set TELEPHONY_PROVIDER=mock to develop/demo without real Exotel credentials.`,
      );
    }
    if (!/^https:\/\//i.test(exotel.webhookBaseUrl)) {
      throw new ProviderConfigError(
        "exotel",
        "EXOTEL_WEBHOOK_BASE_URL must start with https:// — Exotel connects to a wss:// StreamUrl derived from it.",
      );
    }
    return exotel;
  }

  /**
   * Builds the exact form body for Calls/connect. Pure (no I/O) so tests
   * can assert the request shape without credentials or network.
   */
  buildConnectRequest(params: InitiateCallParams, streamToken?: string): URLSearchParams {
    const exotel = this.assertConfigured();
    const base = exotel.webhookBaseUrl.replace(/\/+$/, "");
    const qs = new URLSearchParams({
      internalCallId: params.internalCallId,
      token: exotel.agentStreamWebhookSecret,
    }).toString();

    const body = new URLSearchParams({
      From: params.toNumber,
      CallerId: exotel.fromNumber,
      StatusCallback: `${base}/api/telephony/exotel/status-callback?${qs}`,
      StatusCallbackContentType: "application/json",
    });
    if (exotel.flowAppId) {
      // Flow mode: the customer is connected to an App Bazaar flow (Greeting -> Voicebot applet). The Voicebot applet
      // holds our wss:// URL, so none is sent here; the media stream finds this call by Exotel's call_sid.
      body.set("Url", `${exotel.flowUrlBase}/${exotel.accountSid}/exoml/start_voice/${exotel.flowAppId}`);
    } else {
      // The media stream is authenticated by a per-call, short-lived signed token (security/stream-token.ts) that
      // names this call and organization. The shared webhook secret stays on the status-callback URL above (that is
      // webhook authentication, a separate mechanism); it is repeated here only while STREAM_ALLOW_STATIC_SECRET is
      // on, as a compatibility fallback for a peer that drops the token. Set it to false to make the token mandatory.
      if (!streamToken) throw new ProviderConfigError("exotel", "A stream token is required to build a StreamUrl");
      const streamQs = new URLSearchParams({ st: streamToken });
      if (getConfig().stream.allowStaticSecret) streamQs.set("token", exotel.agentStreamWebhookSecret);
      body.set("StreamUrl", `${base.replace(/^https/i, "wss")}/api/telephony/exotel/media-stream?${streamQs.toString()}`);
      body.set("StreamType", "bidirectional");
    }
    body.append("StatusCallbackEvents[0]", "terminal");
    body.append("StatusCallbackEvents[1]", "answered");
    if (exotel.callType) body.set("CallType", exotel.callType);
    return body;
  }

  async initiateCall(params: InitiateCallParams): Promise<InitiateCallResult> {
    const exotel = this.assertConfigured();
    let streamToken: string | undefined;
    if (!exotel.flowAppId) {
      if (!params.organizationId) throw new ProviderConfigError("exotel", "organizationId is required to issue a stream token");
      streamToken = (await issueStreamToken({ callId: params.internalCallId, organizationId: params.organizationId, provider: "exotel" })).token;
    }
    const body = this.buildConnectRequest(params, streamToken);
    const url = `https://${exotel.subdomain}/v1/Accounts/${exotel.accountSid}/Calls/connect.json`;
    const auth = Buffer.from(`${exotel.apiKey}:${exotel.apiToken}`).toString("base64");

    logger.info("exotel.initiateCall: requesting", {
      toNumber: redact(params.toNumber),
      internalCallId: params.internalCallId,
      apiKey: redact(exotel.apiKey),
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new ProviderRequestError("exotel", "Network error calling Exotel Calls/connect API", err);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new ProviderRequestError(
        "exotel",
        `Exotel rejected call request (HTTP ${response.status}): ${text.slice(0, 500)}`,
      );
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch (err) {
      throw new ProviderRequestError("exotel", "Exotel returned a malformed (non-JSON) response", err);
    }

    const callSid = extractCallSid(json);
    if (!callSid) {
      throw new ProviderRequestError(
        "exotel",
        "Exotel response did not contain a recognizable Call Sid",
      );
    }
    return { providerCallId: callSid, status: "initiating" };
  }

  describeSetup(): ProviderSetupStatus {
    const { exotel } = getConfig();
    const missing = this.missingSettings();
    const problems: string[] = [];
    if (exotel.webhookBaseUrl && !/^https:\/\//i.test(exotel.webhookBaseUrl)) {
      problems.push("The public webhook address must use https:// (Exotel connects to a wss:// address derived from it).");
    }
    return {
      provider: this.name,
      simulated: false,
      configured: missing.length === 0 && problems.length === 0,
      missing,
      problems,
      numberCheckSupported: true,
    };
  }

  /**
   * Looks the number up in the account's ExoPhone list (documented ExoPhones API, v2_beta):
   *   GET https://{subdomain}/v2_beta/Accounts/{account_sid}/IncomingPhoneNumbers  -> { incoming_phone_numbers: [...] }
   * https://developer.exotel.com/docs/exophones/api-reference/list-numbers
   * Read-only. Only the matching entry's capability and destination flags are reported back: the list holds every
   * number of the platform's Exotel account (other organizations' numbers too) and is never returned or logged.
   * The page/page_size fields are documented but not how to request further pages, so only the first page is read and
   * a miss on a full page is reported as inconclusive.
   */
  async checkNumber(phoneNumber: string): Promise<ProviderNumberCheck> {
    const { exotel } = getConfig();
    const missing = (
      [
        ["EXOTEL_API_KEY", exotel.apiKey],
        ["EXOTEL_API_TOKEN", exotel.apiToken],
        ["EXOTEL_ACCOUNT_SID", exotel.accountSid],
        ["EXOTEL_SUBDOMAIN", exotel.subdomain],
      ] as const
    ).filter(([, v]) => !v);
    if (missing.length > 0) {
      return { status: "error", detail: "The platform's Exotel API credentials are not configured. Contact support.", retryable: false };
    }
    const url = `https://${exotel.subdomain}/v2_beta/Accounts/${encodeURIComponent(exotel.accountSid)}/IncomingPhoneNumbers`;
    const auth = Buffer.from(`${exotel.apiKey}:${exotel.apiToken}`).toString("base64");
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Basic ${auth}`, Accept: "application/json" },
        signal: AbortSignal.timeout(NUMBER_CHECK_TIMEOUT_MS),
      });
    } catch (err) {
      const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      logger.warn("exotel.checkNumber: request failed", { timedOut });
      return {
        status: "error",
        detail: timedOut ? "Exotel did not answer within 10 seconds. Try again shortly." : "Exotel could not be reached. Try again shortly.",
        retryable: true,
      };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      logger.warn("exotel.checkNumber: provider refused", { status: response.status });
      if (response.status === 401 || response.status === 403) {
        return { status: "error", detail: `Exotel refused the platform's API credentials (HTTP ${response.status}). Contact support.`, retryable: false };
      }
      if (response.status === 429) return { status: "error", detail: "Exotel is rate-limiting requests. Try again in a minute.", retryable: true };
      if (response.status >= 500) return { status: "error", detail: `Exotel had an internal error (HTTP ${response.status}). Try again shortly.`, retryable: true };
      return { status: "error", detail: `Exotel rejected the number lookup (HTTP ${response.status}). Contact support.`, retryable: false };
    }
    let entries: Array<Record<string, unknown>>;
    let pageSize: number | null = null;
    try {
      const json = (await response.json()) as Record<string, unknown>;
      const list = json.incoming_phone_numbers;
      if (!Array.isArray(list)) throw new Error("no incoming_phone_numbers array");
      entries = list.filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null);
      pageSize = typeof json.page_size === "number" ? json.page_size : null;
    } catch {
      return { status: "error", detail: "Exotel returned a response this version does not understand. Contact support.", retryable: false };
    }
    const match = entries.find((e) => sameNumber(e.phone_number, phoneNumber) || sameNumber(e.friendly_name, phoneNumber));
    if (!match) {
      const fullPage = pageSize !== null && entries.length >= pageSize;
      return {
        status: "not_found",
        detail: fullPage
          ? `Not found in the first ${entries.length} numbers of the Exotel account (the list continues on further pages, which this check cannot read). Contact support to confirm.`
          : "This number is not on the platform's Exotel account. Calls to it cannot reach your agent until support adds it.",
        retryable: false,
      };
    }
    const capabilities = (match.capabilities ?? {}) as Record<string, unknown>;
    const voiceCapable = capabilities.voice !== false;
    const voiceDestinationSet = typeof match.voice_url === "string" && match.voice_url.length > 0;
    return {
      status: "verified",
      detail: !voiceCapable
        ? "The number is on the Exotel account but is not enabled for voice."
        : voiceDestinationSet
          ? "The number is on the Exotel account and has an incoming-call flow set."
          : "The number is on the Exotel account but no incoming-call flow is set, so calls will not reach your agent. Contact support.",
      voiceCapable,
      voiceDestinationSet,
    };
  }

  /**
   * Parses Exotel's StatusCallback (form-encoded or JSON). With
   * StatusCallbackEvents the payload carries an `EventType`
   * (terminal / answered / ringing); without it only terminal callbacks
   * with `Status` (completed | failed | busy | no-answer) are sent.
   */
  parseStatusCallback(payload: TelephonyStatusCallbackPayload): ParsedStatusCallback {
    const callSid = String(payload.CallSid ?? payload.Sid ?? "");
    if (!callSid) {
      throw new ProviderRequestError("exotel", "Status callback payload missing CallSid");
    }
    const eventType = String(payload.EventType ?? "").toLowerCase();
    const rawStatus = String(payload.Status ?? payload.CallStatus ?? "").toLowerCase();

    let status: ParsedStatusCallback["status"];
    if (eventType.includes("answer")) {
      status = "in_progress";
    } else if (eventType.includes("ring")) {
      status = "ringing";
    } else {
      const mapped = EXOTEL_STATUS_MAP[rawStatus];
      if (!mapped) {
        // Never fail a live call over a status string we do not understand.
        throw new ProviderRequestError("exotel", `Unrecognized Exotel call status "${rawStatus}"`);
      }
      status = mapped;
    }

    const duration = payload.ConversationDuration ?? payload.Duration;
    const durationSeconds = duration !== undefined && duration !== "" ? Number(duration) : undefined;
    const recordingUrl = payload.RecordingUrl ? String(payload.RecordingUrl) : undefined;
    return { providerCallId: callSid, status, durationSeconds, recordingUrl };
  }
}

const NUMBER_CHECK_TIMEOUT_MS = 10_000;

/** Exotel lists numbers in E.164 (`phone_number`) and national form (`friendly_name`); compare normalized. */
function sameNumber(value: unknown, e164: string): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return normalizeDialedNumber(value) === e164;
  } catch {
    return false;
  }
}

/** Exotel's JSON response nests the call under Call.Sid (or call.sid); be lenient about exact shape. */
function extractCallSid(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  const call = (obj.Call ?? obj.call) as Record<string, unknown> | undefined;
  if (call && typeof call.Sid === "string") return call.Sid;
  if (call && typeof call.sid === "string") return call.sid;
  if (typeof obj.Sid === "string") return obj.Sid;
  return null;
}
