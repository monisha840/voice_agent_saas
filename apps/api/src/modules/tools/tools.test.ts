import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildApp } from "../../app.js";
import { cleanupTenants, createTenant, loginCookie } from "../../test/tenants.js";

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let cookieOn: string;
let cookieOff: string;

type Tool = { name: string; description: string; module: string; requires: string[]; available: boolean };

async function getTools(cookie: string) {
  const res = await fetch(`${baseUrl}/api/tools`, { headers: { cookie } });
  return { status: res.status, body: (await res.json()) as { data?: Tool[] } };
}

beforeAll(async () => {
  const on = await createTenant("TLON");
  const off = await createTenant("TLOFF", { modules: [] });
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  cookieOn = await loginCookie(baseUrl, on.email);
  cookieOff = await loginCookie(baseUrl, off.email);
});

afterAll(async () => {
  await app.close();
  await cleanupTenants();
});

describe("GET /api/tools", () => {
  it("requires login", async () => {
    const res = await fetch(`${baseUrl}/api/tools`);
    expect(res.status).toBe(401);
  });

  it("lists every tool as available when the sales module is on", async () => {
    const { status, body } = await getTools(cookieOn);
    expect(status).toBe(200);
    expect(body.data!.length).toBe(9);
    expect(body.data!.every((t) => t.available)).toBe(true);
    expect(body.data!.find((t) => t.name === "book_site_visit")).toMatchObject({ module: "sales", requires: ["lead", "project"] });
  });

  it("marks sales tools unavailable (core stays available) when the module is off", async () => {
    const { body } = await getTools(cookieOff);
    for (const t of body.data!) expect(t.available).toBe(t.module === "core");
    expect(body.data!.find((t) => t.name === "end_call")!.available).toBe(true);
  });
});
