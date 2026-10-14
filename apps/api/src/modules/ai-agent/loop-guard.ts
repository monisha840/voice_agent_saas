/**
 * Two small judgements about the agent's own replies, used to keep a conversation from going round in circles:
 *
 *  - `replySimilarity`: how alike two replies are (word overlap). A model that cannot do what it was asked tends to say
 *    the same thing again; the session counts such repeats and changes tack, then wraps up.
 *  - `announcesEndOfCall`: the reply says the call is being ended ("I have closed the call", "call close
 *    பண்றேன்") without having called end_call, so the call would carry on after being announced as over.
 *
 * Both are deterministic and language-neutral where they can be; the closing phrases are a short Tamil/English/Hindi list.
 */

const normalise = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 0);

/** Fewer words than this are too short to call a repeat ("OK", "Sure, noted"). */
const MIN_WORDS = 4;

/** Jaccard overlap (0..1) of the two replies' word sets; 0 when either is too short to judge. */
export function replySimilarity(a: string, b: string): number {
  const wa = normalise(a);
  const wb = normalise(b);
  if (wa.length < MIN_WORDS || wb.length < MIN_WORDS) return 0;
  const sa = new Set(wa);
  const sb = new Set(wb);
  let shared = 0;
  for (const w of sa) if (sb.has(w)) shared++;
  return shared / (sa.size + sb.size - shared);
}

/** Two replies this alike count as the agent repeating itself. */
export const REPEAT_SIMILARITY = 0.6;

export function isRepeat(reply: string, previous: readonly string[]): boolean {
  return previous.some((p) => replySimilarity(reply, p) >= REPEAT_SIMILARITY);
}

/** A sentence is split at its terminator; the terminator stays with it. */
const SENTENCES = /[^.?!…।॥]+[.?!…।॥]*/gu;

/** "can close the call", "shall I end the call", "if you want we can cut the call": an offer or a condition, not an announcement. */
const OFFER_BEFORE = /\b(can|could|shall|should|may|might|would|will you|do you|want|like|if|or|unless|before|until)\b/i;

const CLOSING_EN =
  /\b(ending|end|ended|closing|close|closed|cutting|cut|disconnecting|disconnect|disconnected)\s+(the|this|our|my|your)\s+call\b|\bcall\s+(is|has been|was|will be|is being)\s+(ended|closed|cut|disconnected)\b|\bhang(ing)?\s+up\b/i;
const CLOSING_TA = /(கால்|call|கால)[^.?!]{0,15}(close|cut|end|கட்|கிளோஸ்|முடிக்)/iu;
const CLOSING_HI = /(कॉल|काल)[^.?!]{0,15}(बंद|समाप्त|कट)/u;

/**
 * True when a statement (not a question, not an offer) in the reply says the call is being ended. The caller then hears
 * a goodbye, so the call must really end; the session honours it as if end_call had been called.
 */
export function announcesEndOfCall(text: string): boolean {
  const sentences = text.match(SENTENCES) ?? [];
  for (const raw of sentences) {
    const s = raw.trim();
    if (!s || s.includes("?")) continue;
    // The Tamil and Hindi patterns look for the English word "call" too, so they only apply to a sentence in that script.
    const m = CLOSING_EN.exec(s) ?? (/\p{Script=Tamil}/u.test(s) ? CLOSING_TA.exec(s) : null) ?? (/\p{Script=Devanagari}/u.test(s) ? CLOSING_HI.exec(s) : null);
    if (!m) continue;
    const before = s.slice(Math.max(0, m.index - 30), m.index + 12);
    if (OFFER_BEFORE.test(before)) continue;
    return true;
  }
  return false;
}
