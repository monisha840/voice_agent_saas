/**
 * Per-call time guards for the media-stream handler: a hard cap on call length and a silence timeout.
 *
 * Both are cost protection. A call that nobody is talking on, or that simply never ends, would otherwise keep
 * telephony and provider minutes running until the stale-call reaper notices (45 minutes by default).
 *
 * The guard only owns the timers; what happens when one fires (speak a line, close the socket) is the handler's
 * business and is passed in as callbacks. The numbers are captured when the call starts: a running call keeps the
 * limits it began with, whatever the configuration says later.
 */

export interface CallGuardOptions {
  /** 0 disables the cap. */
  maxDurationMs: number;
  /** 0 disables the silence timeout. */
  silenceTimeoutMs: number;
  /** "Are you still there?" prompts allowed before the call is ended for silence. */
  maxReprompts: number;
  /** The silence timer expired and the reprompt budget is not used up. The handler should speak, then call armSilence(). */
  onReprompt: () => void | Promise<void>;
  /** The silence timer expired with the reprompt budget used up. */
  onSilenceEnd: () => void | Promise<void>;
  /** The call has run for maxDurationMs. */
  onMaxDuration: () => void | Promise<void>;
}

export class CallGuard {
  private durationTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private reprompts = 0;
  private stopped = false;

  constructor(private readonly opts: CallGuardOptions) {}

  /** Starts the call-length clock. Call once, when the call is answered. */
  start(): void {
    if (this.stopped || this.durationTimer || this.opts.maxDurationMs <= 0) return;
    this.durationTimer = setTimeout(() => this.fire(this.opts.onMaxDuration), this.opts.maxDurationMs);
    this.durationTimer.unref?.();
  }

  /** The agent finished speaking and now waits for the customer: (re)start the silence timer. */
  armSilence(): void {
    this.clearSilence();
    if (this.stopped || this.opts.silenceTimeoutMs <= 0) return;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      if (this.reprompts < this.opts.maxReprompts) {
        this.reprompts++;
        this.fire(this.opts.onReprompt);
      } else {
        this.fire(this.opts.onSilenceEnd);
      }
    }, this.opts.silenceTimeoutMs);
    this.silenceTimer.unref?.();
  }

  /** The agent or the pipeline is busy (speaking, transcribing): silence is not the customer's fault. */
  disarmSilence(): void {
    this.clearSilence();
  }

  /** The customer said something: the next stretch of silence starts with a fresh reprompt budget. */
  heardCustomer(): void {
    this.reprompts = 0;
    this.clearSilence();
  }

  /** Clears every timer; the guard never fires again. */
  stop(): void {
    this.stopped = true;
    if (this.durationTimer) clearTimeout(this.durationTimer);
    this.durationTimer = null;
    this.clearSilence();
  }

  private clearSilence(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
  }

  private fire(callback: () => void | Promise<void>): void {
    if (this.stopped) return;
    void Promise.resolve()
      .then(callback)
      .catch(() => undefined); // a failing callback must never become an unhandled rejection that takes the process down
  }
}

/** What the agent says before a guard ends the call. Plain English: these are operational lines, not agent persona. */
export const GUARD_LINES = {
  reprompt: "Are you still there?",
  silenceEnd: "I'm not able to hear you, so I'll end the call now. Goodbye.",
  maxDuration: "We've reached the maximum time for this call, so I'll end it here. Thank you, and goodbye.",
} as const;
