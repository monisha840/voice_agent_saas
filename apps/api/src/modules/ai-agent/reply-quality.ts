/**
 * A cheap, deterministic review of each spoken reply, for monitoring real calls. It never changes what is said: it
 * measures the reply and names the problems we have actually seen, so a pilot's calls can be filtered for them.
 *
 * Flags
 *  - too_long                    the reply is longer than a phone caller can comfortably follow
 *  - multiple_questions          two or more questions in one reply
 *  - booking_unconfirmed         a visit was booked this turn but the reply states no day, date or time
 *  - claims_booking_without_tool the reply says something was booked or confirmed, yet no booking succeeded this turn
 */

export type ReplyFlag = "too_long" | "multiple_questions" | "booking_unconfirmed" | "claims_booking_without_tool";

export interface ReplyReview {
  words: number;
  chars: number;
  flags: ReplyFlag[];
}

export const DEFAULT_MAX_REPLY_WORDS = 30;

/** Past-tense claims that something is booked or done (English and the colloquial Tamil the agent uses). */
const BOOKING_CLAIM = /\b(booked|confirmed)\b|பண்ணியாச்சு|ஆகியிருக்கு|பதிவு செய்யப்பட்டது/iu;
/** Any time or date digit, or an AM/PM marker. */
const HAS_TIME_OR_DATE = /\d|\b(a\.?m\.?|p\.?m\.?)\b/iu;

export function reviewReply(input: { text: string; bookedThisTurn: boolean; maxWords?: number }): ReplyReview {
  const text = input.text.trim();
  const words = text.split(/\s+/).filter(Boolean).length;
  const flags: ReplyFlag[] = [];

  if (words > (input.maxWords ?? DEFAULT_MAX_REPLY_WORDS)) flags.push("too_long");
  if ((text.match(/[?？]/g) ?? []).length >= 2) flags.push("multiple_questions");
  if (input.bookedThisTurn && !HAS_TIME_OR_DATE.test(text)) flags.push("booking_unconfirmed");
  if (!input.bookedThisTurn && BOOKING_CLAIM.test(text)) flags.push("claims_booking_without_tool");

  return { words, chars: text.length, flags };
}
