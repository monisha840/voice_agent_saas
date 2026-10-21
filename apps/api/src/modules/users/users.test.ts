import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, inArray } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";

import { buildApp } from "../../app.js";
import { clearSentEmails, sentEmailsTo, setEmailSender, type EmailMessage, type IEmailSender } from "../../adapters/email/index.js";
import { adminDb as db } from "../../db/client.js";
import { auditLogs, invitations, leads, memberships, projectMembers, sessions, subscriptions, users } from "../../db/schema.js";
import { systemContext } from "../../auth/context.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import { cleanupTenants, createMember, createTenant, loginCookie, TEST_PASSWORD, type TestTenant } from "../../test/tenants.js";
import { hashInviteToken, usersService } from "./users.service.js";

type Role = "OWNER" | "ADMIN" | "MANAGER" | "AGENT";
let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let A: TestTenant;
let B: TestTenant;
const cookies = {} as Record<Role, string>;
let cookieB: string;
const members = {} as Record<"ADMIN" | "MANAGER" | "AGENT", { userId: string; email: string }>;
const createdEmails: string[] = [];
let ipCounter = 0;
const uniq = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

async function http(cookie: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { cookie, ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, text };
}
const json = (body: unknown) => JSON.stringify(body);

async function invite(cookie: string, email: string, role: Role) {
  const res = await http(cookie, "/api/users/invitations", { method: "POST", body: json({ email, role }) });
  return res;
}

/** Public endpoint; each call comes from a fresh IP so the per-IP rate limit never interferes. */
async function accept(body: Record<string, unknown>, ip = `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`) {
  const res = await app.inject({ method: "POST", url: "/api/auth/accept-invite", payload: body, remoteAddress: ip });
  const cookie = res.cookies.find((c) => c.name === "va_session");
  return { status: res.statusCode, body: res.json() as { data?: { id: string; email: string; name: string }; error?: string }, cookie: cookie ? `va_session=${cookie.value}` : "" };
}

async function resend(cookie: string, invitationId: string) {
  return http(cookie, `/api/users/invitations/${invitationId}/resend`, { method: "POST", body: json({}) });
}

const tokenFrom = (url: string) => new URL(url).searchParams.get("token") ?? "";
/** The accept link as it appears in a plain-text body (the URL must stand on its own there). */
const linkIn = (text: string) => text.match(/https?:\/\/\S*\/accept-invite\?token=[A-Za-z0-9_-]+/)?.[0] ?? "";

/**
 * A stand-in for a deployment with real credentials. The default sender is the mock one, which never claims a
 * delivery, so this is the only way to exercise what happens when a provider accepts a message - or goes down.
 */
function stubSender(opts: { fail?: Error; accept?: boolean } = {}): IEmailSender & { sent: EmailMessage[] } {
  const sent: EmailMessage[] = [];
  return {
    name: "resend",
    sent,
    async send(message: EmailMessage) {
      if (opts.fail) throw opts.fail;
      sent.push(message);
      return { providerMessageId: "stub-message-id", accepted: opts.accept ?? true };
    },
  };
}

/** Runs one action with that sender installed, and always puts the configured one back. */
async function withSender<T>(sender: IEmailSender, action: () => Promise<T>): Promise<T> {
  setEmailSender(sender);
  try {
    return await action();
  } finally {
    setEmailSender(null);
  }
}

/**
 * The invitee's token. It is NOT in the response in general: it comes back as `inviteUrl` only because no email
 * provider is configured in tests, which is the one case where nothing was actually delivered.
 */
async function newInvite(email: string, role: Role, cookie = cookies.OWNER) {
  createdEmails.push(email);
  const res = await invite(cookie, email, role);
  expect(res.status).toBe(201);
  expect(res.body.data.delivery).toBe("not-configured");
  return { token: tokenFrom(res.body.data.inviteUrl as string), id: res.body.data.invitation.id as string };
}

beforeAll(async () => {
  A = await createTenant("A");
  B = await createTenant("B");
  members.ADMIN = await createMember(A.orgId, "ADMIN");
  members.MANAGER = await createMember(A.orgId, "MANAGER");
  members.AGENT = await createMember(A.orgId, "AGENT");
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  cookies.OWNER = await loginCookie(baseUrl, A.email);
  cookies.ADMIN = await loginCookie(baseUrl, members.ADMIN.email);
  cookies.MANAGER = await loginCookie(baseUrl, members.MANAGER.email);
  cookies.AGENT = await loginCookie(baseUrl, members.AGENT.email);
  cookieB = await loginCookie(baseUrl, B.email);
});

afterAll(async () => {
  await app.close();
  // The mock outbox holds real (if unused) invite tokens: do not leave them in the process.
  setEmailSender(null);
  clearSentEmails();
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [A.orgId, B.orgId]));
  await db.delete(projectMembers).where(inArray(projectMembers.organizationId, [A.orgId, B.orgId]));
  await db.delete(invitations).where(inArray(invitations.organizationId, [A.orgId, B.orgId]));
  await cleanupTenants();
  if (createdEmails.length > 0) await db.delete(users).where(inArray(users.email, createdEmails));
});

