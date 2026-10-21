/**
 * Startup validation of the email settings (config/validate.ts) and their parsing (config/env.ts).
 *
 * The rule under test: a production process must refuse to start when the links it would mail are unusable or when a
 * real provider was selected without its credentials. Development keeps working with nothing configured at all.
 *
 * Assertions look for the problems these settings cause, not for an exact list: a production environment assembled
 * from nothing reports plenty of unrelated ones.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { validateConfig } from "../../config/validate.js";
import { getConfig } from "../../config/env.js";

const TOUCHED = ["NODE_ENV", "APP_BASE_URL", "EMAIL_PROVIDER", "EMAIL_FROM", "EMAIL_REPLY_TO", "RESEND_API_KEY", "EMAIL_TIMEOUT_MS"] as const;
const saved: Record<string, string | undefined> = {};

/** The problems (errors or warnings) these settings are responsible for. */
const about = (list: string[], re: RegExp) => list.filter((p) => re.test(p));
const EMAIL_SETTINGS = /APP_BASE_URL|EMAIL_|RESEND_API_KEY/;

beforeEach(() => {
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("email configuration defaults", () => {
  it("runs with nothing configured: the mock sender and the dashboard's dev address, no complaints", () => {
    const cfg = getConfig();
    expect(cfg.email.provider).toBe("mock");
    expect(cfg.email.from).toBe("");
    expect(cfg.email.replyTo).toBe("");
    expect(cfg.email.timeoutMs).toBe(10_000);
    expect(cfg.appBaseUrl).toBe("http://localhost:3000");

    const { errors, warnings } = validateConfig();
    expect(about(errors, EMAIL_SETTINGS)).toEqual([]);
    expect(about(warnings, EMAIL_SETTINGS)).toEqual([]);
  });

  it("strips trailing slashes from APP_BASE_URL so a link is never built with a double slash", () => {
    process.env.APP_BASE_URL = "https://app.example.com//";
    expect(getConfig().appBaseUrl).toBe("https://app.example.com");
  });

  it("rejects an unknown EMAIL_PROVIDER instead of falling back to the mock", () => {
    process.env.EMAIL_PROVIDER = "ses";
    expect(validateConfig().errors).toContainEqual(expect.stringContaining('Invalid provider value "ses"'));
  });

  it("reports a malformed EMAIL_TIMEOUT_MS", () => {
    process.env.EMAIL_TIMEOUT_MS = "soon";
    expect(validateConfig().errors).toContainEqual(expect.stringContaining("EMAIL_TIMEOUT_MS must be a non-negative whole number"));
  });
});

describe("APP_BASE_URL validation", () => {
  it("is an error in any environment when it is not an absolute http(s) URL", () => {
    process.env.APP_BASE_URL = "app.example.com";
    expect(about(validateConfig().errors, /APP_BASE_URL/)).toHaveLength(1);
    expect(about(validateConfig().errors, /APP_BASE_URL/)[0]).toMatch(/absolute http:\/\/ or https:\/\/ URL/);
  });

  it("production refuses a missing value", () => {
    process.env.NODE_ENV = "production";
    expect(about(validateConfig().errors, /APP_BASE_URL/)[0]).toMatch(/must be set to the dashboard's public https:\/\/ address in production/);
  });

  it("production refuses a non-https value", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_BASE_URL = "http://app.example.com";
    expect(about(validateConfig().errors, /APP_BASE_URL/)[0]).toMatch(/must be an https:\/\/ URL in production/);
  });

  it("production refuses a localhost dashboard address", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_BASE_URL = "https://localhost:3000";
    expect(about(validateConfig().errors, /APP_BASE_URL/)[0]).toMatch(/not localhost/);
  });

  it("production accepts the dashboard's public https address", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_BASE_URL = "https://app.example.com";
    expect(about(validateConfig().errors, /APP_BASE_URL/)).toEqual([]);
  });

  it("development is happy with the local dashboard", () => {
    process.env.APP_BASE_URL = "http://localhost:3000";
    expect(about(validateConfig().errors, /APP_BASE_URL/)).toEqual([]);
    expect(about(validateConfig().warnings, /APP_BASE_URL/)).toEqual([]);
  });
});

describe("email provider validation", () => {
  it("a real provider without its credentials is a warning in development and an error in production", () => {
    process.env.EMAIL_PROVIDER = "resend";

    const dev = validateConfig();
    expect(about(dev.errors, /RESEND_API_KEY/)).toEqual([]);
    expect(about(dev.warnings, /RESEND_API_KEY/)[0]).toMatch(/EMAIL_PROVIDER=resend requires RESEND_API_KEY, EMAIL_FROM/);

    process.env.NODE_ENV = "production";
    const prod = validateConfig();
    expect(about(prod.errors, /RESEND_API_KEY/)[0]).toMatch(/EMAIL_PROVIDER=resend requires RESEND_API_KEY, EMAIL_FROM/);
  });

  it("names only the credential that is actually missing", () => {
    process.env.NODE_ENV = "production";
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_FROM = "Voice Agent <no-reply@mail.example.com>";
    expect(about(validateConfig().errors, /RESEND_API_KEY/)[0]).toMatch(/requires RESEND_API_KEY$/);
  });

  it("a fully configured real provider in production reports nothing about email", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_BASE_URL = "https://app.example.com";
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_FROM = "Voice Agent <no-reply@mail.example.com>";
    process.env.EMAIL_REPLY_TO = "support@example.com";
    process.env.RESEND_API_KEY = "re_live_key";

    const { errors, warnings } = validateConfig();
    expect(about(errors, EMAIL_SETTINGS)).toEqual([]);
    expect(about(warnings, EMAIL_SETTINGS)).toEqual([]);
  });

  /**
   * An ERROR, not a warning (decided 2026-10-21), unlike mock telephony/AI. The mock sender delivers nothing AND the
   * invite endpoint returns the invitation link in its response body whenever the sender is the mock, so a production
   * boot on mock email would put a live 7-day credential into access logs while resets never arrive.
   */
  it("production refuses to start on the mock sender", () => {
    process.env.NODE_ENV = "production";
    const { errors, warnings } = validateConfig();
    expect(about(errors, /EMAIL_PROVIDER/)[0]).toMatch(/must not be mock in production/);
    // and it must not ALSO be reported as a mere warning
    expect(about(warnings, /EMAIL_PROVIDER/)).toEqual([]);
  });

  it.each([
    ["EMAIL_FROM", "no-reply"],
    ["EMAIL_FROM", "Voice Agent <no-reply@mail.example.com>, attacker@evil.test"],
    ["EMAIL_REPLY_TO", "support@example.com\r\nBcc: attacker@evil.test"],
  ])("rejects a %s that is not a usable address (%s)", (name, value) => {
    process.env[name] = value;
    expect(about(validateConfig().errors, new RegExp(name))[0]).toMatch(/must be "name@example.com" or "Name <name@example.com>"/);
  });
});
