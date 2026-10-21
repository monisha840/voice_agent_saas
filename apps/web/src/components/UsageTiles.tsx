import { Bot, Calendar, Clock, PhoneCall } from "lucide-react";
import type { UsageSummary } from "@/lib/types";

/** The usage totals. Site visits are a Sales-module metric, so they only show when `showSiteVisits` is set. */
export function UsageTiles({ usage, showSiteVisits }: { usage: UsageSummary; showSiteVisits: boolean }) {
  const tiles = [
    { label: "Calls", value: usage.totals.calls, icon: PhoneCall },
    { label: "Minutes", value: Math.round(usage.totals.callSeconds / 60), icon: Clock },
    { label: "AI replies", value: usage.totals.aiTurns, icon: Bot },
    ...(showSiteVisits ? [{ label: "Site visits", value: usage.totals.siteVisits, icon: Calendar }] : []),
  ];
  return (
    <div className={`grid grid-cols-2 gap-4 ${tiles.length === 4 ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
      {tiles.map((t) => (
        <div key={t.label} className="rounded-xl border border-stone-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium uppercase tracking-wide text-stone-400">{t.label}</span>
            <t.icon size={14} className="text-stone-300" />
          </div>
          <div className="mt-2 text-3xl font-semibold tabular-nums text-stone-900">{t.value.toLocaleString("en-IN")}</div>
        </div>
      ))}
    </div>
  );
}
