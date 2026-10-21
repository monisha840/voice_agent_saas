/**
 * Small, dependency-free helpers for client data imports: a CSV reader and parsers for the way people actually
 * write prices and areas in India ("65,00,000", "₹65 lakh", "1.1 Cr", "1,200 sq ft").
 */

/** Parses CSV text (RFC 4180 quoting, CRLF or LF, optional BOM) into rows of cells. Blank lines are dropped. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== "")) rows.push(row.map((c) => c.trim()));
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"' && cell === "") quoted = true;
    else if (ch === ",") endCell();
    else if (ch === "\n") endRow();
    else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
}

/** A price in whole rupees from "6500000", "65,00,000", "₹65 lakh", "65L", "1.1 Cr"; null when it is not a price. */
export function parseIndianPrice(raw: string): number | null {
  const s = raw
    .toLowerCase()
    .replace(/[₹]|rs\.?|inr/g, "")
    .replace(/,/g, "")
    .trim();
  const m = /^(\d+(?:\.\d+)?)\s*(crores?|cr|lakhs?|lacs?|lac|l|k)?$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2];
  const factor = !unit ? 1 : unit.startsWith("c") ? 10_000_000 : unit === "k" ? 1_000 : 100_000;
  const value = Math.round(n * factor);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** A whole number of square feet from "1200", "1,200", "1200 sq ft"; null when it is not an area. */
export function parseAreaSqft(raw: string): number | null {
  const m = /^(\d[\d,]*(?:\.\d+)?)\s*(sq\.?\s*ft\.?|sqft|sft|square\s*feet)?$/i.exec(raw.trim());
  if (!m) return null;
  const n = Math.round(Number(m[1].replace(/,/g, "")));
  return Number.isFinite(n) && n > 0 ? n : null;
}
