import { describe, it, expect } from "vitest";
import { SentenceChunker } from "./text-chunker.js";

/** Feeds deltas one by one and returns every chunk produced, in order, including the flush. */
function run(deltas: string[], opts?: ConstructorParameters<typeof SentenceChunker>[0]): string[] {
  const c = new SentenceChunker(opts);
  const out: string[] = [];
  for (const d of deltas) out.push(...c.push(d));
  out.push(...c.flush());
  return out;
}
const tokens = (s: string) => s.match(/\S+\s*/g) ?? [];

describe("SentenceChunker", () => {
  it("the example: token deltas become sentence chunks", () => {
    expect(run(["Hello", " Rajesh", ". I", " can", " help", " you", " with", " that."])).toEqual(["Hello Rajesh.", "I can help you with that."]);
  });

  it("emits a sentence as soon as the delta AFTER its terminator shows it ended (not at the end of the reply)", () => {
    const c = new SentenceChunker();
    expect(c.push("The price starts at 70 lakhs.")).toEqual([]); // the '.' might be part of "70.5": wait
    expect(c.push(" It")).toEqual(["The price starts at 70 lakhs."]);
    expect(c.push(" includes parking.")).toEqual([]);
    expect(c.flush()).toEqual(["It includes parking."]);
  });

  it("never splits decimals, currency or abbreviations", () => {
    expect(run(tokens("The price is 2.5 crore. Mr. Rajesh will call you at Rs. 70 lakhs approx. tomorrow."))).toEqual([
      "The price is 2.5 crore.",
      "Mr. Rajesh will call you at Rs. 70 lakhs approx. tomorrow.",
    ]);
    expect(run(tokens("Ask A. R. Rahman about it. Then we can go ahead."))).toEqual(["Ask A. R. Rahman about it.", "Then we can go ahead."]);
  });

  it("merges short sentences instead of producing tiny chunks", () => {
    expect(run(tokens("Yes. No. Of course I can help you with that today."))).toEqual(["Yes. No. Of course I can help you with that today."]);
    // after the first chunk the minimum is larger (24)
    expect(run(tokens("Certainly, I can help. Yes. No. We have a two bedroom flat available now."))).toEqual([
      "Certainly, I can help.",
      "Yes. No. We have a two bedroom flat available now.",
    ]);
  });

  it("handles ? ! … and quotes, and keeps ?! together", () => {
    expect(run(tokens('Are you looking for a 2 BHK?! I can show you "Green Valley." We also have more… Shall we begin?'))).toEqual([
      "Are you looking for a 2 BHK?!",
      'I can show you "Green Valley."',
      "We also have more… Shall we begin?", // "We also have more…" alone is under the 24-char minimum, so it merges
    ]);
  });

  it("splits Tamil and Devanagari sentences on their terminators", () => {
    expect(run(tokens("இந்த திட்டத்தில் இரண்டு படுக்கையறை வீடுகள் உள்ளன. விலை எழுபது லட்சத்தில் தொடங்குகிறது."))).toEqual([
      "இந்த திட்டத்தில் இரண்டு படுக்கையறை வீடுகள் உள்ளன.",
      "விலை எழுபது லட்சத்தில் தொடங்குகிறது.",
    ]);
    expect(run(tokens("नमस्ते, मैं आपकी मदद कर सकता हूँ। आप क्या जानना चाहते हैं।"))).toEqual(["नमस्ते, मैं आपकी मदद कर सकता हूँ।", "आप क्या जानना चाहते हैं।"]);
  });

  it("Tanglish (Latin-script Tamil) chunks like any other text", () => {
    expect(run(tokens("Sure, naan help panren. Indha project la 2 BHK price 70 lakhs la start aagudhu."))).toEqual([
      "Sure, naan help panren.",
      "Indha project la 2 BHK price 70 lakhs la start aagudhu.",
    ]);
  });

  it("splits a very long run at clause punctuation, then at a space, past the minimum", () => {
    const clause = "The project has a clubhouse, a swimming pool, a children's play area, a gym, a jogging track, a landscaped garden, and covered parking for every flat that is sold";
    const chunks = run(tokens(clause), { maxChunkChars: 80 });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 80 + 1)).toBe(true);
    expect(chunks.slice(0, -1).every((c) => c.endsWith(","))).toBe(true);
    expect(chunks.join(" ")).toBe(clause);

    const noPunct = "word ".repeat(60).trim();
    const c2 = run(tokens(noPunct), { maxChunkChars: 50 });
    expect(c2.length).toBeGreaterThan(1);
    expect(c2.join(" ")).toBe(noPunct);
  });

  it("flush releases a short remainder and is empty when nothing is pending; text without a terminator comes out whole", () => {
    expect(run(["Okay"])).toEqual(["Okay"]);
    expect(run([])).toEqual([]);
    expect(run(["   "])).toEqual([]);
    expect(run(["No terminator here at all"])).toEqual(["No terminator here at all"]);
  });

  it("chunks joined with spaces always equal the original text, however the deltas were cut", () => {
    const text = "Welcome! The 2 BHK is Rs. 70.5 lakhs. It has parking, a pool, and a gym; we can visit on Saturday. Would 11:30 AM work?";
    const expected = text.replace(/\s+/g, " ");
    for (const size of [1, 2, 3, 5, 7, 13, 1000]) {
      const deltas = Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
      expect(run(deltas).join(" ")).toBe(expected);
    }
  });

  it("the first chunk is allowed to be shorter than later ones so speech starts sooner", () => {
    expect(run(tokens("Hello Rajesh. I can help you with that and more.")).length).toBe(2);
    expect(run(tokens("Hello Rajesh. I can help."), { minChunkChars: 24 })).toEqual(["Hello Rajesh.", "I can help."]);
  });
});
