/**
 * The mock sender is what makes the product exercisable with no credentials, so what it records (and what it refuses
 * to log) is a contract of its own.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MockEmailSender, clearSentEmails, lastSentEmail, sentEmails, sentEmailsTo } from "./mock.email.provider.js";
import { maskEmail } from "./address.js";
import type { EmailMessage } from "./email.interface.js";

function message(over: Partial<EmailMessage> = {}): EmailMessage {
  return {
    to: { email: "priya@example.com", name: "Priya Sharma" },
    subject: "You have been invited to Acme Realty",
    text: "Accept the invitation:\nhttps://app.example.com/invite/accept?token=secret-token-value",
    html: "<p>Accept</p>",
    kind: "invite",
    ...over,
  };
}

describe("MockEmailSender", () => {
  beforeEach(() => clearSentEmails());
  afterEach(() => {
    clearSentEmails();
    vi.restoreAllMocks();
  });

  it("records what would have been sent and reports acceptance with an id", async () => {
    const sender = new MockEmailSender();
    const result = await sender.send(message());

    expect(sender.name).toBe("mock");
    expect(result.accepted).toBe(true);
    expect(result.providerMessageId).toMatch(/^mock-email-\d+$/);

    const recorded = sentEmails();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].message.to.email).toBe("priya@example.com");
    expect(recorded[0].message.text).toContain("secret-token-value"); // the development inbox keeps the body
    expect(recorded[0].providerMessageId).toBe(result.providerMessageId);
    expect(recorded[0].at).toBeInstanceOf(Date);
    expect(lastSentEmail()?.message.kind).toBe("invite");
  });

  it("logs one line that names the kind and a masked recipient, and never the subject or the body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await new MockEmailSender().send(message({ idempotencyKey: "invite:42:v1" }));

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(line).toContain('"kind":"invite"');
    expect(line).toContain(`"to":"${maskEmail("priya@example.com")}"`);
    expect(line).toContain('"idempotencyKey":"invite:42:v1"');
    expect(line).not.toContain("secret-token-value");
    expect(line).not.toContain("Acme Realty");
    expect(line).not.toContain("priya@example.com");
    expect(line).not.toContain("<p>");
  });

  it("collapses a repeat of the same idempotency key instead of recording a second message", async () => {
    const sender = new MockEmailSender();
    const first = await sender.send(message({ idempotencyKey: "password-reset:7:1700000000" }));
    const second = await sender.send(message({ idempotencyKey: "password-reset:7:1700000000" }));

    expect(second.providerMessageId).toBe(first.providerMessageId);
    expect(second.accepted).toBe(true);
    expect(sentEmails()).toHaveLength(1);
  });

  it("records every message when no idempotency key is given, and finds them by recipient", async () => {
    const sender = new MockEmailSender();
    await sender.send(message());
    await sender.send(message());
    await sender.send(message({ to: { email: "OTHER@example.com" }, kind: "password-reset" }));

    expect(sentEmails()).toHaveLength(3);
    expect(sentEmailsTo("priya@example.com")).toHaveLength(2);
    expect(sentEmailsTo("other@example.com")).toHaveLength(1); // address compared case-insensitively
  });

  it("clearSentEmails empties the outbox and forgets the collapsed keys", async () => {
    const sender = new MockEmailSender();
    await sender.send(message({ idempotencyKey: "invite:1:v1" }));
    clearSentEmails();
    expect(sentEmails()).toHaveLength(0);
    expect(lastSentEmail()).toBeUndefined();

    await sender.send(message({ idempotencyKey: "invite:1:v1" }));
    expect(sentEmails()).toHaveLength(1);
  });

  it("the outbox a caller reads is a copy: it cannot be mutated from outside", async () => {
    await new MockEmailSender().send(message());
    const recorded = sentEmails() as unknown as EmailMessage[];
    recorded.length = 0;
    expect(sentEmails()).toHaveLength(1);
  });
});

describe("maskEmail", () => {
  it("keeps the domain and one character of the local part", () => {
    expect(maskEmail("priya@example.com")).toBe("p***@example.com");
    expect(maskEmail("not-an-address")).toBe("***");
  });
});
