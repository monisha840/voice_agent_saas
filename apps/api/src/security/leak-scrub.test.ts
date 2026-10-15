/** Pure unit tests for the credential scrubbers used by request logs, the structured logger and audit metadata. */
import { describe, expect, it } from "vitest";
import { maskQueryCredentials, scrubFields, scrubString } from "../shared/logger.js";
import { redactUrl } from "./telephony-auth.js";
import { sanitizeMetadata } from "../modules/audit/audit.service.js";

const S = "s3cr3t-VALUE-0123456789";

describe("credential scrubbing", () => {
  it("masks token / st / g and the other credential-named query keys, in any position", () => {
    for (const key of ["token", "st", "g", "access_token", "api_key", "password", "secret"]) {
      expect(redactUrl(`/p?a=1&${key}=${S}&b=2`)).toBe(`/p?a=1&${key}=[redacted]&b=2`);
      expect(redactUrl(`/p?${key}=${S}`)).toBe(`/p?${key}=[redacted]`);
    }
  });

  it("masks percent-encoded and upper-case spellings of a credential key", () => {
    expect(redactUrl(`/p?t%6Fken=${S}`)).not.toContain(S);
    expect(redactUrl(`/p?%73t=${S}`)).not.toContain(S);
    expect(redactUrl(`/p?TOKEN=${S}&G=${S}`)).not.toContain(S);
  });

  it("leaves harmless parameters alone", () => {
    expect(redactUrl("/p?CallSid=abc&internalCallId=123&Direction=inbound")).toBe("/p?CallSid=abc&internalCallId=123&Direction=inbound");
    expect(maskQueryCredentials("/p?stage=1&gate=2")).toBe("/p?stage=1&gate=2");
  });

  it("masks user:password@host credentials, Basic and Bearer values in free text", () => {
    expect(scrubString(`connecting wss://exotel:${S}@api.example.com/media-stream`)).not.toContain(S);
    expect(scrubString(`Authorization: Basic ${Buffer.from(`u:${S}`).toString("base64")}`)).not.toContain(Buffer.from(`u:${S}`).toString("base64"));
    expect(scrubString(`Bearer ${S}`)).not.toContain(S);
  });

  it("scrubs nested structured-log fields (err.url, request urls) and secret-named keys", () => {
    const out = JSON.stringify(scrubFields({ err: { url: `https://h/p?token=${S}`, config: { headers: { authorization: `Basic ${S}` } } }, grant: S }));
    expect(out).not.toContain(S);
  });

  it("audit / security-event metadata strings are scrubbed too, before truncation", () => {
    const meta = sanitizeMetadata({ note: `see /api/telephony/exotel/media-stream?g=${S}&st=${S}`, url: `wss://u:${S}@h/x`, long: `${"x".repeat(495)}?token=${S}` }) as Record<string, string>;
    expect(JSON.stringify(meta)).not.toContain(S);
  });
});
