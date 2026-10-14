/**
 * Fixed lines the system speaks when the model could not (it kept asking for tools, or its request failed) and the
 * operational lines of the call guard. They follow the call's language so a Tamil call is never suddenly answered in
 * English, are gender-neutral, and are spoken casually, the way a telecaller talks.
 */
type LineSet = {
  /** The model never produced words for this turn. */
  fallback: string;
  /** A reply was held back because it stated a figure no tool had returned. */
  verify: string;
  /** A reply was left with nothing to say once a repeated visit offer was removed. */
  more: string;
  /** The call is ending (end_call ran) and the model said no closing words: a plain acknowledgement, no goodbye yet. */
  noted: string;
  /** Spoken at the very end, after the line has stayed open without the caller adding anything. */
  goodbye: string;
  /** The model's request failed: ask the caller to say it again instead of going silent. */
  retry: string;
  /** The caller has been silent for a while. */
  reprompt: string;
  /** The caller stayed silent; the call is ending. */
  silenceEnd: string;
  /** The call reached its maximum length; it is ending. */
  maxDuration: string;
};

const LINES: Record<string, LineSet> = {
  "en-IN": {
    fallback: "Sorry, let me have a colleague follow up with you on that.",
    verify: "Let me confirm that figure and have the team share it with you.",
    more: "Is there anything else you would like to know about the project?",
    noted: "Alright, I have noted that.",
    goodbye: "Thank you for your time. Goodbye.",
    retry: "Sorry, I didn't catch that. Could you say it once more?",
    reprompt: "Hello, are you still there?",
    silenceEnd: "I'm not able to hear you, so I'll end the call now. Thank you, goodbye.",
    maxDuration: "We've reached the maximum time for this call, so I'll end it here. Thank you, and goodbye.",
  },
  "ta-IN": {
    fallback: "மன்னிக்கவும், இதைப் பற்றி எங்க டீம்ல ஒருத்தர் உங்களுக்கு கால் பண்ணுவாங்க.",
    verify: "அந்த விவரத்தை confirm பண்ணிட்டு நம்ம team உங்களுக்கு சொல்லுவாங்க.",
    more: "இந்த project பத்தி வேற ஏதாவது தெரிஞ்சுக்கணுமா?",
    noted: "சரி, note பண்ணிக்கிறேன்.",
    goodbye: "உங்க நேரத்துக்கு நன்றி. வணக்கம்.",
    retry: "சாரி, சரியா கேக்கல. ஒரு தடவை திரும்பச் சொல்லுங்களேன்?",
    reprompt: "ஹலோ, லைன்ல இருக்கீங்களா?",
    silenceEnd: "உங்க குரல் கேக்கல, அதனால கால் முடிக்கிறேன். நன்றி, வணக்கம்.",
    maxDuration: "இந்த கால் நேரம் முடிஞ்சுது, அதனால இத முடிக்கிறேன். நன்றி, வணக்கம்.",
  },
  "hi-IN": {
    fallback: "माफ़ कीजिए, इस बारे में हमारी टीम का एक सदस्य आपसे संपर्क करेगा।",
    verify: "यह जानकारी पक्की करके हमारी टीम आपको बताएगी।",
    more: "इस प्रोजेक्ट के बारे में और कुछ जानना है?",
    noted: "ठीक है, मैंने नोट कर लिया है।",
    goodbye: "आपके समय के लिए धन्यवाद। नमस्ते।",
    retry: "माफ़ कीजिए, ठीक से सुनाई नहीं दिया। एक बार फिर बता दीजिए?",
    reprompt: "हैलो, क्या आप लाइन पर हैं?",
    silenceEnd: "आपकी आवाज़ नहीं आ रही है, इसलिए कॉल समाप्त किया जा रहा है। धन्यवाद, नमस्ते।",
    maxDuration: "इस कॉल का समय पूरा हो गया है, इसलिए कॉल यहीं समाप्त किया जा रहा है। धन्यवाद, नमस्ते।",
  },
};

const BY_NAME: Record<string, string> = { english: "en-IN", tamil: "ta-IN", hindi: "hi-IN" };

export type FixedLine = keyof LineSet;

/** `language` is a code ("ta-IN") or a name ("Tamil"); anything unknown gets English. */
export function fixedLine(kind: FixedLine, language?: string | null): string {
  const key = (language ?? "").trim();
  const code = LINES[key] ? key : BY_NAME[key.toLowerCase()];
  return (LINES[code ?? "en-IN"] ?? LINES["en-IN"])[kind];
}

/** The line spoken when the model produced no words for a turn. */
export function fallbackLine(language?: string | null): string {
  return fixedLine("fallback", language);
}
