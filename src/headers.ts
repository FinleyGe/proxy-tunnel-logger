import type { HeaderPair } from "./types.ts";

const HOP_BY_HOP_HEADERS = new Set([
  "proxy-connection",
  "proxy-authorization",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Convert Node's flat rawHeaders array into ordered [name, value] pairs.
 */
export function rawHeadersToPairs(rawHeaders: string[]): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    pairs.push([rawHeaders[i]!, rawHeaders[i + 1]!]);
  }
  return pairs;
}

/**
 * Convert a Fetch API Headers instance into ordered [name, value] pairs,
 * preserving multiple Set-Cookie headers.
 */
export function fetchHeadersToPairs(headers: Headers): HeaderPair[] {
  const pairs: HeaderPair[] = [];
  const setCookies = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
  for (const [key, value] of headers.entries()) {
    if (key.toLowerCase() === "set-cookie") continue;
    pairs.push([key, value]);
  }
  for (const cookie of setCookies) {
    pairs.push(["set-cookie", cookie]);
  }
  return pairs;
}

/**
 * Collect additional hop-by-hop header names listed in Connection headers.
 */
function extractConnectionTokens(pairs: HeaderPair[]): Set<string> {
  const dynamicHopByHop = new Set<string>();
  for (const [name, value] of pairs) {
    if (name.toLowerCase() === "connection") {
      for (const token of value.split(",")) {
        const normalized = token.trim().toLowerCase();
        if (normalized) dynamicHopByHop.add(normalized);
      }
    }
  }
  return dynamicHopByHop;
}

/**
 * Remove hop-by-hop headers (both standard and Connection-nominated).
 */
export function stripHopByHopHeaders(
  pairs: HeaderPair[],
  options: { dropHost?: boolean } = {}
): HeaderPair[] {
  const dynamicHopByHop = extractConnectionTokens(pairs);
  return pairs.filter(([name]) => {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || dynamicHopByHop.has(lower)) {
      return false;
    }
    if (options.dropHost && lower === "host") {
      return false;
    }
    return true;
  });
}

/**
 * Build a Fetch Headers object from header pairs without dropping duplicate keys.
 */
export function pairsToFetchHeaders(pairs: HeaderPair[]): Headers {
  const headers = new Headers();
  for (const [name, value] of pairs) {
    headers.append(name, value);
  }
  return headers;
}

/**
 * Convert header pairs to a Node ServerResponse-compatible header map,
 * preserving array values for repeated headers like Set-Cookie.
 */
export function pairsToNodeHeaders(pairs: HeaderPair[]): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of pairs) {
    const existing = out[name];
    if (existing === undefined) {
      out[name] = value;
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      out[name] = [existing, value];
    }
  }
  return out;
}

/**
 * Look up the first matching header value case-insensitively.
 */
export function getHeaderValue(pairs: HeaderPair[] | undefined, target: string): string | undefined {
  if (!pairs) return undefined;
  const lower = target.toLowerCase();
  for (const [name, value] of pairs) {
    if (name.toLowerCase() === lower) return value;
  }
  return undefined;
}
