/**
 * Mock telephony provider — used for local development and automated
 * tests when TELEPHONY_PROVIDER=mock (the default). It never claims a
 * real call happened; it simulates the provider contract only, so the
 * rest of the system (calls module, dashboard polling, websocket
 * harness) can be exercised without real Exotel credentials.
 */

import type {
  ITelephonyProvider,
  InitiateCallParams,
  InitiateCallResult,
  ParsedStatusCallback,
  TelephonyStatusCallbackPayload,
} from "./telephony.interface.js";

export class MockTelephonyProvider implements ITelephonyProvider {
  readonly name = "mock";

  async initiateCall(params: InitiateCallParams): Promise<InitiateCallResult> {
    return {
      providerCallId: `mock-call-${params.internalCallId}`,
      status: "initiating",
    };
  }

  parseStatusCallback(payload: TelephonyStatusCallbackPayload): ParsedStatusCallback {
    return {
      providerCallId: String(payload.providerCallId ?? ""),
      status: (payload.status as ParsedStatusCallback["status"]) ?? "completed",
      durationSeconds: payload.durationSeconds ? Number(payload.durationSeconds) : undefined,
    };
  }
}
