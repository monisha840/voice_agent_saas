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
  };
  /** Extra Host header values treated as private/local (comma-separated API_PRIVATE_HOSTS). */
  privateHosts: string[];
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
  };
  /** Honor X-Forwarded-* for req.ip. Only enable behind a proxy you control (TRUST_PROXY=true). */
  trustProxy: boolean;
  /** Fastify request body cap in bytes. */
  bodyLimitBytes: number;
  /** In-memory limits (per process; reset on restart, not shared across instances). */
  rateLimit: {
    /** Per-IP default for authenticated API routes. */
    apiMax: number;
    apiWindowMs: number;
    /** Per-organization cap on call initiation. */
    callsPerOrgMax: number;
    callsPerOrgWindowMs: number;
  };
  /** Reaper for calls whose final provider callback never arrives. */
  staleCalls: { pendingMs: number; inProgressMs: number; intervalMs: number };
  /** Local call simulator behind the mock telephony provider. */
  mockTelephony: {
    autoplay: boolean;
    baseUrl: string;
    scenario: "answered" | "busy" | "no_answer";
  };
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
  };
  sarvam: {
    apiKey: string;
    sttModel: string;
    llmModel: string;
    ttsModel: string;
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
      endSilenceMs: Number(process.env.TURN_END_SILENCE_MS ?? 700),
      energyThreshold: Number(process.env.TURN_ENERGY_THRESHOLD ?? 500),
      minSpeechMs: Number(process.env.TURN_MIN_SPEECH_MS ?? 250),
      maxUtteranceMs: Number(process.env.TURN_MAX_UTTERANCE_MS ?? 15000),
    },
    privateHosts: (process.env.API_PRIVATE_HOSTS ?? "")
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
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
    },
    trustProxy: process.env.TRUST_PROXY === "true",
    bodyLimitBytes: Number(process.env.BODY_LIMIT_BYTES ?? 256 * 1024),
    rateLimit: {
      apiMax: Number(process.env.RATE_LIMIT_API_MAX ?? 300),
      apiWindowMs: Number(process.env.RATE_LIMIT_API_WINDOW_MS ?? 60_000),
      callsPerOrgMax: Number(process.env.RATE_LIMIT_CALLS_PER_ORG_MAX ?? 10),
      callsPerOrgWindowMs: Number(process.env.RATE_LIMIT_CALLS_PER_ORG_WINDOW_MS ?? 60_000),
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
    exotel: {
      apiKey: process.env.EXOTEL_API_KEY ?? "",
      apiToken: process.env.EXOTEL_API_TOKEN ?? "",
      accountSid: process.env.EXOTEL_ACCOUNT_SID ?? "",
      subdomain: process.env.EXOTEL_SUBDOMAIN ?? "",
      agentStreamWebhookSecret: process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET ?? "",
      fromNumber: process.env.EXOTEL_FROM_NUMBER ?? "",
      webhookBaseUrl: process.env.EXOTEL_WEBHOOK_BASE_URL ?? "",
      callType: process.env.EXOTEL_CALL_TYPE ?? "",
    },
    sarvam: {
      apiKey: process.env.SARVAM_API_KEY ?? "",
      sttModel: process.env.SARVAM_STT_MODEL ?? "saaras:v3",
      llmModel: process.env.SARVAM_LLM_MODEL ?? "sarvam-105b",
      ttsModel: process.env.SARVAM_TTS_MODEL ?? "bulbul:v3",
    },
  };
}
