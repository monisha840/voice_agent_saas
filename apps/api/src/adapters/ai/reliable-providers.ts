/**
 * Decorators that put the reliability layer (timeout, retry of transient failures, cancellation, circuit breaker)
 * around ANY STT / LLM / TTS provider. The provider factory (index.ts) applies them, so conversation code, the media
 * stream handler and every future adapter get identical behaviour without knowing it exists, and no adapter has to
 * re-implement retries.
 *
 * Settings are read from configuration on every call, so they follow the environment; the circuit breaker for a
 * provider is created on first use and shared by all calls to that provider in this process.
 */
import { getConfig } from "../../config/env.js";
import { getCircuitBreaker, InMemoryCircuitBreaker } from "./circuit-breaker.js";
import { callWithReliability } from "./reliability.js";
import type { ChatMessage, ChatResult, ILanguageModel, LlmStreamHandlers, ToolDefinition } from "./llm.interface.js";
import type { ProviderCallOptions, ProviderCapabilities } from "./provider-common.js";
import type { ISpeechToText, SttResult, SttStreamHandlers, SttStreamingSession, SttStreamOptions } from "./stt.interface.js";
import type { ITextToSpeech, TtsOptions, TtsResult, TtsStreamHandlers, TtsStreamingSession, TtsStreamOptions } from "./tts.interface.js";
import { ProviderRequestError } from "../../shared/errors.js";

type Kind = "stt" | "llm" | "tts";

function run<T>(
  provider: string,
  operation: string,
  kind: Kind,
  opts: ProviderCallOptions | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
  canRetry?: () => boolean,
): Promise<T> {
  const p = getConfig().providers;
  const timeoutMs = kind === "stt" ? p.sttTimeoutMs : kind === "llm" ? p.llmTimeoutMs : p.ttsTimeoutMs;
  return callWithReliability(
    {
      provider,
      operation,
      timeoutMs,
      totalBudgetMs: p.totalBudgetMs,
      retry: { maxAttempts: p.maxAttempts, baseDelayMs: p.retryBaseDelayMs, maxDelayMs: p.retryMaxDelayMs },
      breaker: getCircuitBreaker(
        provider,
        () => new InMemoryCircuitBreaker(provider, { failureThreshold: p.breakerFailureThreshold, cooldownMs: p.breakerCooldownMs }),
      ),
      signal: opts?.signal,
      callId: opts?.callId,
      canRetry,
    },
    fn,
  );
}

export class ReliableSpeechToText implements ISpeechToText {
  /** Defined only when the wrapped provider can stream (assigned in the constructor, after `inner` is set). */
  readonly startStreaming?: ISpeechToText["startStreaming"];

  constructor(private readonly inner: ISpeechToText) {
    if (inner.startStreaming) this.startStreaming = (handlers, opts) => this.streamWithBreaker(handlers, opts);
  }
  get name(): string {
    return this.inner.name;
  }
  get capabilities(): ProviderCapabilities | undefined {
    return this.inner.capabilities;
  }
  transcribe(audio: Buffer, opts?: ProviderCallOptions & { languageCode?: string }): Promise<SttResult> {
    return run(this.inner.name, "stt.transcribe", "stt", opts, (signal) => this.inner.transcribe(audio, { ...opts, signal }));
  }

  /**
   * Streaming sessions get the circuit breaker (fail fast while the provider is unhealthy; connect failures and
   * provider errors count toward opening it) but NOT retries: a live stream cannot be replayed (audio is gone and a
   * repeated utterance would duplicate a turn). Timeouts are the adapter's own (connect timeout) and the coordinator's
   * (final-transcript timeout). Defined only when the wrapped provider can stream.
   */
  private streamWithBreaker = async (handlers: SttStreamHandlers, opts: SttStreamOptions): Promise<SttStreamingSession> => {
        const p = getConfig().providers;
        const provider = this.inner.name;
        const breaker = getCircuitBreaker(
          provider,
          () => new InMemoryCircuitBreaker(provider, { failureThreshold: p.breakerFailureThreshold, cooldownMs: p.breakerCooldownMs }),
        );
        const ticket = await breaker.acquire("stt.stream"); // throws CircuitOpenError: nothing is opened
        let settled = false;
        const settle = (kind: "success" | "failure" | "release") => {
          if (settled) return;
          settled = true;
          void ticket[kind]().catch(() => undefined);
        };
        try {
          return await this.inner.startStreaming!(
            {
              onPartial: (e) => {
                settle("success");
                handlers.onPartial(e);
              },
              onFinal: (e) => {
                settle("success");
                handlers.onFinal(e);
              },
              onError: (err) => {
                const c = err.category;
                settle(c === "timeout" || c === "network" || c === "server" || c === "bad_response" ? "failure" : "release");
                handlers.onError(err);
              },
              onClose: () => {
                settle("release"); // closed without evidence either way (e.g. cancelled before any transcript)
                handlers.onClose();
              },
            },
            opts,
          );
        } catch (err) {
          settle("release");
          throw err;
        }
  };
}

export class ReliableLanguageModel implements ILanguageModel {
  /** Defined only when the wrapped provider can stream (assigned in the constructor, after `inner` is set). */
  readonly chatStream?: ILanguageModel["chatStream"];

