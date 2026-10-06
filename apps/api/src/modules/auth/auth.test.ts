import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { buildApp } from "../../app.js";
import { db } from "../../db/client.js";
import { sessions, users } from "../../db/schema.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import { hashSessionToken } from "../../auth/session.service.js";
import { usersRepository } from "../../db/repositories/users.repository.js";

type App = Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = "correct horse battery staple";
let app: App;
const createdUserIds: string[] = [];

async function makeUser(email: string, opts: { active?: boolean; password?: string } = {}) {
  const user = await usersRepository.create({
    email,
    name: "Test User",
    passwordHash: await hashPassword(opts.password ?? PASSWORD),
  });
  if (opts.active === false) await usersRepository.setActive({ id: user.id, isActive: false });
  createdUserIds.push(user.id);
  return user;
}

const login = (email: string, password: string, headers: Record<string, string> = {}, ip = "10.0.0.1") =>
  app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password }, headers, remoteAddress: ip });

function cookieFrom(res: { cookies: Array<{ name: string; value: string }> }) {
  const c = res.cookies.find((x) => x.name === "va_session");
  return c ? `va_session=${c.value}` : "";
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  for (const id of createdUserIds) await db.delete(users).where(eq(users.id, id));
  await app.close();
});

describe("password hashing", () => {
  it("verifies the right password, rejects the wrong one, and never stores plaintext", async () => {
    const hash = await hashPassword("s3cret-passphrase");
    expect(hash.startsWith("scrypt$")).toBe(true);
    expect(hash).not.toContain("s3cret-passphrase");
    expect(await verifyPassword("s3cret-passphrase", hash)).toBe(true);
    expect(await verifyPassword("s3cret-passphrasf", hash)).toBe(false);
  });

  it("salts every hash and rejects malformed stored values", async () => {
    expect(await hashPassword("same")).not.toBe(await hashPassword("same"));
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
    expect(await verifyPassword("x", "scrypt$1$2$3$4")).toBe(false);
  });
});

