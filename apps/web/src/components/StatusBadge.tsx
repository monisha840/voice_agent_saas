import type { LeadStatus } from "@/lib/types";

/**
 * Semantic status groups, per the product's call-status visual system:
 * neutral / attention / active / success / error / muted. Deliberately
 * restrained — no rainbow of per-status colors.
 */
type Tone = "neutral" | "attention" | "active" | "success" | "error" | "muted";

const STATUS_TONE: Record<string, Tone> = {
  NEW: "neutral",
  CALLING: "attention",
  RINGING: "attention",
  NO_ANSWER: "attention",
  BUSY: "attention",
  RETRY: "attention",
  ANSWERED: "active",
  IN_PROGRESS: "active",
  QUALIFICATION: "active",
  INTERESTED: "success",
  VISIT_OFFERED: "active",
  VISIT_BOOKED: "success",
  CONFIRMED: "success",
  VISITED: "success",
  COMPLETED: "success",
  BOOKED: "success",
  NOT_INTERESTED: "muted",
  DNC: "muted",
  NO_SHOW: "error",
  FAILED: "error",
  FOLLOW_UP: "attention",
  CANCELLED: "muted",
};

const TONE_STYLES: Record<Tone, string> = {
  neutral: "bg-stone-100 text-stone-600 ring-1 ring-inset ring-stone-200",
  attention: "bg-amber-50 text-amber-700 ring-1 ring-inset ring-amber-200",
  active: "bg-blue-50 text-blue-700 ring-1 ring-inset ring-blue-200",
  success: "bg-emerald-50 text-emerald-700 ring-1 ring-inset ring-emerald-200",
  error: "bg-red-50 text-red-700 ring-1 ring-inset ring-red-200",
  muted: "bg-stone-100 text-stone-500 ring-1 ring-inset ring-stone-200",
};

export function StatusBadge({ status, className = "" }: { status: LeadStatus | string; className?: string }) {
  const key = status.toUpperCase();
  const tone = STATUS_TONE[key] ?? "neutral";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${TONE_STYLES[tone]} ${className}`}
    >
      {tone === "active" && <span className="live-dot h-1.5 w-1.5 rounded-full bg-blue-600" />}
      {status.replace(/_/g, " ")}
    </span>
  );
}
