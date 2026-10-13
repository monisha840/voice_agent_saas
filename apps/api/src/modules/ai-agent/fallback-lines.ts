/**
 * The line spoken when the model could not finish a turn (it kept asking for tools and never produced words).
 * It follows the call's language so a Tamil call is not suddenly answered in English. Gender-neutral wording.
 */
const LINES: Record<string, string> = {
  "en-IN": "Sorry, let me have a colleague follow up with you on that.",
  "ta-IN": "மன்னிக்கவும், இதைப் பற்றி எங்கள் குழுவில் ஒருவர் உங்களைத் தொடர்புகொள்வார்.",
  "hi-IN": "माफ़ कीजिए, इस बारे में हमारी टीम का एक सदस्य आपसे संपर्क करेगा।",
};

const BY_NAME: Record<string, string> = { english: "en-IN", tamil: "ta-IN", hindi: "hi-IN" };

/** `language` is a code ("ta-IN") or a name ("Tamil"); anything unknown gets English. */
export function fallbackLine(language?: string | null): string {
  const key = (language ?? "").trim();
  const code = LINES[key] ? key : BY_NAME[key.toLowerCase()];
  return LINES[code ?? "en-IN"] ?? LINES["en-IN"];
}
