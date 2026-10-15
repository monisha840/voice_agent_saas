/**
 * Permissions, data scope and route registration are contributed by the Sales module's manifest, not hardcoded in
 * the core. These tests run the platform with Sales registered, unregistered, enabled and disabled per organization.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";

import { buildApp } from "../../app.js";
import { adminDb as db } from "../../db/client.js";
import { leads } from "../../db/schema.js";
import { setTelephonyProvider } from "../../adapters/telephony/index.js";
import { can, assertCan, leadScopeFor, projectScopeFor } from "../../auth/access.js";
import { systemContext, userContext } from "../../auth/context.js";
import {
  PERMISSION_ALIASES,
  allPermissions,
  moduleOfPermission,
  permissionsForRole,
  registerPermissions,
  roleHasPermission,
  unregisterPermissions,
  type Permission,
} from "../../auth/permissions.js";
import { unregisterModule, isModuleRegistered } from "../modules/module-runtime.js";
import { registerSalesModule } from "./index.js";
import { SALES_PERMISSIONS } from "./sales-permissions.js";
import { CapturingProvider, httpClient, relaxRateLimits, type Body } from "../../test/agent-first.js";
import { cleanupTenants, createMember, createTenant, loginCookie, type TestTenant } from "../../test/tenants.js";

const SALES_NAMES = Object.keys(SALES_PERMISSIONS.grants);
const asPermission = (p: string) => p as Permission;

afterEach(() => {
  // Every test leaves the process as the test setup found it: Sales registered, nothing extra.
  unregisterPermissions("demo");
  registerSalesModule();
});

describe("permissions come from the manifest", () => {
  it("the core permission list names no Sales permission, and the Sales module contributes exactly its own", () => {
    unregisterModule("sales");
    const withoutSales = allPermissions();
    for (const name of SALES_NAMES) expect(withoutSales).not.toContain(name);
    expect(withoutSales).toContain("calls:create");
    expect(withoutSales).toContain("agents:manage");

    registerSalesModule();
    const withSales = allPermissions();
    for (const name of SALES_NAMES) {
      expect(withSales).toContain(name);
      expect(moduleOfPermission(name)).toBe("sales");
    }
    expect(moduleOfPermission("calls:read")).toBeNull();
    expect(withSales.length).toBe(withoutSales.length + SALES_NAMES.length);
  });

  it("with Sales unregistered nobody holds a Sales permission, not even an OWNER, and the core matrix is unchanged", () => {
    unregisterModule("sales");
    expect(isModuleRegistered("sales")).toBe(false);
    for (const role of ["OWNER", "ADMIN", "MANAGER", "AGENT"] as const) {
      for (const name of SALES_NAMES) expect(roleHasPermission(role, asPermission(name)), `${role} ${name}`).toBe(false);
    }
    // Core: exactly the product's matrix.
    expect(roleHasPermission("OWNER", "org:manage")).toBe(true);
    expect(roleHasPermission("ADMIN", "org:manage")).toBe(false);
    expect(roleHasPermission("ADMIN", "usage:read")).toBe(true);
    expect(roleHasPermission("MANAGER", "calls:create")).toBe(true);
    expect(roleHasPermission("MANAGER", "agents:read")).toBe(true);
    expect(roleHasPermission("MANAGER", "agents:manage")).toBe(false);
    expect(roleHasPermission("AGENT", "calls:read")).toBe(true);
    expect(roleHasPermission("AGENT", "agents:read")).toBe(false);
    expect(permissionsForRole("AGENT").sort()).toEqual(["calls:create", "calls:read", "org:read"]);
  });

  it("registering Sales again restores the exact role grants (OWNER/ADMIN all, MANAGER and AGENT as listed)", () => {
    unregisterModule("sales");
    registerSalesModule();
    for (const [name, roles] of Object.entries(SALES_PERMISSIONS.grants)) {
      expect(roleHasPermission("OWNER", asPermission(name))).toBe(true);
      expect(roleHasPermission("ADMIN", asPermission(name))).toBe(true);
      expect(roleHasPermission("MANAGER", asPermission(name)), `MANAGER ${name}`).toBe(roles.includes("MANAGER"));
      expect(roleHasPermission("AGENT", asPermission(name)), `AGENT ${name}`).toBe(roles.includes("AGENT"));
    }
    expect(roleHasPermission("AGENT", "leads:create" as Permission)).toBe(false);
    expect(roleHasPermission("MANAGER", "projects:create" as Permission)).toBe(false);
  });

  it("keeps the agent-config aliases working with and without Sales", () => {
    for (const registered of [true, false]) {
      if (!registered) unregisterModule("sales");
      for (const role of ["OWNER", "ADMIN", "MANAGER", "AGENT"] as const) {
        for (const [oldName, newName] of Object.entries(PERMISSION_ALIASES)) {
          expect(roleHasPermission(role, asPermission(oldName)), `${role} ${oldName}`).toBe(roleHasPermission(role, newName));
        }
      }
    }
  });

  it("a module can add its own permissions, but never redefine a core one or take another module's", () => {
    expect(() => registerPermissions({ module: "demo", grants: { "org:read": [] } })).toThrow(/core permission/);
    expect(() => registerPermissions({ module: "demo", grants: { "leads:read": [] } })).toThrow(/already provided by module "sales"/);

    registerPermissions({ module: "demo", grants: { "demo:read": ["AGENT"] } });
    expect(roleHasPermission("AGENT", asPermission("demo:read"))).toBe(true);
    expect(roleHasPermission("MANAGER", asPermission("demo:read"))).toBe(false);
    expect(roleHasPermission("ADMIN", asPermission("demo:read"))).toBe(true);
    expect(roleHasPermission("OWNER", asPermission("demo:read"))).toBe(true);
    unregisterPermissions("demo");
    expect(roleHasPermission("OWNER", asPermission("demo:read"))).toBe(false);
  });
});

describe("module permissions are only usable while the organization has the module", () => {
  const org = "11111111-1111-1111-1111-111111111111";

  it("Sales disabled for the organization: every Sales permission fails, whatever the role", () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER", "AGENT"] as const) {
      const ctx = userContext(org, "u", role, []);
      for (const name of SALES_NAMES) expect(can(ctx, asPermission(name)), `${role} ${name}`).toBe(false);
    }
    expect(() => assertCan(userContext(org, "u", "OWNER", []), asPermission("leads:read"))).toThrow(/Sales module is not enabled/);
  });

  it("Sales enabled: the role decides, exactly as before", () => {
    const enabled = ["sales"];
    expect(can(userContext(org, "u", "MANAGER", enabled), asPermission("leads:create"))).toBe(true);
    expect(can(userContext(org, "u", "AGENT", enabled), asPermission("leads:create"))).toBe(false);
    expect(() => assertCan(userContext(org, "u", "AGENT", enabled), asPermission("leads:create"))).toThrow(/does not allow/);
  });

  it("core permissions never depend on any module", () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER", "AGENT"] as const) {
      expect(can(userContext(org, "u", role, []), "calls:create")).toBe(true);
      expect(can(userContext(org, "u", role, []), "calls:read")).toBe(true);
    }
    expect(can(userContext(org, "u", "OWNER", []), "agents:manage")).toBe(true);
    expect(can(userContext(org, "u", "AGENT", []), "agents:manage")).toBe(false);
  });

  it("a context without a loaded module list is checked by role only; system flows always pass", () => {
    expect(can(userContext(org, "u", "MANAGER"), asPermission("leads:create"))).toBe(true);
    expect(can(systemContext(org, "media-stream"), asPermission("leads:create"))).toBe(true);
    expect(() => assertCan(systemContext(org, "ai-tool"), asPermission("projects:create"))).not.toThrow();
  });
});

describe("data scope is provided by the Sales module, with conservative core defaults", () => {
  let T: TestTenant;
  let agentUserId: string;

  beforeAll(async () => {
    T = await createTenant("ScopeProv");
    const agent = await createMember(T.orgId, "AGENT");
    agentUserId = agent.userId;
    await db
      .insert(leads)
      .values({ organizationId: T.orgId, projectId: T.projectId, name: "Mine", phone: "+919000010066", assignedUserId: agentUserId });
  });
  afterAll(async () => {
    await cleanupTenants();
  });

  it("with Sales: an agent's project scope follows the leads assigned to them; owners see everything", async () => {
    const agentCtx = userContext(T.orgId, agentUserId, "AGENT");
    expect(await projectScopeFor(agentCtx)).toEqual({ kind: "ids", projectIds: [T.projectId] });
    expect(await leadScopeFor(agentCtx)).toEqual({ kind: "assigned", userId: agentUserId });
    expect(await projectScopeFor(userContext(T.orgId, randomUUID(), "OWNER"))).toEqual({ kind: "all" });
    expect(await leadScopeFor(userContext(T.orgId, randomUUID(), "ADMIN"))).toEqual({ kind: "all" });
  });

  it("without Sales: the core defaults apply and no project or lead data is consulted", async () => {
    unregisterModule("sales");
    const agentCtx = userContext(T.orgId, agentUserId, "AGENT");
    expect(await projectScopeFor(agentCtx)).toEqual({ kind: "ids", projectIds: [] });
    expect(await projectScopeFor(userContext(T.orgId, randomUUID(), "MANAGER"))).toEqual({ kind: "ids", projectIds: [] });
    expect(await projectScopeFor(userContext(T.orgId, randomUUID(), "OWNER"))).toEqual({ kind: "all" });
    // Calls: owners/admins all, managers only leadless calls, agents only their own calls.
    expect(await leadScopeFor(userContext(T.orgId, randomUUID(), "OWNER"))).toEqual({ kind: "all" });
    expect(await leadScopeFor(userContext(T.orgId, randomUUID(), "MANAGER"))).toEqual({ kind: "projects", projectIds: [] });
    expect(await leadScopeFor(agentCtx)).toEqual({ kind: "assigned", userId: agentUserId });
    // System flows are never narrowed.
    expect(await leadScopeFor(systemContext(T.orgId, "media-stream"))).toEqual({ kind: "all" });
    expect(await projectScopeFor(systemContext(T.orgId, "reaper"))).toEqual({ kind: "all" });
  });
});

describe("route registration is module-driven: the bare core (no modules)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let http: ReturnType<typeof httpClient>;
  let A: TestTenant;
  let owner: string;
  let agentRole: string;

  beforeAll(async () => {
    relaxRateLimits();
    // Never dial or simulate anything: the stub provider only records.
    setTelephonyProvider(new CapturingProvider("mock"));
    A = await createTenant("BareCore");
    app = await buildApp({ modules: [] });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    http = httpClient(baseUrl);
    owner = await loginCookie(baseUrl, A.email);
    agentRole = await loginCookie(baseUrl, (await createMember(A.orgId, "AGENT")).email);
  });
  // The file-level afterEach puts Sales back after every test; this block must keep running without it.
  beforeEach(() => unregisterModule("sales"));
  afterAll(async () => {
    await app.close();
    setTelephonyProvider(null);
    registerSalesModule();
    await cleanupTenants();
  });

  it("serves no Sales URL at all, and Sales is not registered", async () => {
    expect(isModuleRegistered("sales")).toBe(false);
    for (const path of ["/api/leads", "/api/projects", "/api/site-visits", `/api/leads/${A.leadId}`, `/api/projects/${A.projectId}`]) {
      expect((await http(owner, "GET", path)).status, path).toBe(404);
    }
    expect((await http(owner, "POST", `/api/leads/${A.leadId}/call`)).status).toBe(404);
  });

  it("the Voice AI core works completely without it", async () => {
    for (const path of ["/api/organization", "/api/organization/modules", "/api/agents", "/api/agent-options", "/api/tools", "/api/calls", "/api/usage/summary", "/api/users", "/api/audit-logs", "/api/auth/me"]) {
      expect((await http(owner, "GET", path)).status, path).toBe(200);
    }
    expect((await http(agentRole, "GET", "/api/agent-options")).status).toBe(200);
    expect((await http(agentRole, "GET", "/api/agents")).status).toBe(403); // roles are still enforced
  });

  it("places a leadless call and reads it back, with no lead, project or site visit involved", async () => {
    const placed = await http(owner, "POST", "/api/calls", { agentId: A.agentId, callType: "test" });
    expect(placed.status).toBe(202);
    const detail = await http(owner, "GET", `/api/calls/${placed.body.data.callId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data).toMatchObject({ leadId: null, callType: "test", agent: { id: A.agentId } });
    // An AGENT-role user can place calls too, and sees the call they started (the core scope default).
    const mine = await http(agentRole, "POST", "/api/calls", { agentId: A.agentId, callType: "test" });
    expect(mine.status).toBe(202);
    const list = await http(agentRole, "GET", "/api/calls");
    expect(list.body.data.map((c: { id: string }) => c.id)).toEqual([mine.body.data.callId]);
  });

  it("Sales tools are not offered", async () => {
    const tools = (await http(owner, "GET", "/api/tools")).body.data as Array<{ name: string }>;
    expect(tools.map((t) => t.name)).toEqual(["end_call"]);
  });
});

describe("route registration is module-driven: Sales registered", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let http: ReturnType<typeof httpClient>;
  let on: TestTenant;
  let off: TestTenant;
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    relaxRateLimits();
    on = await createTenant("SalesRoutesOn");
    off = await createTenant("SalesRoutesOff", { modules: [] });
    app = await buildApp();
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    http = httpClient(baseUrl);
    cookies.onOwner = await loginCookie(baseUrl, on.email);
    cookies.offOwner = await loginCookie(baseUrl, off.email);
    cookies.onManager = await loginCookie(baseUrl, (await createMember(on.orgId, "MANAGER")).email);
    cookies.onAgent = await loginCookie(baseUrl, (await createMember(on.orgId, "AGENT")).email);
  });
  afterAll(async () => {
    await app.close();
    await cleanupTenants();
  });

  it("registers the Sales routes from its manifest", () => {
    expect(isModuleRegistered("sales")).toBe(true);
  });

  it("serves them to organizations with Sales enabled", async () => {
    for (const path of ["/api/leads", "/api/projects", "/api/site-visits", `/api/leads/${on.leadId}`, `/api/projects/${on.projectId}`]) {
      expect((await http(cookies.onOwner, "GET", path)).status, path).toBe(200);
    }
  });

  it("refuses organizations with Sales disabled, for every Sales route and every role", async () => {
    for (const path of ["/api/leads", "/api/projects", "/api/site-visits", `/api/leads/${off.leadId}`, `/api/projects/${off.projectId}`]) {
      const res = await http(cookies.offOwner, "GET", path);
      expect(res.status, path).toBe(403);
      expect((res.body as Body).error).toMatch(/Sales module is not enabled/);
    }
    expect((await http(cookies.offOwner, "POST", "/api/leads", { name: "x" })).status).toBe(403);
    expect((await http(cookies.offOwner, "POST", `/api/leads/${off.leadId}/call`)).status).toBe(403);
  });

  it("still enforces roles inside the module", async () => {
    const create = { name: "Role Test", location: "Somewhere" };
    expect((await http(cookies.onManager, "POST", "/api/projects", create)).status).toBe(403); // projects:create is admin-only
    expect((await http(cookies.onAgent, "POST", "/api/leads", { name: "n", phone: "+919000010055", projectId: on.projectId })).status).toBe(403);
    expect((await http(cookies.onAgent, "GET", "/api/projects")).status).toBe(200); // projects:read is granted to agents
    expect((await http(cookies.onOwner, "POST", "/api/projects", create)).status).toBe(201);
  });

  it("keeps tenants apart: the other organization's lead is not visible through the module's routes", async () => {
    expect((await http(cookies.onOwner, "GET", `/api/leads/${off.leadId}`)).status).toBe(404);
    const list = (await http(cookies.onOwner, "GET", "/api/leads")).body.data as Array<{ id: string }>;
    expect(list.map((l) => l.id)).not.toContain(off.leadId);
  });

  it("a Sales permission is unusable at the service layer once the module is disabled, even for the OWNER", async () => {
    const ctx = userContext(off.orgId, off.userId, "OWNER", []);
    expect(can(ctx, asPermission("leads:read"))).toBe(false);
    expect(can(userContext(on.orgId, on.userId, "OWNER", ["sales"]), asPermission("leads:read"))).toBe(true);
  });
});
