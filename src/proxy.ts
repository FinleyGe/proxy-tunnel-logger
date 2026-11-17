import crypto from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import { BoundedCapture } from "./body.ts";
import type { AppConfig } from "./config.ts";
import {
  fetchHeadersToPairs,
  pairsToFetchHeaders,
  pairsToNodeHeaders,
  rawHeadersToPairs,
  stripHopByHopHeaders,
} from "./headers.ts";
import type { JsonlLogStore } from "./storage.ts";
import type { HttpLogEntry, ProxyMode, TunnelLogEntry } from "./types.ts";

interface ResolvedTarget {
  url: URL;
  mode: ProxyMode;
}

function isSelfAddress(hostHeader: string, proxyPort: number): boolean {
  const lower = hostHeader.toLowerCase();
  const known = new Set([
    `127.0.0.1:${proxyPort}`,
    `localhost:${proxyPort}`,
    `[::1]:${proxyPort}`,
    `0.0.0.0:${proxyPort}`,
  ]);
  return known.has(lower);
}

function resolveTarget(req: http.IncomingMessage, config: AppConfig, actualPort: number): ResolvedTarget {
  const rawUrl = req.url || "/";
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    return { url: new URL(rawUrl), mode: "forward" };
  }

  if (config.upstream) {
    const joined = rawUrl.startsWith("/") ? `${config.upstream}${rawUrl}` : `${config.upstream}/${rawUrl}`;
    return { url: new URL(joined), mode: "reverse" };
  }

  const hostHeader = req.headers.host;
  if (!hostHeader) {
    throw new Error("Missing target URL and Host header");
  }
  if (isSelfAddress(hostHeader, actualPort)) {
    throw new Error("Direct request to forward proxy port without target URL or UPSTREAM configured");
  }

  return {
    url: new URL(rawUrl, `http://${hostHeader}`),
    mode: "forward",
  };
}

function hasRequestBody(req: http.IncomingMessage): boolean {
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD") return false;
  if (req.headers["transfer-encoding"] !== undefined) return true;
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined) {
    const parsed = Number(contentLength);
    return Number.isFinite(parsed) && parsed > 0;
  }
  return false;
}

