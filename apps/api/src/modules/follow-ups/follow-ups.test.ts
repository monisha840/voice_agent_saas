/**
 * The follow-up note the agent leaves for the team: the request_follow_up tool, the service rules and who can see what.
 * Real database, real services.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { leads } from "../../db/schema.js";
import { callsRepository } from "../../db/repositories/calls.repository.js";
import { executeTool } from "../../ai-tools/index.js";
import type { ToolExecutionContext } from "../../ai-tools/types.js";
import { userContext, type RequestContext } from "../../auth/context.js";
import { cleanupTenants, createMember, createTenant, type TestTenant } from "../../test/tenants.js";
import { followUpsService } from "./follow-ups.service.js";
import { leadsService } from "../leads/leads.service.js";

let A: TestTenant;
let B: TestTenant;
let owner: RequestContext;
let ownerB: RequestContext;
let agentUser: RequestContext;
let toolCtx: ToolExecutionContext;
let noLeadToolCtx: ToolExecutionContext;

beforeAll(async () => {
  A = await createTenant("FUA");
  B = await createTenant("FUB");
  owner = userContext(A.orgId, A.userId, "OWNER");
  ownerB = userContext(B.orgId, B.userId, "OWNER");
  const agent = await createMember(A.orgId, "AGENT");
  agentUser = userContext(A.orgId, agent.userId, "AGENT");
  toolCtx = { organizationId: A.orgId, callId: A.callId, agentId: A.agentId, callType: "outbound", subject: { leadId: A.leadId, projectId: A.projectId } };
  const call = await callsRepository.create({ organizationId: A.orgId, status: "in_progress", callType: "test", agentId: A.agentId });
  noLeadToolCtx = { organizationId: A.orgId, callId: call.id, agentId: A.agentId, callType: "test", subject: { projectId: A.projectId } };
});

afterAll(async () => {
  await cleanupTenants();
});

describe("request_follow_up", () => {
  it("records a human request on the lead, for the team to see", async () => {
    const r = await executeTool("request_follow_up", { reason: "human_requested", note: "Wants to talk to a manager" }, toolCtx);
    expect(r).toEqual({ recorded: true, kind: "human_requested" });
    const list = await followUpsService.listForLead(owner, { leadId: A.leadId });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "human_requested", status: "open", note: "Wants to talk to a manager", callId: A.callId, leadId: A.leadId });
    // The lead's own status is not touched by a human request.
    expect((await leadsService.getLeadDetail(owner, { leadId: A.leadId }))!.status).toBe("NEW");
  });

  it("records the same kind once per call: a repeat updates the note instead of adding a row", async () => {
    await executeTool("request_follow_up", { reason: "human_requested", note: "Second time, wants someone senior" }, toolCtx);
    const list = await followUpsService.listForLead(owner, { leadId: A.leadId });
    expect(list.filter((f) => f.kind === "human_requested")).toHaveLength(1);
    expect(list.find((f) => f.kind === "human_requested")!.note).toBe("Second time, wants someone senior");
  });

  it("keeps a callback time the lead named, and the words when the model could not give a date", async () => {
    await executeTool("request_follow_up", { reason: "callback", callbackTime: "2031-05-06T17:00:00+05:30", note: "Busy now" }, toolCtx);
    const cb = (await followUpsService.listForLead(owner, { leadId: A.leadId })).find((f) => f.kind === "callback")!;
    expect(cb.dueAt?.toISOString()).toBe("2031-05-06T11:30:00.000Z");

    await executeTool("request_follow_up", { reason: "info_requested", callbackTime: "after the 20th", note: "Wants the brochure" }, toolCtx);
    const info = (await followUpsService.listForLead(owner, { leadId: A.leadId })).find((f) => f.kind === "info_requested")!;
    expect(info.dueAt).toBeNull();
    expect(info.note).toBe("Wants the brochure. Time asked: after the 20th");
  });

  it("a callback time that is already past is not trusted: the words go to the note, no time is stored", async () => {
    const r = await executeTool("request_follow_up", { reason: "info_requested", callbackTime: "2020-01-01T10:00:00+05:30", note: "Send the layout" }, noLeadToolCtx);
    expect(r).toEqual({ recorded: true, kind: "info_requested" });
    const row = (await followUpsService.listOpen(owner)).find((f) => f.callId === noLeadToolCtx.callId && f.kind === "info_requested")!;
    expect(row.dueAt).toBeNull();
    expect(row.note).toBe("Send the layout. Time asked: 2020-01-01T10:00:00+05:30");
  });

  it("do_not_call records the request and marks the lead DNC", async () => {
    await executeTool("request_follow_up", { reason: "do_not_call", note: "Do not call again" }, toolCtx);
    expect((await db.select().from(leads).where(eq(leads.id, A.leadId)))[0].status).toBe("DNC");
  });

  it("an unknown reason is refused and records nothing", async () => {
    const before = (await followUpsService.listForLead(owner, { leadId: A.leadId })).length;
    const r = await executeTool("request_follow_up", { reason: "send_flowers" }, toolCtx);
    expect(r).toMatchObject({ error: expect.stringContaining("reason must be one of") });
    expect(await followUpsService.listForLead(owner, { leadId: A.leadId })).toHaveLength(before);
  });

  it("works on a call with a project but no lead (an unknown caller): recorded without a lead, visible to owners only", async () => {
    await executeTool("request_follow_up", { reason: "human_requested", note: "Unknown caller wants a person" }, noLeadToolCtx);
    const open = await followUpsService.listOpen(owner);
    const mine = open.find((f) => f.callId === noLeadToolCtx.callId && f.kind === "human_requested")!;
    expect(mine).toMatchObject({ leadId: null, kind: "human_requested" });
    expect((await followUpsService.listOpen(agentUser)).some((f) => f.callId === noLeadToolCtx.callId)).toBe(false);
  });
});

describe("questions the agent could not answer, per project", () => {
  it("lists the information requests of the project's leads, newest first", async () => {
    const rows = await followUpsService.unansweredForProject(owner, { projectId: A.projectId });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => typeof r.note === "string" || r.note === null)).toBe(true);
    expect(rows.some((r) => r.note?.startsWith("Wants the brochure"))).toBe(true);
    expect(rows[0].leadName).toBe("FUA Lead");
  });

  it("is limited to information requests (not callbacks) and to this organization", async () => {
    const rows = await followUpsService.unansweredForProject(owner, { projectId: A.projectId });
    expect(rows.every((r) => !r.note?.includes("Busy now"))).toBe(true);
    await expect(followUpsService.unansweredForProject(ownerB, { projectId: A.projectId })).rejects.toThrow(/not found/i);
  });
});

describe("who sees and clears follow-ups", () => {
  it("the queue lists open follow-ups with the lead's name, oldest first", async () => {
    const open = await followUpsService.listOpen(owner);
    expect(open.length).toBeGreaterThanOrEqual(4);
    const times = open.map((f) => f.createdAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(open.find((f) => f.leadId === A.leadId)!.leadName).toBe("FUA Lead");
  });

  it("another organization sees none of it, and cannot clear it", async () => {
    expect(await followUpsService.listOpen(ownerB)).toEqual([]);
    await expect(followUpsService.listForLead(ownerB, { leadId: A.leadId })).rejects.toThrow(/not found/i);
    const anyId = (await followUpsService.listOpen(owner))[0].id;
    expect(await followUpsService.resolve(ownerB, { id: anyId })).toBeNull();
  });

  it("an agent who is not assigned the lead does not see it and cannot clear it", async () => {
    expect(await followUpsService.listOpen(agentUser)).toEqual([]);
    const id = (await followUpsService.listForLead(owner, { leadId: A.leadId }))[0].id;
    expect(await followUpsService.resolve(agentUser, { id })).toBeNull();
  });

  it("marking done removes it from the queue and keeps it in the lead's history", async () => {
    const id = (await followUpsService.listOpen(owner)).find((f) => f.leadId === A.leadId)!.id;
    const done = await followUpsService.resolve(owner, { id });
    expect(done).toMatchObject({ status: "done" });
    expect(done!.resolvedAt).toBeInstanceOf(Date);
    expect((await followUpsService.listOpen(owner)).some((f) => f.id === id)).toBe(false);
    expect((await followUpsService.listForLead(owner, { leadId: A.leadId })).some((f) => f.id === id && f.status === "done")).toBe(true);
    // idempotent
    expect(await followUpsService.resolve(owner, { id })).toMatchObject({ status: "done" });
  });
});
