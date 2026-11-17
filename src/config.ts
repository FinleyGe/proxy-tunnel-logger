import path from "node:path";

export interface AppConfig {
  proxyHost: string;
  proxyPort: number;
  uiHost: string;
  uiPort: number;
  dataDir: string;
  maxBodyBytes: number;
  upstream?: string;
}

const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MiB

function parsePort(raw: string | undefined, fallback: number, name: string): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return parsed;
}

function parseNonNegativeInt(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return parsed;
}

/**
 * Load runtime configuration from environment variables with safe local defaults.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const upstreamRaw = env.UPSTREAM?.trim();
  let upstream: string | undefined;
  if (upstreamRaw) {
    const u = new URL(upstreamRaw);
    upstream = u.origin + (u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, ""));
  }

  return {
    proxyHost: env.PROXY_HOST?.trim() || "127.0.0.1",
    proxyPort: parsePort(env.PROXY_PORT, 8080, "PROXY_PORT"),
    uiHost: env.UI_HOST?.trim() || "127.0.0.1",
    uiPort: parsePort(env.UI_PORT, 3000, "UI_PORT"),
    dataDir: path.resolve(env.DATA_DIR?.trim() || "./data"),
    maxBodyBytes: parseNonNegativeInt(env.MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES, "MAX_BODY_BYTES"),
    upstream,
  };
}
