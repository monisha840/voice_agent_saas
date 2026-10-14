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

import { replySimilarity } from "./loop-guard.js";

/** A sentence including its terminator(s), closing quote and trailing space. */
const SENTENCE = /[^.?!…।॥]+(?:[.?!…।॥]+["'”’)\]»]*)?\s*/gu;

/** Openers that make a question a continuation of the one before it (English, Tamil, Hindi). */
const ALTERNATIVE = /^\s*(?:or|இல்ல|இல்லன்னா|இல்லையென்றால்|அல்லது|या|या फिर)(?:\s|$)/iu;

/** A question this alike to one asked a moment ago is the same question again. */
export const SAME_QUESTION_SIMILARITY = 0.6;

/** A question is only judged "the same again" when it has at least this many words. */
const MIN_QUESTION_WORDS = 7;

/** The sentences of a text that are questions (contain "?"), trimmed. */
export function questionsIn(text: string): string[] {
  return (text.match(SENTENCE) ?? []).filter((s) => s.includes("?")).map((s) => s.trim());
}

export class QuestionLimiter {
  private asked = false;

  /**
   * `avoid`: questions the agent asked in its last replies. A question in the new reply that is the same again
   * (word overlap) is dropped: the caller did not answer it and does not need to hear it a second time word for word.
   */
  constructor(private readonly avoid: readonly string[] = []) {}

  /** `text` without every question after the first; `dropped` says whether anything was removed. */
  filter(text: string): { text: string; dropped: boolean } {
    const parts = text.match(SENTENCE);
    if (!parts) return { text, dropped: false };
    let out = "";
    let dropped = false;
    let lastWasQuestion = false;
    for (const part of parts) {
      const isQuestion = part.includes("?");
      // Only longer questions are compared: short ones ("Do you need a loan?" / "Do you need a visit?") share a frame
      // and are different questions.
      if (isQuestion && part.trim().split(/\s+/).length >= MIN_QUESTION_WORDS && this.avoid.some((a) => replySimilarity(part, a) >= SAME_QUESTION_SIMILARITY)) {
        dropped = true;
        lastWasQuestion = false;
        continue;
      }
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
