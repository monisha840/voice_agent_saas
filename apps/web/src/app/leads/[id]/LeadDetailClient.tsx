"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Building2,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  Clock,
  MapPin,
  MessageSquare,
  Phone,
  Target,
  type LucideIcon,
} from "lucide-react";
import { Header } from "@/components/Header";
import { StatusBadge } from "@/components/StatusBadge";
import { CallExperience } from "@/components/CallExperience";
import { EmptyState } from "@/components/StateViews";
import { formatBudgetRange, formatDateTime, formatDuration } from "@/lib/format";
import { api } from "@/lib/api";
import { can } from "@/lib/permissions";
import { Button, errorMessage } from "@/components/ui";
import { LeadFormModal } from "@/components/LeadForm";
import { FollowUpList } from "@/components/FollowUpList";
import type { LeadDetail, Project, Role, TeamMember } from "@/lib/types";

export function LeadDetailClient({
  initial,
  role = null,
  projects = [],
  assignees = [],
}: {
  initial: LeadDetail;
  role?: Role | null;
  projects?: Project[];
  assignees?: TeamMember[];
}) {
  const router = useRouter();
  const [lead, setLead] = useState<LeadDetail>(initial);
  const [editing, setEditing] = useState(false);
  const project = projects.find((p) => p.id === lead.projectId);

  const latestCall = lead.callHistory[0] ?? null;
  const conversation = lead.latestConversation;
  const qualification = conversation?.qualification ?? null;
  const latestVisit = lead.siteVisits[0] ?? null;
  const callJustCompleted = latestCall?.status === "completed" && conversation?.summary;

  return (
    <main className="min-h-screen bg-stone-50">
      <Header />

      <div className="mx-auto max-w-6xl px-6 py-8">
        <Link
          href="/leads"
          className="inline-flex items-center gap-1 text-sm text-stone-500 transition hover:text-stone-800"
        >
          <ChevronLeft size={14} />
          Leads
        </Link>

        {/* Lead header */}
        <section className="mt-4 flex flex-wrap items-start justify-between gap-4 rounded-xl border border-stone-200 bg-white p-6">
          <div>
            <h1 className="text-xl font-semibold text-stone-900">{lead.name}</h1>
            <p className="mt-1 text-sm text-stone-500">
              {lead.requirementConfig ?? "Requirement not captured"} ·{" "}
              {formatBudgetRange(lead.budgetMin, lead.budgetMax)}
            </p>
          </div>
          <div className="flex items-center gap-3">
            {can(role, "leads:update") && (
              <Button variant="secondary" onClick={() => setEditing(true)}>
                Edit details
              </Button>
            )}
            <StatusBadge status={lead.status} />
          </div>
        </section>

        {editing && (
          <LeadFormModal
            lead={lead}
            projects={projects}
            assignees={assignees}
            canAssign={false}
            onClose={() => setEditing(false)}
            onSaved={(saved) => {
              setLead((prev) => ({ ...prev, ...saved, callHistory: prev.callHistory, siteVisits: prev.siteVisits, followUps: prev.followUps, latestConversation: prev.latestConversation }));
              setEditing(false);
              router.refresh();
            }}
          />
        )}

        {/* Call result banner — only rendered when the backend actually
            reports a completed call with a summary. */}
        {callJustCompleted && (
          <div className="fade-up mt-6 flex items-center gap-3 rounded-xl border border-emerald-200 bg-emerald-50 px-5 py-4">
            <CheckCircle2 size={20} className="shrink-0 text-emerald-700" />
            <div>
              <div className="text-sm font-semibold text-emerald-900">
                Call completed · {formatDuration(latestCall!.startedAt, latestCall!.endedAt)}
                {qualification && qualification.interestLevel !== "unknown" && (
                  <span className="ml-2 font-normal text-emerald-700">
                    {qualification.interestLevel.toUpperCase()} INTEREST
                  </span>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Call CTA / live experience */}
        <div className="mt-6">
          <CallExperience leadId={lead.id} initial={lead} onUpdated={setLead} />
        </div>

        {/* Two-column workspace */}
        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Main column */}
          <div className="space-y-6 lg:col-span-2">
            <LeadOverviewCard lead={lead} projectName={project?.name} />

            {qualification ? (
              <QualificationCard qualification={qualification} />
            ) : (
              <SectionShell title="AI Qualification" icon={Target}>
                <EmptyState
                  title="No qualification yet"
                  description="Start an AI call to see qualification details extracted from the conversation here."
                />
              </SectionShell>
            )}

            {conversation?.summary && (
              <SectionShell title="AI Summary" icon={MessageSquare}>
                <p className="text-sm leading-relaxed text-stone-700">{conversation.summary}</p>
                {qualification && (
                  <div className="mt-4 flex flex-wrap gap-6 border-t border-stone-100 pt-4 text-sm">
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-stone-400">
                        Interest
                      </div>
                      <div className="mt-0.5 font-medium capitalize text-stone-900">
                        {qualification.interestLevel}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-medium uppercase tracking-wide text-stone-400">
                        Next Action
                      </div>
                      <div className="mt-0.5 font-medium text-stone-900">
                        {qualification.recommendedNextAction}
                      </div>
                    </div>
                  </div>
                )}
              </SectionShell>
            )}

            <TranscriptCard turns={conversation?.transcript ?? []} leadName={lead.name} />

            <CallHistoryCard calls={lead.callHistory} />
          </div>

          {/* Right rail */}
          <div className="space-y-6">
            <SectionShell title="Lead Status" icon={CheckCircle2}>
              <StatusBadge status={lead.status} className="text-sm" />
            </SectionShell>

            <SectionShell title="Project" icon={Building2}>
              <div className="text-sm font-medium text-stone-900">
                {project?.name ?? "Green Valley Residency"}
              </div>
              <div className="mt-1 flex items-center gap-1 text-sm text-stone-500">
                <MapPin size={13} />
                {project?.location ?? "Whitefield, Bangalore"}
              </div>
            </SectionShell>

            {can(role, "leads:assign") && (
              <SectionShell title="Assignee" icon={Phone}>
                <AssigneeControl lead={lead} assignees={assignees} onChange={(l) => setLead((prev) => ({ ...prev, ...l }))} />
              </SectionShell>
            )}

            <SectionShell title="Site Visit" icon={Calendar}>
              {latestVisit ? (
                <div>
                  <div className="text-lg font-semibold text-stone-900">
                    {formatDateTime(latestVisit.scheduledAt)}
                  </div>
                  <div className="mt-2">
                    <StatusBadge status={latestVisit.status === "booked" ? "CONFIRMED" : "CANCELLED"} />
                  </div>
                </div>
              ) : (
                <p className="text-sm text-stone-500">No site visit booked</p>
              )}
            </SectionShell>

            {lead.followUps.length > 0 && (
              <SectionShell title="Follow-ups" icon={Clock}>
                <FollowUpList
                  items={lead.followUps}
                  canClear={can(role, "leads:update")}
                  onCleared={(id) =>
                    setLead((prev) => ({
                      ...prev,
                      followUps: prev.followUps.map((f) => (f.id === id ? { ...f, status: "done" as const, resolvedAt: new Date().toISOString() } : f)),
                    }))
                  }
                />
              </SectionShell>
            )}

            {qualification?.recommendedNextAction && (
              <SectionShell title="Next Action" icon={Target}>
                <p className="text-sm text-stone-700">{qualification.recommendedNextAction}</p>
              </SectionShell>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function SectionShell({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-stone-200 bg-white p-6">
      <div className="mb-4 flex items-center gap-2">
        <Icon size={15} className="text-stone-400" />
        <h2 className="text-sm font-semibold text-stone-900">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function LeadOverviewCard({ lead, projectName }: { lead: LeadDetail; projectName?: string }) {
  const fields: Array<{ label: string; value: string }> = [
    { label: "Phone", value: lead.phone },
    { label: "Configuration", value: lead.requirementConfig ?? "Not captured" },
    { label: "Budget", value: formatBudgetRange(lead.budgetMin, lead.budgetMax) },
    { label: "Project", value: projectName ?? "Green Valley Residency" },
    { label: "Assigned to", value: lead.assigneeName ?? "Unassigned" },
    { label: "Created", value: formatDateTime(lead.createdAt) },
  ];

  return (
    <SectionShell title="Lead Overview" icon={Phone}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        {fields.map((f) => (
          <div key={f.label}>
            <dt className="text-xs font-medium uppercase tracking-wide text-stone-400">{f.label}</dt>
            <dd className="mt-0.5 text-sm font-medium text-stone-900">{f.value}</dd>
          </div>
        ))}
      </dl>
    </SectionShell>
  );
}

function QualificationCard({ qualification }: { qualification: NonNullable<LeadDetail["latestConversation"]>["qualification"] }) {
  if (!qualification) return null;
  const notCaptured = "Not captured";

  const rows: Array<{ label: string; value: string }> = [
    { label: "Interest", value: cap(qualification.interestLevel) },
    { label: "Configuration", value: qualification.configuration ?? notCaptured },
    { label: "Budget", value: qualification.budget ?? notCaptured },
    { label: "Purchase Timeline", value: qualification.purchaseTimeline ?? notCaptured },
    { label: "Loan Requirement", value: qualification.loanRequirement ?? notCaptured },
    { label: "Location Preference", value: qualification.locationPreference ?? notCaptured },
  ];

  return (
    <SectionShell title="AI Qualification" icon={Target}>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
        {rows.map((r) => (
          <div key={r.label}>
            <dt className="text-xs font-medium uppercase tracking-wide text-stone-400">{r.label}</dt>
            <dd
              className={`mt-0.5 text-sm font-medium ${
                r.value === notCaptured ? "text-stone-400" : "text-stone-900"
              }`}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>

      {qualification.customerQuestions.length > 0 && (
        <div className="mt-5 border-t border-stone-100 pt-4">
          <div className="text-xs font-medium uppercase tracking-wide text-stone-400">
            Customer Questions
          </div>
          <ul className="mt-2 space-y-1">
            {qualification.customerQuestions.map((q, i) => (
              <li key={i} className="text-sm text-stone-700">
                · {q}
              </li>
            ))}
          </ul>
        </div>
      )}
    </SectionShell>
  );
}

function TranscriptCard({
  turns,
  leadName,
}: {
  turns: NonNullable<LeadDetail["latestConversation"]>["transcript"];
  leadName: string;
}) {
  return (
    <SectionShell title="Conversation" icon={MessageSquare}>
      {turns.length === 0 ? (
        <EmptyState
          title="No conversation yet"
          description="Start an AI call to see the live transcript appear here."
        />
      ) : (
        <div className="max-h-96 space-y-3 overflow-y-auto pr-1">
          {turns.map((turn, i) => (
            <div key={i} className="flex gap-3 text-sm">
              <span
                className={`mt-0.5 shrink-0 text-xs font-semibold ${
                  turn.speaker === "ai" ? "text-emerald-700" : "text-stone-400"
                }`}
              >
                {turn.speaker === "ai" ? "Priya · AI" : leadName.split(" ")[0]}
              </span>
              <span className="text-stone-700">{turn.text}</span>
            </div>
          ))}
        </div>
      )}
    </SectionShell>
  );
}

function CallHistoryCard({ calls }: { calls: LeadDetail["callHistory"] }) {
  return (
    <SectionShell title="Call History" icon={Clock}>
      {calls.length === 0 ? (
        <p className="text-sm text-stone-500">No previous calls</p>
      ) : (
        <ul className="divide-y divide-stone-100">
          {calls.map((call) => (
            <li key={call.id} className="flex items-center justify-between py-2.5 text-sm">
              <div>
                <div className="font-medium text-stone-800">AI Outbound Call</div>
                <div className="text-xs text-stone-400">{formatDateTime(call.createdAt)}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-stone-500">{formatDuration(call.startedAt, call.endedAt)}</span>
                <StatusBadge status={call.status.toUpperCase()} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionShell>
  );
}

function cap(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function AssigneeControl({
  lead,
  assignees,
  onChange,
}: {
  lead: LeadDetail;
  assignees: TeamMember[];
  onChange: (l: Partial<LeadDetail>) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function assign(userId: string) {
    setBusy(true);
    setError(null);
    try {
      await api.assignLead(lead.id, userId || null);
      const name = assignees.find((u) => u.userId === userId)?.name ?? null;
      onChange({ assignedUserId: userId || null, assigneeName: name });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <select
        value={lead.assignedUserId ?? ""}
        disabled={busy}
        onChange={(e) => void assign(e.target.value)}
        aria-label="Assignee"
        className="w-full rounded-md border border-stone-300 bg-white px-3 py-2 text-sm focus:border-emerald-600 focus:outline-none disabled:opacity-60"
      >
        <option value="">Unassigned</option>
        {assignees.map((u) => (
          <option key={u.userId} value={u.userId}>
            {u.name} ({u.role})
          </option>
        ))}
      </select>
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
