/**
 * Voice selection reaching the TTS provider, and the safe fallback when a provider rejects the configured voice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProviderRequestError } from "../../shared/errors.js";
import { synthesizeWithVoice } from "./tts-voice.js";
import { MockTtsProvider } from "./mock.tts.provider.js";
import type { ITextToSpeech, TtsResult } from "./tts.interface.js";

const WAV: TtsResult = { audio: Buffer.from("x"), format: "wav" };
const rejected = (category: "invalid_request" | "server" | "auth" | "timeout") =>
  new ProviderRequestError("stub-tts", `stub-tts tts.synthesize failed (${category})`, undefined, { category, operation: "tts.synthesize" });

beforeEach(() => void vi.spyOn(console, "warn").mockImplementation(() => undefined));
afterEach(() => vi.restoreAllMocks());

describe("synthesizeWithVoice", () => {
  it("passes the configured voice (and language, rate, call id) to the provider", async () => {
    const tts = new MockTtsProvider();
    await synthesizeWithVoice(tts, "hello", { voice: "meera", languageCode: "hi-IN", sampleRate: 8000, callId: "c1" });
    expect(tts.requests).toEqual([{ text: "hello", voice: "meera", languageCode: "hi-IN" }]);
  });

  it("with no configured voice none is sent (the provider default applies)", async () => {
    const tts = new MockTtsProvider();
    await synthesizeWithVoice(tts, "hello", {});
    expect(tts.requests[0].voice).toBeUndefined();
  });

  it("a provider that does not support voice selection never receives one", async () => {
    const synthesize = vi.fn<ITextToSpeech["synthesize"]>(async () => WAV);
    const tts: ITextToSpeech = { name: "no-voices", capabilities: { voiceSelection: false }, synthesize };
    await synthesizeWithVoice(tts, "hi", { voice: "meera" });
    expect(synthesize.mock.calls[0][1]).toMatchObject({ voice: undefined });
  });

  it("a voice the provider rejects falls back ONCE to the provider default, so the agent still speaks", async () => {
    const synthesize = vi
      .fn<ITextToSpeech["synthesize"]>()
      .mockRejectedValueOnce(rejected("invalid_request"))
      .mockResolvedValueOnce(WAV);
    const tts: ITextToSpeech = { name: "stub-tts", synthesize };
    await expect(synthesizeWithVoice(tts, "hi", { voice: "bogus" })).resolves.toBe(WAV);
    expect(synthesize).toHaveBeenCalledTimes(2);
    expect(synthesize.mock.calls[0][1]).toMatchObject({ voice: "bogus" });
    expect(synthesize.mock.calls[1][1]).toMatchObject({ voice: undefined });
  });

  it.each(["server", "auth", "timeout"] as const)("a %s failure is not a voice problem: it is passed up and there is no second request", async (category) => {
    const synthesize = vi.fn<ITextToSpeech["synthesize"]>().mockRejectedValue(rejected(category));
    const tts: ITextToSpeech = { name: "stub-tts", synthesize };
    await expect(synthesizeWithVoice(tts, "hi", { voice: "meera" })).rejects.toMatchObject({ category });
    expect(synthesize).toHaveBeenCalledTimes(1);
  });

  it("an invalid_request with NO voice configured is not retried (nothing to fall back from)", async () => {
    const synthesize = vi.fn<ITextToSpeech["synthesize"]>().mockRejectedValue(rejected("invalid_request"));
    const tts: ITextToSpeech = { name: "stub-tts", synthesize };
    await expect(synthesizeWithVoice(tts, "hi", {})).rejects.toMatchObject({ category: "invalid_request" });
    expect(synthesize).toHaveBeenCalledTimes(1);
  });
});
