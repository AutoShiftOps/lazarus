// lib/soap/fetcher.ts
// SSRF-safe WSDL fetching. Every outbound HTTP request goes through this module.
//
// Exports (task 4.1):
//   isBlockedIp(ip: string): boolean  — pure, no I/O, property-testable
//
// TODO (task 4.2): implement safeFetch and fetchWsdl
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
    .reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group, 16)), 0n);
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