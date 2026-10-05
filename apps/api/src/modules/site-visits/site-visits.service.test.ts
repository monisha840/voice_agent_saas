import { describe, it, expect } from "vitest";
import { siteVisitsService } from "./site-visits.service.js";

describe("siteVisitsService.checkVisitSlots", () => {
  it("returns exactly 3 structured slots, all in the future, all on a Saturday", () => {
    const slots = siteVisitsService.checkVisitSlots();

    expect(slots).toHaveLength(3);
    for (const slot of slots) {
      expect(slot.id).toBeTruthy();
      expect(slot.label).toContain("Saturday");
      const dt = new Date(slot.isoDateTime);
      expect(dt.getTime()).toBeGreaterThan(Date.now());
      expect(dt.getDay()).toBe(6); // Saturday
    }
  });

  it("returns distinct times for each slot", () => {
    const slots = siteVisitsService.checkVisitSlots();
    const times = new Set(slots.map((s) => s.isoDateTime));
    expect(times.size).toBe(slots.length);
  });
});