describe("login / session / logout", () => {
  it("logs in with a valid password and sets an httpOnly, SameSite=Lax session cookie", async () => {
    await makeUser("login-ok@example.test");
    const res = await login("Login-OK@Example.test", PASSWORD); // email is case-insensitive
    expect(res.statusCode).toBe(200);
    expect(res.json().data.email).toBe("login-ok@example.test");
    expect(JSON.stringify(res.json())).not.toMatch(/password|hash/i);
    const raw = String(res.headers["set-cookie"]);
    expect(raw).toMatch(/va_session=/);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
  });

  it("stores only a hash of the session token, never the token itself", async () => {
    await makeUser("hashed-token@example.test");
    const res = await login("hashed-token@example.test", PASSWORD);
    const token = cookieFrom(res).split("=")[1];
    const rows = await db.select().from(sessions).where(eq(sessions.tokenHash, hashSessionToken(token)));
    expect(rows).toHaveLength(1);
    const all = await db.select().from(sessions);
    expect(all.some((s) => s.tokenHash === token)).toBe(false);
  });

  it("gives the same 401 for unknown email, wrong password and disabled account", async () => {
    await makeUser("exists@example.test");
    await makeUser("disabled@example.test", { active: false });
    const unknown = await login("nobody@example.test", PASSWORD);
    const wrong = await login("exists@example.test", "wrong-password-123");
    const disabled = await login("disabled@example.test", PASSWORD);
    for (const r of [unknown, wrong, disabled]) {
      expect(r.statusCode).toBe(401);
      expect(r.json().error).toBe("Invalid email or password");
      expect(r.headers["set-cookie"]).toBeUndefined();
    }
  });

  it("rejects malformed login bodies with 400 and no stack trace", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "not-an-email" } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Invalid request/);
    expect(JSON.stringify(res.json())).not.toMatch(/at .*\(.*\.ts/);
  });

  it("/api/auth/me works with the cookie, and logout invalidates it server-side", async () => {
    await makeUser("me@example.test");
    const cookie = cookieFrom(await login("me@example.test", PASSWORD));
    const me = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().data.email).toBe("me@example.test");

    const out = await app.inject({ method: "POST", url: "/api/auth/logout", headers: { cookie } });
    expect(out.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } });
    expect(after.statusCode).toBe(401); // the old cookie is dead even if someone kept it
  });

  it("an expired session is rejected and removed", async () => {
    const user = await makeUser("expired@example.test");
    const cookie = cookieFrom(await login("expired@example.test", PASSWORD));
    await db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(sessions.userId, user.id));
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
    expect(await db.select().from(sessions).where(eq(sessions.userId, user.id))).toHaveLength(0);
  });

  it("disabling a user kills their existing sessions immediately", async () => {
    const user = await makeUser("soon-disabled@example.test");
    const cookie = cookieFrom(await login("soon-disabled@example.test", PASSWORD));
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(200);
    await usersRepository.setActive({ id: user.id, isActive: false });
    expect((await app.inject({ method: "GET", url: "/api/auth/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("throttles repeated failed logins for the same account and IP", async () => {
    await makeUser("throttle@example.test");
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await login("throttle@example.test", "bad-password-xyz", {}, "10.9.9.9")).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    // A different IP is not affected.
    expect((await login("throttle@example.test", PASSWORD, {}, "10.8.8.8")).statusCode).toBe(200);
  });
});

describe("the login gate", () => {
  it("blocks every protected API route without a session", async () => {
    for (const [method, url] of [
      ["GET", "/api/leads"],
      ["GET", "/api/projects"],
      ["GET", "/api/calls/00000000-0000-0000-0000-000000000000"],
      ["POST", "/api/leads/00000000-0000-0000-0000-000000000000/call"],
      ["GET", "/api/auth/me"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });

  it("rejects a forged or garbage cookie", async () => {
    for (const cookie of ["va_session=garbage", `va_session=${"a".repeat(500)}`, "va_session="]) {
      expect((await app.inject({ method: "GET", url: "/api/leads", headers: { cookie } })).statusCode).toBe(401);
    }
  });

  it("keeps health and the webhook-secret endpoints reachable without a login", async () => {
    expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    const cb = await app.inject({
      method: "POST",
      url: "/api/telephony/exotel/status-callback",
      payload: { providerCallId: "unknown", status: "ringing" },
    });
    expect(cb.statusCode).toBe(200); // mock mode without a secret is open; with a secret it would be 401, not a login redirect
  });

  it("refuses a cookie-authenticated state change that comes from a foreign origin (CSRF)", async () => {
    await makeUser("csrf@example.test");
    const cookie = cookieFrom(await login("csrf@example.test", PASSWORD));
    const evil = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, origin: "https://evil.example" },
    });
    expect(evil.statusCode).toBe(403);
    const ok = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { cookie, origin: "http://127.0.0.1:3000" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("only echoes CORS credentials for the dashboard origin", async () => {
    const good = await app.inject({ method: "GET", url: "/health", headers: { origin: "http://127.0.0.1:3000" } });
    expect(good.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3000");
    expect(good.headers["access-control-allow-credentials"]).toBe("true");
    const bad = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://evil.example" } });
    expect(bad.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("dev-only demo login", () => {
  it("signs in the seeded demo user without a password, locally", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/demo-login" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.email).toBe("demo@greenvalley.demo");
    expect(cookieFrom(res)).toMatch(/^va_session=/);
  });

  it("the demo user cannot log in with a password (it is random and unknown)", async () => {
    expect((await login("demo@greenvalley.demo", "password")).statusCode).toBe(401);
  });

  it("is invisible to requests that came through a tunnel/proxy", async () => {
    const res = await app.inject({ method: "POST", url: "/api/auth/demo-login", headers: { "x-forwarded-for": "203.0.113.5" } });
    expect(res.statusCode).toBe(404);
  });

  it("is switched off by DEMO_LOGIN_ENABLED=false", async () => {
    const prev = process.env.DEMO_LOGIN_ENABLED;
    process.env.DEMO_LOGIN_ENABLED = "false";
    try {
      expect((await app.inject({ method: "POST", url: "/api/auth/demo-login" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/auth/config" })).json().data.demoLoginEnabled).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.DEMO_LOGIN_ENABLED;
      else process.env.DEMO_LOGIN_ENABLED = prev;
    }
  });
});
