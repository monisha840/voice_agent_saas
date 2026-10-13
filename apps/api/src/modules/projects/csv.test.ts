import { describe, it, expect } from "vitest";
import { parseAreaSqft, parseCsv, parseIndianPrice } from "./csv.js";
import { importFaqCsv, importUnitsCsv } from "./knowledge-import.js";

describe("parseCsv", () => {
  it("reads rows, quoted commas, escaped quotes, CRLF and a BOM", () => {
    const rows = parseCsv('﻿type,note\r\n"2 BHK","Near ""park"", east"\r\n3 BHK,plain\r\n');
    expect(rows).toEqual([
      ["type", "note"],
      ["2 BHK", 'Near "park", east'],
      ["3 BHK", "plain"],
    ]);
  });

  it("drops blank lines and keeps a final row with no trailing newline", () => {
    expect(parseCsv("a,b\n\n1,2")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("keeps a newline inside quotes", () => {
    expect(parseCsv('a,b\n"line1\nline2",x')[1]).toEqual(["line1\nline2", "x"]);
  });
});

describe("parseIndianPrice", () => {
  it.each([
    ["6500000", 6_500_000],
    ["65,00,000", 6_500_000],
    ["₹65,00,000", 6_500_000],
    ["65 lakh", 6_500_000],
    ["65L", 6_500_000],
    ["₹1.1 Cr", 11_000_000],
    ["1.25 crore", 12_500_000],
    ["Rs. 2500", 2_500],
  ])("%s -> %d", (raw, expected) => {
    expect(parseIndianPrice(raw)).toBe(expected);
  });

  it("rejects what is not a price", () => {
    expect(parseIndianPrice("ask sales")).toBeNull();
    expect(parseIndianPrice("")).toBeNull();
    expect(parseIndianPrice("-5")).toBeNull();
  });
});

describe("parseAreaSqft", () => {
  it("reads plain numbers and units", () => {
    expect(parseAreaSqft("1200")).toBe(1200);
    expect(parseAreaSqft("1,200 sq ft")).toBe(1200);
    expect(parseAreaSqft("2400 sqft")).toBe(2400);
  });
  it("rejects text and zero", () => {
    expect(parseAreaSqft("30x40")).toBeNull();
    expect(parseAreaSqft("0")).toBeNull();
  });
});

describe("importUnitsCsv", () => {
  it("apartment types with price ranges become units and ranges", () => {
    const r = importUnitsCsv("Type,Area,Min Price,Max Price\n2 BHK,1150,65 lakh,78 lakh\n3 BHK,1550,95 lakh,1.1 Cr\n");
    expect(r.rejected).toEqual([]);
    expect(r.units).toEqual([
      { type: "2 BHK", areaSqft: 1150 },
      { type: "3 BHK", areaSqft: 1550 },
    ]);
    expect(r.ranges).toEqual([
      { type: "2 BHK", min: 6_500_000, max: 7_800_000 },
      { type: "3 BHK", min: 9_500_000, max: 11_000_000 },
    ]);
  });

  it("plots: number, facing, status and a rate per square foot", () => {
    const r = importUnitsCsv(
      ["Plot No,Type,Area (sq ft),Facing,Status,Rate per sqft", 'A-12,30x40,1200,East,Available,"₹2,500"', "A-13,30x40,1200,West,Sold,2500", 'B-02,40x60,2400,North,Hold,"2,800"'].join("\n"),
    );
    expect(r.rejected).toEqual([]);
    expect(r.units[0]).toEqual({ type: "30x40", areaSqft: 1200, plotNumber: "A-12", facing: "East", status: "available", pricePerSqft: 2500 });
    expect(r.units.map((u) => u.status)).toEqual(["available", "sold", "hold"]);
    expect(r.perSqft).toEqual({ min: 2500, max: 2800 });
    expect(r.ranges).toEqual([
      { type: "30x40", min: 3_000_000, max: 3_000_000 },
      { type: "40x60", min: 6_720_000, max: 6_720_000 },
    ]);
  });

  it("reports bad rows with their line number and keeps the good ones", () => {
    const r = importUnitsCsv("Type,Area,Status,Price\n2 BHK,1150,Available,65 lakh\n3 BHK,big,Available,1 Cr\n4 BHK,1800,maybe,2 Cr\n,900,Available,40 lakh\n");
    expect(r.accepted).toBe(1);
    expect(r.rejected.map((x) => x.line)).toEqual([3, 4, 5]);
    expect(r.rejected[0].reason).toContain("area");
    expect(r.rejected[1].reason).toContain("status");
  });

  it("an unquoted number with a comma is rejected with a clear reason, not read as a wrong value", () => {
    const r = importUnitsCsv("Plot No,Area,Rate\nA-1,1200,2,500\nA-2,1200,2500\n");
    expect(r.accepted).toBe(1);
    expect(r.rejected).toEqual([{ line: 2, reason: expect.stringContaining("quotes") }]);
  });

  it("refuses a file without the columns it needs", () => {
    const r = importUnitsCsv("Name,Colour\nA,red\n");
    expect(r.accepted).toBe(0);
    expect(r.rejected[0].reason).toContain("header");
  });
});

describe("importFaqCsv", () => {
  it("reads question and answer pairs and rejects incomplete ones", () => {
    const r = importFaqCsv('Question,Answer\nIs it RERA registered?,"Yes, registered."\nWhat is the booking amount?,\n');
    expect(r.items).toEqual([{ question: "Is it RERA registered?", answer: "Yes, registered." }]);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0].line).toBe(3);
  });
});
