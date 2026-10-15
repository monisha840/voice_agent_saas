import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { issueStreamToken, StreamTokenError, verifyStreamToken } from "./stream-token.js";
import { redactUrl } from "./telephony-auth.js";
import { scrubString } from "../shared/logger.js";

const KEY_A = randomBytes(32).toString("base64");
const KEY_B = randomBytes(32).toString("base64");
const callId = randomUUID();
const orgId = randomUUID();

const saved = process.env.STREAM_TOKEN_KEYS;
beforeEach(() => {
  process.env.STREAM_TOKEN_KEYS = `k1:${KEY_A}`;
});
afterEach(() => {
  if (saved === undefined) delete process.env.STREAM_TOKEN_KEYS;
  else process.env.STREAM_TOKEN_KEYS = saved;
  delete process.env.STREAM_TOKEN_TTL_MS;
});

async function reason(token: unknown, now?: Date): Promise<string> {
  try {
    await verifyStreamToken(token, now);
  } catch (err) {
    if (err instanceof StreamTokenError) return err.reason;
    throw err;
  }
  return "accepted";
}

describe("stream token: valid", () => {
  it("round-trips the call, organization, provider and a unique id, with an expiry in the future", async () => {
    const a = await issueStreamToken({ callId, organizationId: orgId, provider: "exotel" });
    const b = await issueStreamToken({ callId, organizationId: orgId, provider: "exotel" });
    expect(a.token).not.toBe(b.token);
    const claims = await verifyStreamToken(a.token);
    expect(claims).toMatchObject({ callId, organizationId: orgId, provider: "exotel", jti: a.jti });
    expect(claims.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(claims.jti).not.toBe((await verifyStreamToken(b.token)).jti);
  });

  it("is a standard compact JWS (HS256) with a key id, and carries no secrets", async () => {
    const { token } = await issueStreamToken({ callId, organizationId: orgId, provider: "exotel" });
    const [h, p] = token.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT", kid: "k1" });
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "iss", "jti", "nbf", "org", "prv", "sub", "typ2"]);
    expect(token).not.toContain(KEY_A);
  });
});

describe("stream token: rejected", () => {
  it("missing, empty, non-string and oversized input", async () => {
    expect(await reason(undefined)).toBe("missing");
    expect(await reason("")).toBe("missing");
    expect(await reason(["a", "b"])).toBe("missing");
    expect(await reason("x".repeat(3000))).toBe("malformed");
  });

  it("malformed structure", async () => {
    expect(await reason("not-a-jwt")).toBe("malformed");
    expect(await reason("a.b.c")).toBe("malformed");
    expect(await reason("....")).toBe("malformed");
  });

  it("a forged signature, and a payload swapped under a valid signature", async () => {
    const { token } = await issueStreamToken({ callId, organizationId: orgId, provider: "exotel" });
    const [h, p, s] = token.split(".");
    expect(await reason(`${h}.${p}.${s.slice(0, -2)}AA`)).toBe("bad_signature");
    const forged = { ...JSON.parse(Buffer.from(p, "base64url").toString()), sub: randomUUID() };
    expect(await reason(`${h}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${s}`)).toBe("bad_signature");
    // Signed with a different key but claiming the right key id.
    const other = await new SignJWT({ org: orgId, prv: "exotel", typ2: "media-stream" })
      .setProtectedHeader({ alg: "HS256", kid: "k1" })
      .setIssuer("voice-engine").setAudience("voice-engine:media-stream").setSubject(callId).setJti(randomUUID())
      .setIssuedAt().setExpirationTime("10m")
      .sign(new Uint8Array(Buffer.from(KEY_B, "base64")));
    expect(await reason(other)).toBe("bad_signature");
  });

  it("an unknown key id, and an 'alg: none' token", async () => {
    const unknownKid = await new SignJWT({ org: orgId, prv: "exotel", typ2: "media-stream" })
      .setProtectedHeader({ alg: "HS256", kid: "nope" })
      .setIssuer("voice-engine").setAudience("voice-engine:media-stream").setSubject(callId).setJti(randomUUID())
      .setIssuedAt().setExpirationTime("10m")
      .sign(new Uint8Array(Buffer.from(KEY_A, "base64")));
    expect(await reason(unknownKid)).toBe("unknown_key");

    const none = [
      Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url"),
      Buffer.from(JSON.stringify({ iss: "voice-engine", aud: "voice-engine:media-stream", sub: callId, org: orgId, exp: 9999999999 })).toString("base64url"),
      "",
    ].join(".");
    expect(["malformed", "unknown_key"]).toContain(await reason(none));
  });

  it("expired, and not yet valid", async () => {
    const past = new Date(Date.now() - 3 * 3600_000);
    const old = await issueStreamToken({ callId, organizationId: orgId, provider: "exotel", now: past });
    expect(await reason(old.token)).toBe("expired");
    const future = await issueStreamToken({ callId, organizationId: orgId, provider: "exotel", now: new Date(Date.now() + 3600_000) });
    expect(await reason(future.token)).toBe("not_yet_valid");
  });

  it("the wrong audience and the wrong issuer (a token minted for something else)", async () => {
    const key = new Uint8Array(Buffer.from(KEY_A, "base64"));
    const base = (aud: string, iss: string) =>
      new SignJWT({ org: orgId, prv: "exotel", typ2: "media-stream" })
        .setProtectedHeader({ alg: "HS256", kid: "k1" })
        .setIssuer(iss).setAudience(aud).setSubject(callId).setJti(randomUUID())
        .setIssuedAt().setExpirationTime("10m")
        .sign(key);
    expect(await reason(await base("voice-engine:dashboard", "voice-engine"))).toBe("wrong_audience");
    expect(await reason(await base("voice-engine:media-stream", "someone-else"))).toBe("wrong_issuer");
  });

  it("bad claim shapes: non-UUID call or organization, missing type", async () => {
    const key = new Uint8Array(Buffer.from(KEY_A, "base64"));
    const mint = (sub: string, org: string, typ2?: string) =>
      new SignJWT({ org, prv: "exotel", ...(typ2 ? { typ2 } : {}) })
        .setProtectedHeader({ alg: "HS256", kid: "k1" })
        .setIssuer("voice-engine").setAudience("voice-engine:media-stream").setSubject(sub).setJti(randomUUID())
        .setIssuedAt().setExpirationTime("10m")
        .sign(key);
    expect(await reason(await mint("not-a-uuid", orgId, "media-stream"))).toBe("bad_claims");
    expect(await reason(await mint(callId, "../../x", "media-stream"))).toBe("bad_claims");
    expect(await reason(await mint(callId, orgId))).toBe("wrong_type");
  });

  it("errors never contain the token", async () => {
    const { token } = await issueStreamToken({ callId, organizationId: orgId, provider: "exotel" });
    const tampered = `${token.slice(0, -3)}xyz`;
    try {
      await verifyStreamToken(tampered);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain(tampered);
      expect(JSON.stringify(err)).not.toContain(tampered);
    }
  });
});