describe("GET /api/users", () => {
  it("returns the team with the documented shape and no credentials; MANAGER may read, AGENT may not", async () => {
    const res = await http(cookies.MANAGER, "/api/users");
    expect(res.status).toBe(200);
    const team = res.body.data as Array<Record<string, unknown>>;
    expect(team).toHaveLength(4);
    expect(Object.keys(team[0]).sort()).toEqual(["email", "isActive", "joinedAt", "name", "role", "userId"]);
    expect(team.map((t) => t.email)).toContain(members.AGENT.email);
    expect(res.text).not.toMatch(/passwordHash|scrypt\$/);
    expect((await http(cookies.AGENT, "/api/users")).status).toBe(403);
  });

  it("never lists another organization's members", async () => {
    const team = (await http(cookies.OWNER, "/api/users")).body.data as Array<{ userId: string }>;
    expect(team.map((t) => t.userId)).not.toContain(B.userId);
  });
});

describe("POST /api/users/invitations", () => {
  it("creates an invitation and stores only the hash of its token", async () => {
    const email = `Newbie-${uniq()}@Example.test`;
    const res = await invite(cookies.OWNER, email, "AGENT");
    expect(res.status).toBe(201);
    const { invitation, delivery, inviteUrl } = res.body.data;
    expect(invitation).toMatchObject({ email: email.toLowerCase(), role: "AGENT" });
    expect(Object.keys(invitation).sort()).toEqual(["email", "expiresAt", "id", "role"]);
    expect(delivery).toBe("not-configured");
    const token = tokenFrom(inviteUrl);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new URL(inviteUrl).pathname).toBe("/accept-invite");
    const days = (new Date(invitation.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    const [row] = await db.select().from(invitations).where(eq(invitations.id, invitation.id));
    expect(row.tokenHash).toBe(hashInviteToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row.invitedByUserId).toBe(A.userId);

    // The token is never shown again.
    const list = await http(cookies.OWNER, "/api/users/invitations");
    expect(list.text).not.toContain(token);
    expect(list.text).not.toContain(row.tokenHash);
    expect(list.text).not.toMatch(/token/i);
    createdEmails.push(email.toLowerCase());
  });

  it("never returns a raw token field; the link is in the body only because no provider is configured", async () => {
    const email = `shape-${uniq()}@example.test`;
    createdEmails.push(email);
    const res = await invite(cookies.OWNER, email, "AGENT");
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.data).sort()).toEqual(["delivery", "invitation", "inviteUrl"]);
    expect(res.body.data).not.toHaveProperty("inviteToken");
    expect(res.body.data).not.toHaveProperty("acceptPath");
    expect(res.body.data.inviteUrl).toMatch(/^https?:\/\/.+\/accept-invite\?token=[A-Za-z0-9_-]{43}$/);
  });

  it("validates the body", async () => {
    expect((await invite(cookies.OWNER, "not-an-email", "AGENT")).status).toBe(400);
    expect((await http(cookies.OWNER, "/api/users/invitations", { method: "POST", body: json({ email: "a@example.test", role: "GOD" }) })).status).toBe(400);
    expect((await http(cookies.OWNER, "/api/users/invitations", { method: "POST", body: json({ email: "a@example.test" }) })).status).toBe(400);
  });

  it("enforces the hierarchy: ADMIN cannot invite OWNER/ADMIN, can invite MANAGER/AGENT; OWNER can invite anyone", async () => {
    expect((await invite(cookies.ADMIN, `x-${uniq()}@example.test`, "OWNER")).status).toBe(403);
    expect((await invite(cookies.ADMIN, `x-${uniq()}@example.test`, "ADMIN")).status).toBe(403);
    await newInvite(`m-${uniq()}@example.test`, "MANAGER", cookies.ADMIN);
    await newInvite(`a-${uniq()}@example.test`, "AGENT", cookies.ADMIN);
    await newInvite(`o-${uniq()}@example.test`, "OWNER", cookies.OWNER);
    await newInvite(`ad-${uniq()}@example.test`, "ADMIN", cookies.OWNER);
  });

  it("rejects an email that is already a member (409)", async () => {
    const res = await invite(cookies.OWNER, members.AGENT.email.toUpperCase(), "AGENT");
    expect(res.status).toBe(409);
  });

  it("re-inviting a pending email revokes the old invitation", async () => {
    const email = `again-${uniq()}@example.test`;
    const first = await newInvite(email, "AGENT");
    const second = await newInvite(email, "MANAGER");
    const pending = (await http(cookies.OWNER, "/api/users/invitations")).body.data as Array<{ id: string; email: string }>;
    expect(pending.filter((p) => p.email === email).map((p) => p.id)).toEqual([second.id]);
    expect((await accept({ token: first.token, name: "Old", password: "long-enough-password" })).status).toBe(400);
    expect((await accept({ token: second.token, name: "New", password: "long-enough-password" })).status).toBe(200);
  });

  it("writes an audit record with no token in it", async () => {
    const email = `audit-${uniq()}@example.test`;
    const { token, id } = await newInvite(email, "AGENT");
    const rows = await db.select().from(auditLogs).where(and(eq(auditLogs.organizationId, A.orgId), eq(auditLogs.entityId, id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "user.invited", actorUserId: A.userId, entityType: "invitation" });
    expect(rows[0].metadata).toEqual({ email, role: "AGENT", delivery: "not-configured" });
    expect(JSON.stringify(rows[0])).not.toContain(token);
  });
});

