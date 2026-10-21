/**
 * Minimal Server-Sent Events reader for a fetch() response body. Provider-neutral.
 *
 * Yields the `data:` payload of each event (multi-line data joined with "\n"); ignores comments, `event:`, `id:` and
 * `retry:` fields. Handles events split across network chunks and CRLF / LF / CR line endings. Memory is bounded: a
 * single event larger than `maxEventBytes` aborts the read instead of buffering without limit.
 */
export const DEFAULT_MAX_SSE_EVENT_BYTES = 1024 * 1024;

export class SseOverflowError extends Error {
  constructor() {
    super("SSE event exceeded the size limit");
    this.name = "SseOverflowError";
  }
}

export async function* readSse(body: ReadableStream<Uint8Array>, maxEventBytes = DEFAULT_MAX_SSE_EVENT_BYTES): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let data: string[] = [];
  let dataBytes = 0;

  const flushEvent = (): string | undefined => {
    if (data.length === 0) return undefined;
    const out = data.join("\n");
    data = [];
    dataBytes = 0;
    return out;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // A line ends at \n, \r\n or a lone \r. A trailing \r may be half of \r\n: keep it for the next chunk.
      for (;;) {
        const m = /\r\n|\n|\r(?!$)/.exec(buffer);
        if (!m) break;
        const line = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        if (line === "") {
          const ev = flushEvent();
          if (ev !== undefined) yield ev;
        } else if (!line.startsWith(":")) {
          const colon = line.indexOf(":");
          const field = colon < 0 ? line : line.slice(0, colon);
          if (field === "data") {
            let v = colon < 0 ? "" : line.slice(colon + 1);
            if (v.startsWith(" ")) v = v.slice(1);
            dataBytes += v.length + 1;
            if (dataBytes > maxEventBytes) throw new SseOverflowError();
            data.push(v);
          }
        }
      }
      if (buffer.length > maxEventBytes) throw new SseOverflowError();
    }
    buffer += decoder.decode();
    // A final event with no terminating blank line is still an event.
    if (buffer.length > 0 && !buffer.startsWith(":") && buffer.startsWith("data")) {
      const colon = buffer.indexOf(":");
      let v = colon < 0 ? "" : buffer.slice(colon + 1);
      if (v.startsWith(" ")) v = v.slice(1);
      data.push(v.replace(/\r$/, ""));
    }
    const last = flushEvent();
    if (last !== undefined) yield last;
  } finally {
    // Releases the connection whether we finished, were cancelled, or the consumer stopped reading.
    reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
