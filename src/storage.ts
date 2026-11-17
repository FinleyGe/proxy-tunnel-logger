import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { getHeaderValue } from "./headers.ts";
import type { LogEntry, LogSummary } from "./types.ts";

interface IndexedRecord {
  summary: LogSummary;
  offset: number;
  length: number;
}

export interface ListQuery {
  page?: number;
  limit?: number;
  type?: "all" | "http" | "tunnel";
  status?: string;
  q?: string;
}

export interface ListResult {
  items: LogSummary[];
  total: number;
  page: number;
  limit: number;
  stats: {
    total: number;
    http: number;
    tunnel: number;
  };
}

/**
 * Derive a lightweight UI list summary from a full HTTP or tunnel log entry.
 */
export function toLogSummary(entry: LogEntry): LogSummary {
  if (entry.type === "tunnel") {
    return {
      id: entry.id,
      type: "tunnel",
      timestamp: entry.timestamp,
      durationMs: entry.durationMs,
      method: "CONNECT",
      url: `${entry.targetHost}:${entry.targetPort}`,
      host: `${entry.targetHost}:${entry.targetPort}`,
      path: "",
      tunnelStatus: entry.status,
      reqBytes: entry.bytesUp,
      resBytes: entry.bytesDown,
      error: entry.error,
    };
  }

  const contentType = getHeaderValue(entry.resHeaders, "content-type");
  const contentEncoding = getHeaderValue(entry.resHeaders, "content-encoding");
  return {
    id: entry.id,
    type: "http",
    timestamp: entry.timestamp,
    durationMs: entry.durationMs,
    ttfbMs: entry.ttfbMs,
    method: entry.method,
    url: entry.url,
    host: entry.host,
    path: entry.path,
    statusCode: entry.statusCode,
    statusText: entry.statusText,
    reqBytes: entry.reqBodyBytes,
    resBytes: entry.resBodyBytes,
    contentType,
    contentEncoding,
    isSse: Boolean(contentType && contentType.toLowerCase().includes("text/event-stream")),
    aborted: entry.aborted,
    error: entry.error,
  };
}

function matchesStatusFilter(summary: LogSummary, status: string): boolean {
  if (!status || status === "all") return true;
  if (status === "error") {
    return Boolean(
      summary.error ||
        summary.aborted ||
        summary.tunnelStatus === "error" ||
        (summary.statusCode !== undefined && summary.statusCode >= 500)
    );
  }
  if (status === "tunnel") return summary.type === "tunnel";
  if (summary.type !== "http" || summary.statusCode === undefined) return false;
  if (status === "2xx") return summary.statusCode >= 200 && summary.statusCode < 300;
  if (status === "3xx") return summary.statusCode >= 300 && summary.statusCode < 400;
  if (status === "4xx") return summary.statusCode >= 400 && summary.statusCode < 500;
  if (status === "5xx") return summary.statusCode >= 500 && summary.statusCode < 600;
  return String(summary.statusCode) === status;
}

/**
 * Append-only JSONL log store with serialized writes and byte-offset indexing.
 */
export class JsonlLogStore {
  public readonly filePath: string;
  private readonly records: IndexedRecord[] = [];
  private readonly byId = new Map<string, IndexedRecord>();
  private readonly listeners = new Set<(summary: LogSummary) => void>();
  private writeQueue: Promise<void> = Promise.resolve();
  private fileSize = 0;
  private httpCount = 0;
  private tunnelCount = 0;

  constructor(private readonly dataDir: string, filename = "logs.jsonl") {
    this.filePath = path.join(dataDir, filename);
  }