describe("the invitation email", () => {
  it("reaches the invitee with the accept link, the inviter, the organization, the role and the expiry", async () => {
    clearSentEmails();
    const email = `mailed-${uniq()}@example.test`;
    createdEmails.push(email);
    const res = await invite(cookies.OWNER, email, "MANAGER");
    expect(res.status).toBe(201);

    const recorded = sentEmailsTo(email);
    expect(recorded).toHaveLength(1);
    const msg = recorded[0].message;
    expect(msg.to.email).toBe(email);
    expect(msg.kind).toBe("invite");
    // The idempotency key is derived from the invitation row, never from the token.
    expect(msg.idempotencyKey).toBe(`invite:${res.body.data.invitation.id}`);
    expect(msg.subject).toContain("Tenant A");
    expect(msg.subject).not.toMatch(/[A-Za-z0-9_-]{43}/);

    // The plain-text body stands on its own: the absolute link is in it, built from APP_BASE_URL.
    const link = linkIn(msg.text);
    expect(link).toBe(res.body.data.inviteUrl);
    expect(msg.text).toContain("Tenant A"); // the organization
    expect(msg.text).toContain("owner-a user"); // who invited them
    expect(msg.text).toMatch(/manager/i); // the role
    expect(msg.text).toContain(new Date(res.body.data.invitation.expiresAt).toISOString().slice(0, 10)); // the expiry
    expect(msg.html).toContain(link);

    // The link in the email is the credential, and it works.
    expect((await accept({ token: tokenFrom(link), name: "Mailed Person", password: "long-enough-password" })).status).toBe(200);
  });

  it("with a provider configured the link is emailed and NEVER returned in the response", async () => {
    const sender = stubSender();
    const email = `real-${uniq()}@example.test`;
    createdEmails.push(email);
    const res = await withSender(sender, () => invite(cookies.OWNER, email, "AGENT"));
    expect(res.status).toBe(201);
    expect(res.body.data.delivery).toBe("sent");
    // The whole point: no credential in the API response once a real send happened.
    expect(Object.keys(res.body.data).sort()).toEqual(["delivery", "invitation"]);
    expect(res.text).not.toMatch(/token|inviteUrl|acceptPath/i);

    // The token left the server only inside the message body - and it is the real one.
    expect(sender.sent).toHaveLength(1);
    const token = tokenFrom(linkIn(sender.sent[0].text));
    const [row] = await db.select().from(invitations).where(eq(invitations.id, res.body.data.invitation.id));
    expect(row.tokenHash).toBe(hashInviteToken(token));
    expect(sender.sent[0].idempotencyKey).not.toContain(token);

    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, row.id), eq(auditLogs.action, "user.invited")));
    expect(audit[0].metadata).toEqual({ email, role: "AGENT", delivery: "sent" });
    expect((await accept({ token, name: "Real Person", password: "long-enough-password" })).status).toBe(200);
  });

  it("a provider outage does not fail or roll back the invitation, withholds the link, and shows up in the audit trail", async () => {
    const email = `outage-${uniq()}@example.test`;
    createdEmails.push(email);
    const res = await withSender(stubSender({ fail: new Error("smtp: connection refused") }), () =>
      invite(cookies.OWNER, email, "AGENT"),
    );
    expect(res.status).toBe(201);
    expect(res.body.data.delivery).toBe("failed");
    // A send was attempted, so no credential comes back: the recovery path is the resend endpoint.
    expect(Object.keys(res.body.data).sort()).toEqual(["delivery", "invitation"]);
    expect(res.text).not.toMatch(/token|inviteUrl|acceptPath/i);

    // The row and the seat it holds survived the failure.
    const [row] = await db.select().from(invitations).where(eq(invitations.id, res.body.data.invitation.id));
    expect(row.revokedAt).toBeNull();
    expect(row.acceptedAt).toBeNull();
    const pending = (await http(cookies.OWNER, "/api/users/invitations")).body.data as Array<{ id: string }>;
    expect(pending.map((p) => p.id)).toContain(row.id);

    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, row.id), eq(auditLogs.action, "user.invited")));
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toEqual({ email, role: "AGENT", delivery: "failed" });
    expect(JSON.stringify(audit[0])).not.toContain(row.tokenHash);
  });

  it("a provider that refuses the message is reported as failed too", async () => {
    const email = `refused-${uniq()}@example.test`;
    createdEmails.push(email);
    const res = await withSender(stubSender({ accept: false }), () => invite(cookies.OWNER, email, "AGENT"));
    expect(res.status).toBe(201);
    expect(res.body.data.delivery).toBe("failed");
    expect(res.body.data).not.toHaveProperty("inviteUrl");
  });

  it("a failed send is not a way to probe which addresses exist: the answer is the same either way", async () => {
    const outage = stubSender({ fail: new Error("smtp: connection refused") });
    const unknown = `nobody-${uniq()}@example.test`;
    const existing = await createMember(B.orgId, "AGENT", "probe"); // a real account, in another organization
    createdEmails.push(unknown);
    const results = await withSender(outage, async () => [
      await invite(cookies.OWNER, unknown, "AGENT"),
      await invite(cookies.OWNER, existing.email, "AGENT"),
    ]);
    for (const r of results) {
      expect(r.status).toBe(201);
      expect(Object.keys(r.body.data).sort()).toEqual(["delivery", "invitation"]);
      expect(r.body.data.delivery).toBe("failed");
    }
  });
});

