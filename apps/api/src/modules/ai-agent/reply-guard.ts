/**
 * Checks on what the agent is about to SAY, made in code because a prompt is only followed most of the time:
 *
 *  - the same site-visit offer is not made again and again;
 *  - a figure (price, size, distance) that no tool returned on this call is never spoken.
 *
 * Both work sentence by sentence on the reply, before it is spoken or stored, and are language-neutral where they can be
 * (digits, punctuation); the visit words are a short English/Tamil/Hindi list.
 */

/** A sentence including its terminator(s), closing quote and trailing space. */
const SENTENCE = /[^.?!…।॥]+(?:[.?!…।॥]+["'”’)\]»]*)?\s*/gu;

// --------------------------------------------------------------------------------------------------------------------
// Site-visit offers
// --------------------------------------------------------------------------------------------------------------------

const VISIT_WORDS = /\b(site\s*visit|visit|slots?|schedule|book(ing)?)\b|விசிட்|வருகை|வந்து\s*பார்|विज़िट|साइट\s*विज़िट|स्लॉट/iu;

/** True for a QUESTION that offers or asks about a visit ("Shall I arrange a site visit?", "site visit ஏற்பாடு பண்ணட்டுமா?"). */
export function isVisitOffer(sentence: string): boolean {
  return sentence.includes("?") && VISIT_WORDS.test(sentence);
}

/** True when the caller's own words are about visiting, so an offer in the answer is a reply, not a push. */
export function callerAskedAboutVisit(callerText: string): boolean {
  return VISIT_WORDS.test(callerText) || /\b(come|coming|see the (flat|house|place|project|site)|saturday|sunday|weekend|tomorrow|next week)\b|வர(ணும்|லாமா|ேன்)|பார்க்க\s*(முடியும்|வரணும்)|कब\s*आ/iu.test(callerText);
}

/** True when a whole reply contains a visit offer (used to look back over the agent's last replies). */
export function replyOffersVisit(reply: string): boolean {
  return (reply.match(SENTENCE) ?? []).some((s) => isVisitOffer(s));
}

// --------------------------------------------------------------------------------------------------------------------
// Figures
// --------------------------------------------------------------------------------------------------------------------

const NUMBER = /\d[\d,]*(?:\.\d+)?/g;
const toNumber = (raw: string): number => Number(raw.replace(/,/g, ""));

/** Every number written in the given texts (tool results, what the caller said). */
export function numbersIn(texts: readonly string[]): Set<number> {
  const out = new Set<number>();
  for (const t of texts) for (const m of t.match(NUMBER) ?? []) {
    const n = toNumber(m);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

const UNIT_LAKH = "(?:lakhs?|lacs?|lakh|லட்சம்|லட்சத்து\\S*|இலட்சம்|இலட்சத்து\\S*|लाख)";
const UNIT_CRORE = "(?:crores?|cr\\b|கோடியே|கோடி|करोड़|करोड)";
const UNIT_SQFT = "(?:sq\\.?\\s*ft|sqft|square\\s*feet|சதுர\\s*அடி|वर्ग\\s*फीट)";
const UNIT_KM = "(?:km|kms|kilomet(?:er|re)s?|கி\\.?மீ\\.?|கிலோமீட்டர்\\S*|किमी|किलोमीटर)";
const UNIT_MIN = "(?:min(?:ute)?s?|நிமிட\\S*|मिनट)";

const AMOUNT = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*(${UNIT_CRORE}|${UNIT_LAKH}|${UNIT_SQFT}|${UNIT_KM}|${UNIT_MIN})`, "giu");
const COMPOSITE = new RegExp(`(\\d[\\d,]*(?:\\.\\d+)?)\\s*${UNIT_CRORE}\\D{0,12}?(\\d[\\d,]*(?:\\.\\d+)?)\\s*${UNIT_LAKH}`, "giu");
const RUPEE = /(?:₹|rs\.?|inr|ரூ\.?|रु\.?)\s*(\d[\d,]*(?:\.\d+)?)/giu;

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.005);

/** Does `value` (in the unit it was spoken in) match something the tools returned, raw or scaled to rupees? */
function grounded(value: number, unit: string, known: ReadonlySet<number>): boolean {
  const candidates: number[] = [value];
  if (new RegExp(`^${UNIT_CRORE}$`, "iu").test(unit)) candidates.push(value * 1e7);
  else if (new RegExp(`^${UNIT_LAKH}$`, "iu").test(unit)) candidates.push(value * 1e5);
  for (const k of known) for (const c of candidates) if (near(c, k)) return true;
  return false;
}

/**
 * The figures in `sentence` (a price, an area, a distance, a travel time) that are not in `known`. A bare number with no
 * unit is not judged: it may be a count or a time of day. "1 crore 10 lakhs" is read as 1.10 crore.
 */
export function ungroundedFigures(sentence: string, known: ReadonlySet<number>): string[] {
  const bad: string[] = [];
  const covered: Array<[number, number]> = [];

  for (const m of sentence.matchAll(COMPOSITE)) {
    const total = toNumber(m[1]) * 1e7 + toNumber(m[2]) * 1e5;
    covered.push([m.index!, m.index! + m[0].length]);
    if (![...known].some((k) => near(total, k))) bad.push(m[0].trim());
  }
  const inComposite = (i: number) => covered.some(([a, b]) => i >= a && i < b);

  for (const m of sentence.matchAll(AMOUNT)) {
    if (inComposite(m.index!)) continue;
    const value = toNumber(m[1]);
    if (!grounded(value, m[2], known)) bad.push(m[0].trim());
  }
  for (const m of sentence.matchAll(RUPEE)) {
    if (inComposite(m.index!)) continue;
    const value = toNumber(m[1]);
    if (!grounded(value, "₹", known)) bad.push(m[0].trim());
  }
  return bad;
}

// --------------------------------------------------------------------------------------------------------------------
// The guard
// --------------------------------------------------------------------------------------------------------------------

export interface ReplyGuardOptions {
  /** Numbers the reply may state (from tool results and the caller's own words). */
  knownNumbers: ReadonlySet<number>;
  /** True when a visit offer must not be made now (one was made a moment ago and the caller did not ask about visiting). */
  suppressVisitOffer: boolean;
}

export interface GuardResult {
  text: string;
  /** A visit-offer sentence was removed. */
  visitOfferRemoved: boolean;
  /** Figures that no tool returned, whose sentences were removed. */
  ungrounded: string[];
}

export class ReplyGuard {
  constructor(private readonly opts: ReplyGuardOptions) {}

  /** `text` with the offending sentences removed. Pure: the same input gives the same output. */
  filter(text: string): GuardResult {
    const parts = text.match(SENTENCE);
    if (!parts) return { text, visitOfferRemoved: false, ungrounded: [] };
    let out = "";
    let visitOfferRemoved = false;
    const ungrounded: string[] = [];
    for (const part of parts) {
      const bad = ungroundedFigures(part, this.opts.knownNumbers);
      if (bad.length > 0) {
        ungrounded.push(...bad);
        continue;
      }
      if (this.opts.suppressVisitOffer && isVisitOffer(part)) {
        visitOfferRemoved = true;
        continue;
      }
      out += part;
    }
    if (!visitOfferRemoved && ungrounded.length === 0) return { text, visitOfferRemoved: false, ungrounded: [] };
    return { text: out.trim(), visitOfferRemoved, ungrounded };
  }
}
