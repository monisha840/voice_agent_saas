/**
 * The Resend adapter: request shaping and failure classification. `fetch` is always stubbed — no test may reach the
 * real API, and the "not configured" tests must not depend on the ambient environment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ResendEmailProvider } from "./resend.email.provider.js";
import { ProviderConfigError, ProviderRequestError } from "../../shared/errors.js";
import type { EmailMessage } from "./email.interface.js";

const ENV = ["EMAIL_PROVIDER", "EMAIL_FROM", "EMAIL_REPLY_TO", "RESEND_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

function message(over: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to: { email: "priya@example.com", name: "Priya Sharma" },
    subject: "Reset your password",
    text: "Reset your password:\nhttps://app.example.com/reset?token=abc",
    html: "<p>Reset</p>",
    kind: "password-reset",
    ...over,
  };
}

/** A stubbed fetch that answers once with this status/body and records the call. */
function stubFetch(status: number, body: string | object, headers: Record<string, string> = {}) {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(payload, { status, headers: { "content-type": "application/json", ...headers } }));
}

beforeEach(() => {
  for (const k of ENV) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.EMAIL_PROVIDER = "resend";
  process.env.EMAIL_FROM = "Voice Agent <no-reply@mail.example.com>";
  process.env.RESEND_API_KEY = "re_test_key";
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("ResendEmailProvider configuration", () => {
  it("refuses to send without RESEND_API_KEY, and says how to develop without one", async () => {
    delete process.env.RESEND_API_KEY;
    const fetchSpy = stubFetch(200, { id: "nope" });

    await expect(new ResendEmailProvider().send(message())).rejects.toBeInstanceOf(ProviderConfigError);
    await expect(new ResendEmailProvider().send(message())).rejects.toThrow(/RESEND_API_KEY[\s\S]*EMAIL_PROVIDER=mock/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses to send without EMAIL_FROM", async () => {
    delete process.env.EMAIL_FROM;
    await expect(new ResendEmailProvider().send(message())).rejects.toThrow(/EMAIL_FROM/);
  });

  it("refuses a malformed EMAIL_FROM as a configuration error, not a request error", () => {
    process.env.EMAIL_FROM = "no-reply@localhost";
    expect(() => new ResendEmailProvider().buildRequest(message())).toThrow(ProviderConfigError);
  });
});

describe("ResendEmailProvider request shaping", () => {
  it("builds the documented POST: bearer token, JSON body, text and html, no idempotency header when none is given", () => {
    const { url, headers, body } = new ResendEmailProvider().buildRequest(message());

    expect(url).toBe("https://api.resend.com/emails");
    expect(headers).toEqual({
      Authorization: "Bearer re_test_key",
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    expect(body).toEqual({
      from: "Voice Agent <no-reply@mail.example.com>",
      to: ["Priya Sharma <priya@example.com>"],
      subject: "Reset your password",
      text: "Reset your password:\nhttps://app.example.com/reset?token=abc",
      html: "<p>Reset</p>",
    });
  });

  it("sends the caller's idempotency key as the Idempotency-Key header", () => {
    const { headers } = new ResendEmailProvider().buildRequest(message({ idempotencyKey: "password-reset:7:1700000000" }));
    expect(headers["Idempotency-Key"]).toBe("password-reset:7:1700000000");
  });

  it("refuses an idempotency key that could restructure the request, without attempting a send", async () => {
    const fetchSpy = stubFetch(200, { id: "x" });
    const bad = message({ idempotencyKey: "abc\r\nX-Injected: 1" });

    await expect(new ResendEmailProvider().send(bad)).rejects.toMatchObject({ category: "invalid_request" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("strips characters from a display name that would add a header or a second recipient", () => {
    const { body } = new ResendEmailProvider().buildRequest(
      message({ to: { email: "priya@example.com", name: 'Priya" <evil@attacker.test>, Bob\r\nBcc: x@y.test' } }),
    );
    expect(body.to).toHaveLength(1);
    expect(body.to[0]).toBe("Priya evil@attacker.test Bob Bcc x@y.test <priya@example.com>");
    expect(body.to[0]).not.toContain("\r");
    expect(body.to[0]).not.toContain("\n");
    expect(body.to[0]).not.toContain('"');
    expect(body.to[0].split("<")).toHaveLength(2);
  });

  it("refuses an invalid recipient as a permanent request error (never retried, never sent)", async () => {
    const fetchSpy = stubFetch(200, { id: "x" });
    await expect(new ResendEmailProvider().send(message({ to: { email: "not-an-address" } }))).rejects.toMatchObject({
      category: "invalid_request",
      transient: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("refuses a message with no text body: text is the message", () => {
    expect(() => new ResendEmailProvider().buildRequest(message({ text: "   " }))).toThrow(/plain-text body is empty/);
  });

  it("uses the message's reply-to, else EMAIL_REPLY_TO, else sends no reply_to", () => {
    expect(new ResendEmailProvider().buildRequest(message()).body.reply_to).toBeUndefined();

    process.env.EMAIL_REPLY_TO = "support@example.com";
    expect(new ResendEmailProvider().buildRequest(message()).body.reply_to).toBe("support@example.com");

    const withOwn = new ResendEmailProvider().buildRequest(message({ replyTo: { email: "sales@example.com", name: "Sales" } }));
    expect(withOwn.body.reply_to).toBe("Sales <sales@example.com>");
  });

  it("omits html when the caller gives none", () => {
    const { body } = new ResendEmailProvider().buildRequest(message({ html: undefined }));
    expect("html" in body).toBe(false);
  });
});

describe("ResendEmailProvider send", () => {
  it("posts the built request and returns the provider's message id", async () => {
    const fetchSpy = stubFetch(200, { id: "e1b2c3d4-0000-4000-8000-000000000000" });

    const result = await new ResendEmailProvider().send(message({ idempotencyKey: "invite:1:v1" }));

    expect(result).toEqual({ providerMessageId: "e1b2c3d4-0000-4000-8000-000000000000", accepted: true });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("invite:1:v1");
    expect(JSON.parse(init.body as string).subject).toBe("Reset your password");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("accepts a { data: { id } } envelope as well as a bare id", async () => {
    stubFetch(200, { data: { id: "msg-7" } });
    await expect(new ResendEmailProvider().send(message())).resolves.toEqual({ providerMessageId: "msg-7", accepted: true });
  });

  const statusCases: Array<[number, string, boolean]> = [
    [401, "auth", false],
    [422, "invalid_request", false],
    [429, "rate_limited", true],
    [500, "server", true],
  ];
  it.each(statusCases)("maps HTTP %i to the %s category (transient: %s)", async (status, category, transient) => {
    stubFetch(status, { message: "nope" });
    const err = await new ResendEmailProvider().send(message()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderRequestError);
    expect(err).toMatchObject({ category, transient, status });
  });

  it("reads Retry-After on a 429 so the retry respects the provider's own hint", async () => {
    stubFetch(429, { message: "slow down" }, { "retry-after": "2" });
    const err = (await new ResendEmailProvider().send(message()).catch((e: unknown) => e)) as ProviderRequestError;
    expect(err.retryAfterMs).toBe(2000);
  });

  it("never repeats the provider's response body or our credentials in the error or its log fields", async () => {
    stubFetch(401, { message: "API key re_test_key is invalid" });
    const err = (await new ResendEmailProvider().send(message()).catch((e: unknown) => e)) as ProviderRequestError;
    expect(err.message).not.toContain("re_test_key");
    expect(JSON.stringify(err.toLogFields())).not.toContain("re_test_key");
  });

  it("classifies a dropped connection as network, and a timeout as timeout", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    await expect(new ResendEmailProvider().send(message())).rejects.toMatchObject({ category: "network", transient: true });

    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeout);
    await expect(new ResendEmailProvider().send(message())).rejects.toMatchObject({ category: "timeout", transient: true });
  });

  it("treats a 2xx that is not usable as bad_response", async () => {
    stubFetch(200, "not json at all");
    await expect(new ResendEmailProvider().send(message())).rejects.toMatchObject({ category: "bad_response" });

    stubFetch(200, { accepted: true });
    await expect(new ResendEmailProvider().send(message())).rejects.toMatchObject({ category: "bad_response" });
  });
});
