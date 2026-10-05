export function formatInrLakhsCrore(amount: number): string {
  if (amount >= 10_000_000) return `₹${(amount / 10_000_000).toFixed(amount % 10_000_000 === 0 ? 0 : 1)}Cr`;
  if (amount >= 100_000) return `₹${(amount / 100_000).toFixed(amount % 100_000 === 0 ? 0 : 1)}L`;
  return `₹${amount.toLocaleString("en-IN")}`;
}

export function formatBudgetRange(min: number | null, max: number | null): string {
  if (min == null && max == null) return "Not specified";
  if (min != null && max != null) return `${formatInrLakhsCrore(min)}–${formatInrLakhsCrore(max)}`;
  return formatInrLakhsCrore((min ?? max)!);
}

export function formatDuration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt || !endedAt) return "—";
  const seconds = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

export function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Lead-list "last activity" column. Deliberately derived only from data
 * that already exists on the lead (status + updatedAt) — the API does
 * not separately expose a "last activity" field, so this never invents
 * one; it just describes the same status transition the badge shows,
 * in plain language, with a relative timestamp.
 */
export function formatRelativeActivity(status: string, updatedAt: string): string {
  if (status === "NEW") return "No calls yet";
  return `Updated ${formatRelativeTime(updatedAt)}`;
}

function formatRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
