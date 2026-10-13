/**
 * Startup configuration validation, and the parsing helpers behind the new limits and TRUST_PROXY.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { assertValidConfig, ConfigValidationError, validateConfig } from "./validate.js";
import { getConfig, intEnv, parseTrustProxy } from "./env.js";

const TOUCHED = [
  "NODE_ENV",
  "DATABASE_URL",
  "TELEPHONY_PROVIDER",
  "AI_PROVIDER",
  "WEB_ORIGINS",
  "COOKIE_SECURE",
  "DEMO_LOGIN_ENABLED",
  "AUTH_SCRYPT_N",
  "TRUST_PROXY",
  "API_PRIVATE_HOSTS",
  "EXOTEL_API_KEY",
  "EXOTEL_API_TOKEN",
  "EXOTEL_ACCOUNT_SID",
  "EXOTEL_SUBDOMAIN",
  "EXOTEL_AGENTSTREAM_WEBHOOK_SECRET",
  "EXOTEL_FROM_NUMBER",
  "EXOTEL_WEBHOOK_BASE_URL",
  "EXOTEL_DEMO_API_KEY",
  "EXOTEL_DEMO_PROJECT_ID",
  "SARVAM_API_KEY",
  "MAX_CONCURRENT_CALLS_PER_ORG",
  "MAX_CALL_DURATION_MS",
  "STALE_CALL_IN_PROGRESS_MS",
  "SILENCE_TIMEOUT_MS",
  "SHUTDOWN_DRAIN_TIMEOUT_MS",
] as const;

let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
  for (const k of TOUCHED) delete process.env[k];
  process.env.DATABASE_URL = "postgresql://u:p@localhost:5432/db_test";
});
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** A complete, valid production environment. */
function productionEnv() {
  process.env.NODE_ENV = "production";
  process.env.WEB_ORIGINS = "https://app.example.com";
  process.env.TELEPHONY_PROVIDER = "exotel";
  process.env.AI_PROVIDER = "sarvam";
  process.env.EXOTEL_API_KEY = "k";
  process.env.EXOTEL_API_TOKEN = "t";
  process.env.EXOTEL_ACCOUNT_SID = "acct";
  process.env.EXOTEL_SUBDOMAIN = "api.in.exotel.com";
  process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "a-long-random-webhook-secret-123";
  process.env.EXOTEL_FROM_NUMBER = "+918000000000";
  process.env.EXOTEL_WEBHOOK_BASE_URL = "https://api.example.com";
  process.env.SARVAM_API_KEY = "sk";
  process.env.TRUST_PROXY = "1";
  process.env.API_PRIVATE_HOSTS = "api.internal";
}

