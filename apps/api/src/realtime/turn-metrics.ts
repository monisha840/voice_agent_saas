/**
 * Per-turn timing record. Timestamps are epoch milliseconds from the controller's clock. The record holds timings,
 * identifiers and outcome flags ONLY: never audio, transcripts, prompts or credentials.
 */
export type TurnStage =
  | "speechStart"
  | "speechEnd"
  | "sttSessionStart"
  | "sttStart"
  | "firstPartial"
  | "finalTranscript"
  | "sttEnd"
  | "llmStart"
  | "llmHopStart"
  | "llmFirstToken"
  | "llmFirstChunk"
  | "llmEnd"
  | "ttsStart"
  | "ttsFirstAudio"
  | "ttsEnd"
  | "firstAudioByte";

export type TurnKind = "user" | "ai";

export type TurnOutcome = "completed" | "empty" | "cancelled" | "interrupted" | "error";

export interface TurnIds {
  callId: string;
  agentId?: string;
  organizationId?: string;
}

export class TurnMetrics {
  readonly stamps: Partial<Record<TurnStage, number>> = {};
  startedAt: number;
  endedAt?: number;
  outcome?: TurnOutcome;
  interrupted = false;
  cancelled = false;
  errorName?: string;
  /** Caller utterances dropped by backpressure while this turn was in flight. */
  droppedUtterances = 0;
  /** Streaming STT: interim transcripts seen for this turn's utterance (their text is never kept). */
  sttPartials?: number;
  /** Streaming STT: the final transcript was empty (no recognisable speech). */
  sttEmpty?: boolean;
  /** Audio levels of this turn's utterance (RMS 0..32768): the room's noise floor and the caller's voiced level. Numbers only. */
  noiseFloor?: number;
  voicedRms?: number;
  /** Which STT provider produced this turn's transcript (benchmark label). */
  sttProvider?: string;
  /** Provider failure category when the turn failed (timeout, network, auth, ...). */
  errorCategory?: string;
  /** LLM: model requests made this turn (1 + one per tool round), tool calls requested, and the size of the LAST reply. */
  llmHops?: number;
  llmToolCalls?: number;
  llmChunks?: number;
  llmChars?: number;
  llmStreamed?: boolean;
  llmFinishReason?: string;
  llmCompletionToks?: number;
  /** TTS: the reply was spoken sentence by sentence while the model was still generating (streaming TTS). */
  ttsStreamed?: boolean;
  /** Streaming TTS: sentences submitted, and the duration of the audio received for them. */
  ttsSentences?: number;
  ttsAudioMs?: number;
  /** Streaming TTS failed before any audio and the reply was produced another way ("voice" = default voice, "batch"). */
  ttsFallback?: string;

  constructor(
    readonly turnId: string,
    readonly kind: TurnKind,
    readonly ids: TurnIds,
    private readonly now: () => number,
  ) {
    this.startedAt = now();
  }

  /** Overwrites a stage: for stages that describe the LAST of several repeated steps (the final model request). */
  set(stage: TurnStage, at: number = this.now()): void {
    this.stamps[stage] = at;
  }

  /** Records a stage the first time it happens; later marks of the same stage are ignored. */
  mark(stage: TurnStage, at: number = this.now()): void {
    if (this.stamps[stage] === undefined) this.stamps[stage] = at;
  }

  private span(from: TurnStage, to: TurnStage): number | undefined {
    const a = this.stamps[from];
    const b = this.stamps[to];
    return a !== undefined && b !== undefined ? Math.max(0, b - a) : undefined;
  }

  /** Derived latencies in ms (undefined = that stage never happened). */
  summary() {
    const end = this.endedAt ?? this.now();
    return {
      turnId: this.turnId,
      kind: this.kind,
      ...this.ids,
      outcome: this.outcome,
      interrupted: this.interrupted,
      cancelled: this.cancelled,
      errorName: this.errorName,
      errorCategory: this.errorCategory,
      sttProvider: this.sttProvider,
      droppedUtterances: this.droppedUtterances || undefined,
      userSpeechMs: this.span("speechStart", "speechEnd"),
      noiseFloor: this.noiseFloor !== undefined ? Math.round(this.noiseFloor) : undefined,
      voicedRms: this.voicedRms !== undefined ? Math.round(this.voicedRms) : undefined,
      sttMs: this.span("sttStart", "sttEnd"),
      speechEndToSttEndMs: this.span("speechEnd", "sttEnd"),
      sttPartials: this.sttPartials,
      sttEmpty: this.sttEmpty,
      speechStartToFirstPartialMs: this.span("speechStart", "firstPartial"),
      speechEndToFinalMs: this.span("speechEnd", "finalTranscript"),
      sttTurnMs: this.span("speechStart", "finalTranscript"),
      sttSessionToFinalMs: this.span("sttSessionStart", "finalTranscript"),
      sttFinalToLlmStartMs: this.span("sttEnd", "llmStart"),
      llmMs: this.span("llmStart", "llmEnd"),
      llmToFirstDeltaMs: this.span("llmHopStart", "llmFirstToken"),
      llmFirstDeltaToFirstChunkMs: this.span("llmFirstToken", "llmFirstChunk"),
      llmHops: this.llmHops,
      llmToolCalls: this.llmToolCalls,
      llmChunks: this.llmChunks,
      llmChars: this.llmChars,
      llmStreamed: this.llmStreamed,
      llmFinishReason: this.llmFinishReason,
      llmCompletionToks: this.llmCompletionToks,
      ttsStreamed: this.ttsStreamed,
      ttsSentences: this.ttsSentences,
      ttsAudioMs: this.ttsAudioMs,
      ttsFallback: this.ttsFallback,
      llmChunkToTtsFirstAudioMs: this.span("llmFirstChunk", "ttsFirstAudio"),
      ttsFirstAudioMs: this.span("ttsStart", "ttsFirstAudio"),
      ttsAudioMsToCaller: this.span("ttsFirstAudio", "firstAudioByte"),
      llmEndToTtsEndMs: this.span("llmEnd", "ttsEnd"),
      ttsStartedBeforeLlmEnd:
        this.stamps.ttsStart !== undefined && this.stamps.llmEnd !== undefined ? this.stamps.ttsStart < this.stamps.llmEnd : undefined,
      ttsMs: this.span("ttsStart", "ttsEnd"),
      ttsToFirstAudioMs: this.span("ttsStart", "firstAudioByte"),
      speechEndToFirstAudioMs: this.span("speechEnd", "firstAudioByte"),
      turnMs: Math.max(0, end - this.startedAt),
    };
  }
}
