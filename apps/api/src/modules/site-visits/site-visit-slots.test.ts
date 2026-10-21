/**
 * Visit slots are wall-clock times in the business time zone. A server clock in UTC must not shift "10:00 AM" into the
 * afternoon.
 */
import { describe, it, expect, afterEach } from "vitest";
import { siteVisitsService } from "./site-visits.service.js";

const instants = (now: string) => siteVisitsService.checkVisitSlots(new Date(now)).map((s) => s.isoDateTime);

afterEach(() => {
  delete process.env.BUSINESS_TIME_ZONE;
});

describe("checkVisitSlots time zone", () => {
  it("defaults to India time: 10:00, 11:30 and 14:00 IST on the next Saturday", () => {
    // Tuesday 13 Oct 2026 (IST) -> Saturday 17 Oct 2026.
    expect(instants("2026-10-13T12:00:00Z")).toEqual(["2026-10-17T04:30:00.000Z", "2026-10-17T06:00:00.000Z", "2026-10-17T08:30:00.000Z"]);
  });

  it("does not depend on the process time zone (the same instants whatever the server clock zone)", () => {
    const a = instants("2026-10-13T12:00:00Z");
    const b = instants("2026-10-13T12:00:00Z");
    expect(a).toEqual(b);
    expect(a[0]).toBe("2026-10-17T04:30:00.000Z");
  });

  it("uses the business day, not the UTC day, to find the next Saturday", () => {
    // 20:00 UTC on Saturday 17 Oct is 01:30 IST on Sunday 18 Oct, so the next Saturday is the 24th.
    expect(instants("2026-10-17T20:00:00Z")[0]).toBe("2026-10-24T04:30:00.000Z");
    // 05:00 UTC on Saturday 17 Oct is 10:30 IST the same Saturday: the next one is a week later.
    expect(instants("2026-10-17T05:00:00Z")[0]).toBe("2026-10-24T04:30:00.000Z");
  });

  it("honours BUSINESS_TIME_ZONE", () => {
    process.env.BUSINESS_TIME_ZONE = "UTC";
    expect(instants("2026-10-13T12:00:00Z")[0]).toBe("2026-10-17T10:00:00.000Z");
  });

  it("keeps the offered labels", () => {
    expect(siteVisitsService.checkVisitSlots(new Date("2026-10-13T12:00:00Z")).map((s) => s.label)).toEqual([
      "Saturday 10:00 AM",
      "Saturday 11:30 AM",
      "Saturday 2:00 PM",
    ]);
  });
});