function parseConnectTarget(rawTarget: string): { host: string; port: number } {
  const trimmed = rawTarget.trim();
  if (!trimmed) throw new Error("Empty CONNECT target");

  if (trimmed.startsWith("[")) {
    const endBracket = trimmed.indexOf("]");
    if (endBracket === -1) throw new Error(`Invalid IPv6 CONNECT target: ${trimmed}`);
    const host = trimmed.slice(1, endBracket);
    const rest = trimmed.slice(endBracket + 1);
    const port = rest.startsWith(":") ? Number(rest.slice(1)) : 443;
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`Invalid CONNECT port in target: ${trimmed}`);
    }
    return { host, port };
  }

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon === -1) {
    return { host: trimmed, port: 443 };
  }
  const host = trimmed.slice(0, lastColon);
  const port = Number(trimmed.slice(lastColon + 1));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid CONNECT target: ${trimmed}`);
  }
  return { host, port };
}

function createRequestBodyStream(
  req: http.IncomingMessage,
  capture: BoundedCapture
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const onData = (chunk: Buffer | Uint8Array) => {
        if (closed) return;
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        capture.push(bytes);
        controller.enqueue(bytes);
      };
      const onEnd = () => {
        if (closed) return;
        closed = true;
        cleanup();
        controller.close();
      };
      const onError = (err: Error) => {
        if (closed) return;
        closed = true;
        cleanup();
        controller.error(err);
      };
      const cleanup = () => {
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onError);
      };

      req.on("data", onData);
      req.on("end", onEnd);
      req.on("error", onError);
    },
    cancel() {
      req.destroy();
    },
  });
}

function createResponseCaptureTransform(capture: BoundedCapture): TransformStream<Uint8Array, Uint8Array> {
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      capture.push(chunk);
      controller.enqueue(chunk);
    },
  });
}

export interface ProxyServerHandle {
  server: http.Server;
  port: number;
  host: string;
  close: () => Promise<void>;
}

/**
 * Start the HTTP forward/reverse proxy server with passthrough CONNECT tunneling.
 */
export async function startProxyServer(
  config: AppConfig,
  store: JsonlLogStore
): Promise<ProxyServerHandle> {
  let boundPort = config.proxyPort;

  const server = http.createServer(async (req, res) => {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const startPerf = performance.now();
    const method = (req.method || "GET").toUpperCase();
    const clientIp = req.socket.remoteAddress;
    const rawReqHeaders = rawHeadersToPairs(req.rawHeaders);
    const reqCapture = new BoundedCapture(config.maxBodyBytes);
    const resCapture = new BoundedCapture(config.maxBodyBytes);

    let mode: ProxyMode = config.upstream ? "reverse" : "forward";
    let targetUrlStr = req.url || "/";
    let host = req.headers.host || "";
    let reqPath = req.url || "/";
    let statusCode: number | undefined;
    let statusText: string | undefined;
    let ttfbMs: number | undefined;
    let resHeadersPairs: ReturnType<typeof fetchHeadersToPairs> | undefined;
    let aborted = false;
    let errorMsg: string | undefined;

    const abortController = new AbortController();
    let streamFinished = false;

    const onClientClose = () => {
      if (!streamFinished && !res.writableEnded) {
        aborted = true;
        abortController.abort(new Error("Client disconnected"));
      }
    };
    res.on("close", onClientClose);

    try {
      const resolved = resolveTarget(req, config, boundPort);
      mode = resolved.mode;
      targetUrlStr = resolved.url.toString();
      host = resolved.url.host;
      reqPath = `${resolved.url.pathname}${resolved.url.search}`;

      const outboundHeadersPairs = stripHopByHopHeaders(rawReqHeaders, {
        dropHost: mode === "reverse",
      });
      const outboundHeaders = pairsToFetchHeaders(outboundHeadersPairs);

      const sendBody = hasRequestBody(req);
      const bodyStream = sendBody ? createRequestBodyStream(req, reqCapture) : undefined;

      const fetchInit: RequestInit & { decompress?: boolean; duplex?: "half" } = {
        method,
        headers: outboundHeaders,
        body: bodyStream,
        redirect: "manual",
        decompress: false,
        signal: abortController.signal,
      };
      if (bodyStream) {
        fetchInit.duplex = "half";
      }

      const upstreamResp = await fetch(targetUrlStr, fetchInit);
      ttfbMs = Math.round(performance.now() - startPerf);
      statusCode = upstreamResp.status;
      statusText = upstreamResp.statusText;

      const rawResPairs = fetchHeadersToPairs(upstreamResp.headers);
      resHeadersPairs = stripHopByHopHeaders(rawResPairs);
      const nodeResHeaders = pairsToNodeHeaders(resHeadersPairs);

      res.writeHead(upstreamResp.status, upstreamResp.statusText, nodeResHeaders);
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      if (upstreamResp.body) {
        const teeTransform = createResponseCaptureTransform(resCapture);
        const passthrough = upstreamResp.body.pipeThrough(teeTransform);
        const reader = passthrough.getReader();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (aborted || res.destroyed) {
              await reader.cancel().catch(() => {});
              break;
            }
            if (!res.write(value)) {
              await once(res, "drain");
            }
          }
        } catch (streamErr) {
          if (!aborted) {
            throw streamErr;
          }
        } finally {
          reader.releaseLock();
        }
      }

      streamFinished = true;
      if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    } catch (err) {
      if (!aborted) {
        errorMsg = err instanceof Error ? err.message : String(err);
      }
      if (!res.headersSent && !res.destroyed) {
        statusCode = 502;
        statusText = "Bad Gateway";
        const body = `Proxy error: ${errorMsg ?? "Request aborted"}\n`;
        res.writeHead(502, {
          "content-type": "text/plain; charset=utf-8",
          "content-length": String(Buffer.byteLength(body)),
        });
        res.end(body);
      } else if (!res.destroyed && !res.writableEnded) {
        res.destroy();
      }
    } finally {
      res.off("close", onClientClose);
      const durationMs = Math.round(performance.now() - startPerf);
      const reqCaptured = reqCapture.finalize();
      const resCaptured = resCapture.finalize();

      const entry: HttpLogEntry = {
        id,
        type: "http",
        timestamp,
        mode,
        method,
        url: targetUrlStr,
        host,
        path: reqPath,
        clientIp,
        statusCode,
        statusText,
        ttfbMs,
        durationMs,
        reqHeaders: rawReqHeaders,
        resHeaders: resHeadersPairs,
        reqBody: reqCaptured.bytes > 0 ? reqCaptured.body : undefined,
        reqBodyEncoding: reqCaptured.bytes > 0 ? reqCaptured.encoding : undefined,
        reqBodyBytes: reqCaptured.bytes,
        reqBodyTruncated: reqCaptured.truncated || undefined,
        resBody: resCaptured.bytes > 0 ? resCaptured.body : undefined,
        resBodyEncoding: resCaptured.bytes > 0 ? resCaptured.encoding : undefined,
        resBodyBytes: resCaptured.bytes,
        resBodyTruncated: resCaptured.truncated || undefined,
        aborted: aborted || undefined,
        error: errorMsg,
      };

      void store.append(entry);
    }
  });

  // Disable default request timeout so long-lived SSE / chunked streams are not interrupted.
  server.requestTimeout = 0;

  server.on("connect", (req, clientSocket, head) => {
    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    const startPerf = performance.now();
    const clientIp =
      clientSocket instanceof net.Socket
        ? clientSocket.remoteAddress
        : req.socket.remoteAddress;

    let targetHost = req.url || "";
    let targetPort = 443;
    let bytesUp = 0;
    let bytesDown = 0;
    let finalized = false;
    let tunnelError: string | undefined;

    const writeLog = (status: "closed" | "error") => {
      if (finalized) return;
      finalized = true;
      const entry: TunnelLogEntry = {
        id,
        type: "tunnel",
        timestamp,
        targetHost,
        targetPort,
        clientIp,
        bytesUp,
        bytesDown,
        durationMs: Math.round(performance.now() - startPerf),
        status,
        error: tunnelError,
      };
      void store.append(entry);
    };

    try {
      const parsed = parseConnectTarget(req.url || "");
      targetHost = parsed.host;
      targetPort = parsed.port;
    } catch (err) {
      tunnelError = err instanceof Error ? err.message : String(err);
      clientSocket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      writeLog("error");
      return;
    }

    let connected = false;
    let clientClosed = false;
    let upstreamClosed = false;

    const upstream = net.connect({ host: targetHost, port: targetPort });

    const maybeFinalize = () => {
      if (clientClosed && upstreamClosed) {
        writeLog(tunnelError ? "error" : "closed");
      }
    };

    upstream.once("connect", () => {
      connected = true;
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

      if (head && head.length > 0) {
        bytesUp += head.length;
        upstream.write(head);
      }

      clientSocket.on("data", (chunk: Buffer) => {
        bytesUp += chunk.length;
      });
      upstream.on("data", (chunk: Buffer) => {
        bytesDown += chunk.length;
      });

      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });

    upstream.on("error", (err) => {
      tunnelError = err.message;
      if (!connected) {
        clientSocket.end(`HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n${err.message}\n`);
        clientSocket.destroy();
        upstreamClosed = true;
        clientClosed = true;
        writeLog("error");
        return;
      }
      clientSocket.destroy();
    });

    clientSocket.on("error", (err) => {
      if (!tunnelError) tunnelError = err.message;
      upstream.destroy();
    });

    upstream.on("close", () => {
      upstreamClosed = true;
      if (!clientSocket.destroyed) {
        clientSocket.end();
      }
      maybeFinalize();
    });

    clientSocket.on("close", () => {
      clientClosed = true;
      if (!upstream.destroyed) {
        upstream.destroy();
      }
      maybeFinalize();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      const addr = server.address();
      if (addr && typeof addr === "object") {
        boundPort = addr.port;
      }
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.proxyPort, config.proxyHost);
  });

  return {
    server,
    port: boundPort,
    host: config.proxyHost,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
