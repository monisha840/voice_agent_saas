import { describe, it, expect } from "vitest";
import { KNOWLEDGE_CATEGORIES, isKnowledgeCategory, knowledgeSchemas } from "./knowledge.schemas.js";

const valid: Record<string, unknown> = {
  pricing: { ranges: [{ type: "2 BHK", min: 100, max: 200 }] },
  configurations: { units: [{ type: "2 BHK", areaSqft: 1100 }] },
  amenities: { items: ["Gym", "Pool"] },
  possession: { expectedDate: "2027-03-31", notes: "n" },
  location: { address: "Whitefield", landmarks: ["ITPL"] },
  faq: { items: [{ question: "q?", answer: "a" }] },
  rera: { registrationNumber: "PRM/KA/RERA/1/2" },
  loan: { assistanceAvailable: true, banks: ["SBI"] },
  booking: { bookingAmount: 200000, currency: "INR", paymentPlan: "20:80" },
  maintenance: { chargesPerSqftPerMonth: 3.5 },
  nearby: { items: [{ name: "Chromepet railway station", type: "railway", distanceKm: 2.5, travelMinutes: 8 }] },
  approvals: { items: [{ authority: "DTCP", number: "123/2024" }] },
  builder: { name: "Green Valley Developers", yearsInBusiness: 15 },
  about: { text: "A gated community of 120 homes near the IT corridor." },
};

const invalid: Record<string, unknown[]> = {
  pricing: [{ ranges: [{ type: "2 BHK", min: 300, max: 200 }] }, { ranges: [{ type: "2 BHK", min: -1, max: 5 }] }, { ranges: [{ type: "x", min: 1.5, max: 2 }] }, {}],
  configurations: [{ units: [{ type: "2 BHK", areaSqft: 0 }] }, { units: [{ areaSqft: 10 }] }],
  amenities: [{ items: "Gym" }, { items: [""] }, { items: Array.from({ length: 101 }, (_, i) => `a${i}`) }],
  possession: [{ expectedDate: "31-12-2027" }, { expectedDate: "2027-02-30" }, {}],
  location: [{ landmarks: [] }, { address: "x" }],
  faq: [{ items: [{ question: "q" }] }, { items: [{ question: "q", answer: "a".repeat(2001) }] }],
  rera: [{}, { registrationNumber: "" }],
  loan: [{ assistanceAvailable: "yes" }, {}],
  booking: [{ bookingAmount: -5 }, { bookingAmount: 1.5 }],
  maintenance: [{ chargesPerSqftPerMonth: -1 }, { chargesPerSqftPerMonth: "3" }],
  nearby: [{ items: [{ name: "x", type: "castle" }] }, { items: [{ name: "x", distanceKm: -1 }] }, { items: "school" }],
  approvals: [{ items: [{ number: "1" }] }, {}],
  builder: [{}, { name: "" }, { name: "x", yearsInBusiness: -1 }],
  about: [{ text: "" }, { text: "a".repeat(2001) }, {}],
};

describe("knowledge schemas", () => {
  it("covers exactly the fourteen categories", () => {
    expect([...KNOWLEDGE_CATEGORIES].sort()).toEqual(Object.keys(valid).sort());
    expect(isKnowledgeCategory("rera")).toBe(true);
    expect(isKnowledgeCategory("hacks")).toBe(false);
    expect(isKnowledgeCategory("__proto__")).toBe(false);
  });

  for (const category of KNOWLEDGE_CATEGORIES) {
    it(`${category}: accepts valid content`, () => {
      expect(knowledgeSchemas[category].safeParse(valid[category]).success).toBe(true);
    });
    it(`${category}: rejects invalid content`, () => {
      for (const bad of invalid[category]) {
        expect(knowledgeSchemas[category].safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      }
    });
  }

  it("defaults the pricing currency to INR and strips unknown keys", () => {
    const parsed = knowledgeSchemas.pricing.parse({ ranges: [], extra: 1 }) as Record<string, unknown>;
    expect(parsed.currency).toBe("INR");
    expect(parsed).not.toHaveProperty("extra");
  });
});
