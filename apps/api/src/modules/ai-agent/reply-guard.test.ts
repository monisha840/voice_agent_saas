import { describe, it, expect } from "vitest";
import { ReplyGuard, callerAskedAboutVisit, isVisitOffer, numbersIn, replyOffersVisit, ungroundedFigures } from "./reply-guard.js";

const TOOL = JSON.stringify({
  ranges: [
    { type: "2 BHK", min: 6500000, max: 7800000 },
    { type: "3 BHK", min: 9500000, max: 11000000 },
  ],
  units: [{ type: "2 BHK", areaSqft: 1150 }, { type: "3 BHK", areaSqft: 1550 }],
  places: [{ name: "Metro", distanceKm: 4, travelMinutes: 12 }],
});
const known = numbersIn([TOOL, "my budget is 80 lakhs"]);

describe("isVisitOffer / replyOffersVisit", () => {
  it.each([
    "Shall I schedule a site visit for you?",
    "உங்களுக்கு site visit ஏற்பாடு பண்ணட்டுமா?",
    "Would you like me to check the available slots?",
    "क्या मैं साइट विज़िट बुक कर दूँ?",
  ])("offer: %s", (s) => expect(isVisitOffer(s)).toBe(true));

  it.each(["The visit is booked for Saturday.", "The 2 BHK is 65 lakhs.", "Is it for yourself or investment?", "Do you need a loan?"])("not an offer: %s", (s) =>
    expect(isVisitOffer(s)).toBe(false),
  );

  it("looks over a whole reply", () => {
    expect(replyOffersVisit("The price is 65 lakhs. Shall I book a site visit?")).toBe(true);
    expect(replyOffersVisit("The price is 65 lakhs.")).toBe(false);
  });

  it("a caller who talks about coming over is asking about a visit", () => {
    expect(callerAskedAboutVisit("can I come on Saturday")).toBe(true);
    expect(callerAskedAboutVisit("when can I visit the site")).toBe(true);
    expect(callerAskedAboutVisit("what is the price of 3 BHK")).toBe(false);
  });
});

describe("ungroundedFigures", () => {
  it("accepts figures the tools returned, in lakhs, crores, sq ft and km", () => {
    expect(ungroundedFigures("The 2 BHK is 65 to 78 lakhs.", known)).toEqual([]);
    expect(ungroundedFigures("The 3 BHK is 95 lakhs to 1.10 crore.", known)).toEqual([]);
    expect(ungroundedFigures("3 BHK வந்து 95 லட்சத்துல இருந்து 1 கோடியே 10 இலட்சம் வரைக்கும் வரும்.", known)).toEqual([]);
    expect(ungroundedFigures("It is 1550 sq ft, and the metro is 4 km away, about 12 minutes.", known)).toEqual([]);
    expect(ungroundedFigures("Your budget of 80 lakhs fits.", known)).toEqual([]);
  });

  it("flags a figure no tool returned", () => {
    expect(ungroundedFigures("The 2 BHK is 55 lakhs.", known)).toEqual(["55 lakhs"]);
    expect(ungroundedFigures("It is 1800 sq ft.", known)).toEqual(["1800 sq ft"]);
    expect(ungroundedFigures("The metro is 9 km away.", known)).toEqual(["9 km"]);
    expect(ungroundedFigures("It will be 1 crore 40 lakhs.", known).length).toBe(1);
    expect(ungroundedFigures("The booking amount is ₹5,00,000.", known)).toEqual(["₹5,00,000"]);
  });

  it("does not judge bare numbers: counts, times and BHK sizes", () => {
    expect(ungroundedFigures("We have 3 slots, at 10 and 11:30, for a 4 BHK.", known)).toEqual([]);
  });
});

describe("ReplyGuard", () => {
  it("removes a repeated visit offer and keeps the answer", () => {
    const g = new ReplyGuard({ knownNumbers: known, suppressVisitOffer: true });
    const r = g.filter("The 2 BHK is 65 to 78 lakhs. Shall I schedule a site visit?");
    expect(r).toEqual({ text: "The 2 BHK is 65 to 78 lakhs.", visitOfferRemoved: true, ungrounded: [] });
  });

  it("leaves a visit offer alone when it is not suppressed", () => {
    const g = new ReplyGuard({ knownNumbers: known, suppressVisitOffer: false });
    const text = "The 2 BHK is 65 to 78 lakhs. Shall I schedule a site visit?";
    expect(g.filter(text)).toEqual({ text, visitOfferRemoved: false, ungrounded: [] });
  });

  it("removes a sentence with an unverified figure and keeps the rest", () => {
    const g = new ReplyGuard({ knownNumbers: known, suppressVisitOffer: false });
    const r = g.filter("It is a gated community. The 2 BHK is 55 lakhs. There is a gym.");
    expect(r.text).toBe("It is a gated community. There is a gym.");
    expect(r.ungrounded).toEqual(["55 lakhs"]);
  });

  it("can leave nothing, which the caller of the guard must handle", () => {
    const g = new ReplyGuard({ knownNumbers: known, suppressVisitOffer: false });
    expect(g.filter("The 2 BHK is 55 lakhs.").text).toBe("");
  });

  it("is language-neutral for the figure check", () => {
    const g = new ReplyGuard({ knownNumbers: known, suppressVisitOffer: false });
    expect(g.filter("2 BHK விலை 55 லட்சம் வரும்.").ungrounded).toEqual(["55 லட்சம்"]);
  });
});
