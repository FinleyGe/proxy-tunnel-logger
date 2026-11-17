import { decodeBodyForDisplay } from "./body.ts";
import type { AppConfig } from "./config.ts";
import { getHeaderValue } from "./headers.ts";
import type { JsonlLogStore } from "./storage.ts";
import type { ConfigInfo, LogDetailResponse } from "./types.ts";
import index from "../ui/index.html";

export interface UiServerHandle {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  host: string;
  close: () => void;
}

/**
 * Start the Bun full-stack web UI and JSONL query/SSE API on a separate port.
 */
export function startUiServer(
  config: AppConfig,
  store: JsonlLogStore,
  actualProxyPort: number
): UiServerHandle {
  const encoder = new TextEncoder();

  const server = Bun.serve({
    hostname: config.uiHost,
    port: config.uiPort,
    idleTimeout: 0,
    routes: {
      "/": index,

      "/api/health": {
        GET: () => Response.json({ ok: true }),
      },

      "/api/config": {
        GET: () => {
          const stats = store.getStats();
          const info: ConfigInfo = {
            proxyHost: config.proxyHost,
            proxyPort: actualProxyPort,
            uiHost: config.uiHost,
            uiPort: server.port ?? config.uiPort,
            dataDir: config.dataDir,
            maxBodyBytes: config.maxBodyBytes,
            upstream: config.upstream,
            totalLogs: stats.total,
            httpLogs: stats.http,
            tunnelLogs: stats.tunnel,
          };
          return Response.json(info);
        },
      },

      "/api/logs": {
        GET: (req) => {
          const url = new URL(req.url);
          const page = Number(url.searchParams.get("page") || "1");
          const limit = Number(url.searchParams.get("limit") || "50");
          const rawType = url.searchParams.get("type") || "all";
          const type = rawType === "http" || rawType === "tunnel" ? rawType : "all";
          const status = url.searchParams.get("status") || "all";
          const q = url.searchParams.get("q") || "";

          const result = store.list({ page, limit, type, status, q });
          return Response.json(result);
        },
      },

      "/api/logs/:id": {
        GET: async (req) => {
          const id = req.params.id;
          const entry = await store.getById(id);
          if (!entry) {
            return Response.json({ error: "Log entry not found" }, { status: 404 });
          }

          if (entry.type === "tunnel") {
            const detail: LogDetailResponse = { entry };
            return Response.json(detail);
          }

          const reqContentEncoding = getHeaderValue(entry.reqHeaders, "content-encoding");
          const reqContentType = getHeaderValue(entry.reqHeaders, "content-type");
          const resContentEncoding = getHeaderValue(entry.resHeaders, "content-encoding");
          const resContentType = getHeaderValue(entry.resHeaders, "content-type");

          const detail: LogDetailResponse = {
            entry,
            reqBodyPreview: decodeBodyForDisplay(
              entry.reqBody,
              entry.reqBodyEncoding,
              reqContentEncoding,
              reqContentType
            ),
            resBodyPreview: decodeBodyForDisplay(
              entry.resBody,
              entry.resBodyEncoding,
              resContentEncoding,
              resContentType
            ),
          };
          return Response.json(detail);
        },
      },

      "/api/events": {
        GET: (req) => {
          let cleanup: (() => void) | undefined;
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              const send = (chunk: string) => {
                try {
                  controller.enqueue(encoder.encode(chunk));
                } catch {
                  cleanup?.();
                }
              };

              send(": connected\n\n");
              const unsubscribe = store.subscribe((summary) => {
                send(`event: log\ndata: ${JSON.stringify(summary)}\n\n`);
              });
              const heartbeat = setInterval(() => {
                send(": ping\n\n");
              }, 20000);

              cleanup = () => {
                clearInterval(heartbeat);
                unsubscribe();
                try {
                  controller.close();
                } catch {
                  // Stream already closed.
                }
              };

              req.signal.addEventListener("abort", () => cleanup?.());
            },
            cancel() {
              cleanup?.();
            },
          });

          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream; charset=utf-8",
              "Cache-Control": "no-cache, no-transform",
              Connection: "keep-alive",
            },
          });
        },
      },

      "/api/export": {
        GET: () => {
          const file = Bun.file(store.filePath);
          return new Response(file, {
            headers: {
              "Content-Type": "application/x-ndjson; charset=utf-8",
              "Content-Disposition": 'attachment; filename="logs.jsonl"',
            },
          });
        },
      },
    },
    fetch() {
      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    server,
    port: server.port ?? config.uiPort,
    host: config.uiHost,
    close: () => server.stop(true),
  };
}
