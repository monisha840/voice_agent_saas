import Link from "next/link";
import { CheckCircle2, Circle } from "lucide-react";
import { api, serverHeaders } from "@/lib/api.server";
import { can } from "@/lib/permissions";
import { createBillingApi } from "@/lib/billing";
import type { Agent } from "@/lib/types";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { Card } from "@/components/ui";

export const dynamic = "force-dynamic";

interface Step {
  key: string;
  title: string;
  detail: string;
  done: boolean | null; // null = cannot be determined for this role
  href: string;
  cta: string;
  show: boolean;
}

/**
 * Setup checklist. Every tick comes from real data (workspace, subscription, agents, calls, team): nothing is
 * remembered client-side or faked. Steps the viewer's role cannot act on are hidden.
 */
export default async function OnboardingPage() {
  try {
    const me = await api.me();
    const role = me.organization?.role ?? null;
    if (!me.organization) {
      return (
        <PageShell title="Set up your workspace">
          <Card>
            <p className="text-sm text-stone-700">
              Your account is not part of a workspace yet. Workspaces are currently created by the Sirah Digital team or by an
              invitation from an existing workspace owner. Contact support@sirahdigital.in to have one created.
            </p>
          </Card>
        </PageShell>
      );
    }
    const billing = createBillingApi(serverHeaders);
    const [overview, agents, calls, users] = await Promise.all([
      can(role, "usage:read") ? billing.overview().catch(() => null) : Promise.resolve(null),
      can(role, "agents:read") ? api.listAgents(false).catch((): Agent[] | null => null) : Promise.resolve(null),
      can(role, "calls:read") ? api.listCalls({ limit: 1 }).then((r) => r.data).catch(() => null) : Promise.resolve(null),
      can(role, "users:read") ? api.listUsers().catch(() => null) : Promise.resolve(null),
    ]);
    const activeAgents = (agents ?? []).filter((a) => a.status === "active");
    const steps: Step[] = [
      { key: "workspace", title: "Create your workspace", detail: `${me.organization.name} is set up.`, done: true, href: "/settings", cta: "Settings", show: true },
      {
        key: "plan",
        title: "Choose how you will run",
        detail: overview?.managed ? `On the ${overview.plan?.name ?? "current"} plan.` : "Start a trial to get a defined minute allowance.",
        done: overview ? overview.managed : null,
        href: "/billing",
        cta: "Plan & billing",
        show: can(role, "usage:read"),
      },
      {
        key: "agent",
        title: "Create your first voice agent",
        detail: "Give it a name, a persona and the knowledge it may use.",
        done: agents ? activeAgents.length > 0 : null,
        href: activeAgents.length > 0 ? "/agents" : "/agents/new",
        cta: activeAgents.length > 0 ? "View agents" : "Create agent",
        show: can(role, "agents:manage"),
      },
      {
        key: "test",
        title: "Place a test call",
        detail: "Hear the agent and check how it answers. Test calls are not billed.",
        done: calls ? calls.length > 0 : null,
        href: "/test",
        cta: "Open test",
        show: can(role, "calls:create"),
      },
      {
        key: "team",
        title: "Invite a teammate",
        detail: "Add admins, managers or agents with the right access.",
        done: users ? users.length > 1 : null,
        href: "/team",
        cta: "Team",
        show: can(role, "users:manage"),
      },
    ].filter((s) => s.show);
    const done = steps.filter((s) => s.done === true).length;

    return (
      <PageShell title="Get started" subtitle={`${done} of ${steps.length} steps complete`}>
        <ol className="space-y-3">
          {steps.map((s) => (
            <li key={s.key} className="flex items-start gap-3 rounded-xl border border-stone-200 bg-white p-4">
              {s.done ? (
                <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-700" aria-label="Done" />
              ) : (
                <Circle size={20} className="mt-0.5 shrink-0 text-stone-300" aria-label="To do" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-semibold text-stone-900">{s.title}</div>
                <p className="mt-0.5 text-sm text-stone-500">{s.detail}</p>
              </div>
              <Link href={s.href} className="shrink-0 text-sm font-medium text-emerald-700 hover:text-emerald-800">
                {s.cta}
              </Link>
            </li>
          ))}
        </ol>
      </PageShell>
    );
  } catch (err) {
    return (
      <PageShell title="Get started">
        <LoadFailure err={err} what="Setup" />
      </PageShell>
    );
  }
}
