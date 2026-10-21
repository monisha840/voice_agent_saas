/**
 * Cleaning of a speech-to-text transcript before it reaches the model.
 *
 * Speech recognisers can fall into a repetition loop on noisy or unclear audio and emit the same word or phrase
 * hundreds of times. That text would be spoken back, stored in the call record and fed to the summary, so a long run is
 * collapsed to a couple of repeats. Real speech does not repeat one phrase more than a handful of times.
 */

export interface CollapsedText {
  text: string;
  /** True when at least one run was shortened. */
  collapsed: boolean;
  /** How many words were dropped. */
  removedWords: number;
}

const MIN_RUN = 6; // a phrase repeated this many times in a row is treated as a loop
const KEEP = 2; // copies kept of a looped phrase
const MAX_PHRASE_WORDS = 4;

const normal = (w: string) => w.replace(/[.,!?;:"'()-]/g, "").toLowerCase();

export function collapseRepetition(input: string): CollapsedText {
  let words = input.trim().split(/\s+/).filter(Boolean);
  const originalCount = words.length;
  if (originalCount < MIN_RUN) return { text: input.trim(), collapsed: false, removedWords: 0 };

  for (let n = 1; n <= MAX_PHRASE_WORDS; n++) {
    const out: string[] = [];
    let i = 0;
    while (i < words.length) {
      // How many times does the n-word phrase starting at i repeat back to back?
      let repeats = 1;
      while (i + (repeats + 1) * n <= words.length && phraseEquals(words, i, i + repeats * n, n)) repeats++;
      if (repeats >= MIN_RUN) {
        for (let k = 0; k < KEEP * n; k++) out.push(words[i + k]);
        i += repeats * n;
      } else {
        out.push(words[i]);
        i++;
      }
    }
    words = out;
  }

  const removedWords = originalCount - words.length;
  return { text: words.join(" "), collapsed: removedWords > 0, removedWords };
}

function phraseEquals(words: string[], a: number, b: number, n: number): boolean {
  for (let k = 0; k < n; k++) {
    if (normal(words[a + k]) !== normal(words[b + k]) || normal(words[a + k]) === "") return false;
  }
  return true;
}