describe("POST /api/users/invitations/:id/resend", () => {
  it("issues a FRESH token, emails it, kills the previous link, and audits the replacement", async () => {
    clearSentEmails();
    const email = `resend-${uniq()}@example.test`;
    const first = await newInvite(email, "AGENT");
    expect(sentEmailsTo(email)).toHaveLength(1);

    const res = await resend(cookies.OWNER, first.id);
    expect(res.status).toBe(201);
    const second = { id: res.body.data.invitation.id as string, token: tokenFrom(res.body.data.inviteUrl as string) };
    expect(second.id).not.toBe(first.id);
    expect(second.token).not.toBe(first.token);
    expect(second.token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Two messages, not one: the idempotency key is per invitation row, so a resend cannot be collapsed into the
    // first send by the provider (or by the mock) and silently deliver nothing.
    const mailed = sentEmailsTo(email);
    expect(mailed).toHaveLength(2);
    expect(mailed[1].message.idempotencyKey).toBe(`invite:${second.id}`);
    expect(mailed[1].message.idempotencyKey).not.toBe(mailed[0].message.idempotencyKey);
    expect(tokenFrom(linkIn(mailed[1].message.text))).toBe(second.token);
    expect(mailed[1].message.text).not.toContain(first.token);

    // The replaced invitation is gone from the pending list - the seat it held was released.
    const pending = (await http(cookies.OWNER, "/api/users/invitations")).body.data as Array<{ id: string; email: string }>;
    expect(pending.filter((p) => p.email === email).map((p) => p.id)).toEqual([second.id]);

    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, second.id), eq(auditLogs.action, "user.invitation_resent")));
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toEqual({ email, role: "AGENT", delivery: "not-configured", replaces: first.id });
    expect(JSON.stringify(audit[0])).not.toContain(second.token);

    expect((await accept({ token: first.token, name: "Old", password: "long-enough-password" })).status).toBe(400);
    expect((await accept({ token: second.token, name: "New", password: "long-enough-password" })).status).toBe(200);
  });

  it("an expired invitation is resendable - that is the recovery path - and comes back with a new expiry", async () => {
    const email = `rx-${uniq()}@example.test`;
    const stale = await newInvite(email, "AGENT");
    await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, stale.id));
    const res = await resend(cookies.OWNER, stale.id);
    expect(res.status).toBe(201);
    const days = (new Date(res.body.data.invitation.expiresAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect((await accept({ token: tokenFrom(res.body.data.inviteUrl), name: "Renewed", password: "long-enough-password" })).status).toBe(200);
  });

  it("an accepted or revoked invitation cannot be resent (404), nor can another tenant's", async () => {
    const used = await newInvite(`ru-${uniq()}@example.test`, "AGENT");
    expect((await accept({ token: used.token, name: "U", password: "long-enough-password" })).status).toBe(200);
    expect((await resend(cookies.OWNER, used.id)).status).toBe(404);

    const revoked = await newInvite(`rr-${uniq()}@example.test`, "AGENT");
    expect((await http(cookies.OWNER, `/api/users/invitations/${revoked.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await resend(cookies.OWNER, revoked.id)).status).toBe(404);

    const mine = await newInvite(`rm-${uniq()}@example.test`, "AGENT");
    expect((await resend(cookieB, mine.id)).status).toBe(404);
    expect((await resend(cookies.OWNER, "not-a-uuid")).status).toBe(400);
    // B's attempt did nothing: the invitation is still usable.
    expect((await accept({ token: mine.token, name: "Iso", password: "long-enough-password" })).status).toBe(200);
  });

  it("only OWNER/ADMIN may resend, and the role hierarchy is re-checked against the invitation's role", async () => {
    const forOwner = await newInvite(`rh-${uniq()}@example.test`, "OWNER");
    expect((await resend(cookies.ADMIN, forOwner.id)).status).toBe(403);
    expect((await resend(cookies.OWNER, forOwner.id)).status).toBe(201);
    const forAgent = await newInvite(`rh2-${uniq()}@example.test`, "AGENT");
    for (const role of ["MANAGER", "AGENT"] as const) {
      expect((await resend(cookies[role], forAgent.id)).status).toBe(403);
    }
  });

  it("refuses (409) when the address has become a member since the invitation was issued", async () => {
    const email = `rc-${uniq()}@example.test`;
    const pending = await newInvite(email, "AGENT");
    // The race: they joined through another route after this invitation was issued.
    const [joined] = await db.insert(users).values({ email, name: "Raced", passwordHash: await hashPassword(TEST_PASSWORD) }).returning();
    await db.insert(memberships).values({ organizationId: A.orgId, userId: joined.id, role: "AGENT" });
    expect((await resend(cookies.OWNER, pending.id)).status).toBe(409);
  });

  it("is seat-neutral: a resend fits a plan that is already full, a new address does not", async () => {
    const C = await createTenant("INVCAP", { modules: [] });
    const day = 86_400_000;
    await db.insert(subscriptions).values({
      organizationId: C.orgId,
      planKey: "starter",
      status: "active",
      limitOverrides: { maxTeamMembers: 2 },
      currentPeriodStart: new Date(Date.now() - 5 * day),
      currentPeriodEnd: new Date(Date.now() + 25 * day),
    });
    const cookieC = await loginCookie(baseUrl, C.email);
    const email = `cap-${uniq()}@example.test`;
    createdEmails.push(email);

    // C's owner + one pending invitation = the cap of 2.
    const first = await invite(cookieC, email, "AGENT");
    expect(first.status).toBe(201);
    const extra = await invite(cookieC, `cap2-${uniq()}@example.test`, "AGENT");
    expect(extra.status).toBe(429);
    expect(extra.body.code).toBe("TEAM_MEMBER_LIMIT_REACHED");

    // Resending revokes the pending row before inserting the new one, so the seat count never rises.
    const again = await resend(cookieC, first.body.data.invitation.id);
    expect(again.status).toBe(201);
    expect((await http(cookieC, "/api/users/invitations")).body.data).toHaveLength(1);
    expect((await invite(cookieC, `cap3-${uniq()}@example.test`, "AGENT")).status).toBe(429);
  });
});

describe("GET/DELETE /api/users/invitations", () => {
  it("only OWNER/ADMIN may list or revoke", async () => {
    for (const role of ["MANAGER", "AGENT"] as const) {
      expect((await http(cookies[role], "/api/users/invitations")).status).toBe(403);
    }
    expect((await http(cookies.ADMIN, "/api/users/invitations")).status).toBe(200);
  });

  it("lists only pending invitations (not revoked, accepted or expired)", async () => {
    const pending = await newInvite(`p-${uniq()}@example.test`, "AGENT");
    const revoked = await newInvite(`r-${uniq()}@example.test`, "AGENT");
    const expired = await newInvite(`e-${uniq()}@example.test`, "AGENT");
    const used = await newInvite(`u-${uniq()}@example.test`, "AGENT");
    await http(cookies.OWNER, `/api/users/invitations/${revoked.id}`, { method: "DELETE" });
    await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, expired.id));
    expect((await accept({ token: used.token, name: "U", password: "long-enough-password" })).status).toBe(200);
    const ids = ((await http(cookies.OWNER, "/api/users/invitations")).body.data as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(pending.id);
    for (const gone of [revoked, expired, used]) expect(ids).not.toContain(gone.id);
  });

  it("revoking works, is audited, and the token stops working", async () => {
    const { token, id } = await newInvite(`rv-${uniq()}@example.test`, "AGENT");
    const res = await http(cookies.OWNER, `/api/users/invitations/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await accept({ token, name: "X", password: "long-enough-password" })).status).toBe(400);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "user.invitation_revoked")));
    expect(audit).toHaveLength(1);
  });

  it("is tenant isolated: org B cannot see or revoke org A's invitations (404)", async () => {
    const { id, token } = await newInvite(`iso-${uniq()}@example.test`, "AGENT");
    const listB = await http(cookieB, "/api/users/invitations");
    expect((listB.body.data as Array<{ id: string }>).map((i) => i.id)).not.toContain(id);
    expect((await http(cookieB, `/api/users/invitations/${id}`, { method: "DELETE" })).status).toBe(404);
    expect((await http(cookies.OWNER, `/api/users/invitations/${"0".repeat(8)}-0000-4000-8000-000000000000`, { method: "DELETE" })).status).toBe(404);
    expect((await http(cookies.OWNER, "/api/users/invitations/not-a-uuid", { method: "DELETE" })).status).toBe(400);
    // Still usable: B's attempt did nothing.
    expect((await accept({ token, name: "Iso", password: "long-enough-password" })).status).toBe(200);
  });
});

