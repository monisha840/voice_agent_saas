/**
 * Real Exotel telephony adapter.
 *
 * Implements outbound call initiation using Exotel's documented
 * "Connect Two Numbers" Voice API:
 *   POST https://{api_key}:{api_token}@api.exotel.com/v1/Accounts/{account_sid}/Calls/connect
 *   (Mumbai region: api.in.exotel.com — selected here via EXOTEL_SUBDOMAIN)
 *   Content-Type: application/x-www-form-urlencoded
 *
 * Reference: https://developer.exotel.com/docs/voice-v3/api-reference/connect-two-numbers
 *
 * The call is placed with `StreamUrl` pointing at our AgentStream
 * WebSocket endpoint, so once the call connects Exotel opens a
 * bidirectional media-stream WebSocket to us (Exotel is the WS client;
 * we host the server) per the documented AgentStream/Voicebot Applet
 * contract: https://developer.exotel.com/docs/agentstream/overview
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
import { ProviderConfigError, ProviderRequestError } from "../../shared/errors.js";
import { logger, redact } from "../../shared/logger.js";

/** Exotel's call status strings, mapped to our normalized set. */
const EXOTEL_STATUS_MAP: Record<string, ParsedStatusCallback["status"]> = {
  "in-progress": "in_progress",
  ringing: "ringing",
  completed: "completed",
  busy: "failed",
  failed: "failed",
  "no-answer": "failed",
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

    return exotel;
  }

  async initiateCall(params: InitiateCallParams): Promise<InitiateCallResult> {
    const exotel = this.assertConfigured();

    const baseUrl = `https://${exotel.subdomain}/v1/Accounts/${exotel.accountSid}/Calls/connect.json`;
    const auth = Buffer.from(`${exotel.apiKey}:${exotel.apiToken}`).toString("base64");

    const statusCallbackUrl = `${exotel.webhookBaseUrl}/api/telephony/exotel/status-callback?internalCallId=${encodeURIComponent(params.internalCallId)}`;
    const streamUrl = `${exotel.webhookBaseUrl.replace(/^http/, "ws")}/api/telephony/exotel/media-stream?internalCallId=${encodeURIComponent(params.internalCallId)}`;

    const body = new URLSearchParams({
      From: exotel.fromNumber,
      To: params.toNumber,
      CallerId: exotel.fromNumber,
      CallType: "trans",
      StatusCallback: statusCallbackUrl,
      StreamUrl: streamUrl,
    });

    logger.info("exotel.initiateCall: requesting", {
      toNumber: params.toNumber,
      internalCallId: params.internalCallId,
      apiKey: redact(exotel.apiKey),
    });

    let response: Response;
    try {
      response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
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

  parseStatusCallback(payload: TelephonyStatusCallbackPayload): ParsedStatusCallback {
    const callSid = String(payload.CallSid ?? payload.Sid ?? "");
    const rawStatus = String(payload.Status ?? payload.CallStatus ?? "").toLowerCase();
    const status = EXOTEL_STATUS_MAP[rawStatus] ?? "failed";

    const durationSeconds = payload.Duration ? Number(payload.Duration) : undefined;
    const recordingUrl = payload.RecordingUrl ? String(payload.RecordingUrl) : undefined;

    if (!callSid) {
      throw new ProviderRequestError("exotel", "Status callback payload missing CallSid");
    }

    return { providerCallId: callSid, status, durationSeconds, recordingUrl };
  }
}

/** Exotel's JSON response nests the call under Call.Sid; be lenient about exact shape. */
function extractCallSid(json: unknown): string | null {
  if (typeof json !== "object" || json === null) return null;
  const obj = json as Record<string, unknown>;
  const call = obj.Call as Record<string, unknown> | undefined;
  if (call && typeof call.Sid === "string") return call.Sid;
  if (typeof obj.Sid === "string") return obj.Sid;
  return null;
}
