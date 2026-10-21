/**
 * Customer-facing password reset ("forgot password") and e-mail verification, end to end through the real HTTP app
 * and the real PostgreSQL (restricted runtime role, row-level security on).
 *
 * The properties under test, in the order that matters:
 *   1. ENUMERATION SAFETY   /forgot-password answers identically for an address that exists, one that does not and
 *                           a deactivated account - status, body, and the database work behind it.
 *   2. UNIFORM TOKEN ERRORS unknown, expired, already-spent and superseded reset tokens are indistinguishable.
 *   3. SESSION REVOCATION   a completed reset ends EVERY session, including the one that asked for it.
 *   4. SINGLE USE           a token cannot be replayed, in either flow.
 *   5. THROTTLING           per-address and per-IP limits engage and fail closed.
 *   6. MFA                  a reset never grants a usable session to an account with a second factor.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { buildApp } from "../../app.js";
import { adminDb as db } from "../../db/client.js";
import { accountTokens, authThrottle, securityEvents, sessions, users } from "../../db/schema.js";
import { codeAt } from "../../auth/totp.js";
import { cleanupTenants, createMember, createTenant, TEST_PASSWORD, type TestTenant } from "../../test/tenants.js";
import { usersRepository } from "../../test/repos.js";
import { clearSentEmails, sentEmails, sentEmailsTo } from "../../adapters/email/index.js";
import { accountTokensRepository } from "./account-tokens.repository.js";
import { settleOutbox } from "./recovery-mail.js";
import { INVALID_RESET_TOKEN, INVALID_VERIFICATION_TOKEN, hashAccountToken } from "./account-recovery.js";

type App = Awaited<ReturnType<typeof buildApp>>;

const NEW_PASSWORD = "a-brand-new-passphrase-2026";

let app: App;
let A: TestTenant;

/** Every request gets its own address unless a test is specifically exercising a per-IP budget. */
let ipCounter = 0;
const nextIp = () => `10.61.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

interface Res {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  cookie: string;
}

async function call(method: "GET" | "POST", url: string, opts: { cookie?: string; body?: unknown; ip?: string } = {}): Promise<Res> {
  const res = await app.inject({
    method,
    url,
    remoteAddress: opts.ip ?? nextIp(),
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
  return { status: res.statusCode, body, cookie: set ? `va_session=${set.value}` : "" };
}

async function loginOk(email: string, password = TEST_PASSWORD): Promise<string> {
  const r = await call("POST", "/api/auth/login", { body: { email, password } });
  expect(r.status, `login ${email}: ${JSON.stringify(r.body)}`).toBe(200);
  return r.cookie;
}

const forgot = (email: string, ip?: string) => call("POST", "/api/auth/forgot-password", { body: { email }, ip });

/** The messages the mock provider recorded for an address, newest first. */
const mailTo = (to: string) => [...sentEmailsTo(to)].reverse().map((r) => r.message);
/** Every recipient the mock provider has seen. */
const recipients = () => sentEmails().map((r) => r.message.to.email);

/** Pulls the token out of the plain-text body - the one place a token is ever allowed to appear. */
function tokenFromLastMail(kind: "password-reset" | "email-verification", to: string): string {
  const mail = mailTo(to).find((m) => m.kind === kind);
  expect(mail, `no ${kind} mail recorded for ${to}`).toBeTruthy();
  const match = /[?&]token=([A-Za-z0-9_-]+)/.exec(mail!.text);
  expect(match, `no token link in the ${kind} body`).toBeTruthy();
  return decodeURIComponent(match![1]);
}

/** Request a reset for an existing account and return the token that was mailed. */
async function resetTokenFor(email: string): Promise<string> {
  clearSentEmails();
  expect((await forgot(email)).status).toBe(200);
  await settleOutbox();
  return tokenFromLastMail("password-reset", email);
}

async function verificationTokenFor(cookie: string, email: string): Promise<string> {
  clearSentEmails();
  const r = await call("POST", "/api/auth/email-verification/send", { cookie });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  await settleOutbox();
  return tokenFromLastMail("email-verification", email);
}

const eventsFor = (userId: string) =>
  db.select().from(securityEvents).where(eq(securityEvents.actorUserId, userId));

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  A = await createTenant("Recov");
});

afterEach(() => {
  vi.restoreAllMocks();
  clearSentEmails();
});

afterAll(async () => {
  await settleOutbox();
  await db.delete(authThrottle);
  await cleanupTenants();
  await app.close();
});

// ---------------------------------------------------------------------------------------------------------------
describe("POST /api/auth/forgot-password: enumeration safety", () => {
  it("answers identically for an address that exists, one that does not, and a deactivated account", async () => {
    const member = await createMember(A.orgId, "AGENT", "enum-exists");
    const disabled = await createMember(A.orgId, "AGENT", "enum-disabled");
    await usersRepository.setActive({ id: disabled.userId, isActive: false });

    const results = [
      await forgot(member.email),
      await forgot("absolutely-nobody-here@example.test"),
      await forgot(disabled.email),
    ];
    for (const r of results) {
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ data: { ok: true } });
      // No cookie, no hint of an account, nothing to compare against.
      expect(r.cookie).toBe("");
    }
    // The three bodies are byte-for-byte the same.
    expect(new Set(results.map((r) => JSON.stringify(r.body))).size).toBe(1);

    await settleOutbox();
    // Only the live account was actually mailed - but the CALLER cannot see that.
    const addressed = recipients();
    expect(addressed).toContain(member.email);
    expect(addressed).not.toContain(disabled.email);
    expect(addressed).not.toContain("absolutely-nobody-here@example.test");
  });

  it("does the same database work for an unknown address as for a real one (no timing shortcut)", async () => {
    const member = await createMember(A.orgId, "AGENT", "enum-timing");
    // The decoy lookup + counting query the unknown-address path runs instead of returning early.
    const lookup = vi.spyOn(accountTokensRepository, "findUsableByTokenHash");
    const counted = vi.spyOn(accountTokensRepository, "countOutstanding");
    const created = vi.spyOn(accountTokensRepository, "create");

    expect((await forgot("still-nobody@example.test")).status).toBe(200);
    expect(lookup, "the unknown-address path must issue a decoy token lookup").toHaveBeenCalledTimes(1);
    expect(counted, "...and a second bounded query, matching the real path's write").toHaveBeenCalledTimes(1);
    expect(created, "no token may be minted for an address with no account").not.toHaveBeenCalled();

    created.mockClear();
    expect((await forgot(member.email)).status).toBe(200);
    expect(created).toHaveBeenCalledTimes(1);
  });

  it("stays in the same latency class for both (loose bound: only a gross difference fails)", async () => {
    const member = await createMember(A.orgId, "AGENT", "enum-latency");
    const timeOne = async (email: string) => {
      const t = process.hrtime.bigint();
      await forgot(email);
      return Number(process.hrtime.bigint() - t) / 1e6;
    };
    const known: number[] = [];
    const unknown: number[] = [];
    // Interleaved so a warming effect hits both equally. Three samples each: the per-address budget is 3.
    for (let i = 0; i < 3; i++) {
      known.push(await timeOne(member.email));
      unknown.push(await timeOne(`ghost-${i}-${Date.now()}@example.test`));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    // Deliberately generous: this guards against someone deleting the burn and making the unknown path trivially
    // cheap, not against machine noise.
    expect(Math.abs(median(known) - median(unknown))).toBeLessThan(400);
  });

  it("records the attempt in the security trail without ever storing the address or a token", async () => {
    const member = await createMember(A.orgId, "AGENT", "enum-trail");
    const token = await resetTokenFor(member.email);
    const rows = await eventsFor(member.userId);
    const requested = rows.find((r) => r.eventType === "auth.password.reset_requested");
    expect(requested).toBeTruthy();
    expect(requested!.outcome).toBe("info");
    expect((requested!.metadata as { delivered?: boolean }).delivered).toBe(true);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(member.email);
  });

  it("rejects a malformed address with 400 and no stack trace", async () => {
    const r = await call("POST", "/api/auth/forgot-password", { body: { email: "not-an-address" } });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\(.*\.ts/);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("POST /api/auth/reset-password: the happy path", () => {
  it("mails a single-use link, sets the new password, and signs the customer in", async () => {
    const member = await createMember(A.orgId, "MANAGER", "reset-happy");
    const token = await resetTokenFor(member.email);

    // The mail is usable as plain text alone and names nothing secret outside the body.
    const mail = mailTo(member.email)[0];
    expect(mail.kind).toBe("password-reset");
    expect(mail.subject).not.toContain(token);
    expect(mail.idempotencyKey).not.toContain(token);
    expect(mail.text).toContain("/reset-password?token=");

    const done = await call("POST", "/api/auth/reset-password", { body: { token, password: NEW_PASSWORD } });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.email).toBe(member.email);
    expect(done.body.data.mfaRequired).toBe(false);
    expect(done.cookie).toMatch(/^va_session=/);
    expect(JSON.stringify(done.body)).not.toMatch(/password|hash/i);

    // The session it handed back works...
    const me = await call("GET", "/api/auth/me", { cookie: done.cookie });
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(member.email);
    // ...the new password works...
    await loginOk(member.email, NEW_PASSWORD);
    // ...and the old one does not.
    const old = await call("POST", "/api/auth/login", { body: { email: member.email, password: TEST_PASSWORD } });
    expect(old.status).toBe(401);
  });

  it("stores only a hash of the reset token, never the token itself", async () => {
    const member = await createMember(A.orgId, "AGENT", "reset-hash");
    const token = await resetTokenFor(member.email);
    const rows = await db.select().from(accountTokens).where(eq(accountTokens.userId, member.userId));
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashAccountToken(token));
    expect(rows[0].tokenHash).not.toBe(token);
    expect((await db.select().from(accountTokens)).some((r) => r.tokenHash === token)).toBe(false);
  });

  it("marks the address verified, because completing a reset proves control of the mailbox", async () => {
    const member = await createMember(A.orgId, "AGENT", "reset-verifies");
    const before = await usersRepository.findById({ id: member.userId });
    expect(before!.emailVerifiedAt).toBeNull();

    const token = await resetTokenFor(member.email);
    expect((await call("POST", "/api/auth/reset-password", { body: { token, password: NEW_PASSWORD } })).status).toBe(200);
    const after = await usersRepository.findById({ id: member.userId });
    expect(after!.emailVerifiedAt).toBeInstanceOf(Date);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("POST /api/auth/reset-password: every unusable token is refused identically", () => {
  it("gives the same 400 and the same message for unknown, expired, already-used and superseded tokens", async () => {
    // Two accounts, because a single address may only ask for a reset three times in the throttle window and this
    // case needs four links.
    const one = await createMember(A.orgId, "AGENT", "reset-uniform-a");
    const two = await createMember(A.orgId, "AGENT", "reset-uniform-b");

    // (a) unknown - a token that was never issued
    const unknown = await call("POST", "/api/auth/reset-password", {
      body: { token: "Zm9yZ2VkLXRva2VuLXRoYXQtd2FzLW5ldmVyLWlzc3VlZA", password: NEW_PASSWORD },
    });

    // (b) expired
    const expiredToken = await resetTokenFor(one.email);
    await accountTokensRepository.expireForTest({ tokenHash: hashAccountToken(expiredToken) });
    const expired = await call("POST", "/api/auth/reset-password", { body: { token: expiredToken, password: NEW_PASSWORD } });

    // (c) already used - spend one, then present it again
    const usedToken = await resetTokenFor(one.email);
    expect((await call("POST", "/api/auth/reset-password", { body: { token: usedToken, password: NEW_PASSWORD } })).status).toBe(200);
    const reused = await call("POST", "/api/auth/reset-password", { body: { token: usedToken, password: "another-fresh-passphrase-77" } });

    // (d) superseded - asking again invalidates the older link
    const first = await resetTokenFor(two.email);
    const second = await resetTokenFor(two.email);
    expect(second).not.toBe(first);
    const superseded = await call("POST", "/api/auth/reset-password", { body: { token: first, password: "yet-another-passphrase-88" } });

    for (const [label, r] of [["unknown", unknown], ["expired", expired], ["reused", reused], ["superseded", superseded]] as const) {
      expect(r.status, label).toBe(400);
      expect(r.body.error, label).toBe(INVALID_RESET_TOKEN);
      expect(r.cookie, label).toBe("");
    }
    // Indistinguishable: one response shape for all four.
    expect(new Set([unknown, expired, reused, superseded].map((r) => `${r.status}|${JSON.stringify(r.body)}`)).size).toBe(1);
  });

  it("refuses a token whose account was deactivated after it was issued, with the same message", async () => {
    const member = await createMember(A.orgId, "AGENT", "reset-disabled");
    const token = await resetTokenFor(member.email);
    await usersRepository.setActive({ id: member.userId, isActive: false });
    const r = await call("POST", "/api/auth/reset-password", { body: { token, password: NEW_PASSWORD } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(INVALID_RESET_TOKEN);
  });

  it("refuses a weak password WITHOUT burning the link, so one typo does not cost a new e-mail", async () => {
    const member = await createMember(A.orgId, "AGENT", "reset-weak");
    const token = await resetTokenFor(member.email);
    const weak = await call("POST", "/api/auth/reset-password", { body: { token, password: "password123" } });
    expect(weak.status).toBe(400);
    expect(weak.body.error).not.toBe(INVALID_RESET_TOKEN); // the policy's reason, not the token's
    expect(weak.body.error).toMatch(/too common|at least|password/i);

    // The same link still works with an acceptable password.
    const ok = await call("POST", "/api/auth/reset-password", { body: { token, password: NEW_PASSWORD } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it("is single-use under concurrency: two simultaneous uses of one token, exactly one succeeds", async () => {
    const member = await createMember(A.orgId, "AGENT", "reset-race");
    const token = await resetTokenFor(member.email);
    const [a, b] = await Promise.all([
      call("POST", "/api/auth/reset-password", { body: { token, password: NEW_PASSWORD } }),
      call("POST", "/api/auth/reset-password", { body: { token, password: "a-different-passphrase-99" } }),
    ]);
    const codes = [a.status, b.status].sort();
    expect(codes).toEqual([200, 400]);
    const loser = a.status === 400 ? a : b;
    expect(loser.body.error).toBe(INVALID_RESET_TOKEN);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("a completed reset revokes every session", () => {
  it("ends all existing sessions, including other devices, and leaves only the newly issued one", async () => {
    const member = await createMember(A.orgId, "MANAGER", "reset-sessions");
    const deviceOne = await loginOk(member.email);
    const deviceTwo = await loginOk(member.email);
    const deviceThree = await loginOk(member.email);
    expect((await db.select().from(sessions).where(eq(sessions.userId, member.userId))).length).toBe(3);

    const token = await resetTokenFor(member.email);
    const done = await call("POST", "/api/auth/reset-password", { body: { token, password: NEW_PASSWORD } });
    expect(done.status).toBe(200);
    expect(done.body.data.sessionsRevoked).toBe(3);

    // Every old cookie is dead, server-side.
    for (const [label, cookie] of [["one", deviceOne], ["two", deviceTwo], ["three", deviceThree]] as const) {
      expect((await call("GET", "/api/auth/me", { cookie })).status, label).toBe(401);
    }
    // Exactly one session remains: the one the reset handed back.
    const rows = await db.select().from(sessions).where(eq(sessions.userId, member.userId));
    expect(rows).toHaveLength(1);
    expect((await call("GET", "/api/auth/me", { cookie: done.cookie })).status).toBe(200);
  });

  it("stamps password_changed_at and records auth.password.reset_completed", async () => {
    const member = await createMember(A.orgId, "AGENT", "reset-trail");
    const token = await resetTokenFor(member.email);
    expect((await call("POST", "/api/auth/reset-password", { body: { token, password: NEW_PASSWORD } })).status).toBe(200);

    const user = await usersRepository.findById({ id: member.userId });
    expect(user!.passwordChangedAt).toBeInstanceOf(Date);
    const rows = await eventsFor(member.userId);
    const completed = rows.find((r) => r.eventType === "auth.password.reset_completed");
    expect(completed).toBeTruthy();
    expect(completed!.outcome).toBe("success");
    expect((completed!.metadata as { sessionsRevoked?: number }).sessionsRevoked).toBeGreaterThanOrEqual(0);
  });

  it("records auth.password.reset_failed for a refused token", async () => {
    const before = (await db.select().from(securityEvents).where(eq(securityEvents.eventType, "auth.password.reset_failed"))).length;
    expect(
      (await call("POST", "/api/auth/reset-password", { body: { token: "not-a-real-token-at-all", password: NEW_PASSWORD } })).status,
    ).toBe(400);
    const after = (await db.select().from(securityEvents).where(eq(securityEvents.eventType, "auth.password.reset_failed"))).length;
    expect(after).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("a reset never unlocks an account that has a second factor", () => {
  it("issues a PENDING session: the new password alone reaches nothing but the MFA step", async () => {
    const member = await createMember(A.orgId, "MANAGER", "reset-mfa");
    // Enrol MFA the way the product does.
    const cookie = await loginOk(member.email);
    const start = await call("POST", "/api/auth/mfa/enroll", { cookie });
    expect(start.status, JSON.stringify(start.body)).toBe(200);
    const secret = start.body.data.secret as string;
    const confirm = await call("POST", "/api/auth/mfa/enroll/confirm", { cookie, body: { code: codeAt(secret, new Date()) } });
    expect(confirm.status, JSON.stringify(confirm.body)).toBe(200);
    const recoveryCodes = confirm.body.data.recoveryCodes as string[];

    const token = await resetTokenFor(member.email);
    const done = await call("POST", "/api/auth/reset-password", { body: { token, password: NEW_PASSWORD } });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // The password WAS changed...
    expect(done.body.data.mfaRequired).toBe(true);
    // ...but the session is half-finished: the login gate lets it reach nothing else.
    expect((await call("GET", "/api/leads", { cookie: done.cookie })).status).toBe(401);
    const me = await call("GET", "/api/auth/me", { cookie: done.cookie });
    expect(me.status).toBe(200);
    expect(me.body.data.security.mfaPending).toBe(true);

    // Only the second factor completes it. A recovery code is used rather than a TOTP code because the code that
    // confirmed enrolment a moment ago is still the current time step, and a step is single-use (replay
    // protection) - which is also the realistic shape of this situation: someone recovering an account reaches for
    // a recovery code.
    const verify = await call("POST", "/api/auth/mfa/verify", { cookie: done.cookie, body: { recoveryCode: recoveryCodes[0] } });
    expect(verify.status, JSON.stringify(verify.body)).toBe(200);
    expect(verify.body.data.method).toBe("recovery");
    expect((await call("GET", "/api/auth/me", { cookie: done.cookie })).body.data.security.mfaPending).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("throttling", () => {
  it("limits reset requests per ADDRESS (3 per 15 minutes), whatever the source address", async () => {
    const member = await createMember(A.orgId, "AGENT", "throttle-addr");
    const codes: number[] = [];
    // Each from a different IP, so only the per-address budget can bite.
    for (let i = 0; i < 5; i++) codes.push((await forgot(member.email)).status);
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3)).toEqual([429, 429]);

    // A different address from the same source is unaffected: the budgets are independent.
    const other = await createMember(A.orgId, "AGENT", "throttle-addr-other");
    expect((await forgot(other.email)).status).toBe(200);
  });

  it("limits reset requests per SOURCE IP (10 per 15 minutes), whatever the address", async () => {
    const ip = "10.62.5.5";
    const codes: number[] = [];
    // Eleven distinct addresses: the per-address budget can never be the cause.
    for (let i = 0; i < 11; i++) codes.push((await forgot(`sweep-${i}-${Date.now()}@example.test`, ip)).status);
    expect(codes.slice(0, 10).every((c) => c === 200)).toBe(true);
    expect(codes[10]).toBe(429);
    expect((await forgot(`sweep-last-${Date.now()}@example.test`, "10.62.6.6")).status).toBe(200);
  });

  it("limits token guesses per SOURCE IP, so an attacker cannot rotate guesses past the limit", async () => {
    const ip = "10.62.7.7";
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push(
        (await call("POST", "/api/auth/reset-password", { body: { token: `guess-number-${i}`, password: NEW_PASSWORD }, ip })).status,
      );
    }
    // Every guess is a different token, so only the per-IP budget can produce the 429.
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true);
    expect(codes[10]).toBe(429);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("e-mail verification", () => {
  it("confirms an address from the mailed link, and refuses the same link a second time", async () => {
    const member = await createMember(A.orgId, "AGENT", "verify-happy");
    const cookie = await loginOk(member.email);

    const status = await call("GET", "/api/auth/email-verification", { cookie });
    expect(status.status).toBe(200);
    expect(status.body.data).toEqual({ email: member.email, verified: false, verifiedAt: null });

    const token = await verificationTokenFor(cookie, member.email);
    const mail = mailTo(member.email)[0];
    expect(mail.kind).toBe("email-verification");
    expect(mail.text).toContain("/verify-email?token=");

    const confirmed = await call("POST", "/api/auth/email-verification/confirm", { body: { token } });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    expect(confirmed.body.data).toMatchObject({ ok: true, email: member.email, alreadyVerified: false });

    const after = await call("GET", "/api/auth/email-verification", { cookie });
    expect(after.body.data.verified).toBe(true);
    expect(after.body.data.verifiedAt).toBeTruthy();

    // Replay: the token is spent, so it is refused exactly like an unknown one.
    const replay = await call("POST", "/api/auth/email-verification/confirm", { body: { token } });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe(INVALID_VERIFICATION_TOKEN);
  });

  it("refuses unknown, expired and superseded verification tokens identically", async () => {
    const member = await createMember(A.orgId, "AGENT", "verify-uniform");
    const cookie = await loginOk(member.email);

    const unknown = await call("POST", "/api/auth/email-verification/confirm", { body: { token: "never-issued-this-one" } });

    const expiredToken = await verificationTokenFor(cookie, member.email);
    await accountTokensRepository.expireForTest({ tokenHash: hashAccountToken(expiredToken) });
    const expired = await call("POST", "/api/auth/email-verification/confirm", { body: { token: expiredToken } });

    const older = await verificationTokenFor(cookie, member.email);
    const newer = await verificationTokenFor(cookie, member.email);
    expect(newer).not.toBe(older);
    const superseded = await call("POST", "/api/auth/email-verification/confirm", { body: { token: older } });

    for (const [label, r] of [["unknown", unknown], ["expired", expired], ["superseded", superseded]] as const) {
      expect(r.status, label).toBe(400);
      expect(r.body.error, label).toBe(INVALID_VERIFICATION_TOKEN);
    }
    expect(new Set([unknown, expired, superseded].map((r) => `${r.status}|${JSON.stringify(r.body)}`)).size).toBe(1);
    // The newest link still works.
    expect((await call("POST", "/api/auth/email-verification/confirm", { body: { token: newer } })).status).toBe(200);
  });

  it("a verification token cannot be used as a reset token, or the other way round", async () => {
    const member = await createMember(A.orgId, "AGENT", "verify-crosswise");
    const cookie = await loginOk(member.email);
    const verifyToken = await verificationTokenFor(cookie, member.email);
    const resetToken = await resetTokenFor(member.email);

    const asReset = await call("POST", "/api/auth/reset-password", { body: { token: verifyToken, password: NEW_PASSWORD } });
    expect(asReset.status).toBe(400);
    expect(asReset.body.error).toBe(INVALID_RESET_TOKEN);

    const asVerify = await call("POST", "/api/auth/email-verification/confirm", { body: { token: resetToken } });
    expect(asVerify.status).toBe(400);
    expect(asVerify.body.error).toBe(INVALID_VERIFICATION_TOKEN);

    // Neither attempt spent the other flow's token.
    expect((await call("POST", "/api/auth/email-verification/confirm", { body: { token: verifyToken } })).status).toBe(200);
    expect((await call("POST", "/api/auth/reset-password", { body: { token: resetToken, password: NEW_PASSWORD } })).status).toBe(200);
  });

  it("a token minted for an address is refused once that address has changed", async () => {
    const member = await createMember(A.orgId, "AGENT", "verify-moved");
    const cookie = await loginOk(member.email);
    const token = await verificationTokenFor(cookie, member.email);
    // The account moves to another address (an operator action today).
    const moved = `moved-${Date.now()}@example.test`;
    await db.update(users).set({ email: moved }).where(eq(users.id, member.userId));
    const r = await call("POST", "/api/auth/email-verification/confirm", { body: { token } });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe(INVALID_VERIFICATION_TOKEN);
    expect((await usersRepository.findById({ id: member.userId }))!.emailVerifiedAt).toBeNull();
  });

  it("requesting a verification mail needs a session, and never takes an address from the caller", async () => {
    // No cookie: the login gate refuses it, so it cannot be used to probe addresses or to mail a third party.
    expect((await call("POST", "/api/auth/email-verification/send")).status).toBe(401);
    expect((await call("GET", "/api/auth/email-verification")).status).toBe(401);

    const member = await createMember(A.orgId, "AGENT", "verify-own-only");
    const victim = await createMember(A.orgId, "AGENT", "verify-victim");
    const cookie = await loginOk(member.email);
    clearSentEmails();
    // An address in the body is ignored: the endpoint reads the session, not the payload.
    const r = await call("POST", "/api/auth/email-verification/send", { cookie, body: { email: victim.email } });
    expect(r.status).toBe(200);
    expect(r.body.data.email).toBe(member.email);
    await settleOutbox();
    expect(recipients()).not.toContain(victim.email);
  });

  it("says so (and mails nothing) when the address is already confirmed", async () => {
    const member = await createMember(A.orgId, "AGENT", "verify-twice");
    const cookie = await loginOk(member.email);
    const token = await verificationTokenFor(cookie, member.email);
    expect((await call("POST", "/api/auth/email-verification/confirm", { body: { token } })).status).toBe(200);

    clearSentEmails();
    const again = await call("POST", "/api/auth/email-verification/send", { cookie });
    expect(again.status).toBe(200);
    expect(again.body.data.alreadyVerified).toBe(true);
    await settleOutbox();
    expect(sentEmails()).toHaveLength(0);
  });

  it("limits verification mails per account (5 per 15 minutes)", async () => {
    const member = await createMember(A.orgId, "AGENT", "verify-throttle");
    const cookie = await loginOk(member.email);
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await call("POST", "/api/auth/email-verification/send", { cookie })).status);
    expect(codes.slice(0, 5).every((c) => c === 200)).toBe(true);
    expect(codes.slice(5)).toEqual([429, 429]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("the recovery endpoints and the login gate", () => {
  it("the three public ones are reachable without a session; the request-mail one is not", async () => {
    expect((await forgot(`gatecheck-${Date.now()}@example.test`)).status).toBe(200);
    expect((await call("POST", "/api/auth/reset-password", { body: { token: "x", password: NEW_PASSWORD } })).status).toBe(400);
    expect((await call("POST", "/api/auth/email-verification/confirm", { body: { token: "x" } })).status).toBe(400);
    expect((await call("POST", "/api/auth/email-verification/send")).status).toBe(401);
  });

  it("the token table holds no tenant data and no organization column", async () => {
    const cols = await db.execute(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      `select column_name from information_schema.columns where table_schema = 'public' and table_name = 'account_tokens'` as any,
    );
    const names = (cols as unknown as Array<{ column_name: string }>).map((c) => c.column_name).sort();
    expect(names).toEqual(["created_at", "email", "expires_at", "id", "purpose", "requested_ip", "token_hash", "used_at", "user_id"]);
    expect(names).not.toContain("organization_id");
  });

  it("the runtime role (row-level security on, no tenant context) can mint and spend a token", async () => {
    // This is the whole point of the no-RLS decision: the flow runs with no session and no organization. If a
    // policy were added here, both calls below would silently find nothing and the feature would be dead.
    const member = await createMember(A.orgId, "AGENT", "rls-no-context");
    const token = await resetTokenFor(member.email); // minted by the app, as the restricted role, unauthenticated
    const rows = await db
      .select()
      .from(accountTokens)
      .where(and(eq(accountTokens.userId, member.userId), eq(accountTokens.purpose, "password_reset")));
    expect(rows).toHaveLength(1);
    expect((await call("POST", "/api/auth/reset-password", { body: { token, password: NEW_PASSWORD } })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("housekeeping", () => {
  it("the janitor removes expired and long-spent tokens and leaves live ones alone", async () => {
    const { accountRecovery } = await import("./account-recovery.js");
    const member = await createMember(A.orgId, "AGENT", "janitor");
    const live = await resetTokenFor(member.email);
    const stale = await db
      .insert(accountTokens)
      .values({
        userId: member.userId,
        purpose: "email_verification",
        email: member.email,
        tokenHash: hashAccountToken(`stale-${Date.now()}`),
        expiresAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
      })
      .returning({ id: accountTokens.id });

    const removed = await accountRecovery.purgeUnusableTokens();
    expect(removed).toBeGreaterThanOrEqual(1);
    const left = await db.select().from(accountTokens).where(inArray(accountTokens.id, [stale[0].id]));
    expect(left).toHaveLength(0);
    // The live link still works.
    expect((await call("POST", "/api/auth/reset-password", { body: { token: live, password: NEW_PASSWORD } })).status).toBe(200);
  });
});
