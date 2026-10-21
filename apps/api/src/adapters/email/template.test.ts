/**
 * renderBasicEmail: the plain text must stand on its own, and nothing interpolated may become markup.
 */
import { describe, it, expect } from "vitest";
import { renderBasicEmail, escapeHtml } from "./template.js";

describe("renderBasicEmail", () => {
  const input = {
    heading: "You have been invited to Acme Realty",
    paragraphs: ["Priya invited you to join Acme Realty on Voice Agent.", "The link below expires in 7 days."],
    cta: { label: "Accept the invitation", url: "https://app.example.com/invite/accept?token=abc.def-123" },
    footer: "If you did not expect this email you can ignore it.",
  };

  it("puts the CTA url in the text as a bare url, on its own line, not only as a link", () => {
    const { text } = renderBasicEmail(input);
    expect(text).toContain("Accept the invitation:\nhttps://app.example.com/invite/accept?token=abc.def-123");
    expect(text).not.toContain("<a ");
    expect(text).not.toContain("href");
  });

  it("the text alone carries the whole message (heading, every paragraph, the url and the footer)", () => {
    const { text } = renderBasicEmail(input);
    for (const part of [input.heading, ...input.paragraphs, input.cta.url, input.footer]) {
      expect(text).toContain(part);
    }
    expect(text.endsWith("\n")).toBe(true);
  });

  it("html carries the same content as the text, with the url both as a link and as readable text", () => {
    const { html } = renderBasicEmail(input);
    expect(html).toContain(input.heading);
    for (const p of input.paragraphs) expect(html).toContain(p);
    expect(html).toContain(input.footer);
    // Once as the button's href, once in the "copy this" line.
    const occurrences = html.split("https://app.example.com/invite/accept?token=abc.def-123").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(html).toContain('<a href="https://app.example.com/invite/accept?token=abc.def-123"');
  });

  it("escapes every interpolated value: a name or organization name cannot inject markup", () => {
    const { html, text } = renderBasicEmail({
      heading: 'Welcome <script>alert("x")</script>',
      paragraphs: ['Priya "The Closer" <priya@evil.test> & co invited you'],
      cta: { label: "<b>Click</b>", url: "https://app.example.com/a?x=1&y=2" },
      footer: "</div><img src=x onerror=alert(1)>",
    });
    // Every "<" an input brought with it is text, so no tag and no attribute can come from an input.
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>Click</b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("&amp;y=2");
    // The text body is not HTML, so it keeps the characters as typed.
    expect(text).toContain('Priya "The Closer" <priya@evil.test> & co invited you');
  });

  it("never links a url that is not http(s), but still shows it in both bodies", () => {
    const { html, text } = renderBasicEmail({
      heading: "Reset your password",
      paragraphs: ["Use the link below."],
      cta: { label: "Reset", url: "javascript:alert(1)" },
    });
    expect(html).not.toContain("href=");
    expect(html).toContain("javascript:alert(1)");
    expect(text).toContain("Reset:\njavascript:alert(1)");
  });

  it("drops empty paragraphs and optional parts instead of leaving blank blocks", () => {
    const { html, text } = renderBasicEmail({ heading: "Verify your email", paragraphs: ["Tap the link.", "   ", ""] });
    expect(text).toBe("Verify your email\n\nTap the link.\n");
    expect(html.match(/<p /g) ?? []).toHaveLength(1);
  });

  it("stays a self-contained document: no <style> block, no external image, no tracking pixel", () => {
    const { html } = renderBasicEmail(input);
    expect(html).not.toContain("<style");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("src=");
    // The CTA is the only address in the document: nothing is fetched when the message is opened.
    expect(new Set(html.match(/https?:\/\/[^"\s<]+/g) ?? [])).toEqual(new Set([input.cta.url]));
  });
});

describe("escapeHtml", () => {
  it("escapes the five characters that matter in content and in a quoted attribute", () => {
    expect(escapeHtml(`<a href="x" title='y'>&`)).toBe("&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;");
  });
});
