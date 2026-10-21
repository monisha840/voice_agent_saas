import { describe, it, expect } from "vitest";
import { CallerLevelTracker, detectLanguageSwitchRequest, isCallerGoodbye, isFillerOnly, isUnexpectedLanguage, looksLikeNoiseTranscript, shouldIgnoreUtterance } from "./caller-input.js";

describe("isFillerOnly", () => {
  it.each(["ஆ", "ம்", "உம்", "ம்.", "ம்ம்", "um", "Hmm...", "uh, hmm", "ஆ ம்"])("%s is filler", (t) => {
    expect(isFillerOnly(t)).toBe(true);
  });

  it.each(["ஆமா", "சரி", "yes", "ok", "no", "3 BHK", "ஆம்", "இல்ல", "hmm yes"])("%s is not filler", (t) => {
    expect(isFillerOnly(t)).toBe(false);
  });
});

describe("shouldIgnoreUtterance", () => {
  it("drops a short filler, as in the call where 190-300 ms noises became caller turns", () => {
    expect(shouldIgnoreUtterance("ஆ", 190)).toBe(true);
    expect(shouldIgnoreUtterance("உம்", 290)).toBe(true);
    expect(shouldIgnoreUtterance("ம்.", 301)).toBe(true);
  });

  it("keeps a long filler: the caller may really be hesitating", () => {
    expect(shouldIgnoreUtterance("hmm", 1500)).toBe(false);
  });

  it("keeps a short real answer", () => {
    expect(shouldIgnoreUtterance("yes", 250)).toBe(false);
    expect(shouldIgnoreUtterance("ஆமா", 400)).toBe(false);
  });

  it("drops text that has no letters or digits at all", () => {
    expect(shouldIgnoreUtterance(" . , ", 5000)).toBe(true);
    expect(shouldIgnoreUtterance("", 5000)).toBe(true);
  });
});

describe("detectLanguageSwitchRequest", () => {
  it("English requests, as spoken in the call", () => {
    expect(detectLanguageSwitchRequest("Could you please speak in English?")).toBe("en-IN");
    expect(detectLanguageSwitchRequest("I mean I wanted to speak in English.")).toBe("en-IN");
    expect(detectLanguageSwitchRequest("English please")).toBe("en-IN");
    expect(detectLanguageSwitchRequest("can you reply in english")).toBe("en-IN");
  });

  it("English requests in Tamil", () => {
    expect(detectLanguageSwitchRequest("இங்கிலீஷ்ல பேசுங்க")).toBe("en-IN");
    expect(detectLanguageSwitchRequest("ஆங்கிலத்தில் பேசுங்கள்")).toBe("en-IN");
  });

  it("Tamil requests", () => {
    expect(detectLanguageSwitchRequest("Please speak in Tamil")).toBe("ta-IN");
    expect(detectLanguageSwitchRequest("tamil la pesunga")).toBe("ta-IN");
    expect(detectLanguageSwitchRequest("தமிழில் பேசுங்கள்")).toBe("ta-IN");
    expect(detectLanguageSwitchRequest("தமிழ்ல சொல்லுங்க")).toBe("ta-IN");
  });

  it("Hindi requests", () => {
    expect(detectLanguageSwitchRequest("please speak in Hindi")).toBe("hi-IN");
    expect(detectLanguageSwitchRequest("हिंदी में बात करो")).toBe("hi-IN");
  });

  it("asking to go back, as spoken in the second call", () => {
    expect(detectLanguageSwitchRequest("Go back to Tamil language.")).toBe("ta-IN");
    expect(detectLanguageSwitchRequest("I want you to speak in Tamil now")).toBe("ta-IN");
    expect(detectLanguageSwitchRequest("please come back to English")).toBe("en-IN");
    expect(detectLanguageSwitchRequest("english la pesunga")).toBe("en-IN");
    expect(detectLanguageSwitchRequest("தமிழுக்கு மாறுங்க")).toBe("ta-IN");
  });

  it("a place name is not a language request", () => {
    expect(detectLanguageSwitchRequest("Do you have flats in Tamil Nadu other than Chennai?")).toBeNull();
    expect(detectLanguageSwitchRequest("I am from Tamil Nadu")).toBeNull();
  });

  it("a sentence that merely mentions a language is not a request", () => {
    expect(detectLanguageSwitchRequest("Tell me the price, I only know a little English")).toBeNull();
    expect(detectLanguageSwitchRequest("The brochure is in English")).toBe("en-IN"); // "in English" is a request; known, accepted
  });

  it("ordinary sentences are not requests", () => {
    expect(detectLanguageSwitchRequest("What is the price of the 2 BHK?")).toBeNull();
    expect(detectLanguageSwitchRequest("My English is not very good but I understand")).toBeNull();
    expect(detectLanguageSwitchRequest("இந்த 2 BHK விலை எவ்வளவு?")).toBeNull();
  });

  it("naming two languages is ambiguous", () => {
    expect(detectLanguageSwitchRequest("speak in English or in Tamil, whichever")).toBeNull();
  });
});

