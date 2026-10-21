import type { CallType } from "@/lib/types";
import { Badge } from "@/components/ui";

const LABEL: Record<CallType, string> = { outbound: "Outbound", inbound: "Inbound", test: "Test" };
const TONE = { outbound: "info", inbound: "success", test: "neutral" } as const;

export function CallTypeBadge({ type }: { type?: CallType | null }) {
  if (!type) return null;
  return <Badge tone={TONE[type] ?? "neutral"}>{LABEL[type] ?? type}</Badge>;
}