describe("PATCH /api/users/:userId/role", () => {
  it("OWNER changes a role; it is audited with from/to and takes effect immediately", async () => {
    const m = await createMember(A.orgId, "AGENT", "promote");
    const res = await http(cookies.OWNER, `/api/users/${m.userId}/role`, { method: "PATCH", body: json({ role: "MANAGER" }) });
    expect(res.status).toBe(200);
    const [row] = await db.select().from(memberships).where(and(eq(memberships.userId, m.userId), eq(memberships.organizationId, A.orgId)));
    expect(row.role).toBe("MANAGER");
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, m.userId), eq(auditLogs.action, "user.role_changed")));
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toEqual({ from: "AGENT", to: "MANAGER" });
    expect(audit[0].actorUserId).toBe(A.userId);
  });

  it("ADMIN can change managers/agents but not grant ADMIN/OWNER nor touch ADMIN/OWNER", async () => {
    const agent = await createMember(A.orgId, "AGENT", "adm-target");
    expect((await http(cookies.ADMIN, `/api/users/${agent.userId}/role`, { method: "PATCH", body: json({ role: "MANAGER" }) })).status).toBe(200);
    expect((await http(cookies.ADMIN, `/api/users/${agent.userId}/role`, { method: "PATCH", body: json({ role: "ADMIN" }) })).status).toBe(403);
    expect((await http(cookies.ADMIN, `/api/users/${agent.userId}/role`, { method: "PATCH", body: json({ role: "OWNER" }) })).status).toBe(403);
    const otherAdmin = await createMember(A.orgId, "ADMIN", "other-admin");
    expect((await http(cookies.ADMIN, `/api/users/${otherAdmin.userId}/role`, { method: "PATCH", body: json({ role: "AGENT" }) })).status).toBe(403);
    expect((await http(cookies.ADMIN, `/api/users/${A.userId}/role`, { method: "PATCH", body: json({ role: "AGENT" }) })).status).toBe(403);
    const [owner] = await db.select().from(memberships).where(and(eq(memberships.userId, A.userId), eq(memberships.organizationId, A.orgId)));
    expect(owner.role).toBe("OWNER");
  });

  it("nobody can change their own role", async () => {
    const res = await http(cookies.OWNER, `/api/users/${A.userId}/role`, { method: "PATCH", body: json({ role: "AGENT" }) });
    expect(res.status).toBe(403);
    expect((await http(cookies.ADMIN, `/api/users/${members.ADMIN.userId}/role`, { method: "PATCH", body: json({ role: "MANAGER" }) })).status).toBe(403);
  });

  it("MANAGER and AGENT cannot change roles", async () => {
    for (const role of ["MANAGER", "AGENT"] as const) {
      const res = await http(cookies[role], `/api/users/${members.AGENT.userId}/role`, { method: "PATCH", body: json({ role: "AGENT" }) });
      expect(res.status).toBe(403);
    }
  });

  it("protects the last OWNER (even from a system actor, who has no self-check)", async () => {
    const owners = await db.select().from(memberships).where(and(eq(memberships.organizationId, B.orgId), eq(memberships.role, "OWNER")));
    expect(owners).toHaveLength(1);
    await expect(usersService.changeRole(systemContext(B.orgId, "test"), { userId: B.userId, role: "ADMIN" })).rejects.toThrow(/at least one owner/);
    await expect(usersService.removeMember(systemContext(B.orgId, "test"), { userId: B.userId })).rejects.toThrow(/at least one owner/);
    // With a second owner, demoting one is fine.
    const second = await createMember(B.orgId, "OWNER", "second-owner");
    await usersService.changeRole(systemContext(B.orgId, "test"), { userId: second.userId, role: "ADMIN" });
  });

  it("validates input and hides other organizations' users (404)", async () => {
    expect((await http(cookies.OWNER, `/api/users/${members.AGENT.userId}/role`, { method: "PATCH", body: json({ role: "KING" }) })).status).toBe(400);
    expect((await http(cookies.OWNER, "/api/users/not-a-uuid/role", { method: "PATCH", body: json({ role: "AGENT" }) })).status).toBe(400);
    expect((await http(cookies.OWNER, `/api/users/${B.userId}/role`, { method: "PATCH", body: json({ role: "AGENT" }) })).status).toBe(404);
    expect((await http(cookieB, `/api/users/${members.AGENT.userId}/role`, { method: "PATCH", body: json({ role: "OWNER" }) })).status).toBe(404);
    const [stillAgent] = await db.select().from(memberships).where(and(eq(memberships.userId, members.AGENT.userId), eq(memberships.organizationId, A.orgId)));
    expect(stillAgent.role).toBe("AGENT");
  });
});

