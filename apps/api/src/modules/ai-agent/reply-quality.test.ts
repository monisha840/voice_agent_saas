import { describe, it, expect } from "vitest";
import { reviewReply } from "./reply-quality.js";

describe("reviewReply", () => {
  it("a short, single-question reply has no flags", () => {
    const r = reviewReply({ text: "சனிக்கிழமை 10 AM, 11:30 AM, அப்புறம் 2 PM slots இருக்கு. எது வசதியா இருக்கும்?", bookedThisTurn: false });
    expect(r.flags).toEqual([]);
    expect(r.words).toBeGreaterThan(5);
  });

  it("flags a long reply", () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    expect(reviewReply({ text, bookedThisTurn: false }).flags).toContain("too_long");
    expect(reviewReply({ text, bookedThisTurn: false, maxWords: 50 }).flags).not.toContain("too_long");
  });

  it("flags more than one question", () => {
    expect(reviewReply({ text: "Which configuration? And what is your budget?", bookedThisTurn: false }).flags).toContain("multiple_questions");
    expect(reviewReply({ text: "Which configuration do you want?", bookedThisTurn: false }).flags).not.toContain("multiple_questions");
  });

  it("flags a booking confirmation that states no day, date or time", () => {
    const bare = reviewReply({ text: "எல்லாம் முடிஞ்சது. நல்ல நாளாக அமையட்டும்!", bookedThisTurn: true });
    expect(bare.flags).toContain("booking_unconfirmed");
    const full = reviewReply({ text: "சனிக்கிழமை 17 October காலை 11:30 மணிக்கு visit book பண்ணியாச்சு.", bookedThisTurn: true });
    expect(full.flags).toEqual([]);
  });

  it("flags a claim that something is booked when no booking succeeded this turn", () => {
    expect(reviewReply({ text: "Your site visit is booked for Saturday 11:30 AM.", bookedThisTurn: false }).flags).toContain("claims_booking_without_tool");
    expect(reviewReply({ text: "சனிக்கிழமை 11:30-க்கு visit book பண்ணியாச்சு.", bookedThisTurn: false }).flags).toContain("claims_booking_without_tool");
    expect(reviewReply({ text: "Your site visit is booked for Saturday 11:30 AM.", bookedThisTurn: true }).flags).toEqual([]);
  });

  it("asking the caller to confirm a slot is not a claim", () => {
    expect(reviewReply({ text: "இதுல எதை confirm பண்ணலாம்?", bookedThisTurn: false }).flags).toEqual([]);
  });
});