describe("validateConfig", () => {
  it("a complete production environment is valid and has no warnings", () => {
    productionEnv();
    expect(validateConfig()).toEqual({ errors: [], warnings: [] });
    expect(assertValidConfig()).toEqual([]);
  });

  it("local development with no provider credentials is valid", () => {
    expect(validateConfig().errors).toEqual([]);
  });

  it("production: reports EVERY problem at once, naming each setting", () => {
    productionEnv();
    delete process.env.WEB_ORIGINS;
    process.env.COOKIE_SECURE = "false";
    process.env.DEMO_LOGIN_ENABLED = "true";
    process.env.AUTH_SCRYPT_N = "1024";
    delete process.env.SARVAM_API_KEY;
    delete process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET;
    delete process.env.DATABASE_URL;
    let message = "";
    try {
      assertValidConfig();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      message = (err as Error).message;
    }
    for (const needle of ["WEB_ORIGINS", "COOKIE_SECURE", "DEMO_LOGIN_ENABLED", "AUTH_SCRYPT_N", "SARVAM_API_KEY", "EXOTEL_AGENTSTREAM_WEBHOOK_SECRET", "DATABASE_URL"]) {
      expect(message).toContain(needle);
    }
  });

  it("production: localhost origins, a non-https webhook base URL and a short secret are rejected", () => {
    productionEnv();
    process.env.WEB_ORIGINS = "http://localhost:3000";
    process.env.EXOTEL_WEBHOOK_BASE_URL = "http://api.example.com";
    process.env.EXOTEL_AGENTSTREAM_WEBHOOK_SECRET = "short";
    const { errors } = validateConfig();
    expect(errors.some((e) => e.includes("localhost"))).toBe(true);
    expect(errors.some((e) => e.includes("https://"))).toBe(true);
    expect(errors.some((e) => e.includes("too short"))).toBe(true);
  });

  it("outside production, missing provider credentials are only warnings", () => {
    process.env.TELEPHONY_PROVIDER = "exotel";
    process.env.AI_PROVIDER = "sarvam";
    const { errors, warnings } = validateConfig();
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("EXOTEL_API_KEY"))).toBe(true);
    expect(warnings.some((w) => w.includes("SARVAM_API_KEY"))).toBe(true);
  });

  it("production with mock providers warns (no real calls) but is not an error", () => {
    productionEnv();
    process.env.TELEPHONY_PROVIDER = "mock";
    process.env.AI_PROVIDER = "mock";
    const { errors, warnings } = validateConfig();
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("TELEPHONY_PROVIDER=mock"))).toBe(true);
  });

  it("production without TRUST_PROXY or API_PRIVATE_HOSTS warns about the load-balancer pitfalls", () => {
    productionEnv();
    delete process.env.TRUST_PROXY;
    delete process.env.API_PRIVATE_HOSTS;
    const { errors, warnings } = validateConfig();
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes("TRUST_PROXY"))).toBe(true);
    expect(warnings.some((w) => w.includes("API_PRIVATE_HOSTS"))).toBe(true);
  });

  it("malformed numbers are errors in every environment (not silently NaN)", () => {
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = "lots";
    process.env.SILENCE_TIMEOUT_MS = "-5";
    process.env.SHUTDOWN_DRAIN_TIMEOUT_MS = "1.5";
    const { errors } = validateConfig();
    expect(errors.some((e) => e.includes("MAX_CONCURRENT_CALLS_PER_ORG"))).toBe(true);
    expect(errors.some((e) => e.includes("SILENCE_TIMEOUT_MS"))).toBe(true);
    expect(errors.some((e) => e.includes("SHUTDOWN_DRAIN_TIMEOUT_MS"))).toBe(true);
  });

  it("an unknown provider name is reported, not thrown", () => {
    process.env.TELEPHONY_PROVIDER = "carrier-pigeon";
    expect(validateConfig().errors.some((e) => e.includes("carrier-pigeon"))).toBe(true);
  });

  it("warns when the call-length cap is not below the stale-call reaper threshold", () => {
    process.env.MAX_CALL_DURATION_MS = "3600000";
    process.env.STALE_CALL_IN_PROGRESS_MS = "2700000";
    expect(validateConfig().warnings.some((w) => w.includes("MAX_CALL_DURATION_MS"))).toBe(true);
  });
});

describe("limit parsing is fail-safe", () => {
  it("intEnv: unset and blank use the default; a malformed value falls back to the default instead of NaN", () => {
    delete process.env.MAX_CONCURRENT_CALLS_PER_ORG;
    expect(intEnv("MAX_CONCURRENT_CALLS_PER_ORG", 10)).toBe(10);
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = "  ";
    expect(intEnv("MAX_CONCURRENT_CALLS_PER_ORG", 10)).toBe(10);
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = "banana";
    expect(intEnv("MAX_CONCURRENT_CALLS_PER_ORG", 10)).toBe(10);
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = "-3";
    expect(intEnv("MAX_CONCURRENT_CALLS_PER_ORG", 10)).toBe(10);
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = "0";
    expect(intEnv("MAX_CONCURRENT_CALLS_PER_ORG", 10)).toBe(0); // 0 is a real value: unlimited
    process.env.MAX_CONCURRENT_CALLS_PER_ORG = "25";
    expect(intEnv("MAX_CONCURRENT_CALLS_PER_ORG", 10)).toBe(25);
  });

  it("the production defaults are sensible and finite", () => {
    for (const k of ["MAX_CONCURRENT_CALLS_PER_ORG", "MAX_CALL_DURATION_MS", "SILENCE_TIMEOUT_MS", "SHUTDOWN_DRAIN_TIMEOUT_MS"]) delete process.env[k];
    const l = getConfig().limits;
    expect(l.maxConcurrentCallsPerOrg).toBeGreaterThan(0);
    expect(l.maxCallDurationMs).toBeGreaterThan(0);
    expect(l.silenceTimeoutMs).toBeGreaterThan(0);
    expect(getConfig().shutdown.drainTimeoutMs).toBeGreaterThan(0);
  });
});

describe("TRUST_PROXY", () => {
  it("is configurable as a boolean, a hop count or an address list", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("2")).toBe(2);
    expect(parseTrustProxy("10.0.0.0/8,172.16.0.0/12")).toBe("10.0.0.0/8,172.16.0.0/12");
  });
});
