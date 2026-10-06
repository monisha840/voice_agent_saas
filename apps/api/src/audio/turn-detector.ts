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
    const ms = pcmDurationMs(frame.length, this.opts.sampleRate);
    const isSpeech = pcmRms(frame) >= this.opts.energyThreshold;

    if (!this.inUtterance) {
      if (!isSpeech) {
        this.preRoll.push({ frame, ms });
        this.preRollTotalMs += ms;
        while (this.preRollTotalMs > this.opts.preRollMs && this.preRoll.length > 0) {
          this.preRollTotalMs -= this.preRoll.shift()!.ms;
        }
        return null;
      }
      this.inUtterance = true;
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
      const utterance = this.speechMs >= this.opts.minSpeechMs ? Buffer.concat(this.chunks) : null;
      this.reset();
      return utterance;
    }
    return null;
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
