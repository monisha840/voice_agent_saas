"use client";

import { useState, type ComponentType } from "react";
import { Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import type { KnowledgeCategory, ProjectKnowledge } from "@/lib/types";
import { KNOWLEDGE_CATEGORIES } from "@/lib/types";
import { Badge, Button, Field, Notice, errorMessage, inputClass } from "@/components/ui";

/* ---------- helpers: API content <-> editable form state ---------- */

type Obj = Record<string, unknown>;
const obj = (x: unknown): Obj => (x && typeof x === "object" ? (x as Obj) : {});
const str = (x: unknown): string => (typeof x === "string" ? x : x == null ? "" : String(x));
const strList = (x: unknown): string[] => (Array.isArray(x) ? x.map(str) : []);
const rows = (x: unknown): Obj[] => (Array.isArray(x) ? x.map(obj) : []);

function num(value: string, label: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n)) throw new Error(`${label}: enter a valid number.`);
  return n;
}
function optNum(value: string, label: string): number | undefined {
  return value.trim() === "" ? undefined : num(value, label);
}
/** Drops empty optional strings so the API does not receive "" for absent fields. */
const opt = (value: string): string | undefined => (value.trim() === "" ? undefined : value.trim());
const compact = <T extends Obj>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
const cleanList = (l: string[]) => l.map((s) => s.trim()).filter(Boolean);

interface FormProps<T> {
  value: T;
  onChange: (v: T) => void;
  disabled: boolean;
}

interface Spec<T> {
  title: string;
  hint: string;
  empty: T;
  parse: (content: unknown) => T;
  serialize: (v: T) => unknown;
  Form: ComponentType<FormProps<T>>;
}

/* ---------- reusable row editors ---------- */

function StringList({
  items,
  onChange,
  disabled,
  placeholder,
  addLabel,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  disabled: boolean;
  placeholder: string;
  addLabel: string;
}) {
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex gap-2">
          <input
            value={item}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
            className={inputClass}
          />
          {!disabled && (
            <Button variant="ghost" aria-label="Remove" onClick={() => onChange(items.filter((_, j) => j !== i))}>
              <Trash2 size={14} />
            </Button>
          )}
        </div>
      ))}
      {!disabled && (
        <Button variant="secondary" onClick={() => onChange([...items, ""])}>
          <Plus size={14} />
          {addLabel}
        </Button>
      )}
    </div>
  );
}

function AddRow({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <Button variant="secondary" onClick={onClick}>
      <Plus size={14} />
      {label}
    </Button>
  );
}

function RemoveRow({ onClick }: { onClick: () => void }) {
  return (
    <Button variant="ghost" aria-label="Remove row" onClick={onClick}>
      <Trash2 size={14} />
    </Button>
  );
}

const replaceAt = <T,>(list: T[], i: number, patch: Partial<T>) =>
  list.map((x, j) => (j === i ? { ...x, ...patch } : x));

/* ---------- per-category specs ---------- */

interface PricingState {
  currency: string;
  ranges: { type: string; min: string; max: string }[];
  notes: string;
}
const pricing: Spec<PricingState> = {
  title: "Pricing",
  hint: "Price range per configuration type.",
  empty: { currency: "INR", ranges: [{ type: "", min: "", max: "" }], notes: "" },
  parse: (c) => ({
    currency: str(obj(c).currency) || "INR",
    ranges: rows(obj(c).ranges).map((r) => ({ type: str(r.type), min: str(r.min), max: str(r.max) })),
    notes: str(obj(c).notes),
  }),
  serialize: (v) =>
    compact({
      currency: v.currency.trim(),
      ranges: v.ranges.map((r, i) => ({
        type: r.type.trim(),
        min: num(r.min, `Range ${i + 1} min`),
        max: num(r.max, `Range ${i + 1} max`),
      })),
      notes: opt(v.notes),
    }),
  Form: ({ value, onChange, disabled }) => (
    <div className="space-y-3">
      <Field label="Currency" className="max-w-[10rem]">
        <input disabled={disabled} value={value.currency} onChange={(e) => onChange({ ...value, currency: e.target.value })} className={inputClass} />
      </Field>
      {value.ranges.map((r, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <input disabled={disabled} placeholder="Type (e.g. 2 BHK)" value={r.type} onChange={(e) => onChange({ ...value, ranges: replaceAt(value.ranges, i, { type: e.target.value }) })} className={inputClass} />
          <input disabled={disabled} inputMode="decimal" placeholder="Min price" value={r.min} onChange={(e) => onChange({ ...value, ranges: replaceAt(value.ranges, i, { min: e.target.value }) })} className={inputClass} />
          <input disabled={disabled} inputMode="decimal" placeholder="Max price" value={r.max} onChange={(e) => onChange({ ...value, ranges: replaceAt(value.ranges, i, { max: e.target.value }) })} className={inputClass} />
          {!disabled && <RemoveRow onClick={() => onChange({ ...value, ranges: value.ranges.filter((_, j) => j !== i) })} />}
        </div>
      ))}
      {!disabled && <AddRow label="Add range" onClick={() => onChange({ ...value, ranges: [...value.ranges, { type: "", min: "", max: "" }] })} />}
      <Field label="Notes (optional)">
        <textarea disabled={disabled} rows={2} value={value.notes} onChange={(e) => onChange({ ...value, notes: e.target.value })} className={inputClass} />
      </Field>
    </div>
  ),
};

