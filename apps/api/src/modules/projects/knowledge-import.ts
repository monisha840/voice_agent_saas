/**
 * Turns a client's spreadsheet (exported as CSV) into project knowledge, so a client can be onboarded without an
 * engineer. Pure: it validates and shapes the rows; writing is the service's job. Bad rows are reported, never guessed.
 */
import { parseAreaSqft, parseCsv, parseIndianPrice } from "./csv.js";

export const IMPORT_KINDS = ["units", "faq"] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const MAX_IMPORT_ROWS = 500;

export interface ImportedUnit {
  type: string;
  areaSqft: number;
  plotNumber?: string;
  facing?: string;
  status?: "available" | "sold" | "hold";
  pricePerSqft?: number;
  price?: number;
}

export interface RejectedRow {
  /** 1-based line in the file (the header is line 1). */
  line: number;
  reason: string;
}

export interface UnitsImport {
  kind: "units";
  accepted: number;
  rejected: RejectedRow[];
  units: ImportedUnit[];
  /** Price ranges per unit type (only when there are few enough distinct types to be useful). */
  ranges: Array<{ type: string; min: number; max: number }>;
  perSqft?: { min: number; max: number };
}

export interface FaqImport {
  kind: "faq";
  accepted: number;
  rejected: RejectedRow[];
  items: Array<{ question: string; answer: string }>;
}

const key = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

const ALIASES: Record<string, string[]> = {
  type: ["type", "unit", "unittype", "configuration", "plottype", "name"],
  area: ["area", "areasqft", "sqft", "areainsqft", "plotarea", "builtup"],
  plotNumber: ["plot", "plotno", "plotnumber", "plotid", "unitno", "unitnumber"],
  facing: ["facing", "direction"],
  status: ["status", "availability"],
  price: ["price", "totalprice", "cost"],
  priceMin: ["pricemin", "minprice", "min"],
  priceMax: ["pricemax", "maxprice", "max"],
  pricePerSqft: ["pricepersqft", "persqft", "rate", "ratepersqft"],
  question: ["question", "q", "faq"],
  answer: ["answer", "a", "reply"],
};

function columnMap(header: string[]): Map<string, number> {
  const out = new Map<string, number>();
  header.forEach((h, i) => {
    const k = key(h);
    for (const [field, names] of Object.entries(ALIASES)) {
      if (names.includes(k) && !out.has(field)) out.set(field, i);
    }
  });
  return out;
}

function normaliseStatus(raw: string): ImportedUnit["status"] | null {
  const s = raw.toLowerCase().trim();
  if (["available", "avail", "open", "free", "unsold"].includes(s)) return "available";
  if (["sold", "booked", "registered"].includes(s)) return "sold";
  if (["hold", "blocked", "reserved", "on hold"].includes(s)) return "hold";
  return null;
}

