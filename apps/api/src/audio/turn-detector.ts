/**
 * Energy-based end-of-turn detector for a CONTINUOUS inbound audio stream.
 *
 * Exotel sends ~100 ms frames for the whole call (including silence), so
 * "no frames arrived for N ms" never happens. Instead we measure each
 * frame's loudness and declare the customer's turn over after
 * `endSilenceMs` of quiet following real speech. Timing is derived from
 * the audio itself (bytes / sample rate), not wall-clock, so it is
 * deterministic and testable.
 *
 * Deliberately simple (no ML VAD): a fixed RMS threshold. Tune
 * TURN_ENERGY_THRESHOLD on real phone audio.
 */
import { pcmDurationMs, pcmRms } from "./pcm.js";

export interface TurnDetectorOptions {
  sampleRate: number;
  /** RMS (0..32768) at or above which a frame counts as speech. */
  energyThreshold: number;
  /** Utterances with less voiced audio than this are discarded as noise. */
  minSpeechMs: number;
  /** Quiet time after speech that ends the turn. */
  endSilenceMs: number;
  /** Hard cap: force-end a turn that runs this long. */
  maxUtteranceMs: number;
  /** Quiet audio kept before speech onset so word starts are not clipped. */
  preRollMs: number;
}

export type VadEventKind =
  /** Quiet, no utterance in progress. */
  | "silence"
  /** First loud frame of a new utterance. */
  | "speech_start"
  /** Another loud frame inside the utterance. */
  | "speech"
  /** A quiet frame inside the utterance (end of turn not yet reached). */
  | "pause"
  /** The utterance finished; `utterance` holds its PCM. */
  | "speech_end"
  /** The utterance finished but had too little voiced audio (noise); nothing to transcribe. */
  | "discarded";

export interface VadResult {
  event: VadEventKind;
  utterance?: Buffer;
  /** Voiced audio so far in the current utterance (at the end event: the final total). */
  speechMs: number;
  /** Quiet audio since the last voiced frame. */
  trailingSilenceMs: number;
  /** speech_start only: the pre-roll plus the first voiced frame, i.e. everything the utterance holds so far. */
  leadAudio?: Buffer;
}

export class TurnDetector {
  private preRoll: Array<{ frame: Buffer; ms: number }> = [];
  private preRollTotalMs = 0;
  private chunks: Buffer[] = [];
  private inUtterance = false;
  private speechMs = 0;
  private silenceMs = 0;
  private totalMs = 0;

  constructor(private readonly opts: TurnDetectorOptions) {}

  /** Feed one inbound frame. Returns the finished utterance PCM, or null. */
  push(frame: Buffer): Buffer | null {
    return this.process(frame).utterance ?? null;
  }

  /**
   * Feed one inbound frame and report what it meant. This is the incremental view of the same state machine `push`
   * uses: callers that need speech-start / pause / end events (turn control, barge-in) use this.
   *
   * Memory is bounded: an utterance is force-ended at maxUtteranceMs and pre-roll is capped at preRollMs.
   */
  process(frame: Buffer): VadResult {
    const ms = pcmDurationMs(frame.length, this.opts.sampleRate);
    const isSpeech = pcmRms(frame) >= this.opts.energyThreshold;
    let started = false;

    if (!this.inUtterance) {
      if (!isSpeech) {
        this.preRoll.push({ frame, ms });
        this.preRollTotalMs += ms;
        while (this.preRollTotalMs > this.opts.preRollMs && this.preRoll.length > 0) {
          this.preRollTotalMs -= this.preRoll.shift()!.ms;
        }
        return { event: "silence", speechMs: 0, trailingSilenceMs: 0 };
      }
      this.inUtterance = true;
      started = true;
      this.chunks = this.preRoll.map((p) => p.frame);
      this.totalMs = this.preRollTotalMs;
      this.preRoll = [];
      this.preRollTotalMs = 0;
      this.speechMs = 0;
      this.silenceMs = 0;
    }

    this.chunks.push(frame);
    this.totalMs += ms;
    if (isSpeech) {
      this.speechMs += ms;
      this.silenceMs = 0;
    } else {
      this.silenceMs += ms;
    }

    if (this.silenceMs >= this.opts.endSilenceMs || this.totalMs >= this.opts.maxUtteranceMs) {
      const speechMs = this.speechMs;
      const trailingSilenceMs = this.silenceMs;
      const utterance = speechMs >= this.opts.minSpeechMs ? Buffer.concat(this.chunks) : null;
      this.reset();
      return utterance
        ? { event: "speech_end", utterance, speechMs, trailingSilenceMs }
        : { event: "discarded", speechMs, trailingSilenceMs };
    }
    return {
      event: started ? "speech_start" : isSpeech ? "speech" : "pause",
      speechMs: this.speechMs,
      trailingSilenceMs: this.silenceMs,
      ...(started ? { leadAudio: Buffer.concat(this.chunks) } : {}),
    };
  }

  /** Bytes currently buffered (utterance in progress, or pre-roll). For observability. */
  get bufferedBytes(): number {
    let n = 0;
    for (const c of this.chunks) n += c.length;
    for (const p of this.preRoll) n += p.frame.length;
    return n;
  }

  /** True while the customer is mid-utterance. */
  get speaking(): boolean {
    return this.inUtterance;
  }

  reset(): void {
    this.preRoll = [];
    this.preRollTotalMs = 0;
    this.chunks = [];
    this.inUtterance = false;
    this.speechMs = 0;
    this.silenceMs = 0;
    this.totalMs = 0;
  }
}
