import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";

const PW = "UiTest-Passw0rd-1";
const API = process.env.E2E_API_URL ?? "http://127.0.0.1:4491";

async function signIn(browser: Browser, email: string): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PW);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  await expect(page.getByRole("link", { name: "Overview" })).toBeVisible();
  return { ctx, page };
}

test.describe.configure({ mode: "serial" });

let kbUrl = "";

test("owner creates a knowledge base and manages FAQ and information entries", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "kb-owner@ui.test");
  page.on("dialog", (d) => void d.accept());
  await page.goto("/knowledge");
  await expect(page.getByText("No knowledge yet")).toBeVisible();
  await expect(page.getByText("Other secret base")).toHaveCount(0); // another organization's knowledge is invisible

  await page.getByRole("button", { name: "New knowledge base" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Front desk");
  await page.getByRole("button", { name: "Create" }).click();
  await page.waitForURL(/\/knowledge\/[0-9a-f-]{36}$/);
  kbUrl = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { name: "Front desk" })).toBeVisible();

  // FAQ: add, then edit
  await page.getByRole("button", { name: "Add question" }).click();
  await page.getByLabel("Question", { exact: true }).fill("Do you deliver?");
  await page.getByRole("textbox", { name: /^Answer/ }).fill("Yes, within 3 km.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Yes, within 3 km.")).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).first().click();
  await page.getByRole("textbox", { name: /^Answer/ }).fill("Yes, free delivery within 5 km.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Yes, free delivery within 5 km.")).toBeVisible();
  await expect(page.getByText("Yes, within 3 km.")).toHaveCount(0);

  // Information: add, then delete
  await page.getByRole("button", { name: "Add information" }).click();
  await page.getByLabel("Topic", { exact: true }).fill("Old timings");
  await page.getByRole("textbox", { name: /^Information/ }).fill("We open at 8 am.");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("We open at 8 am.")).toBeVisible();
  await page.getByRole("button", { name: "Delete Old timings" }).click();
  await expect(page.getByText("We open at 8 am.")).toHaveCount(0);

  // Empty entries are refused with a message, not saved
  await page.getByRole("button", { name: "Add question" }).click();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Enter both the question and the answer.")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await ctx.close();
});

test("document upload: a text file becomes searchable; invalid and duplicate files are refused with a message", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "kb-owner@ui.test");
  await page.goto(kbUrl);
  const file = page.locator('input[type="file"]');
  const policy = "# Returns\n\nItems can be returned within 7 days with the bill.\n\n# Payment\n\nWe accept UPI and cards.";
  await file.setInputFiles({ name: "policies.md", mimeType: "text/markdown", buffer: Buffer.from(policy) });
  await expect(page.getByText(/"policies.md" processed into \d+ passage/)).toBeVisible();
  await expect(page.getByText("policies.md", { exact: true })).toBeVisible();
  await expect(page.getByText("ready", { exact: true })).toBeVisible();

  await file.setInputFiles({ name: "brochure.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.7") });
  await expect(page.getByText(/Unsupported file type/)).toBeVisible();
  await file.setInputFiles({ name: "latin1.txt", mimeType: "text/plain", buffer: Buffer.from([0x63, 0x61, 0x66, 0xe9]) });
  await expect(page.getByText(/not UTF-8/)).toBeVisible();
  await file.setInputFiles({ name: "policies-again.md", mimeType: "text/markdown", buffer: Buffer.from(policy) });
  await expect(page.getByText(/already uploaded as "policies.md"/)).toBeVisible();
  await expect(page.getByText("brochure.pdf", { exact: true })).toHaveCount(0); // refused uploads leave no record

  // what an agent would retrieve
  await page.getByLabel("Test question").fill("can I return an item?");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("Items can be returned within 7 days with the bill.")).toBeVisible();
  await page.getByLabel("Test question").fill("helicopter rides");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText(/Nothing found/)).toBeVisible();
  await ctx.close();
});