export function importUnitsCsv(csv: string): UnitsImport {
  const rows = parseCsv(csv);
  const result: UnitsImport = { kind: "units", accepted: 0, rejected: [], units: [], ranges: [] };
  if (rows.length < 2) {
    result.rejected.push({ line: 1, reason: "needs a header row and at least one data row" });
    return result;
  }
  const cols = columnMap(rows[0]);
  if (!cols.has("area") || (!cols.has("type") && !cols.has("plotNumber"))) {
    result.rejected.push({ line: 1, reason: "header must include an area column and a type or plot-number column" });
    return result;
  }
  const cell = (r: string[], f: string) => (cols.has(f) ? (r[cols.get(f)!] ?? "").trim() : "");

  for (let i = 1; i < rows.length; i++) {
    const line = i + 1;
    if (result.units.length >= MAX_IMPORT_ROWS) {
      result.rejected.push({ line, reason: `more than ${MAX_IMPORT_ROWS} rows; the rest were not imported` });
      break;
    }
    const r = rows[i];
    if (r.length > rows[0].length) {
      result.rejected.push({ line, reason: "more cells than the header (a number such as 2,500 must be in quotes)" });
      continue;
    }
    const plotNumber = cell(r, "plotNumber");
    const type = cell(r, "type") || (plotNumber ? `Plot ${plotNumber}` : "");
    if (!type) {
      result.rejected.push({ line, reason: "no type or plot number" });
      continue;
    }
    const area = parseAreaSqft(cell(r, "area"));
    if (area === null) {
      result.rejected.push({ line, reason: `area "${cell(r, "area")}" is not a number of square feet` });
      continue;
    }

    const unit: ImportedUnit = { type: type.slice(0, 200), areaSqft: area };
    if (plotNumber) unit.plotNumber = plotNumber.slice(0, 200);
    const facing = cell(r, "facing");
    if (facing) unit.facing = facing.slice(0, 200);

    const statusRaw = cell(r, "status");
    if (statusRaw) {
      const status = normaliseStatus(statusRaw);
      if (!status) {
        result.rejected.push({ line, reason: `status "${statusRaw}" is not available, sold or hold` });
        continue;
      }
      unit.status = status;
    }

    let bad: string | null = null;
    for (const [field, prop] of [["price", "price"], ["pricePerSqft", "pricePerSqft"]] as const) {
      const raw = cell(r, field);
      if (!raw) continue;
      const v = parseIndianPrice(raw);
      if (v === null) bad = `${field} "${raw}" is not a price`;
      else unit[prop] = v;
    }
    if (bad) {
      result.rejected.push({ line, reason: bad });
      continue;
    }
    const min = cell(r, "priceMin");
    const max = cell(r, "priceMax");
    if (min || max) {
      const lo = parseIndianPrice(min);
      const hi = parseIndianPrice(max);
      if (lo === null || hi === null || hi < lo) {
        result.rejected.push({ line, reason: `price range "${min}"–"${max}" is not valid` });
        continue;
      }
      // A range row has no single price; its bounds feed the type's range below.
      (unit as ImportedUnit & { _min?: number; _max?: number })._min = lo;
      (unit as ImportedUnit & { _min?: number; _max?: number })._max = hi;
    }
    result.units.push(unit);
  }

  // Ranges per unit type, from each row's own price (or rate x area, or its stated range).
  const byType = new Map<string, { min: number; max: number }>();
  const rates: number[] = [];
  for (const raw of result.units) {
    const u = raw as ImportedUnit & { _min?: number; _max?: number };
    const lo = u._min ?? u.price ?? (u.pricePerSqft ? Math.round(u.pricePerSqft * u.areaSqft) : undefined);
    const hi = u._max ?? lo;
    delete u._min;
    delete u._max;
    if (u.pricePerSqft) rates.push(u.pricePerSqft);
    if (lo === undefined || hi === undefined) continue;
    const cur = byType.get(u.type);
    byType.set(u.type, cur ? { min: Math.min(cur.min, lo), max: Math.max(cur.max, hi) } : { min: lo, max: hi });
  }
  if (byType.size > 0 && byType.size <= 50) {
    result.ranges = [...byType].map(([type, v]) => ({ type, ...v }));
  }
  if (rates.length > 0) result.perSqft = { min: Math.min(...rates), max: Math.max(...rates) };
  result.accepted = result.units.length;
  return result;
}

export function importFaqCsv(csv: string): FaqImport {
  const rows = parseCsv(csv);
  const result: FaqImport = { kind: "faq", accepted: 0, rejected: [], items: [] };
  if (rows.length < 2) {
    result.rejected.push({ line: 1, reason: "needs a header row and at least one data row" });
    return result;
  }
  const cols = columnMap(rows[0]);
  if (!cols.has("question") || !cols.has("answer")) {
    result.rejected.push({ line: 1, reason: "header must include question and answer columns" });
    return result;
  }
  for (let i = 1; i < rows.length; i++) {
    const line = i + 1;
    if (rows[i].length > rows[0].length) {
      result.rejected.push({ line, reason: "more cells than the header (text containing a comma must be in quotes)" });
      continue;
    }
    const question = (rows[i][cols.get("question")!] ?? "").trim();
    const answer = (rows[i][cols.get("answer")!] ?? "").trim();
    if (!question || !answer) {
      result.rejected.push({ line, reason: "question and answer are both required" });
      continue;
    }
    if (result.items.length >= 100) {
      result.rejected.push({ line, reason: "more than 100 questions; the rest were not imported" });
      break;
    }
    result.items.push({ question: question.slice(0, 500), answer: answer.slice(0, 2000) });
  }
  result.accepted = result.items.length;
  return result;
}
