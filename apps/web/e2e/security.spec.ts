import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import path from "node:path";

/* eslint-disable @typescript-eslint/no-require-imports */
const OTPAuth = require(path.resolve(__dirname, "../../api/node_modules/otpauth")) as {
  TOTP: new (o: { secret: unknown; digits: number; period: number; algorithm: string }) => { generate(): string };
  Secret: { fromBase32(s: string): unknown };
};

const PHASE = process.env.E2E_PHASE ?? "off";
const PW1 = "UiTest-Passw0rd-1";
const PW2 = "UiTest-New-Passw0rd-2";

let secret = "";
let lastCounter = -1;
let recovery: string[] = [];

/** A TOTP code for a 30s step not used before (the server rejects replays), waiting for the next step if needed. */
async function freshCode(): Promise<string> {
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30, algorithm: "SHA1" });
  for (;;) {
    const counter = Math.floor(Date.now() / 30_000);
    if (counter > lastCounter) {
      lastCounter = counter;
      return totp.generate();
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  // Wait for the outcome (dashboard header, second-factor step, or an error) so later navigations do not abort the login.
  await expect(
    page.locator("header").or(page.getByText("Enter the 6-digit code")).or(page.locator("p[role=alert]")).first(),
  ).toBeVisible();
}

async function newSession(browser: Browser): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ userAgent: "Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0 SecondDevice" });
  return { ctx, page: await ctx.newPage() };
}

