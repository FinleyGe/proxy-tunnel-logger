import type {
  ConfigInfo,
  DecodedBodyPreview,
  HeaderPair,
  HttpLogEntry,
  LogDetailResponse,
  LogSummary,
  SSEEventItem,
  TunnelLogEntry,
} from "../src/types.ts";
import type { ListResult } from "../src/storage.ts";

interface AppState {
  page: number;
  limit: number;
  type: "all" | "http" | "tunnel";
  status: string;
  q: string;
  items: LogSummary[];
  total: number;
  stats: { total: number; http: number; tunnel: number };
  selectedId: string | null;
  detail: LogDetailResponse | null;
  activeTab: "response" | "request" | "sse" | "raw";
  bodyMode: "pretty" | "raw";
  config: ConfigInfo | null;
}

const state: AppState = {
  page: 1,
  limit: 50,
  type: "all",
  status: "all",
  q: "",
  items: [],
  total: 0,
  stats: { total: 0, http: 0, tunnel: 0 },
  selectedId: null,
  detail: null,
  activeTab: "response",
  bodyMode: "pretty",
  config: null,
};

const el = {
  proxyAddr: document.getElementById("proxy-addr")!,
  copyProxyBtn: document.getElementById("copy-proxy-btn") as HTMLButtonElement,
  quickstartCmd: document.getElementById("quickstart-cmd")!,
  statTotal: document.getElementById("stat-total")!,
  statHttp: document.getElementById("stat-http")!,
  statTunnel: document.getElementById("stat-tunnel")!,
  liveIndicator: document.getElementById("live-indicator")!,
  liveText: document.getElementById("live-text")!,
  searchInput: document.getElementById("search-input") as HTMLInputElement,
  statusFilter: document.getElementById("status-filter") as HTMLSelectElement,
  refreshBtn: document.getElementById("refresh-btn") as HTMLButtonElement,
  listBody: document.getElementById("list-body")!,
  prevPage: document.getElementById("prev-page") as HTMLButtonElement,
  nextPage: document.getElementById("next-page") as HTMLButtonElement,
  pageInfo: document.getElementById("page-info")!,
  detailRoot: document.getElementById("detail-root")!,
  themeToggle: document.getElementById("theme-toggle") as HTMLButtonElement,
};

function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString([], { hour12: false }) + `.${String(d.getMilliseconds()).padStart(3, "0")}`;
}

function getMethodClass(method: string): string {
  const upper = method.toUpperCase();
  if (["GET", "POST", "PUT", "PATCH", "DELETE", "CONNECT"].includes(upper)) {
    return `method-${upper}`;
  }
  return "method-OTHER";
}

function getStatusBadge(item: LogSummary): { label: string; cls: string } {
  if (item.type === "tunnel") {
    return item.tunnelStatus === "error"
      ? { label: "TUNNEL ERR", cls: "status-err" }
      : { label: "TUNNEL", cls: "status-tunnel" };
  }
  if (item.error && !item.statusCode) {
    return { label: "ERR", cls: "status-err" };
  }
  if (item.aborted) {
    return { label: `${item.statusCode ?? "ABORT"}`, cls: "status-warn" };
  }
  const code = item.statusCode ?? 0;
  if (code >= 200 && code < 300) return { label: String(code), cls: "status-ok" };
  if (code >= 300 && code < 400) return { label: String(code), cls: "status-redir" };
  if (code >= 400 && code < 500) return { label: String(code), cls: "status-warn" };
  return { label: String(code || "ERR"), cls: "status-err" };
}

function tryPrettyJson(text: string): string {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}

function renderStats(): void {
  el.statTotal.textContent = String(state.stats.total);
  el.statHttp.textContent = String(state.stats.http);
  el.statTunnel.textContent = String(state.stats.tunnel);
}

