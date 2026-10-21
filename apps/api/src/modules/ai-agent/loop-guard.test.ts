import { describe, it, expect } from "vitest";
import { announcesEndOfCall, isRepeat, replySimilarity } from "./loop-guard.js";

describe("replySimilarity / isRepeat", () => {
  it("the same sentence, lightly reworded, is a repeat (as in the call that kept saying it was an AI)", () => {
    const a = "நான் AI assistant-ங்கறத ஏற்கனவே சொல்லிட்டேன். இப்போ visit slot பாக்கலாமா?";
    const b = "நான் AI assistant, Priya. visit slot பாக்கலாமா?";
    expect(replySimilarity(a, a)).toBe(1);
    expect(replySimilarity(a, b)).toBeGreaterThan(0.3);
    expect(isRepeat("I am an AI assistant. Would you like to see the visit slots?", ["I am an AI assistant, would you like to see visit slots?"])).toBe(true);
  });

  it("different answers are not repeats", () => {
    expect(isRepeat("The 3 BHK ranges from 95 to 110 lakhs.", ["We have slots this Saturday at 10 or 11:30."])).toBe(false);
  });

  it("very short replies are never called repeats", () => {
    expect(isRepeat("Okay, noted.", ["Okay, noted."])).toBe(false);
  });
});

describe("announcesEndOfCall", () => {
  it.each([
    "இப்போ call-அ close பண்ணிருக்கேன். வேற ஏதாவது உதவி வேணும்னா எங்கள contact பண்ணுங்க. நன்றி, bye.",
    "சரி, call cut பண்றேன். வேற ஏதாவது தேவைனா எங்கள contact பண்ணுங்க. நன்றி, bye.",
    "நான் இப்போ call-அ close பண்ணிட்டேன். நம்ம team உங்கள contact பண்ணுவாங்க.",
    "I will end the call now. Thank you.",
    "I've closed the call. Goodbye.",
    "This call is being disconnected, goodbye.",
  ])("%s", (t) => {
    expect(announcesEndOfCall(t)).toBe(true);
  });

  it.each([
    "Shall I close the call?",
    "If you want, I can end the call.",
    "Would you like me to close the call now?",
    "I will call you at the end of the day.",
    "At the end of the call I will send the details on WhatsApp.",
    "நான் உங்களுக்கு நாளைக்கு call பண்றேன்.",
    "call close பண்ணலாமா?",
    "You can call us back tomorrow.",
    "The 2 BHK costs 65 lakhs.",
  ])("not an announcement: %s", (t) => {
    expect(announcesEndOfCall(t)).toBe(false);
  });
});
