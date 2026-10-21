/**
 * Provider selection (index.ts) and the one email-specific reliability rule: a send is retried only when it carries
 * an idempotencyKey, because a retry without one is a second email.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getEmailSender, setEmailSender } from "./index.js";
import { ReliableEmailSender } from "./reliable-email.js";
import { MockEmailSender, clearSentEmails, sentEmails } from "./mock.email.provider.js";
import { resetCircuitBreakers } from "../ai/circuit-breaker.js";
import { ProviderRequestError } from "../../shared/errors.js";
import type { EmailMessage, IEmailSender, SendResult } from "./email.interface.js";
import type { ProviderCallOptions } from "../ai/provider-common.js";

const ENV = [
  "EMAIL_PROVIDER",
  "EMAIL_FROM",
  "RESEND_API_KEY",
  "EMAIL_TIMEOUT_MS",
  "PROVIDER_MAX_ATTEMPTS",
  "PROVIDER_RETRY_BASE_DELAY_MS",
  "PROVIDER_RETRY_MAX_DELAY_MS",
  "PROVIDER_BREAKER_FAILURE_THRESHOLD",
] as const;
const saved: Record<string, string | undefined> = {};

function message(over: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to: { email: "priya@example.com" },
    subject: "Reset your password",
    text: "https://app.example.com/reset?token=abc",
    kind: "password-reset",
    ...over,
  };
}

/** An inner sender that counts attempts and fails (or hangs) as a test asks. */
class StubSender implements IEmailSender {
  attempts = 0;
  constructor(
    readonly name: string,
    private readonly behaviour: (attempt: number) => Promise<SendResult>,
  ) {}
  send(_message: EmailMessage, _opts?: ProviderCallOptions): Promise<SendResult> {
    this.attempts += 1;
    return this.behaviour(this.attempts);
  }
}

const transient = () =>
  Promise.reject(new ProviderRequestError("stub", "stub email.send failed (HTTP 500)", undefined, { category: "server", operation: "email.send" }));
const permanent = () =>
  Promise.reject(new ProviderRequestError("stub", "stub email.send refused", undefined, { category: "invalid_request", operation: "email.send" }));

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // Keep the retry waits off the clock; the policy, not the backoff, is what is under test.
  process.env.PROVIDER_MAX_ATTEMPTS = "3";
  process.env.PROVIDER_RETRY_BASE_DELAY_MS = "1";
  process.env.PROVIDER_RETRY_MAX_DELAY_MS = "2";
  setEmailSender(null);
  resetCircuitBreakers();
  clearSentEmails();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setEmailSender(null);
  resetCircuitBreakers();
  clearSentEmails();
  vi.restoreAllMocks();
});

describe("getEmailSender", () => {
  it("defaults to the mock sender, which records instead of delivering", async () => {
    const sender = getEmailSender();
    expect(sender.name).toBe("mock");

    const result = await sender.send(message());
    expect(result.accepted).toBe(true);
    expect(sentEmails()).toHaveLength(1);
  });

  it("returns the same instance on every call (selection is fixed at process start)", () => {
    expect(getEmailSender()).toBe(getEmailSender());
  });

  it("selects Resend only when EMAIL_PROVIDER says so", () => {
    process.env.EMAIL_PROVIDER = "resend";
    process.env.EMAIL_FROM = "no-reply@mail.example.com";
    process.env.RESEND_API_KEY = "re_test_key";
    expect(getEmailSender().name).toBe("resend");
  });

  it("refuses an unknown EMAIL_PROVIDER rather than falling back to the mock", () => {
    process.env.EMAIL_PROVIDER = "sendgrid";
    expect(() => getEmailSender()).toThrow(/Invalid provider value "sendgrid"/);
  });

  it("setEmailSender installs a sender for tests, and null restores the configured one", async () => {
    const stub = new StubSender("stub-install", async () => ({ providerMessageId: "x", accepted: true }));
    setEmailSender(stub);
    expect(getEmailSender()).toBe(stub);
    setEmailSender(null);
    expect(getEmailSender().name).toBe("mock");
  });
});

describe("ReliableEmailSender", () => {
  it("does NOT retry a message without an idempotency key: one retry would be a second email", async () => {
    const inner = new StubSender("stub-no-key", transient);
    await expect(new ReliableEmailSender(inner).send(message())).rejects.toMatchObject({ category: "server" });
    expect(inner.attempts).toBe(1);
  });

  it("retries a transient failure when the message carries an idempotency key (the provider collapses the repeat)", async () => {
    const inner = new StubSender("stub-with-key", transient);
    await expect(new ReliableEmailSender(inner).send(message({ idempotencyKey: "password-reset:7:1" }))).rejects.toMatchObject({ category: "server" });
    expect(inner.attempts).toBe(3);
  });

  it("succeeds on a retry and reports the provider's result", async () => {
    const inner = new StubSender("stub-recovers", (attempt) =>
      attempt === 1 ? transient() : Promise.resolve({ providerMessageId: "id-2", accepted: true }),
    );
    await expect(new ReliableEmailSender(inner).send(message({ idempotencyKey: "invite:1:v1" }))).resolves.toEqual({
      providerMessageId: "id-2",
      accepted: true,
    });
    expect(inner.attempts).toBe(2);
  });

  it("never retries a permanent failure, idempotency key or not", async () => {
    const inner = new StubSender("stub-permanent", permanent);
    await expect(new ReliableEmailSender(inner).send(message({ idempotencyKey: "invite:2:v1" }))).rejects.toMatchObject({
      category: "invalid_request",
    });
    expect(inner.attempts).toBe(1);
  });

  it("bounds a send that hangs with EMAIL_TIMEOUT_MS", async () => {
    process.env.EMAIL_TIMEOUT_MS = "20";
    const inner = new StubSender("stub-hangs", () => new Promise<SendResult>(() => undefined));
    await expect(new ReliableEmailSender(inner).send(message())).rejects.toMatchObject({ category: "timeout" });
    expect(inner.attempts).toBe(1);
  });

  it("fails fast while the provider is unhealthy instead of holding up the request that triggered the send", async () => {
    process.env.PROVIDER_BREAKER_FAILURE_THRESHOLD = "2";
    const inner = new StubSender("stub-breaker", transient);
    const sender = new ReliableEmailSender(inner);

    await expect(sender.send(message())).rejects.toMatchObject({ category: "server" });
    await expect(sender.send(message())).rejects.toMatchObject({ category: "server" });
    expect(inner.attempts).toBe(2);

    await expect(sender.send(message())).rejects.toMatchObject({ category: "circuit_open" });
    expect(inner.attempts).toBe(2); // the provider was not touched
  });

  it("passes the caller's cancellation through and reports it as cancelled, not as a failure", async () => {
    const inner = new StubSender("stub-cancel", () => new Promise<SendResult>(() => undefined));
    await expect(new ReliableEmailSender(inner).send(message(), { signal: AbortSignal.abort() })).rejects.toMatchObject({
      category: "cancelled",
    });
    expect(inner.attempts).toBe(0);
  });

  it("keeps the wrapped sender's name, so logs and metrics name the real provider", () => {
    expect(new ReliableEmailSender(new MockEmailSender()).name).toBe("mock");
  });
});
