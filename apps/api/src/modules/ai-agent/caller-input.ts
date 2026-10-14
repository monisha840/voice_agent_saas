/**
 * Judging what the caller actually said, from the transcript.
 *
 * Two jobs, both pure and deterministic:
 *  - ignoring noise: a cough, a breath or a click is transcribed as "ம்" or "um" and must not become a caller turn
 *    (it would interrupt the agent, trigger a reply, and pollute the transcript and the summary);
 *  - noticing an explicit request to change language ("please speak in English", "தமிழில் பேசுங்க"), which the agent
 *    must honour from that turn on, whatever language it started in.
 */

/** Base forms of sounds people make that carry no content. Tamil is compared with the virama (்) removed. */
const FILLERS = new Set([
  // Tamil
  "ம", "மம", "மமம", "உம", "உமம", "ஆ", "ஆஆ", "ஆஹ", "ஆங", "ஓ", "ஹ", "ஹம", "ஹும", "அ", "எ", "ஏ",
  // English
  "um", "umm", "uh", "uhh", "hmm", "hm", "mm", "mmm", "mhm", "ah", "aah", "oh", "er", "erm", "huh", "eh", "ha",
]);

/** A sound this short with only filler in it is not a turn. Longer fillers ("hmm, let me think") are left to the model. */
export const FILLER_MAX_MS = 1000;

