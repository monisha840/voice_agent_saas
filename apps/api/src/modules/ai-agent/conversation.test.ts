import { describe, it, expect, beforeAll } from "vitest";
import { ConversationSession } from "./conversation.js";
import { MockLlmProvider } from "../../adapters/ai/mock.llm.provider.js";
import { projectsService } from "../projects/projects.service.js";
import { leadsService } from "../leads/leads.service.js";
import { callsService } from "../calls/calls.service.js";
import { conversationsRepository } from "../../db/repositories/conversations.repository.js";
import type { ToolExecutionContext } from "../../ai-tools/types.js";

describe("ConversationSession (text-only harness, mock LLM, real tool/service layer)", () => {
  let ctx: ToolExecutionContext;

  beforeAll(async () => {
    const project = await projectsService.getDefaultProject();
    const leads = await leadsService.listLeads();
    const lead = leads.find((l) => l.name === "Sunita Rao")!;
    const call = await callsService.createCall({ leadId: lead.id });
    ctx = { leadId: lead.id, projectId: project.id, callId: call.id };
  });

  it("start() produces an opening spoken line and persists it as an 'ai' turn", async () => {
    const session = new ConversationSession(new MockLlmProvider(), ctx, {
      leadName: "Sunita Rao",
      projectName: "Green Valley Residency",
    });

    const result = await session.start();
    expect(result.spokenText).toBeTruthy();
    expect(result.shouldEndCall).toBe(false);

    const conversation = await conversationsRepository.findByCallId({ callId: ctx.callId });
    const transcript = conversation!.transcript as Array<{ speaker: string }>;
    expect(transcript.some((t) => t.speaker === "ai")).toBe(true);
  });

  it("a price question triggers a tool call and the tool result feeds back into the next response", async () => {
    const session = new ConversationSession(new MockLlmProvider(), ctx, {
      leadName: "Sunita Rao",
      projectName: "Green Valley Residency",
    });
    await session.start();

    const result = await session.handleUserUtterance("What is the price of a 2 BHK?");
    expect(result.spokenText.toLowerCase()).toContain("mock response");

    const conversation = await conversationsRepository.findByCallId({ callId: ctx.callId });
    const transcript = conversation!.transcript as Array<{ speaker: string; text: string }>;
    expect(transcript.some((t) => t.speaker === "lead" && t.text.includes("price"))).toBe(true);
  });
});
