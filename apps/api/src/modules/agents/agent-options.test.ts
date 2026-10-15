import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import { buildApp } from "../../app.js";
import { adminDb as db } from "../../db/client.js";
import { agents, calls, leads } from "../../db/schema.js";
import type { OrgRole } from "../../auth/context.js";
import { cleanupTenants, createDefaultAgent, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = { data?: any; error?: string };

const SECRET_PROMPT = "TOP-SECRET-SYSTEM-PROMPT-DO-NOT-LEAK";
const ROLES: OrgRole[] = ["OWNER", "ADMIN", "MANAGER", "AGENT"];

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl: string;
let A: TestTenant;
let B: TestTenant;
let secondAgentId: string;
let archivedAgentId: string;
let agentRoleUserId: string;
let assignedCallId: string;
const cookies: Record<string, string> = {};
let cookieB: string;

async function get(cookie: string, path: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: { cookie } });
  return { status: res.status, text: await res.text() };
}
const json = (t: string) => JSON.parse(t) as Body;

beforeAll(async () => {
  A = await createTenant("AgOptA");
  B = await createTenant("AgOptB");

  // A second active agent with sensitive configuration, and an archived one.
  const second = await createDefaultAgent(A.orgId, {
    name: "Support line",
    personaName: "Sam",
    isDefault: false,
    promptTemplateKey: "generic",
    systemPrompt: SECRET_PROMPT,
    extraInstructions: SECRET_PROMPT,
    enabledTools: ["end_call"],
  });
  secondAgentId = second.id;
  const archived = await createDefaultAgent(A.orgId, { name: "Old agent", personaName: "Olga", isDefault: false, status: "archived" });
  archivedAgentId = archived.id;

  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;

  cookies.OWNER = await loginCookie(baseUrl, A.email);
  for (const role of ROLES.filter((r) => r !== "OWNER")) {
    const m = await createMember(A.orgId, role);
    if (role === "AGENT") agentRoleUserId = m.userId;
    cookies[role] = await loginCookie(baseUrl, m.email);
  }
  cookieB = await loginCookie(baseUrl, B.email);

  // A call on a lead assigned to the AGENT-role user, handled by the second agent: the agent role can see it.
  const [lead] = await db
    .insert(leads)
    .values({ organizationId: A.orgId, projectId: A.projectId, name: "Assigned", phone: "+919000010077", assignedUserId: agentRoleUserId })
    .returning();
  const [call] = await db
    .insert(calls)
    .values({ organizationId: A.orgId, agentId: secondAgentId, leadId: lead.id, status: "completed" })
    .returning();
  assignedCallId = call.id;
});

afterAll(async () => {
  await app.close();
  await db.delete(calls).where(eq(calls.organizationId, A.orgId));
  await cleanupTenants();
});

describe("GET /api/agent-options (selection list for every role that can place calls)", () => {
  for (const role of ROLES) {
    it(`${role} gets the organization's active agents, and only id, name, personaName and status`, async () => {
      const res = await get(cookies[role], "/api/agent-options");
      expect(res.status).toBe(200);
      const data = json(res.text).data as Array<Record<string, unknown>>;
      expect(data.map((a) => a.id).sort()).toEqual([A.agentId, secondAgentId].sort());
      for (const a of data) expect(Object.keys(a).sort()).toEqual(["id", "name", "personaName", "status"]);
      expect(data.find((a) => a.id === secondAgentId)).toEqual({ id: secondAgentId, name: "Support line", personaName: "Sam", status: "active" });
    });
  }

  it("lists the default agent first, without exposing a default flag", async () => {
    const data = json((await get(cookies.AGENT, "/api/agent-options")).text).data;
    expect(data[0].id).toBe(A.agentId);
    expect(data[0]).not.toHaveProperty("isDefault");
  });

  it("never returns archived agents", async () => {
    const res = await get(cookies.AGENT, "/api/agent-options");
    expect(res.text).not.toContain(archivedAgentId);
  });

  it("never leaks prompts, tools, knowledge or other configuration", async () => {
    for (const role of ROLES) {
      const text = (await get(cookies[role], "/api/agent-options")).text;
      for (const forbidden of [SECRET_PROMPT, "systemPrompt", "enabledTools", "knowledge", "moduleConfig", "behaviour", "language", "greeting", "disclosureText", "promptTemplateKey", "voice", "extraInstructions"]) {
        expect(text, `${role} response must not contain ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("is tenant-isolated: each organization sees only its own agents", async () => {
    const b = json((await get(cookieB, "/api/agent-options")).text).data as Array<{ id: string }>;
    expect(b.map((x) => x.id)).toEqual([B.agentId]);
    const aText = (await get(cookies.AGENT, "/api/agent-options")).text;
    expect(aText).not.toContain(B.agentId);
  });

  it("requires login", async () => {
    expect((await get("", "/api/agent-options")).status).toBe(401);
  });
});

describe("the selection list grants no more than selection", () => {
  it("AGENT and MANAGER-below roles still cannot read the full agent configuration or manage agents", async () => {
    expect((await get(cookies.AGENT, "/api/agents")).status).toBe(403);
    expect((await get(cookies.AGENT, `/api/agents/${secondAgentId}`)).status).toBe(403);
    const patch = await fetch(`${baseUrl}/api/agents/${secondAgentId}`, {
      method: "PATCH",
      headers: { cookie: cookies.AGENT, "content-type": "application/json" },
      body: JSON.stringify({ name: "hacked" }),
    });
    expect(patch.status).toBe(403);
    expect((await get(cookies.AGENT, `/api/agents/${secondAgentId}/phone-numbers`)).status).toBe(403);
    const [row] = await db.select().from(agents).where(eq(agents.id, secondAgentId));
    expect(row.name).toBe("Support line");
  });

  it("MANAGER can read agents but not manage them; the selection list is unchanged for them", async () => {
    expect((await get(cookies.MANAGER, "/api/agents")).status).toBe(200);
    const patch = await fetch(`${baseUrl}/api/agents/${secondAgentId}`, {
      method: "PATCH",
      headers: { cookie: cookies.MANAGER, "content-type": "application/json" },
      body: JSON.stringify({ name: "nope" }),
    });
    expect(patch.status).toBe(403);
  });
});

describe("call detail shows the agent without agents:read", () => {
  it("an AGENT-role user sees the agent's id, name and persona on a call they may view", async () => {
    const res = await get(cookies.AGENT, `/api/calls/${assignedCallId}`);
    expect(res.status).toBe(200);
    const call = json(res.text).data;
    expect(call.agent).toEqual({ id: secondAgentId, name: "Support line", personaName: "Sam" });
    // Only the display fields: no configuration rides along.
    expect(res.text).not.toContain(SECRET_PROMPT);
  });

  it("a call in another organization is still invisible", async () => {
    expect((await get(cookieB, `/api/calls/${assignedCallId}`)).status).toBe(404);
  });
});
