import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";
process.env.TELEPHONY_PROVIDER = "mock";

import { buildApp } from "../../app.js";
import { adminDb as db } from "../../db/client.js";
import { auditLogs, agentConfigs } from "../../db/schema.js";
import { userContext } from "../../auth/context.js";
import { projectMembersRepository } from "../../test/repos.js";
import { agentConfigService, DEFAULT_AGENT_CONFIG } from "./agent-config.service.js";
import { buildSystemPrompt } from "../ai-agent/persona.js";
import { cleanupTenants, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let baseUrl: string;
let A: TestTenant;
let B: TestTenant;
let cookies: Record<string, string> = {};
let managerScoped: string;
let managerUnscoped: string;

async function http(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  // Success bodies are wrapped as { data } like every other route; tests read the payload directly.
  return { status: res.status, body: json && typeof json === "object" && "data" in json ? json.data : json };
}

beforeAll(async () => {
  A = await createTenant("A");
  B = await createTenant("B");
  const admin = await createMember(A.orgId, "ADMIN");
  const agent = await createMember(A.orgId, "AGENT");
  const m1 = await createMember(A.orgId, "MANAGER", "mgr-scoped");
  const m2 = await createMember(A.orgId, "MANAGER", "mgr-unscoped");
  await projectMembersRepository.replaceForProject({ organizationId: A.orgId, projectId: A.projectId, userIds: [m1.userId] });
  app = await buildApp();
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  baseUrl = `http://127.0.0.1:${addr.port}`;
  cookies = {
    ownerA: await loginCookie(baseUrl, A.email),
    ownerB: await loginCookie(baseUrl, B.email),
    admin: await loginCookie(baseUrl, admin.email),
    agent: await loginCookie(baseUrl, agent.email),
  };
  managerScoped = await loginCookie(baseUrl, m1.email);
  managerUnscoped = await loginCookie(baseUrl, m2.email);
});

afterAll(async () => {
  await app.close();
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, [A.orgId, B.orgId]));
  await db.delete(agentConfigs).where(inArray(agentConfigs.organizationId, [A.orgId, B.orgId]));
  await cleanupTenants();
});

describe("resolve precedence", () => {
  it("falls back to the built-in default, equal to today's behavior", async () => {
    const ctx = userContext(A.orgId, A.userId, "OWNER");
    const r = await agentConfigService.resolve(ctx, { projectId: A.projectId });
    expect(r.source).toBe("default");
    expect(r.config).toEqual(DEFAULT_AGENT_CONFIG);
    expect(r.config.agentName).toBe("Priya");
    expect(r.config.companyName).toBe("Green Valley Developers");
    // the default config must not change the prompt at all
    const params = { leadName: "X", projectName: "Y" };
    expect(buildSystemPrompt(params, r.config)).toBe(buildSystemPrompt(params));
  });

  it("project override > organization default > built-in default", async () => {
    const ctx = userContext(A.orgId, A.userId, "OWNER");
    await agentConfigService.upsert(ctx, { agentName: "OrgBot", tone: "friendly" });
    let r = await agentConfigService.resolve(ctx, { projectId: A.projectId });
    expect(r.source).toBe("organization");
    expect(r.config.agentName).toBe("OrgBot");
    expect(r.config.companyName).toBe("Green Valley Developers"); // unset -> built-in

    await agentConfigService.upsert(ctx, { projectId: A.projectId, agentName: "ProjBot" });
    r = await agentConfigService.resolve(ctx, { projectId: A.projectId });
    expect(r.source).toBe("project");
    expect(r.config.agentName).toBe("ProjBot");

    await agentConfigService.reset(ctx, { projectId: A.projectId });
    r = await agentConfigService.resolve(ctx, { projectId: A.projectId });
    expect(r.config.agentName).toBe("OrgBot");
    await agentConfigService.reset(ctx, {});
    expect((await agentConfigService.resolve(ctx, { projectId: A.projectId })).source).toBe("default");
  });

  it("a corrupt stored row degrades to defaults instead of failing", async () => {
    const ctx = userContext(A.orgId, A.userId, "OWNER");
    await db.insert(agentConfigs).values({
      organizationId: A.orgId,
      agentName: "Corrupt",
      language: "xx-XX",
      tone: "angry",
      callBehaviour: "nonsense",
      allowedTools: ["rm_rf", 5],
      qualificationQuestions: "x",
      siteVisitBehaviour: { offerSlots: 99 },
    });
    const { config } = await agentConfigService.resolve(ctx, { projectId: A.projectId });
    expect(config.agentName).toBe("Corrupt");
    expect(config.language).toBe("en-IN");
    expect(config.tone).toBe("professional");
    expect(config.callBehaviour).toEqual({ maxResponseSentences: 3, endCallWhenDone: true });
    expect(config.allowedTools).toEqual([]);
    expect(config.siteVisitBehaviour.offerSlots).toBe(3);
    expect(buildSystemPrompt({ leadName: "L", projectName: "P" }, config)).toMatch(/AI assistant/);
    await agentConfigService.reset(ctx, {});
  });
});

