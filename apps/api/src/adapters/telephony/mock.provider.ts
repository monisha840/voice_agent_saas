/**
 * Mock telephony provider — used for local development and automated
 * tests when TELEPHONY_PROVIDER=mock (the default). It never claims a
 * real call happened. After accepting a call it (optionally) launches
 * the local call simulator in the background, which acts as Exotel
 * against this API's real status-callback and media-stream endpoints —
 * so a "Call Lead" click with mock providers runs the full pipeline and
 * finalizes the call.
 *
 * Set MOCK_TELEPHONY_AUTOPLAY=false to only return a call id (the old
 * behaviour); MOCK_CALL_SCENARIO=busy|no_answer to simulate unanswered calls.
 */
import { getConfig } from "../../config/env.js";
import { runSimulatedCall, type SimulatedCallOptions, type SimulationReport } from "../../simulator/call-simulator.js";
import { logger } from "../../shared/logger.js";
import type {
  ITelephonyProvider,
  InitiateCallParams,
  InitiateCallResult,
  ParsedStatusCallback,
  TelephonyStatusCallbackPayload,
} from "./telephony.interface.js";

export interface MockTelephonyOptions {
  autoplay?: boolean;
  baseUrl?: string;
  scenario?: SimulatedCallOptions["scenario"];
  customerTurns?: readonly string[];
  duplicateCompletedCallback?: boolean;
  passInternalCallIdInUrl?: boolean;
}

export class MockTelephonyProvider implements ITelephonyProvider {
  readonly name = "mock";
  /** Background simulations started by this provider (awaitable by tests). */
  readonly simulations: Promise<SimulationReport | null>[] = [];

  constructor(private readonly options: MockTelephonyOptions = {}) {}

  async initiateCall(params: InitiateCallParams): Promise<InitiateCallResult> {
    const cfg = getConfig().mockTelephony;
    const autoplay = this.options.autoplay ?? cfg.autoplay;
    if (autoplay) {
      const simulation = runSimulatedCall({
        baseUrl: this.options.baseUrl ?? cfg.baseUrl,
        internalCallId: params.internalCallId,
        scenario: this.options.scenario ?? cfg.scenario,
        customerTurns: this.options.customerTurns,
        duplicateCompletedCallback: this.options.duplicateCompletedCallback,
        passInternalCallIdInUrl: this.options.passInternalCallIdInUrl,
      }).catch((err: unknown) => {
        logger.error("mock-telephony: simulated call failed", {
          internalCallId: params.internalCallId,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      });
      this.simulations.push(simulation);
    }
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
