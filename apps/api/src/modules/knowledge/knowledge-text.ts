/**
 * Pure text handling for the knowledge base: validating and decoding uploads, cleaning text, splitting documents into
 * passages, and turning a caller's question into a full-text query. No database, no I/O.
 *
 * Uploaded content is DATA, never instructions: it is cleaned of control characters and invisible formatting
 * characters (which can hide text from a reviewer), normalised, and size-bounded. The search tool presents it to the
 * model as reference excerpts (see knowledge-tool.ts).
 */
import { createHash } from "node:crypto";

export const MAX_UPLOAD_BYTES = 200 * 1024;
export const MAX_ITEM_BODY_CHARS = 4000;
export const MAX_ITEM_TITLE_CHARS = 300;
export const MAX_CHUNKS_PER_DOCUMENT = 300;
export const TARGET_CHUNK_CHARS = 700;

/** The only formats the current infrastructure can process safely without new parsers. */
export const ALLOWED_UPLOADS: Readonly<Record<string, readonly string[]>> = {
  ".txt": ["text/plain"],
  ".md": ["text/markdown", "text/x-markdown", "text/plain"],
  ".csv": ["text/csv", "application/vnd.ms-excel", "text/plain"],
};

export class UploadRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadRejectedError";
  }
}

/** Control characters (except tab/newline), bidi overrides, zero-width and other invisible format characters. */
// eslint-disable-next-line no-control-regex -- deliberately matches control characters to strip or reject them
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Cleans free text: NFC, unsafe characters removed, line endings unified, runs of blank lines collapsed, trimmed. */
export function cleanText(input: string): string {
  return input
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(UNSAFE_CHARS, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface DecodedUpload {
  text: string;
  sizeBytes: number;
  sha256: string;
  extension: string;
}

/**
 * Validates an upload BEFORE anything is stored: extension and declared type on the allow-list, size bound, the bytes
 * really are UTF-8 text (no NUL bytes, decodes strictly), and not mostly unprintable. Throws UploadRejectedError with a
 * message safe to show the user.
 */
export function decodeUpload(input: { filename: string; contentType: string; contentBase64: string }): DecodedUpload {
  const name = input.filename.trim();
  // eslint-disable-next-line no-control-regex -- deliberately matches control characters to strip or reject them
  if (!name || name.length > 255 || /[\\/\u0000]/.test(name)) throw new UploadRejectedError("Invalid file name");
  const dot = name.lastIndexOf(".");
  const extension = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  const allowedTypes = ALLOWED_UPLOADS[extension];
  if (!allowedTypes) {
    throw new UploadRejectedError(`Unsupported file type "${extension || "(none)"}". Upload .txt, .md or .csv files.`);
  }
  const declared = input.contentType.trim().toLowerCase().split(";")[0];
  if (declared && !allowedTypes.includes(declared) && declared !== "application/octet-stream") {
    throw new UploadRejectedError(`The file's type (${declared}) does not match its ${extension} extension.`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input.contentBase64.replace(/\s/g, ""))) throw new UploadRejectedError("The file content is not valid base64");
  const bytes = Buffer.from(input.contentBase64, "base64");
  if (bytes.length === 0) throw new UploadRejectedError("The file is empty");
  if (bytes.length > MAX_UPLOAD_BYTES) throw new UploadRejectedError(`The file is larger than ${MAX_UPLOAD_BYTES / 1024} KB`);
  if (bytes.includes(0)) throw new UploadRejectedError("The file is not a text file");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UploadRejectedError("The file is not UTF-8 text");
  }
  const raw = text.replace(/^\uFEFF/, "");
  // Binary-ish content shows up as C0 control characters; invisible formatting characters are only stripped.
  // eslint-disable-next-line no-control-regex -- deliberately matches control characters to strip or reject them
  const unprintable = (raw.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g) ?? []).length;
  if (raw.length > 0 && unprintable / raw.length > 0.05) throw new UploadRejectedError("The file contains too many control characters");
  const cleaned = cleanText(raw);
  if (!cleaned) throw new UploadRejectedError("The file has no readable text");
  return { text: cleaned, sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), extension };
}

/**
 * Splits text into passages of about TARGET_CHUNK_CHARS: paragraphs are kept together when they fit, long paragraphs
 * are split at sentence ends, and anything still too long is hard-wrapped. Each passage is a searchable item.
 */
export function chunkText(text: string, target = TARGET_CHUNK_CHARS): string[] {
  const hardMax = Math.round(target * 1.6);
  const pieces: string[] = [];
  for (const para of text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean)) {
    if (para.length <= hardMax) {
      pieces.push(para);
      continue;
    }
    const sentences = para.match(/[^.!?।]+[.!?।]+["')\]]*\s*|[^.!?।]+$/g) ?? [para];
    let buf = "";
    for (const s of sentences) {
      if ((buf + s).length > target && buf) {
        pieces.push(buf.trim());
        buf = "";
      }
      buf += s;
      while (buf.length > hardMax) {
        pieces.push(buf.slice(0, target).trim());
        buf = buf.slice(target);
      }
    }
    if (buf.trim()) pieces.push(buf.trim());
  }
  // Merge small neighbours so passages carry enough context.
  const out: string[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length + p.length + 1 <= target) out[out.length - 1] = `${last}\n${p}`;
    else out.push(p);
  }
  return out;
}

/** A CSV becomes one passage per row ("header: value; ..."), so each row is retrievable on its own. */
export function csvToPassages(text: string): string[] {
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ""));
  if (rows.length === 0) return [];
  const [header, ...data] = rows;
  if (data.length === 0) return [header.join(", ")];
  return data.map((r) =>
    r
      .map((cell, i) => (cell.trim() ? `${(header[i] ?? `column ${i + 1}`).trim()}: ${cell.trim()}` : ""))
      .filter(Boolean)
      .join("; "),
  ).filter(Boolean);
}

/** Minimal RFC 4180 parser (quoted fields, escaped quotes, commas and newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Common English and Tanglish filler words that carry no meaning for retrieval. */
const STOPWORDS = new Set(
  (
    "a an the is are was were be been am do does did of to in on at for from by with and or but if then than so as it its this that these those " +
    "i me my we our you your he she they them their what which who whom whose when where why how can could would should will shall may might " +
    "please tell know want about any some there here have has had not no yes ok okay hi hello sir madam " +
    "enna epdi eppadi enga yenna sollunga solunga venum vendum irukka iruka iruku irukku pa da ma"
  ).split(" "),
);

/**
 * The words of a question, for an OR full-text query: letters, combining marks (Tamil vowel signs) and digits form
 * words in any script; filler words and single characters are dropped; at most 12 distinct words. The returned words
 * contain only \p{L}\p{M}\p{N}, so they are safe to join into a tsquery.
 */
export function queryTerms(question: string): string[] {
  const words = cleanText(question).toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
  const out: string[] = [];
  for (const w of words) {
    if (w.length < 2 || STOPWORDS.has(w) || out.includes(w)) continue;
    out.push(w);
    if (out.length >= 12) break;
  }
  return out;
}
