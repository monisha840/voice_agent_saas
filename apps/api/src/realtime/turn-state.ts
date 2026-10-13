/**
 * The explicit turn state machine for one live call.
 *
 *   IDLE ─speech─▶ USER_SPEAKING ─pause─▶ USER_SILENCE ─end of speech─▶ PROCESSING ─audio─▶ AI_SPEAKING ─▶ IDLE
 *                       ▲                      │                            │                  │
 *                       └── speech resumes ────┘                            └──── barge-in ────┤
 *                       ▲                                                                      ▼
 *                       └──────────────────────────── INTERRUPTED ◀───────────────────────────┘
 *
 * PROCESSING covers everything between "the caller finished" and "the first audio is going out" (STT, LLM, tools,
 * TTS). A turn the agent starts on its own (greeting, a guard line) goes IDLE → PROCESSING/AI_SPEAKING directly.
 * INTERRUPTED is transient: it exists so cancellation has a single place to happen, then moves on.
 *
 * Illegal transitions are refused (returns false) rather than thrown: a bug must never crash a live call.
 */
export type TurnState = "IDLE" | "USER_SPEAKING" | "USER_SILENCE" | "PROCESSING" | "AI_SPEAKING" | "INTERRUPTED" | "CLOSED";

const ALLOWED: Record<TurnState, readonly TurnState[]> = {
  IDLE: ["USER_SPEAKING", "PROCESSING", "AI_SPEAKING", "CLOSED"],
  USER_SPEAKING: ["USER_SILENCE", "PROCESSING", "IDLE", "CLOSED"],
  USER_SILENCE: ["USER_SPEAKING", "PROCESSING", "IDLE", "CLOSED"],
  PROCESSING: ["AI_SPEAKING", "IDLE", "INTERRUPTED", "CLOSED"],
  AI_SPEAKING: ["IDLE", "INTERRUPTED", "CLOSED"],
  INTERRUPTED: ["USER_SPEAKING", "IDLE", "CLOSED"],
  CLOSED: [],
};

export interface StateChange {
  from: TurnState;
  to: TurnState;
  reason: string;
}

const HISTORY_LIMIT = 32;

export class TurnStateMachine {
  private current: TurnState = "IDLE";
  private readonly log: StateChange[] = [];

  constructor(private readonly onChange?: (change: StateChange) => void) {}

  get state(): TurnState {
    return this.current;
  }

  /** The most recent transitions (bounded), oldest first. For tests and diagnostics. */
  get history(): readonly StateChange[] {
    return this.log;
  }

  canTransition(to: TurnState): boolean {
    return ALLOWED[this.current].includes(to);
  }

  /** Moves to `to`. Same-state is a no-op that returns true; an illegal move changes nothing and returns false. */
  transition(to: TurnState, reason: string): boolean {
    if (to === this.current) return true;
    if (!this.canTransition(to)) return false;
    const change = { from: this.current, to, reason };
    this.current = to;
    this.log.push(change);
    if (this.log.length > HISTORY_LIMIT) this.log.shift();
    this.onChange?.(change);
    return true;
  }
}
