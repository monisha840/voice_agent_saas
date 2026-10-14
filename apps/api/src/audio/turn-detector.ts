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
 * Deliberately simple (no ML VAD): an RMS threshold. The base threshold (TURN_ENERGY_THRESHOLD) is fixed; with
 * `floorMultiplier` set it rises with the room: speech must also exceed the recent noise floor by that factor, so a
 * constant hum, a fan or a TV in the background does not count as the caller speaking. The floor is a low percentile of
 * the last few seconds of frame loudness (speech has pauses, a room does not), and the adaptive threshold is capped so
 * a quiet caller in a loud room can still be heard. Tune on real phone audio.
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
  /**
   * Adaptive threshold: a frame is speech only if its RMS is also at least this many times the noise floor. 0 or
   * absent = the fixed `energyThreshold` alone (the original behaviour).
   */
  floorMultiplier?: number;
  /** The adaptive threshold never goes above this RMS. Default 1500. */
  maxAdaptiveThreshold?: number;
  /** How much recent audio the noise floor is estimated from. Default 8000 ms. */
  floorWindowMs?: number;
}

/** The noise floor is a low percentile of recent frame loudness. */
const FLOOR_PERCENTILE = 0.2;
/** No floor is claimed until this much audio has been seen. */
const FLOOR_MIN_AUDIO_MS = 1000;

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
  /** The room's noise floor (RMS) as estimated now; 0 while it is not yet known. */
  noiseFloor?: number;
  /** Mean RMS of the voiced frames of the current utterance (0 when there are none). */
  voicedRms?: number;
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
  /** Loudness of the most recent audio, for the noise floor. Bounded by `floorWindowMs`. */
  private recent: Array<{ rms: number; ms: number }> = [];
  private recentMs = 0;
  private floor = 0;
  private framesSinceFloor = 0;
  private voicedRmsSum = 0;
  private voicedFrames = 0;

  constructor(private readonly opts: TurnDetectorOptions) {}

  /** The current noise floor estimate (RMS); 0 while unknown. */
  get noiseFloor(): number {
    return this.floor;
  }

  /** The RMS a frame must reach to count as speech right now. */
  get threshold(): number {
    const { energyThreshold, floorMultiplier = 0, maxAdaptiveThreshold = 1500 } = this.opts;
    if (floorMultiplier <= 0 || this.floor <= 0) return energyThreshold;
    return Math.max(energyThreshold, Math.min(this.floor * floorMultiplier, Math.max(energyThreshold, maxAdaptiveThreshold)));
  }

  private observe(rms: number, ms: number): void {
    if ((this.opts.floorMultiplier ?? 0) <= 0) return;
    this.recent.push({ rms, ms });
    this.recentMs += ms;
    const window = this.opts.floorWindowMs ?? 8000;
    while (this.recentMs > window && this.recent.length > 1) this.recentMs -= this.recent.shift()!.ms;
    if (this.recentMs < FLOOR_MIN_AUDIO_MS) return;
    // Re-estimating every frame is wasteful; every few frames is as good (the window is seconds long).
    if (++this.framesSinceFloor < 5) return;
    this.framesSinceFloor = 0;
    const sorted = this.recent.map((r) => r.rms).sort((a, b) => a - b);
    this.floor = sorted[Math.floor(FLOOR_PERCENTILE * (sorted.length - 1))];
  }

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
    const rms = pcmRms(frame);
    // Classified against the room as it was BEFORE this frame, so a loud frame cannot raise its own bar.
    const isSpeech = rms >= this.threshold;
    this.observe(rms, ms);
    const noiseFloor = this.floor;
    let started = false;

    if (!this.inUtterance) {
      if (!isSpeech) {
        this.preRoll.push({ frame, ms });
        this.preRollTotalMs += ms;
        while (this.preRollTotalMs > this.opts.preRollMs && this.preRoll.length > 0) {
          this.preRollTotalMs -= this.preRoll.shift()!.ms;
        }
        return { event: "silence", speechMs: 0, trailingSilenceMs: 0, noiseFloor, voicedRms: 0 };
      }
      this.inUtterance = true;
      started = true;
      this.chunks = this.preRoll.map((p) => p.frame);
      this.totalMs = this.preRollTotalMs;
      this.preRoll = [];
      this.preRollTotalMs = 0;
      this.speechMs = 0;
      this.silenceMs = 0;
      this.voicedRmsSum = 0;
      this.voicedFrames = 0;
    }

    this.chunks.push(frame);
    this.totalMs += ms;
    if (isSpeech) {
      this.speechMs += ms;
      this.silenceMs = 0;
      this.voicedRmsSum += rms;
      this.voicedFrames++;
    } else {
      this.silenceMs += ms;
    }

    if (this.silenceMs >= this.opts.endSilenceMs || this.totalMs >= this.opts.maxUtteranceMs) {
      const speechMs = this.speechMs;
      const trailingSilenceMs = this.silenceMs;
      const voicedRms = this.voicedFrames > 0 ? this.voicedRmsSum / this.voicedFrames : 0;
      const utterance = speechMs >= this.opts.minSpeechMs ? Buffer.concat(this.chunks) : null;
      this.reset();
      return utterance
        ? { event: "speech_end", utterance, speechMs, trailingSilenceMs, noiseFloor, voicedRms }
        : { event: "discarded", speechMs, trailingSilenceMs, noiseFloor, voicedRms };
    }
    return {
      event: started ? "speech_start" : isSpeech ? "speech" : "pause",
      speechMs: this.speechMs,
      trailingSilenceMs: this.silenceMs,
      noiseFloor,
      voicedRms: this.voicedFrames > 0 ? this.voicedRmsSum / this.voicedFrames : 0,
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
    this.voicedRmsSum = 0;
    this.voicedFrames = 0;
    // The noise floor describes the room, not the utterance: it is kept.
  }
}
