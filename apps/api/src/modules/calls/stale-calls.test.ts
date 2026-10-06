/**
 * The stale-call reaper against the real Postgres: calls whose terminal
 * callback never arrived must not stay "in progress" forever.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";

process.env.AI_PROVIDER = "mock";

import { db } from "../../db/client.js";
import { calls, leads } from "../../db/schema.js";
import { projectsService } from "../projects/projects.service.js";
import { callsService } from "./calls.service.js";
import { conversationsRepository } from "../../db/repositories/conversations.repository.js";
import { leadsRepository } from "../../db/repositories/leads.repository.js";
import { demoContext } from "../../test/helpers.js";
import { defaultAgentIdFor } from "../../test/tenants.js";
import type { RequestContext } from "../../auth/context.js";

const createdLeadIds: string[] = [];
const MIN = 60_000;
let org: RequestContext;
let projectId: string;

async function leadWithCall(status: "initiating" | "ringing" | "in_progress", ageMs: number) {
  const [lead] = await db
    .insert(leads)
    .values({
      organizationId: org.organizationId,
      projectId,
      name: "Stale Call Lead",
      phone: "+919000000002",
      status: "CALLING",
    })
    .returning();
  createdLeadIds.push(lead.id);
  const old = new Date(Date.now() - ageMs);
  const [call] = await db
    .insert(calls)
    .values({
      organizationId: org.organizationId,
      agentId: await defaultAgentIdFor(org.organizationId),
      leadId: lead.id,
      status,
      createdAt: old,
      startedAt: status === "in_progress" ? old : null,
    })
    .returning();
  await conversationsRepository.createForCall({ organizationId: org.organizationId, callId: call.id });
  return { lead, call };
}

const LIMITS = { pendingMs: 10 * MIN, inProgressMs: 45 * MIN };
const lead = (id: string) => leadsRepository.findById({ organizationId: org.organizationId, id });

beforeAll(async () => {
  org = await demoContext();
  projectId = (await projectsService.getDefaultProject(org)).id;
});

afterAll(async () => {
  for (const id of createdLeadIds) await db.delete(leads).where(eq(leads.id, id));
});

describe("callsService.reapStaleCalls", () => {
  it("fails a never-answered call older than the limit and puts the lead back to RETRY", async () => {
    const l = await leadWithCall("ringing", 30 * MIN);
    await callsService.reapStaleCalls(LIMITS);
    const after = await callsService.getCallDetail(org, { callId: l.call.id });
    expect(after?.status).toBe("failed");
    expect(after?.endedAt).toBeTruthy();
    expect((await lead(l.lead.id))?.status).toBe("RETRY");
  });

  it("leaves a recent never-answered call and a recent in-progress call alone", async () => {
    const pending = await leadWithCall("initiating", 2 * MIN);
    const live = await leadWithCall("in_progress", 5 * MIN);
    await callsService.reapStaleCalls(LIMITS);
    expect((await callsService.getCallDetail(org, { callId: pending.call.id }))?.status).toBe("initiating");
    expect((await callsService.getCallDetail(org, { callId: live.call.id }))?.status).toBe("in_progress");
    expect((await lead(pending.lead.id))?.status).toBe("CALLING");
  });

  it("completes a long-running answered call and finalizes it from the transcript, exactly once", async () => {
    const l = await leadWithCall("in_progress", 2 * 60 * MIN);
    const turn = (speaker: "ai" | "lead", text: string) =>
      conversationsRepository.appendTurn({
        organizationId: org.organizationId,
        callId: l.call.id,
        turn: { speaker, text, timestamp: new Date().toISOString() },
      });
    await turn("ai", "Hello! This is Priya, an AI assistant.");
    await turn("lead", "I'm looking for a 2 BHK. My budget is around 70 lakhs.");

    const first = await callsService.reapStaleCalls(LIMITS);
    expect(first.closed).toBeGreaterThanOrEqual(1);
    const after = await callsService.getCallDetail(org, { callId: l.call.id });
    expect(after?.status).toBe("completed");
    expect(after?.conversation?.summary).toContain("2 BHK");
    expect((await lead(l.lead.id))?.status).toBe("INTERESTED");

    const summary = after?.conversation?.summary;
    await callsService.reapStaleCalls(LIMITS); // second run must be a no-op for this call
    const again = await callsService.getCallDetail(org, { callId: l.call.id });
    expect(again?.conversation?.summary).toBe(summary);
    expect(again?.endedAt).toEqual(after?.endedAt);
  });
});
