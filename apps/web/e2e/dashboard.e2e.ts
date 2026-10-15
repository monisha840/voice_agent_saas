import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

// Fixtures: apps/api/src/scripts/dashboard-ui-e2e-setup.ts. Screenshots go to test-results/dashboard-shots (ignored by git).
const PW = "UiTest-Passw0rd-1";
const API = process.env.E2E_API_URL ?? "http://127.0.0.1:4391";
const SHOTS = "test-results/dashboard-shots";

async function signIn(browser: Browser, email: string, viewport?: { width: number; height: number }): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(viewport ? { viewport } : {});
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
  return { ctx, page };
}

/** A datetime-local value `days` from now at 11:00 local time. */
function localInput(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T11:00`;
}

const stat = (page: Page, label: string) => page.getByText(label, { exact: true }).locator("..");

test.describe.configure({ mode: "serial" });

test("overview shows the organization's real numbers and nothing from other tenants", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "d-owner@ui.test");
  await expect(stat(page, "Total leads")).toContainText("30");
  // Seeded: one answered outbound, one failed outbound, one answered inbound.
  await expect(stat(page, "Calls, 30 days")).toContainText("3");
  await expect(stat(page, "Answered calls")).toContainText("2");
  await expect(stat(page, "Answered calls")).toContainText("67% answered");
  await expect(stat(page, "Interested leads")).toContainText("2");
  await expect(page.getByText("Calls per day")).toBeVisible();
  await expect(page.getByText("New leads per day")).toBeVisible();
  await expect(page.getByRole("link", { name: "Knowledge" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Numbers" })).toBeVisible();
  const visits = page.getByRole("heading", { name: "Upcoming site visits" }).locator("xpath=ancestor::section[1]");
  await expect(visits.getByRole("link", { name: "Arun Kumar" })).toBeVisible();
  await expect(page.getByText("Hidden Other Lead")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/overview.png`, fullPage: true });
  await ctx.close();
});

test("overview and leads fit a phone screen without sideways scrolling", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "d-owner@ui.test", { width: 375, height: 800 });
  for (const path of ["/", "/leads", "/site-visits", "/calls"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, path).toBeLessThanOrEqual(1);
  }
  await page.goto("/");
  await page.screenshot({ path: `${SHOTS}/overview-mobile.png`, fullPage: true });
  await ctx.close();
});

test("leads: paging, search by name and phone, status filter, empty result", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "d-owner@ui.test");
  await page.goto("/leads");
  await expect(page.getByText("1–25 of 30")).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("26–30 of 30")).toBeVisible();
  await page.getByPlaceholder("Search name or phone").fill("priya");
  await expect(page.getByText("1–1 of 1")).toBeVisible();
  await expect(page.getByRole("link", { name: "Priya Raman" })).toBeVisible();
  await page.getByPlaceholder("Search name or phone").fill("98111 00002");
  await expect(page.getByRole("link", { name: "Arun Kumar" })).toBeVisible();
  await page.getByPlaceholder("Search name or phone").fill("Hidden");
  await expect(page.getByText("No leads match")).toBeVisible();
  await page.getByPlaceholder("Search name or phone").fill("");
  await page.locator("select").first().selectOption("INTERESTED");
  await expect(page.getByText("1–1 of 1")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/leads.png`, fullPage: true });
  await ctx.close();
});

test("lead page: book a site visit once even when the button is double-clicked", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "d-owner@ui.test");
  await page.goto("/leads");
  await page.getByPlaceholder("Search name or phone").fill("Meena");
  await page.getByRole("link", { name: "Meena Iyer" }).click();
  await page.waitForURL(/\/leads\//);
  const leadId = page.url().split("/leads/")[1];
  await expect(page.getByText("Past", { exact: true })).toBeVisible(); // the seeded visit two days ago
  await page.getByRole("button", { name: "Book site visit" }).click();
  await page.getByLabel("Date and time").fill(localInput(5));
  await page.getByRole("button", { name: "Book visit" }).dblclick();
  await expect(page.getByText(/^Visit booked for/)).toBeVisible();
  await expect(page.getByText("Upcoming", { exact: true })).toBeVisible();
  const res = await ctx.request.get(`${API}/api/site-visits?leadId=${leadId}&view=upcoming`);
  expect((await res.json()).total).toBe(1);
  // The server refuses a second upcoming visit whatever the UI does.
  const again = await ctx.request.post(`${API}/api/site-visits`, { data: { leadId, scheduledAt: new Date(Date.now() + 6 * 86_400_000).toISOString() } });
  expect(again.status()).toBe(409);
  await page.screenshot({ path: `${SHOTS}/lead-detail.png`, fullPage: true });
  await ctx.close();
});

test("site visits: reschedule and cancel upcoming visits; past and cancelled ones cannot change", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "d-owner@ui.test");
  await page.goto("/site-visits");
  const arun = page.getByRole("row").filter({ hasText: "Arun Kumar" });
  await arun.getByRole("button", { name: "Reschedule" }).click();
  await page.getByLabel("Date and time").fill(localInput(9));
  await page.getByRole("button", { name: "Save new time" }).click();
  await expect(page.getByText(/^Visit for Arun Kumar moved to/)).toBeVisible();

  const meena = page.getByRole("row").filter({ hasText: "Meena Iyer" });
  await meena.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog", { name: "Cancel site visit" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel visit" }).click();
  await expect(page.getByText("Visit for Meena Iyer cancelled.")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Meena Iyer" })).toHaveCount(0);

  await page.getByRole("tab", { name: "Cancelled" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Meena Iyer" })).toBeVisible();
  await page.getByRole("tab", { name: "Past" }).click();
  const past = page.getByRole("row").filter({ hasText: "Meena Iyer" });
  await expect(past.getByText("No changes")).toBeVisible();
  await page.getByRole("tab", { name: "Upcoming" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Arun Kumar" })).toBeVisible();
  await expect(page.locator("[aria-busy=true]")).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/site-visits.png`, fullPage: true });
  await ctx.close();
});

