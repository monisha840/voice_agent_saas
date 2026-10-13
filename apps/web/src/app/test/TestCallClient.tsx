"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { AgentOption, CallDetail, Lead, LeadDetail } from "@/lib/types";
import { Button, Card, Field, Notice, errorMessage, inputClass } from "@/components/ui";
import { CallExperience } from "@/components/CallExperience";
import { CallStatusBadge } from "@/components/CallStatusBadge";
import { EmptyState, LoadingState } from "@/components/StateViews";
import { WebCallRun } from "./WebCallRun";

type Target = "simulated" | "phone" | "lead" | "web";
// Temporary browser channel: hidden unless NEXT_PUBLIC_WEB_CALL_ENABLED=true (and the API has WEB_CALL_ENABLED=true).
const WEB_CALL_ENABLED = process.env.NEXT_PUBLIC_WEB_CALL_ENABLED === "true";
const POLL_MS = 2000;

export function TestCallClient({ agents, leads, sales }: { agents: AgentOption[]; leads: Lead[]; sales: boolean }) {
  const [agentId, setAgentId] = useState(agents[0]?.id ?? "") // the API lists the default agent first;
  const [target, setTarget] = useState<Target>("simulated");

  if (agents.length === 0) {
    return (
      <Card>
        <EmptyState
          title="No agents available"
          description="Create an active agent in Agents first, or ask an admin if you cannot see any."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card title="Call setup">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Agent">
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className={inputClass}>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.personaName})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Target">
            <select value={target} onChange={(e) => setTarget(e.target.value as Target)} className={inputClass}>
              <option value="simulated">Simulated call (no phone number)</option>
              {WEB_CALL_ENABLED && <option value="web">Web call (your microphone)</option>}
              <option value="phone">Phone number</option>
              {sales && <option value="lead">Lead</option>}
            </select>
          </Field>
        </div>
      </Card>

      {target === "lead" ? (
        <LeadTarget key={agentId} agentId={agentId} leads={leads} />
      ) : target === "web" ? (
        <WebCallRun key={agentId} agentId={agentId} />
      ) : (
        // Re-mount when the agent or target changes so a finished run never leaks across settings.
        <DirectRun key={`${agentId}:${target}`} agentId={agentId} withNumber={target === "phone"} />
      )}
    </div>
  );
}

function DirectRun({ agentId, withNumber }: { agentId: string; withNumber: boolean }) {
  const [toNumber, setToNumber] = useState("");
  const [call, setCall] = useState<CallDetail | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  function stop() {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  }
  useEffect(() => stop, []);

  function poll(id: string) {
    stop();
    const tick = async () => {
      try {
        const latest = await api.getCall(id);
        setCall(latest);
        if (latest.status === "completed" || latest.status === "failed") stop();
      } catch {
        // Transient poll failure; keep polling.
      }
    };
    void tick();
    timer.current = setInterval(() => void tick(), POLL_MS);
  }

  async function start() {
    setError(null);
    if (withNumber && !toNumber.trim()) {
      setError("Enter a phone number to call.");
      return;
    }
    setStarting(true);
    setCall(null);
    try {
      const res = await api.createCall({
        agentId,
        callType: "test",
        ...(withNumber ? { toNumber: toNumber.trim() } : {}),
      });
      setCallId(res.callId);
      poll(res.callId);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setStarting(false);
    }
  }

  const finished = call?.status === "completed" || call?.status === "failed";
  const running = callId !== null && !finished;
  const transcript = call?.conversation?.transcript ?? [];

  return (
    <div className="space-y-6">
      <Card title={withNumber ? "Phone number" : "Simulated call"}>
        <div className="space-y-4">
          {withNumber ? (
            <Field label="Phone number" hint="Include the country code, for example +91…" className="block w-full sm:w-80">
              <input
                type="tel"
                value={toNumber}
                disabled={running}
                onChange={(e) => setToNumber(e.target.value)}
                className={inputClass}
              />
            </Field>
          ) : (
            <p className="text-sm text-stone-500">
              Runs a simulated conversation with the agent. No phone number or lead is needed.
            </p>
          )}
          <Button busy={starting} disabled={running} onClick={() => void start()}>
            {callId && finished ? "Run again" : "Start test call"}
          </Button>
        </div>
      </Card>

      {error && <Notice tone="error">{error}</Notice>}

      {callId && (
        <Card title="Live call" action={call ? <CallStatusBadge status={call.status} /> : undefined}>
          {!call ? (
            <LoadingState label="Starting call…" />
          ) : (
            <div className="space-y-3">
              {transcript.length === 0 ? (
                <p className="text-sm text-stone-500">
                  {finished ? "No transcript recorded." : "Waiting for the conversation…"}
                </p>
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
              {call.status === "failed" && <Notice tone="error">The call failed.</Notice>}
              {finished && (
                <Link
                  href={`/calls/${callId}`}
                  className="inline-block text-sm font-medium text-emerald-700 hover:text-emerald-800"
                >
                  Open call details
                </Link>
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function LeadTarget({ agentId, leads }: { agentId: string; leads: Lead[] }) {
  const [leadId, setLeadId] = useState(leads[0]?.id ?? "");
  const [detail, setDetail] = useState<LeadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!leadId) return;
    let cancelled = false;
    setDetail(null);
    setError(null);
    api
      .getLead(leadId)
      .then((d) => !cancelled && setDetail(d))
      .catch((err) => !cancelled && setError(errorMessage(err)));
    return () => {
      cancelled = true;
    };
  }, [leadId]);

  if (leads.length === 0) {
    return (
      <Card>
        <EmptyState title="No leads yet" description="Add a lead in the Sales module to place a test call to it." />
      </Card>
    );
  }

  const latestCall = detail?.callHistory[0] ?? null;

  return (
    <div className="space-y-6">
      <Card title="Lead">
        <Field label="Lead" className="w-full sm:w-80">
          <select value={leadId} onChange={(e) => setLeadId(e.target.value)} className={inputClass}>
            {leads.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name} · {l.phone}
              </option>
            ))}
          </select>
        </Field>
      </Card>

      {error && <Notice tone="error">{error}</Notice>}
      {!detail && !error && <LoadingState label="Loading…" />}
      {detail && (
        <CallExperience
          key={`${detail.id}:${agentId}`}
          leadId={detail.id}
          agentId={agentId}
          initial={detail}
          onUpdated={setDetail}
        />
      )}

      {latestCall && (
        <p className="text-sm text-stone-500">
          Latest call:{" "}
          <Link href={`/calls/${latestCall.id}`} className="font-medium text-emerald-700 hover:text-emerald-800">
            open call details
          </Link>
        </p>
      )}
    </div>
  );
}