function renderList(): void {
  renderStats();

  const totalPages = Math.max(1, Math.ceil(state.total / state.limit));
  el.pageInfo.textContent = `Page ${state.page} / ${totalPages} (${state.total} matching)`;
  el.prevPage.disabled = state.page <= 1;
  el.nextPage.disabled = state.page >= totalPages;

  if (state.items.length === 0) {
    el.listBody.innerHTML = `<div class="empty-list">No matching logs yet.</div>`;
    return;
  }

  el.listBody.innerHTML = state.items
    .map((item) => {
      const selected = item.id === state.selectedId ? " selected" : "";
      const status = getStatusBadge(item);
      const methodCls = getMethodClass(item.method);
      const sseTag = item.isSse ? `<span class="tag-badge tag-sse">SSE</span>` : "";
      const primary = item.host || item.url;
      const secondary = item.type === "tunnel" ? "HTTPS / TCP passthrough" : item.path || "/";
      const ttfb = item.ttfbMs !== undefined ? `TTFB ${item.ttfbMs}ms · ` : "";

      return `
        <div class="log-row${selected}" data-id="${escapeHtml(item.id)}">
          <div class="row-badges">
            <span class="method-badge ${methodCls}">${escapeHtml(item.method)}</span>
            <span class="status-badge ${status.cls}">${escapeHtml(status.label)}</span>
            ${sseTag}
          </div>
          <div class="row-main">
            <div class="row-host" title="${escapeHtml(item.url)}">${escapeHtml(primary)}</div>
            <div class="row-path" title="${escapeHtml(item.url)}">${escapeHtml(secondary)}</div>
          </div>
          <div class="row-meta">
            <div><strong>${item.durationMs} ms</strong></div>
            <div>${ttfb}↑${formatBytes(item.reqBytes)} ↓${formatBytes(item.resBytes)}</div>
            <div>${escapeHtml(formatTime(item.timestamp))}</div>
          </div>
        </div>
      `;
    })
    .join("");
}

function renderHeadersTable(headers: HeaderPair[] | undefined): string {
  if (!headers || headers.length === 0) {
    return `<div class="empty-list">No headers recorded.</div>`;
  }
  const rows = headers
    .map(
      ([name, value]) =>
        `<tr><th>${escapeHtml(name)}</th><td>${escapeHtml(value)}</td></tr>`
    )
    .join("");
  return `<table class="headers-table"><tbody>${rows}</tbody></table>`;
}

function renderBodySection(
  rawBody: string | undefined,
  rawEncoding: "utf8" | "base64" | undefined,
  rawBytes: number,
  truncated: boolean | undefined,
  preview: DecodedBodyPreview | undefined
): string {
  if (rawBytes === 0 || rawBody === undefined) {
    return `<div class="empty-list">Empty body (0 B)</div>`;
  }

  const badges: string[] = [
    `<span class="stat-pill">Size <strong>${formatBytes(rawBytes)}</strong></span>`,
    `<span class="stat-pill">Stored <strong>${rawEncoding ?? "utf8"}</strong></span>`,
  ];
  if (preview?.contentEncoding) {
    const label = preview.decompressed
      ? `${preview.contentEncoding} (decompressed)`
      : preview.contentEncoding;
    badges.push(`<span class="stat-pill">Encoding <strong>${escapeHtml(label)}</strong></span>`);
  }
  if (truncated) {
    badges.push(`<span class="status-badge status-warn">Truncated at capture limit</span>`);
  }

  let bodyHtml = "";
  if (preview?.decompressionError) {
    bodyHtml = `
      <div class="error-banner">Could not decompress (${escapeHtml(preview.decompressionError)}). Showing raw stored payload.</div>
      <pre class="code-block">${escapeHtml(rawBody.slice(0, 16000))}</pre>
    `;
  } else if (preview?.isBinary || preview?.text === null || preview?.text === undefined) {
    bodyHtml = `
      <div class="info-banner">Binary payload (${formatBytes(rawBytes)}). Base64 preview below:</div>
      <pre class="code-block">${escapeHtml(rawBody.slice(0, 16000))}</pre>
    `;
  } else {
    const content = state.bodyMode === "pretty" ? tryPrettyJson(preview.text) : preview.text;
    bodyHtml = `<pre class="code-block">${escapeHtml(content)}</pre>`;
  }

  return `
    <div class="section-header">
      <div class="stats-group">${badges.join("")}</div>
      <div class="segmented">
        <button class="seg-btn${state.bodyMode === "pretty" ? " active" : ""}" data-bodymode="pretty" type="button">Pretty</button>
        <button class="seg-btn${state.bodyMode === "raw" ? " active" : ""}" data-bodymode="raw" type="button">Raw</button>
      </div>
    </div>
    ${bodyHtml}
  `;
}

