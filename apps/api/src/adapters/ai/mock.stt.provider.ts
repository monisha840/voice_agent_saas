/**
 * Mock STT — for local dev/tests without Sarvam credentials. Never
 * claims to have transcribed anything real; returns a clearly-labeled
 * canned transcript so downstream pipeline logic can be exercised.
 */
import type { ISpeechToText, SttResult } from "./stt.interface.js";

export class MockSttProvider implements ISpeechToText {
  readonly name = "mock-stt";

  async transcribe(_audio: Buffer): Promise<SttResult> {
    return { text: "[mock transcription] Hi, I am interested in a 2 BHK.", languageCode: "en-IN" };
  }
}
