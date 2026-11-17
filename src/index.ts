import { loadConfig } from "./config.ts";
import { startProxyServer } from "./proxy.ts";
import { JsonlLogStore } from "./storage.ts";
import { startUiServer } from "./ui-server.ts";

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new JsonlLogStore(config.dataDir);
  await store.init();

  const proxy = await startProxyServer(config, store);
  const ui = startUiServer(config, store, proxy.port);

  const capLabel =
    config.maxBodyBytes === 0 ? "unlimited" : `${config.maxBodyBytes} bytes`;
  console.log(`Proxy listening on   http://${proxy.host}:${proxy.port}`);
  console.log(`Web UI listening on  http://${ui.host}:${ui.port}`);
  console.log(`JSONL log file:      ${store.filePath}`);
  console.log(`Body capture limit:  ${capLabel}`);
  if (config.upstream) {
    console.log(`Reverse upstream:    ${config.upstream}`);
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    ui.close();
    await proxy.close();
    await store.flush();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
