/**
 * Loads environment variables from a single root-level `.env` file,
 * regardless of which directory the process was started from (pnpm
 * filtering changes the working directory into the package), and
 * exposes typed, validated config.
 *
 * Design rule (per MVP scope): the application must be able to START
 * with no external provider credentials. Only an actual attempt to use
 * a real provider (Exotel/Sarvam) should fail, and it must fail with a
 * clear configuration error — never a silent fallback to a mock during
 * what's supposed to be a real call.
 */

import { config } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

let loaded = false;

export function loadEnv(): void {
  if (loaded) return;
  loaded = true;

  // apps/api/src/config/env.ts -> repo root is 4 levels up.
  const repoRootEnv = resolve(import.meta.dirname, "../../../../.env");
  const localEnv = resolve(process.cwd(), ".env");

  if (existsSync(repoRootEnv)) {
    config({ path: repoRootEnv });
  } else if (existsSync(localEnv)) {
    config({ path: localEnv });
  }
}

export type TelephonyProviderKind = "mock" | "exotel";
export type AiProviderKind = "mock" | "sarvam";
export type EmailProviderKind = "mock" | "resend";

export interface AppConfig {
  nodeEnv: string;
  portApi: number;
  databaseUrl: string;
  telephonyProvider: TelephonyProviderKind;
  aiProvider: AiProviderKind;
  /** End-of-turn detection on the continuous inbound audio stream. */
  turn: {
    endSilenceMs: number;
    energyThreshold: number;
    minSpeechMs: number;
    maxUtteranceMs: number;
    /** Speech must exceed the room's noise floor by this factor (0 = fixed energyThreshold only). */
    floorMultiplier: number;
    /** The adaptive threshold never rises above this RMS. */
    maxAdaptiveThreshold: number;
  };
  /** Real-time audio pipeline bounds (realtime/). */
  realtime: {
    /** Use the provider's streaming LLM (when it has one): reply text is processed as it is generated. Opt-in until verified with real credentials. */
    llmStreaming: boolean;
    /**
     * Which STT provider serves live calls. "sarvam" (default) = whatever AI_PROVIDER selects (Sarvam or the mock).
     * "assemblyai" = EXPERIMENTAL, opt-in only, streaming-only; see adapters/ai/assemblyai/. Never chosen automatically
     * and never a fallback for the other.
     */
    sttProvider: "sarvam" | "assemblyai";
    /** Use the provider's streaming STT (when it has one) instead of one batch request per utterance. Opt-in until verified with real credentials. */
    sttStreaming: boolean;
    /** Synthesize each LLM sentence as it completes (Sarvam streaming TTS) instead of one batch request per reply. Off by default. */
    ttsStreaming: boolean;
    /** Audio held for a streaming STT session that is still connecting / congested, per call. */
    sttMaxQueuedBytes: number;
    /** Caller may interrupt the agent mid-reply. Off by default until verified on real phone audio (no echo cancellation here). */
    bargeInEnabled: boolean;
    bargeInMinSpeechMs: number;
    /** Interrupting needs the caller's voiced level to be this many times the room's noise floor (0 = no level check). */
    bargeInEnergyRatio: number;
    /** Finished caller utterances allowed to wait behind the turn in flight. */
    maxPendingUtterances: number;
    /** Outbound audio queued per call before a reply is refused. */
    maxOutboundQueueBytes: number;
    /** Stop feeding the socket while it holds more than this. */
    outboundHighWaterBytes: number;
    /** Malformed inbound audio frames tolerated per call before it is dropped. */
    maxMalformedFrames: number;
    /** Largest WebSocket message accepted. */
    wsMaxPayloadBytes: number;
    /**
     * A caller turn that produces no outbound audio within this duration (ms) is abandoned.
     * Bounds the sum of STT, all LLM hops, and TTS. Default 12000 ms, clamped to >= 2000.
     */
    turnDeadlineMs: number;
  };
  /** Extra Host header values treated as private/local (comma-separated API_PRIVATE_HOSTS). */
  privateHosts: string[];
  /** Bearer token for GET /metrics (METRICS_TOKEN, >= 16 chars). Unset: /metrics answers 404. */
  metricsToken: string | null;
  /**
   * Public base URL of the WEB DASHBOARD, without a trailing slash: the base of every link an email carries (invite,
   * password reset, address verification). Not the API's address (NEXT_PUBLIC_API_URL) and not the telephony webhook
   * (EXOTEL_WEBHOOK_BASE_URL). Development defaults to the dashboard's dev server; production must set a public
   * https:// URL and startup validation refuses anything else.
   */
  appBaseUrl: string;
  /**
   * Transactional email (adapters/email/). Selection is explicit via EMAIL_PROVIDER, never a fallback: with "mock"
   * (the default) nothing is delivered — the sender records what WOULD have been sent — so the product runs end to
   * end with no credentials, and a real provider without its key fails loudly instead of quietly dropping mail.
   */
  email: {
    provider: EmailProviderKind;
    /** From header: "name@example.com" or "Name <name@example.com>". Required by a real provider. */
    from: string;
    /** Reply-To offered to recipients; empty = none. */
    replyTo: string;
    /** Per-attempt bound on one send. Retries and the circuit breaker reuse the shared PROVIDER_* settings. */
    timeoutMs: number;
    /** Required when EMAIL_PROVIDER=resend. */
    resendApiKey: string;
  };
  auth: {
    cookieName: string;
    /** Idle lifetime; refreshed while the session is used. */
    sessionTtlMs: number;
    /** Hard cap regardless of activity. */
    sessionMaxAgeMs: number;
    cookieSecure: boolean;
    /** Origins allowed to call the API from a browser (CORS + CSRF check). */
    allowedOrigins: string[];
    /** Dev-only "continue as demo" login. Never enabled when NODE_ENV=production unless forced. */
    demoLoginEnabled: boolean;
    demoUserEmail: string;
    scryptN: number;
    mfa: {
      /** base64 of 32 random bytes: encrypts stored TOTP secrets (AES-256-GCM). Required to enrol anyone. */
      encryptionKey: string;
      /** off: nothing required; warn: owners/admins are told to enrol; enforce: owners/admins without MFA can only reach enrolment. */
      enforcement: "off" | "warn" | "enforce";
      /** Shown in authenticator apps. */
      issuer: string;
      /** Password re-entry is required for sensitive account changes if the last proof is older than this. */
      reauthWindowMs: number;
      /** How long a half-finished login (password ok, second factor pending) stays valid. */
      pendingTtlMs: number;
    };
    throttle: {
      /** Consecutive failures for one (account, IP) pair before it is temporarily locked. */
      pairThreshold: number;
      /** Failures for one IP across accounts before it is temporarily locked. */
      ipThreshold: number;
      /** Failures for one account across all IPs before attempts are delayed (a bounded delay, never a lock-out). */
      accountThreshold: number;
      /** First lock duration; doubles with each further failure, up to maxLockMs. */
      baseLockMs: number;
      maxLockMs: number;
      /** Failures older than this stop counting. */
      windowMs: number;
    };
    passwords: {
      minLength: number;
      /** Have I Been Pwned range API (k-anonymity: only a 5-character SHA-1 prefix leaves the server). */
      pwned: "off" | "fail-open" | "fail-closed";
    };
  };
  /**
   * Honor X-Forwarded-* for req.ip. Only enable behind a proxy you control. TRUST_PROXY accepts true/false, a hop
   * count (e.g. 1 = exactly one proxy in front), or a comma-separated list of trusted proxy IPs/CIDRs.
   */
  trustProxy: boolean | number | string;
  /** Fastify request body cap in bytes. */
  bodyLimitBytes: number;
  /** Rate limits. Counters live in PostgreSQL (shared by every API instance). */
  rateLimit: {
    /**
     * What GENERAL API routes (global per-IP, per-org call limit) do when the counter store errors: "open" (default,
     * serve the request) or "closed" (503). Auth and sensitive-account routes always fail closed.
     */
    failMode: "open" | "closed";
    /** Per-IP default for authenticated API routes. */
    apiMax: number;
    apiWindowMs: number;
    /** Per authenticated USER, same window (ordinary dashboard budget; users sharing a server IP do not share it). */
    userMax: number;
    /** Per ORGANIZATION, same window (aggregate ceiling so one tenant cannot monopolise the API). */
    orgMax: number;
    /** Per-organization cap on call initiation. */
    callsPerOrgMax: number;
    callsPerOrgWindowMs: number;
  };
  /**
   * Cost and abuse guards, applied per organization. 0 disables a limit. A running call keeps the values it started
   * with; changing a limit only affects calls that start afterwards.
   */
  limits: {
    /** Calls in progress (initiating, ringing, answered) at once for one organization. */
    maxConcurrentCallsPerOrg: number;
    /** Calls created by one organization in any rolling 24 hours (test calls included). */
    maxCallsPerOrgPerDay: number;
    /** Billable call seconds one organization may use per calendar month (UTC), from the usage ledger. */
    maxCallSecondsPerOrgPerMonth: number;
    /** Hard cap on one conversation; the AI says goodbye and the call ends. */
    maxCallDurationMs: number;
    /** No customer speech for this long ends the call (after the reprompts below). */
    silenceTimeoutMs: number;
    /** How many "are you still there?" prompts before ending a silent call. */
    silenceReprompts: number;
    /**
     * After the agent decides to end the call the line stays open this long, listening, before it says goodbye and hangs
     * up: the caller may be about to add something. 0 = end at once.
     */
    closingGraceMs: number;
    /** The same wait when the caller has just said goodbye themselves (a short beat, not a minute). */
    closingGraceAfterGoodbyeMs: number;
  };
  /**
   * Reliability of calls to AI providers (STT / LLM / TTS), applied uniformly by adapters/ai/reliability.ts. Retries
   * apply only to transient failures; every wait is bounded by the total budget.
   */
  providers: {
    sttTimeoutMs: number;
    llmTimeoutMs: number;
    /** Streaming LLM: no reply text or tool call within this long of the request starting = give up (voice cannot wait). */
    llmFirstTokenTimeoutMs: number;
    /** Streaming LLM: the connection delivers nothing for this long mid-stream = give up. */
    llmStreamStallTimeoutMs: number;
    ttsTimeoutMs: number;
    /** Attempts per call, including the first (1 = no retries). */
    maxAttempts: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
    /** Upper bound on one provider call including all retries and waits. */
    totalBudgetMs: number;
    /** Consecutive provider-health failures that open a provider's circuit. */
    breakerFailureThreshold: number;
    /** How long an open circuit fails fast before one probe call is allowed. */
    breakerCooldownMs: number;
    /** A tool that has not finished by now is reported to the model as timed out (it cannot be cancelled). */
    toolTimeoutMs: number;
  };
  /** Media-stream authentication (per-call tokens): see security/stream-token.ts. */
  stream: {
    /** "<kid>:<base64>[,...]": first signs, all verify. Empty = development throw-away key. */
    tokenKeys: string;
    /** How long a token stays valid; must cover the ring time of an outbound call. */
    tokenTtlMs: number;
    /** Connections one token may open (legitimate provider reconnects), counted across instances. */
    tokenMaxUses: number;
    /** Accept the shared webhook secret alone on the media stream (needed by inbound calls and flow mode). */
    allowStaticSecret: boolean;
    /** Static-secret streams (inbound / flow mode) may create an inbound call from their own start event when no webhook announced it. */
    inboundDirectAllowed: boolean;
    /** A static-secret stream must arrive within this long of its inbound call being registered. */
    inboundMaxAgeMs: number;
    /** A static-secret stream (flow mode) must arrive within this long of its outbound call being created. */
    flowMaxAgeMs: number;
    /**
     * Static-secret streams may attach only to a call still `initiating`/`ringing`. Off by default because Exotel's
     * "answered" status callback can legitimately reach us before the flow's stream connects (call already in_progress).
     */
    staticRequirePendingStatus: boolean;
    /** Exotel account_sid values a stream may carry (plus EXOTEL_ACCOUNT_SID when set). Empty = not enforced. */
    allowedAccountSids: string[];
    /** A shared (database) stream claim whose heartbeat is older than this is dead and may be taken over. */
    claimStaleMs: number;
    /** How often a live stream refreshes its claim. */
    claimHeartbeatMs: number;
    /** Opt-in per-call grants minted by the dynamic Voicebot endpoint (security/stream-grant.ts). */
    grantTtlMs: number;
    /** Connections one grant may open (provider reconnects), counted across instances. */
    grantMaxUses: number;
    /** Refuse streams that carry no grant (static-secret-only). Strongest mode; needs the applet on the dynamic endpoint. */
    requireGrant: boolean;
  };
  /** Graceful shutdown. */
  shutdown: {
    /** How long live calls may keep running after SIGTERM before their sockets are closed. */
    drainTimeoutMs: number;
  };
  /**
   * Retention of security_events (see docs/security/audit-retention.md). OFF by default: nothing is deleted until
   * business/legal has approved the periods. Category mapping lives in SQL (app_security_event_category).
   */
  securityRetention: {
    /** Effective switch: SECURITY_EVENT_RETENTION_ENABLED=true AND a recorded policy approval reference. */
    enabled: boolean;
    /** Reference (ticket/decision id) of the business/legal approval of the periods; deletion never runs without it. */
    approvalRef: string;
    /** Copy purged rows to security_events_archive (same statement) instead of dropping them outright. */
    archive: boolean;
    daysByCategory: {
      auth_session: number;
      mfa_config: number;
      access_denied: number;
      privileged_action: number;
      other: number;
    };
    batchSize: number;
    maxBatchesPerRun: number;
  };
  /** Reaper for calls whose final provider callback never arrives. */
  staleCalls: { pendingMs: number; inProgressMs: number; intervalMs: number };
  /** Local call simulator behind the mock telephony provider. */
  mockTelephony: {
    autoplay: boolean;
    baseUrl: string;
    scenario: "answered" | "busy" | "no_answer";
  };
  /**
   * Read-only demo endpoint for Exotel's built-in Voice Agent "API Integration" (modules/projects/demo-property.routes.ts).
   * Off unless BOTH values are set. The key is its own credential, never the telephony webhook secret.
   */
  demoApi: { apiKey: string; projectId: string };
  /** Temporary browser "web call" channel (modules/calls/web-call.routes.ts). Off by default; routes are not registered when off. */
  webCallEnabled: boolean;
  exotel: {
    apiKey: string;
    apiToken: string;
    accountSid: string;
    subdomain: string;
    agentStreamWebhookSecret: string;
    fromNumber: string;
    webhookBaseUrl: string;
    /** Optional Exotel CallType (omitted from the request when empty). */
    callType: string;
    /**
     * App Bazaar flow (Greeting -> Voicebot applet) that carries the audio. When set, outbound calls are placed INTO
     * this flow (the Voicebot applet holds our wss:// URL) instead of passing StreamUrl/StreamType in the request.
     */
    flowAppId: string;
    /** Where Exotel serves flows (`{base}/{account_sid}/exoml/start_voice/{app_id}`). */
    flowUrlBase: string;
  };
  /** EXPERIMENTAL AssemblyAI realtime STT (adapters/ai/assemblyai/). Inert unless REALTIME_STT_PROVIDER=assemblyai. */
  assemblyai: {
    apiKey: string;
    url: string;
    /** Streaming `speech_model`. Checked against the model the service reports back. */
    model: string;
    /** Provider-side turn endpointing is pushed far out so OUR turn controller (ForceEndpoint) decides when a turn ends. */
    minTurnSilenceMs: number;
    maxTurnSilenceMs: number;
    /** After we end an utterance, how long to wait for the provider's final before settling with what we hold. */
    flushGraceMs: number;
  };
  sarvam: {
    apiKey: string;
    sttModel: string;
    /** Batch STT `mode`. `codemix` keeps English words in English script inside Indian-language speech. */
    sttMode: string;
    llmModel: string;
    ttsModel: string;
    /**
     * Sarvam chat `reasoning_effort`. "" = do not send the field (the API default applies: thinking ON, which adds latency
     * and spends max_tokens). "off" = send null (documented way to disable thinking). Otherwise passed through
     * (low | medium | high | max).
     */
    llmReasoningEffort: string;
    ttsStreamUrl: string;
    sttRealtimeUrl: string;
    sttRealtimeModel: string;
    sttRealtimeStreamType: string;
    sttRealtimeMode: string;
  };
}

