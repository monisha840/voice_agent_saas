import { isUniqueViolation } from "../../db/pg-error.js";
import { assertCan } from "../../auth/access.js";
import type { RequestContext } from "../../auth/context.js";
import { tenantScoped } from "../../auth/tenant-scoped.js";
import { agentPhoneNumbersRepository } from "../../db/repositories/agent-phone-numbers.repository.js";
import { agentsRepository } from "../../db/repositories/agents.repository.js";
import { getTelephonyProvider } from "../../adapters/telephony/index.js";
import type { ProviderSetupStatus } from "../../adapters/telephony/telephony.interface.js";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors.js";
import { auditService } from "../audit/audit.service.js";
import { normalizeRoutingNumber } from "../agents/agent-phone-numbers.service.js";

/**
 * Telephony number management: the organization's inbound numbers, which agent answers each, pausing and resuming
 * routing, the calls and failures per number, and a connection check. Built on the existing inbound routing table
 * (agent_phone_numbers, resolved by calls.service startInboundCall) and the configured telephony adapter; there is no
 * second routing path. Read = agents:read (MANAGER+), change and provider checks = agents:manage (ADMIN+).
 */

const STATS_WINDOW_DAYS = 30;
/** One provider check per number per this long (each is a request to the provider's API). */
const CHECK_COOLDOWN_MS = 15_000;
const lastCheck = new Map<string, number>();

type Row = NonNullable<Awaited<ReturnType<typeof agentPhoneNumbersRepository.findById>>>;
type Stats = Awaited<ReturnType<typeof agentPhoneNumbersRepository.lineStats>>[number];

function routingState(row: Row): "active" | "paused" | "agent_inactive" {
  if (!row.number.routingEnabled) return "paused";
  return row.agentStatus === "active" ? "active" : "agent_inactive";
}

