/** ISpeechToText — the only STT contract the conversation loop depends on. */
export interface SttResult {
  text: string;
  languageCode?: string;
}

export interface ISpeechToText {
  readonly name: string;
  /** audio: raw audio bytes for one utterance (WAV/PCM). */
  transcribe(audio: Buffer, opts?: { languageCode?: string }): Promise<SttResult>;
}
