"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Phone, PhoneCall } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import type { LeadDetail } from "@/lib/types";
import { formatDuration } from "@/lib/format";

/**
 * Backend call states (apps/web/src/lib/types.ts CallStatus, sourced
 * from the calls table): "initiating" | "ringing" | "in_progress" |
 * "completed" | "failed". This component maps those 1:1 to the UI
 * copy the product spec asks for (Calling.../Connecting.../Live
 * Call/Call Completed) — it never shows a state the backend hasn't
 * actually reported.
 */
type UiCallState = "ready" | "calling" | "connecting" | "live" | "completed" | "failed";

const POLL_INTERVAL_MS = 2000;

export function CallExperience({
  leadId,
  initial,
  onUpdated,
}: {
  leadId: string;
  initial: LeadDetail;
  onUpdated: (lead: LeadDetail) => void;
}) {
  const [uiState, setUiState] = useState<UiCallState>(deriveState(initial));
  const [lead, setLead] = useState<LeadDetail>(initial);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPolling() {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }

  function startPolling() {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const latest = await api.getLead(leadId);
        setLead(latest);
        onUpdated(latest);
        const next = deriveState(latest);
        setUiState(next);
        if (next === "completed" || next === "failed") stopPolling();
      } catch {
        // Transient poll failure — keep polling rather than flashing an error.
      }
    }, POLL_INTERVAL_MS);
  }

  useEffect(() => stopPolling, []);

  async function handleCallLead() {
    setError(null);
    setUiState("calling");
    try {
      await api.callLead(leadId);
      startPolling();
    } catch (err) {
      setUiState("failed");
      if (err instanceof ApiError && err.code === "PROVIDER_NOT_CONFIGURED") {
        setError(
          "Telephony provider not configured on the server (Exotel credentials missing). Set TELEPHONY_PROVIDER=mock to demo without placing a real call.",
        );
      } else if (err instanceof Error) {
        setError(err.message);
      } else {
        setError("Call could not be started. Check the telephony configuration and try again.");
      }
    }
  }

  const isLive = uiState === "calling" || uiState === "connecting" || uiState === "live";

  if (isLive) {
    return <LiveCallPanel lead={lead} uiState={uiState} />;
  }

  return (
    <div className="rounded-xl border border-stone-200 bg-white p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-sm font-semibold text-stone-900">AI Voice Call</div>
          <div className="mt-0.5 text-sm text-stone-500">{readyLabel(uiState, lead)}</div>
        </div>
        <button
          onClick={handleCallLead}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-emerald-800"
        >
          <Phone size={16} />
          Call Lead
        </button>
      </div>
      {error && (
        <div className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-700">{error}</div>
      )}
    </div>
  );
}

function LiveCallPanel({ lead, uiState }: { lead: LeadDetail; uiState: UiCallState }) {
  const latestCall = lead.callHistory[0];
  const transcript = lead.latestConversation?.transcript ?? [];
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (uiState !== "live" || !latestCall?.startedAt) return;
    const startedAt = new Date(latestCall.startedAt).getTime();
    const tick = () => setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [uiState, latestCall?.startedAt]);

  const mins = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const secs = String(elapsed % 60).padStart(2, "0");

  return (
    <div className="fade-up overflow-hidden rounded-xl border border-emerald-200 bg-emerald-950 text-white">
      <div className="flex items-center justify-between border-b border-white/10 px-6 py-4">
        <div className="flex items-center gap-2">
          {uiState === "live" && <span className="live-dot h-2 w-2 rounded-full bg-emerald-400" />}
          <span className="text-xs font-semibold uppercase tracking-wide text-emerald-300">
            {uiState === "calling" && "Calling " + lead.name}
            {uiState === "connecting" && "Connecting"}
            {uiState === "live" && "Live Call"}
          </span>
        </div>
        {uiState === "live" && (
          <span className="font-mono text-sm tabular-nums text-emerald-200">
            {mins}:{secs}
          </span>
        )}
      </div>

      <div className="px-6 py-8 text-center">
        <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-emerald-800/60 ring-4 ring-emerald-700/40">
          {uiState === "live" ? (
            <PhoneCall size={26} className="text-emerald-300" />
          ) : (
            <Loader2 size={26} className="animate-spin text-emerald-300" />
          )}
        </div>

        <p className="mt-4 text-lg font-medium">
          {uiState === "calling" && "Dialing…"}
          {uiState === "connecting" && "Connecting…"}
          {uiState === "live" && (transcript.length === 0 ? "Listening for conversation…" : "Call in progress")}
        </p>
        <p className="mt-1 text-sm text-emerald-300/80">AI Agent · Priya</p>
      </div>

      {uiState === "live" && (
        <div className="max-h-64 overflow-y-auto border-t border-white/10 bg-emerald-900/40 px-6 py-4">
          {transcript.length === 0 ? (
            <p className="text-center text-sm text-emerald-300/70">Listening for conversation…</p>
          ) : (
            <ul className="space-y-2.5">
              {transcript.map((turn, i) => (
                <li key={i} className="text-sm leading-relaxed">
                  <span
                    className={`mr-2 font-semibold ${turn.speaker === "ai" ? "text-emerald-300" : "text-white"}`}
                  >
                    {turn.speaker === "ai" ? "Priya" : lead.name.split(" ")[0]}
                  </span>
                  <span className="text-emerald-50/90">{turn.text}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function readyLabel(uiState: UiCallState, lead: LeadDetail): string {
  if (uiState === "failed") return "Call could not be started. Check the telephony configuration and try again.";
  const latestCall = lead.callHistory[0];
  if (uiState === "completed" && latestCall) {
    return `Last call completed · ${formatDuration(latestCall.startedAt, latestCall.endedAt)}`;
  }
  return "Ready to call";
}

function deriveState(lead: LeadDetail): UiCallState {
  const latest = lead.callHistory[0];
  if (!latest) return "ready";
  switch (latest.status) {
    case "initiating":
      return "calling";
    case "ringing":
      return "connecting";
    case "in_progress":
      return "live";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "ready";
  }
}