  /**
   * Ensure storage directory/file exist and index any pre-existing JSONL entries.
   */
  async init(): Promise<void> {
    await fsp.mkdir(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      await fsp.writeFile(this.filePath, "", "utf8");
      this.fileSize = 0;
      return;
    }

    const stat = await fsp.stat(this.filePath);
    this.fileSize = stat.size;
    if (stat.size === 0) return;

    const fh = await fsp.open(this.filePath, "r");
    try {
      const chunkSize = 1024 * 1024;
      const buf = Buffer.allocUnsafe(chunkSize);
      let fileOffset = 0;
      let leftover = Buffer.alloc(0);
      let lineStartOffset = 0;

      while (true) {
        const { bytesRead } = await fh.read(buf, 0, chunkSize, fileOffset);
        if (bytesRead === 0) break;
        const slice = buf.subarray(0, bytesRead);
        const combined = leftover.length > 0 ? Buffer.concat([leftover, slice]) : slice;

        let pos = 0;
        while (true) {
          const nlIdx = combined.indexOf(0x0a, pos);
          if (nlIdx === -1) break;
          const lineBuf = combined.subarray(pos, nlIdx);
          const lineLen = lineBuf.length;
          this.indexLine(lineBuf, lineStartOffset, lineLen);
          lineStartOffset += lineLen + 1;
          pos = nlIdx + 1;
        }

        leftover = pos < combined.length ? Buffer.from(combined.subarray(pos)) : Buffer.alloc(0);
        fileOffset += bytesRead;
      }

      if (leftover.length > 0) {
        this.indexLine(leftover, lineStartOffset, leftover.length);
      }
    } finally {
      await fh.close();
    }
  }

  private indexLine(lineBuf: Buffer, offset: number, length: number): void {
    const raw = lineBuf.toString("utf8").trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as LogEntry;
      if (!parsed || typeof parsed.id !== "string") return;
      const summary = toLogSummary(parsed);
      const record: IndexedRecord = { summary, offset, length };
      this.records.push(record);
      this.byId.set(parsed.id, record);
      if (parsed.type === "http") this.httpCount++;
      else if (parsed.type === "tunnel") this.tunnelCount++;
    } catch {
      // Ignore corrupt or partially flushed trailing line from an abrupt process crash.
    }
  }

  /**
   * Queue an entry for serialized append to logs.jsonl and notify live subscribers.
   */
  append(entry: LogEntry): Promise<void> {
    const task = this.writeQueue.then(async () => {
      const jsonLine = JSON.stringify(entry);
      const lineBuf = Buffer.from(jsonLine + "\n", "utf8");
      const offset = this.fileSize;
      const length = lineBuf.length - 1;

      await fsp.appendFile(this.filePath, lineBuf);
      this.fileSize += lineBuf.length;

      const summary = toLogSummary(entry);
      const record: IndexedRecord = { summary, offset, length };
      this.records.push(record);
      this.byId.set(entry.id, record);
      if (entry.type === "http") this.httpCount++;
      else this.tunnelCount++;

      for (const listener of this.listeners) {
        try {
          listener(summary);
        } catch {
          // Isolate subscriber errors from storage writes.
        }
      }
    });

    // Keep the queue alive even if a single write fails.
    this.writeQueue = task.catch(() => {});
    return task;
  }

  /**
   * Flush all pending queued writes (useful during graceful shutdown or tests).
   */
  async flush(): Promise<void> {
    await this.writeQueue;
  }

  list(query: ListQuery = {}): ListResult {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 50));
    const typeFilter = query.type ?? "all";
    const statusFilter = query.status ?? "all";
    const needle = query.q?.trim().toLowerCase() ?? "";

    const matched: LogSummary[] = [];
    for (let i = this.records.length - 1; i >= 0; i--) {
      const summary = this.records[i]!.summary;
      if (typeFilter !== "all" && summary.type !== typeFilter) continue;
      if (!matchesStatusFilter(summary, statusFilter)) continue;
      if (needle) {
        const hay = `${summary.method} ${summary.url} ${summary.host} ${summary.path} ${summary.error ?? ""}`.toLowerCase();
        if (!hay.includes(needle)) continue;
      }
      matched.push(summary);
    }

    const start = (page - 1) * limit;
    const items = matched.slice(start, start + limit);
    return {
      items,
      total: matched.length,
      page,
      limit,
      stats: {
        total: this.records.length,
        http: this.httpCount,
        tunnel: this.tunnelCount,
      },
    };
  }

  async getById(id: string): Promise<LogEntry | null> {
    const record = this.byId.get(id);
    if (!record) return null;

    const fh = await fsp.open(this.filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(record.length);
      const { bytesRead } = await fh.read(buf, 0, record.length, record.offset);
      return JSON.parse(buf.subarray(0, bytesRead).toString("utf8")) as LogEntry;
    } finally {
      await fh.close();
    }
  }

  getStats(): { total: number; http: number; tunnel: number } {
    return {
      total: this.records.length,
      http: this.httpCount,
      tunnel: this.tunnelCount,
    };
  }

  subscribe(listener: (summary: LogSummary) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
