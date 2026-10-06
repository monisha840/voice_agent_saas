import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { api, ApiError } from "@/lib/api.server";
import { hasModule } from "@/lib/modules";
import { can } from "@/lib/permissions";
import { counterpartyLabel, formatDateTime, formatDuration } from "@/lib/format";
import { LoadFailure, PageShell } from "@/components/PageShell";
import { CallTypeBadge } from "@/components/CallTypeBadge";
import { CallStatusBadge } from "@/components/CallStatusBadge";
import { Card } from "@/components/ui";

export default async function CallDetailPage({ params }: { params: { id: string } }) {
  try {
    const [call, me] = await Promise.all([api.getCall(params.id), api.me()]);
    const conversation = call.conversation;
    const transcript = conversation?.transcript ?? [];
    // The lead link is a Sales-module feature; a call itself never requires a lead.
    // The agent's name is shown to everyone who can see the call; the editor link only to roles that may read agents.
    const canOpenAgent = can(me.organization?.role, "agents:read");
    const leadLink = call.leadId && hasModule(me.organization, "sales") ? `/leads/${call.leadId}` : null;

    return (
      <PageShell>
        <Link href="/calls" className="inline-flex items-center gap-1 text-sm text-stone-500 transition hover:text-stone-800">
          <ChevronLeft size={14} />
          Calls
        </Link>

        <section className="mt-4 flex flex-wrap items-start justify-between gap-4 rounded-xl border border-stone-200 bg-white p-6">
          <div>
            <h1 className="text-xl font-semibold text-stone-900">Call {call.id.slice(0, 8)}</h1>
            <p className="mt-1 text-sm text-stone-500">
              {formatDateTime(call.startedAt ?? call.createdAt)} · {formatDuration(call.startedAt, call.endedAt)}
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-stone-600">
              <CallTypeBadge type={call.callType} />
              <span>
                With <span className="font-medium text-stone-900">{counterpartyLabel(call)}</span>
              </span>
              {call.agent && (
                <span>
                  · Agent{" "}
                  {canOpenAgent ? (
                    <Link href={`/agents/${call.agent.id}`} className="font-medium text-emerald-700 hover:text-emerald-800">
                      {call.agent.name}
                    </Link>
                  ) : (
                    <span className="font-medium text-stone-900">{call.agent.name}</span>
                  )}{" "}
                  ({call.agent.personaName})
                </span>
              )}
            </p>
            {leadLink && (
              <Link href={leadLink} className="mt-2 inline-block text-sm font-medium text-emerald-700 hover:text-emerald-800">
                View lead
              </Link>
            )}
          </div>
          <CallStatusBadge status={call.status} />
        </section>

        <div className="mt-6 space-y-6">
          <Card title="Summary">
            <p className="text-sm text-stone-700">{conversation?.summary ?? "No summary yet."}</p>
            {conversation?.qualification?.recommendedNextAction && (
              <p className="mt-3 text-sm text-stone-500">
                Recommended next action: {conversation.qualification.recommendedNextAction}
              </p>
            )}
          </Card>

          <Card title="Transcript">
            {transcript.length === 0 ? (
              <p className="text-sm text-stone-500">No transcript recorded.</p>
            ) : (
              <ol className="space-y-3">
                {transcript.map((t, i) => (
                  <li key={i} className="text-sm">
                    <span className="mr-2 text-xs font-semibold uppercase tracking-wide text-stone-400">
                      {t.speaker === "ai" ? "Agent" : "Caller"}
                    </span>
                    <span className="text-stone-800">{t.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </PageShell>
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) notFound();
    return (
      <PageShell title="Call">
        <LoadFailure err={err} what="Call" />
      </PageShell>
    );
  }
}
