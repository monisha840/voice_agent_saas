/**
 * Circuit breaker for AI providers.
 *
 *   closed     normal. Provider-health failures are counted; `failureThreshold` in a row open the circuit.
 *   open       calls fail immediately with CircuitOpenError (nothing is sent to the unhealthy provider) until
 *              `cooldownMs` has passed.
 *   half_open  after the cooldown, up to `halfOpenMaxProbes` calls are let through as probes. A successful probe
 *              closes the circuit; a failed probe re-opens it (and restarts the cooldown). Other callers still fail fast.
 *
 * The interface (`CircuitBreaker`) is async and ticket-based so a shared implementation (state in Redis or the
 * database, for several API instances) can replace InMemoryCircuitBreaker without touching any caller. The in-memory
 * one is per process, which is right for the current single-process deployment: each instance learns about an outage
 * independently.
 */
import { CircuitOpenError } from "../../shared/errors.js";
import { logger } from "../../shared/logger.js";

export type CircuitState = "closed" | "open" | "half_open";

/** What happened to one admitted call. Exactly one of the three must be called. */
export interface CircuitTicket {
  /** The provider answered correctly. */
  success(): Promise<void>;
  /** The provider looks unhealthy (timeout, network error, 5xx, unusable response). */
  failure(): Promise<void>;
  /** The call says nothing about provider health (cancelled, bad credentials, a bug of ours). */
  release(): Promise<void>;
}

export interface CircuitSnapshot {
  state: CircuitState;
  consecutiveFailures: number;
}

export interface CircuitBreaker {
  readonly name: string;
  /** Admits the call and returns its ticket, or throws CircuitOpenError. */
  acquire(operation?: string): Promise<CircuitTicket>;
  snapshot(): Promise<CircuitSnapshot>;
}

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  /** Probe calls allowed at once while half-open. Default 1. */
  halfOpenMaxProbes?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class InMemoryCircuitBreaker implements CircuitBreaker {
  private state: CircuitState = "closed";
  private failures = 0;
  private openedAt = 0;
  private probesInFlight = 0;
  /** Bumped on every state change so a ticket that outlives its state cannot corrupt the new one. */
  private epoch = 0;
  private readonly now: () => number;
  private readonly maxProbes: number;

  constructor(
    readonly name: string,
    private readonly opts: CircuitBreakerOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.maxProbes = opts.halfOpenMaxProbes ?? 1;
  }

  async snapshot(): Promise<CircuitSnapshot> {
    this.advance();
    return { state: this.state, consecutiveFailures: this.failures };
  }

  async acquire(operation?: string): Promise<CircuitTicket> {
    this.advance();
    if (this.state === "open") {
      throw new CircuitOpenError(this.name, operation, Math.max(0, this.openedAt + this.opts.cooldownMs - this.now()));
    }
    if (this.state === "half_open") {
      if (this.probesInFlight >= this.maxProbes) throw new CircuitOpenError(this.name, operation, 1_000);
      this.probesInFlight++;
      return this.ticket(this.epoch, true);
    }
    return this.ticket(this.epoch, false);
  }

  /** open -> half_open once the cooldown has passed. */
  private advance(): void {
    if (this.state === "open" && this.now() - this.openedAt >= this.opts.cooldownMs) {
      this.transition("half_open");
    }
  }

  private transition(next: CircuitState): void {
    if (this.state === next) return;
    const previous = this.state;
    this.state = next;
    this.epoch++;
    this.probesInFlight = 0;
    if (next === "open") this.openedAt = this.now();
    if (next === "closed") this.failures = 0;
    logger.warn("provider circuit breaker state change", { provider: this.name, from: previous, to: next, consecutiveFailures: this.failures });
  }

  private ticket(epoch: number, probe: boolean): CircuitTicket {
    let settled = false;
    const settle = (fn: () => void) => async () => {
      if (settled) return;
      settled = true;
      if (epoch !== this.epoch) return; // the circuit moved on while this call was running
      fn();
    };
    return {
      success: settle(() => {
        if (probe) this.transition("closed");
        else this.failures = 0;
      }),
      failure: settle(() => {
        if (probe) {
          this.transition("open");
        } else if (++this.failures >= this.opts.failureThreshold) {
          this.transition("open");
        }
      }),
      release: settle(() => {
        if (probe) this.probesInFlight = Math.max(0, this.probesInFlight - 1);
      }),
    };
  }
}

const breakers = new Map<string, CircuitBreaker>();

/**
 * One breaker per provider endpoint (named after the provider, which is already per capability: "sarvam-105b",
 * "sarvam-saaras", "sarvam-bulbul"), so a TTS outage never stops the LLM. Thresholds come from configuration.
 */
export function getCircuitBreaker(name: string, make: () => CircuitBreaker): CircuitBreaker {
  let b = breakers.get(name);
  if (!b) {
    b = make();
    breakers.set(name, b);
  }
  return b;
}

/** Test helper. */
export function resetCircuitBreakers(): void {
  breakers.clear();
}
