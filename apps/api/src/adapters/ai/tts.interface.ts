/** ITextToSpeech — the only TTS contract the conversation loop depends on. */
export interface TtsResult {
  /** Raw audio bytes (decoded from the provider's response). */
  audio: Buffer;
  format: "wav" | "mp3";
}

export interface ITextToSpeech {
  readonly name: string;
  /** `sampleRate`: preferred output rate in Hz (Exotel needs 8000 by default). */
  synthesize(text: string, opts?: { languageCode?: string; sampleRate?: number }): Promise<TtsResult>;
}
