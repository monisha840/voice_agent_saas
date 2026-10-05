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
  exotel: {
    apiKey: string;
    apiToken: string;
    accountSid: string;
    subdomain: string;
    agentStreamWebhookSecret: string;
    fromNumber: string;
    webhookBaseUrl: string;
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
    exotel: {
      apiKey: process.env.EXOTEL_API_KEY ?? "",
      apiToken: process.env.EXOTEL_API_TOKEN ?? "",
      accountSid: process.env.EXOTEL_ACCOUNT_SID ?? "",
      subdomain: process.env.EXOTEL_SUBDOMAIN ?? "",
      agentStreamWebhookSecret: process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET ?? "",
      fromNumber: process.env.EXOTEL_FROM_NUMBER ?? "",
      webhookBaseUrl: process.env.EXOTEL_WEBHOOK_BASE_URL ?? "",
    },
    sarvam: {
      apiKey: process.env.SARVAM_API_KEY ?? "",
      sttModel: process.env.SARVAM_STT_MODEL ?? "saaras:v3",
      llmModel: process.env.SARVAM_LLM_MODEL ?? "sarvam-105b",
      ttsModel: process.env.SARVAM_TTS_MODEL ?? "bulbul:v3",
    },
  };
}
