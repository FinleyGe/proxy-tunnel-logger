import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { AppConfig } from "../src/config.ts";
import { startProxyServer, type ProxyServerHandle } from "../src/proxy.ts";
import { JsonlLogStore, type ListResult } from "../src/storage.ts";
import type { ConfigInfo, HttpLogEntry, LogDetailResponse, TunnelLogEntry } from "../src/types.ts";
import { startUiServer, type UiServerHandle } from "../src/ui-server.ts";

function sha256(buf: Buffer | Uint8Array): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

describe("proxy-tunnel-logger e2e", () => {
  let tmpDir: string;
  let upstreamServer: http.Server;
  let upstreamPort: number;
  let tcpEchoServer: net.Server;
  let tcpEchoPort: number;
  let store: JsonlLogStore;
  let proxy: ProxyServerHandle;
  let ui: UiServerHandle;
  let gzipPayload: Buffer;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "ptl-test-"));
    gzipPayload = gzipSync(Buffer.from(JSON.stringify({ compressed: true, msg: "hello gzip" })));

    upstreamServer = http.createServer(async (req, res) => {
      if (req.url === "/echo" && req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const rawBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Set-Cookie": ["sid=abc; HttpOnly", "theme=dark"],
          Connection: "keep-alive",
        });
        res.end(
          JSON.stringify({
            method: req.method,
            auth: req.headers.authorization || null,
            proxyConn: req.headers["proxy-connection"] || null,
            body: rawBody,
          })
        );
        return;
      }

      if (req.url === "/gzip") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Encoding": "gzip",
          "Content-Length": String(gzipPayload.length),
        });
        res.end(gzipPayload);
        return;
      }

      if (req.url === "/sse") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
        });
        res.write("event: chunk\nid: 1\ndata: {\"delta\":\"hello\"}\n\n");
        setTimeout(() => {
          res.write("event: chunk\nid: 2\ndata: {\"delta\":\"world\"}\n\n");
          res.end();
        }, 120);
        return;
      }

      if (req.url === "/large") {
        const big = "A".repeat(4096);
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(big);
        return;
      }

      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "http://example.org/next" });
        res.end();
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    });

    await new Promise<void>((r) => upstreamServer.listen(0, "127.0.0.1", r));
    upstreamPort = (upstreamServer.address() as net.AddressInfo).port;

    tcpEchoServer = net.createServer((sock) => {
      sock.on("data", (d) =>
        sock.write(Buffer.concat([Buffer.from("TUNNEL:"), typeof d === "string" ? Buffer.from(d) : d]))
      );
    });
    await new Promise<void>((r) => tcpEchoServer.listen(0, "127.0.0.1", r));
    tcpEchoPort = (tcpEchoServer.address() as net.AddressInfo).port;

    const config: AppConfig = {
      proxyHost: "127.0.0.1",
      proxyPort: 0,
      uiHost: "127.0.0.1",
      uiPort: 0,
      dataDir: tmpDir,
      maxBodyBytes: 1024,
    };

    store = new JsonlLogStore(tmpDir);
    await store.init();
    proxy = await startProxyServer(config, store);
    ui = startUiServer(config, store, proxy.port);
  });

  afterAll(async () => {
    ui.close();
    await proxy.close();
    await store.flush();
    upstreamServer.close();
    tcpEchoServer.close();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  test("forwards HTTP POST unredacted, strips hop-by-hop headers, and logs JSONL", async () => {
    const res = await fetch(`http://127.0.0.1:${upstreamPort}/echo`, {
      proxy: `http://127.0.0.1:${proxy.port}`,
      method: "POST",
      headers: {
        Authorization: "Bearer secret-token-123",
        "Proxy-Connection": "keep-alive",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prompt: "hi" }),
    } as RequestInit);

    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual(["sid=abc; HttpOnly", "theme=dark"]);
    const body = (await res.json()) as { auth: string; proxyConn: string | null; body: string };
    expect(body.auth).toBe("Bearer secret-token-123");
    expect(body.proxyConn).toBeNull();
    expect(body.body).toBe('{"prompt":"hi"}');

    await store.flush();
    const list = store.list({ q: "/echo" });
    expect(list.items.length).toBeGreaterThanOrEqual(1);
    const summary = list.items[0]!;
    expect(summary.type).toBe("http");

    const detailRes = await fetch(`http://127.0.0.1:${ui.port}/api/logs/${summary.id}`);
    expect(detailRes.status).toBe(200);
    const detail = (await detailRes.json()) as LogDetailResponse;
    const entry = detail.entry as HttpLogEntry;
    expect(entry.reqHeaders.some(([k, v]) => k.toLowerCase() === "authorization" && v === "Bearer secret-token-123")).toBe(true);
    expect(entry.reqBodyEncoding).toBe("utf8");
    expect(entry.resBodyEncoding).toBe("utf8");
    expect(entry.ttfbMs).toBeGreaterThanOrEqual(0);
  });

  test("preserves raw gzip bytes on wire and decompresses only for UI preview", async () => {
    const res = await fetch(`http://127.0.0.1:${upstreamPort}/gzip`, {
      proxy: `http://127.0.0.1:${proxy.port}`,
      decompress: false,
    } as RequestInit);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const wireBytes = Buffer.from(await res.arrayBuffer());
    expect(sha256(wireBytes)).toBe(sha256(gzipPayload));

    await store.flush();
    const summary = store.list({ q: "/gzip" }).items[0]!;
    const detail = (await fetch(`http://127.0.0.1:${ui.port}/api/logs/${summary.id}`).then((r) =>
      r.json()
    )) as LogDetailResponse;
    const entry = detail.entry as HttpLogEntry;
    expect(entry.resBodyEncoding).toBe("base64");
    expect(entry.resBodyBytes).toBe(gzipPayload.length);
    expect(detail.resBodyPreview?.decompressed).toBe(true);
    expect(detail.resBodyPreview?.text).toBe(JSON.stringify({ compressed: true, msg: "hello gzip" }));
  });

  test("streams SSE incrementally without whole-body buffering and parses events", async () => {
    const t0 = performance.now();
    const res = await fetch(`http://127.0.0.1:${upstreamPort}/sse`, {
      proxy: `http://127.0.0.1:${proxy.port}`,
    } as RequestInit);

    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const arrivals: Array<{ text: string; elapsed: number }> = [];
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      arrivals.push({
        text: decoder.decode(value),
        elapsed: performance.now() - t0,
      });
    }

    expect(arrivals.length).toBeGreaterThanOrEqual(2);
    expect(arrivals[1]!.elapsed - arrivals[0]!.elapsed).toBeGreaterThanOrEqual(60);

    await store.flush();
    const summary = store.list({ q: "/sse" }).items[0]!;
    expect(summary.isSse).toBe(true);

    const detail = (await fetch(`http://127.0.0.1:${ui.port}/api/logs/${summary.id}`).then((r) =>
      r.json()
    )) as LogDetailResponse;
    expect(detail.resBodyPreview?.sseEvents?.length).toBe(2);
    expect(detail.resBodyPreview?.sseEvents?.[0]?.data).toBe('{"delta":"hello"}');
    expect(detail.resBodyPreview?.sseEvents?.[1]?.data).toBe('{"delta":"world"}');
  });

  test("does not follow 302 redirects inside proxy", async () => {
    const res = await fetch(`http://127.0.0.1:${upstreamPort}/redirect`, {
      proxy: `http://127.0.0.1:${proxy.port}`,
      redirect: "manual",
    } as RequestInit);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://example.org/next");
  });

  test("passes full large body to client while capping JSONL capture at MAX_BODY_BYTES", async () => {
    const res = await fetch(`http://127.0.0.1:${upstreamPort}/large`, {
      proxy: `http://127.0.0.1:${proxy.port}`,
    } as RequestInit);
    const txt = await res.text();
    expect(txt.length).toBe(4096);

    await store.flush();
    const summary = store.list({ q: "/large" }).items[0]!;
    const detail = (await fetch(`http://127.0.0.1:${ui.port}/api/logs/${summary.id}`).then((r) =>
      r.json()
    )) as LogDetailResponse;
    const entry = detail.entry as HttpLogEntry;
    expect(entry.resBodyBytes).toBe(4096);
    expect(entry.resBodyTruncated).toBe(true);
    expect(entry.resBody?.length).toBe(1024);
  });

  test("forwards CONNECT tunnel bidirectionally and logs byte counts without MITM", async () => {
    const tunnelOutput = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(proxy.port, "127.0.0.1", () => {
        sock.write(`CONNECT 127.0.0.1:${tcpEchoPort} HTTP/1.1\r\nHost: 127.0.0.1:${tcpEchoPort}\r\n\r\n`);
      });
      let acc = "";
      let sent = false;
      sock.on("data", (chunk) => {
        acc += chunk.toString();
        if (!sent && acc.includes("200 Connection Established\r\n\r\n")) {
          sent = true;
          sock.write("SECRET_TLS_BYTES");
        }
        if (acc.includes("TUNNEL:SECRET_TLS_BYTES")) {
          sock.end();
          resolve(acc);
        }
      });
      sock.on("error", reject);
      setTimeout(() => reject(new Error(`Tunnel timeout: ${acc}`)), 2000);
    });

    expect(tunnelOutput).toContain("TUNNEL:SECRET_TLS_BYTES");
    // Give socket close handler a brief moment to append tunnel log
    await new Promise((r) => setTimeout(r, 40));
    await store.flush();

    const tunnels = store.list({ type: "tunnel" });
    expect(tunnels.items.length).toBeGreaterThanOrEqual(1);
    const summary = tunnels.items[0]!;
    const detail = (await fetch(`http://127.0.0.1:${ui.port}/api/logs/${summary.id}`).then((r) =>
      r.json()
    )) as LogDetailResponse;
    const entry = detail.entry as TunnelLogEntry;
    expect(entry.type).toBe("tunnel");
    expect(entry.targetHost).toBe("127.0.0.1");
    expect(entry.targetPort).toBe(tcpEchoPort);
    expect(entry.bytesUp).toBe(16);
    expect(entry.bytesDown).toBe(23);
    expect(entry.status).toBe("closed");
  });

  test("serves UI HTML, config, pagination, export, and reloads JSONL index", async () => {
    const html = await fetch(`http://127.0.0.1:${ui.port}/`).then((r) => r.text());
    expect(html).toContain("Proxy Tunnel Logger");

    const cfg = (await fetch(`http://127.0.0.1:${ui.port}/api/config`).then((r) =>
      r.json()
    )) as ConfigInfo;
    expect(cfg.proxyPort).toBe(proxy.port);
    expect(cfg.totalLogs).toBeGreaterThanOrEqual(6);

    const page1 = (await fetch(`http://127.0.0.1:${ui.port}/api/logs?page=1&limit=2`).then((r) =>
      r.json()
    )) as ListResult;
    expect(page1.items.length).toBe(2);

    const exported = await fetch(`http://127.0.0.1:${ui.port}/api/export`).then((r) => r.text());
    expect(exported.trim().split("\n").length).toBe(cfg.totalLogs);

    const reloaded = new JsonlLogStore(tmpDir);
    await reloaded.init();
    expect(reloaded.getStats().total).toBe(cfg.totalLogs);
    const firstId = page1.items[0]!.id;
    const fetched = await reloaded.getById(firstId);
    expect(fetched?.id).toBe(firstId);
  });
});