describe("stream token: key rotation", () => {
  it("the first key signs; tokens from an older key keep verifying while it stays in the list, and stop when removed", async () => {
    const old = await issueStreamToken({ callId, organizationId: orgId, provider: "exotel" }); // signed by k1
    process.env.STREAM_TOKEN_KEYS = `k2:${KEY_B},k1:${KEY_A}`; // rotate: new signing key first, old verify-only
    const fresh = await issueStreamToken({ callId, organizationId: orgId, provider: "exotel" });
    expect(JSON.parse(Buffer.from(fresh.token.split(".")[0], "base64url").toString()).kid).toBe("k2");
    expect(await reason(old.token)).toBe("accepted");
    expect(await reason(fresh.token)).toBe("accepted");
    process.env.STREAM_TOKEN_KEYS = `k2:${KEY_B}`; // old key retired
    expect(await reason(old.token)).toBe("unknown_key");
    expect(await reason(fresh.token)).toBe("accepted");
  });

  it("refuses a weak or malformed key configuration", async () => {
    process.env.STREAM_TOKEN_KEYS = `k1:${Buffer.alloc(8).toString("base64")}`;
    await expect(issueStreamToken({ callId, organizationId: orgId, provider: "exotel" })).rejects.toThrow(/at least 32 bytes/);
    process.env.STREAM_TOKEN_KEYS = "no-colon-here";
    await expect(issueStreamToken({ callId, organizationId: orgId, provider: "exotel" })).rejects.toThrow(/<kid>:<base64/);
  });

  it("the TTL is configurable but never below 30 seconds", async () => {
    process.env.STREAM_TOKEN_TTL_MS = "1000";
    const a = await issueStreamToken({ callId, organizationId: orgId, provider: "exotel" });
    const seconds = (a.expiresAt.getTime() - Date.now()) / 1000;
    expect(seconds).toBeGreaterThan(25);
    expect(seconds).toBeLessThanOrEqual(31);
  });
});

describe("token leakage", () => {
  it("is masked in URLs and free text that reach logs", async () => {
    const { token } = await issueStreamToken({ callId, organizationId: orgId, provider: "exotel" });
    const url = `/api/telephony/exotel/media-stream?st=${token}&token=shared-secret`;
    const redacted = redactUrl(url);
    expect(redacted).not.toContain(token);
    expect(redacted).not.toContain("shared-secret");
    expect(scrubString(`connecting wss://x/api/telephony/exotel/media-stream?st=${token}`)).not.toContain(token);
  });
});
