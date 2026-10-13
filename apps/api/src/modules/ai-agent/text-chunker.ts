/**
 * SentenceChunker — turns a stream of text deltas into speakable chunks.
 *
 * LLM deltas are token-sized ("Hello", " Rajesh", ". I", ...): far too small to synthesize one by one. This groups
 * them into sentence-sized pieces so a TTS request is worth making, without waiting for the whole reply:
 *
 *   "Hello" " Rajesh" ". I" " can" " help" " you" " with" " that."  ->  "Hello Rajesh."  then  "I can help you with that."
 *
 * Rules:
 *  - A boundary is a sentence terminator (. ? ! … । ॥, optionally followed by closing quotes/brackets) FOLLOWED BY
 *    whitespace. Needing the whitespace means "2.5 lakhs" and "Rs.70" are never split, and a terminator at the very end
 *    of what has arrived is held until the next delta shows whether the sentence really ended.
 *  - Not a boundary: a '.' after a common abbreviation (Mr., Dr., Rs., approx., ...) or a lone initial ("A. R. Rahman").
 *  - No tiny chunks: a sentence shorter than `minChunkChars` (`firstChunkMinChars` for the first chunk, which is
 *    shorter on purpose so speech can start sooner) is merged with the next one.
 *  - A very long run with no sentence end is split at the last clause punctuation (, ; : —), else the last space,
 *    once it passes `maxChunkChars`.
 *  - flush() releases whatever is left, however short, when the reply is complete.
 *
 * Language-neutral: it knows punctuation, not words (the abbreviation list is the only English-specific part and is
 * only a guard against a premature split). Pure and synchronous; no provider, tool or Sales knowledge.
 */
export interface ChunkerOptions {
  firstChunkMinChars: number;
  minChunkChars: number;
  maxChunkChars: number;
}

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = { firstChunkMinChars: 10, minChunkChars: 24, maxChunkChars: 180 };

const TERMINATORS = new Set([".", "?", "!", "…", "।", "॥"]);
const CLOSERS = new Set(['"', "'", ")", "]", "”", "’", "»"]);
const ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "no", "nos", "vs", "etc", "approx", "rs", "inr", "sq", "ft", "est", "dept", "e.g", "i.e", "viz", "min", "max", "tel",
]);

export class SentenceChunker {
  private buffer = "";
  private emitted = 0;
  private readonly opts: ChunkerOptions;

  constructor(opts: Partial<ChunkerOptions> = {}) {
    this.opts = { ...DEFAULT_CHUNKER_OPTIONS, ...opts };
  }

  /** Adds a delta; returns the chunks that are now complete (usually none or one). */
  push(delta: string): string[] {
    this.buffer += delta;
    const out: string[] = [];
    for (;;) {
      const end = this.findBoundary();
      if (end < 0) break;
      out.push(this.take(end));
    }
    return out;
  }

  /** The reply is complete: whatever remains is the last chunk. */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (!rest) return [];
    this.emitted++;
    return [rest];
  }

  private min(): number {
    return this.emitted === 0 ? this.opts.firstChunkMinChars : this.opts.minChunkChars;
  }

  private take(end: number): string {
    const chunk = this.buffer.slice(0, end).trim();
    this.buffer = this.buffer.slice(end).replace(/^\s+/, "");
    this.emitted++;
    return chunk;
  }

  /** Index just past the chunk to emit, or -1 if more text is needed. */
  private findBoundary(): number {
    const b = this.buffer;
    const min = this.min();
    for (let i = 0; i < b.length; i++) {
      if (!TERMINATORS.has(b[i])) continue;
      let j = i + 1;
      while (j < b.length && (TERMINATORS.has(b[j]) || CLOSERS.has(b[j]))) j++; // "?!", '."', "..."
      if (j >= b.length) return -1; // the terminator is the last thing seen: wait for what follows
      if (!/\s/.test(b[j])) {
        i = j - 1; // "2.5", "Rs.70", "a.b": not a sentence end
        continue;
      }
      if (b[i] === "." && this.isAbbreviation(b, i)) continue;
      if (b.slice(0, j).trim().length < min) {
        i = j - 1; // too short to be worth a request on its own: merge with the next sentence
        continue;
      }
      return j;
    }
    if (b.length >= this.opts.maxChunkChars) return this.splitLong();
    return -1;
  }

  private isAbbreviation(b: string, dot: number): boolean {
    let s = dot;
    while (s > 0 && /[\p{L}.]/u.test(b[s - 1])) s--;
    const word = b.slice(s, dot).toLowerCase();
    if (word === "") return false;
    if (ABBREVIATIONS.has(word)) return true;
    return /^\p{L}$/u.test(word) && /\p{Lu}/u.test(b[s]); // a lone capital initial: "A. R. Rahman"
  }

  /** A long run with no sentence end: cut at the last clause punctuation, else the last space, past the minimum. */
  private splitLong(): number {
    const b = this.buffer.slice(0, this.opts.maxChunkChars);
    const min = this.min();
    for (let i = b.length - 1; i >= min; i--) {
      if (",;:—–".includes(b[i]) && i + 1 < b.length && /\s/.test(b[i + 1])) return i + 1;
    }
    for (let i = b.length - 1; i >= min; i--) {
      if (/\s/.test(b[i])) return i;
    }
    return -1;
  }
}