interface ConfigurationsState {
  units: { type: string; areaSqft: string }[];
}
const configurations: Spec<ConfigurationsState> = {
  title: "Configurations",
  hint: "Unit types and their area.",
  empty: { units: [{ type: "", areaSqft: "" }] },
  parse: (c) => ({ units: rows(obj(c).units).map((u) => ({ type: str(u.type), areaSqft: str(u.areaSqft) })) }),
  serialize: (v) => ({
    units: v.units.map((u, i) => ({ type: u.type.trim(), areaSqft: num(u.areaSqft, `Unit ${i + 1} area`) })),
  }),
  Form: ({ value, onChange, disabled }) => (
    <div className="space-y-3">
      {value.units.map((u, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <input disabled={disabled} placeholder="Type (e.g. 3 BHK)" value={u.type} onChange={(e) => onChange({ units: replaceAt(value.units, i, { type: e.target.value }) })} className={inputClass} />
          <input disabled={disabled} inputMode="decimal" placeholder="Area (sq ft)" value={u.areaSqft} onChange={(e) => onChange({ units: replaceAt(value.units, i, { areaSqft: e.target.value }) })} className={inputClass} />
          {!disabled && <RemoveRow onClick={() => onChange({ units: value.units.filter((_, j) => j !== i) })} />}
        </div>
      ))}
      {!disabled && <AddRow label="Add unit type" onClick={() => onChange({ units: [...value.units, { type: "", areaSqft: "" }] })} />}
    </div>
  ),
};

interface AmenitiesState {
  items: string[];
}
const amenities: Spec<AmenitiesState> = {
  title: "Amenities",
  hint: "Facilities available at the project.",
  empty: { items: [""] },
  parse: (c) => ({ items: strList(obj(c).items) }),
  serialize: (v) => ({ items: cleanList(v.items) }),
  Form: ({ value, onChange, disabled }) => (
    <StringList items={value.items} onChange={(items) => onChange({ items })} disabled={disabled} placeholder="e.g. Swimming pool" addLabel="Add amenity" />
  ),
};

