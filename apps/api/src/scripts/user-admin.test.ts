import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { adminDb as db } from "../db/client.js";
import { securityEvents, sessions, users } from "../db/schema.js";
import { verifyPassword } from "../auth/password.js";
import { cleanupTenants, createTenant, TEST_PASSWORD } from "../test/tenants.js";
import { runUserAdmin } from "./user-admin.js";

afterAll(cleanupTenants);

const NEW_PASSWORD = "Blue-Harbour-5521"; // passes the policy: no name/email token, long enough, not common

async function userRow(email: string) {
  const rows = await db.select().from(users).where(eq(users.email, email)).limit(1);
  return rows[0];
}

async function eventsOf(userId: string, type: string) {
  return db.select().from(securityEvents).where(and(eq(securityEvents.actorUserId, userId), eq(securityEvents.eventType, type)));
}

describe("user:admin reset-password", () => {
  it("sets a new hash, stamps password_changed_at, ends every session and names the operator", async () => {
    const t = await createTenant("RP");
    const before = await userRow(t.email);
    expect(before.passwordChangedAt).toBeNull();
    // Two live logins on the account: both must be gone afterwards.
    await db.insert(sessions).values([
      { userId: t.userId, tokenHash: "a".repeat(64), expiresAt: new Date(Date.now() + 86_400_000) },
      { userId: t.userId, tokenHash: "b".repeat(64), expiresAt: new Date(Date.now() + 86_400_000) },
    ]);

    const result = (await runUserAdmin(["reset-password", t.email, "locked", "out"], { newPassword: NEW_PASSWORD })) as {
      sessionsRevoked: number;
      accountActive: boolean;
    };
    expect(result).toEqual({ sessionsRevoked: 2, accountActive: true });

    const after = await userRow(t.email);
    expect(after.passwordHash).not.toBe(before.passwordHash);
    expect(after.passwordHash.startsWith("scrypt$")).toBe(true); // the application's own hasher, not a second format
    expect(await verifyPassword(NEW_PASSWORD, after.passwordHash)).toBe(true);
    expect(await verifyPassword(TEST_PASSWORD, after.passwordHash)).toBe(false);
    expect(after.passwordChangedAt).toBeInstanceOf(Date);
    expect(await db.select().from(sessions).where(eq(sessions.userId, t.userId))).toHaveLength(0);

    const recorded = await eventsOf(t.userId, "auth.password.changed");
    expect(recorded).toHaveLength(1);
    expect(recorded[0].outcome).toBe("success");
    expect(recorded[0].metadata).toMatchObject({ operator: expect.any(String), reason: "locked out", byOperator: true, sessionsRevoked: 2 });
  });

  it("applies the app's password policy, records the refusal and changes nothing", async () => {
    const t = await createTenant("RQ");
    const before = await userRow(t.email);
    await expect(runUserAdmin(["reset-password", t.email], { newPassword: "short" })).rejects.toThrow(/too_short/);
    await expect(runUserAdmin(["reset-password", t.email], { newPassword: "password1234" })).rejects.toThrow(/too_common/);

    const after = await userRow(t.email);
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.passwordChangedAt).toBeNull();
    const refusals = await eventsOf(t.userId, "auth.password.rejected");
    expect(refusals.map((r) => (r.metadata as { problem?: string }).problem).sort()).toEqual(["too_common", "too_short"]);
    expect(refusals.every((r) => r.outcome === "denied")).toBe(true);
  });

  it("refuses the password the account already has (a reset that revokes sessions but rotates nothing)", async () => {
    const t = await createTenant("RR");
    await expect(runUserAdmin(["reset-password", t.email], { newPassword: TEST_PASSWORD })).rejects.toThrow(/already has/);
    expect((await userRow(t.email)).passwordChangedAt).toBeNull();
  });

  it("needs a password, a known command and a known user", async () => {
    const t = await createTenant("RS");
    delete process.env.NEW_PASSWORD; // the CLI reads it from the environment; nothing is set here
    await expect(runUserAdmin(["reset-password", t.email])).rejects.toThrow(/NEW_PASSWORD is required/);
    await expect(runUserAdmin(["reset-password", "nobody@example.test"], { newPassword: NEW_PASSWORD })).rejects.toThrow(/No user with email/);
    await expect(runUserAdmin(["reset-passwords", t.email], { newPassword: NEW_PASSWORD })).rejects.toThrow(/Usage: user:admin/);
    await expect(runUserAdmin([])).rejects.toThrow(/Usage: user:admin/);
  });
});