describe("validation (HTTP 400)", () => {
  const bad: Array<[string, Record<string, unknown>]> = [
    ["unsupported language", { language: "fr-FR" }],
    // Only English and Tamil are supported. These were selectable before but were never validated, so they must now
    // be refused rather than quietly accepted and advertised.
    ["Hindi, which this product does not support", { language: "hi-IN" }],
    ["Telugu, which this product does not support", { language: "te-IN" }],
    ["unknown tool", { allowedTools: ["get_project_price", "drop_tables"] }],
    ["4 qualification questions", { qualificationQuestions: ["a", "b", "c", "d"] }],
    ["disclosure wording that hides the AI", { disclosureText: "Hello, this is Priya from Green Valley." }],
    ["unknown flag to disable disclosure", { disclosureEnabled: false }],
    ["bad tone", { tone: "rude" }],
    ["too many sentences", { callBehaviour: { maxResponseSentences: 9 } }],
    ["offerSlots 4", { siteVisitBehaviour: { offerSlots: 4 } }],
    ["empty agent name", { agentName: "" }],
    ["extra instructions too long", { extraInstructions: "x".repeat(1501) }],
    ["non-uuid projectId", { projectId: "nope" }],
  ];
  it.each(bad)("rejects %s", async (_n, body) => {
    const res = await http(cookies.ownerA, "PUT", "/api/agent-config", body);
    expect(res.status).toBe(400);
  });

  it("accepts a compliant custom disclosure and persists the config", async () => {
    const res = await http(cookies.ownerA, "PUT", "/api/agent-config", {
      agentName: "Asha",
      language: "ta-IN",
      disclosureText: "Vanakkam, naan Asha, oru virtual assistant.",
      qualificationQuestions: ["Eppo vaanga plan panreenga?"],
      allowedTools: ["get_project_price"],
      callBehaviour: { maxResponseSentences: 2 },
    });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("organization");
    expect(res.body.editable).toBe(true);
    expect(res.body.config.callBehaviour).toEqual({ maxResponseSentences: 2, endCallWhenDone: true });
    const get = await http(cookies.ownerA, "GET", "/api/agent-config");
    expect(get.body.config.agentName).toBe("Asha");
    expect(get.body.config.allowedTools).toEqual(["get_project_price"]);
    await http(cookies.ownerA, "DELETE", "/api/agent-config");
  });
});

describe("roles", () => {
  it("OWNER and ADMIN manage; MANAGER and AGENT cannot write", async () => {
    expect((await http(cookies.admin, "PUT", "/api/agent-config", { agentName: "AdminSet" })).status).toBe(200);
    expect((await http(cookies.ownerA, "PUT", "/api/agent-config", { agentName: "OwnerSet" })).status).toBe(200);
    expect((await http(managerScoped, "PUT", "/api/agent-config", { agentName: "No" })).status).toBe(403);
    expect((await http(cookies.agent, "PUT", "/api/agent-config", { agentName: "No" })).status).toBe(403);
    expect((await http(managerScoped, "DELETE", "/api/agent-config")).status).toBe(403);
    expect((await http(cookies.agent, "DELETE", "/api/agent-config")).status).toBe(403);
  });

  it("MANAGER reads read-only, only for scoped projects; AGENT cannot read", async () => {
    const own = await http(managerScoped, "GET", `/api/agent-config?projectId=${A.projectId}`);
    expect(own.status).toBe(200);
    expect(own.body.editable).toBe(false);
    expect((await http(managerUnscoped, "GET", `/api/agent-config?projectId=${A.projectId}`)).status).toBe(404);
    expect((await http(cookies.agent, "GET", "/api/agent-config")).status).toBe(403);
    expect((await http(cookies.admin, "GET", "/api/agent-config")).body.editable).toBe(true);
    await http(cookies.ownerA, "DELETE", "/api/agent-config");
  });
});

describe("tenant isolation", () => {
  it("org A cannot read, write or delete using org B's project; configs never leak", async () => {
    await http(cookies.ownerB, "PUT", "/api/agent-config", { agentName: "BSecret" });
    await http(cookies.ownerB, "PUT", "/api/agent-config", { projectId: B.projectId, agentName: "BProj" });

    expect((await http(cookies.ownerA, "GET", `/api/agent-config?projectId=${B.projectId}`)).status).toBe(404);
    expect((await http(cookies.ownerA, "PUT", "/api/agent-config", { projectId: B.projectId, agentName: "Hijack" })).status).toBe(404);
    expect((await http(cookies.ownerA, "DELETE", `/api/agent-config?projectId=${B.projectId}`)).status).toBe(404);

    const aView = await http(cookies.ownerA, "GET", "/api/agent-config");
    expect(aView.body.config.agentName).not.toBe("BSecret");
    // A's own default delete never touches B's row
    await http(cookies.ownerA, "DELETE", "/api/agent-config");
    const bView = await http(cookies.ownerB, "GET", `/api/agent-config?projectId=${B.projectId}`);
    expect(bView.body.config.agentName).toBe("BProj");
    expect(bView.body.source).toBe("project");

    const ctxA = userContext(A.orgId, A.userId, "OWNER");
    expect((await agentConfigService.resolve(ctxA, { projectId: B.projectId })).config.agentName).toBe("Priya");
  });
});

describe("audit", () => {
  it("records updated (field names only) and reset", async () => {
    const secret = "TOP-SECRET-PROMPT-TEXT";
    await http(cookies.ownerA, "PUT", "/api/agent-config", { projectId: A.projectId, extraInstructions: secret, tone: "formal" });
    await http(cookies.ownerA, "DELETE", `/api/agent-config?projectId=${A.projectId}`);
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.organizationId, A.orgId));
    const updated = rows.find((r) => r.action === "agent_config.updated" && (r.metadata as { changed: string[] }).changed.includes("extraInstructions"));
    expect(updated).toBeTruthy();
    expect((updated!.metadata as { changed: string[] }).changed.sort()).toEqual(["extraInstructions", "tone"]);
    expect(JSON.stringify(rows.map((r) => r.metadata))).not.toContain(secret);
    expect(rows.some((r) => r.action === "agent_config.reset")).toBe(true);
  });
});
