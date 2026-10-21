/**
 * Which language the caller is speaking, so an agent that mirrors the caller can answer in it.
 *
 * Pure and deterministic. The script of the transcript is the primary signal (Tamil letters mean Tamil, whatever a
 * detector labelled the audio); only a Latin-script transcript falls back to the provider's own language label. Very
 * short utterances ("ok", "haan") never switch the language: they carry too little to decide on.
 */
import { LANGUAGE_NAME } from "./persona.js";

const ENGLISH = "en-IN";

/**
 * Unicode block -> agent language code. Latin is handled separately.
 *
 * Wider than SUPPORTED_LANGUAGES on purpose: an agent can only be CONFIGURED in English or Tamil, but a caller can
 * speak whatever they like, and an agent that mirrors the caller should answer in the language they used rather than
 * keep talking past them. Trimming this table would not make those callers go away; it would only make the agent
 * answer them in the wrong language.
 */
const SCRIPTS: ReadonlyArray<{ code: string; from: number; to: number }> = [
  { code: "ta-IN", from: 0x0b80, to: 0x0bff },
  { code: "hi-IN", from: 0x0900, to: 0x097f },
  { code: "bn-IN", from: 0x0980, to: 0x09ff },
  { code: "pa-IN", from: 0x0a00, to: 0x0a7f },
  { code: "gu-IN", from: 0x0a80, to: 0x0aff },
  { code: "od-IN", from: 0x0b00, to: 0x0b7f },
  { code: "te-IN", from: 0x0c00, to: 0x0c7f },
  { code: "kn-IN", from: 0x0c80, to: 0x0cff },
  { code: "ml-IN", from: 0x0d00, to: 0x0d7f },
];

/** A caller who mixes languages gets the Indian one once this share of their letters is in its script. */
const NON_LATIN_SHARE = 0.2;
/** Fewer words than this never change the language. */
const MIN_WORDS = 2;

export function isReplyLanguage(code: string | undefined): code is string {
  return !!code && (code === ENGLISH || code in LANGUAGE_NAME);
}

/** The language's name as the model should read it ("Tamil"), or undefined for a code we do not know. */
export function replyLanguageName(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (code === ENGLISH) return "English";
  return LANGUAGE_NAME[code];
}

/**
 * The language to reply in, or null when the utterance should not change it (too short, or nothing decisive).
 * `providerCode` is the speech provider's label for the utterance, used only for Latin-script text.
 */
export function detectReplyLanguage(text: string, providerCode?: string): string | null {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length < MIN_WORDS) return null;

  const counts = new Map<string, number>();
  let letters = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const script = SCRIPTS.find((s) => cp >= s.from && cp <= s.to);
    if (script) {
      counts.set(script.code, (counts.get(script.code) ?? 0) + 1);
      letters++;
    } else if (/\p{L}/u.test(ch)) {
      counts.set("latin", (counts.get("latin") ?? 0) + 1);
      letters++;
    }
  }
  if (letters === 0) return null;

  let best: { code: string; n: number } | null = null;
  for (const [code, n] of counts) {
    if (code !== "latin" && (!best || n > best.n)) best = { code, n };
  }
  if (best && best.n / letters >= NON_LATIN_SHARE) return best.code;

  // Latin script: English, unless the provider says it heard another language we can name (e.g. romanised Hindi).
  // Romanised Tamil ("enna rate sir") lands here too and is answered in Tamil when the provider labels it ta-IN,
  // which is the Tanglish case: there is no separate Tanglish code, only Tamil with English words in it.
  if (isReplyLanguage(providerCode)) return providerCode;
  return ENGLISH;
}
