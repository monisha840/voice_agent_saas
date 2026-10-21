import { describe, it, expect, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { adminDb as db } from "../db/client.js";
import { calls, organizationModules, subscriptions } from "../db/schema.js";
import { cleanupTenants, createTenant } from "../test/tenants.js";
import { formatTable, listOrganizations } from "./org-list.js";

afterAll(cleanupTenants);

const DAY = 86_400_000;

describe("org:list", () => {
  it("reports membership, modules, plan, the status in force and the last call date", async () => {
    const unmanaged = await createTenant("L1");
    const managed = await createTenant("L2", { modules: [] });
    const lapsed = await createTenant("L3");

    await db.insert(subscriptions).values({
      organizationId: managed.orgId,
      planKey: "growth",
      status: "active",
      currentPeriodStart: new Date(Date.now() - 2 * DAY),
      currentPeriodEnd: new Date(Date.now() + 28 * DAY),
    });
    // A trial whose end has passed: the stored status is still "trialing" until something sweeps it.
    await db.insert(subscriptions).values({
      organizationId: lapsed.orgId,
      planKey: "trial",
      status: "trialing",
      trialEndsAt: new Date(Date.now() - 2 * DAY),
      currentPeriodStart: new Date(Date.now() - 20 * DAY),
      currentPeriodEnd: new Date(Date.now() - 2 * DAY),
    });
    const lastCall = new Date(Date.now() - 3 * DAY);
    await db.update(calls).set({ startedAt: lastCall }).where(eq(calls.id, unmanaged.callId));

    const rows = await listOrganizations();
    // createTenant slugs are "t-<label>-<random>".
    const by = (label: string) => rows.find((r) => r.slug.startsWith(`t-${label}-`))!;

    const u = by("l1");
    expect(u).toMatchObject({ members: 1, modules: ["sales"], planKey: null, status: "unmanaged", storedStatus: null, calls: 1 });
    expect(u.lastCallAt).toBe(lastCall.toISOString());

    const m = by("l2");
    expect(m).toMatchObject({ members: 1, modules: [], planKey: "growth", planName: "Growth", status: "active", storedStatus: null, calls: 1 });

    const l = by("l3");
    expect(l.planKey).toBe("trial");
    expect(l.status).toBe("expired"); // computed at `now`, not read from the row
    expect(l.storedStatus).toBe("trialing");

    // Every organization is listed, in creation order, and nothing is written by listing them.
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect([...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map((r) => r.slug)).toEqual(rows.map((r) => r.slug));
    expect(await listOrganizations()).toEqual(rows);
  });

  it("lists several enabled modules and renders a padded table with a header", async () => {
    const t = await createTenant("L4");
    await db.insert(organizationModules).values({ organizationId: t.orgId, moduleKey: "zzz-future", enabled: true });
    await db.insert(organizationModules).values({ organizationId: t.orgId, moduleKey: "disabled-one", enabled: false });

    const rows = await listOrganizations();
    const mine = rows.find((r) => r.slug.startsWith("t-l4-"))!;
    expect(mine.modules).toEqual(["sales", "zzz-future"]); // alphabetical, disabled rows excluded

    const table = formatTable(rows);
    const [header, rule] = table.split("\n");
    expect(header.startsWith("SLUG")).toBe(true);
    expect(header).toContain("LAST CALL");
    expect(rule).toMatch(/^-+ {2}-+/);
    expect(table).toContain("unmanaged");
  });
});