test("owner connects the knowledge base to an agent; the binding survives a reload and an editor save", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "kb-owner@ui.test");
  await page.goto("/agents");
  await page.getByRole("link", { name: /Assistant/ }).first().click();
  await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/);
  const box = page.getByRole("checkbox", { name: /Front desk/ });
  await expect(box).not.toBeChecked();
  await box.check();
  const saved = page.waitForResponse((r) => r.url().endsWith("/knowledge-bases") && r.request().method() === "PUT");
  const reloaded = page.waitForEvent("load");
  await page.getByRole("button", { name: "Save knowledge" }).click();
  expect((await saved).status()).toBe(200);
  await reloaded; // the page reloads so the editor below picks up the changed tool list
  await expect(page.getByRole("checkbox", { name: /Front desk/ })).toBeChecked();
  // The search tool is now enabled on the agent (server state, read through the same API the dashboard uses).
  const agentId = new URL(page.url()).pathname.split("/").pop()!;
  const agent = (await (await ctx.request.get(`${API}/api/agents/${agentId}`)).json()) as { data: { enabledTools: string[] } };
  expect(agent.data.enabledTools).toContain("search_knowledge");
  // Saving the agent editor (which does not know about knowledge bases) keeps the binding and the tool.
  const save = await ctx.request.patch(`${API}/api/agents/${agentId}`, { data: { enabledTools: ["end_call"] } });
  expect(save.status()).toBe(200);
  await page.reload();
  await expect(page.getByRole("checkbox", { name: /Front desk/ })).toBeChecked();
  await ctx.close();
});

test("playground: the saved agent answers from its knowledge through the real engine, with tool calls shown", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "kb-owner@ui.test");
  await page.goto("/agents");
  await page.getByRole("link", { name: /Assistant/ }).first().click();
  await page.waitForURL(/\/agents\/[0-9a-f-]{36}$/);
  await page.getByRole("link", { name: "Test in playground" }).click();
  await page.waitForURL(/\/playground$/);
  await expect(page.getByText("Simulated · text only · nothing is dialed")).toBeVisible();
  await page.getByRole("button", { name: "Start conversation" }).click();
  await expect(page.getByText(/AI assistant/).first()).toBeVisible();

  await page.getByLabel("Caller message").fill("Do you deliver?");
  const reply = page.waitForResponse((r) => r.url().includes("/api/playground/") && r.url().endsWith("/messages"), { timeout: 60_000 });
  const t0 = Date.now();
  await page.getByRole("button", { name: "Send" }).click();
  const res = await reply;
  expect(res.status()).toBe(200);
  await expect(page.getByText("Tool call:")).toBeVisible();
  await expect(page.getByText("search_knowledge").first()).toBeVisible();
  // The reply is the knowledge base's answer (the configured development model answers from the tool result).
  await expect(page.locator("div").filter({ hasText: /^AssistantYes, free delivery within 5 km\.$/ }).first()).toBeVisible();
  await expect(page.getByText("OTHER-ORG-SECRET")).toHaveCount(0);

  // Tool calls can be hidden
  await page.getByLabel("Show tool calls").uncheck();
  await expect(page.getByText("Tool call:")).toHaveCount(0);

  await page.getByRole("button", { name: "End", exact: true }).click();
  await expect(page.getByText("You ended the conversation")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start again" })).toBeVisible();
  await ctx.close();
});

test("manager can read but not change knowledge; an agent-role user is denied; another organization cannot open it", async ({ browser }) => {
  const manager = await signIn(browser, "kb-manager@ui.test");
  await manager.page.goto(kbUrl);
  await expect(manager.page.getByText("Yes, free delivery within 5 km.")).toBeVisible();
  await expect(manager.page.getByRole("button", { name: "Add question" })).toHaveCount(0);
  await expect(manager.page.getByText("Upload document")).toHaveCount(0);
  await expect(manager.page.getByRole("button", { name: "Archive" })).toHaveCount(0);
  await manager.ctx.close();

  const agentUser = await signIn(browser, "kb-agent@ui.test");
  await agentUser.page.goto("/knowledge");
  await expect(agentUser.page.getByText("You don't have permission")).toBeVisible();
  await agentUser.ctx.close();

  const other = await signIn(browser, "other-owner@ui.test");
  const res = await other.page.goto(kbUrl);
  expect(res?.status()).toBe(404);
  await other.page.goto("/knowledge");
  await expect(other.page.getByText("Other secret base")).toBeVisible();
  await expect(other.page.getByText("Front desk")).toHaveCount(0);
  await other.ctx.close();
});

test("archiving a knowledge base makes it read-only; unarchiving restores editing", async ({ browser }) => {
  const { ctx, page } = await signIn(browser, "kb-owner@ui.test");
  await page.goto(kbUrl);
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText(/agents do not search it and it is read-only/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Add question" })).toHaveCount(0);
  await page.getByRole("button", { name: "Unarchive" }).click();
  await expect(page.getByRole("button", { name: "Add question" })).toBeVisible();
  await ctx.close();
});