interface PossessionState {
  expectedDate: string;
  notes: string;
}
const possession: Spec<PossessionState> = {
  title: "Possession",
  hint: "Expected handover date.",
  empty: { expectedDate: "", notes: "" },
  parse: (c) => ({ expectedDate: str(obj(c).expectedDate), notes: str(obj(c).notes) }),
  serialize: (v) => compact({ expectedDate: v.expectedDate, notes: opt(v.notes) }),
  Form: ({ value, onChange, disabled }) => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Expected date">
        <input type="date" disabled={disabled} value={value.expectedDate} onChange={(e) => onChange({ ...value, expectedDate: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Notes (optional)">
        <input disabled={disabled} value={value.notes} onChange={(e) => onChange({ ...value, notes: e.target.value })} className={inputClass} />
      </Field>
    </div>
  ),
};

interface LocationState {
  address: string;
  landmarks: string[];
}
const location: Spec<LocationState> = {
  title: "Location",
  hint: "Address and nearby landmarks.",
  empty: { address: "", landmarks: [""] },
  parse: (c) => ({ address: str(obj(c).address), landmarks: strList(obj(c).landmarks) }),
  serialize: (v) => ({ address: v.address.trim(), landmarks: cleanList(v.landmarks) }),
  Form: ({ value, onChange, disabled }) => (
    <div className="space-y-3">
      <Field label="Address">
        <textarea disabled={disabled} rows={2} value={value.address} onChange={(e) => onChange({ ...value, address: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Landmarks">
        <StringList items={value.landmarks} onChange={(landmarks) => onChange({ ...value, landmarks })} disabled={disabled} placeholder="e.g. 5 min from metro station" addLabel="Add landmark" />
      </Field>
    </div>
  ),
};

interface FaqState {
  items: { question: string; answer: string }[];
}
const faq: Spec<FaqState> = {
  title: "FAQ",
  hint: "Questions buyers commonly ask, with the answers the agent should give.",
  empty: { items: [{ question: "", answer: "" }] },
  parse: (c) => ({ items: rows(obj(c).items).map((r) => ({ question: str(r.question), answer: str(r.answer) })) }),
  serialize: (v) => ({ items: v.items.map((r) => ({ question: r.question.trim(), answer: r.answer.trim() })) }),
  Form: ({ value, onChange, disabled }) => (
    <div className="space-y-3">
      {value.items.map((r, i) => (
        <div key={i} className="space-y-2 rounded-md border border-stone-200 p-3">
          <input disabled={disabled} placeholder="Question" value={r.question} onChange={(e) => onChange({ items: replaceAt(value.items, i, { question: e.target.value }) })} className={inputClass} />
          <textarea disabled={disabled} rows={2} placeholder="Answer" value={r.answer} onChange={(e) => onChange({ items: replaceAt(value.items, i, { answer: e.target.value }) })} className={inputClass} />
          {!disabled && (
            <Button variant="ghost" onClick={() => onChange({ items: value.items.filter((_, j) => j !== i) })}>
              <Trash2 size={14} />
              Remove
            </Button>
          )}
        </div>
      ))}
      {!disabled && <AddRow label="Add question" onClick={() => onChange({ items: [...value.items, { question: "", answer: "" }] })} />}
    </div>
  ),
};

interface ReraState {
  registrationNumber: string;
  authority: string;
  notes: string;
}
const rera: Spec<ReraState> = {
  title: "RERA",
  hint: "Regulatory registration details.",
  empty: { registrationNumber: "", authority: "", notes: "" },
  parse: (c) => ({
    registrationNumber: str(obj(c).registrationNumber),
    authority: str(obj(c).authority),
    notes: str(obj(c).notes),
  }),
  serialize: (v) =>
    compact({ registrationNumber: v.registrationNumber.trim(), authority: opt(v.authority), notes: opt(v.notes) }),
  Form: ({ value, onChange, disabled }) => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Registration number">
        <input disabled={disabled} value={value.registrationNumber} onChange={(e) => onChange({ ...value, registrationNumber: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Authority (optional)">
        <input disabled={disabled} value={value.authority} onChange={(e) => onChange({ ...value, authority: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Notes (optional)" className="sm:col-span-2">
        <textarea disabled={disabled} rows={2} value={value.notes} onChange={(e) => onChange({ ...value, notes: e.target.value })} className={inputClass} />
      </Field>
    </div>
  ),
};

interface LoanState {
  assistanceAvailable: boolean;
  banks: string[];
  notes: string;
}
const loan: Spec<LoanState> = {
  title: "Home loan",
  hint: "Loan assistance and partner banks.",
  empty: { assistanceAvailable: true, banks: [], notes: "" },
  parse: (c) => ({
    assistanceAvailable: obj(c).assistanceAvailable !== false,
    banks: strList(obj(c).banks),
    notes: str(obj(c).notes),
  }),
  serialize: (v) =>
    compact({
      assistanceAvailable: v.assistanceAvailable,
      banks: cleanList(v.banks).length ? cleanList(v.banks) : undefined,
      notes: opt(v.notes),
    }),
  Form: ({ value, onChange, disabled }) => (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-stone-700">
        <input type="checkbox" disabled={disabled} checked={value.assistanceAvailable} onChange={(e) => onChange({ ...value, assistanceAvailable: e.target.checked })} className="h-4 w-4 accent-emerald-700" />
        Loan assistance available
      </label>
      <Field label="Partner banks (optional)">
        <StringList items={value.banks} onChange={(banks) => onChange({ ...value, banks })} disabled={disabled} placeholder="e.g. HDFC" addLabel="Add bank" />
      </Field>
      <Field label="Notes (optional)">
        <textarea disabled={disabled} rows={2} value={value.notes} onChange={(e) => onChange({ ...value, notes: e.target.value })} className={inputClass} />
      </Field>
    </div>
  ),
};

interface BookingState {
  bookingAmount: string;
  currency: string;
  paymentPlan: string;
  notes: string;
}
const booking: Spec<BookingState> = {
  title: "Booking",
  hint: "Booking amount and payment plan.",
  empty: { bookingAmount: "", currency: "INR", paymentPlan: "", notes: "" },
  parse: (c) => ({
    bookingAmount: str(obj(c).bookingAmount),
    currency: str(obj(c).currency) || "INR",
    paymentPlan: str(obj(c).paymentPlan),
    notes: str(obj(c).notes),
  }),
  serialize: (v) =>
    compact({
      bookingAmount: optNum(v.bookingAmount, "Booking amount"),
      currency: opt(v.currency),
      paymentPlan: opt(v.paymentPlan),
      notes: opt(v.notes),
    }),
  Form: ({ value, onChange, disabled }) => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Booking amount (optional)">
        <input disabled={disabled} inputMode="decimal" value={value.bookingAmount} onChange={(e) => onChange({ ...value, bookingAmount: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Currency">
        <input disabled={disabled} value={value.currency} onChange={(e) => onChange({ ...value, currency: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Payment plan (optional)" className="sm:col-span-2">
        <input disabled={disabled} value={value.paymentPlan} onChange={(e) => onChange({ ...value, paymentPlan: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Notes (optional)" className="sm:col-span-2">
        <textarea disabled={disabled} rows={2} value={value.notes} onChange={(e) => onChange({ ...value, notes: e.target.value })} className={inputClass} />
      </Field>
    </div>
  ),
};

interface MaintenanceState {
  chargesPerSqftPerMonth: string;
  currency: string;
  notes: string;
}
const maintenance: Spec<MaintenanceState> = {
  title: "Maintenance",
  hint: "Monthly maintenance charges.",
  empty: { chargesPerSqftPerMonth: "", currency: "INR", notes: "" },
  parse: (c) => ({
    chargesPerSqftPerMonth: str(obj(c).chargesPerSqftPerMonth),
    currency: str(obj(c).currency) || "INR",
    notes: str(obj(c).notes),
  }),
  serialize: (v) =>
    compact({
      chargesPerSqftPerMonth: optNum(v.chargesPerSqftPerMonth, "Charges"),
      currency: opt(v.currency),
      notes: opt(v.notes),
    }),
  Form: ({ value, onChange, disabled }) => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Charges per sq ft per month (optional)">
        <input disabled={disabled} inputMode="decimal" value={value.chargesPerSqftPerMonth} onChange={(e) => onChange({ ...value, chargesPerSqftPerMonth: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Currency">
        <input disabled={disabled} value={value.currency} onChange={(e) => onChange({ ...value, currency: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Notes (optional)" className="sm:col-span-2">
        <textarea disabled={disabled} rows={2} value={value.notes} onChange={(e) => onChange({ ...value, notes: e.target.value })} className={inputClass} />
      </Field>
    </div>
  ),
};

const NEARBY_TYPES = ["school", "college", "hospital", "it_park", "office", "mall", "market", "metro", "railway", "bus", "airport", "highway", "temple", "park", "other"];

interface NearbyState {
  items: { name: string; type: string; distanceKm: string; travelMinutes: string }[];
}
const nearby: Spec<NearbyState> = {
  title: "Nearby places",
  hint: "Schools, hospitals, offices, transport and landmarks, with distance and travel time. The agent only names places listed here.",
  empty: { items: [{ name: "", type: "other", distanceKm: "", travelMinutes: "" }] },
  parse: (c) => ({
    items: rows(obj(c).items).map((r) => ({ name: str(r.name), type: str(r.type) || "other", distanceKm: str(r.distanceKm), travelMinutes: str(r.travelMinutes) })),
  }),
  serialize: (v) => ({
    items: v.items
      .filter((r) => r.name.trim() !== "")
      .map((r, i) =>
        compact({
          name: r.name.trim(),
          type: opt(r.type),
          distanceKm: optNum(r.distanceKm, `Place ${i + 1} distance`),
          travelMinutes: optNum(r.travelMinutes, `Place ${i + 1} travel time`),
        }),
      ),
  }),
  Form: ({ value, onChange, disabled }) => (
    <div className="space-y-3">
      {value.items.map((r, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_8rem_6rem_6rem_auto]">
          <input disabled={disabled} placeholder="Place name" value={r.name} onChange={(e) => onChange({ items: replaceAt(value.items, i, { name: e.target.value }) })} className={inputClass} />
          <select disabled={disabled} value={r.type} onChange={(e) => onChange({ items: replaceAt(value.items, i, { type: e.target.value }) })} className={inputClass}>
            {NEARBY_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace("_", " ")}
              </option>
            ))}
          </select>
          <input disabled={disabled} inputMode="decimal" placeholder="km" value={r.distanceKm} onChange={(e) => onChange({ items: replaceAt(value.items, i, { distanceKm: e.target.value }) })} className={inputClass} />
          <input disabled={disabled} inputMode="numeric" placeholder="minutes" value={r.travelMinutes} onChange={(e) => onChange({ items: replaceAt(value.items, i, { travelMinutes: e.target.value }) })} className={inputClass} />
          {!disabled && <RemoveRow onClick={() => onChange({ items: value.items.filter((_, j) => j !== i) })} />}
        </div>
      ))}
      {!disabled && <AddRow label="Add place" onClick={() => onChange({ items: [...value.items, { name: "", type: "other", distanceKm: "", travelMinutes: "" }] })} />}
    </div>
  ),
};

interface ApprovalsState {
  items: { authority: string; number: string; notes: string }[];
  notes: string;
}
const approvals: Spec<ApprovalsState> = {
  title: "Approvals",
  hint: "Authority approvals and registration numbers the agent may quote.",
  empty: { items: [{ authority: "", number: "", notes: "" }], notes: "" },
  parse: (c) => ({
    items: rows(obj(c).items).map((r) => ({ authority: str(r.authority), number: str(r.number), notes: str(r.notes) })),
    notes: str(obj(c).notes),
  }),
  serialize: (v) =>
    compact({
      items: v.items
        .filter((r) => r.authority.trim() !== "")
        .map((r) => compact({ authority: r.authority.trim(), number: opt(r.number), notes: opt(r.notes) })),
      notes: opt(v.notes),
    }),
  Form: ({ value, onChange, disabled }) => (
    <div className="space-y-3">
      {value.items.map((r, i) => (
        <div key={i} className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
          <input disabled={disabled} placeholder="Authority (e.g. DTCP)" value={r.authority} onChange={(e) => onChange({ ...value, items: replaceAt(value.items, i, { authority: e.target.value }) })} className={inputClass} />
          <input disabled={disabled} placeholder="Number" value={r.number} onChange={(e) => onChange({ ...value, items: replaceAt(value.items, i, { number: e.target.value }) })} className={inputClass} />
          <input disabled={disabled} placeholder="Notes" value={r.notes} onChange={(e) => onChange({ ...value, items: replaceAt(value.items, i, { notes: e.target.value }) })} className={inputClass} />
          {!disabled && <RemoveRow onClick={() => onChange({ ...value, items: value.items.filter((_, j) => j !== i) })} />}
        </div>
      ))}
      {!disabled && <AddRow label="Add approval" onClick={() => onChange({ ...value, items: [...value.items, { authority: "", number: "", notes: "" }] })} />}
      <Field label="Notes (optional)">
        <textarea disabled={disabled} rows={2} value={value.notes} onChange={(e) => onChange({ ...value, notes: e.target.value })} className={inputClass} />
      </Field>
    </div>
  ),
};

interface BuilderState {
  name: string;
  yearsInBusiness: string;
  completedProjects: string;
  notes: string;
}
const builder: Spec<BuilderState> = {
  title: "Builder",
  hint: "Who is building the project, and their track record.",
  empty: { name: "", yearsInBusiness: "", completedProjects: "", notes: "" },
  parse: (c) => ({
    name: str(obj(c).name),
    yearsInBusiness: str(obj(c).yearsInBusiness),
    completedProjects: str(obj(c).completedProjects),
    notes: str(obj(c).notes),
  }),
  serialize: (v) =>
    compact({
      name: v.name.trim(),
      yearsInBusiness: optNum(v.yearsInBusiness, "Years in business"),
      completedProjects: optNum(v.completedProjects, "Completed projects"),
      notes: opt(v.notes),
    }),
  Form: ({ value, onChange, disabled }) => (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Builder name" className="sm:col-span-2">
        <input disabled={disabled} value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Years in business (optional)">
        <input disabled={disabled} inputMode="numeric" value={value.yearsInBusiness} onChange={(e) => onChange({ ...value, yearsInBusiness: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Completed projects (optional)">
        <input disabled={disabled} inputMode="numeric" value={value.completedProjects} onChange={(e) => onChange({ ...value, completedProjects: e.target.value })} className={inputClass} />
      </Field>
      <Field label="Notes (optional)" className="sm:col-span-2">
        <textarea disabled={disabled} rows={2} value={value.notes} onChange={(e) => onChange({ ...value, notes: e.target.value })} className={inputClass} />
      </Field>
    </div>
  ),
};

interface AboutState {
  text: string;
}
const about: Spec<AboutState> = {
  title: "About the project",
  hint: "The project in the builder's own words (2-3 sentences). The agent uses it for tell-me-about-the-project questions.",
  empty: { text: "" },
  parse: (c) => ({ text: str(obj(c).text) }),
  serialize: (v) => ({ text: v.text.trim() }),
  Form: ({ value, onChange, disabled }) => (
    <Field label="Description">
      <textarea disabled={disabled} rows={4} maxLength={2000} value={value.text} onChange={(e) => onChange({ text: e.target.value })} className={inputClass} />
    </Field>
  ),
};

/* ---------- card shell with per-category save ---------- */

function KnowledgeCard<T>({
  spec,
  category,
  projectId,
  initial,
  canEdit,
}: {
  spec: Spec<T>;
  category: KnowledgeCategory;
  projectId: string;
  initial: unknown;
  canEdit: boolean;
}) {
  const [saved, setSaved] = useState(initial !== undefined);
  const [value, setValue] = useState<T>(initial !== undefined ? spec.parse(initial) : spec.empty);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.saveKnowledge(projectId, category, spec.serialize(value));
      setSaved(true);
      setNotice("Saved.");
    } catch (err) {
      setError(err instanceof Error && !("status" in err) ? err.message : errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm(`Remove the ${spec.title} information from this project?`)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.deleteKnowledge(projectId, category);
      setSaved(false);
      setValue(spec.empty);
      setNotice("Removed.");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-stone-200 bg-white p-5">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-stone-900">{spec.title}</h3>
        {saved ? <Badge tone="success">Saved</Badge> : <Badge>Not set</Badge>}
      </div>
      <p className="mb-4 text-xs text-stone-500">{spec.hint}</p>
      <spec.Form value={value} onChange={setValue} disabled={!canEdit || busy} />
      {error && (
        <div className="mt-3">
          <Notice tone="error">{error}</Notice>
        </div>
      )}
      {notice && !error && (
        <div className="mt-3">
          <Notice tone="success">{notice}</Notice>
        </div>
      )}
      {canEdit && (
        <div className="mt-4 flex gap-2">
          <Button busy={busy} onClick={() => void save()}>
            Save {spec.title}
          </Button>
          {saved && (
            <Button variant="danger" disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export function KnowledgeEditors({
  projectId,
  knowledge,
  canEdit,
}: {
  projectId: string;
  knowledge: ProjectKnowledge[];
  canEdit: boolean;
}) {
  const byCategory = new Map(knowledge.map((k) => [k.category, k.content]));
  const common = (c: KnowledgeCategory) => ({
    category: c,
    projectId,
    canEdit,
    initial: byCategory.get(c),
  });
  const cards: Record<KnowledgeCategory, React.ReactNode> = {
    pricing: <KnowledgeCard spec={pricing} {...common("pricing")} />,
    configurations: <KnowledgeCard spec={configurations} {...common("configurations")} />,
    amenities: <KnowledgeCard spec={amenities} {...common("amenities")} />,
    possession: <KnowledgeCard spec={possession} {...common("possession")} />,
    location: <KnowledgeCard spec={location} {...common("location")} />,
    faq: <KnowledgeCard spec={faq} {...common("faq")} />,
    rera: <KnowledgeCard spec={rera} {...common("rera")} />,
    loan: <KnowledgeCard spec={loan} {...common("loan")} />,
    booking: <KnowledgeCard spec={booking} {...common("booking")} />,
    maintenance: <KnowledgeCard spec={maintenance} {...common("maintenance")} />,
    nearby: <KnowledgeCard spec={nearby} {...common("nearby")} />,
    approvals: <KnowledgeCard spec={approvals} {...common("approvals")} />,
    builder: <KnowledgeCard spec={builder} {...common("builder")} />,
    about: <KnowledgeCard spec={about} {...common("about")} />,
  };
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {KNOWLEDGE_CATEGORIES.map((c) => (
        <div key={c} className={c === "faq" || c === "nearby" ? "lg:col-span-2" : ""}>
          {cards[c]}
        </div>
      ))}
    </div>
  );
}