describe("DELETE /api/users/:userId", () => {
  it("removes the membership, project assignments and lead assignments; the account survives; access ends on the very next request", async () => {
    const m = await createMember(A.orgId, "AGENT", "leaver");
    const cookie = await loginCookie(baseUrl, m.email);
    await db.insert(projectMembers).values({ organizationId: A.orgId, projectId: A.projectId, userId: m.userId });
    await db.update(leads).set({ assignedUserId: m.userId }).where(eq(leads.id, A.leadId));
    expect((await http(cookie, "/api/leads")).status).toBe(200);

    const res = await http(cookies.ADMIN, `/api/users/${m.userId}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    expect(await db.select().from(memberships).where(and(eq(memberships.userId, m.userId), eq(memberships.organizationId, A.orgId)))).toHaveLength(0);
    expect(await db.select().from(projectMembers).where(eq(projectMembers.userId, m.userId))).toHaveLength(0);
    const [lead] = await db.select().from(leads).where(eq(leads.id, A.leadId));
    expect(lead.assignedUserId).toBeNull();
    expect(await db.select().from(users).where(eq(users.id, m.userId))).toHaveLength(1);
    // Their sessions that were working in this organization end with the membership (same transaction).
    expect(await db.select().from(sessions).where(eq(sessions.userId, m.userId))).toHaveLength(0);

    // The still-valid cookie must no longer reach the organization's data.
    for (const path of ["/api/leads", "/api/users", "/api/organization", "/api/projects"]) {
      const after = await http(cookie, path);
      expect([401, 403]).toContain(after.status);
      expect(after.text).not.toContain(A.projectName);
    }
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, m.userId), eq(auditLogs.action, "user.removed")));
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBe(members.ADMIN.userId);
  });

  it("ADMIN cannot remove ADMIN/OWNER; nobody removes themselves; MANAGER/AGENT cannot remove", async () => {
    const otherAdmin = await createMember(A.orgId, "ADMIN", "keep-admin");
    expect((await http(cookies.ADMIN, `/api/users/${otherAdmin.userId}`, { method: "DELETE" })).status).toBe(403);
    expect((await http(cookies.ADMIN, `/api/users/${A.userId}`, { method: "DELETE" })).status).toBe(403);
    expect((await http(cookies.ADMIN, `/api/users/${members.ADMIN.userId}`, { method: "DELETE" })).status).toBe(403);
    expect((await http(cookies.OWNER, `/api/users/${A.userId}`, { method: "DELETE" })).status).toBe(403);
    expect((await http(cookies.MANAGER, `/api/users/${members.AGENT.userId}`, { method: "DELETE" })).status).toBe(403);
    expect((await http(cookies.AGENT, `/api/users/${members.MANAGER.userId}`, { method: "DELETE" })).status).toBe(403);
    expect(await db.select().from(memberships).where(eq(memberships.userId, otherAdmin.userId))).toHaveLength(1);
  });

  it("OWNER can remove an ADMIN", async () => {
    const admin = await createMember(A.orgId, "ADMIN", "fired-admin");
    expect((await http(cookies.OWNER, `/api/users/${admin.userId}`, { method: "DELETE" })).status).toBe(200);
  });

  it("is tenant isolated (404) and validates the id", async () => {
    expect((await http(cookies.OWNER, `/api/users/${B.userId}`, { method: "DELETE" })).status).toBe(404);
    expect((await http(cookieB, `/api/users/${members.AGENT.userId}`, { method: "DELETE" })).status).toBe(404);
    expect((await http(cookies.OWNER, "/api/users/nope", { method: "DELETE" })).status).toBe(400);
    expect(await db.select().from(memberships).where(eq(memberships.userId, B.userId))).toHaveLength(1);
  });
});

describe("POST /api/auth/accept-invite", () => {
  it("creates the account + membership, starts a session in the invited org, and audits it", async () => {
    const email = `join-${uniq()}@example.test`;
    const { token, id } = await newInvite(email, "MANAGER");
    const res = await accept({ token, name: "Joiner", password: "a-very-long-password" });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ email, name: "Joiner" });
    expect(res.cookie).not.toBe("");

    const me = await http(res.cookie, "/api/auth/me");
    expect(me.body.data.organization.id).toBe(A.orgId);
    const org = await http(res.cookie, "/api/organization");
    expect(org.body.data).toMatchObject({ id: A.orgId, role: "MANAGER" });

    const [user] = await db.select().from(users).where(eq(users.email, email));
    expect(await verifyPassword("a-very-long-password", user.passwordHash)).toBe(true);
    expect(user.passwordHash).not.toContain("a-very-long-password");
    const [inv] = await db.select().from(invitations).where(eq(invitations.id, id));
    expect(inv.acceptedAt).not.toBeNull();

    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "user.invite_accepted")));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ organizationId: A.orgId, actorUserId: user.id });
    expect(JSON.stringify(audit[0])).not.toContain(token);
    expect(JSON.stringify(audit[0])).not.toContain("a-very-long-password");
  });

  it("returns one generic error for unknown, used, revoked and expired tokens", async () => {
    const used = await newInvite(`g1-${uniq()}@example.test`, "AGENT");
    await accept({ token: used.token, name: "G", password: "long-enough-password" });
    const revoked = await newInvite(`g2-${uniq()}@example.test`, "AGENT");
    await http(cookies.OWNER, `/api/users/invitations/${revoked.id}`, { method: "DELETE" });
    const expired = await newInvite(`g3-${uniq()}@example.test`, "AGENT");
    await db.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, expired.id));

    const results = [];
    for (const token of [used.token, revoked.token, expired.token, "totally-unknown-token"]) {
      results.push(await accept({ token, name: "Nope", password: "long-enough-password" }));
    }
    for (const r of results) {
      expect(r.status).toBe(400);
      expect(r.body).toEqual({ error: "Invalid or expired invitation" });
      expect(r.cookie).toBe("");
    }
  });

  it("enforces the password policy (10-128) and requires name and token", async () => {
    const { token } = await newInvite(`pw-${uniq()}@example.test`, "AGENT");
    expect((await accept({ token, name: "P", password: "short" })).status).toBe(400);
    expect((await accept({ token, name: "P", password: "x".repeat(129) })).status).toBe(400);
    expect((await accept({ token, name: "", password: "long-enough-password" })).status).toBe(400);
    expect((await accept({ name: "P", password: "long-enough-password" })).status).toBe(400);
    // Failed validation did not burn the invitation.
    expect((await accept({ token, name: "P", password: "long-enough-password" })).status).toBe(200);
  });

  it("an existing account must prove its password; the password is never changed", async () => {
    const existing = await createMember(B.orgId, "AGENT", "multi");
    const [before] = await db.select().from(users).where(eq(users.id, existing.userId));
    const { token } = await newInvite(existing.email, "MANAGER");

    const wrong = await accept({ token, name: "Whoever", password: "not-the-right-password" });
    expect(wrong.status).toBe(401);
    expect(wrong.cookie).toBe("");
    expect(await db.select().from(memberships).where(and(eq(memberships.userId, existing.userId), eq(memberships.organizationId, A.orgId)))).toHaveLength(0);

    const ok = await accept({ token, name: "Whoever", password: TEST_PASSWORD });
    expect(ok.status).toBe(200);
    const [after] = await db.select().from(users).where(eq(users.id, existing.userId));
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.name).toBe(before.name);
    const [m] = await db.select().from(memberships).where(and(eq(memberships.userId, existing.userId), eq(memberships.organizationId, A.orgId)));
    expect(m.role).toBe("MANAGER");
    expect(await db.select().from(memberships).where(eq(memberships.userId, existing.userId))).toHaveLength(2);
    expect((await http(ok.cookie, "/api/auth/me")).body.data.organization.id).toBe(A.orgId);
  });

  it("two concurrent accepts of the same token: exactly one wins", async () => {
    const { token } = await newInvite(`race-${uniq()}@example.test`, "AGENT");
    const results = await Promise.all([
      accept({ token, name: "R1", password: "long-enough-password" }),
      accept({ token, name: "R2", password: "long-enough-password" }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    const email = results.find((r) => r.status === 200)!.body.data!.email;
    const rows = await db.select().from(users).where(eq(users.email, email));
    expect(rows).toHaveLength(1);
    expect(await db.select().from(memberships).where(eq(memberships.userId, rows[0].id))).toHaveLength(1);
  });

  it("is rate limited per IP", async () => {
    const ip = "10.77.77.77";
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await accept({ token: `bogus-${i}`, name: "B", password: "long-enough-password" }, ip)).status);
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    // Another IP is unaffected.
    expect((await accept({ token: "bogus", name: "B", password: "long-enough-password" }, "10.77.77.78")).status).toBe(400);
  });
});

describe("audit trail never holds secrets", () => {
  it("no audit row for this organization contains a token, hash or password", async () => {
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.organizationId, A.orgId));
    expect(rows.length).toBeGreaterThan(5);
    const blob = JSON.stringify(rows);
    expect(blob).not.toMatch(/scrypt\$/);
    expect(blob).not.toMatch(/long-enough-password|a-very-long-password|inviteToken|tokenHash/);
    const invites = await db.select().from(invitations).where(eq(invitations.organizationId, A.orgId));
    for (const inv of invites) expect(blob).not.toContain(inv.tokenHash);
  });

});
