/**
 * Speaking with the agent's configured voice, without letting a bad voice name silence the agent.
 *
 * The voice is a free-form, provider-specific speaker name stored on the agent. If the provider cannot honour it (it
 * says "invalid request"), the agent would otherwise fail every utterance. So that one failure is answered with a
 * second attempt on the provider's default voice, and the problem is logged so it can be fixed. Every other failure
 * (timeouts, outages, auth) is NOT a voice problem and is passed up untouched.
 */
import { ProviderRequestError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";
import type { ITextToSpeech, TtsOptions, TtsResult } from "./tts.interface.js";

export async function synthesizeWithVoice(tts: ITextToSpeech, text: string, opts: TtsOptions = {}): Promise<TtsResult> {
  // A provider that does not do voice selection never receives one.
  const voice = tts.capabilities?.voiceSelection === false ? undefined : opts.voice;
  try {
    return await tts.synthesize(text, { ...opts, voice });
  } catch (err) {
    if (voice && err instanceof ProviderRequestError && err.category === "invalid_request") {
      logger.warn("tts: configured voice was rejected by the provider, using its default voice", {
        provider: err.provider,
        voice,
        callId: opts.callId,
      });
      return tts.synthesize(text, { ...opts, voice: undefined });
    }
    throw err;
  }
}
