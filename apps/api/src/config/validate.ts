/**
 * Startup configuration check, run by server.ts before anything listens.
 *
 * getConfig() is deliberately lazy so local development and tests can run with no provider credentials. A
 * production process must not: a missing secret or a typo'd number should stop the deploy with one clear message
 * listing everything wrong, not surface later as a failed call. Problems that only matter in production are errors
 * there and warnings elsewhere.
 */
import { getConfig } from "./env.js";

export interface ConfigReport {
  errors: string[];
  warnings: string[];
}

export class ConfigValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid configuration:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    this.name = "ConfigValidationError";
  }
}

/** Every setting that must be a non-negative whole number when present. */
const NUMERIC_VARS = [
  "PORT_API",
  "DATABASE_POOL_MAX",
  "TURN_END_SILENCE_MS",
  "TURN_ENERGY_THRESHOLD",
  "TURN_MIN_SPEECH_MS",
  "TURN_MAX_UTTERANCE_MS",
  "SESSION_TTL_MS",
  "SESSION_MAX_AGE_MS",
  "AUTH_SCRYPT_N",
  "BODY_LIMIT_BYTES",
  "RATE_LIMIT_API_MAX",
  "RATE_LIMIT_API_WINDOW_MS",
  "RATE_LIMIT_CALLS_PER_ORG_MAX",
  "RATE_LIMIT_CALLS_PER_ORG_WINDOW_MS",
  "STALE_CALL_PENDING_MS",
  "STALE_CALL_IN_PROGRESS_MS",
  "STALE_CALL_CHECK_INTERVAL_MS",
  "MAX_CONCURRENT_CALLS_PER_ORG",
  "QUOTA_CALLS_PER_ORG_PER_DAY",
  "QUOTA_CALL_SECONDS_PER_ORG_PER_MONTH",
  "MAX_CALL_DURATION_MS",
  "SILENCE_TIMEOUT_MS",
  "SILENCE_REPROMPTS",
  "SHUTDOWN_DRAIN_TIMEOUT_MS",
  "PROVIDER_STT_TIMEOUT_MS",
  "PROVIDER_LLM_TIMEOUT_MS",
  "PROVIDER_TTS_TIMEOUT_MS",
  "PROVIDER_MAX_ATTEMPTS",
  "PROVIDER_RETRY_BASE_DELAY_MS",
  "PROVIDER_RETRY_MAX_DELAY_MS",
  "PROVIDER_TOTAL_BUDGET_MS",
  "PROVIDER_BREAKER_FAILURE_THRESHOLD",
  "PROVIDER_BREAKER_COOLDOWN_MS",
  "TOOL_TIMEOUT_MS",
] as const;

