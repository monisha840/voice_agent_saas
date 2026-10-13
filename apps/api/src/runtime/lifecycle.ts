/**
 * Process lifecycle: whether this instance is draining for shutdown, which live call sockets it holds, and which
 * background tasks (post-call finalization) are still running.
 *
 * Shutdown never cuts a conversation off: once draining starts, new work that would create a call is refused (and
 * readiness turns red so the load balancer stops sending traffic) while every live call keeps running until it ends
 * on its own. Only after the drain timeout are the remaining sockets closed with a polite "going away".
 */
import { ServiceUnavailableError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";

export interface LiveSession {
  /** Our call id, for logs. */
  callId: string;
  /** Closes the call's socket politely. Called only if the drain timeout runs out. */
  close(code: number, reason: string): void;
}

export class Lifecycle {
  private draining = false;
  private readonly sessions = new Set<LiveSession>();
  private readonly tasks = new Set<Promise<unknown>>();
  private idleWaiters: Array<() => void> = [];

  isDraining(): boolean {
    return this.draining;
  }

  beginDrain(): void {
    if (this.draining) return;
    this.draining = true;
    logger.info("lifecycle: draining, refusing new calls", { liveCalls: this.sessions.size });
  }

  /** New call creation (outbound API, inbound webhook) goes through this so a draining instance takes no new calls. */
  assertAcceptingCalls(): void {
    if (this.draining) throw new ServiceUnavailableError("This server is shutting down; try again shortly.", "SHUTTING_DOWN");
  }

  /** Registers a live call socket; the returned function unregisters it (call it when the socket closes). */
  registerSession(session: LiveSession): () => void {
    this.sessions.add(session);
    return () => {
      this.sessions.delete(session);
      if (this.sessions.size === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const w of waiters) w();
      }
    };
  }

  liveCallCount(): number {
    return this.sessions.size;
  }

  /** Background work that must finish before the process exits (the promise must not reject). */
  trackTask(task: Promise<unknown>): void {
    const tracked = task.finally(() => this.tasks.delete(tracked));
    this.tasks.add(tracked);
  }

  /**
   * Waits for live calls to end by themselves, up to `timeoutMs`; then closes whatever is left (1001 going away)
   * and waits briefly for them to unregister. Finally lets background tasks finish, bounded by `taskTimeoutMs`.
   */
  async drain(opts: { timeoutMs: number; taskTimeoutMs?: number }): Promise<{ forcedClosed: number }> {
    this.beginDrain();
    let forcedClosed = 0;
    if (this.sessions.size > 0) {
      const ended = await this.waitUntilIdle(opts.timeoutMs);
      if (!ended) {
        forcedClosed = this.sessions.size;
        logger.warn("lifecycle: drain timeout, closing live calls", { liveCalls: forcedClosed });
        for (const s of [...this.sessions]) {
          try {
            s.close(1001, "server shutting down");
          } catch {
            // already closing
          }
        }
        await this.waitUntilIdle(2_000);
      }
    }
    if (this.tasks.size > 0) {
      await Promise.race([Promise.allSettled([...this.tasks]), new Promise((r) => setTimeout(r, opts.taskTimeoutMs ?? 10_000).unref())]);
    }
    return { forcedClosed };
  }

  private waitUntilIdle(timeoutMs: number): Promise<boolean> {
    if (this.sessions.size === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.idleWaiters = this.idleWaiters.filter((w) => w !== onIdle);
        resolve(false);
      }, timeoutMs);
      timer.unref();
      const onIdle = () => {
        clearTimeout(timer);
        resolve(true);
      };
      this.idleWaiters.push(onIdle);
    });
  }

  /** Test helper: back to a fresh, accepting state. */
  reset(): void {
    this.draining = false;
    this.sessions.clear();
    this.tasks.clear();
    this.idleWaiters = [];
  }
}

export const lifecycle = new Lifecycle();