function readProviderKind<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(
    `Invalid provider value "${value}". Expected one of: ${allowed.join(", ")}`,
  );
}

/**
 * Non-negative integer from the environment. Unset -> the default. A malformed value ALSO falls back to the default
 * (never NaN, which would silently turn a limit off); config/validate.ts reports the malformed value at startup.
 */
export function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

/** TRUST_PROXY: "true"/"false", a hop count, or a trusted-proxy address/CIDR list (Fastify's trustProxy forms). */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const v = (raw ?? "").trim();
  if (v === "" || v.toLowerCase() === "false") return false;
  if (v.toLowerCase() === "true") return true;
  if (/^\d+$/.test(v)) return Number(v);
  return v;
}

/**
 * Builds config from process.env. Deliberately does NOT throw for missing
 * provider credentials — only for a malformed provider-selection value.
 * Credential presence is checked lazily, at the point a real provider is
 * actually used (see telephony/exotel.provider.ts and ai/sarvam.*.ts).
 */
export function getConfig(): AppConfig {
  return {
    nodeEnv: process.env.NODE_ENV ?? "development",
    portApi: Number(process.env.PORT_API ?? 4000),
    databaseUrl: process.env.DATABASE_URL ?? "",
    telephonyProvider: readProviderKind(
      process.env.TELEPHONY_PROVIDER,
      ["mock", "exotel"] as const,
      "mock",
    ),
    aiProvider: readProviderKind(
      process.env.AI_PROVIDER,
      ["mock", "sarvam"] as const,
      "mock",
    ),
    turn: {
      // 900 ms: a person pausing mid-sentence ("no, I have no interest in...") must not be taken as finished.
      endSilenceMs: Number(process.env.TURN_END_SILENCE_MS ?? 900),
      energyThreshold: Number(process.env.TURN_ENERGY_THRESHOLD ?? 500),
      // 400 ms: a cough, a click or a word from across the room is shorter than a real answer.
      minSpeechMs: Number(process.env.TURN_MIN_SPEECH_MS ?? 400),
      maxUtteranceMs: Number(process.env.TURN_MAX_UTTERANCE_MS ?? 15000),
      floorMultiplier: Math.max(0, Number(process.env.TURN_FLOOR_MULTIPLIER ?? 3)),
      maxAdaptiveThreshold: Math.max(500, Number(process.env.TURN_MAX_ADAPTIVE_THRESHOLD ?? 1500)),
    },
    realtime: {
      sttProvider: readProviderKind(process.env.REALTIME_STT_PROVIDER, ["sarvam", "assemblyai"] as const, "sarvam"),
      llmStreaming: (process.env.REALTIME_LLM_STREAMING ?? "false") === "true",
      sttStreaming: (process.env.REALTIME_STT_STREAMING ?? "false") === "true",
      ttsStreaming: (process.env.REALTIME_TTS_STREAMING ?? "false") === "true",
      sttMaxQueuedBytes: Math.max(3200, intEnv("REALTIME_STT_MAX_QUEUED_BYTES", 256 * 1024)),
      bargeInEnabled: (process.env.REALTIME_BARGE_IN ?? "false") === "true",
      // Interrupting the agent is a deliberate act: a second of clear speech, not a noise.
      bargeInMinSpeechMs: Math.max(100, intEnv("REALTIME_BARGE_IN_MIN_SPEECH_MS", 1000)),
      bargeInEnergyRatio: Math.max(0, Number(process.env.REALTIME_BARGE_IN_ENERGY_RATIO ?? 6)),
      maxPendingUtterances: Math.max(1, intEnv("REALTIME_MAX_PENDING_UTTERANCES", 2)),
      maxOutboundQueueBytes: Math.max(3200, intEnv("REALTIME_MAX_OUTBOUND_QUEUE_BYTES", 4 * 1024 * 1024)),
      outboundHighWaterBytes: Math.max(3200, intEnv("REALTIME_OUTBOUND_HIGH_WATER_BYTES", 256 * 1024)),
      maxMalformedFrames: Math.max(1, intEnv("REALTIME_MAX_MALFORMED_FRAMES", 100)),
      wsMaxPayloadBytes: Math.max(4096, intEnv("REALTIME_WS_MAX_PAYLOAD_BYTES", 256 * 1024)),
      turnDeadlineMs: Math.max(2000, intEnv("REALTIME_TURN_DEADLINE_MS", 12000)),
    },
    metricsToken: (process.env.METRICS_TOKEN ?? "").length >= 16 ? (process.env.METRICS_TOKEN as string) : null,
    privateHosts: (process.env.API_PRIVATE_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
    // The dashboard's dev server (apps/web) in development; production supplies its own public https:// address.
    appBaseUrl: (process.env.APP_BASE_URL ?? "http://localhost:3000").trim().replace(/\/+$/, ""),
    email: {
      provider: readProviderKind(process.env.EMAIL_PROVIDER, ["mock", "resend"] as const, "mock"),
      from: (process.env.EMAIL_FROM ?? "").trim(),
      replyTo: (process.env.EMAIL_REPLY_TO ?? "").trim(),
      timeoutMs: Math.max(1, intEnv("EMAIL_TIMEOUT_MS", 10_000)),
      resendApiKey: process.env.RESEND_API_KEY ?? "",
    },
    auth: {
      cookieName: process.env.SESSION_COOKIE_NAME ?? "va_session",
      sessionTtlMs: Number(process.env.SESSION_TTL_MS ?? 7 * 24 * 3600_000),
      sessionMaxAgeMs: Number(process.env.SESSION_MAX_AGE_MS ?? 30 * 24 * 3600_000),
      cookieSecure: (process.env.COOKIE_SECURE ?? (process.env.NODE_ENV === "production" ? "true" : "false")) === "true",
      allowedOrigins: (process.env.WEB_ORIGINS ?? "http://127.0.0.1:3000,http://localhost:3000")
        .split(",")
        .map((o) => o.trim())
        .filter(Boolean),
      demoLoginEnabled: (process.env.DEMO_LOGIN_ENABLED ?? (process.env.NODE_ENV === "production" ? "false" : "true")) === "true",
      demoUserEmail: process.env.DEMO_USER_EMAIL ?? "demo@greenvalley.demo",
      scryptN: Number(process.env.AUTH_SCRYPT_N ?? 32768),
      mfa: {
        encryptionKey: process.env.MFA_ENCRYPTION_KEY ?? "",
        enforcement: (["off", "warn", "enforce"] as const).includes(process.env.MFA_ENFORCEMENT as never)
          ? (process.env.MFA_ENFORCEMENT as "off" | "warn" | "enforce")
          : "warn",
        issuer: process.env.MFA_ISSUER ?? "Voice Agent",
        reauthWindowMs: Number(process.env.REAUTH_WINDOW_MS ?? 10 * 60_000),
        pendingTtlMs: Number(process.env.MFA_PENDING_TTL_MS ?? 10 * 60_000),
      },
      throttle: {
        pairThreshold: Number(process.env.LOGIN_PAIR_THRESHOLD ?? 5),
        ipThreshold: Number(process.env.LOGIN_IP_THRESHOLD ?? 30),
        accountThreshold: Number(process.env.LOGIN_ACCOUNT_THRESHOLD ?? 20),
        baseLockMs: Number(process.env.LOGIN_BASE_LOCK_MS ?? 30_000),
        maxLockMs: Number(process.env.LOGIN_MAX_LOCK_MS ?? 15 * 60_000),
        windowMs: Number(process.env.LOGIN_FAILURE_WINDOW_MS ?? 15 * 60_000),
      },
      passwords: {
        minLength: Number(process.env.PASSWORD_MIN_LENGTH ?? 10),
        pwned: (["off", "fail-open", "fail-closed"] as const).includes(process.env.PWNED_PASSWORDS as never)
          ? (process.env.PWNED_PASSWORDS as "off" | "fail-open" | "fail-closed")
          : "off",
      },
    },
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    bodyLimitBytes: Number(process.env.BODY_LIMIT_BYTES ?? 256 * 1024),
    rateLimit: {
      failMode: process.env.RATE_LIMIT_FAIL_MODE === "closed" ? "closed" : "open",
      apiMax: Number(process.env.RATE_LIMIT_API_MAX ?? 300),
      apiWindowMs: Number(process.env.RATE_LIMIT_API_WINDOW_MS ?? 60_000),
      userMax: Number(process.env.RATE_LIMIT_USER_MAX ?? 300),
      orgMax: Number(process.env.RATE_LIMIT_ORG_MAX ?? 1500),
      callsPerOrgMax: Number(process.env.RATE_LIMIT_CALLS_PER_ORG_MAX ?? 10),
      callsPerOrgWindowMs: Number(process.env.RATE_LIMIT_CALLS_PER_ORG_WINDOW_MS ?? 60_000),
    },
    limits: {
      maxConcurrentCallsPerOrg: intEnv("MAX_CONCURRENT_CALLS_PER_ORG", 10),
      maxCallsPerOrgPerDay: intEnv("QUOTA_CALLS_PER_ORG_PER_DAY", 1000),
      maxCallSecondsPerOrgPerMonth: intEnv("QUOTA_CALL_SECONDS_PER_ORG_PER_MONTH", 0),
      maxCallDurationMs: intEnv("MAX_CALL_DURATION_MS", 30 * 60_000),
      silenceTimeoutMs: intEnv("SILENCE_TIMEOUT_MS", 20_000),
      silenceReprompts: intEnv("SILENCE_REPROMPTS", 1),
      closingGraceMs: intEnv("CLOSING_GRACE_MS", 60_000),
      closingGraceAfterGoodbyeMs: intEnv("CLOSING_GRACE_AFTER_GOODBYE_MS", 2_000),
    },
    providers: {
      sttTimeoutMs: Math.max(1, intEnv("PROVIDER_STT_TIMEOUT_MS", 10_000)),
      llmTimeoutMs: Math.max(1, intEnv("PROVIDER_LLM_TIMEOUT_MS", 15_000)),
      llmFirstTokenTimeoutMs: Math.max(1, intEnv("PROVIDER_LLM_FIRST_TOKEN_TIMEOUT_MS", 8_000)),
      llmStreamStallTimeoutMs: Math.max(1, intEnv("PROVIDER_LLM_STREAM_STALL_TIMEOUT_MS", 5_000)),
      ttsTimeoutMs: Math.max(1, intEnv("PROVIDER_TTS_TIMEOUT_MS", 10_000)),
      maxAttempts: Math.max(1, intEnv("PROVIDER_MAX_ATTEMPTS", 3)),
      retryBaseDelayMs: intEnv("PROVIDER_RETRY_BASE_DELAY_MS", 250),
      retryMaxDelayMs: intEnv("PROVIDER_RETRY_MAX_DELAY_MS", 2_000),
      totalBudgetMs: Math.max(1, intEnv("PROVIDER_TOTAL_BUDGET_MS", 30_000)),
      breakerFailureThreshold: Math.max(1, intEnv("PROVIDER_BREAKER_FAILURE_THRESHOLD", 5)),
      breakerCooldownMs: intEnv("PROVIDER_BREAKER_COOLDOWN_MS", 30_000),
      toolTimeoutMs: Math.max(1, intEnv("TOOL_TIMEOUT_MS", 10_000)),
    },
    stream: {
      tokenKeys: process.env.STREAM_TOKEN_KEYS ?? "",
      tokenTtlMs: Math.max(30_000, intEnv("STREAM_TOKEN_TTL_MS", 15 * 60_000)),
      tokenMaxUses: Math.max(1, intEnv("STREAM_TOKEN_MAX_USES", 3)),
      allowStaticSecret: (process.env.STREAM_ALLOW_STATIC_SECRET ?? "true") !== "false",
      inboundDirectAllowed: (process.env.STREAM_INBOUND_DIRECT_ALLOWED ?? "true") !== "false",
      inboundMaxAgeMs: Math.max(5_000, intEnv("STREAM_INBOUND_MAX_AGE_MS", 10 * 60_000)),
      flowMaxAgeMs: Math.max(5_000, intEnv("STREAM_FLOW_MAX_AGE_MS", 30 * 60_000)),
      staticRequirePendingStatus: (process.env.STREAM_STATIC_REQUIRE_PENDING_STATUS ?? "false") === "true",
      allowedAccountSids: (process.env.STREAM_ALLOWED_ACCOUNT_SIDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      claimStaleMs: Math.max(1_000, intEnv("STREAM_CLAIM_STALE_MS", 30_000)),
      claimHeartbeatMs: Math.max(200, intEnv("STREAM_CLAIM_HEARTBEAT_MS", 10_000)),
      grantTtlMs: Math.max(5_000, intEnv("STREAM_GRANT_TTL_MS", 10 * 60_000)),
      grantMaxUses: Math.max(1, intEnv("STREAM_GRANT_MAX_USES", 3)),
      requireGrant: (process.env.STREAM_REQUIRE_GRANT ?? "false") === "true",
    },
    shutdown: {
      drainTimeoutMs: intEnv("SHUTDOWN_DRAIN_TIMEOUT_MS", 120_000),
    },
    securityRetention: {
      enabled:
        (process.env.SECURITY_EVENT_RETENTION_ENABLED ?? "false") === "true" &&
        (process.env.SECURITY_EVENT_RETENTION_APPROVAL_REF ?? "").trim() !== "",
      approvalRef: (process.env.SECURITY_EVENT_RETENTION_APPROVAL_REF ?? "").trim(),
      archive: (process.env.SECURITY_EVENT_RETENTION_ARCHIVE ?? "false") === "true",
      daysByCategory: {
        auth_session: Math.max(1, intEnv("SECURITY_EVENT_RETENTION_DAYS_AUTH_SESSION", 400)),
        mfa_config: Math.max(1, intEnv("SECURITY_EVENT_RETENTION_DAYS_MFA_CONFIG", 730)),
        access_denied: Math.max(1, intEnv("SECURITY_EVENT_RETENTION_DAYS_ACCESS_DENIED", 400)),
        privileged_action: Math.max(1, intEnv("SECURITY_EVENT_RETENTION_DAYS_PRIVILEGED_ACTION", 730)),
        other: Math.max(1, intEnv("SECURITY_EVENT_RETENTION_DAYS_OTHER", 400)),
      },
      batchSize: Math.min(10_000, Math.max(1, intEnv("SECURITY_EVENT_RETENTION_BATCH_SIZE", 1000))),
      maxBatchesPerRun: Math.max(1, intEnv("SECURITY_EVENT_RETENTION_MAX_BATCHES", 20)),
    },
    staleCalls: {
      pendingMs: Number(process.env.STALE_CALL_PENDING_MS ?? 10 * 60_000),
      inProgressMs: Number(process.env.STALE_CALL_IN_PROGRESS_MS ?? 45 * 60_000),
      intervalMs: Number(process.env.STALE_CALL_CHECK_INTERVAL_MS ?? 60_000),
    },
    mockTelephony: {
      autoplay: (process.env.MOCK_TELEPHONY_AUTOPLAY ?? "true") !== "false",
      baseUrl: process.env.MOCK_TELEPHONY_BASE_URL ?? `http://127.0.0.1:${process.env.PORT_API ?? 4000}`,
      scenario: readProviderKind(
        process.env.MOCK_CALL_SCENARIO,
        ["answered", "busy", "no_answer"] as const,
        "answered",
      ),
    },
    webCallEnabled: (process.env.WEB_CALL_ENABLED ?? "false") === "true",
    demoApi: {
      apiKey: process.env.EXOTEL_DEMO_API_KEY ?? "",
      projectId: process.env.EXOTEL_DEMO_PROJECT_ID ?? "",
    },
    exotel: {
      apiKey: process.env.EXOTEL_API_KEY ?? "",
      apiToken: process.env.EXOTEL_API_TOKEN ?? "",
      accountSid: process.env.EXOTEL_ACCOUNT_SID ?? "",
      subdomain: process.env.EXOTEL_SUBDOMAIN ?? "",
      agentStreamWebhookSecret: process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET ?? "",
      fromNumber: process.env.EXOTEL_FROM_NUMBER ?? "",
      webhookBaseUrl: process.env.EXOTEL_WEBHOOK_BASE_URL ?? "",
      callType: process.env.EXOTEL_CALL_TYPE ?? "",
      flowAppId: process.env.EXOTEL_FLOW_APP_ID ?? "",
      flowUrlBase: (process.env.EXOTEL_FLOW_URL_BASE ?? "http://my.exotel.com").replace(/\/+$/, ""),
    },
    assemblyai: {
      apiKey: process.env.ASSEMBLYAI_API_KEY ?? "",
      url: process.env.ASSEMBLYAI_STT_URL ?? "wss://streaming.assemblyai.com/v3/ws",
      model: process.env.ASSEMBLYAI_STT_MODEL ?? "universal-streaming-english",
      minTurnSilenceMs: Math.max(50, intEnv("ASSEMBLYAI_STT_MIN_TURN_SILENCE_MS", 5_000)),
      maxTurnSilenceMs: Math.max(50, intEnv("ASSEMBLYAI_STT_MAX_TURN_SILENCE_MS", 8_000)),
      flushGraceMs: Math.max(50, intEnv("ASSEMBLYAI_STT_FLUSH_GRACE_MS", 2_000)),
    },
    sarvam: {
      apiKey: process.env.SARVAM_API_KEY ?? "",
      sttModel: process.env.SARVAM_STT_MODEL ?? "saaras:v3",
      sttMode: process.env.SARVAM_STT_MODE ?? "codemix",
      llmModel: process.env.SARVAM_LLM_MODEL ?? "sarvam-105b-conversations",
      ttsModel: process.env.SARVAM_TTS_MODEL ?? "bulbul:v3",
      /** Streaming STT: wss://api.sarvam.ai/speech-to-text-realtime/ws (a different endpoint and model from the batch one). */
      llmReasoningEffort: (process.env.SARVAM_LLM_REASONING_EFFORT ?? "").trim().toLowerCase(),
      /** Streaming TTS: wss://api.sarvam.ai/text-to-speech/ws (model is passed as a query parameter). */
      ttsStreamUrl: process.env.SARVAM_TTS_STREAM_URL ?? "wss://api.sarvam.ai/text-to-speech/ws",
      sttRealtimeUrl: process.env.SARVAM_STT_REALTIME_URL ?? "wss://api.sarvam.ai/speech-to-text-realtime/ws",
      sttRealtimeModel: process.env.SARVAM_STT_REALTIME_MODEL ?? "saaras:v3-realtime",
      /** "fast" is Sarvam's recommendation for conversational agents. */
      sttRealtimeStreamType: process.env.SARVAM_STT_REALTIME_STREAM_TYPE ?? "fast",
      sttRealtimeMode: process.env.SARVAM_STT_REALTIME_MODE ?? "codemix",
    },
  };
}
