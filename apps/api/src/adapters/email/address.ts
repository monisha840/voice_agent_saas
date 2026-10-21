/**
 * Address handling shared by the email adapters. Pure (no config, no I/O) so both providers and their tests agree on
 * what a usable address is.
 *
 * Why it is strict: an address and a display name end up in message headers. A value carrying CR/LF, a comma or an
 * angle bracket could add a header or a second recipient, so nothing of the sort is ever passed on — a bad address is
 * refused, and a bad display name is dropped rather than repaired into something the recipient would not recognise.
 */
import type { EmailAddress } from "./email.interface.js";

/**
 * Deliberately conservative: one @, no whitespace, no header-structuring characters, and a dotted domain. It rejects
 * a few exotic-but-legal addresses (quoted local parts, bare-hostname domains); a transactional product never needs
 * them, and letting one through costs more than refusing it.
 */
const ADDRESS = /^[^\s<>@,;:"]+@[^\s<>@,;:"]+\.[^\s<>@,;:"]+$/;

export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && ADDRESS.test(value);
}

/** Everything that could split or restructure a header is removed, not escaped; an empty result means "no name". */
export function sanitizeDisplayName(raw: string | undefined): string {
  if (!raw) return "";
  return raw
    .replace(/[\p{Cc}\p{Cf}"<>,;:\\]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 78);
}

/** `Name <name@example.com>`, or the bare address when there is no usable display name. Expects a valid address. */
export function formatAddress(addr: EmailAddress): string {
  const email = addr.email.trim();
  const name = sanitizeDisplayName(addr.name);
  return name ? `${name} <${email}>` : email;
}

/**
 * An address reduced to what a log line may carry: the domain, and only the first character of the local part
 * ("a***@example.com"). Enough to follow one delivery through the logs, not enough to be a mailing list.
 */
export function maskEmail(value: string): string {
  const at = value.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${value[0]}***${value.slice(at)}`;
}