function renderSseEvents(events: SSEEventItem[] | undefined): string {
  if (!events || events.length === 0) {
    return `<div class="empty-list">No parsed SSE events.</div>`;
  }
  return `
    <div class="sse-list">
      ${events
        .map((ev) => {
          const formatted = state.bodyMode === "pretty" ? tryPrettyJson(ev.data) : ev.data;
          return `
            <div class="sse-event">
              <div class="sse-event-head">
                <strong>#${ev.index}</strong>
                ${ev.event ? `<span>event: ${escapeHtml(ev.event)}</span>` : ""}
                ${ev.id ? `<span>id: ${escapeHtml(ev.id)}</span>` : ""}
              </div>
              <pre class="code-block">${escapeHtml(formatted)}</pre>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function buildCurlCommand(entry: HttpLogEntry): string {
  const parts = [`curl -X ${entry.method}`];
  for (const [k, v] of entry.reqHeaders) {
    const lower = k.toLowerCase();
    if (lower === "host" || lower === "content-length" || lower === "proxy-connection") continue;
    parts.push(`-H ${JSON.stringify(`${k}: ${v}`)}`);
  }
  if (entry.reqBody && entry.reqBodyEncoding === "utf8") {
    parts.push(`--data-raw ${JSON.stringify(entry.reqBody)}`);
  }
  parts.push(JSON.stringify(entry.url));
  return parts.join(" \\\n  ");
}

function renderTunnelDetail(entry: TunnelLogEntry): void {
  el.detailRoot.innerHTML = `
    <div class="detail-card">
      <div class="detail-url-row">
        <div class="detail-url">CONNECT ${escapeHtml(entry.targetHost)}:${entry.targetPort}</div>
        <span class="status-badge ${entry.status === "error" ? "status-err" : "status-tunnel"}">
          ${entry.status === "error" ? "TUNNEL ERROR" : "TUNNEL CLOSED"}
        </span>
      </div>
      <div class="info-banner">
        Passthrough TCP/TLS tunnel without MITM interception. Encrypted payloads are forwarded untouched; only target host, port, duration, and byte counts are logged.
      </div>
      ${entry.error ? `<div class="error-banner">${escapeHtml(entry.error)}</div>` : ""}
      <div class="meta-grid">
        <div class="meta-item"><div class="meta-label">Target</div><div class="meta-value">${escapeHtml(entry.targetHost)}:${entry.targetPort}</div></div>
        <div class="meta-item"><div class="meta-label">Duration</div><div class="meta-value">${entry.durationMs} ms</div></div>
        <div class="meta-item"><div class="meta-label">Bytes Up</div><div class="meta-value">${formatBytes(entry.bytesUp)}</div></div>
        <div class="meta-item"><div class="meta-label">Bytes Down</div><div class="meta-value">${formatBytes(entry.bytesDown)}</div></div>
        <div class="meta-item"><div class="meta-label">Client IP</div><div class="meta-value">${escapeHtml(entry.clientIp || "-")}</div></div>
        <div class="meta-item"><div class="meta-label">Timestamp</div><div class="meta-value">${escapeHtml(entry.timestamp)}</div></div>
      </div>
    </div>
    <div class="detail-card">
      <div class="section-header"><h3>Raw JSONL Record</h3></div>
      <pre class="code-block">${escapeHtml(JSON.stringify(entry, null, 2))}</pre>
    </div>
  `;
}

function renderHttpDetail(detail: LogDetailResponse): void {
  const entry = detail.entry as HttpLogEntry;
  const sseEvents = detail.resBodyPreview?.sseEvents;
  if (state.activeTab === "sse" && (!sseEvents || sseEvents.length === 0)) {
    state.activeTab = "response";
  }

  let tabContent = "";
  if (state.activeTab === "response") {
    tabContent = `
      <div class="detail-card">
        <div class="section-header"><h3>Response Headers (${entry.resHeaders?.length ?? 0})</h3></div>
        ${renderHeadersTable(entry.resHeaders)}
      </div>
      <div class="detail-card">
        <div class="section-header"><h3>Response Body</h3></div>
        ${renderBodySection(
          entry.resBody,
          entry.resBodyEncoding,
          entry.resBodyBytes,
          entry.resBodyTruncated,
          detail.resBodyPreview
        )}
      </div>
    `;
  } else if (state.activeTab === "request") {
    tabContent = `
      <div class="detail-card">
        <div class="section-header"><h3>Request Headers (${entry.reqHeaders.length})</h3></div>
        ${renderHeadersTable(entry.reqHeaders)}
      </div>
      <div class="detail-card">
        <div class="section-header"><h3>Request Body</h3></div>
        ${renderBodySection(
          entry.reqBody,
          entry.reqBodyEncoding,
          entry.reqBodyBytes,
          entry.reqBodyTruncated,
          detail.reqBodyPreview
        )}
      </div>
    `;
  } else if (state.activeTab === "sse") {
    tabContent = `
      <div class="detail-card">
        <div class="section-header">
          <h3>SSE Events (${sseEvents?.length ?? 0})</h3>
          <div class="segmented">
            <button class="seg-btn${state.bodyMode === "pretty" ? " active" : ""}" data-bodymode="pretty" type="button">Pretty</button>
            <button class="seg-btn${state.bodyMode === "raw" ? " active" : ""}" data-bodymode="raw" type="button">Raw</button>
          </div>
        </div>
        ${renderSseEvents(sseEvents)}
      </div>
    `;
  } else {
    tabContent = `
      <div class="detail-card">
        <div class="section-header"><h3>Raw JSONL Record</h3></div>
        <pre class="code-block">${escapeHtml(JSON.stringify(entry, null, 2))}</pre>
      </div>
    `;
  }

  el.detailRoot.innerHTML = `
    <div class="detail-card">
      <div class="detail-url-row">
        <div class="detail-url">${escapeHtml(entry.method)} ${escapeHtml(entry.url)}</div>
        <div class="detail-actions">
          <button class="btn btn-small" id="copy-url-btn" type="button">Copy URL</button>
          <button class="btn btn-small" id="copy-curl-btn" type="button">Copy curl</button>
        </div>
      </div>
      ${entry.error ? `<div class="error-banner">Error: ${escapeHtml(entry.error)}</div>` : ""}
      ${entry.aborted ? `<div class="error-banner">Client aborted request before stream completed.</div>` : ""}
      <div class="meta-grid">
        <div class="meta-item"><div class="meta-label">Status</div><div class="meta-value">${entry.statusCode ?? "-"} ${escapeHtml(entry.statusText || "")}</div></div>
        <div class="meta-item"><div class="meta-label">TTFB</div><div class="meta-value">${entry.ttfbMs !== undefined ? `${entry.ttfbMs} ms` : "-"}</div></div>
        <div class="meta-item"><div class="meta-label">Duration</div><div class="meta-value">${entry.durationMs} ms</div></div>
        <div class="meta-item"><div class="meta-label">Mode</div><div class="meta-value">${escapeHtml(entry.mode)}</div></div>
        <div class="meta-item"><div class="meta-label">Req / Res Size</div><div class="meta-value">↑${formatBytes(entry.reqBodyBytes)} ↓${formatBytes(entry.resBodyBytes)}</div></div>
        <div class="meta-item"><div class="meta-label">Timestamp</div><div class="meta-value">${escapeHtml(formatTime(entry.timestamp))}</div></div>
      </div>
    </div>

    <div class="tabs">
      <button class="tab-btn${state.activeTab === "response" ? " active" : ""}" data-tab="response" type="button">Response</button>
      <button class="tab-btn${state.activeTab === "request" ? " active" : ""}" data-tab="request" type="button">Request</button>
      ${
        sseEvents && sseEvents.length > 0
          ? `<button class="tab-btn${state.activeTab === "sse" ? " active" : ""}" data-tab="sse" type="button">SSE Stream (${sseEvents.length})</button>`
          : ""
      }
      <button class="tab-btn${state.activeTab === "raw" ? " active" : ""}" data-tab="raw" type="button">Raw JSONL</button>
    </div>

    ${tabContent}
  `;

  document.getElementById("copy-url-btn")?.addEventListener("click", () => {
    void navigator.clipboard?.writeText(entry.url);
  });
  document.getElementById("copy-curl-btn")?.addEventListener("click", () => {
    void navigator.clipboard?.writeText(buildCurlCommand(entry));
  });
}

function renderDetail(): void {
  if (!state.detail) return;
  if (state.detail.entry.type === "tunnel") {
    renderTunnelDetail(state.detail.entry);
  } else {
    renderHttpDetail(state.detail);
  }
}

async function fetchConfig(): Promise<void> {
  const res = await fetch("/api/config");
  if (!res.ok) return;
  const cfg = (await res.json()) as ConfigInfo;
  state.config = cfg;
  const displayHost = cfg.proxyHost === "0.0.0.0" ? window.location.hostname || "127.0.0.1" : cfg.proxyHost;
  const addr = `${displayHost}:${cfg.proxyPort}`;
  el.proxyAddr.textContent = addr;
  el.quickstartCmd.textContent = `curl -x http://${addr} http://httpbin.org/get`;
  state.stats = { total: cfg.totalLogs, http: cfg.httpLogs, tunnel: cfg.tunnelLogs };
  renderStats();
}

async function fetchLogs(): Promise<void> {
  const params = new URLSearchParams({
    page: String(state.page),
    limit: String(state.limit),
    type: state.type,
    status: state.status,
    q: state.q,
  });
  const res = await fetch(`/api/logs?${params.toString()}`);
  if (!res.ok) return;
  const data = (await res.json()) as ListResult;
  state.items = data.items;
  state.total = data.total;
  state.stats = data.stats;
  renderList();
}

async function selectLog(id: string): Promise<void> {
  state.selectedId = id;
  renderList();
  const res = await fetch(`/api/logs/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const detail = (await res.json()) as LogDetailResponse;
  state.detail = detail;
  if (detail.entry.type === "http" && detail.resBodyPreview?.sseEvents?.length) {
    state.activeTab = "sse";
  } else {
    state.activeTab = "response";
  }
  renderDetail();
}

function connectLiveEvents(): void {
  const es = new EventSource("/api/events");
  es.onopen = () => {
    el.liveIndicator.className = "live-badge connected";
    el.liveText.textContent = "Live";
  };
  es.onerror = () => {
    el.liveIndicator.className = "live-badge disconnected";
    el.liveText.textContent = "Reconnecting";
  };
  es.addEventListener("log", () => {
    void fetchLogs();
  });
}

function setupTheme(): void {
  try {
    const saved = localStorage.getItem("ptl-theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.setAttribute("data-theme", saved);
    }
  } catch {
    // Ignore storage errors in restricted environments.
  }

  el.themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const next =
      current === "dark" ? "light" : current === "light" ? "dark" : prefersDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("ptl-theme", next);
    } catch {
      // Ignore storage errors.
    }
  });
}

function bindEvents(): void {
  el.copyProxyBtn.addEventListener("click", () => {
    const addr = el.proxyAddr.textContent || "127.0.0.1:8080";
    const cmd = `export HTTP_PROXY=http://${addr} HTTPS_PROXY=http://${addr}`;
    void navigator.clipboard?.writeText(cmd);
    const hint = el.copyProxyBtn.querySelector(".copy-hint");
    if (hint) {
      hint.textContent = "Copied!";
      setTimeout(() => {
        hint.textContent = "Copy";
      }, 1400);
    }
  });

  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  el.searchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = el.searchInput.value;
      state.page = 1;
      void fetchLogs();
    }, 150);
  });

  document.querySelectorAll<HTMLButtonElement>(".seg-btn[data-type]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".seg-btn[data-type]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      state.type = (btn.dataset.type as AppState["type"]) || "all";
      state.page = 1;
      void fetchLogs();
    });
  });

  el.statusFilter.addEventListener("change", () => {
    state.status = el.statusFilter.value;
    state.page = 1;
    void fetchLogs();
  });

  el.refreshBtn.addEventListener("click", () => {
    void fetchLogs();
  });

  el.prevPage.addEventListener("click", () => {
    if (state.page > 1) {
      state.page--;
      void fetchLogs();
    }
  });

  el.nextPage.addEventListener("click", () => {
    const totalPages = Math.max(1, Math.ceil(state.total / state.limit));
    if (state.page < totalPages) {
      state.page++;
      void fetchLogs();
    }
  });

  el.listBody.addEventListener("click", (ev) => {
    const row = (ev.target as HTMLElement).closest<HTMLElement>(".log-row");
    if (row?.dataset.id) {
      void selectLog(row.dataset.id);
    }
  });

  el.detailRoot.addEventListener("click", (ev) => {
    const tabBtn = (ev.target as HTMLElement).closest<HTMLElement>("[data-tab]");
    if (tabBtn?.dataset.tab) {
      state.activeTab = tabBtn.dataset.tab as AppState["activeTab"];
      renderDetail();
      return;
    }
    const modeBtn = (ev.target as HTMLElement).closest<HTMLElement>("[data-bodymode]");
    if (modeBtn?.dataset.bodymode) {
      state.bodyMode = modeBtn.dataset.bodymode as AppState["bodyMode"];
      renderDetail();
    }
  });
}

setupTheme();
bindEvents();
void fetchConfig();
void fetchLogs();
connectLiveEvents();
