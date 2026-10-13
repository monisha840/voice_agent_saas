/**
 * The summary's recommended lead status is the model's opinion. VISIT_BOOKED may only be applied when a site visit
 * was really booked during the call; otherwise a lead that was only offered a slot must not be marked as booked.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "../../db/client.js";
import { calls, projects, siteVisits } from "../../db/schema.js";
import { executeTool } from "../../ai-tools/index.js";
import { callRuntime } from "../calls/call-runtime.js";
import { siteVisitsService } from "../site-visits/site-visits.service.js";
import { ConversationSession } from "../ai-agent/conversation.js";
import type { ChatResult, ILanguageModel } from "../../adapters/ai/llm.interface.js";
import { systemContext } from "../../auth/context.js";
import { callsRepository } from "../../db/repositories/calls.repository.js";
import { leadsRepository } from "../../db/repositories/leads.repository.js";
import { cleanupTenants, createTenant, type TestTenant } from "../../test/tenants.js";
import { salesCallHooks } from "./sales-call-hooks.js";

let A: TestTenant;
let ctx: ReturnType<typeof systemContext>;
let n = 0;

beforeAll(async () => {
  A = await createTenant("LS_A");
  ctx = systemContext(A.orgId, "test");
});

afterAll(async () => {
  await cleanupTenants();
});

async function freshLead() {
  return leadsRepository.create({
    organizationId: A.orgId,
    projectId: A.projectId,
    name: `Status Lead ${++n}`,
    phone: `+9190001${String(20000 + n)}`,
  });
}

async function callFor(leadId: string, startedAt: Date) {
  const call = await callsRepository.create({ organizationId: A.orgId, status: "completed", callType: "outbound", agentId: A.agentId, leadId });
  await db.update(calls).set({ startedAt }).where(eq(calls.id, call.id));
  return (await callsRepository.findByIdAnyOrg({ id: call.id }))!;
}

const statusOf = async (leadId: string) => (await leadsRepository.findById({ organizationId: A.orgId, id: leadId }))!.status;
const finalize = (call: Awaited<ReturnType<typeof callFor>>, status: string) =>
  salesCallHooks.onFinalized!(ctx, call, { summary: "s", interestLevel: "high", recommendedLeadStatus: status });

describe("VISIT_BOOKED needs a real booking", () => {
  it("a visit that was only offered becomes INTERESTED, not VISIT_BOOKED", async () => {
    const lead = await freshLead();
    await finalize(await callFor(lead.id, new Date()), "VISIT_BOOKED");
    expect(await statusOf(lead.id)).toBe("INTERESTED");
  });

  it("a visit booked during the call keeps VISIT_BOOKED", async () => {
    const lead = await freshLead();
    const call = await callFor(lead.id, new Date(Date.now() - 5_000));
    await db.insert(siteVisits).values({ organizationId: A.orgId, leadId: lead.id, projectId: A.projectId, scheduledAt: new Date(Date.now() + 86_400_000) });
    await finalize(call, "VISIT_BOOKED");
    expect(await statusOf(lead.id)).toBe("VISIT_BOOKED");
  });

  it("an earlier booking still counts, so the lead stays VISIT_BOOKED after a later call", async () => {
    const lead = await freshLead();
    await db.insert(siteVisits).values({
      organizationId: A.orgId,
      leadId: lead.id,
      projectId: A.projectId,
      scheduledAt: new Date(Date.now() + 86_400_000),
      createdAt: new Date(Date.now() - 3 * 86_400_000),
    });
    await leadsRepository.updateStatus({ organizationId: A.orgId, id: lead.id, status: "ANSWERED" });
    await finalize(await callFor(lead.id, new Date()), "VISIT_BOOKED");
    expect(await statusOf(lead.id)).toBe("VISIT_BOOKED");
  });

  it("other recommended statuses are applied unchanged", async () => {
    const lead = await freshLead();
    await finalize(await callFor(lead.id, new Date()), "NOT_INTERESTED");
    expect(await statusOf(lead.id)).toBe("NOT_INTERESTED");
  });

  it("a booked visit that belongs to a different lead does not count", async () => {
    const other = await freshLead();
    await db.insert(siteVisits).values({ organizationId: A.orgId, leadId: other.id, projectId: A.projectId, scheduledAt: new Date(Date.now() + 86_400_000) });
    const lead = await freshLead();
    await finalize(await callFor(lead.id, new Date()), "VISIT_BOOKED");
    expect(await statusOf(lead.id)).toBe("INTERESTED");
  });

  it("a booked visit in a different project does not count", async () => {
    const [otherProject] = await db.insert(projects).values({ organizationId: A.orgId, name: "Other Heights", location: "Elsewhere" }).returning();
    const lead = await freshLead();
    await db.insert(siteVisits).values({ organizationId: A.orgId, leadId: lead.id, projectId: otherProject.id, scheduledAt: new Date(Date.now() + 86_400_000) });
    await finalize(await callFor(lead.id, new Date()), "VISIT_BOOKED");
    expect(await statusOf(lead.id)).toBe("INTERESTED");
  });

  it("a cancelled visit does not count", async () => {
    const lead = await freshLead();
    await db.insert(siteVisits).values({ organizationId: A.orgId, leadId: lead.id, projectId: A.projectId, scheduledAt: new Date(Date.now() + 86_400_000), status: "cancelled" });
    await finalize(await callFor(lead.id, new Date()), "VISIT_BOOKED");
    expect(await statusOf(lead.id)).toBe("INTERESTED");
  });
});

describe("book_site_visit only books a slot that was offered", () => {
  async function runtimeFor(leadId: string) {
    const call = await callsRepository.create({ organizationId: A.orgId, status: "in_progress", callType: "outbound", agentId: A.agentId, leadId });
    return { call, rt: await callRuntime.build(ctx, call) };
  }

  it("an unoffered time is refused: no visit exists, and a summary that claims VISIT_BOOKED still leaves the lead INTERESTED", async () => {
    const lead = await freshLead();
    const { call, rt } = await runtimeFor(lead.id);
    const farFuture = new Date(Date.now() + 40 * 86_400_000).toISOString();
    const result = (await executeTool("book_site_visit", { isoDateTime: farFuture }, rt.toolContext, rt.effectiveTools)) as { booked?: boolean; error?: string };
    expect(result.booked).toBe(false);
    expect(result.error).toBeTruthy();
    expect(await db.select().from(siteVisits).where(eq(siteVisits.leadId, lead.id))).toHaveLength(0);
    await finalize((await callsRepository.findByIdAnyOrg({ id: call.id }))!, "VISIT_BOOKED");
    expect(await statusOf(lead.id)).toBe("INTERESTED");
  });

  it("an offered slot books, and then VISIT_BOOKED is legitimate", async () => {
    const lead = await freshLead();
    const { call, rt } = await runtimeFor(lead.id);
    const slot = siteVisitsService.checkVisitSlots()[1];
    const result = (await executeTool("book_site_visit", { isoDateTime: slot.isoDateTime }, rt.toolContext, rt.effectiveTools)) as { booked?: boolean };
    expect(result.booked).toBe(true);
    await finalize((await callsRepository.findByIdAnyOrg({ id: call.id }))!, "VISIT_BOOKED");
    expect(await statusOf(lead.id)).toBe("VISIT_BOOKED");
  });

  it("the turn reports that a visit was really booked (for reply monitoring)", async () => {
    const lead = await freshLead();
    const { rt } = await runtimeFor(lead.id);
    const slot = siteVisitsService.checkVisitSlots()[0];
    const script: ChatResult[] = [
      { toolCalls: [{ id: "t1", name: "book_site_visit", arguments: { isoDateTime: slot.isoDateTime } }] },
      { content: "Your visit is booked." },
    ];
    const llm: ILanguageModel = { name: "scripted", async chat() { return script.shift() ?? { content: "ok" }; } };
    const session = new ConversationSession(llm, rt.toolContext, rt.promptParams, rt.config);
    const ran: Array<{ name: string; booked: boolean }> = [];
    await session.handleUserUtterance("please book the first slot", { onToolRun: (e) => ran.push(e) });
    expect(ran).toEqual([{ name: "book_site_visit", booked: true }]);
  });

  it("a refused booking is reported as not booked", async () => {
    const lead = await freshLead();
    const { rt } = await runtimeFor(lead.id);
    const script: ChatResult[] = [
      { toolCalls: [{ id: "t1", name: "book_site_visit", arguments: { isoDateTime: new Date(Date.now() + 40 * 86_400_000).toISOString() } }] },
      { content: "Sorry, that time is not available." },
    ];
    const llm: ILanguageModel = { name: "scripted", async chat() { return script.shift() ?? { content: "ok" }; } };
    const session = new ConversationSession(llm, rt.toolContext, rt.promptParams, rt.config);
    const ran: Array<{ name: string; booked: boolean }> = [];
    await session.handleUserUtterance("book it next month", { onToolRun: (e) => ran.push(e) });
    expect(ran).toEqual([{ name: "book_site_visit", booked: false }]);
  });
});
