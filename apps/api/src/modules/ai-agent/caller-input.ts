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

/**
 * Should this utterance be dropped before the agent sees it? Only short, content-free sounds are: a long filler may be
 * a real, if hesitant, answer, and anything with a word in it is kept.
 */
export function shouldIgnoreUtterance(text: string, speechMs: number): boolean {
  if (words(text).length === 0) return true;
  return isFillerOnly(text) && speechMs < FILLER_MAX_MS;
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
