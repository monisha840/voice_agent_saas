"use client";

import { useState } from "react";

export interface DailyPoint {
  day: string; // YYYY-MM-DD
  value: number;
  /** Extra line shown in the tooltip and the table (e.g. "3 answered"). */
  detail?: string;
}

const W = 600;
const H = 140;
const PAD_TOP = 8;
const PAD_BOTTOM = 4;
const GAP = 2; // surface gap between adjacent bars
const BAR = "#047857"; // emerald-700: validated (lightness, chroma, contrast vs the light surface)

const dayLabel = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });

/** Bar with a 4px rounded top and a square end on the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(4, w / 2, h);
  const base = y + h;
  return `M${x},${base} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${base} Z`;
}

/**
 * One series per day as thin bars (single series: the title names it, no legend). Hover or focus a day for its exact
 * value; the same numbers are available as a table. Days with no data are real zeros, not gaps.
 */
export function DailyBarChart({ title, unit, points }: { title: string; unit: string; points: DailyPoint[] }) {
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...points.map((p) => p.value));
  const total = points.reduce((n, p) => n + p.value, 0);
  const slot = W / Math.max(1, points.length);
  const barW = Math.max(1, slot - GAP);
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const current = active !== null ? points[active] : null;

  return (
    <figure className="m-0">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-semibold text-stone-900">{title}</span>
        <span className="text-xs text-stone-500">
          {total} {unit} · max {max}/day
        </span>
      </figcaption>
      <div className="relative mt-3">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          className="h-36 w-full"
          role="img"
          aria-label={`${title}: ${total} ${unit} over ${points.length} days`}
          onMouseLeave={() => setActive(null)}
        >
          <line x1="0" x2={W} y1={H - PAD_BOTTOM} y2={H - PAD_BOTTOM} stroke="#e7e5e4" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {points.map((p, i) => {
            const h = p.value === 0 ? 0 : Math.max(2, (p.value / max) * plotH);
            const x = i * slot + GAP / 2;
            return (
              <g key={p.day}>
                {h > 0 && (
                  <path d={barPath(x, H - PAD_BOTTOM - h, barW, h)} fill={BAR} opacity={active === null || active === i ? 1 : 0.45} />
                )}
                {/* Hit target: the whole column, larger than the mark. */}
                <rect
                  x={i * slot}
                  y={0}
                  width={slot}
                  height={H}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${dayLabel(p.day)}: ${p.value} ${unit}${p.detail ? `, ${p.detail}` : ""}`}
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                />
              </g>
            );
          })}
        </svg>
        {current && active !== null && (
          <div
            className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-xs shadow-sm"
            style={{ left: `${((active + 0.5) / points.length) * 100}%` }}
          >
            <div className="font-medium text-stone-900">{dayLabel(current.day)}</div>
            <div className="text-stone-600">
              {current.value} {unit}
            </div>
            {current.detail && <div className="text-stone-500">{current.detail}</div>}
          </div>
        )}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-stone-400">
        <span>{points[0] ? dayLabel(points[0].day) : ""}</span>
        <span>{points.length ? dayLabel(points[points.length - 1].day) : ""}</span>
      </div>
      <details className="mt-2 text-xs text-stone-500">
        <summary className="cursor-pointer select-none hover:text-stone-700">View as table</summary>
        <table className="mt-2 w-full text-left">
          <thead className="text-stone-400">
            <tr>
              <th className="py-1 pr-4 font-medium">Day</th>
              <th className="py-1 pr-4 font-medium">{unit}</th>
              {points.some((p) => p.detail) && <th className="py-1 font-medium">Detail</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-stone-100 text-stone-700">
            {points.map((p) => (
              <tr key={p.day}>
                <td className="py-1 pr-4">{dayLabel(p.day)}</td>
                <td className="py-1 pr-4 tabular-nums">{p.value}</td>
                {points.some((q) => q.detail) && <td className="py-1">{p.detail ?? ""}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}