describe("text a recogniser makes up from noise", () => {
  it("the same non-word token over and over is noise, as in the call where the room became '100 rupees' three times", () => {
    expect(looksLikeNoiseTranscript("₹100 ₹100 ₹100", 1500)).toBe(true);
    expect(shouldIgnoreUtterance("₹100 ₹100 ₹100", 2000)).toBe(true);
    expect(looksLikeNoiseTranscript("100 100 100 100", 1500)).toBe(true);
  });

  it("a number said once, or with words around it, is an answer", () => {
    expect(looksLikeNoiseTranscript("₹100", 800)).toBe(false);
    expect(looksLikeNoiseTranscript("100 lakhs", 900)).toBe(false);
    expect(looksLikeNoiseTranscript("50 60 70", 1500)).toBe(false);
    expect(shouldIgnoreUtterance("எனக்கு 100 லட்சம் budget", 1500)).toBe(false);
  });

  it("one word stretched over many seconds is not speech; a short one is", () => {
    expect(looksLikeNoiseTranscript("சரி", 5000)).toBe(true);
    expect(looksLikeNoiseTranscript("சரி", 600)).toBe(false);
    expect(looksLikeNoiseTranscript("நான் நாளைக்கு வரலாமா", 5000)).toBe(false);
  });
});

describe("speech in a language this call has not used", () => {
  it("a short utterance heard as Telugu on a Tamil call is background", () => {
    expect(isUnexpectedLanguage("te-IN", ["ta-IN", undefined, null], 3)).toBe(true);
  });

  it("the call's own languages and English/Hindi are never 'unexpected'", () => {
    expect(isUnexpectedLanguage("ta-IN", ["ta-IN"], 2)).toBe(false);
    expect(isUnexpectedLanguage("en-IN", ["ta-IN"], 2)).toBe(false);
    expect(isUnexpectedLanguage("hi-IN", ["ta-IN"], 2)).toBe(false);
  });

  it("a language the caller asked for is allowed, a long utterance is never dropped on this ground, and unknown is kept", () => {
    expect(isUnexpectedLanguage("te-IN", ["ta-IN", "te-IN"], 2)).toBe(false);
    expect(isUnexpectedLanguage("te-IN", ["ta-IN"], 12)).toBe(false);
    expect(isUnexpectedLanguage(undefined, ["ta-IN"], 2)).toBe(false);
  });
});

describe("CallerLevelTracker", () => {
  it("accepts everything until it knows the caller's level", () => {
    const t = new CallerLevelTracker();
    expect(t.isBackground(300)).toBe(false);
    expect(t.isBackground(4000)).toBe(false);
  });

  it("then treats a much quieter voice as the room, and keeps the caller's level unchanged by it", () => {
    const t = new CallerLevelTracker();
    t.isBackground(3000);
    t.isBackground(3200);
    const level = t.callerLevel;
    expect(t.isBackground(500)).toBe(true);
    expect(t.callerLevel).toBe(level);
    expect(t.isBackground(2800)).toBe(false);
  });

  it("a caller who is only somewhat quieter than before is still the caller", () => {
    const t = new CallerLevelTracker();
    t.isBackground(3000);
    t.isBackground(3000);
    expect(t.isBackground(1500)).toBe(false);
  });

  it("unknown or zero levels are never background", () => {
    const t = new CallerLevelTracker();
    t.isBackground(3000);
    t.isBackground(3000);
    expect(t.isBackground(undefined)).toBe(false);
    expect(t.isBackground(0)).toBe(false);
  });
});


describe("isCallerGoodbye", () => {
  it.each(["ok thanks bye", "Thank you, bye", "bye", "நன்றி", "சரி போதும்", "அவ்வளவுதான் நன்றி bye", "धन्यवाद", "that's all"])("%s", (t) => {
    expect(isCallerGoodbye(t)).toBe(true);
  });

  it.each(["thanks, and what is the price of a 3 BHK", "இல்லை நான் எந்த interest-உம்", "what about the second floor", "", "ஆமாம்"])("not a goodbye: %s", (t) => {
    expect(isCallerGoodbye(t)).toBe(false);
  });
});
