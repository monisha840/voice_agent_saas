/**
 * Session revocation, session management, MFA, login throttling, password policy and the security audit trail,
 * end to end through the real HTTP app and the real PostgreSQL (restricted runtime role, RLS on).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { buildApp } from "../../app.js";
import { adminDb as db } from "../../db/client.js";
import { authThrottle, memberships, mfaRecoveryCodes, securityEvents, sessions, users } from "../../db/schema.js";
import { accountService } from "../../auth/account.service.js";
import { codeAt } from "../../auth/totp.js";
import { hashPassword } from "../../auth/password.js";
import { cleanupTenants, createMember, createTenant, TEST_PASSWORD, type TestTenant } from "../../test/tenants.js";
import { usersRepository } from "../../test/repos.js";

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let A: TestTenant;
let B: TestTenant;
let ipCounter = 0;
const nextIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  cookie: string;
  headers: Record<string, unknown>;
}

async function call(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, opts: { cookie?: string; body?: unknown; ip?: string } = {}): Promise<Res> {
  const res = await app.inject({
    method,
    url,
    remoteAddress: opts.ip ?? "10.99.0.1",
    headers: opts.cookie ? { cookie: opts.cookie } : {},
    payload: opts.body === undefined ? undefined : (opts.body as object),
  });
  const set = res.cookies.find((c) => c.name === "va_session");
  let body: unknown = null;
  try {
    body = res.json();
  } catch {
    body = null;
  }
  return { status: res.statusCode, body, cookie: set ? `va_session=${set.value}` : "", headers: res.headers };
}

async function login(email: string, password = TEST_PASSWORD, ip = nextIp()): Promise<Res> {
  return call("POST", "/api/auth/login", { body: { email, password }, ip });
}

async function loginOk(email: string, ip = nextIp()): Promise<string> {
  const r = await login(email, TEST_PASSWORD, ip);
  expect(r.status, `login ${email}`).toBe(200);
  return r.cookie;
}

async function enrolMfa(cookie: string): Promise<{ secret: string; recoveryCodes: string[] }> {
  const start = await call("POST", "/api/auth/mfa/enroll", { cookie });
  expect(start.status).toBe(200);
  const secret = start.body.data.secret as string;
  const confirm = await call("POST", "/api/auth/mfa/enroll/confirm", { cookie, body: { code: codeAt(secret, new Date()) } });
  expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
  return { secret, recoveryCodes: confirm.body.data.recoveryCodes as string[] };
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  A = await createTenant("SecA");
  B = await createTenant("SecB");
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.MFA_ENFORCEMENT;
  process.env.MFA_ENFORCEMENT = "warn";
});

afterAll(async () => {
  await db.delete(authThrottle);
  await cleanupTenants();
  await app.close();
});

describe("session revocation on sensitive changes", () => {
  it("a password change ends every other session, rotates this one, and a failed change changes nothing", async () => {
    const m = await createMember(A.orgId, "MANAGER", "pwchange");
    const s1 = await loginOk(m.email);
    const s2 = await loginOk(m.email);
    expect((await call("GET", "/api/auth/me", { cookie: s1 })).status).toBe(200);
    expect((await call("GET", "/api/auth/me", { cookie: s2 })).status).toBe(200);

    // A wrong current password changes nothing: both sessions still work, the password is the old one.
    const bad = await call("POST", "/api/auth/change-password", { cookie: s1, body: { currentPassword: "nope-nope-nope", newPassword: "a-much-better-passphrase-1" } });
    expect(bad.status).toBe(400);
    expect((await call("GET", "/api/auth/me", { cookie: s2 })).status).toBe(200);
    expect((await login(m.email)).status).toBe(200);

    const ok = await call("POST", "/api/auth/change-password", { cookie: s1, body: { currentPassword: TEST_PASSWORD, newPassword: "a-much-better-passphrase-1" } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.cookie).toMatch(/va_session=/);
    expect(ok.cookie).not.toBe(s1);

    expect((await call("GET", "/api/auth/me", { cookie: s2 })).status).toBe(401); // other session: revoked
    expect((await call("GET", "/api/auth/me", { cookie: s1 })).status).toBe(401); // old cookie: rotated away
    expect((await call("GET", "/api/auth/me", { cookie: ok.cookie })).status).toBe(200); // the new one works
    expect((await login(m.email, TEST_PASSWORD)).status).toBe(401); // old password no longer works
    expect((await login(m.email, "a-much-better-passphrase-1")).status).toBe(200);
  });

  it("a role downgrade ends that user's sessions in the organization; the next sign-in has the new role only", async () => {
    const admin = await createMember(A.orgId, "ADMIN", "downgraded");
    const owner = await loginOk(A.email);
    const adminCookie = await loginOk(admin.email);
    expect((await call("GET", "/api/users", { cookie: adminCookie })).status).toBe(200);

    const res = await call("PATCH", `/api/users/${admin.userId}/role`, { cookie: owner, body: { role: "AGENT" } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect((await call("GET", "/api/users", { cookie: adminCookie })).status).toBe(401); // session gone, not just narrowed
    const fresh = await loginOk(admin.email);
    expect((await call("GET", "/api/users", { cookie: fresh })).status).toBe(403); // AGENT may not list the team
    const events = await db.select().from(securityEvents).where(and(eq(securityEvents.actorUserId, admin.userId), eq(securityEvents.eventType, "membership.role_changed")));
    expect(events).toHaveLength(1);
  });

  it("removing a multi-organization user from one organization ends that session only; their other organization's session survives", async () => {
    const m = await createMember(A.orgId, "AGENT", "multi");
    await db.insert(memberships).values({ organizationId: B.orgId, userId: m.userId, role: "AGENT" });
    const inA = await loginOk(m.email); // oldest membership (A) is active
    const inB = await loginOk(m.email);
    const sw = await call("POST", "/api/auth/switch-organization", { cookie: inB, body: { organizationId: B.orgId } });
    expect(sw.status).toBe(200);

    const owner = await loginOk(A.email);
    expect((await call("DELETE", `/api/users/${m.userId}`, { cookie: owner })).status).toBe(200);

    expect((await call("GET", "/api/auth/me", { cookie: inA })).status).toBe(401);
    const stillB = await call("GET", "/api/auth/me", { cookie: inB });
    expect(stillB.status).toBe(200);
    expect(stillB.body.data.organization.id).toBe(B.orgId);
    expect(stillB.body.data.organizations.map((o: { id: string }) => o.id)).toEqual([B.orgId]);
  });

  it("deactivating an account ends all its sessions and refuses new sign-ins", async () => {
    const m = await createMember(A.orgId, "AGENT", "deactivate");
    const c1 = await loginOk(m.email);
    const c2 = await loginOk(m.email);
    const out = await accountService.deactivate({ userId: m.userId, operator: "test", reason: "unit test" });
    expect(out.sessionsRevoked).toBe(2);
    expect((await call("GET", "/api/auth/me", { cookie: c1 })).status).toBe(401);
    expect((await call("GET", "/api/auth/me", { cookie: c2 })).status).toBe(401);
    expect((await login(m.email)).status).toBe(401);
    expect(await db.select().from(sessions).where(eq(sessions.userId, m.userId))).toHaveLength(0);
  });

  it("concurrent requests cannot outlive a revocation: everything started after it commits is refused", async () => {
    const m = await createMember(A.orgId, "AGENT", "race");
    const cookie = await loginOk(m.email);
    const owner = await loginOk(A.email);
    const before = await Promise.all(Array.from({ length: 10 }, () => call("GET", "/api/auth/me", { cookie })));
    expect(before.every((r) => r.status === 200)).toBe(true);

    const revoke = call("DELETE", `/api/users/${m.userId}`, { cookie: owner });
    const racing = Array.from({ length: 20 }, () => call("GET", "/api/auth/me", { cookie }));
    expect((await revoke).status).toBe(200);
    await Promise.all(racing); // those in flight may or may not have been served; none may crash
    const after = await Promise.all(Array.from({ length: 20 }, () => call("GET", "/api/auth/me", { cookie })));
    expect(after.every((r) => r.status === 401)).toBe(true);
  });
});

describe("session management API", () => {
  it("lists only the caller's live sessions, safe fields only, current flagged, IP masked", async () => {
    const m = await createMember(A.orgId, "MANAGER", "sessions");
    const c1 = await loginOk(m.email, "203.0.113.45");
    await loginOk(m.email, "198.51.100.7");
    const res = await call("GET", "/api/auth/sessions", { cookie: c1 });
    expect(res.status).toBe(200);
    const list = res.body.data as Array<Record<string, unknown>>;
    expect(list).toHaveLength(2);
    for (const s of list) {
      expect(Object.keys(s).sort()).toEqual(["createdAt", "current", "device", "expiresAt", "id", "ip", "lastSeenAt", "mfaVerified"]);
      expect(String(s.ip)).toMatch(/\.x$/);
    }
    expect(list.filter((s) => s.current)).toHaveLength(1);
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(c1.split("=")[1]); // never the token
    const hashes = (await db.select().from(sessions).where(eq(sessions.userId, m.userId))).map((s) => s.tokenHash);
    for (const h of hashes) expect(raw).not.toContain(h); // never the stored hash
  });

  it("revokes one specific session; another user's session id is indistinguishable from a missing one", async () => {
    const m = await createMember(A.orgId, "MANAGER", "revokeone");
    const other = await createMember(A.orgId, "MANAGER", "victim");
    const c1 = await loginOk(m.email);
    const c2 = await loginOk(m.email);
    const victim = await loginOk(other.email);
    const list = (await call("GET", "/api/auth/sessions", { cookie: c1 })).body.data as Array<{ id: string; current: boolean }>;
    const target = list.find((s) => !s.current)!;

    const res = await call("DELETE", `/api/auth/sessions/${target.id}`, { cookie: c1 });
    expect(res.status).toBe(200);
    expect((await call("GET", "/api/auth/me", { cookie: c2 })).status).toBe(401);
    expect((await call("GET", "/api/auth/me", { cookie: c1 })).status).toBe(200);
    // Already revoked: not found.
    expect((await call("DELETE", `/api/auth/sessions/${target.id}`, { cookie: c1 })).status).toBe(404);

    // Someone else's session: same 404, and it keeps working.
    const victimSession = (await db.select().from(sessions).where(eq(sessions.userId, other.userId)))[0];
    expect((await call("DELETE", `/api/auth/sessions/${victimSession.id}`, { cookie: c1 })).status).toBe(404);
    expect((await call("GET", "/api/auth/me", { cookie: victim })).status).toBe(200);

    expect((await call("DELETE", "/api/auth/sessions/not-a-uuid", { cookie: c1 })).status).toBe(400);
  });

  it("revoke-others keeps the current session and ends the rest", async () => {
    const m = await createMember(A.orgId, "MANAGER", "revokeothers");
    const keep = await loginOk(m.email);
    const o1 = await loginOk(m.email);
    const o2 = await loginOk(m.email);
    const res = await call("POST", "/api/auth/sessions/revoke-others", { cookie: keep });
    expect(res.body.data.revoked).toBe(2);
    expect((await call("GET", "/api/auth/me", { cookie: keep })).status).toBe(200);
    expect((await call("GET", "/api/auth/me", { cookie: o1 })).status).toBe(401);
    expect((await call("GET", "/api/auth/me", { cookie: o2 })).status).toBe(401);
  });

  it("requires a login", async () => {
    expect((await call("GET", "/api/auth/sessions")).status).toBe(401);
    expect((await call("POST", "/api/auth/sessions/revoke-others")).status).toBe(401);
  });
});

describe("MFA (TOTP)", () => {
  it("sensitive steps need a recent password proof, and re-authentication restores it", async () => {
    const m = await createMember(A.orgId, "MANAGER", "reauth");
    const cookie = await loginOk(m.email);
    await db.update(sessions).set({ lastAuthAt: new Date(Date.now() - 60 * 60_000) }).where(eq(sessions.userId, m.userId));
    const stale = await call("POST", "/api/auth/mfa/enroll", { cookie });
    expect(stale.status).toBe(403);
    expect(stale.body.code).toBe("REAUTH_REQUIRED");

    const wrong = await call("POST", "/api/auth/reauthenticate", { cookie, body: { password: "definitely-wrong" } });
    expect(wrong.status).toBe(400);
    expect((await call("POST", "/api/auth/mfa/enroll", { cookie })).status).toBe(403);

    expect((await call("POST", "/api/auth/reauthenticate", { cookie, body: { password: TEST_PASSWORD } })).status).toBe(200);
    expect((await call("POST", "/api/auth/mfa/enroll", { cookie })).status).toBe(200);
  });

  it("enrols, then requires the second factor at login; the seed is sealed and recovery codes are hashed", async () => {
    const m = await createMember(A.orgId, "MANAGER", "mfa-flow");
    const cookie = await loginOk(m.email);
    const other = await loginOk(m.email);
    const start = await call("POST", "/api/auth/mfa/enroll", { cookie });
    expect(start.status).toBe(200);
    expect(start.body.data.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(start.body.data.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    const secret = start.body.data.secret as string;

    const [pending] = await db.select().from(users).where(eq(users.id, m.userId));
    expect(pending.mfaEnabledAt).toBeNull(); // not enabled until a code proves the device
    expect(pending.mfaSecretEnc).toBeTruthy();
    expect(pending.mfaSecretEnc).not.toContain(secret); // sealed, never plaintext

    const bad = await call("POST", "/api/auth/mfa/enroll/confirm", { cookie, body: { code: "000000" } });
    expect(bad.status).toBe(400);
    const ok = await call("POST", "/api/auth/mfa/enroll/confirm", { cookie, body: { code: codeAt(secret, new Date()) } });
    expect(ok.status).toBe(200);
    const recovery = ok.body.data.recoveryCodes as string[];
    expect(recovery).toHaveLength(10);
    expect(new Set(recovery).size).toBe(10);
    for (const c of recovery) expect(c).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);

    const stored = await db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, m.userId));
    expect(stored).toHaveLength(10);
    for (const row of stored) for (const c of recovery) expect(row.codeHash).not.toContain(c.replace("-", ""));

    // The account's other sessions ended when MFA was enabled.
    expect((await call("GET", "/api/auth/me", { cookie: other })).status).toBe(401);
    expect((await call("GET", "/api/auth/me", { cookie })).status).toBe(200);

    // An enrolled account cannot be re-enrolled over (a stolen session cannot swap the device).
    expect((await call("POST", "/api/auth/mfa/enroll", { cookie })).status).toBe(409);

    // Status never contains the seed.
    const status = await call("GET", "/api/auth/mfa", { cookie });
    expect(JSON.stringify(status.body)).not.toContain(secret);
    expect(status.body.data.enabled).toBe(true);
    expect(status.body.data.recoveryCodesRemaining).toBe(10);
  });

  it("a half-finished login can only complete the second factor; a wrong code never opens it; the right one does", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const m = await createMember(A.orgId, "MANAGER", "mfa-login");
    const cookie = await loginOk(m.email);
    const { secret } = await enrolMfa(cookie);

    vi.setSystemTime(t0 + 5 * 60_000);
    const l = await login(m.email);
    expect(l.status).toBe(200);
    expect(l.body.data.mfaRequired).toBe(true);
    const pending = l.cookie;

    const blocked = await call("GET", "/api/leads", { cookie: pending });
    expect(blocked.status).toBe(401);
    expect(blocked.body.code).toBe("MFA_REQUIRED");
    expect((await call("GET", "/api/projects", { cookie: pending })).status).toBe(401);
    expect((await call("GET", "/api/auth/me", { cookie: pending })).body.data.security.mfaPending).toBe(true);
    expect((await call("POST", "/api/auth/mfa/verify", { cookie: pending, body: { code: "123456" } })).status).toBe(400);
    expect((await call("GET", "/api/leads", { cookie: pending })).status).toBe(401);

    const right = await call("POST", "/api/auth/mfa/verify", { cookie: pending, body: { code: codeAt(secret, new Date()) } });
    expect(right.status, JSON.stringify(right.body)).toBe(200);
    expect((await call("GET", "/api/leads", { cookie: pending })).status).toBe(200);
  });

  it("a TOTP code is accepted once: replaying it, even inside its validity window, fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const m = await createMember(A.orgId, "MANAGER", "mfa-replay");
    const cookie = await loginOk(m.email);
    const { secret } = await enrolMfa(cookie);

    vi.setSystemTime(t0 + 3 * 60_000);
    const first = (await login(m.email)).cookie;
    const code = codeAt(secret, new Date());
    expect((await call("POST", "/api/auth/mfa/verify", { cookie: first, body: { code } })).status).toBe(200);

    const second = (await login(m.email)).cookie;
    const replay = await call("POST", "/api/auth/mfa/verify", { cookie: second, body: { code } });
    expect(replay.status).toBe(400);
    expect((await call("GET", "/api/leads", { cookie: second })).status).toBe(401);
    const events = await db.select().from(securityEvents).where(and(eq(securityEvents.actorUserId, m.userId), eq(securityEvents.eventType, "auth.mfa.replay_rejected")));
    expect(events.length).toBeGreaterThanOrEqual(1);

    // The next step's code is fine.
    vi.setSystemTime(t0 + 3 * 60_000 + 30_000);
    expect((await call("POST", "/api/auth/mfa/verify", { cookie: second, body: { code: codeAt(secret, new Date()) } })).status).toBe(200);
  });

  it("a recovery code works exactly once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const m = await createMember(A.orgId, "MANAGER", "mfa-recovery");
    const cookie = await loginOk(m.email);
    const { recoveryCodes } = await enrolMfa(cookie);

    vi.setSystemTime(t0 + 2 * 60_000);
    const c1 = (await login(m.email)).cookie;
    const use = await call("POST", "/api/auth/mfa/verify", { cookie: c1, body: { recoveryCode: recoveryCodes[0] } });
    expect(use.status).toBe(200);
    expect(use.body.data.method).toBe("recovery");
    expect((await call("GET", "/api/leads", { cookie: c1 })).status).toBe(200);

    const c2 = (await login(m.email)).cookie;
    expect((await call("POST", "/api/auth/mfa/verify", { cookie: c2, body: { recoveryCode: recoveryCodes[0] } })).status).toBe(400);
    expect((await call("POST", "/api/auth/mfa/verify", { cookie: c2, body: { recoveryCode: recoveryCodes[1].toLowerCase() } })).status).toBe(200);
    const status = await call("GET", "/api/auth/mfa", { cookie: c2 });
    expect(status.body.data.recoveryCodesRemaining).toBe(8);
  });

  it("guessing codes is throttled (bounded, then recoverable)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const m = await createMember(A.orgId, "MANAGER", "mfa-brute");
    const cookie = await loginOk(m.email);
    const { secret } = await enrolMfa(cookie);
    vi.setSystemTime(t0 + 4 * 60_000);
    const pending = (await login(m.email)).cookie;
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await call("POST", "/api/auth/mfa/verify", { cookie: pending, body: { code: String(100000 + i) } })).status);
    expect(statuses.slice(0, 5)).toEqual([400, 400, 400, 400, 400]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
    // Even the right code is refused while locked ...
    const locked = await call("POST", "/api/auth/mfa/verify", { cookie: pending, body: { code: codeAt(secret, new Date()) } });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers["retry-after"])).toBeGreaterThan(0);
    // ... but the lock is short and bounded, so the owner is never shut out for good.
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const fresh = (await login(m.email)).cookie;
    const recovered = await call("POST", "/api/auth/mfa/verify", { cookie: fresh, body: { code: codeAt(secret, new Date()) } });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
  });

  it("disabling needs the password AND a valid second factor, ends other sessions, and removes the secrets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const m = await createMember(A.orgId, "MANAGER", "mfa-disable");
    const cookie = await loginOk(m.email);
    const { secret } = await enrolMfa(cookie);

    vi.setSystemTime(t0 + 6 * 60_000);
    const device1 = (await login(m.email)).cookie;
    await call("POST", "/api/auth/mfa/verify", { cookie: device1, body: { code: codeAt(secret, new Date()) } });
    vi.setSystemTime(t0 + 6 * 60_000 + 30_000);
    const device2 = (await login(m.email)).cookie;
    await call("POST", "/api/auth/mfa/verify", { cookie: device2, body: { code: codeAt(secret, new Date()) } });

    // A thief holding a verified session still cannot remove the factor without the password and a code.
    vi.setSystemTime(t0 + 7 * 60_000);
    const code = codeAt(secret, new Date());
    expect((await call("POST", "/api/auth/mfa/disable", { cookie: device1, body: { password: "wrong-password-xx", code } })).status).toBe(400);
    expect((await call("POST", "/api/auth/mfa/disable", { cookie: device1, body: { password: TEST_PASSWORD, code: "000000" } })).status).toBe(400);
    expect((await call("GET", "/api/auth/mfa", { cookie: device1 })).body.data.enabled).toBe(true);

    const ok = await call("POST", "/api/auth/mfa/disable", { cookie: device1, body: { password: TEST_PASSWORD, code } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await call("GET", "/api/auth/me", { cookie: device2 })).status).toBe(401); // other session ended
    const [row] = await db.select().from(users).where(eq(users.id, m.userId));
    expect([row.mfaSecretEnc, row.mfaEnabledAt, row.mfaLastStep]).toEqual([null, null, null]);
    expect(await db.select().from(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, m.userId))).toHaveLength(0);
    const again = await login(m.email);
    expect(again.body.data.mfaRequired).toBe(false);
  });

  it("regenerating recovery codes needs a valid code and invalidates the old set", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const m = await createMember(A.orgId, "MANAGER", "mfa-regen");
    const cookie = await loginOk(m.email);
    const { secret, recoveryCodes } = await enrolMfa(cookie);
    vi.setSystemTime(t0 + 2 * 60_000);
    const c = (await login(m.email)).cookie;
    await call("POST", "/api/auth/mfa/verify", { cookie: c, body: { recoveryCode: recoveryCodes[0] } });
    await call("POST", "/api/auth/reauthenticate", { cookie: c, body: { password: TEST_PASSWORD } });

    expect((await call("POST", "/api/auth/mfa/recovery-codes", { cookie: c, body: { code: "000000" } })).status).toBe(400);
    vi.setSystemTime(t0 + 3 * 60_000);
    const regen = await call("POST", "/api/auth/mfa/recovery-codes", { cookie: c, body: { code: codeAt(secret, new Date()) } });
    expect(regen.status, JSON.stringify(regen.body)).toBe(200);
    const fresh = regen.body.data.recoveryCodes as string[];
    expect(fresh).toHaveLength(10);

    vi.setSystemTime(t0 + 4 * 60_000);
    const c2 = (await login(m.email)).cookie;
    expect((await call("POST", "/api/auth/mfa/verify", { cookie: c2, body: { recoveryCode: recoveryCodes[1] } })).status).toBe(400); // old set dead
    expect((await call("POST", "/api/auth/mfa/verify", { cookie: c2, body: { recoveryCode: fresh[0] } })).status).toBe(200);
  });

  it("enforcement: an owner/admin without MFA can reach only enrolment, others are unaffected, enrolling lifts it", async () => {
    process.env.MFA_ENFORCEMENT = "enforce";
    const adminU = await createMember(A.orgId, "ADMIN", "enforced-admin");
    const agentU = await createMember(A.orgId, "AGENT", "enforced-agent");
    const adminCookie = await loginOk(adminU.email);
    const agentCookie = await loginOk(agentU.email);

    const blocked = await call("GET", "/api/leads", { cookie: adminCookie });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("MFA_ENROLLMENT_REQUIRED");
    const me = await call("GET", "/api/auth/me", { cookie: adminCookie });
    expect(me.status).toBe(200);
    expect(me.body.data.security.mfaEnrollmentRequired).toBe(true);
    expect((await call("GET", "/api/leads", { cookie: agentCookie })).status).toBe(200);

    const { secret } = await enrolMfa(adminCookie); // enrolment itself is reachable
    expect(secret).toBeTruthy();
    expect((await call("GET", "/api/leads", { cookie: adminCookie })).status).toBe(200);
  });

  it("in warn mode (the default rollout stage) nobody is blocked but the state is reported", async () => {
    process.env.MFA_ENFORCEMENT = "warn";
    const adminU = await createMember(A.orgId, "ADMIN", "warned-admin");
    const cookie = await loginOk(adminU.email);
    expect((await call("GET", "/api/leads", { cookie })).status).toBe(200);
    const me = await call("GET", "/api/auth/me", { cookie });
    expect(me.body.data.security).toMatchObject({ mfaEnabled: false, mfaEnrollmentRequired: false, mfaEnforcement: "warn" });
  });

  it("an operator reset removes the factor and every session; no bypass is left behind", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t0 = Date.now();
    const m = await createMember(A.orgId, "MANAGER", "mfa-reset");
    const cookie = await loginOk(m.email);
    await enrolMfa(cookie);
    vi.setSystemTime(t0 + 2 * 60_000);
    await accountService.resetMfa({ userId: m.userId, operator: "ops-test", reason: "lost device" });
    expect((await call("GET", "/api/auth/me", { cookie })).status).toBe(401);
    const [row] = await db.select().from(users).where(eq(users.id, m.userId));
    expect([row.mfaSecretEnc, row.mfaEnabledAt]).toEqual([null, null]);
    const ev = await db.select().from(securityEvents).where(and(eq(securityEvents.actorUserId, m.userId), eq(securityEvents.eventType, "auth.mfa.reset_by_operator")));
    expect(ev).toHaveLength(1);
    expect((ev[0].metadata as { operator: string }).operator).toBe("ops-test");
    expect((await login(m.email)).body.data.mfaRequired).toBe(false);
  });
});

describe("login throttling", () => {
  it("locks one (account, IP) pair after repeated failures with Retry-After, never locking the account for other addresses", async () => {
    const m = await createMember(A.orgId, "AGENT", "throttle-pair");
    const attacker = "192.0.2.50";
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await login(m.email, "wrong-password-1", attacker)).status);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429]);
    const throttled = await login(m.email, TEST_PASSWORD, attacker); // even the right password: refused while locked
    expect(throttled.status).toBe(429);
    expect(throttled.body.code).toBe("THROTTLED");
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(throttled.headers["retry-after"])).toBeLessThanOrEqual(15 * 60);
    // The real owner, from another address, is not affected.
    expect((await login(m.email, TEST_PASSWORD, "192.0.2.51")).status).toBe(200);
  });

  it("answers an unknown account exactly like a wrong password (no enumeration), including the throttle", async () => {
    const m = await createMember(A.orgId, "AGENT", "enum-known");
    const ip1 = nextIp();
    const ip2 = nextIp();
    const known = await login(m.email, "wrong-password-1", ip1);
    const unknown = await login("nobody-here@example.test", "wrong-password-1", ip2);
    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
    for (let i = 0; i < 5; i++) await login("nobody-here@example.test", "wrong-password-1", ip2);
    const k2 = [];
    for (let i = 0; i < 5; i++) k2.push((await login(m.email, "wrong-password-1", ip1)).status);
    expect((await login("nobody-here@example.test", "wrong-password-1", ip2)).status).toBe(429);
    expect(k2.at(-1)).toBe(429);
  });

  it("a rejected attempt during a lock does not extend it, and a success clears the pair counter", async () => {
    const m = await createMember(A.orgId, "AGENT", "throttle-extend");
    const ip = nextIp();
    for (let i = 0; i < 5; i++) await login(m.email, "wrong-password-1", ip);
    const rows1 = await db.select().from(authThrottle).where(inArray(authThrottle.failures, [5]));
    const locked = rows1.filter((r) => r.lockedUntil);
    expect(locked.length).toBeGreaterThan(0);
    const before = new Map(locked.map((r) => [r.key, r.lockedUntil!.getTime()]));
    for (let i = 0; i < 3; i++) expect((await login(m.email, "wrong-password-1", ip)).status).toBe(429);
    const after = await db.select().from(authThrottle);
    for (const r of after) if (before.has(r.key)) expect(r.lockedUntil!.getTime()).toBe(before.get(r.key));

    // Success from another address clears nothing of this pair; success on a fresh pair is clean.
    const ip2 = nextIp();
    for (let i = 0; i < 3; i++) await login(m.email, "wrong-password-1", ip2);
    expect((await login(m.email, TEST_PASSWORD, ip2)).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await login(m.email, "wrong-password-1", ip2)).status).toBe(401); // counter restarted
  });

  it("a distributed attack on one account adds only a SHORT bounded delay for the owner", async () => {
    process.env.LOGIN_ACCOUNT_THRESHOLD = "10";
    try {
      const m = await createMember(A.orgId, "AGENT", "throttle-distributed");
      for (let i = 0; i < 14; i++) await login(m.email, "wrong-password-1", nextIp()); // many addresses, one account
      const owner = await login(m.email, TEST_PASSWORD, nextIp());
      expect(owner.status).toBe(429);
      expect(Number(owner.headers["retry-after"])).toBeLessThanOrEqual(30);
    } finally {
      process.env.LOGIN_ACCOUNT_THRESHOLD = "100000";
    }
  });

  it("spraying many accounts from one address is limited per IP", async () => {
    process.env.LOGIN_IP_THRESHOLD = "6";
    try {
      const ip = nextIp();
      const out: number[] = [];
      for (let i = 0; i < 9; i++) out.push((await login(`spray-${i}@example.test`, "wrong-password-1", ip)).status);
      expect(out.slice(0, 6).every((s) => s === 401)).toBe(true);
      expect(out.slice(6).every((s) => s === 429)).toBe(true);
    } finally {
      process.env.LOGIN_IP_THRESHOLD = "100000";
    }
  });
});

describe("password policy", () => {
  it("rejects common, short and identity-derived passwords; accepts a good one; a rejected change changes nothing", async () => {
    const m = await createMember(A.orgId, "AGENT", "policy");
    const cookie = await loginOk(m.email);
    const [row] = await db.select().from(users).where(eq(users.id, m.userId));
    const change = (newPassword: string) => call("POST", "/api/auth/change-password", { cookie, body: { currentPassword: TEST_PASSWORD, newPassword } });

    expect((await change("short")).status).toBe(400);
    expect((await change("password123")).status).toBe(400);
    expect((await change("Password@123")).status).toBe(400);
    expect((await change("aaaaaaaaaaaaaaaa")).status).toBe(400);
    expect((await change(`${m.email.split("@")[0]}-extra-1`)).status).toBe(400);
    expect((await change(TEST_PASSWORD)).status).toBe(400); // unchanged
    const [after] = await db.select().from(users).where(eq(users.id, m.userId));
    expect(after.passwordHash).toBe(row.passwordHash);
    expect((await call("GET", "/api/auth/me", { cookie })).status).toBe(200); // session untouched

    expect((await change("pelican-lantern-orbit-91")).status).toBe(200);
  });

  it("applies to invitation sign-up as well", async () => {
    const owner = await loginOk(A.email);
    const email = `invitee-${Date.now()}@example.test`;
    const inv = await call("POST", "/api/users/invitations", { cookie: owner, body: { email, role: "AGENT" } });
    expect(inv.status, JSON.stringify(inv.body)).toBeLessThan(300);
    const token = inv.body.data.inviteToken ?? inv.body.data.token ?? new URL(inv.body.data.inviteUrl ?? "http://x/?token=").searchParams.get("token");
    if (token) {
      const weak = await call("POST", "/api/auth/accept-invite", { body: { token, name: "New Person", password: "password123" } });
      expect(weak.status).toBe(400);
    }
  });

  it("changing the password stamps passwordChangedAt and no session older than it can resume", async () => {
    const m = await createMember(A.orgId, "AGENT", "pwstamp");
    const cookie = await loginOk(m.email);
    await usersRepository.setPasswordHash({ id: m.userId, passwordHash: await hashPassword("another-fine-passphrase-7") });
    await db.update(users).set({ passwordChangedAt: new Date(Date.now() + 1000) }).where(eq(users.id, m.userId));
    expect((await call("GET", "/api/auth/me", { cookie })).status).toBe(401);
  });
});

describe("security audit trail", () => {
  it("records failed and successful logins with identifiers only - never the password or token", async () => {
    const m = await createMember(A.orgId, "AGENT", "audit-login");
    const secretTry = "super-secret-attempt-9";
    await login(m.email, secretTry);
    const ok = await login(m.email);
    const rows = await db.select().from(securityEvents).where(eq(securityEvents.actorUserId, m.userId));
    const types = rows.map((r) => r.eventType);
    expect(types).toContain("auth.login.failed");
    expect(types).toContain("auth.login.success");
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain(secretTry);
    expect(blob).not.toContain(TEST_PASSWORD);
    expect(blob).not.toContain(ok.cookie.split("=")[1]);
    for (const r of rows) {
      expect(r.requestId === null || typeof r.requestId === "string").toBe(true);
      expect(r.createdAt).toBeInstanceOf(Date);
    }
  });

  it("MFA events never contain the seed, a code or a recovery code", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const m = await createMember(A.orgId, "MANAGER", "audit-mfa");
    const cookie = await loginOk(m.email);
    const { secret, recoveryCodes } = await enrolMfa(cookie);
    await call("POST", "/api/auth/mfa/verify", { cookie, body: { code: "999999" } });
    const rows = await db.select().from(securityEvents).where(eq(securityEvents.actorUserId, m.userId));
    const blob = JSON.stringify(rows);
    expect(rows.map((r) => r.eventType)).toEqual(expect.arrayContaining(["auth.mfa.enrollment_started", "auth.mfa.enrolled"]));
    expect(blob).not.toContain(secret);
    for (const c of recoveryCodes) expect(blob).not.toContain(c);
    expect(blob).not.toContain("999999");
  });

  it("an organization's owner reads only that organization's events; an agent cannot read them", async () => {
    const ownerA = await loginOk(A.email);
    const ownerB = await loginOk(B.email);
    const eA = await call("GET", "/api/security/events?limit=200", { cookie: ownerA });
    const eB = await call("GET", "/api/security/events?limit=200", { cookie: ownerB });
    expect(eA.status).toBe(200);
    expect(eB.status).toBe(200);
    const idsA = new Set((eA.body.data as Array<{ id: string }>).map((e) => e.id));
    for (const e of eB.body.data as Array<{ id: string }>) expect(idsA.has(e.id)).toBe(false);
    const agent = await createMember(A.orgId, "AGENT", "audit-agent");
    expect((await call("GET", "/api/security/events", { cookie: await loginOk(agent.email) })).status).toBe(403);
  });

  it("the runtime role cannot alter or delete security events (append-only)", async () => {
    const { sql } = await import("../../db/client.js");
    await expect(sql`update security_events set outcome = 'x'`).rejects.toThrow(/permission denied/);
    await expect(sql`delete from security_events`).rejects.toThrow(/permission denied/);
  });
});

describe("CORS preflight for the dashboard", () => {
  it("allows the methods the dashboard uses (DELETE/PATCH/PUT) from the dashboard origin only", async () => {
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/api/auth/sessions/00000000-0000-0000-0000-000000000000",
      headers: { origin: "http://127.0.0.1:3000", "access-control-request-method": "DELETE" },
    });
    expect(String(allowed.headers["access-control-allow-methods"])).toMatch(/DELETE/);
    expect(String(allowed.headers["access-control-allow-methods"])).toMatch(/PATCH/);
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3000");
    const foreign = await app.inject({
      method: "OPTIONS",
      url: "/api/auth/sessions/00000000-0000-0000-0000-000000000000",
      headers: { origin: "https://evil.example", "access-control-request-method": "DELETE" },
    });
    expect(foreign.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
