import Link from "next/link";
import { ArrowRight, MapPin, PhoneCall, Sparkles, Target, Users } from "lucide-react";
import { api } from "@/lib/api.server";
import { Header } from "@/components/Header";
import { StatusBadge } from "@/components/StatusBadge";
import { ErrorState, ModuleDisabled } from "@/components/StateViews";
import { hasModule } from "@/lib/modules";
import { formatBudgetRange, formatRelativeActivity } from "@/lib/format";
import { can } from "@/lib/permissions";
import type { Role, TeamMember } from "@/lib/types";
import { NewLeadButton } from "../NewLeadButton";

export default async function LeadsPage() {
  let project;
  let projects;
  let leads;
  let role: Role | null = null;
  let assignees: TeamMember[] = [];
  let loadError: string | null = null;

  try {
    const me = await api.me();
    if (!hasModule(me.organization, "sales")) {
      return (
        <main className="min-h-screen bg-stone-50">
          <Header />
          <div className="mx-auto max-w-6xl px-6 py-16">
            <ModuleDisabled />
          </div>
        </main>
      );
    }
    projects = await api.listProjects();
    project = projects[0];
    leads = await api.listLeads();
    // The role only decides which controls to show; the API enforces the rules.
    role = me.organization?.role ?? null;
    if (can(role, "leads:assign")) assignees = await api.listUsers().catch(() => []);
  } catch {
    loadError =
      "Could not reach the API. Make sure the backend is running (pnpm dev:api) and the database is seeded (pnpm db:seed).";
  }

  if (loadError || !projects || !leads) {
    return (
      <main className="min-h-screen bg-stone-50">
        <Header />
        <div className="mx-auto max-w-6xl px-6 py-16">
          <ErrorState title="Unable to load dashboard" message={loadError!} />
        </div>
      </main>
    );
  }

  // Metrics are derived entirely from the leads already fetched above —
  // nothing here is fabricated. "AI Calls" counts leads that have moved
  // past NEW (i.e. a call was at least attempted), "Interested" counts
  // the INTERESTED/VISIT_BOOKED/CONFIRMED/VISITED outcomes, and "Visits
  // Booked" counts the actual site-visit-bearing statuses.
  const callsAttempted = leads.filter((l) => l.status !== "NEW").length;
  const interested = leads.filter((l) =>
    ["INTERESTED", "VISIT_BOOKED", "CONFIRMED", "VISITED"].includes(l.status),
  ).length;
  const visitsBooked = leads.filter((l) =>
    ["VISIT_BOOKED", "CONFIRMED", "VISITED"].includes(l.status),
  ).length;

  const metrics = [
    { label: "Total Leads", value: leads.length, icon: Users },
    { label: "AI Calls", value: callsAttempted, icon: PhoneCall },
    { label: "Interested", value: interested, icon: Target },
    { label: "Visits Booked", value: visitsBooked, icon: Sparkles },
  ];

  return (
    <main className="min-h-screen bg-stone-50">
      <Header />

      <div className="mx-auto max-w-6xl px-6 py-10">
        {/* Hero: product story in one glance */}
        <section className="mb-8">
          <div className="flex flex-wrap items-start justify-between gap-6 rounded-xl border border-stone-200 bg-white p-7">
            <div>
              <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-200">
                <Sparkles size={12} />
                AI Voice Sales Agent
              </div>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-900">
                {project?.name ?? "No projects yet"}
              </h1>
              {project && (
                <p className="mt-1 flex items-center gap-1.5 text-sm text-stone-500">
                  <MapPin size={14} />
                  {project.location}
                </p>
              )}
            </div>

            {/* The product story, compressed to a single scannable line */}
            <div className="flex items-center gap-2 text-xs font-medium text-stone-400">
              {["Lead", "AI Call", "Qualification", "Conversation", "Site Visit", "Follow-up"].map(
                (step, i, arr) => (
                  <span key={step} className="flex items-center gap-2">
                    <span className="rounded-md bg-stone-100 px-2 py-1 text-stone-600">{step}</span>
                    {i < arr.length - 1 && <ArrowRight size={12} className="text-stone-300" />}
                  </span>
                ),
              )}
            </div>
          </div>
        </section>

        {/* Metrics */}
        <section className="mb-8 grid grid-cols-2 gap-4 sm:grid-cols-4">
          {metrics.map((m) => (
            <div key={m.label} className="rounded-xl border border-stone-200 bg-white p-5">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium uppercase tracking-wide text-stone-400">
                  {m.label}
                </span>
                <m.icon size={14} className="text-stone-300" />
              </div>
              <div className="mt-2 text-3xl font-semibold tabular-nums text-stone-900">{m.value}</div>
            </div>
          ))}
        </section>

        {/* Lead list */}
        <section className="rounded-xl border border-stone-200 bg-white">
          <div className="flex items-center justify-between border-b border-stone-200 px-6 py-4">
            <h2 className="text-sm font-semibold text-stone-900">Leads</h2>
            <div className="flex items-center gap-3">
              <span className="text-xs text-stone-400">{leads.length} total</span>
              {can(role, "leads:create") && <NewLeadButton projects={projects} assignees={assignees} />}
            </div>
          </div>
          {leads.length === 0 && (
            <div className="px-6 py-10 text-center text-sm text-stone-500">
              No leads yet.{can(role, "leads:create") ? " Use New lead to add the first one." : ""}
            </div>
          )}

          <div className="divide-y divide-stone-100">
            {leads.map((lead) => (
              <Link
                key={lead.id}
                href={`/leads/${lead.id}`}
                className="group flex items-center justify-between gap-6 px-6 py-4 transition hover:bg-stone-50"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-stone-900">{lead.name}</span>
                    {lead.name === "Rajesh Kumar" && (
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 ring-1 ring-inset ring-emerald-200">
                        Demo Lead
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-sm text-stone-500">
                    {lead.requirementConfig ?? "Requirement not captured"} ·{" "}
                    {formatBudgetRange(lead.budgetMin, lead.budgetMax)} ·{" "}
                    <span className={lead.assigneeName ? "" : "text-stone-400"}>
                      {lead.assigneeName ? `Assigned to ${lead.assigneeName}` : "Unassigned"}
                    </span>
                  </div>
                </div>

                <div className="hidden text-sm text-stone-400 sm:block">
                  {formatRelativeActivity(lead.status, lead.updatedAt)}
                </div>

                <StatusBadge status={lead.status} />

                <ArrowRight
                  size={16}
                  className="shrink-0 text-stone-300 transition group-hover:translate-x-0.5 group-hover:text-stone-500"
                />
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
