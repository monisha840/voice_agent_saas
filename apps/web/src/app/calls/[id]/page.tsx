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

const SITE_VISIT_LABEL: Record<string, string> = {
  booked: "Booked",
  offered: "Offered",
  declined: "Declined",
  not_discussed: "Not discussed",
};

export default async function CallDetailPage({ params: paramsPromise }: { params: Promise<{ id: string }> }) {
  const params = await paramsPromise;
  try {
    const [call, me] = await Promise.all([api.getCall(params.id), api.me()]);
    const conversation = call.conversation;
    const transcript = conversation?.transcript ?? [];
    const qualification = conversation?.qualification ?? null;
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

        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <Card title="Call details">
            <dl className="space-y-2 text-sm">
              {(
                [
                  ["Placed", formatDateTime(call.createdAt)],
                  ["Answered", call.startedAt ? formatDateTime(call.startedAt) : "Not answered"],
                  ["Ended", call.endedAt ? formatDateTime(call.endedAt) : call.status === "completed" || call.status === "failed" ? "Not recorded" : "Still in progress"],
                  ["Talk time", call.startedAt && call.endedAt ? formatDuration(call.startedAt, call.endedAt) : "—"],
                  // Inbound only: the number the caller dialled. Older calls predate it, so it can be missing.
                  ...(call.callType === "inbound" ? ([["Line", call.lineNumber ?? "Not recorded"]] as const) : []),
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3">
                  <dt className="text-stone-500">{k}</dt>
                  <dd className="text-right text-stone-900">{v}</dd>
                </div>
              ))}
            </dl>
          </Card>

          <Card title="Outcome">
            {qualification ? (
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-500">Interest</dt>
                  <dd className="capitalize text-stone-900">{qualification.interestLevel}</dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-stone-500">Site visit</dt>
                  <dd className="text-stone-900">{SITE_VISIT_LABEL[qualification.siteVisitStatus] ?? qualification.siteVisitStatus}</dd>
                </div>
                {qualification.budget && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-stone-500">Budget</dt>
                    <dd className="text-right text-stone-900">{qualification.budget}</dd>
                  </div>
                )}
                <p className="pt-2 text-xs text-stone-400">From the post-call summary of this conversation.</p>
              </dl>
            ) : (
              <p className="text-sm text-stone-500">No outcome recorded for this call.</p>
            )}
            {leadLink && (
              <p className="mt-3 text-xs text-stone-500">
                Bookings made on the call are listed on the{" "}
                <Link href={leadLink} className="font-medium text-emerald-700 hover:text-emerald-800">
                  lead&apos;s page
                </Link>
                .
              </p>
            )}
          </Card>

          <Card title="Recording">
            {call.recordingUrl ? (
              <>
                <audio controls preload="none" src={call.recordingUrl} className="w-full">
                  <a href={call.recordingUrl}>Open recording</a>
                </audio>
                <p className="mt-2 text-xs text-stone-400">Hosted by your telephony provider.</p>
              </>
            ) : (
              <p className="text-sm text-stone-500">No recording was stored for this call.</p>
            )}
          </Card>
        </div>

        <div className="mt-6 space-y-6">
          <Card title="Summary">
            <p className="text-sm text-stone-700">{conversation?.summary ?? "No summary was recorded for this call."}</p>
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
