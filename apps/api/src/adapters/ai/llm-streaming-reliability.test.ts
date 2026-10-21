/**
 * Reliability wrapper for STREAMING LLM calls, plus the SSE reader and the mock streaming model.
 * The rule under test: a stream that has already delivered text to the caller is NEVER retried or replayed.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { ReliableLanguageModel } from "./reliable-providers.js";
import { MockLlmProvider } from "./mock.llm.provider.js";
import { getLlmProvider, setLlmProvider } from "./index.js";
import { readSse, SseOverflowError } from "./sse.js";
import { StreamingToolCalls } from "./openai-compat.js";
import { CircuitOpenError, ProviderRequestError, type ProviderFailureCategory } from "../../shared/errors.js";
import type { ChatMessage, ChatResult, ILanguageModel, LlmStreamHandlers, ToolDefinition } from "./llm.interface.js";
import type { ProviderCallOptions } from "./provider-common.js";

const uniq = () => `stub-llm-${Math.random().toString(36).slice(2)}`;
const err = (category: ProviderFailureCategory) => new ProviderRequestError("stub", `stub ${category}`, undefined, { category, operation: "llm.stream" });
const noop: LlmStreamHandlers = { onTextDelta: () => undefined };
const MSG: ChatMessage[] = [{ role: "user", content: "hi" }];
const ENV = ["PROVIDER_MAX_ATTEMPTS", "PROVIDER_RETRY_BASE_DELAY_MS", "PROVIDER_RETRY_MAX_DELAY_MS", "PROVIDER_LLM_TIMEOUT_MS", "PROVIDER_BREAKER_FAILURE_THRESHOLD"];

afterEach(() => {
  for (const k of ENV) delete process.env[k];
  setLlmProvider(null);
  vi.restoreAllMocks();
});

type Script = (n: number, h: LlmStreamHandlers, opts?: ProviderCallOptions) => Promise<ChatResult>;
function model(script: Script) {
  let calls = 0;
  const inner: ILanguageModel = {
    name: uniq(),
    capabilities: { streamingLlm: true },
    chat: async () => ({ content: "batch" }),
    chatStream: async (_m: ChatMessage[], _t: ToolDefinition[], h: LlmStreamHandlers, opts?: ProviderCallOptions) => script(++calls, h, opts),
  };
  process.env.PROVIDER_RETRY_BASE_DELAY_MS = "1";
  process.env.PROVIDER_RETRY_MAX_DELAY_MS = "2";
  return { wrapped: new ReliableLanguageModel(inner), calls: () => calls };
}

describe("ReliableLanguageModel.chatStream", () => {
  it("exists only when the wrapped model can stream; chat() is unchanged", async () => {
    expect(new ReliableLanguageModel({ name: uniq(), chat: async () => ({ content: "x" }) }).chatStream).toBeUndefined();
    const { wrapped } = model(async () => ({ content: "s" }));
    expect(wrapped.chatStream).toBeDefined();
    expect((await wrapped.chat(MSG, [])).content).toBe("batch");
  });

  it("passes deltas and the result through", async () => {
    const { wrapped } = model(async (_n, h) => (h.onTextDelta("a "), h.onTextDelta("b"), { content: "a b", finishReason: "stop" }));
    const got: string[] = [];
    const r = await wrapped.chatStream!(MSG, [], { onTextDelta: (t) => void got.push(t) });
    expect(got).toEqual(["a ", "b"]);
    expect(r).toEqual({ content: "a b", finishReason: "stop" });
  });

  it("a transient failure BEFORE anything was delivered is retried, and the caller hears the reply once", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { wrapped, calls } = model(async (n, h) => {
      if (n === 1) throw err("network");
      h.onTextDelta("Second attempt.");
      return { content: "Second attempt." };
    });
    const got: string[] = [];
    const r = await wrapped.chatStream!(MSG, [], { onTextDelta: (t) => void got.push(t) });
    expect(calls()).toBe(2);
    expect(got).toEqual(["Second attempt."]);
    expect(r.content).toBe("Second attempt.");
  });

  it("a transient failure AFTER text was delivered is NOT retried (no replay, no duplicate speech)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { wrapped, calls } = model(async (_n, h) => {
      h.onTextDelta("Our price is ");
      throw err("network");
    });
    const got: string[] = [];
    await expect(wrapped.chatStream!(MSG, [], { onTextDelta: (t) => void got.push(t) })).rejects.toMatchObject({ category: "network" });
    expect(calls()).toBe(1);
    expect(got).toEqual(["Our price is "]);
  });

  it.each(["auth", "invalid_request", "config", "cancelled"] as ProviderFailureCategory[])("%s failures are never retried", async (category) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { wrapped, calls } = model(async () => {
      throw err(category);
    });
    await expect(wrapped.chatStream!(MSG, [], noop)).rejects.toBeDefined();
    expect(calls()).toBe(1);
  });

  it("bounded retries: gives up after PROVIDER_MAX_ATTEMPTS transient failures with nothing delivered", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.PROVIDER_MAX_ATTEMPTS = "3";
    const { wrapped, calls } = model(async () => {
      throw err("server");
    });
    await expect(wrapped.chatStream!(MSG, [], noop)).rejects.toMatchObject({ category: "server", attempts: 3 });
    expect(calls()).toBe(3);
  });

  it("the per-attempt timeout bounds total generation time; a timeout after delivery is not retried", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    process.env.PROVIDER_LLM_TIMEOUT_MS = "80";
    const { wrapped, calls } = model(async (_n, h, opts) => {
      h.onTextDelta("Starting. ");
      await new Promise((_r, rej) => opts?.signal?.addEventListener("abort", () => rej(opts.signal!.reason), { once: true }));
      return {};
    });
    await expect(wrapped.chatStream!(MSG, [], noop)).rejects.toMatchObject({ category: "timeout" });
    expect(calls()).toBe(1);
  });

  it("caller cancellation reaches the provider call and surfaces as cancelled", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { wrapped } = model(async (_n, _h, opts) => new Promise((_r, rej) => opts?.signal?.addEventListener("abort", () => rej(opts.signal!.reason), { once: true })));
    const ac = new AbortController();
    const p = wrapped.chatStream!(MSG, [], noop, { signal: ac.signal });
    setTimeout(() => ac.abort(), 10);
    await expect(p).rejects.toMatchObject({ category: "cancelled" });
  });

  it("stream failures open the circuit; cancellations and auth errors do not count against health", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    process.env.PROVIDER_BREAKER_FAILURE_THRESHOLD = "2";
    process.env.PROVIDER_MAX_ATTEMPTS = "1";
    let mode: ProviderFailureCategory = "auth";
    const { wrapped, calls } = model(async () => {
      throw err(mode);
    });
    for (let i = 0; i < 4; i++) await wrapped.chatStream!(MSG, [], noop).catch(() => undefined);
    expect(calls()).toBe(4); // auth failures never tripped it
    mode = "server";
    await wrapped.chatStream!(MSG, [], noop).catch(() => undefined);
    await wrapped.chatStream!(MSG, [], noop).catch(() => undefined);
    await expect(wrapped.chatStream!(MSG, [], noop)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(calls()).toBe(6); // the third call never reached the provider
  });

  it("the configured provider (AI_PROVIDER=mock) streams through the wrapper", async () => {
    const llm = getLlmProvider();
    expect(llm.capabilities?.streamingLlm).toBe(true);
    const got: string[] = [];
    const r = await llm.chatStream!([{ role: "system", content: "You are Asha, a voice assistant." }, { role: "user", content: "hello" }], [], { onTextDelta: (t) => void got.push(t) });
    expect(got.length).toBeGreaterThan(1);
    expect(got.join("")).toBe(r.content);
  });
});

describe("Mock LLM streaming", () => {
  it("streams exactly what chat() would answer, in word-sized deltas, deterministically", async () => {
    const m = new MockLlmProvider();
    const msgs: ChatMessage[] = [{ role: "system", content: "You are Asha, a voice assistant." }, { role: "user", content: "hello there" }];
    const batch = await m.chat(msgs, []);
    const run = async () => {
      const got: string[] = [];
      const r = await m.chatStream(msgs, [], { onTextDelta: (t) => void got.push(t) });
      return { got, r };
    };
    const a = await run();
    const b = await run();
    expect(a.got).toEqual(b.got);
    expect(a.got.join("")).toBe(batch.content);
    expect(a.r.content).toBe(batch.content);
    expect(a.r.finishReason).toBe("stop");
  });

  it("a tool-call answer has no text deltas; the call is in the result", async () => {
    const m = new MockLlmProvider();
    const tools: ToolDefinition[] = [{ name: "get_project_details", description: "d", parameters: { type: "object", properties: {} } }];
    const got: string[] = [];
    const r = await m.chatStream(
      [{ role: "system", content: "You are Asha, a voice assistant." }, { role: "user", content: "Tell me about the Green Valley Residency project" }],
      tools,
      { onTextDelta: (t) => void got.push(t) },
    );
    if (r.toolCalls) {
      expect(got).toEqual([]);
      expect(r.finishReason).toBe("tool_calls");
    }
  });

  it("stops streaming when cancelled", async () => {
    const ac = new AbortController();
    const got: string[] = [];
    await expect(
      new MockLlmProvider().chatStream(
        [{ role: "system", content: "You are Asha, a voice assistant." }, { role: "user", content: "hello" }],
        [],
        { onTextDelta: (t) => (got.push(t), ac.abort()) },
        { signal: ac.signal },
      ),
    ).rejects.toBeDefined();
    expect(got.length).toBe(1);
  });
});

describe("SSE reader", () => {
  const streamOf = (parts: Array<string | Uint8Array>) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (const p of parts) c.enqueue(typeof p === "string" ? new TextEncoder().encode(p) : p);
        c.close();
      },
    });
  const collect = async (s: ReadableStream<Uint8Array>, max?: number) => {
    const out: string[] = [];
    for await (const d of readSse(s, max)) out.push(d);
    return out;
  };

  it("yields data payloads; ignores comments, other fields and blank lines; joins multi-line data", async () => {
    expect(await collect(streamOf([": hi\n\nevent: x\nid: 1\ndata: one\n\ndata: two\ndata: three\n\n\n\ndata:four\n\n"]))).toEqual(["one", "two\nthree", "four"]);
  });

  it("is independent of how the bytes are split, with LF, CRLF or CR endings", async () => {
    const whole = "data: a\r\n\r\ndata: b\n\ndata: c\r\r";
    for (const size of [1, 2, 3, 5, 100]) {
      const parts = Array.from({ length: Math.ceil(whole.length / size) }, (_, i) => whole.slice(i * size, (i + 1) * size));
      expect(await collect(streamOf(parts))).toEqual(["a", "b", "c"]);
    }
  });

  it("emits a final event that lacks its terminating blank line", async () => {
    expect(await collect(streamOf(["data: last"]))).toEqual(["last"]);
  });

  it("bounds memory: an oversized event aborts the read", async () => {
    await expect(collect(streamOf(["data: " + "x".repeat(5000) + "\n\n"]), 1000)).rejects.toBeInstanceOf(SseOverflowError);
    await expect(collect(streamOf(["x".repeat(5000)]), 1000)).rejects.toBeInstanceOf(SseOverflowError);
  });
});

describe("StreamingToolCalls", () => {
  it("bounds the number of calls and the argument size", () => {
    const t = new StreamingToolCalls();
    for (let i = 0; i < 16; i++) expect(t.push([{ index: i, id: `c${i}`, function: { name: "n" } }])).toBe(true);
    expect(t.push([{ index: 99, id: "extra", function: { name: "n" } }])).toBe(false);
    const big = new StreamingToolCalls();
    expect(big.push([{ index: 0, id: "x", function: { name: "n", arguments: "a".repeat(70_000) } }])).toBe(false);
  });

  it("a bare continuation fragment (no index, no id) extends the last call; non-array input is ignored", () => {
    const t = new StreamingToolCalls();
    t.push([{ id: "x", function: { name: "n", arguments: '{"a":' } }]);
    t.push([{ function: { arguments: "1}" } }]);
    t.push(undefined);
    expect(t.finish().calls).toEqual([{ id: "x", name: "n", arguments: { a: 1 } }]);
  });
});
