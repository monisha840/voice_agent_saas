/**
 * Hearing an agent's voice before saving it. The call path quietly falls back to the provider's default voice when a
 * speaker name is rejected (so a typo never silences a live call), which also means a wrong name looks like "nothing
 * changed": the agent keeps the default (male) voice. The preview calls the provider directly, with no fallback, so a
 * name it does not know is reported as such.
 */
import { z } from "zod";
import { getTtsProvider } from "../../adapters/ai/index.js";
import { ProviderRequestError } from "../../shared/errors.js";
import { ValidationError } from "../../shared/errors.js";
import { assertCan } from "../../auth/access.js";
import type { RequestContext } from "../../auth/context.js";
import { parseInput } from "../../shared/validation.js";

const body = z
  .object({
    voice: z.string().trim().min(1).max(80),
    language: z.string().trim().min(2).max(10).optional(),
  })
  .strict();

/**
 * The sample sentence per language. The editor only offers en-IN and ta-IN (SUPPORTED_LANGUAGES); the Hindi sample is
 * kept because a call can still run in Hindi at runtime (the caller asks to switch), so hearing whether a voice copes
 * with Devanagari is still useful. Anything not listed falls back to the English sample.
 */
const SAMPLE: Record<string, string> = {
  "en-IN": "Hello, this is your property assistant from Green Valley Developers. How can I help you today?",
  "ta-IN": "வணக்கம், நான் Green Valley Developers-ல இருந்து பேசுறேன். உங்களுக்கு எப்படி உதவ முடியும்?",
  "hi-IN": "नमस्ते, मैं ग्रीन वैली डेवलपर्स की ओर से बात कर रही हूँ। मैं आपकी कैसे मदद कर सकती हूँ?",
};

export interface VoicePreview {
  voice: string;
  languageCode: string;
  /** WAV (or the provider's format) audio, base64. */
  audioBase64: string;
  format: string;
}

export const voicePreviewService = {
  async preview(ctx: RequestContext, input: unknown): Promise<VoicePreview> {
    assertCan(ctx, "agents:manage");
    const { voice, language } = parseInput(body, input);
    const languageCode = language && SAMPLE[language] ? language : "en-IN";
    try {
      const result = await getTtsProvider().synthesize(SAMPLE[languageCode], { voice, languageCode, sampleRate: 8000 });
      return { voice, languageCode, audioBase64: Buffer.from(result.audio).toString("base64"), format: result.format };
    } catch (err) {
      if (err instanceof ProviderRequestError && err.category === "invalid_request") {
        throw new ValidationError(`The speech provider does not know a voice called "${voice}". Check the spelling; the agent would use the default voice instead.`);
      }
      throw err;
    }
  },
};
