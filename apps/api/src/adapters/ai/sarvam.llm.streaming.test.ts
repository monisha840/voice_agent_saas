/**
 * Contract tests for the Sarvam LLM streaming adapter: the REAL adapter against a local HTTP server that speaks
 * Sarvam's documented streaming format (OpenAI-compatible SSE: `data:` chunk lines, delta.content,
 * delta.reasoning_content, finish_reason, a usage-only chunk, `data: [DONE]`). No credentials, no internet.
 * They prove we follow the documented contract. Tool-call DELTAS are not documented by Sarvam; those tests pin down
 * our (OpenAI-convention) handling, not Sarvam's behaviour.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SarvamLlmProvider } from "./sarvam.llm.provider.js";
import type { LlmStreamHandlers } from "./llm.interface.js";
import { ProviderConfigError, ProviderRequestError } from "../../shared/errors.js";

interface Captured {
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
  url?: string;
}
interface Fake {
  url: string;
  requests: Captured[];
  /** How many connections the server saw closed by the client before it finished writing. */
  aborted: () => number;
  close(): Promise<void>;
}

const servers: Fake[] = [];
async function fake(handler: (res: ServerResponse, req: Captured) => unknown): Promise<Fake> {
  const requests: Captured[] = [];
  let aborted = 0;
  const server: Server = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => {
      const cap: Captured = { headers: req.headers, body: JSON.parse(Buffer.concat(parts).toString() || "{}"), url: req.url };
      requests.push(cap);
      res.on("close", () => {
        if (!res.writableEnded) aborted++;
      });
      void handler(res, cap);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const f: Fake = {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`,
    requests,
    aborted: () => aborted,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
  servers.push(f);
  return f;
}

const sse = (res: ServerResponse) => res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", model: "sarvam-105b", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const text = (t: string) => chunk({ content: t });
const done = "data: [DONE]\n\n";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ENV_KEYS = ["SARVAM_API_KEY", "SARVAM_LLM_REASONING_EFFORT", "SARVAM_LLM_MODEL", "PROVIDER_LLM_FIRST_TOKEN_TIMEOUT_MS", "PROVIDER_LLM_STREAM_STALL_TIMEOUT_MS"];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.SARVAM_API_KEY = "test-llm-key-987";
  delete process.env.SARVAM_LLM_REASONING_EFFORT;
});
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const s of servers.splice(0)) await s.close();
});

function collector() {
  const deltas: string[] = [];
  const handlers: LlmStreamHandlers = { onTextDelta: (t) => void deltas.push(t) };
  return { deltas, handlers };
}
const MSGS = [
  { role: "system" as const, content: "Speak in Tamil (ta-IN)." },
  { role: "user" as const, content: "இந்த project-ல 2 BHK price எவ்வளவு?" },
];
const TOOLS = [{ name: "lookup", description: "d", parameters: { type: "object", properties: {} } }];

describe("request shape", () => {
  it("POSTs stream:true with messages/tools/model, both documented auth headers, and the SSE Accept header", async () => {
    process.env.SARVAM_LLM_MODEL = "sarvam-105b-conversations";
    const f = await fake((res) => (sse(res), res.end(text("ok") + chunk({}, "stop") + done)));
    await new SarvamLlmProvider(f.url).chatStream(MSGS, TOOLS, collector().handlers);
    const r = f.requests[0];
    expect(r.headers["api-subscription-key"]).toBe("test-llm-key-987");
    expect(r.headers.authorization).toBe("Bearer test-llm-key-987");
    expect(r.headers.accept).toBe("text/event-stream");
    expect(r.body).toMatchObject({
      model: "sarvam-105b-conversations",
      stream: true,
      messages: [
        { role: "system", content: "Speak in Tamil (ta-IN)." },
        { role: "user", content: "இந்த project-ல 2 BHK price எவ்வளவு?" },
      ],
      tools: [{ type: "function", function: { name: "lookup" } }],
    });
    expect("reasoning_effort" in r.body).toBe(false); // unset = not sent
  });

  it.each([
    ["off", null],
    ["low", "low"],
    ["high", "high"],
  ])("SARVAM_LLM_REASONING_EFFORT=%s sends reasoning_effort=%j (batch and streaming alike)", async (setting, sent) => {
    process.env.SARVAM_LLM_REASONING_EFFORT = setting;
    const f = await fake((res, req) => {
      if (req.body.stream) (sse(res), res.end(text("a") + chunk({}, "stop") + done));
      else (res.writeHead(200, { "Content-Type": "application/json" }), res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "b" } }] })));
    });
    const p = new SarvamLlmProvider(f.url);
    await p.chatStream(MSGS, [], collector().handlers);
    await p.chat(MSGS, []);
    for (const r of f.requests) expect(r.body.reasoning_effort).toBe(sent);
  });

  it("omits tools when there are none, and refuses to run without a key", async () => {
    const f = await fake((res) => (sse(res), res.end(text("x") + chunk({}, "stop") + done)));
    await new SarvamLlmProvider(f.url).chatStream(MSGS, [], collector().handlers);
    expect("tools" in f.requests[0].body).toBe(false);
    process.env.SARVAM_API_KEY = "";
    await expect(new SarvamLlmProvider(f.url).chatStream(MSGS, [], collector().handlers)).rejects.toBeInstanceOf(ProviderConfigError);
    expect(f.requests.length).toBe(1); // nothing was sent
  });

  it("declares streaming capability", () => {
    expect(new SarvamLlmProvider().capabilities.streamingLlm).toBe(true);
  });
});

describe("streamed text", () => {
  it("delivers each delta as it arrives and assembles content, finish reason and usage; reasoning is never spoken", async () => {
    const f = await fake(async (res) => {
      sse(res);
      res.write(chunk({ role: "assistant", reasoning_content: "thinking about the price..." }));
      res.write(text("Hello"));
      await wait(40);
      res.write(text(" Rajesh"));
      res.write(chunk({ content: ". I can help." }, "stop"));
      res.write(`data: ${JSON.stringify({ id: "x", choices: [], usage: { prompt_tokens: 11, completion_tokens: 6, total_tokens: 17 } })}\n\n`);
      res.end(done);
    });
    const c = collector();
    const t0 = Date.now();
    const seenAt: number[] = [];
    const result = await new SarvamLlmProvider(f.url).chatStream(MSGS, [], { onTextDelta: (t) => (c.deltas.push(t), seenAt.push(Date.now() - t0)) });
    expect(c.deltas).toEqual(["Hello", " Rajesh", ". I can help."]);
    expect(result).toEqual({ content: "Hello Rajesh. I can help.", finishReason: "stop", usage: { promptTokens: 11, completionTokens: 6, totalTokens: 17 } });
    expect(result.content).not.toContain("thinking");
    expect(seenAt[1] - seenAt[0]).toBeGreaterThanOrEqual(25); // genuinely incremental, not buffered to the end
  });

  it("handles events split across network chunks, CRLF endings, comments, and multi-byte text cut mid-character", async () => {
    const payload = Buffer.from(text("நிச்சயமாக. ") + text("விலை 70 லட்சம்.") + chunk({}, "stop") + done, "utf8").toString("latin1");
    const raw = Buffer.from(payload.replace(/\n/g, "\r\n"), "latin1");
    const f = await fake(async (res) => {
      sse(res);
      res.write(": keep-alive comment\r\n\r\n");
      for (let i = 0; i < raw.length; i += 7) {
        res.write(raw.subarray(i, i + 7)); // 7-byte slices: splits UTF-8 characters and \r\n pairs
        await wait(1);
      }
      res.end();
    });
    const c = collector();
    const result = await new SarvamLlmProvider(f.url).chatStream(MSGS, [], c.handlers);
    expect(result.content).toBe("நிச்சயமாக. விலை 70 லட்சம்.");
    expect(c.deltas.join("")).toBe(result.content);
  });

  it("an empty reply is a normal outcome (finish stop, no content)", async () => {
    const f = await fake((res) => (sse(res), res.end(chunk({ role: "assistant" }, "stop") + done)));
    const c = collector();
    const r = await new SarvamLlmProvider(f.url).chatStream(MSGS, [], c.handlers);
    expect(r).toMatchObject({ content: "", finishReason: "stop" });
    expect(c.deltas).toEqual([]);
  });

  it("an empty reply because thinking used the token budget (finish length) is returned empty, with its reason", async () => {
    const f = await fake((res) => (sse(res), res.end(chunk({ reasoning_content: "long thought" }) + chunk({}, "length") + done)));
    const r = await new SarvamLlmProvider(f.url).chatStream(MSGS, [], collector().handlers);
    expect(r).toMatchObject({ content: "", finishReason: "length" });
  });

  it("repeated finish/usage/[DONE] events do not double anything", async () => {
    const f = await fake((res) => (sse(res), res.end(text("Once.") + chunk({}, "stop") + chunk({}, "stop") + done + done)));
    const c = collector();
    const r = await new SarvamLlmProvider(f.url).chatStream(MSGS, [], c.handlers);
    expect(r.content).toBe("Once.");
    expect(c.deltas).toEqual(["Once."]);
  });

  it("a server that ignores stream:true and answers with plain JSON still works (one delta)", async () => {
    const f = await fake((res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Whole answer." }, finish_reason: "stop" }] }));
    });
    const c = collector();
    const r = await new SarvamLlmProvider(f.url).chatStream(MSGS, [], c.handlers);
    expect(r.content).toBe("Whole answer.");
    expect(c.deltas).toEqual(["Whole answer."]);
  });
});

describe("streamed tool calls (OpenAI-convention deltas; provider format undocumented)", () => {
  const frag = (tool_calls: unknown[], finish: string | null = null) => chunk({ tool_calls }, finish);

  it("assembles one call from fragments and hands it back only when the stream is complete", async () => {
    const f = await fake(async (res) => {
      sse(res);
      res.write(frag([{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: "" } }]));
      res.write(frag([{ index: 0, function: { arguments: '{"item":' } }]));
      await wait(30);
      res.write(frag([{ index: 0, function: { arguments: '"2 BHK"}' } }], "tool_calls"));
      res.end(done);
    });
    const c = collector();
    const r = await new SarvamLlmProvider(f.url).chatStream(MSGS, TOOLS, c.handlers);
    expect(r.toolCalls).toEqual([{ id: "call_1", name: "lookup", arguments: { item: "2 BHK" } }]);
    expect(r.content).toBeUndefined();
    expect(r.finishReason).toBe("tool_calls");
    expect(c.deltas).toEqual([]); // tool arguments are never spoken
  });

  it("assembles several calls interleaved by index, preserving ids and order", async () => {
    const f = await fake((res) => {
      sse(res);
      res.write(frag([{ index: 0, id: "a", function: { name: "lookup", arguments: '{"i' } }, { index: 1, id: "b", function: { name: "reserve", arguments: '{"x":1}' } }]));
      res.write(frag([{ index: 0, function: { arguments: 'tem":"A"}' } }], "tool_calls"));
      res.end(done);
    });
    const r = await new SarvamLlmProvider(f.url).chatStream(MSGS, TOOLS, collector().handlers);
    expect(r.toolCalls).toEqual([
      { id: "a", name: "lookup", arguments: { item: "A" } },
      { id: "b", name: "reserve", arguments: { x: 1 } },
    ]);
  });

  it("a re-sent fragment with the same id lands in the same call (no duplicate call)", async () => {
    const f = await fake((res) => {
      sse(res);
      res.write(frag([{ id: "same", function: { name: "lookup", arguments: '{"a":1}' } }]));
      res.write(frag([{ id: "same", function: { name: "lookup" } }], "tool_calls"));
      res.end(done);
    });
    const r = await new SarvamLlmProvider(f.url).chatStream(MSGS, TOOLS, collector().handlers);
    expect(r.toolCalls).toEqual([{ id: "same", name: "lookup", arguments: { a: 1 } }]);
  });

  it("arguments that do not parse as a JSON object are flagged, never guessed or defaulted", async () => {
    const f = await fake((res) => {
      sse(res);
      res.write(frag([{ index: 0, id: "x", function: { name: "lookup", arguments: '{"item": "unterminated' } }], "length"));
      res.end(done);
    });
    const r = await new SarvamLlmProvider(f.url).chatStream(MSGS, TOOLS, collector().handlers);
    expect(r.toolCalls![0]).toMatchObject({ name: "lookup", invalidArguments: true, arguments: {} });
  });

  it("a call that never got a name is incomplete: the whole stream fails (bad_response), nothing is returned", async () => {
    const f = await fake((res) => {
      sse(res);
      res.write(frag([{ index: 0, id: "x", function: { arguments: "{}" } }], "tool_calls"));
      res.end(done);
    });
    await expect(new SarvamLlmProvider(f.url).chatStream(MSGS, TOOLS, collector().handlers)).rejects.toMatchObject({ category: "bad_response" });
  });

  it("a stream cut off in the middle of a tool call yields no call at all", async () => {
    const f = await fake((res) => {
      sse(res);
      res.write(frag([{ index: 0, id: "x", function: { name: "lookup", arguments: '{"item":' } }]));
      res.destroy(); // connection dies before the call is complete and before any finish reason
    });
    await expect(new SarvamLlmProvider(f.url).chatStream(MSGS, TOOLS, collector().handlers)).rejects.toBeInstanceOf(ProviderRequestError);
  });
});

describe("failures are classified, never leak provider text, and are not retried here", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [429, "rate_limited"],
    [400, "invalid_request"],
    [500, "server"],
    [503, "server"],
  ])("HTTP %i is %s", async (status, category) => {
    const f = await fake((res) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "SECRET prompt echo", code: "x" } }));
    });
    const err = await new SarvamLlmProvider(f.url).chatStream(MSGS, [], collector().handlers).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err.category).toBe(category);
    expect(err.message).not.toContain("SECRET");
    expect(JSON.stringify(err.toLogFields())).not.toContain("test-llm-key-987");
    expect(f.requests.length).toBe(1);
  });

  it("a malformed stream event fails the stream (bad_response) after the text already delivered", async () => {
    const f = await fake((res) => (sse(res), res.end(text("Fine so far. ") + "data: {not json\n\n" + text("never seen") + done)));
    const c = collector();
    const err = await new SarvamLlmProvider(f.url).chatStream(MSGS, [], c.handlers).catch((e) => e);
    expect(err.category).toBe("bad_response");
    expect(c.deltas).toEqual(["Fine so far. "]);
  });

  it("an error object inside the stream fails it as a server error without copying its text", async () => {
    const f = await fake((res) => (sse(res), res.end(text("Partial. ") + `data: ${JSON.stringify({ error: { message: "PRIVATE detail", code: "boom" } })}\n\n`)));
    const err = await new SarvamLlmProvider(f.url).chatStream(MSGS, [], collector().handlers).catch((e) => e);
    expect(err.category).toBe("server");
    expect(err.message).not.toContain("PRIVATE");
  });

  it("a stream that ends without [DONE] or a finish reason is cut off, not complete", async () => {
    const f = await fake((res) => (sse(res), res.end(text("The price is seventy"))));
    const c = collector();
    const err = await new SarvamLlmProvider(f.url).chatStream(MSGS, [], c.handlers).catch((e) => e);
    expect(err.category).toBe("bad_response");
    expect(c.deltas).toEqual(["The price is seventy"]); // the caller can see it was delivered, and that the result failed
  });

  it("a dropped connection mid-stream is a network failure", async () => {
    const f = await fake(async (res) => {
      sse(res);
      res.write(text("Half a sent"));
      await wait(10);
      res.destroy();
    });
    const err = await new SarvamLlmProvider(f.url).chatStream(MSGS, [], collector().handlers).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(["network", "bad_response"]).toContain(err.category);
  });

  it("an unreachable server is a network failure", async () => {
    const err = await new SarvamLlmProvider("http://127.0.0.1:1/v1/chat/completions").chatStream(MSGS, [], collector().handlers).catch((e) => e);
    expect(err.category).toBe("network");
  });
});

describe("timeouts", () => {
  it("no reply text within the first-token timeout fails as a timeout, even though the connection is open", async () => {
    process.env.PROVIDER_LLM_FIRST_TOKEN_TIMEOUT_MS = "150";
    const f = await fake((res) => void sse(res)); // headers sent, then silence
    const t0 = Date.now();
    const err = await new SarvamLlmProvider(f.url).chatStream(MSGS, [], collector().handlers).catch((e) => e);
    expect(err.category).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(2_000);
    await wait(50);
    expect(f.aborted()).toBe(1); // the connection was released
  });

  it("thinking alone does not count as a first token (the voice budget applies to speakable output)", async () => {
    process.env.PROVIDER_LLM_FIRST_TOKEN_TIMEOUT_MS = "200";
    process.env.PROVIDER_LLM_STREAM_STALL_TIMEOUT_MS = "5000";
    const f = await fake(async (res) => {
      sse(res);
      for (let i = 0; i < 20; i++) {
        res.write(chunk({ reasoning_content: "hmm " }));
        await wait(30);
      }
      res.end(text("late") + chunk({}, "stop") + done);
    });
    const err = await new SarvamLlmProvider(f.url).chatStream(MSGS, [], collector().handlers).catch((e) => e);
    expect(err.category).toBe("timeout");
  });

  it("a stream that goes quiet mid-reply fails as a timeout after the stall period", async () => {
    process.env.PROVIDER_LLM_STREAM_STALL_TIMEOUT_MS = "150";
    const f = await fake((res) => (sse(res), res.write(text("Started. "))));
    const c = collector();
    const err = await new SarvamLlmProvider(f.url).chatStream(MSGS, [], c.handlers).catch((e) => e);
    expect(err.category).toBe("timeout");
    expect(c.deltas).toEqual(["Started. "]);
  });
});

describe("cancellation", () => {
  it("aborting mid-stream stops reading, rejects as cancelled, delivers nothing further and closes the connection", async () => {
    const f = await fake(async (res) => {
      sse(res);
      for (let i = 0; i < 200 && !res.destroyed; i++) {
        res.write(text(`word${i} `));
        await wait(10);
      }
      res.end();
    });
    const ac = new AbortController();
    const c = collector();
    const p = new SarvamLlmProvider(f.url).chatStream(MSGS, [], c.handlers, { signal: ac.signal });
    await until(() => c.deltas.length >= 3);
    ac.abort();
    const err = await p.catch((e) => e);
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err.category).toBe("cancelled");
    const n = c.deltas.length;
    await wait(100);
    expect(c.deltas.length).toBe(n); // nothing after the abort
    expect(f.aborted()).toBe(1);
  });

  it("an already-aborted signal never reaches the network", async () => {
    const f = await fake((res) => (sse(res), res.end(text("x") + done)));
    const err = await new SarvamLlmProvider(f.url).chatStream(MSGS, [], collector().handlers, { signal: AbortSignal.abort() }).catch((e) => e);
    expect(err.category).toBe("cancelled");
    expect(f.requests.length).toBe(0);
  });

  it("a handler that throws does not break the stream", async () => {
    const f = await fake((res) => (sse(res), res.end(text("One. ") + text("Two.") + chunk({}, "stop") + done)));
    const r = await new SarvamLlmProvider(f.url).chatStream(
      MSGS,
      [],
      {
        onTextDelta: () => {
          throw new Error("handler bug");
        },
      },
    );
    expect(r.content).toBe("One. Two.");
  });
});

describe("concurrency", () => {
  it("many simultaneous streams are independent", async () => {
    const f = await fake(async (res, req) => {
      const n = String((req.body.messages as Array<{ content: string }>).at(-1)!.content);
      sse(res);
      for (const w of [`reply `, `for `, n, `.`]) {
        res.write(text(w));
        await wait(Math.random() * 15);
      }
      res.end(chunk({}, "stop") + done);
    });
    const p = new SarvamLlmProvider(f.url);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const c = collector();
        return p.chatStream([{ role: "user", content: `q${i}` }], [], c.handlers).then((r) => ({ i, r, c }));
      }),
    );
    for (const { i, r, c } of results) {
      expect(r.content).toBe(`reply for q${i}.`);
      expect(c.deltas.join("")).toBe(r.content);
    }
  });
});

async function until(cond: () => boolean, ms = 3_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("condition not met in time");
    await wait(5);
  }
}