const VIRAMA = /்/g;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(VIRAMA, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/** True when the transcript is nothing but filler sounds (or has no letters or digits at all). */
export function isFillerOnly(text: string): boolean {
  const w = words(text);
  if (w.length === 0) return true;
  return w.every((token) => FILLERS.has(token));
}

/** How many words (letters or digits) a transcript has. */
export const wordCount = (text: string) => words(text).length;

/** A token with no letter in it: a number, a currency amount, a symbol ("₹100", "100", "%"). */
const hasLetter = (token: string) => /\p{L}/u.test(token);

/**
 * Text a recogniser makes up from noise: the same non-word token over and over ("₹100 ₹100 ₹100"), or one lone word
 * stretched over several seconds of "speech". Real answers are neither: a number is said once, and a long utterance has
 * several words.
 */
export function looksLikeNoiseTranscript(text: string, speechMs: number): boolean {
  const raw = text.trim().split(/\s+/).filter(Boolean);
  if (raw.length === 0) return true;
  // The same token with no letters in it, three or more times and nothing else.
  if (raw.length >= 3 && raw.every((t) => !hasLetter(t) && t === raw[0])) return true;
  // One word spread over many seconds.
  if (words(text).length <= 1 && speechMs >= NOISE_LONG_SPEECH_MS) return true;
  return false;
}

/** One word taking this long to say is not speech (a recogniser hallucinating over a noisy stretch). */
export const NOISE_LONG_SPEECH_MS = 4000;

/**
 * Should this utterance be dropped before the agent sees it? Short, content-free sounds are; so is text that has the
 * shape of a recogniser's guess over noise. A long filler may be a real, if hesitant, answer, and anything with
 * ordinary words in it is kept.
 */
export function shouldIgnoreUtterance(text: string, speechMs: number): boolean {
  if (words(text).length === 0) return true;
  if (looksLikeNoiseTranscript(text, speechMs)) return true;
  return isFillerOnly(text) && speechMs < FILLER_MAX_MS;
}

/** Indic languages that are not the ones this product's agents speak: hearing one is almost always someone else's TV or street. */
const UNRELATED_LANGUAGES = new Set(["te", "kn", "ml", "bn", "gu", "mr", "pa", "od", "or", "as", "ur"]);

const baseLanguage = (code: string) => code.toLowerCase().split(/[-_]/)[0];

/**
 * True when the recogniser says a SHORT utterance is in a language that neither the agent nor the caller has used on
 * this call (e.g. Telugu on a Tamil call): background speech, not an answer. Longer utterances are never dropped on
 * this ground alone (the recogniser's guess for a real caller can be wrong), and a language the call has used is allowed.
 */
export function isUnexpectedLanguage(heard: string | undefined, allowed: ReadonlyArray<string | undefined | null>, wordCount: number): boolean {
  if (!heard || wordCount > 4) return false;
  const h = baseLanguage(heard);
  if (!UNRELATED_LANGUAGES.has(h)) return false;
  return !allowed.some((a) => a && baseLanguage(a) === h);
}

const ENGLISH = "en-IN";
const TAMIL_CODE = "ta-IN";
const HINDI = "hi-IN";

/** Words that introduce a request to change language. Kept narrow: a wrong switch is sticky for the rest of the call. */
const ASK = "(?:speak|talk|reply|respond|answer|continue|switch|change|use|go back|come back|back|say it|explain it)";
const GAP = "[^.?!]{0,30}";
/** Ways to ask in Romanised Tamil ("tamil la pesunga"). */
const ROMAN_TAIL = "\\s*(?:la|le|il)\\s*(?:pesu|pesunga|pesungal|sollunga|solunga|solluga)";

/** Builds the patterns for one language name. `name` must not be the start of a longer name (see Tamil Nadu). */
function latinPatterns(name: string): RegExp[] {
  return [
    new RegExp(`\\bin ${name}\\b`, "i"),
    new RegExp(`\\b${ASK}\\b${GAP}\\b${name}\\b`, "i"),
    new RegExp(`\\b${name}\\s+(?:please|pls|only|again)\\b`, "i"),
    new RegExp(`\\b${name}${ROMAN_TAIL}`, "i"),
  ];
}

const LATIN_REQUESTS: Array<{ code: string; patterns: RegExp[] }> = [
  { code: ENGLISH, patterns: latinPatterns("english") },
  { code: TAMIL_CODE, patterns: latinPatterns("tamil(?!\\s*nadu)") },
  { code: HINDI, patterns: latinPatterns("hindi") },
];

const NATIVE_REQUESTS: Array<{ code: string; pattern: RegExp }> = [
  { code: ENGLISH, pattern: /ஆங்கிலத்தில்|ஆங்கிலத்துல|இங்கிலீஷ்\s*(ல|இல்|ல்)|இங்கிலீஷ்|இங்கிலிஷ்|இங்லீஷ்|इंग्लिश में|अंग्रेज़ी में|अंग्रेजी में/u },
  { code: TAMIL_CODE, pattern: /தமிழில்|தமிழ்ல|தமிழ்\s*ல்|தமிழ்\s*பேசு|தமிழுக்கு\s*மாறு|तमिल में/u },
  { code: HINDI, pattern: /हिंदी में|हिन्दी में|ஹிந்தியில்|ஹிந்தி\s*ல/u },
];

/**
 * The language the caller explicitly asked for, or null. When the caller names two languages in one sentence the
 * request is ambiguous and nothing changes.
 */
export function detectLanguageSwitchRequest(text: string): string | null {
  const hits = new Set<string>();
  for (const { code, patterns } of LATIN_REQUESTS) {
    if (patterns.some((p) => p.test(text))) hits.add(code);
  }
  for (const { code, pattern } of NATIVE_REQUESTS) {
    if (pattern.test(text)) hits.add(code);
  }
  return hits.size === 1 ? [...hits][0] : null;
}

/**
 * The caller's own voice level, learned over the call, so that a clearly quieter voice (a television in the next room,
 * people talking across the room) is not mistaken for them. The person on the phone is close to the microphone; the
 * background is not, so it arrives well below their level. Only a pronounced drop is treated as background, and only
 * once the caller's level is known from a couple of utterances.
 */
export class CallerLevelTracker {
  private level = 0;
  private seen = 0;

  constructor(
    /** An utterance below this fraction of the caller's level is background. */
    private readonly ratio = 0.4,
    /** Utterances needed before the level is trusted. */
    private readonly minSamples = 2,
  ) {}

  /** Judges one utterance by its mean voiced RMS. Accepted utterances update the caller's level; background does not. */
  isBackground(voicedRms: number | undefined): boolean {
    if (voicedRms === undefined || voicedRms <= 0) return false;
    if (this.seen >= this.minSamples && voicedRms < this.level * this.ratio) return true;
    this.level = this.seen === 0 ? voicedRms : this.level * 0.7 + voicedRms * 0.3;
    this.seen++;
    return false;
  }

  get callerLevel(): number {
    return this.level;
  }
}

/** Phrases a caller uses to finish the call themselves (English, Tamil, Hindi). Matched in a SHORT utterance only. */
const GOODBYE_PHRASES = [
  "bye", "goodbye", "good bye", "thank you", "thanks", "that's all", "that is all", "nothing else", "no thanks",
  "நன்றி", "போதும்", "அவ்வளவுதான்", "அவ்ளோதான்", "வச்சிடுறேன்", "வைக்கிறேன்", "பை",
  "धन्यवाद", "शुक्रिया", "बस", "अलविदा", "बाय",
];

/**
 * True when the caller is closing the conversation themselves ("ok thanks, bye", "நன்றி, bye", "அவ்வளவுதான்"). Only a
 * short utterance counts: "thanks, and what is the price of 3 BHK" is a question, not a goodbye.
 */
export function isCallerGoodbye(text: string): boolean {
  const w = words(text);
  if (w.length === 0 || w.length > 6) return false;
  const lower = text.toLowerCase();
  return GOODBYE_PHRASES.some((p) => lower.includes(p));
}