async function headerSignOut(page: Page) {
  await page.locator("header").getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** Starts enrolment (confirming the password if the server asks) and returns once the QR step is visible. */
async function startEnrol(page: Page, password: string) {
  await page.getByRole("button", { name: "Set up two-step verification" }).click();
  const reauth = page.getByText("Confirm your password");
  const qr = page.getByAltText(/QR code/);
  await expect(reauth.or(qr).first()).toBeVisible();
  if (await reauth.isVisible()) {
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Confirm" }).click();
  }
  await expect(qr).toBeVisible();
}

async function enrolAndConfirm(page: Page, password: string) {
  await startEnrol(page, password);
  const qr = page.getByAltText(/QR code/);
  expect(await qr.evaluate((i) => (i as HTMLImageElement).complete && (i as HTMLImageElement).naturalWidth > 0)).toBe(true);
  secret = (await page.locator("code").first().innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await page.getByLabel("6-digit code").fill(await freshCode());
  await page.getByRole("button", { name: "Verify" }).click();
  const alert = page.getByRole("alert").filter({ hasText: "recovery codes" });
  await expect(alert).toBeVisible();
  recovery = (await alert.locator("li").allInnerTexts()).map((s) => s.trim());
  expect(recovery.length).toBeGreaterThanOrEqual(8);
}

async function recoveryLogin(page: Page, code: string) {
  await page.getByRole("button", { name: "Use a recovery code instead" }).click();
  await page.getByLabel("Recovery code").fill(code);
  await page.getByRole("button", { name: "Verify" }).click();
}

test.describe.configure({ mode: "serial" });

if (PHASE === "off") {
  test("1 sign in with email and password", async ({ page }) => {
    await signIn(page, "owner@ui.test", PW1);
    await expect(page).toHaveURL(/127\.0\.0\.1:3100\/$/);
    await expect(page.locator("header").getByText("UI Test Org")).toBeVisible();
    // Scenario 2 (/account/security renders) shares this session: the login route allows 10 attempts per IP+email per 15 min.
    await page.getByRole("link", { name: "Security" }).click();
    await expect(page).toHaveURL(/\/account\/security/);
    await expect(page.getByRole("heading", { name: "Account security" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Where you are signed in" })).toBeVisible();
    await expect(page.getByText("This device").first()).toBeVisible();
    await expect(page.getByText("Two-step verification").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Change password" })).toBeVisible();
  });

  test("3 change password signs out the other session", async ({ page, browser }) => {
    await signIn(page, "owner@ui.test", PW1);
    const other = await newSession(browser);
    await signIn(other.page, "owner@ui.test", PW1);
    await expect(other.page).toHaveURL(/\/$/);
    await page.goto("/account/security");
    await page.getByLabel("Current password").fill(PW1);
    await page.getByLabel("New password").fill(PW2);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText(/Password changed\. [1-9]\d* other session/)).toBeVisible();
    await other.page.goto("/account/security");
    await expect(other.page.getByLabel("Email")).toBeVisible(); // served the sign-in page (revoked)
    await other.ctx.close();
    await page.reload();
    await expect(page.getByRole("heading", { name: "Account security" })).toBeVisible();
  });

  test("4 enrol MFA: QR + manual key, recovery codes shown once", async ({ page }) => {
    await signIn(page, "owner@ui.test", PW2);
    await page.goto("/account/security");
    await enrolAndConfirm(page, PW2);
    await expect(page.getByText("Your other devices were signed out")).toBeVisible();
    await page.getByRole("button", { name: "I have saved them" }).click();
    await expect(page.getByText("Recovery codes left:")).toBeVisible();
    await page.reload();
    await expect(page.getByText("Save these recovery codes now")).toHaveCount(0);
    for (const c of recovery) await expect(page.getByText(c)).toHaveCount(0);
  });

  test("5 sign in requires a code; wrong code rejected; right code works", async ({ page }) => {
    await signIn(page, "owner@ui.test", PW2);
    await expect(page.getByText("Enter the 6-digit code")).toBeVisible();
    await page.goto("/account/security");
    // protected pages are replaced by the code step while the login is pending
    await expect(page.getByText("Enter the 6-digit code")).toBeVisible();
    await page.getByLabel("Verification code").fill("000000");
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.locator("p[role=alert]")).toBeVisible();
    await expect(page.getByLabel("Verification code")).toBeVisible();
    await page.getByLabel("Verification code").fill(await freshCode());
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.locator("header").getByText("UI Test Org")).toBeVisible();
  });

  test("6 recovery code login works once", async ({ page }) => {
    await signIn(page, "owner@ui.test", PW2);
    await recoveryLogin(page, recovery[0]);
    await expect(page.locator("header").getByText("UI Test Org")).toBeVisible();
    await page.goto("/account/security");
    await expect(page.locator("strong", { hasText: String(recovery.length - 1) })).toBeVisible();
    await headerSignOut(page);
    await signIn(page, "owner@ui.test", PW2);
    await recoveryLogin(page, recovery[0]);
    await expect(page.locator("p[role=alert]")).toBeVisible();
  });

  test("7 sessions list: This device + revoke another session", async ({ page, browser }) => {
    await signIn(page, "owner@ui.test", PW2);
    await recoveryLogin(page, recovery[1]);
    await expect(page.locator("header").getByText("UI Test Org")).toBeVisible();

    const other = await newSession(browser);
    await signIn(other.page, "owner@ui.test", PW2);
    await recoveryLogin(other.page, recovery[2]);
    await expect(other.page.locator("header").getByText("UI Test Org")).toBeVisible();

    await page.goto("/account/security");
    await expect(page.getByText("This device")).toHaveCount(1);
    const rows = page.locator("li").filter({ hasText: "Last active" });
    const rowSignOut = rows.getByRole("button", { name: "Sign out", exact: true });
    await expect(rowSignOut.first()).toBeVisible();
    // 7b: the per-row Sign out button (DELETE /api/auth/sessions/:id). Soft assertion so the rest still runs.
    const countBefore = await rows.count();
    await rowSignOut.first().click();
    await expect.soft(page.getByText("That device was signed out."), "per-row revoke shows its success notice").toBeVisible();
    await expect.soft(rows, "per-row revoke removes one session").toHaveCount(countBefore - 1);
    await page.reload();
    await expect(rows.first()).toBeVisible();
    await page.getByRole("button", { name: "Sign out all other devices" }).click();
    await expect(page.getByText(/Signed out [0-9]+ other device/)).toBeVisible();
    await expect(page.getByText("This device")).toHaveCount(1);
    await expect(page.locator("li").filter({ hasText: "Last active" })).toHaveCount(1);
    await other.page.goto("/account/security");
    await expect(other.page.getByLabel("Email")).toBeVisible();
    await other.ctx.close();
  });
}

if (PHASE === "enforce") {
  test("8 MFA_ENFORCEMENT=enforce: admin sees banner, only security page usable, enrol unlocks", async ({ page }) => {
    await signIn(page, "admin@ui.test", PW1);
    const banner = page.getByRole("alert").filter({ hasText: "requires two-step verification" });
    await expect(banner).toBeVisible();
    await page.goto("/agents");
    await expect(banner).toBeVisible();
    const denied = await page.evaluate(async () => (await fetch("http://127.0.0.1:4100/api/agents", { credentials: "include" })).status);
    expect(denied).toBe(403);
    await page.getByRole("link", { name: "Set it up now" }).click();
    await expect(page).toHaveURL(/\/account\/security/);
    await expect(page.getByText("Your role requires it before you can continue.")).toBeVisible();
    await enrolAndConfirm(page, PW1);
    await page.getByRole("button", { name: "I have saved them" }).click();
    await page.goto("/agents");
    await expect(banner).toHaveCount(0);
    const ok = await page.evaluate(async () => (await fetch("http://127.0.0.1:4100/api/agents", { credentials: "include" })).status);
    expect(ok).toBe(200);
  });
}
