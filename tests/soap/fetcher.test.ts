// tests/soap/fetcher.test.ts
import { describe, it, expect } from "vitest";
import { isBlockedIp } from "../../lib/soap/fetcher";
describe("isBlockedIp", () => {
  // ── Fail-closed: non-IP input ──────────────────────────────────────────────
  it("blocks empty string (fail-closed)", () => {
    expect(isBlockedIp("")).toBe(true);
  });
  it("blocks non-IP garbage string (fail-closed)", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
  });
  // ── Leading-zero octet rejection ──────────────────────────────────────────
  it("blocks 0177.0.0.1 (leading-zero octet — fail-closed)", () => {
    // "0177" could be misread as octal 127 by some parsers; we reject it outright
    expect(isBlockedIp("0177.0.0.1")).toBe(true);
  });
  // ── IPv6 zone ID stripping ─────────────────────────────────────────────────
  it("blocks fe80::1%eth0 (link-local with zone ID)", () => {
    expect(isBlockedIp("fe80::1%eth0")).toBe(true);
  });
  // ── IPv6 embedded IPv4 notation ───────────────────────────────────────────
  it("blocks ::ffff:127.0.0.1 (IPv4-mapped loopback, embedded IPv4)", () => {
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
  });
  it("blocks ::ffff:7f00:1 (IPv4-mapped loopback, hex form)", () => {
    expect(isBlockedIp("::ffff:7f00:1")).toBe(true);
  });
  it("blocks ::127.0.0.1 (IPv4-compatible, embedded IPv4)", () => {
    // Falls in ::/96 (IPv4-compatible range)
    expect(isBlockedIp("::127.0.0.1")).toBe(true);
  });
  // ── Unspecified address ────────────────────────────────────────────────────
  it("blocks :: (IPv6 unspecified)", () => {
    expect(isBlockedIp("::")).toBe(true);
  });
  // ── NAT64 ─────────────────────────────────────────────────────────────────
  it("blocks 64:ff9b::a9fe:a9fe (NAT64 64:ff9b::/96)", () => {
    expect(isBlockedIp("64:ff9b::a9fe:a9fe")).toBe(true);
  });
  // ── 6to4 ──────────────────────────────────────────────────────────────────
  it("blocks 2002:7f00:1:: (6to4 with loopback embedded)", () => {
    expect(isBlockedIp("2002:7f00:1::")).toBe(true);
  });
  // ── CGNAT / shared address ────────────────────────────────────────────────
  it("blocks 100.100.100.200 (CGNAT 100.64.0.0/10)", () => {
    expect(isBlockedIp("100.100.100.200")).toBe(true);
  });
  // ── Multicast ─────────────────────────────────────────────────────────────
  it("blocks 224.0.0.1 (IPv4 multicast 224.0.0.0/4)", () => {
    expect(isBlockedIp("224.0.0.1")).toBe(true);
  });
  it("blocks ff02::1 (IPv6 multicast ff00::/8)", () => {
    expect(isBlockedIp("ff02::1")).toBe(true);
  });
  // ── Reserved / broadcast ──────────────────────────────────────────────────
  it("blocks 255.255.255.255 (reserved 240.0.0.0/4)", () => {
    expect(isBlockedIp("255.255.255.255")).toBe(true);
  });
  // ── Public addresses (must remain allowed) ────────────────────────────────
  it("allows 8.8.8.8 (Google DNS)", () => {
    expect(isBlockedIp("8.8.8.8")).toBe(false);
  });
  it("allows 1.1.1.1 (Cloudflare DNS)", () => {
    expect(isBlockedIp("1.1.1.1")).toBe(false);
  });
  it("allows 172.32.0.1 (just outside 172.16.0.0/12)", () => {
    // 172.16.0.0/12 covers 172.16.0.0 – 172.31.255.255; 172.32.x is public
    expect(isBlockedIp("172.32.0.1")).toBe(false);
  });
  it("allows 2606:4700:4700::1111 (Cloudflare DNS, public IPv6)", () => {
    expect(isBlockedIp("2606:4700:4700::1111")).toBe(false);
  });
  // ── Existing range coverage ───────────────────────────────────────────────
  it("blocks 127.0.0.1 (loopback)", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
  });
  it("blocks 10.0.0.1 (private class A)", () => {
    expect(isBlockedIp("10.0.0.1")).toBe(true);
  });
  it("blocks 172.16.0.1 (private class B)", () => {
    expect(isBlockedIp("172.16.0.1")).toBe(true);
  });
  it("blocks 192.168.1.1 (private class C)", () => {
    expect(isBlockedIp("192.168.1.1")).toBe(true);
  });
  it("blocks 169.254.1.1 (link-local)", () => {
    expect(isBlockedIp("169.254.1.1")).toBe(true);
  });
  it("blocks 169.254.169.254 (cloud metadata)", () => {
    expect(isBlockedIp("169.254.169.254")).toBe(true);
  });
  it("blocks ::1 (IPv6 loopback)", () => {
    expect(isBlockedIp("::1")).toBe(true);
  });
  it("blocks fc00::1 (ULA private)", () => {
    expect(isBlockedIp("fc00::1")).toBe(true);
  });
  it("blocks fe80::1 (link-local without zone ID)", () => {
    expect(isBlockedIp("fe80::1")).toBe(true);
  });
});