function toView(row: Row, stats?: Stats) {
  const n = row.number;
  return {
    id: n.id,
    phoneNumber: n.phoneNumber,
    label: n.label,
    agent: { id: n.agentId, name: row.agentName, status: row.agentStatus },
    routingEnabled: n.routingEnabled,
    state: routingState(row),
    lastInboundAt: n.lastInboundAt,
    refused: { count: n.refusedCount, lastAt: n.lastRefusedAt, lastReason: n.lastRefusedReason },
    provider: { status: n.providerStatus, detail: n.providerDetail, checkedAt: n.providerCheckedAt },
    calls: {
      windowDays: STATS_WINDOW_DAYS,
      total: stats?.total ?? 0,
      failed: stats?.failed ?? 0,
      live: stats?.live ?? 0,
      lastCallAt: stats?.lastCallAt ?? null,
    },
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

function since() {
  return new Date(Date.now() - STATS_WINDOW_DAYS * 86_400_000);
}

function providerSetup(): ProviderSetupStatus {
  const provider = getTelephonyProvider();
  return (
    provider.describeSetup?.() ?? {
      provider: provider.name,
      simulated: false,
      configured: false,
      missing: [],
      problems: ["This provider does not report its configuration."],
      numberCheckSupported: false,
    }
  );
}

async function requireNumber(ctx: RequestContext, id: string) {
  const row = await agentPhoneNumbersRepository.findById({ organizationId: ctx.organizationId, id });
  if (!row) throw new NotFoundError("Phone number not found");
  return row;
}

/** Only an ACTIVE agent of this organization can be given a number (another organization's agent is "not found"). */
async function requireActiveAgent(ctx: RequestContext, agentId: string) {
  const agent = await agentsRepository.findById({ organizationId: ctx.organizationId, id: agentId });
  if (!agent) throw new NotFoundError("Agent not found");
  if (agent.status !== "active") throw new ValidationError(`"${agent.name}" is archived. Unarchive it or choose another agent.`);
  return agent;
}

async function liveCalls(ctx: RequestContext, phoneNumber: string) {
  const [s] = await agentPhoneNumbersRepository.lineStats({ organizationId: ctx.organizationId, lineNumbers: [phoneNumber], since: since() });
  return s?.live ?? 0;
}

function requireConfirmation(confirm: boolean | undefined, impact: string) {
  if (!confirm) throw new ConflictError(`Confirmation required: ${impact} Send the change again with "confirm": true.`);
}

const numbersServiceImpl = {
  async list(ctx: RequestContext) {
    assertCan(ctx, "agents:read");
    const rows = await agentPhoneNumbersRepository.listForOrg({ organizationId: ctx.organizationId });
    const stats = await agentPhoneNumbersRepository.lineStats({
      organizationId: ctx.organizationId,
      lineNumbers: rows.map((r) => r.number.phoneNumber),
      since: since(),
    });
    const byLine = new Map(stats.map((s) => [s.lineNumber, s]));
    return { provider: providerSetup(), numbers: rows.map((r) => toView(r, byLine.get(r.number.phoneNumber))) };
  },

  async get(ctx: RequestContext, params: { id: string }) {
    assertCan(ctx, "agents:read");
    const row = await requireNumber(ctx, params.id);
    const [stats] = await agentPhoneNumbersRepository.lineStats({ organizationId: ctx.organizationId, lineNumbers: [row.number.phoneNumber], since: since() });
    const [recentCalls, recentFailures] = await Promise.all([
      agentPhoneNumbersRepository.callsOnLine({ organizationId: ctx.organizationId, lineNumber: row.number.phoneNumber, limit: 20 }),
      agentPhoneNumbersRepository.callsOnLine({ organizationId: ctx.organizationId, lineNumber: row.number.phoneNumber, limit: 10, failedOnly: true }),
    ]);
    return { ...toView(row, stats), setup: providerSetup(), recentCalls, recentFailures };
  },

  async add(ctx: RequestContext, params: { phoneNumber: string; agentId: string; label?: string | null }) {
    assertCan(ctx, "agents:manage");
    const phoneNumber = normalizeRoutingNumber(params.phoneNumber);
    await requireActiveAgent(ctx, params.agentId);
    const own = await agentPhoneNumbersRepository.findByNumber({ organizationId: ctx.organizationId, phoneNumber });
    if (own) throw new ConflictError(`${phoneNumber} is already in your numbers.`);
    let row;
    try {
      row = await agentPhoneNumbersRepository.add({ organizationId: ctx.organizationId, agentId: params.agentId, phoneNumber, label: params.label ?? null });
    } catch (err) {
      // Held by another organization: say nothing about who or what (no cross-tenant detail).
      if (isUniqueViolation(err)) throw new ConflictError("This number cannot be added. If it belongs to you, contact support.");
      throw err;
    }
    await auditService.record(ctx, {
      action: "agent.phone_number_added",
      entityType: "agent",
      entityId: params.agentId,
      metadata: { phoneNumber, numberId: row.id },
    });
    return numbersServiceImpl.get(ctx, { id: row.id });
  },

  /**
   * Changes the label, the answering agent and/or pauses/resumes routing. Changing where calls go on an active number
   * (another agent, or pausing) needs `confirm: true`; `expectedAgentId` refuses the change if someone else re-routed the
   * number meanwhile.
   */
  async update(
    ctx: RequestContext,
    params: { id: string; label?: string | null; agentId?: string; routingEnabled?: boolean; expectedAgentId?: string; confirm?: boolean },
  ) {
    assertCan(ctx, "agents:manage");
    const row = await requireNumber(ctx, params.id);
    const n = row.number;
    const set: { agentId?: string; label?: string | null; routingEnabled?: boolean } = {};
    if (params.label !== undefined) set.label = params.label;

    const reassign = params.agentId !== undefined && params.agentId !== n.agentId;
    let newAgentName: string | null = null;
    if (reassign) {
      newAgentName = (await requireActiveAgent(ctx, params.agentId!)).name;
      set.agentId = params.agentId;
    }
    const pausing = params.routingEnabled === false && n.routingEnabled;
    const resuming = params.routingEnabled === true && !n.routingEnabled;
    if (pausing || resuming) set.routingEnabled = params.routingEnabled;
    if (Object.keys(set).length === 0) return numbersServiceImpl.get(ctx, { id: n.id });

    if ((reassign || pausing) && n.routingEnabled) {
      const live = await liveCalls(ctx, n.phoneNumber);
      const liveNote = live > 0 ? ` ${live} call${live === 1 ? " is" : "s are"} in progress on it and will finish normally.` : "";
      requireConfirmation(
        params.confirm,
        pausing
          ? `new calls to ${n.phoneNumber} will be refused while it is paused.${liveNote}`
          : `new calls to ${n.phoneNumber} will be answered by "${newAgentName}" instead of "${row.agentName}".${liveNote}`,
      );
    }

    const updated = await agentPhoneNumbersRepository.updateRouting({
      organizationId: ctx.organizationId,
      id: n.id,
      expectedAgentId: params.expectedAgentId,
      set,
    });
    if (!updated) throw new ConflictError("This number's routing was changed by someone else. Reload and try again.");
    await auditService.record(ctx, {
      action: "agent.phone_number_updated",
      entityType: "agent",
      entityId: updated.agentId,
      metadata: {
        numberId: n.id,
        phoneNumber: n.phoneNumber,
        ...(reassign ? { fromAgentId: n.agentId, toAgentId: updated.agentId } : {}),
        ...(set.routingEnabled !== undefined ? { routingEnabled: set.routingEnabled } : {}),
        ...(set.label !== undefined ? { labelChanged: true } : {}),
      },
    });
    return numbersServiceImpl.get(ctx, { id: n.id });
  },

  async remove(ctx: RequestContext, params: { id: string; confirm?: boolean }) {
    assertCan(ctx, "agents:manage");
    const row = await requireNumber(ctx, params.id);
    if (row.number.routingEnabled) {
      requireConfirmation(params.confirm, `calls to ${row.number.phoneNumber} will no longer reach any agent.`);
    }
    const removed = await agentPhoneNumbersRepository.removeById({ organizationId: ctx.organizationId, id: params.id });
    if (!removed) throw new NotFoundError("Phone number not found");
    await auditService.record(ctx, {
      action: "agent.phone_number_removed",
      entityType: "agent",
      entityId: removed.agentId,
      metadata: { phoneNumber: removed.phoneNumber, numberId: removed.id },
    });
  },

  /**
   * Connection check. Every step reports pass / warn / fail with an action. The routing steps run the same code an
   * inbound call runs (the system number lookup) without creating a call; the provider step asks the provider's API
   * (read-only) when it supports it, and stores the result on the number.
   */
  async diagnose(ctx: RequestContext, params: { id: string }) {
    assertCan(ctx, "agents:manage");
    const row = await requireNumber(ctx, params.id);
    const n = row.number;
    const key = `${ctx.organizationId}:${n.id}`;
    const last = lastCheck.get(key) ?? 0;
    if (Date.now() - last < CHECK_COOLDOWN_MS) {
      throw new ConflictError("This number was just checked. Wait a few seconds and try again.");
    }
    lastCheck.set(key, Date.now());
    if (lastCheck.size > 10_000) lastCheck.clear();

    type Step = { key: string; label: string; status: "pass" | "warn" | "fail" | "skip"; detail: string };
    const steps: Step[] = [];
    steps.push(
      n.routingEnabled
        ? { key: "routing", label: "Routing switched on", status: "pass", detail: "Calls to this number are accepted." }
        : { key: "routing", label: "Routing switched on", status: "fail", detail: "Routing is paused: calls are refused. Resume it to accept calls." },
    );
    steps.push(
      row.agentStatus === "active"
        ? { key: "agent", label: "Answering agent is active", status: "pass", detail: `"${row.agentName}" answers this number.` }
        : { key: "agent", label: "Answering agent is active", status: "fail", detail: `"${row.agentName}" is archived. Assign an active agent.` },
    );
    // The real inbound lookup (the same system resolver a provider webhook uses), without creating a call.
    const resolved = await agentPhoneNumbersRepository.findByNumberAnyOrg({ phoneNumber: n.phoneNumber });
    steps.push(
      resolved && resolved.organizationId === ctx.organizationId && resolved.id === n.id
        ? { key: "lookup", label: "Inbound lookup finds this number", status: "pass", detail: "A call to this number is routed to your organization." }
        : { key: "lookup", label: "Inbound lookup finds this number", status: "fail", detail: "The inbound lookup did not resolve this number. Contact support." },
    );

    const setup = providerSetup();
    if (setup.simulated) {
      steps.push({ key: "provider", label: "Telephony provider configured", status: "warn", detail: "Simulated provider: no real calls can arrive in this environment." });
    } else if (!setup.configured) {
      const what = [...setup.missing.map((m) => `${m} is not set`), ...setup.problems].join("; ");
      steps.push({ key: "provider", label: "Telephony provider configured", status: "fail", detail: `The platform's ${setup.provider} connection is incomplete (${what}). Contact support.` });
    } else {
      steps.push({ key: "provider", label: "Telephony provider configured", status: "pass", detail: `${setup.provider} connection settings are present.` });
    }

    const provider = getTelephonyProvider();
    if (!provider.checkNumber) {
      steps.push({ key: "provider_number", label: "Number exists at the provider", status: "skip", detail: "This provider cannot confirm numbers automatically." });
    } else {
      const check = await provider.checkNumber(n.phoneNumber);
      await agentPhoneNumbersRepository.setProviderCheck({ organizationId: ctx.organizationId, id: n.id, status: check.status, detail: check.detail });
      const status: Step["status"] =
        check.status === "verified"
          ? check.voiceCapable === false || check.voiceDestinationSet === false
            ? "warn"
            : "pass"
          : check.status === "unsupported"
            ? "skip"
            : "fail";
      steps.push({ key: "provider_number", label: "Number exists at the provider", status, detail: check.retryable ? `${check.detail} (temporary)` : check.detail });
    }

    const ok = steps.every((s) => s.status === "pass" || s.status === "skip" || s.status === "warn");
    return { checkedAt: new Date().toISOString(), ok, steps, number: await numbersServiceImpl.get(ctx, { id: n.id }) };
  },
};

export const numbersService = tenantScoped(numbersServiceImpl);

/** Test seam: forget provider-check cooldowns. */
export function resetNumberCheckCooldowns() {
  lastCheck.clear();
}
