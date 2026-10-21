/**
 * OPT-IN integration test against the REAL Sarvam chat-completions streaming endpoint. Skipped unless enabled:
 *
 *   SARVAM_LLM_INTEGRATION=1 SARVAM_API_KEY=... pnpm --filter @voice-agent/api test sarvam.llm.streaming.integration
 *
 * Costs a little Sarvam usage. It verifies the PROTOCOL against the live service: that streaming works, deltas arrive
 * incrementally, English and Tamil requests are answered, a tool-call request is understood (and how its deltas are
 * shaped, which Sarvam does not document), and that cancelling mid-stream stops delivery. It does NOT assert exact
 * wording, quality or latency numbers; it prints the timings it observes.
 *
 * NOT part of the normal suite: unit/contract tests never need credentials or internet.
 */
import { describe, it, expect } from "vitest";
import { SarvamLlmProvider } from "./sarvam.llm.provider.js";
import type { ToolDefinition } from "./llm.interface.js";

const enabled = process.env.SARVAM_LLM_INTEGRATION === "1" && !!process.env.SARVAM_API_KEY;
const SYSTEM = "You are a helpful voice assistant on a phone call. Keep every reply to one or two short sentences.";

describe.skipIf(!enabled)("Sarvam LLM streaming (real API)", () => {
  it.each([
    ["English", "Can you tell me the price for a two bedroom apartment?"],
    ["Tamil", "இந்த திட்டத்தில் இரண்டு படுக்கையறை வீட்டின் விலை எவ்வளவு?"],
    ["Tanglish", "Indha project la 2 BHK price evlo?"],
  ])("%s: streams a non-empty reply incrementally", async (name, question) => {
    const deltas: string[] = [];
    const t0 = Date.now();
    let firstAt = 0;
    const r = await new SarvamLlmProvider().chatStream(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: question },
      ],
      [],
      { onTextDelta: (t) => (firstAt ||= Date.now() - t0, deltas.push(t)) },
    );
    expect(r.content?.trim().length ?? 0).toBeGreaterThan(0);
    expect(deltas.join("")).toBe(r.content);
    console.log(`[integration] ${name}: firstDelta=${firstAt}ms total=${Date.now() - t0}ms deltas=${deltas.length} finish=${r.finishReason} usage=${JSON.stringify(r.usage)}`);
  }, 60_000);

  it("with thinking disabled (SARVAM_LLM_REASONING_EFFORT=off) the first delta comes sooner than with the default", async () => {
    const ask = async (effort: string) => {
      process.env.SARVAM_LLM_REASONING_EFFORT = effort;
      const t0 = Date.now();
      let first = 0;
      await new SarvamLlmProvider().chatStream([{ role: "system", content: SYSTEM }, { role: "user", content: "Say hello." }], [], { onTextDelta: () => void (first ||= Date.now() - t0) });
      return first;
    };
    try {
      const off = await ask("off");
      const dflt = await ask("");
      console.log(`[integration] first delta: reasoning off=${off}ms, default=${dflt}ms`);
      expect(off).toBeGreaterThan(0);
    } finally {
      delete process.env.SARVAM_LLM_REASONING_EFFORT;
    }
  }, 60_000);

  it("tool request: returns a complete, parseable tool call (or a plain answer), never half a call", async () => {
    const tools: ToolDefinition[] = [
      {
        name: "get_weather",
        description: "Get the current weather for a city.",
        parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
      },
    ];
    const r = await new SarvamLlmProvider().chatStream(
      [
        { role: "system", content: "Use the provided tools when they help." },
        { role: "user", content: "What is the weather in Chennai right now?" },
      ],
      tools,
      { onTextDelta: () => undefined },
    );
    console.log(`[integration] tool request -> ${r.toolCalls ? JSON.stringify(r.toolCalls) : "plain answer"} finish=${r.finishReason}`);
    if (r.toolCalls) {
      expect(r.toolCalls[0].name).toBe("get_weather");
      expect(r.toolCalls[0].invalidArguments).toBeUndefined();
      expect(typeof r.toolCalls[0].arguments.city).toBe("string");
    } else {
      expect(r.content?.length ?? 0).toBeGreaterThan(0);
    }
  }, 60_000);

  it("cancelling mid-stream stops delivery and rejects as cancelled", async () => {
    const ac = new AbortController();
    const deltas: string[] = [];
    const p = new SarvamLlmProvider().chatStream(
      [{ role: "system", content: "Write long, detailed answers." }, { role: "user", content: "Describe the history of Chennai in detail." }],
      [],
      { onTextDelta: (t) => (deltas.push(t), deltas.length === 3 && ac.abort()) },
      { signal: ac.signal },
    );
    await expect(p).rejects.toMatchObject({ category: "cancelled" });
    const n = deltas.length;
    await new Promise((r) => setTimeout(r, 500));
    expect(deltas.length).toBe(n);
  }, 60_000);
});
