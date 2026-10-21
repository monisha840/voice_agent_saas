import type { CallStatus } from "@/lib/types";
import { Badge } from "@/components/ui";

const TONE = {
  initiating: "info",
  ringing: "info",
  in_progress: "info",
  completed: "success",
  failed: "error",
} as const;

export function CallStatusBadge({ status }: { status: CallStatus }) {
  return <Badge tone={TONE[status] ?? "neutral"}>{status.replace(/_/g, " ")}</Badge>;
}
