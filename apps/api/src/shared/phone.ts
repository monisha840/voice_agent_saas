import { ValidationError } from "./errors.js";

/**
 * Normalizes an Indian mobile number to E.164 (+91XXXXXXXXXX), which is the
 * format Exotel needs for the customer's number. Accepts common typed
 * forms: "9876543210", "09876543210", "919876543210", "+91 98765-43210",
 * "0091 9876543210". Rejects anything else with a clear message, so a bad
 * number fails here instead of as a confusing provider error.
 */
export function normalizeIndianMobile(input: string): string {
  const digits = input.trim().replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(digits)) {
    throw new ValidationError(`Phone number "${input}" contains invalid characters`);
  }

  let national: string;
  if (digits.startsWith("+91")) national = digits.slice(3);
  else if (digits.startsWith("+")) throw new ValidationError("Only Indian (+91) phone numbers are supported");
  else if (digits.startsWith("0091")) national = digits.slice(4);
  else if (digits.length === 12 && digits.startsWith("91")) national = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) national = digits.slice(1);
  else national = digits;

  if (!/^[6-9]\d{9}$/.test(national)) {
    throw new ValidationError(
      `"${input}" is not a valid Indian mobile number (expected 10 digits starting with 6-9, optionally prefixed with +91)`,
    );
  }
  return `+91${national}`;
}

/**
 * Best-effort E.164 for a number a telephony provider reports as the DIALED number (an ExoPhone), which is often a
 * landline or an international number, not just an Indian mobile. Accepts "+91 80 1234 5678", "08012345678",
 * "918012345678", "0091...", "8012345678". Used only to look the number up in the inbound routing table, where the
 * stored form is E.164 (see agents/agent-phone-numbers.service.ts). Throws ValidationError when it is not a number.
 */
export function normalizeDialedNumber(input: string): string {
  const digits = input.trim().replace(/[\s\-().]/g, "");
  if (!/^\+?\d{6,20}$/.test(digits)) throw new ValidationError(`"${input}" is not a phone number`);
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("0091")) return `+91${digits.slice(4)}`;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith("0")) return `+91${digits.slice(1)}`; // national trunk prefix (India)
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}
