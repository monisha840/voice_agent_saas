/**
 * Shared helpers for the agent-first test files: a listening app, an HTTP client, a stub telephony provider and a
 * runner that drives one call through the local call simulator (mock STT/LLM/TTS, no real provider credentials).
 */
import { randomInt } from "node:crypto";
import { buildApp } from "../app.js";
import { systemContext } from "../auth/context.js";
import { MockTelephonyProvider } from "../adapters/telephony/mock.provider.js";
import { setTelephonyProvider } from "../adapters/telephony/index.js";
import type {
  ITelephonyProvider,
  InitiateCallParams,
  InitiateCallResult,
  ParsedStatusCallback,
  TelephonyStatusCallbackPayload,
} from "../adapters/telephony/telephony.interface.js";
import { callsService } from "../modules/calls/calls.service.js";
import { callsRepository } from "../db/repositories/calls.repository.js";
import { conversationsRepository } from "../db/repositories/conversations.repository.js";
import type { SimulationReport } from "../simulator/call-simulator.js";

/** Quiet the per-org / per-IP throttles that would otherwise trip when one file places many calls. */
export function relaxRateLimits() {
  process.env.RATE_LIMIT_CALLS_PER_ORG_MAX = "100000";
  process.env.RATE_LIMIT_API_MAX = "1000000";
}

export async function startTestApp() {
  const app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no listen address");
  return { app, baseUrl: `http://127.0.0.1:${addr.port}` };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Body = { data?: any; error?: string; [k: string]: any };

export function httpClient(baseUrl: string) {
  return async (cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { cookie, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Body };
  };
}

/** A random, unique, normalizable Indian mobile number in E.164. */
export function randomPhone(): string {
  return `+919${String(randomInt(0, 1_000_000_000)).padStart(9, "0")}`;
}

/** A provider that records what it is asked to dial and never places anything. */
export class CapturingProvider implements ITelephonyProvider {
  readonly calls: InitiateCallParams[] = [];
  constructor(readonly name = "capture") {}
  async initiateCall(params: InitiateCallParams): Promise<InitiateCallResult> {
    this.calls.push(params);
    return { providerCallId: `${this.name}-${params.internalCallId}`, status: "ringing" };
  }
  parseStatusCallback(payload: TelephonyStatusCallbackPayload): ParsedStatusCallback {
    return { providerCallId: String(payload.providerCallId ?? ""), status: "completed" };
  }
}

/** A provider that must never be used: any use is a test failure. */
export class ForbiddenProvider implements ITelephonyProvider {
  readonly name = "forbidden-stub";
  used = 0;
  async initiateCall(): Promise<InitiateCallResult> {
    this.used++;
    throw new Error("the configured telephony provider must not be used here");
  }
  parseStatusCallback(): ParsedStatusCallback {
    throw new Error("not used");
  }
}

/** Waits until the post-call pipeline stored a summary for the call. */
export async function waitForSummary(orgId: string, callId: string, timeoutMs = 10_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const conv = await conversationsRepository.findByCallId({ organizationId: orgId, callId });
    if (conv?.summary) return conv;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`call ${callId} was never finalized`);
}

/**
 * Drives an EXISTING call (already created, no provider id yet) through the simulator against the listening app,
 * exactly like the mock provider does for a placed call, and waits for it to finish (and be finalized when answered).
 */
export async function simulateExistingCall(
  baseUrl: string,
  call: { id: string; organizationId: string },
  options: { scenario?: "answered" | "busy" | "no_answer" } = {},
): Promise<SimulationReport> {
  const provider = new MockTelephonyProvider({ baseUrl, autoplay: true, scenario: options.scenario });
  setTelephonyProvider(provider);
  try {
    // Link the provider id BEFORE the simulation starts: it reads the call's provider id straight away (a call
    // placed earlier through another provider may already carry a different one).
    await callsService.attachProviderCallId(systemContext(call.organizationId, "test"), {
      callId: call.id,
      providerCallId: `mock-call-${call.id}`,
    });
    await provider.initiateCall({ toNumber: "+910000000000", internalCallId: call.id });
    const report = (await provider.simulations[0]) as SimulationReport | null;
    if (!report) throw new Error("simulation failed");
    if (report.scenario === "answered") await waitForSummary(call.organizationId, call.id);
    return report;
  } finally {
    setTelephonyProvider(null);
  }
}

export async function getCallRow(id: string) {
  const row = await callsRepository.findByIdAnyOrg({ id });
  if (!row) throw new Error(`call ${id} missing`);
  return row;
}
