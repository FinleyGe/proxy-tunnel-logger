import zlib from "node:zlib";
import type { BodyEncoding, DecodedBodyPreview, SSEEventItem } from "./types.ts";

const utf8FatalDecoder = new TextDecoder("utf-8", { fatal: true });

export interface CapturedBody {
  body: string;
  encoding: BodyEncoding;
  bytes: number;
  truncated: boolean;
}

/**
 * Accumulate streamed chunks up to a configurable byte limit while tracking exact total size.
 */
export class BoundedCapture {
  private readonly maxBytes: number;
  private readonly chunks: Uint8Array[] = [];
  private capturedBytes = 0;
  public totalBytes = 0;
  public truncated = false;

  constructor(maxBytes: number) {
    this.maxBytes = maxBytes === 0 ? Number.POSITIVE_INFINITY : maxBytes;
  }

  push(chunk: Uint8Array): void {
    if (chunk.byteLength === 0) return;
    this.totalBytes += chunk.byteLength;

    if (this.capturedBytes >= this.maxBytes) {
      this.truncated = true;
      return;
    }

    const remaining = this.maxBytes - this.capturedBytes;
    if (chunk.byteLength <= remaining) {
      this.chunks.push(chunk);
      this.capturedBytes += chunk.byteLength;
    } else {
      this.chunks.push(chunk.subarray(0, remaining));
      this.capturedBytes += remaining;
      this.truncated = true;
    }
  }

  finalize(): CapturedBody {
    if (this.capturedBytes === 0) {
      return { body: "", encoding: "utf8", bytes: this.totalBytes, truncated: this.truncated };
    }
    const buf = Buffer.concat(this.chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
    const text = tryDecodeUtf8Text(buf);
    if (text !== null) {
      return { body: text, encoding: "utf8", bytes: this.totalBytes, truncated: this.truncated };
    }
    return {
      body: buf.toString("base64"),
      encoding: "base64",
      bytes: this.totalBytes,
      truncated: this.truncated,
    };
  }
}

/**
 * Return decoded string if buffer is valid UTF-8 without binary control characters, else null.
 */
export function tryDecodeUtf8Text(buf: Buffer): string | null {
  if (buf.length === 0) return "";
  if (buf.includes(0)) return null;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
      return null;
    }
  }
  try {
    return utf8FatalDecoder.decode(buf);
  } catch {
    return null;
  }
}

function decompressSingleLayer(buf: Buffer, algo: string): Buffer {
  switch (algo) {
    case "gzip":
    case "x-gzip":
      return zlib.gunzipSync(buf);
    case "deflate":
      try {
        return zlib.inflateSync(buf);
      } catch {
        return zlib.inflateRawSync(buf);
      }
    case "br":
      return zlib.brotliDecompressSync(buf);
    case "zstd":
      return zlib.zstdDecompressSync(buf);
    case "identity":
      return buf;
    default:
      throw new Error(`Unsupported Content-Encoding: ${algo}`);
  }
}

/**
 * Parse SSE stream text into structured event blocks for inspector display.
 */
export function parseSseEvents(text: string): SSEEventItem[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split("\n\n");
  const events: SSEEventItem[] = [];

  for (const block of blocks) {
    if (!block.trim()) continue;
    let id: string | undefined;
    let event: string | undefined;
    let retry: number | undefined;
    const dataLines: string[] = [];

    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue; // SSE comment
      const colonIdx = line.indexOf(":");
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      let value = colonIdx === -1 ? "" : line.slice(colonIdx + 1);
      if (value.startsWith(" ")) value = value.slice(1);

      if (field === "id") id = value;
      else if (field === "event") event = value;
      else if (field === "data") dataLines.push(value);
      else if (field === "retry") {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) retry = parsed;
      }
    }

    if (dataLines.length > 0 || event !== undefined || id !== undefined) {
      events.push({
        index: events.length + 1,
        id,
        event,
        retry,
        data: dataLines.join("\n"),
      });
    }
  }

  return events;
}

/**
 * Decode stored raw body (and optional Content-Encoding) on the server for UI display only.
 */
export function decodeBodyForDisplay(
  body: string | undefined,
  encoding: BodyEncoding | undefined,
  contentEncoding?: string,
  contentType?: string
): DecodedBodyPreview | undefined {
  if (body === undefined) return undefined;
  const rawBuf = encoding === "base64" ? Buffer.from(body, "base64") : Buffer.from(body, "utf8");
  if (rawBuf.length === 0) {
    return { text: "", isBinary: false, decompressed: false, contentEncoding };
  }

  let currentBuf: Buffer = rawBuf;
  let decompressed = false;
  let decompressionError: string | undefined;

  if (contentEncoding) {
    const algos = contentEncoding
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s && s !== "identity");

    if (algos.length > 0) {
      try {
        for (let i = algos.length - 1; i >= 0; i--) {
          currentBuf = decompressSingleLayer(currentBuf, algos[i]!);
        }
        decompressed = true;
      } catch (err) {
        decompressionError = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const text = decompressionError ? null : tryDecodeUtf8Text(currentBuf);
  const isSse = Boolean(contentType && contentType.toLowerCase().includes("text/event-stream"));
  const sseEvents = isSse && text !== null ? parseSseEvents(text) : undefined;

  return {
    text,
    isBinary: text === null,
    decompressed,
    contentEncoding,
    decompressionError,
    sseEvents,
  };
}