  constructor(private readonly inner: ILanguageModel) {
    if (inner.chatStream) this.chatStream = (messages, tools, handlers, opts) => this.streamReliably(messages, tools, handlers, opts);
  }
  get name(): string {
    return this.inner.name;
  }
  get capabilities(): ProviderCapabilities | undefined {
    return this.inner.capabilities;
  }
  chat(messages: ChatMessage[], tools: ToolDefinition[], opts?: ProviderCallOptions): Promise<ChatResult> {
    return run(this.inner.name, "llm.chat", "llm", opts, (signal) => this.inner.chat(messages, tools, { ...opts, signal }));
  }

  /**
   * A streaming generation gets the same timeout (per attempt = total generation time), cancellation and circuit
   * breaker as chat(). Retries are different: a stream that has already delivered text to the caller is NEVER retried
   * (the caller would hear it twice, or from a different start); only a failure before the first delta is repeated,
   * and only for transient categories. Tool calls are not part of the stream's deliveries (they come back in the
   * result), so nothing can have been executed by then.
   */
  private streamReliably = (messages: ChatMessage[], tools: ToolDefinition[], handlers: LlmStreamHandlers, opts?: ProviderCallOptions): Promise<ChatResult> => {
    let delivered = false;
    const tracked: LlmStreamHandlers = {
      onTextDelta: (text) => {
        delivered = true;
        handlers.onTextDelta(text);
      },
    };
    return run(
      this.inner.name,
      "llm.stream",
      "llm",
      opts,
      (signal) => this.inner.chatStream!(messages, tools, tracked, { ...opts, signal }),
      () => !delivered,
    );
  };
}

export class ReliableTextToSpeech implements ITextToSpeech {
  /** Defined only when the wrapped provider can stream (assigned in the constructor, after `inner` is set). */
  readonly startStreaming?: ITextToSpeech["startStreaming"];

  constructor(private readonly inner: ITextToSpeech) {
    if (inner.startStreaming) this.startStreaming = (handlers, opts) => this.streamReliably(handlers, opts);
  }
  get name(): string {
    return this.inner.name;
  }
  get capabilities(): ProviderCapabilities | undefined {
    return this.inner.capabilities;
  }
  synthesize(text: string, opts?: TtsOptions): Promise<TtsResult> {
    return run(this.inner.name, "tts.synthesize", "tts", opts, (signal) => this.inner.synthesize(text, { ...opts, signal }));
  }

  /**
   * A streaming session gets the circuit breaker (fail fast while the provider is unhealthy; connect failures, stalls and
   * provider errors count toward opening it) and a STALL timeout (no audio / completion for `ttsTimeoutMs` while text
   * is waiting to be synthesized) but NOT retries: audio already played cannot be replayed, and re-sending text would
   * make the caller hear it twice. Whether a failed stream may be repeated (nothing was heard yet) is the caller's
   * decision, because only the caller knows what it has delivered. Cancellation is the adapter's (it watches the
   * signal) and is enforced here too.
   */
  private streamReliably = async (handlers: TtsStreamHandlers, opts: TtsStreamOptions): Promise<TtsStreamingSession> => {
    const p = getConfig().providers;
    const provider = this.inner.name;
    const breaker = getCircuitBreaker(
      provider,
      () => new InMemoryCircuitBreaker(provider, { failureThreshold: p.breakerFailureThreshold, cooldownMs: p.breakerCooldownMs }),
    );
    const ticket = await breaker.acquire("tts.stream"); // throws CircuitOpenError: nothing is opened
    let settled = false;
    const settle = (kind: "success" | "failure" | "release") => {
      if (settled) return;
      settled = true;
      void ticket[kind]().catch(() => undefined);
    };
    let outstanding = 0;
    let stalled = false;
    let stallTimer: ReturnType<typeof setTimeout> | null = null;
    let inner: TtsStreamingSession | undefined;
    const clearStall = () => {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = null;
    };
    const armStall = () => {
      clearStall();
      if (outstanding === 0 || stalled) return;
      stallTimer = setTimeout(() => {
        stalled = true;
        settle("failure");
        const err = new ProviderRequestError(provider, `${provider} tts.stream timed out after ${p.ttsTimeoutMs}ms without progress`, undefined, {
          category: "timeout",
          operation: "tts.stream",
        });
        try {
          handlers.onError(err);
        } catch {
          // handlers must not throw; never let one break teardown
        }
        inner?.cancel();
      }, p.ttsTimeoutMs);
      stallTimer.unref?.();
    };
    const wrapped: TtsStreamHandlers = {
      onAudio: (pcm) => {
        if (stalled) return;
        settle("success");
        armStall();
        handlers.onAudio(pcm);
      },
      onSegmentComplete: () => {
        if (stalled) return;
        settle("success");
        outstanding = Math.max(0, outstanding - 1);
        armStall();
        handlers.onSegmentComplete();
      },
      onError: (err) => {
        if (stalled) return;
        clearStall();
        const c = err.category;
        settle(c === "timeout" || c === "network" || c === "server" || c === "bad_response" ? "failure" : "release");
        handlers.onError(err);
      },
      onClose: () => {
        clearStall();
        settle("release"); // closed without evidence either way (e.g. cancelled before any audio)
        handlers.onClose();
      },
    };
    try {
      inner = await this.inner.startStreaming!(wrapped, opts);
    } catch (err) {
      settle("release");
      throw err;
    }
    const session = inner;
    return {
      get open() {
        return session.open && !stalled;
      },
      sendText: (text) => {
        if (stalled) return false;
        outstanding++; // before sending: a synchronous completion must find it counted
        const ok = session.sendText(text);
        if (ok) armStall();
        else outstanding--;
        return ok;
      },
      cancel: () => {
        clearStall();
        session.cancel();
      },
      close: () => session.close(),
    };
  };
}
