import { describe, it, expect } from "vitest";
import { collapseRepetition } from "./stt-text.js";

describe("collapseRepetition", () => {
  it("leaves ordinary speech alone", () => {
    const text = "இந்த 2 BHK விலை எவ்வளவு?";
    expect(collapseRepetition(text)).toEqual({ text, collapsed: false, removedWords: 0 });
  });

  it("leaves a short, natural repeat alone", () => {
    const text = "சரி சரி சரி நான் வரேன்";
    expect(collapseRepetition(text).collapsed).toBe(false);
  });

  it("collapses a one-word loop to two copies", () => {
    const loop = Array.from({ length: 120 }, () => "ஆ").join(" ");
    const r = collapseRepetition(loop);
    expect(r.text).toBe("ஆ ஆ");
    expect(r.collapsed).toBe(true);
    expect(r.removedWords).toBe(118);
  });

  it("collapses a two-word phrase loop, keeping what came before", () => {
    const loop = Array.from({ length: 60 }, () => "சரிங்க சார்").join(" ");
    const r = collapseRepetition(`ஆ ${loop}`);
    expect(r.text).toBe("ஆ சரிங்க சார் சரிங்க சார்");
  });

  it("keeps real words around a loop", () => {
    const loop = Array.from({ length: 10 }, () => "yes").join(" ");
    expect(collapseRepetition(`hello ${loop} please book it`).text).toBe("hello yes yes please book it");
  });

  it("ignores punctuation and case when comparing", () => {
    const loop = Array.from({ length: 8 }, (_, i) => (i % 2 ? "Okay," : "okay")).join(" ");
    expect(collapseRepetition(loop).text).toBe("okay Okay,");
  });

  it("handles empty input", () => {
    expect(collapseRepetition("   ")).toEqual({ text: "", collapsed: false, removedWords: 0 });
  });
});
