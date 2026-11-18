// lib/soap/fetcher.ts
// SSRF-safe WSDL fetching. Every outbound HTTP request goes through this module.
//
// Exports:
//   isBlockedIp(ip)       — pure, no I/O, property-testable
//   safeFetch(url, opts)  — shared HTTP primitive (SSRF gate, timeout, size cap, redirects)
//   safePost(url, req)    — SSRF-safe SOAP POST: same gate as safeFetch, header allowlist,
//                           256 KB request cap, no redirects, any HTTP status returned
//   fetchWsdl(rawUrl)     — validates the URL, delegates to safeFetch

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { z } from "zod";
import { devAllowLoopback } from "../env";
import type { ErrorCode, LazarusError } from "./types";

// ─── IPv4 helpers ─────────────────────────────────────────────────────────────
/**
 * Parse a dotted-decimal IPv4 string into an unsigned 32-bit integer.
 * Returns null if the string is not a valid IPv4 address.
 *
 * Rejects:
 *   - non-numeric characters
 *   - leading zeros (e.g. "0177" is octal-like ambiguity — treated as invalid)
 *   - octets outside 0-255
 *   - anything other than exactly 4 parts
 */
function parseIPv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    // Reject empty, non-numeric, or leading-zero parts (e.g. "01", "0177")
    if (!/^\d+$/.test(part)) return null;
    if (part.length > 1 && part[0] === "0") return null; // leading zero
    const octet = Number(part);
    if (octet > 255) return null;
    n = ((n << 8) | octet) >>> 0;
  }
  return n;
}
/**
 * Check whether an IPv4 integer falls inside a CIDR range described by a
 * network address integer and a prefix length.
 */
function inIPv4Range(ip: number, network: number, prefix: number): boolean {
  if (prefix === 0) return true;
  const mask = (~0 << (32 - prefix)) >>> 0;
  return (ip & mask) >>> 0 === (network & mask) >>> 0;
}
// ─── IPv6 helpers ─────────────────────────────────────────────────────────────
/**
 * Expand a (possibly compressed) IPv6 string to exactly eight colon-separated
 * 16-bit hex groups.  Returns null if the string cannot be parsed.
 *
 * Zone IDs must be stripped by the caller before calling this function.
 * Supports embedded IPv4 notation, e.g. "::ffff:127.0.0.1" or "::127.0.0.1".
 */
