export type HeaderPair = [name: string, value: string];

export type BodyEncoding = "utf8" | "base64";

export type ProxyMode = "forward" | "reverse";

export interface HttpLogEntry {
  id: string;
  type: "http";
  timestamp: string;
  mode: ProxyMode;
  method: string;
  url: string;
  host: string;
  path: string;
  clientIp?: string;
  statusCode?: number;
  statusText?: string;
  ttfbMs?: number;
  durationMs: number;
  reqHeaders: HeaderPair[];
  resHeaders?: HeaderPair[];
  reqBody?: string;
  reqBodyEncoding?: BodyEncoding;
  reqBodyBytes: number;
  reqBodyTruncated?: boolean;
  resBody?: string;
  resBodyEncoding?: BodyEncoding;
  resBodyBytes: number;
  resBodyTruncated?: boolean;
  aborted?: boolean;
  error?: string;
}

export interface TunnelLogEntry {
  id: string;
  type: "tunnel";
  timestamp: string;
  targetHost: string;
  targetPort: number;
  clientIp?: string;
  bytesUp: number;
  bytesDown: number;
  durationMs: number;
  status: "closed" | "error";
  error?: string;
}

export type LogEntry = HttpLogEntry | TunnelLogEntry;

export interface LogSummary {
  id: string;
  type: "http" | "tunnel";
  timestamp: string;
  durationMs: number;
  ttfbMs?: number;
  method: string;
  url: string;
  host: string;
  path: string;
  statusCode?: number;
  statusText?: string;
  tunnelStatus?: "closed" | "error";
  reqBytes: number;
  resBytes: number;
  contentType?: string;
  contentEncoding?: string;
  isSse?: boolean;
  aborted?: boolean;
  error?: string;
}

export interface SSEEventItem {
  index: number;
  id?: string;
  event?: string;
  retry?: number;
  data: string;
}

export interface DecodedBodyPreview {
  text: string | null;
  isBinary: boolean;
  decompressed: boolean;
  contentEncoding?: string;
  decompressionError?: string;
  sseEvents?: SSEEventItem[];
}

export interface LogDetailResponse {
  entry: LogEntry;
  reqBodyPreview?: DecodedBodyPreview;
  resBodyPreview?: DecodedBodyPreview;
}

export interface ConfigInfo {
  proxyHost: string;
  proxyPort: number;
  uiHost: string;
  uiPort: number;
  dataDir: string;
  maxBodyBytes: number;
  upstream?: string;
  totalLogs: number;
  httpLogs: number;
  tunnelLogs: number;
}
