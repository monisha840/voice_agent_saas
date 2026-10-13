import { describe, it, expect } from "vitest";
import { detectLanguageSwitchRequest, isFillerOnly, shouldIgnoreUtterance } from "./caller-input.js";

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
