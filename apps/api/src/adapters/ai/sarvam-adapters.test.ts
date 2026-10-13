/**
 * The Sarvam adapters against a stubbed `fetch`: wire format (tool calls, voice), failure classification, structured
 * errors that leak neither credentials nor provider bodies, and the reliability wrapper around them. No network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProviderRequestError } from "../../shared/errors.js";
import { SarvamLlmProvider } from "./sarvam.llm.provider.js";
import { SarvamSttProvider } from "./sarvam.stt.provider.js";
import { SarvamTtsProvider } from "./sarvam.tts.provider.js";
import { ReliableLanguageModel, ReliableSpeechToText, ReliableTextToSpeech } from "./reliable-providers.js";
import { resetCircuitBreakers } from "./circuit-breaker.js";
import { parseOpenAiToolCalls, toOpenAiMessage } from "./openai-compat.js";
import type { ChatMessage } from "./llm.interface.js";

const API_KEY = "sk-sarvam-LIVE-SECRET-KEY-999";
const BODY_SECRET = "PROVIDER-INTERNAL-TRACE-abc123";
const ENV = ["SARVAM_API_KEY", "PROVIDER_MAX_ATTEMPTS", "PROVIDER_RETRY_BASE_DELAY_MS", "PROVIDER_RETRY_MAX_DELAY_MS", "PROVIDER_STT_TIMEOUT_MS", "PROVIDER_TTS_TIMEOUT_MS", "PROVIDER_LLM_TIMEOUT_MS", "PROVIDER_BREAKER_FAILURE_THRESHOLD"] as const;

let saved: Record<string, string | undefined>;
let lines: string[];
let fetchMock: ReturnType<typeof vi.fn>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const completion = (message: Record<string, unknown>) => json({ choices: [{ message }] });
const lastBody = () => JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.SARVAM_API_KEY = API_KEY;
  process.env.PROVIDER_MAX_ATTEMPTS = "3";
  process.env.PROVIDER_RETRY_BASE_DELAY_MS = "1";
  process.env.PROVIDER_RETRY_MAX_DELAY_MS = "5";
  process.env.PROVIDER_BREAKER_FAILURE_THRESHOLD = "1000";
  lines = [];
  for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void lines.push(String(args[0])));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  resetCircuitBreakers();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetCircuitBreakers();
});

describe("OpenAI-compatible message translation (tool-call contract)", () => {
  const history: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "book a visit" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_a", name: "check_visit_slots", arguments: { day: "sat" } }] },
    { role: "tool", content: '{"slots":["11:30"]}', toolCallId: "call_a" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_b", name: "book_site_visit", arguments: { at: "11:30" } }, { id: "call_c", name: "update_lead", arguments: {} }] },
    { role: "tool", content: '{"ok":true}', toolCallId: "call_b" },
    { role: "tool", content: '{"ok":true}', toolCallId: "call_c" },
    { role: "assistant", content: "Booked!" },
  ];

  it("an assistant tool turn is ONE message with tool_calls (id, name, JSON-string arguments); tool results carry tool_call_id", () => {
    const wire = history.map(toOpenAiMessage);
    expect(wire[2]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_a", type: "function", function: { name: "check_visit_slots", arguments: '{"day":"sat"}' } }],
    });
    expect(wire[3]).toEqual({ role: "tool", content: '{"slots":["11:30"]}', tool_call_id: "call_a" });
    expect((wire[4] as { tool_calls: unknown[] }).tool_calls).toHaveLength(2);
    expect(wire[7]).toEqual({ role: "assistant", content: "Booked!" });
  });

  it("every tool message answers a tool call that an EARLIER assistant message declared", () => {
    const declared = new Set<string>();
    for (const m of history.map(toOpenAiMessage)) {
      if (m.role === "assistant") for (const c of m.tool_calls ?? []) declared.add(c.id);
      if (m.role === "tool") expect(declared.has(m.tool_call_id)).toBe(true);
    }
  });

  it("tool-call ids from the provider are preserved; garbled arguments are flagged, not silently emptied", () => {
    const calls = parseOpenAiToolCalls([
      { id: "call_1", function: { name: "a", arguments: '{"x":1}' } },
      { id: "call_2", function: { name: "b", arguments: "{not json" } },
      { id: "call_3", function: { name: "c", arguments: '["array"]' } },
      { function: { name: "d", arguments: {} } },
    ]);
    expect(calls[0]).toEqual({ id: "call_1", name: "a", arguments: { x: 1 } });
    expect(calls[1]).toMatchObject({ id: "call_2", name: "b", arguments: {}, invalidArguments: true });
    expect(calls[2]).toMatchObject({ id: "call_3", invalidArguments: true });
    expect(calls[3]).toMatchObject({ id: "", name: "d", arguments: {} });
  });
});

describe("SarvamLlmProvider", () => {
  it("sends assistant tool calls and tool results in the OpenAI shape, with the bearer key", async () => {
    fetchMock.mockResolvedValue(completion({ content: "ok" }));
    await new SarvamLlmProvider().chat(
      [
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "call_a", name: "t", arguments: { k: "v" } }] },
        { role: "tool", content: "{}", toolCallId: "call_a" },
      ],
      [{ name: "t", description: "d", parameters: { type: "object" } }],
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    const body = lastBody();
    expect(body.messages[1].tool_calls[0]).toEqual({ id: "call_a", type: "function", function: { name: "t", arguments: '{"k":"v"}' } });
    expect(body.messages[2]).toEqual({ role: "tool", content: "{}", tool_call_id: "call_a" });
    expect(body.tools[0].function.name).toBe("t");
  });

  it("returns the model's tool calls with their ids", async () => {
    fetchMock.mockResolvedValue(completion({ tool_calls: [{ id: "call_9", type: "function", function: { name: "t", arguments: '{"a":2}' } }] }));
    const r = await new SarvamLlmProvider().chat([{ role: "user", content: "x" }], []);
    expect(r.toolCalls).toEqual([{ id: "call_9", name: "t", arguments: { a: 2 } }]);
  });

  it("passes the caller's abort signal to fetch", async () => {
    fetchMock.mockResolvedValue(completion({ content: "ok" }));
    const controller = new AbortController();
    await new SarvamLlmProvider().chat([{ role: "user", content: "x" }], [], { signal: controller.signal });
    expect((fetchMock.mock.calls[0][1] as RequestInit).signal).toBe(controller.signal);
  });
});

describe("failure classification and structured errors", () => {
  const llm = () => new SarvamLlmProvider();
  const call = () => llm().chat([{ role: "user", content: "secret customer utterance" }], []);

  it.each([
    [401, "auth", false],
    [403, "auth", false],
    [400, "invalid_request", false],
    [422, "invalid_request", false],
    [404, "invalid_request", false],
    [429, "rate_limited", true],
    [500, "server", true],
    [503, "server", true],
    [408, "timeout", true],
  ] as const)("HTTP %i is %s (transient: %s)", async (status, category, transient) => {
    fetchMock.mockResolvedValue(new Response(`{"trace":"${BODY_SECRET}"}`, { status }));
    const e = (await call().catch((x: unknown) => x)) as ProviderRequestError;
    expect(e).toBeInstanceOf(ProviderRequestError);
    expect(e).toMatchObject({ provider: "sarvam", operation: "llm.chat", category, status, transient });
  });

  it("a 429 carries the provider's Retry-After", async () => {
    fetchMock.mockResolvedValue(new Response("slow down", { status: 429, headers: { "retry-after": "2" } }));
    const e = (await call().catch((x: unknown) => x)) as ProviderRequestError;
    expect(e.retryAfterMs).toBe(2_000);
  });

  it("a connection failure is a transient 'network' error", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed: ECONNRESET to 10.0.0.5"));
    const e = (await call().catch((x: unknown) => x)) as ProviderRequestError;
    expect(e).toMatchObject({ category: "network", transient: true });
  });

  it("an unusable 200 (not JSON / no message) is a transient 'bad_response'", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>gateway</html>", { status: 200 }));
    expect(((await call().catch((x: unknown) => x)) as ProviderRequestError).category).toBe("bad_response");
    fetchMock.mockResolvedValueOnce(json({ choices: [] }));
    expect(((await call().catch((x: unknown) => x)) as ProviderRequestError).category).toBe("bad_response");
  });

  it("the error message, log fields and logs contain no API key, no provider response body and no request payload", async () => {
    fetchMock.mockResolvedValue(new Response(`{"trace":"${BODY_SECRET}","echo":"secret customer utterance"}`, { status: 500 }));
    const reliable = new ReliableLanguageModel(llm());
    const e = (await reliable.chat([{ role: "user", content: "secret customer utterance" }], [], { callId: "call-77" }).catch((x: unknown) => x)) as ProviderRequestError;
    const everything = [e.message, JSON.stringify(e.toLogFields()), ...lines].join("\n");
    expect(everything).not.toContain(API_KEY);
    expect(everything).not.toContain(BODY_SECRET);
    expect(everything).not.toContain("secret customer utterance");
    expect(lines.some((l) => l.includes('"callId":"call-77"') && l.includes('"provider":"sarvam-105b"') && l.includes('"operation":"llm.chat"'))).toBe(true);
  });
});

describe("STT", () => {
  it("silence (an empty transcript) is a normal result, not an error", async () => {
    fetchMock.mockResolvedValue(json({ transcript: "" }));
    await expect(new SarvamSttProvider().transcribe(Buffer.from("x"))).resolves.toMatchObject({ text: "" });
  });

  it("a body with no transcript field at all is an unusable response", async () => {
    fetchMock.mockResolvedValue(json({ nope: true }));
    expect(((await new SarvamSttProvider().transcribe(Buffer.from("x")).catch((x: unknown) => x)) as ProviderRequestError).category).toBe("bad_response");
  });
});

describe("TTS voice on the wire", () => {
  it("the agent's voice is sent as the Sarvam speaker; with none, the previous default speaker is used", async () => {
    fetchMock.mockImplementation(async () => json({ audios: [Buffer.from("RIFF").toString("base64")] }));
    await new SarvamTtsProvider().synthesize("hello", { voice: "meera" });
    expect(lastBody().speaker).toBe("meera");
    await new SarvamTtsProvider().synthesize("hello");
    expect(lastBody().speaker).toBe("shubh");
  });

  it("an unknown voice (400) is an 'invalid_request' so the caller can fall back", async () => {
    fetchMock.mockResolvedValue(new Response("unknown speaker", { status: 400 }));
    const e = (await new SarvamTtsProvider().synthesize("hi", { voice: "nobody" }).catch((x: unknown) => x)) as ProviderRequestError;
    expect(e).toMatchObject({ category: "invalid_request", transient: false });
  });
});

describe("the reliability wrapper around the real adapters", () => {
  it("retries a transient failure and then succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }))
      .mockResolvedValueOnce(json({ audios: [Buffer.from("RIFF").toString("base64")] }));
    const r = await new ReliableTextToSpeech(new SarvamTtsProvider()).synthesize("hi");
    expect(r.format).toBe("wav");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a permanent failure (bad credentials)", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
    const e = (await new ReliableLanguageModel(new SarvamLlmProvider()).chat([{ role: "user", content: "x" }], []).catch((x: unknown) => x)) as ProviderRequestError;
    expect(e.category).toBe("auth");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the attempt limit with the last failure and the attempt count", async () => {
    fetchMock.mockImplementation(async () => new Response("down", { status: 502 }));
    const e = (await new ReliableSpeechToText(new SarvamSttProvider()).transcribe(Buffer.from("x")).catch((x: unknown) => x)) as ProviderRequestError;
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(e).toMatchObject({ category: "server", attempts: 3 });
  });

  it("a request that hangs is cut off at the provider timeout (and the adapter's fetch is aborted)", async () => {
    process.env.PROVIDER_MAX_ATTEMPTS = "1";
    process.env.PROVIDER_STT_TIMEOUT_MS = "40";
    let aborted = false;
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal?.reason);
          });
        }),
    );
    const started = Date.now();
    const e = (await new ReliableSpeechToText(new SarvamSttProvider()).transcribe(Buffer.from("x")).catch((x: unknown) => x)) as ProviderRequestError;
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(e.category).toBe("timeout");
    expect(aborted).toBe(true);
  });

  it("cancelling stops the in-flight request", async () => {
    process.env.PROVIDER_LLM_TIMEOUT_MS = "60000";
    const controller = new AbortController();
    let aborted = false;
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(init.signal?.reason);
          });
        }),
    );
    const pending = new ReliableLanguageModel(new SarvamLlmProvider()).chat([{ role: "user", content: "x" }], [], { signal: controller.signal }).catch((x: unknown) => x);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    expect(((await pending) as ProviderRequestError).category).toBe("cancelled");
    expect(aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("repeated outages open the circuit for that provider only, then calls fail fast without any request", async () => {
    process.env.PROVIDER_MAX_ATTEMPTS = "1";
    process.env.PROVIDER_BREAKER_FAILURE_THRESHOLD = "2";
    resetCircuitBreakers();
    fetchMock.mockImplementation(async () => new Response("down", { status: 500 }));
    const tts = new ReliableTextToSpeech(new SarvamTtsProvider());
    await tts.synthesize("a").catch(() => undefined);
    await tts.synthesize("b").catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const e = (await tts.synthesize("c").catch((x: unknown) => x)) as ProviderRequestError;
    expect(e.category).toBe("circuit_open");
    expect(fetchMock).toHaveBeenCalledTimes(2); // nothing was sent

    // The LLM is a different provider with its own circuit: still served.
    fetchMock.mockImplementation(async () => completion({ content: "fine" }));
    await expect(new ReliableLanguageModel(new SarvamLlmProvider()).chat([{ role: "user", content: "x" }], [])).resolves.toMatchObject({ content: "fine" });
  });
});