const isLocalOrigin = (o: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(o);

export function validateConfig(): ConfigReport {
  const env = process.env;
  const errors: string[] = [];
  const warnings: string[] = [];
  const production = (env.NODE_ENV ?? "development") === "production";
  /** Provider credentials: required in production, a heads-up elsewhere. */
  const needed = (problem: string) => (production ? errors : warnings).push(problem);

  for (const name of NUMERIC_VARS) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) errors.push(`${name} must be a non-negative whole number (got "${raw}")`);
  }

  let cfg: ReturnType<typeof getConfig>;
  try {
    cfg = getConfig();
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
    return { errors, warnings };
  }

  if (!cfg.databaseUrl) errors.push("DATABASE_URL is not set");

  if (cfg.telephonyProvider === "exotel") {
    const x = cfg.exotel;
    const missing = (
      [
        ["EXOTEL_API_KEY", x.apiKey],
        ["EXOTEL_API_TOKEN", x.apiToken],
        ["EXOTEL_ACCOUNT_SID", x.accountSid],
        ["EXOTEL_SUBDOMAIN", x.subdomain],
        ["EXOTEL_AGENTSTREAM_WEBHOOK_SECRET", x.agentStreamWebhookSecret],
        ["EXOTEL_FROM_NUMBER", x.fromNumber],
        ["EXOTEL_WEBHOOK_BASE_URL", x.webhookBaseUrl],
      ] as const
    )
      .filter(([, v]) => !v)
      .map(([k]) => k);
    if (missing.length > 0) needed(`TELEPHONY_PROVIDER=exotel requires ${missing.join(", ")}`);
    if (x.webhookBaseUrl && !/^https:\/\//i.test(x.webhookBaseUrl)) needed("EXOTEL_WEBHOOK_BASE_URL must be an https:// URL");
    if (x.agentStreamWebhookSecret && x.agentStreamWebhookSecret.length < 16) {
      needed("EXOTEL_AGENTSTREAM_WEBHOOK_SECRET is too short; use a long random string (16+ characters)");
    }
  }

  const demo = cfg.demoApi;
  if (demo.apiKey || demo.projectId) {
    if (!demo.apiKey || !demo.projectId) warnings.push("EXOTEL_DEMO_API_KEY and EXOTEL_DEMO_PROJECT_ID must both be set; the demo property endpoint stays off until they are");
    else if (demo.apiKey.length < 24) warnings.push("EXOTEL_DEMO_API_KEY is shorter than 24 characters; the demo property endpoint stays off");
    else warnings.push("the demo property endpoint (/api/telephony/exotel/demo/property-details) is ENABLED; remove EXOTEL_DEMO_API_KEY when the Exotel experiment ends");
  }
  if (cfg.aiProvider === "sarvam" && !cfg.sarvam.apiKey) needed("AI_PROVIDER=sarvam requires SARVAM_API_KEY");
  // EXPERIMENT: AssemblyAI only when explicitly selected; refuse to start half-configured rather than fall back.
  if (cfg.realtime.sttProvider === "assemblyai") {
    if (!cfg.assemblyai.apiKey) needed("REALTIME_STT_PROVIDER=assemblyai requires ASSEMBLYAI_API_KEY");
    if (!cfg.realtime.sttStreaming) needed("REALTIME_STT_PROVIDER=assemblyai is streaming-only and requires REALTIME_STT_STREAMING=true");
  }

  if (cfg.limits.maxCallDurationMs > 0 && cfg.limits.maxCallDurationMs >= cfg.staleCalls.inProgressMs) {
    warnings.push(
      `MAX_CALL_DURATION_MS (${cfg.limits.maxCallDurationMs}) is not below STALE_CALL_IN_PROGRESS_MS (${cfg.staleCalls.inProgressMs}); the stale-call reaper may close a call that is still within its allowed length`,
    );
  }
  if (cfg.limits.maxConcurrentCallsPerOrg === 0) warnings.push("MAX_CONCURRENT_CALLS_PER_ORG=0: concurrent calls per organization are unlimited");

  // Retention deletion is destructive and policy-gated: it can only be on with an approval reference and valid periods.
  {
    const wanted = (env.SECURITY_EVENT_RETENTION_ENABLED ?? "false") === "true";
    const approvalRef = (env.SECURITY_EVENT_RETENTION_APPROVAL_REF ?? "").trim();
    const periodVars = [
      "SECURITY_EVENT_RETENTION_DAYS_AUTH_SESSION",
      "SECURITY_EVENT_RETENTION_DAYS_MFA_CONFIG",
      "SECURITY_EVENT_RETENTION_DAYS_ACCESS_DENIED",
      "SECURITY_EVENT_RETENTION_DAYS_PRIVILEGED_ACTION",
      "SECURITY_EVENT_RETENTION_DAYS_OTHER",
    ];
    for (const name of periodVars) {
      const raw = env[name];
      if (raw === undefined || raw === "") continue;
      if (!/^\d+$/.test(raw) || Number(raw) < 1) errors.push(`${name} must be a whole number of days >= 1 (got "${raw}")`);
      else if (wanted && Number(raw) < 30) errors.push(`${name}=${raw} is below the 30-day floor allowed when retention deletion is enabled`);
    }
    if (wanted && !approvalRef) {
      errors.push("SECURITY_EVENT_RETENTION_ENABLED=true requires SECURITY_EVENT_RETENTION_APPROVAL_REF (the recorded business/legal approval of the retention periods); deletion stays off without it");
    }
    if (!wanted && approvalRef) warnings.push("SECURITY_EVENT_RETENTION_APPROVAL_REF is set but SECURITY_EVENT_RETENTION_ENABLED is not true: no events are deleted");
    if ((env.SECURITY_EVENT_RETENTION_ARCHIVE ?? "false") === "true" && !wanted) {
      warnings.push("SECURITY_EVENT_RETENTION_ARCHIVE=true has no effect while retention deletion is disabled");
    }
  }

  if (production) {
    // The administrative connection (fixtures, provisioning scripts) must never exist in a serving process.
    if (env.DATABASE_ADMIN_URL?.trim()) {
      errors.push("DATABASE_ADMIN_URL must not be set on the API runtime in production (it bypasses row-level security); use it only for operator scripts");
    }
    if (cfg.telephonyProvider === "exotel" && !cfg.stream.tokenKeys.trim()) {
      errors.push("STREAM_TOKEN_KEYS must be set in production with TELEPHONY_PROVIDER=exotel (per-call media-stream tokens; format <kid>:<base64 of 32+ bytes>, first key signs)");
    }
    if (cfg.stream.allowStaticSecret) {
      warnings.push("STREAM_ALLOW_STATIC_SECRET is on: the media stream also accepts the shared webhook secret alone (needed for inbound calls and Exotel flow mode); turn it off for API-outbound-only deployments");
    }
    if (!cfg.auth.mfa.encryptionKey) warnings.push("MFA_ENCRYPTION_KEY is not set: no one can enrol in two-step verification until it is");
    if (cfg.auth.mfa.enforcement === "off") warnings.push("MFA_ENFORCEMENT=off: owners/admins are not asked for two-step verification");
    if (cfg.auth.passwords.pwned === "off") warnings.push("PWNED_PASSWORDS=off: new passwords are not screened against known breaches");
    if (!env.WEB_ORIGINS?.trim()) errors.push("WEB_ORIGINS must be set to the dashboard's public origin(s) in production");
    else if (cfg.auth.allowedOrigins.some(isLocalOrigin)) errors.push("WEB_ORIGINS must not list localhost origins in production");
    if (!cfg.auth.cookieSecure) errors.push("COOKIE_SECURE must be true in production");
    if (cfg.auth.demoLoginEnabled) errors.push("DEMO_LOGIN_ENABLED must be false in production");
    if (cfg.auth.scryptN < 16384) errors.push("AUTH_SCRYPT_N must be at least 16384 in production");
    if (cfg.telephonyProvider === "mock") warnings.push("TELEPHONY_PROVIDER=mock: no real calls will be placed or received");
    if (cfg.aiProvider === "mock") warnings.push("AI_PROVIDER=mock: conversations use the scripted mock models");
    if (cfg.trustProxy === false) {
      warnings.push("TRUST_PROXY is not set: behind a load balancer every client appears to have the proxy's IP, so per-IP limits collapse");
    }
    if (cfg.privateHosts.length === 0) {
      warnings.push("API_PRIVATE_HOSTS is empty: dashboard API requests that arrive through a proxy are treated as public and answered 404");
    }
  }

  return { errors, warnings };
}

/** Throws ConfigValidationError listing every problem; returns the warnings so the caller can log them. */
export function assertValidConfig(): string[] {
  const { errors, warnings } = validateConfig();
  if (errors.length > 0) throw new ConfigValidationError(errors);
  return warnings;
}
