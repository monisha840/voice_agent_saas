import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkPassword } from "./password-policy.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.PWNED_PASSWORDS;
});

describe("checkPassword (local rules)", () => {
  it("applies length, blocklist, repetition and identity rules", async () => {
    expect(await checkPassword({ password: "short1" })).toBe("too_short");
    expect(await checkPassword({ password: "x".repeat(129) })).toBe("too_long");
    expect(await checkPassword({ password: "Password123" })).toBe("too_common");
    expect(await checkPassword({ password: "bbbbbbbbbbbb" })).toBe("too_common");
    expect(await checkPassword({ password: "meera-sundar-2026", email: "meera.sundar@example.test", name: "Meera Sundar" })).toBe(
      "contains_identity",
    );
    expect(await checkPassword({ password: "pelican-lantern-orbit-91", email: "a@example.test", name: "Ann" })).toBeNull();
  });

  it("does not impose composition rules (a long lowercase passphrase is fine)", async () => {
    expect(await checkPassword({ password: "correct horse battery staple" })).toBeNull();
  });
});

describe("checkPassword (breached-password screening, k-anonymity)", () => {
  const password = "an-unremarkable-passphrase-77";
  const sha1 = createHash("sha1").update(password).digest("hex").toUpperCase();

  it("sends only the 5-character SHA-1 prefix and rejects a password found in the range", async () => {
    process.env.PWNED_PASSWORDS = "fail-open";
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`);
      expect(url).not.toContain(password);
      return new Response(`0000000000000000000000000000000000A:3\n${sha1.slice(5)}:41\n`, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await checkPassword({ password })).toBe("breached");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a password that is not in the range", async () => {
    process.env.PWNED_PASSWORDS = "fail-closed";
    vi.stubGlobal("fetch", vi.fn(async () => new Response("0000000000000000000000000000000000A:3\n", { status: 200 })));
    expect(await checkPassword({ password })).toBeNull();
  });

  it("when the service is down: fail-open accepts, fail-closed refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    process.env.PWNED_PASSWORDS = "fail-open";
    expect(await checkPassword({ password })).toBeNull();
    process.env.PWNED_PASSWORDS = "fail-closed";
    expect(await checkPassword({ password })).toBe("check_unavailable");
  });

  it("is not called at all when screening is off", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await checkPassword({ password })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
