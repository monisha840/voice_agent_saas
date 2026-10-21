/**
 * The one template helper every transactional email in the product is built from, so invites, password resets and
 * address verifications look and read the same without each feature inventing its own markup.
 *
 * Rules it enforces for its callers:
 *  - The plain text is the real message. A CTA appears in `text` as a bare, clickable-anywhere URL, never only as an
 *    HTML link, so a text-only client (or a recipient who distrusts HTML) loses nothing.
 *  - Every interpolated value is HTML-escaped: a person's name or an organization name cannot inject markup.
 *  - The HTML is one small, inline-styled document. Email clients strip <style> blocks, so there are none; there are
 *    no external images, no web fonts and no tracking pixels, so nothing leaks that the message was opened.
 *
 * It does NOT build URLs. The caller composes them from config.appBaseUrl (APP_BASE_URL) and passes them in.
 */

/** Escapes text for use in HTML element content AND in a double-quoted attribute value. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only http(s) may become a link. Anything else (javascript:, data:) is shown as plain text, never as an href. */
function isLinkableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function renderBasicEmail(input: {
  heading: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
  footer?: string;
}): { text: string; html: string } {
  const heading = input.heading.trim();
  const paragraphs = input.paragraphs.map((p) => p.trim()).filter((p) => p.length > 0);
  const footer = input.footer?.trim() ?? "";
  const cta = input.cta ? { label: input.cta.label.trim(), url: input.cta.url.trim() } : undefined;

  const textBlocks: string[] = [];
  if (heading) textBlocks.push(heading);
  textBlocks.push(...paragraphs);
  // The label names the action, the URL on its own line survives every wrapping and quoting a mail client applies.
  if (cta) textBlocks.push(`${cta.label}:\n${cta.url}`);
  if (footer) textBlocks.push(footer);
  const text = `${textBlocks.join("\n\n")}\n`;

  const htmlBlocks: string[] = [];
  if (heading) {
    htmlBlocks.push(`<h1 style="margin:0 0 16px;font-size:20px;line-height:28px;font-weight:600;color:#111827;">${escapeHtml(heading)}</h1>`);
  }
  for (const p of paragraphs) {
    htmlBlocks.push(`<p style="margin:0 0 16px;font-size:15px;line-height:24px;color:#374151;">${escapeHtml(p)}</p>`);
  }
  if (cta) {
    const label = escapeHtml(cta.label);
    const url = escapeHtml(cta.url);
    if (isLinkableUrl(cta.url)) {
      htmlBlocks.push(
        `<p style="margin:0 0 16px;"><a href="${url}" style="display:inline-block;padding:10px 18px;border-radius:6px;` +
          `background-color:#1d4ed8;color:#ffffff;font-size:15px;line-height:20px;font-weight:600;text-decoration:none;">${label}</a></p>`,
      );
    }
    // Always repeat the address as text: buttons get stripped, rewritten or simply not rendered.
    htmlBlocks.push(
      `<p style="margin:0 0 16px;font-size:13px;line-height:20px;color:#6b7280;word-break:break-all;">` +
        `${label}: ${isLinkableUrl(cta.url) ? `<a href="${url}" style="color:#1d4ed8;">${url}</a>` : url}</p>`,
    );
  }
  if (footer) {
    htmlBlocks.push(`<p style="margin:24px 0 0;font-size:12px;line-height:18px;color:#6b7280;">${escapeHtml(footer)}</p>`);
  }

  const html =
    `<!doctype html>\n<html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:24px;background-color:#f3f4f6;">` +
    `<div style="max-width:560px;margin:0 auto;padding:28px;background-color:#ffffff;border-radius:10px;` +
    `font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">` +
    `${htmlBlocks.join("")}</div></body></html>\n`;

  return { text, html };
}