function expandIPv6(ip: string): string | null {
  // Handle IPv4-mapped / IPv4-compatible suffix (e.g. ::ffff:192.168.1.1, ::127.0.0.1)
  const ipv4SuffixMatch = ip.match(
    /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (ipv4SuffixMatch) {
    const prefix = ipv4SuffixMatch[1];
    const v4 = parseIPv4(ipv4SuffixMatch[2]);
    if (v4 === null) return null;
    const hi = (v4 >>> 16) & 0xffff;
    const lo = v4 & 0xffff;
    ip = `${prefix}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null; // more than one "::" is invalid
  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const gs = s.split(":");
    const result: number[] = [];
    for (const g of gs) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      result.push(parseInt(g, 16));
    }
    return result;
  };
  if (halves.length === 1) {
    // No "::" — must be exactly 8 groups
    const groups = parseGroups(halves[0]);
    if (!groups || groups.length !== 8) return null;
    return groups.map((g) => g.toString(16).padStart(4, "0")).join(":");
  }
  // Has "::"
  const left = parseGroups(halves[0]);
  const right = parseGroups(halves[1]);
  if (!left || !right) return null;
  if (left.length + right.length > 7) return null; // "::" must expand to >= 1 group
  const missing = 8 - left.length - right.length;
  const middle = Array<number>(missing).fill(0);
  const groups = [...left, ...middle, ...right];
  return groups.map((g) => g.toString(16).padStart(4, "0")).join(":");
}
/**
 * Parse an expanded IPv6 string (8 colon-separated groups) into a BigInt.
 */
function ipv6ToBigInt(expanded: string): bigint {
  return expanded
    .split(":")
    .reduce((acc, group) => (acc << BigInt(16)) | BigInt(parseInt(group, 16)), BigInt(0));
}
/**
 * Check whether an IPv6 BigInt falls inside a CIDR range described by a
 * network BigInt and a prefix length.
 */
function inIPv6Range(ip: bigint, network: bigint, prefix: number): boolean {
  if (prefix === 0) return true;
  const shift = BigInt(128 - prefix);
  return ip >> shift === network >> shift;
}
// ─── Blocked range tables ─────────────────────────────────────────────────────
// Each entry: [networkInt, prefixLength]
const BLOCKED_IPV4_RANGES: ReadonlyArray<[number, number]> = [
  [0x00000000,  8], //   0.0.0.0/8          — unspecified
  [0x7f000000,  8], // 127.0.0.0/8          — loopback
  [0x0a000000,  8], //  10.0.0.0/8          — private class A
  [0xac100000, 12], // 172.16.0.0/12        — private class B
  [0xc0a80000, 16], // 192.168.0.0/16       — private class C
  [0xa9fe0000, 16], // 169.254.0.0/16       — link-local
  [0xa9fea9fe, 32], // 169.254.169.254/32   — cloud metadata (AWS/GCP/Azure)
  [0x64400000, 10], // 100.64.0.0/10        — shared address / CGNAT (RFC 6598)
  [0xe0000000,  4], // 224.0.0.0/4          — multicast (RFC 3171)
  [0xf0000000,  4], // 240.0.0.0/4          — reserved, incl. 255.255.255.255 (RFC 1112)
];
// Each entry: [expandedNetworkString, prefixLength]
const BLOCKED_IPV6_RANGES: ReadonlyArray<[string, number]> = [
  ["0000:0000:0000:0000:0000:0000:0000:0001", 128], // ::1               — loopback
  ["fc00:0000:0000:0000:0000:0000:0000:0000",   7], // fc00::/7          — private (ULA)
  ["fe80:0000:0000:0000:0000:0000:0000:0000",  10], // fe80::/10         — link-local
  ["fd00:0ec2:0000:0000:0000:0000:0000:0254", 128], // fd00:ec2::254/128 — cloud metadata
  ["0000:0000:0000:0000:0000:ffff:0000:0000",  96], // ::ffff:0:0/96     — IPv4-mapped
  ["0000:0000:0000:0000:0000:0000:0000:0000",  96], // ::/96             — IPv4-compatible
  ["0064:ff9b:0000:0000:0000:0000:0000:0000",  96], // 64:ff9b::/96      — NAT64 (RFC 6146)
  ["0064:ff9b:0001:0000:0000:0000:0000:0000",  48], // 64:ff9b:1::/48    — NAT64 local (RFC 8215)
  ["2002:0000:0000:0000:0000:0000:0000:0000",  16], // 2002::/16         — 6to4 (RFC 3056)
  ["ff00:0000:0000:0000:0000:0000:0000:0000",   8], // ff00::/8          — multicast
];
// ─── Public API ───────────────────────────────────────────────────────────────
/**
 * Returns true if the given IP address (IPv4 dotted-decimal or IPv6 colon-hex)
 * falls within any range that must not be contacted from a public server:
 * unspecified, loopback, private, link-local, cloud-metadata, IPv4-mapped/compatible,
 * NAT64, 6to4, CGNAT, multicast, or reserved.
 *
 * FAILS CLOSED: returns true (blocked) for any string that is not a valid IPv4
 * or IPv6 address, including empty strings and non-IP input.
 *
 * Pure function — no I/O, no external dependencies, safe to property-test.
 */
export function isBlockedIp(ip: string): boolean {
  if (typeof ip !== "string" || ip.length === 0) return true; // fail-closed
  // Strip IPv6 zone ID before any parsing (e.g. "fe80::1%eth0" -> "fe80::1")
  const stripped = ip.includes("%") ? ip.slice(0, ip.indexOf("%")) : ip;
  if (stripped.length === 0) return true;
  // ── Try IPv4 ──────────────────────────────────────────────────────────────
  const v4 = parseIPv4(stripped);
  if (v4 !== null) {
    for (const [network, prefix] of BLOCKED_IPV4_RANGES) {
      if (inIPv4Range(v4, network, prefix)) return true;
    }
    return false;
  }
  // ── Try IPv6 ──────────────────────────────────────────────────────────────
  const expanded = expandIPv6(stripped);
  if (expanded === null) return true; // unparseable — fail closed
  // Exact match for the unspecified address "::" / all-zeros
  // (also caught by ::/96 range below, but keep explicit for clarity)
  if (expanded === "0000:0000:0000:0000:0000:0000:0000:0000") return true;
  const ipBig = ipv6ToBigInt(expanded);
  for (const [networkStr, prefix] of BLOCKED_IPV6_RANGES) {
    const networkBig = ipv6ToBigInt(networkStr);
    if (inIPv6Range(ipBig, networkBig, prefix)) return true;
  }
  return false;
}

// ─── safeFetch ────────────────────────────────────────────────────────────────

export type FetchResult =
  | { ok: true; xml: string; finalUrl: string }
  | { ok: false; error: LazarusError };

export type SafeFetchResult = FetchResult;

export type SafeFetchOptions = {
  /** Total time budget across all redirect hops. Default 10 000 ms. */
  timeoutMs?: number;
  /** Maximum response body size in bytes. Default 5 242 880 (5 MB). */
  maxBytes?: number;
  /** Maximum number of redirect hops followed. Default 5. */
  maxRedirects?: number;
  /**
   * TEST-ONLY. Permits 127.0.0.0/8 so tests can use a local HTTP server.
   * All other blocked ranges stay blocked. `fetchWsdl` never sets this.
   * Ignored when NODE_ENV is "production".
   */
  allowLoopback?: boolean;
};

/**
 * True for IPv4 127.0.0.0/8 and exactly ::1 (used only with `allowLoopback`).
 * IPv4-mapped forms such as ::ffff:127.0.0.1 are deliberately not loopback here.
 */
function isLoopbackV4(ip: string): boolean {
  if (net.isIPv4(ip)) return ip.startsWith("127.");
  if (net.isIPv6(ip)) {
    return expandIPv6(ip) === "0000:0000:0000:0000:0000:0000:0000:0001";
  }
  return false;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 5_242_880;
const DEFAULT_MAX_REDIRECTS = 5;

const MSG_TIMEOUT = "The séance timed out — the service did not respond in time.";
const MSG_INVALID_URL = "Invalid URL — only HTTP and HTTPS are supported.";
const MSG_BLOCKED =
  "This address points to a private or internal network and cannot be summoned.";
const MSG_TOO_LARGE = "The WSDL document is too large (limit: 5 MB).";

function fail(code: ErrorCode, message: string, detail?: unknown): FetchResult {
  return { ok: false, error: { code, message, detail } };
}

/** Thrown from the custom lookup when a resolved address is blocked. */
class BlockedAddressError extends Error {
  constructor() {
    super("blocked address");
    this.name = "BlockedAddressError";
  }
}

/** Strip the brackets Node's URL parser leaves around IPv6 hostnames. */
function bareHostname(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

type HopOutcome =
  | { kind: "done"; xml: string }
  | { kind: "redirect"; location: string }
  | { kind: "error"; result: FetchResult };

/** Resolve the effective loopback flag. Always false in production. */
function resolveAllowLoopback(option: boolean | undefined): boolean {
  return (
    (option ?? devAllowLoopback()) === true &&
    process.env.NODE_ENV !== "production"
  );
}

/**
 * Node skips `lookup` for IP literals, so they must be checked explicitly.
 * Returns true when the hostname is a blocked IP literal.
 */
function isBlockedLiteralHost(url: URL, allowLoopback: boolean): boolean {
  const host = bareHostname(url.hostname);
  return (
    net.isIP(host) !== 0 &&
    isBlockedIp(host) &&
    !(allowLoopback && isLoopbackV4(host))
  );
}

/**
 * Build the DNS-pinning `lookup`: every resolved address is validated and the
 * validated one is handed to Node, which dials it directly. `onBlocked` is
 * called when any resolved address is blocked.
 */
function createPinnedLookup(
  allowLoopback: boolean,
  onBlocked: () => void,
): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(
      hostname,
      { all: true, family: options.family, hints: options.hints },
      (lookupErr, addresses) => {
        if (lookupErr) {
          callback(lookupErr, "", 0);
          return;
        }
        if (
          addresses.length === 0 ||
          addresses.some(
            (a) =>
              isBlockedIp(a.address) &&
              !(allowLoopback && isLoopbackV4(a.address)),
          )
        ) {
          onBlocked();
          callback(new BlockedAddressError(), "", 0);
          return;
        }
        if (options.all) {
          callback(null, addresses);
        } else {
          callback(null, addresses[0].address, addresses[0].family);
        }
      },
    );
  };
}

type PinnedInit = {
  method: "GET" | "POST";
  headers: Record<string, string | number>;
  body?: string;
};

type PinnedHandlers<T> = {
  /** Handle the response; call `settle` with the result or `err` on failure. */
  onResponse: (
    res: http.IncomingMessage,
    req: http.ClientRequest,
    settle: (value: T) => void,
    err: (code: ErrorCode, message: string, detail?: unknown) => void,
  ) => void;
  /** Wrap a failure into the caller's outcome type. */
  toError: (result: FetchResult) => T;
};

/**
 * Perform one HTTP(S) request with the SSRF machinery shared by GET and POST:
 * pinned lookup, blocked-address mapping, abort/timeout handling. The hostname
 * is unchanged so TLS still verifies the certificate against it.
 */
function pinnedRequest<T>(
  url: URL,
  init: PinnedInit,
  signal: AbortSignal,
  allowLoopback: boolean,
  handlers: PinnedHandlers<T>,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let blocked = false;
    let settled = false;
    const settle = (outcome: T): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const err = (code: ErrorCode, message: string, detail?: unknown): void =>
      settle(handlers.toError(fail(code, message, detail)));

    const lookup = createPinnedLookup(allowLoopback, () => {
      blocked = true;
    });

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(
      url,
      { method: init.method, lookup, agent: false, headers: init.headers },
      (res) => handlers.onResponse(res, req, settle, err),
    );

    const onAbort = (): void => {
      req.destroy();
      err("TIMEOUT", MSG_TIMEOUT);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });

    req.on("error", (e) => {
      if (blocked || e instanceof BlockedAddressError) {
        err("SSRF_BLOCKED", MSG_BLOCKED);
        return;
      }
      err(
        "WSDL_FETCH_FAILED",
        "The endpoint is unreachable or rejected the request.",
        e,
      );
    });
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/** One HTTP(S) GET for `safeFetch`. */
function requestOnce(
  url: URL,
  maxBytes: number,
  signal: AbortSignal,
  allowLoopback: boolean,
): Promise<HopOutcome> {
  return pinnedRequest<HopOutcome>(
    url,
    {
      method: "GET",
      headers: {
        Accept: "text/xml, application/xml, application/wsdl+xml, */*",
        "User-Agent": "Lazarus/1.0",
      },
    },
    signal,
    allowLoopback,
    {
      toError: (result) => ({ kind: "error", result }),
      onResponse: (res, req, settle, err) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          settle({ kind: "redirect", location: res.headers.location });
          return;
        }
        if (status >= 300 && status < 400) {
          res.resume();
          err(
            "WSDL_FETCH_FAILED",
            `The endpoint is unreachable or rejected the request (HTTP ${status}, redirect without a Location).`,
          );
          return;
        }
        if (status !== 200) {
          res.resume();
          err(
            "WSDL_FETCH_FAILED",
            `The endpoint is unreachable or rejected the request (HTTP ${status}).`,
          );
          return;
        }
        const declared = Number(res.headers["content-length"]);
        if (res.headers["content-length"] !== undefined && declared > maxBytes) {
          req.destroy();
          err("WSDL_TOO_LARGE", MSG_TOO_LARGE);
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            req.destroy();
            err("WSDL_TOO_LARGE", MSG_TOO_LARGE);
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () =>
          settle({ kind: "done", xml: Buffer.concat(chunks).toString("utf8") }),
        );
        res.on("error", (e) =>
          err("WSDL_FETCH_FAILED", "The connection was interrupted.", e),
        );
      },
    },
  );
}

/**
 * Shared HTTP primitive for every outbound request in the summon pipeline.
 * Enforces SSRF checks on every hop, a total timeout, a body-size cap and a
 * redirect limit. Never throws; failures are returned as `{ ok: false }`.
 */
export async function safeFetch(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let remainingHops = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const allowLoopback = resolveAllowLoopback(options.allowLoopback);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current: URL;
    try {
      current = new URL(url);
    } catch {
      return fail("INVALID_REQUEST", MSG_INVALID_URL);
    }

    for (;;) {
      if (current.protocol !== "http:" && current.protocol !== "https:") {
        return fail("INVALID_REQUEST", MSG_INVALID_URL);
      }
      if (isBlockedLiteralHost(current, allowLoopback)) {
        return fail("SSRF_BLOCKED", MSG_BLOCKED);
      }

      const outcome = await requestOnce(
        current,
        maxBytes,
        controller.signal,
        allowLoopback,
      );
      if (outcome.kind === "error") return outcome.result;
      if (outcome.kind === "done") {
        return { ok: true, xml: outcome.xml, finalUrl: current.toString() };
      }

      if (remainingHops <= 0) {
        return fail(
          "WSDL_FETCH_FAILED",
          "Too many redirects were encountered (maximum 5).",
        );
      }
      remainingHops -= 1;
      try {
        current = new URL(outcome.location, current);
      } catch {
        return fail(
          "WSDL_FETCH_FAILED",
          "The endpoint returned an invalid redirect location.",
        );
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

// ─── safePost ─────────────────────────────────────────────────────────────────

export type SafePostRequest = {
  body: string;
  headers: Record<string, string>;
  /** Total time budget. Default 25 000 ms. */
  timeoutMs?: number;
  /** Maximum response body size in bytes. Default 5 242 880 (5 MB). */
  maxBytes?: number;
  /** TEST-ONLY. Same semantics as `SafeFetchOptions.allowLoopback`. */
  allowLoopback?: boolean;
};

export type SafePostResult =
  | { ok: true; status: number; body: string }
  | { ok: false; error: LazarusError };

type PostOutcome =
  | { kind: "done"; status: number; body: string }
  | { kind: "error"; result: FetchResult };

const POST_DEFAULT_TIMEOUT_MS = 25_000;
const POST_MAX_REQUEST_BYTES = 262_144;
const POST_ALLOWED_HEADERS: ReadonlyMap<string, string> = new Map([
  ["content-type", "Content-Type"],
  ["soapaction", "SOAPAction"],
]);

const MSG_REQUEST_TOO_LARGE = "The request body is too large (limit: 256 KB).";
const MSG_RESPONSE_TOO_LARGE = "The service response is too large (limit: 5 MB).";
const MSG_POST_REDIRECT = "The service tried to redirect the call; redirects are not followed.";
const MSG_POST_INVALID_URL = MSG_INVALID_URL;

/** Keep only allowlisted headers (case-insensitive), canonically named. */
function filterPostHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const canonical = POST_ALLOWED_HEADERS.get(name.toLowerCase());
    if (canonical !== undefined && typeof value === "string") {
      out[canonical] = value;
    }
  }
  return out;
}

/**
 * SSRF-safe POST for SOAP calls. Same lookup pinning, blocked-IP and loopback
 * rules as `safeFetch`. Never follows redirects, returns every HTTP status
 * with its body, and never throws. Error messages never include upstream text.
 */
export async function safePost(
  url: string,
  req: SafePostRequest,
): Promise<SafePostResult> {
  const timeoutMs = req.timeoutMs ?? POST_DEFAULT_TIMEOUT_MS;
  const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
  const toFail = (r: FetchResult): SafePostResult =>
    r.ok ? { ok: false, error: { code: "INTERNAL_ERROR", message: "Unexpected result." } } : r;

  try {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return toFail(fail("INVALID_REQUEST", MSG_POST_INVALID_URL));
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      return toFail(fail("INVALID_REQUEST", MSG_POST_INVALID_URL));
    }
    if (typeof req.body !== "string") {
      return toFail(fail("INVALID_REQUEST", "The request body must be a string."));
    }
    const bodyBytes = Buffer.byteLength(req.body, "utf8");
    if (bodyBytes > POST_MAX_REQUEST_BYTES) {
      return toFail(fail("INVALID_REQUEST", MSG_REQUEST_TOO_LARGE));
    }
    const allowLoopback = resolveAllowLoopback(req.allowLoopback);
    if (isBlockedLiteralHost(target, allowLoopback)) {
      return toFail(fail("SSRF_BLOCKED", MSG_BLOCKED));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const outcome = await pinnedRequest<PostOutcome>(
        target,
        {
          method: "POST",
          headers: {
            ...filterPostHeaders(req.headers),
            "User-Agent": "Lazarus/1.0",
            "Content-Length": bodyBytes,
          },
          body: req.body,
        },
        controller.signal,
        allowLoopback,
        {
          toError: (result) => ({ kind: "error", result }),
          onResponse: (res, request, settle, err) => {
            const status = res.statusCode ?? 0;
            if (status >= 300 && status < 400) {
              res.resume();
              request.destroy();
              err("WSDL_FETCH_FAILED", MSG_POST_REDIRECT);
              return;
            }
            const declared = Number(res.headers["content-length"]);
            if (
              res.headers["content-length"] !== undefined &&
              declared > maxBytes
            ) {
              request.destroy();
              err("WSDL_TOO_LARGE", MSG_RESPONSE_TOO_LARGE);
              return;
            }
            const chunks: Buffer[] = [];
            let total = 0;
            res.on("data", (chunk: Buffer) => {
              total += chunk.length;
              if (total > maxBytes) {
                request.destroy();
                err("WSDL_TOO_LARGE", MSG_RESPONSE_TOO_LARGE);
                return;
              }
              chunks.push(chunk);
            });
            res.on("end", () =>
              settle({
                kind: "done",
                status,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            );
            res.on("error", (e) =>
              err("WSDL_FETCH_FAILED", "The connection was interrupted.", e),
            );
          },
        },
      );
      if (outcome.kind === "error") return toFail(outcome.result);
      return { ok: true, status: outcome.status, body: outcome.body };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return toFail(
      fail("INTERNAL_ERROR", "The request could not be completed.", e),
    );
  }
}

// ─── fetchWsdl ────────────────────────────────────────────────────────────────

const WsdlUrlSchema = z.string().url();

/** Validate the URL (HTTP/HTTPS only) and fetch the WSDL via `safeFetch`. */
export async function fetchWsdl(rawUrl: string): Promise<FetchResult> {
  const parsed = WsdlUrlSchema.safeParse(rawUrl);
  if (!parsed.success) return fail("INVALID_REQUEST", MSG_INVALID_URL);
  let scheme: string;
  try {
    scheme = new URL(parsed.data).protocol;
  } catch {
    return fail("INVALID_REQUEST", MSG_INVALID_URL);
  }
  if (scheme !== "http:" && scheme !== "https:") {
    return fail("INVALID_REQUEST", MSG_INVALID_URL);
  }
  try {
    return await safeFetch(parsed.data);
  } catch (e) {
    return fail(
      "WSDL_FETCH_FAILED",
      "The endpoint is unreachable or rejected the request.",
      e,
    );
  }
}