test("calls: outcome filter, then details with the recorded transcript and honest empty states", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "d-owner@ui.test");
  await page.goto("/calls");
  await expect(page.getByRole("link", { name: /Priya Raman/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /Meena Iyer/ })).toBeVisible();
  await page.getByLabel("Filter by outcome").selectOption("answered");
  await expect(page.getByRole("link", { name: /Meena Iyer/ })).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/calls.png`, fullPage: true });
  await page.getByRole("link", { name: /Priya Raman/ }).click();
  await expect(page.getByText("Yes, I am looking for a 2 BHK near the lake.")).toBeVisible();
  await expect(page.getByText("Priya wants a 2 BHK and asked about prices.")).toBeVisible();
  await expect(page.getByText("No recording was stored for this call.")).toBeVisible();
  await expect(page.getByText("Offered", { exact: true })).toBeVisible();
  await expect(page.getByText("Line")).toHaveCount(0); // outbound call: no dialled line to show
  await expect(page.getByRole("link", { name: "Leads" })).toBeVisible(); // header finished loading
  await page.screenshot({ path: `${SHOTS}/call-detail.png`, fullPage: true });

  // An inbound call shows the line the caller dialled (migration 0024).
  await page.goto("/calls");
  await page.getByRole("link", { name: /Walk-in Caller/ }).click();
  await expect(page.getByText("Line", { exact: true })).toBeVisible();
  await expect(page.getByText("+918045000111")).toBeVisible();
  await ctx.close();
});

test("another organization cannot see or open these leads", async ({ browser }) => {
  const owner = await signIn(browser, "d-owner@ui.test");
  const found = await owner.ctx.request.get(`${API}/api/leads?q=Priya&limit=5`);
  const priyaId = (await found.json()).data[0].id as string;
  await owner.ctx.close();

  const { ctx, page } = await signIn(browser, "o-owner@ui.test");
  const res = await ctx.request.get(`${API}/api/leads?q=Priya&limit=5`);
  expect((await res.json()).total).toBe(0);
  expect((await ctx.request.get(`${API}/api/leads/${priyaId}`)).status()).toBe(404);
  await page.goto(`/leads/${priyaId}`);
  await expect(page.getByText("This page could not be found.")).toBeVisible();
  await page.goto("/");
  await expect(stat(page, "Total leads")).toContainText("1");
  await ctx.close();
});

test("an agent with no assigned leads sees an empty, honest dashboard", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "d-agent@ui.test");
  await expect(stat(page, "Total leads")).toContainText("0");
  // Both are gated by agents:read, which starts at MANAGER.
  await expect(page.getByRole("link", { name: "Knowledge" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Numbers" })).toHaveCount(0);
  await page.goto("/leads");
  await expect(page.getByText("No leads yet")).toBeVisible();
  await page.goto("/site-visits");
  await expect(page.getByText("No upcoming visits")).toBeVisible();
  await ctx.close();
});
