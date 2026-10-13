/**
 * One question per reply.
 *
 * A telecaller asks one thing and waits. A language model, told to ask at most one question, still often tacks on a
 * second or third ("...Saturday at 10 or 11:30? And is it 2 BHK or 3 BHK? What is your budget?"), which on a phone
 * call confuses the caller and gets only one of them answered. This keeps the statements and the FIRST question of a
 * reply and drops later questions, before anything is spoken or stored, so the history is exactly what the caller heard.
 *
 * Deterministic and language-neutral: it only knows sentence punctuation. A question that merely continues the
 * previous one with an alternative ("... 10 o'clock? Or 11:30?") is part of it and is kept.
 */

/** A sentence including its terminator(s), closing quote and trailing space. */
const SENTENCE = /[^.?!…।॥]+(?:[.?!…।॥]+["'”’)\]»]*)?\s*/gu;

/** Openers that make a question a continuation of the one before it (English, Tamil, Hindi). */
const ALTERNATIVE = /^\s*(?:or|இல்ல|இல்லன்னா|இல்லையென்றால்|அல்லது|या|या फिर)(?:\s|$)/iu;

export class QuestionLimiter {
  private asked = false;

  /** `text` without every question after the first; `dropped` says whether anything was removed. */
  filter(text: string): { text: string; dropped: boolean } {
    const parts = text.match(SENTENCE);
    if (!parts) return { text, dropped: false };
    let out = "";
    let dropped = false;
    let lastWasQuestion = false;
    for (const part of parts) {
      const isQuestion = part.includes("?");
      if (isQuestion) {
        const continuesPrevious = lastWasQuestion && ALTERNATIVE.test(part);
        if (this.asked && !continuesPrevious) {
          dropped = true;
          lastWasQuestion = false;
          continue;
        }
        this.asked = true;
      }
      lastWasQuestion = isQuestion;
      out += part;
    }
    return dropped ? { text: out.trim(), dropped } : { text, dropped: false };
  }
}
