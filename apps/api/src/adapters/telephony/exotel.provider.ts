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
  TelephonyStatusCallbackPayload,
} from "./telephony.interface.js";
import { getConfig } from "../../config/env.js";
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

  private assertConfigured() {
    const { exotel } = getConfig();
    const missing = (
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
