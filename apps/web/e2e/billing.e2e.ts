import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

const PW = "UiTest-Passw0rd-1";
const API = process.env.E2E_API_URL ?? "http://127.0.0.1:4291";

async function signIn(browser: Browser, email: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Wait until the login has finished and the dashboard rendered, so the next navigation cannot abort it.
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
  return { ctx, page };
}

test.describe.configure({ mode: "serial" });

test("unmanaged organization: shows the real state, then the owner starts a trial", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "legacy-owner@ui.test");
  await page.goto("/billing");
  await expect(page.getByText("not on a managed plan")).toBeVisible();
  await expect(page.getByText("No billed calls yet")).toBeVisible();
  await page.getByRole("button", { name: "Start free trial" }).click();
  await expect(page.getByText("Trial started.")).toBeVisible();
  await expect(page.getByText("0 of 30 minutes used")).toBeVisible();
  await expect(page.getByText("30 remaining")).toBeVisible();
  // a second start is refused by the server (409), whatever the UI shows
  const again = await ctx.request.post(`${API}/api/billing/trial`, { data: {} });
  expect(again.status()).toBe(409);
  await ctx.close();
});

test("trial plan caps agents at one: the second agent is refused with a clear reason", async ({ browser }) => {
  const { ctx } = await signIn(browser, "legacy-owner@ui.test");
  const res = await ctx.request.post(`${API}/api/agents`, { data: { name: "Second", personaName: "Asha" } });
  expect(res.status()).toBe(429);
  const body = (await res.json()) as { code: string; error: string };
  expect(body.code).toBe("AGENT_LIMIT_REACHED");
  expect(body.error).toMatch(/upgrade/i);
  await ctx.close();
});

test("owner sees plan, meter and call history from the real ledger; loading more and retry work", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "m-owner@ui.test");
  await page.goto("/billing");
  await expect(page.getByText("Starter").first()).toBeVisible();
  await expect(page.getByText("₹2,999 / month")).toBeVisible();
  await expect(page.getByText("27 of 300 minutes used")).toBeVisible();
  await expect(page.getByText("273 remaining")).toBeVisible();
  // 25 ended calls: first page is 20 rows
  await expect(page.locator("tbody tr")).toHaveCount(20);

  // Load more fails (network) -> error + Retry; then succeeds.
  await page.route("**/api/billing/usage?*cursor=*", (r) => r.abort());
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText(/Unable to reach the server|Failed to fetch/i)).toBeVisible();
  await page.unroute("**/api/billing/usage?*cursor=*");
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("tbody tr")).toHaveCount(25);
  await expect(page.getByText("Too short to bill")).toBeVisible();

  // cancel at period end, then withdraw
  await page.getByRole("button", { name: "Cancel plan" }).click();
  await page.getByRole("button", { name: "Yes, cancel" }).click();
  await expect(page.getByText(/^Ends /)).toBeVisible();
  await page.getByRole("button", { name: "Keep my plan" }).click();
  await expect(page.getByRole("button", { name: "Cancel plan" })).toBeVisible();

  // request a plan: recorded, nothing activated, honest about payments
  await page.getByRole("button", { name: "Request Growth" }).click();
  await expect(page.getByText(/Online payment is not enabled yet/)).toBeVisible();
  await expect(page.getByText("Current plan", { exact: true }).first()).toBeVisible();
  await ctx.close();
});

test("admin can read billing but not change it; manager and agent are denied", async ({ browser }) => {
  const admin = await signIn(browser, "m-admin@ui.test");
  await admin.page.goto("/billing");
  await expect(admin.page.getByText("27 of 300 minutes used")).toBeVisible();
  await expect(admin.page.getByRole("button", { name: "Cancel plan" })).toHaveCount(0);
  await expect(admin.page.getByRole("button", { name: /^Request / })).toHaveCount(0);
  expect((await admin.ctx.request.post(`${API}/api/billing/cancel`, { data: {} })).status()).toBe(403);
  await admin.ctx.close();

  for (const email of ["m-manager@ui.test", "m-agent@ui.test"]) {
    const u = await signIn(browser, email);
    await u.page.goto("/billing");
    await expect(u.page.getByText("You don't have permission")).toBeVisible();
    expect((await u.ctx.request.get(`${API}/api/billing/overview`)).status()).toBe(403);
    expect((await u.ctx.request.post(`${API}/api/billing/trial`, { data: {} })).status()).toBe(403);
    await u.ctx.close();
  }
});

test("quota exhaustion: banner, paused state, and the call attempt is refused with the next step", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "x-owner@ui.test");
  await page.goto("/billing");
  await expect(page.getByText("Calls are paused")).toBeVisible();
  await expect(page.getByText(/trial minutes are used up/i).first()).toBeVisible();
  await expect(page.getByText("30 of 30 minutes used")).toBeVisible();

  await page.goto("/test");
  await page.getByRole("button", { name: "Start test call" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /Choose a plan/ })).toBeVisible();
  await ctx.close();
});

test("empty state for a managed organization with no calls", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "e-owner@ui.test");
  await page.goto("/billing");
  await expect(page.getByText("No billed calls yet")).toBeVisible();
  await expect(page.getByText("0 of 30 minutes used")).toBeVisible();
  await ctx.close();
});

test("invalid request properties are rejected, and an organization id cannot be supplied", async ({ browser }) => {
  const { ctx } = await signIn(browser, "m-owner@ui.test");
  const post = (path: string, data: unknown) => ctx.request.post(`${API}${path}`, { data });
  expect((await post("/api/billing/plan-change", { planKey: "starter", organizationId: "00000000-0000-4000-8000-000000000000" })).status()).toBe(400);
  expect((await post("/api/billing/usage/reconcile", { durationSeconds: 99999 })).status()).toBe(400);
  expect((await post("/api/billing/cancel", { status: "active" })).status()).toBe(400);
  expect((await ctx.request.get(`${API}/api/billing/usage?limit=100000`)).status()).toBe(400);
  await ctx.close();
});

test("organization switching changes whose billing is shown (and what the role may do)", async ({ browser }) => {
  const { ctx } = await signIn(browser, "multi@ui.test");
  const me = (await (await ctx.request.get(`${API}/api/auth/me`)).json()) as { data: { organizations: Array<{ id: string; slug: string; role: string }> } };
  const legacy = me.data.organizations.find((o) => o.slug === "legacy-org")!;
  const managed = me.data.organizations.find((o) => o.slug === "managed-org")!;
  const sw = (id: string) => ctx.request.post(`${API}/api/auth/switch-organization`, { data: { organizationId: id } });

  expect((await sw(legacy.id)).status()).toBe(200);
  const a = (await (await ctx.request.get(`${API}/api/billing/overview`)).json()) as { data: { managed: boolean; plan: { key: string } | null } };
  expect(a.data.managed).toBe(true); // legacy org started its trial in the first test
  expect(a.data.plan?.key).toBe("trial");

  expect((await sw(managed.id)).status()).toBe(200);
  expect((await ctx.request.get(`${API}/api/billing/overview`)).status()).toBe(403); // AGENT in Managed Org
  expect((await ctx.request.get(`${API}/api/billing/plans`)).status()).toBe(200); // catalog needs only membership
  await ctx.close();
});
