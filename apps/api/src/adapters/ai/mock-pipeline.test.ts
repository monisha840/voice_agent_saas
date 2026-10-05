import { describe, it, expect } from "vitest";
import { MockSttProvider } from "./mock.stt.provider.js";
import { MockLlmProvider } from "./mock.llm.provider.js";
import { MockTtsProvider } from "./mock.tts.provider.js";

describe("Mock AI pipeline (no credentials required) — proves the wiring without claiming real speech", () => {
  it("AUDIO -> STT -> text -> LLM -> TTS -> AUDIO completes end-to-end", async () => {
    const stt = new MockSttProvider();
    const llm = new MockLlmProvider();
    const tts = new MockTtsProvider();

    const fakeInputAudio = Buffer.from([0, 1, 2, 3]);
    const sttResult = await stt.transcribe(fakeInputAudio);
    expect(sttResult.text).toContain("mock transcription");

    const llmResult = await llm.chat([{ role: "user", content: sttResult.text }], []);
    expect(llmResult.content).toBeTruthy();

    const ttsResult = await tts.synthesize(llmResult.content!);
    expect(ttsResult.format).toBe("wav");
    expect(ttsResult.audio.length).toBeGreaterThan(44); // more than just a WAV header
  });

  it("TEXT -> LLM -> tool call -> tool result -> final response completes end-to-end", async () => {
    const llm = new MockLlmProvider();
    const tools = [
      {
        name: "get_project_price",
        description: "test",
        parameters: { type: "object", properties: {} },
      },
    ];

    const first = await llm.chat([{ role: "user", content: "what is the price?" }], tools);
    expect(first.toolCalls?.[0]?.name).toBe("get_project_price");

    const second = await llm.chat(
      [
        { role: "user", content: "what is the price?" },
        { role: "tool", content: JSON.stringify({ min: 6500000, max: 7800000 }), toolCallId: "mock-1" },
      ],
      tools,
    );
    expect(second.content).toContain("mock response following tool result");
  });
});
