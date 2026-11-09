// tests/soap/fetcher.test.ts
import { describe, it, expect } from "vitest";
import { isBlockedIp } from "../../lib/soap/fetcher";
import * as fc from 'fast-check';
import { BlockList } from 'net';

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

// ─── Property 5: IP classifier correctness ────────────────────────────────────
// Feature: summon, Property 5: IP classifier correctness
describe("Property 5: IP classifier correctness (oracle + range generators)", () => {
  // Use separate BlockList instances for IPv4 and IPv6 because Node.js net.BlockList
  // maps IPv4-mapped IPv6 ranges (::ffff:0.0.0.0/96) onto plain IPv4 addresses when
  // check() is called with 'ipv4'. That would make the oracle incorrectly flag public
  // IPv4 addresses (e.g. 1.0.0.0) as blocked. isBlockedIp correctly leaves those
  // unblocked, so we must not include IPv6 ranges in the IPv4 oracle.

  // IPv4-only oracle — mirrors BLOCKED_IPV4_RANGES in lib/soap/fetcher.ts
  const ipv4BlockList = new BlockList();
  ipv4BlockList.addSubnet('0.0.0.0', 8, 'ipv4');
  ipv4BlockList.addSubnet('127.0.0.0', 8, 'ipv4');
  ipv4BlockList.addSubnet('10.0.0.0', 8, 'ipv4');
  ipv4BlockList.addSubnet('172.16.0.0', 12, 'ipv4');
  ipv4BlockList.addSubnet('192.168.0.0', 16, 'ipv4');
  ipv4BlockList.addSubnet('169.254.0.0', 16, 'ipv4');
  ipv4BlockList.addAddress('169.254.169.254', 'ipv4');  // /32
  ipv4BlockList.addSubnet('100.64.0.0', 10, 'ipv4');
  ipv4BlockList.addSubnet('224.0.0.0', 4, 'ipv4');
  ipv4BlockList.addSubnet('240.0.0.0', 4, 'ipv4');

  // IPv6-only oracle — mirrors BLOCKED_IPV6_RANGES in lib/soap/fetcher.ts
  const ipv6BlockList = new BlockList();
  ipv6BlockList.addAddress('::1', 'ipv6');           // loopback /128
  ipv6BlockList.addAddress('::', 'ipv6');             // unspecified /128
  ipv6BlockList.addSubnet('fc00::', 7, 'ipv6');
  ipv6BlockList.addSubnet('fe80::', 10, 'ipv6');
  ipv6BlockList.addAddress('fd00:ec2::254', 'ipv6'); // cloud metadata /128
  ipv6BlockList.addSubnet('::ffff:0.0.0.0', 96, 'ipv6');  // IPv4-mapped
  ipv6BlockList.addSubnet('::', 96, 'ipv6');          // IPv4-compatible
  ipv6BlockList.addSubnet('64:ff9b::', 96, 'ipv6');
  ipv6BlockList.addSubnet('64:ff9b:1::', 48, 'ipv6');
  ipv6BlockList.addSubnet('2002::', 16, 'ipv6');
  ipv6BlockList.addSubnet('ff00::', 8, 'ipv6');

  // ── Part A: Oracle properties ──────────────────────────────────────────────

  it("IPv4 oracle: isBlockedIp matches net.BlockList for any IPv4 address", () => {
    fc.assert(
      fc.property(fc.ipV4(), (ip) => {
        const oracle = ipv4BlockList.check(ip, 'ipv4');
        return isBlockedIp(ip) === oracle;
      }),
      { numRuns: 1000 }
    );
  });

  it("IPv6 oracle: isBlockedIp matches net.BlockList for pure hex IPv6 addresses", () => {
    // fc.ipV6() can emit mixed IPv4-in-IPv6 notation that net.BlockList.check() rejects.
    // Filter to pure hex IPv6 only.
    const pureHexIPv6 = fc.ipV6().filter(ip => !/\d+\.\d+\.\d+\.\d+/.test(ip));
    fc.assert(
      fc.property(pureHexIPv6, (ip) => {
        const oracle = ipv6BlockList.check(ip, 'ipv6');
        return isBlockedIp(ip) === oracle;
      }),
      { numRuns: 1000 }
    );
  });

  // ── Part B: Range generators asserting true ────────────────────────────────

  function arbitraryIpv4InRange(networkDotted: string, prefix: number): fc.Arbitrary<string> {
    const parts = networkDotted.split('.').map(Number);
    const networkInt = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    const hostBits = 32 - prefix;
    const hostCount = hostBits > 0 ? (1 << hostBits) - 1 : 0;
    return fc.integer({ min: 0, max: hostCount }).map((host) => {
      const ip = (networkInt | host) >>> 0;
      return [(ip >>> 24) & 0xff, (ip >>> 16) & 0xff, (ip >>> 8) & 0xff, ip & 0xff].join('.');
    });
  }

  it("IPs inside 0.0.0.0/8 are blocked", () => {
    fc.assert(
      fc.property(arbitraryIpv4InRange('0.0.0.0', 8), (ip) => isBlockedIp(ip) === true),
      { numRuns: 100 }
    );
  });

  it("IPs inside 127.0.0.0/8 (loopback) are blocked", () => {
    fc.assert(
      fc.property(arbitraryIpv4InRange('127.0.0.0', 8), (ip) => isBlockedIp(ip) === true),
      { numRuns: 100 }
    );
  });

  it("IPs inside 10.0.0.0/8 (private A) are blocked", () => {
    fc.assert(
      fc.property(arbitraryIpv4InRange('10.0.0.0', 8), (ip) => isBlockedIp(ip) === true),
      { numRuns: 100 }
    );
  });

  it("IPs inside 172.16.0.0/12 (private B) are blocked", () => {
    fc.assert(
      fc.property(arbitraryIpv4InRange('172.16.0.0', 12), (ip) => isBlockedIp(ip) === true),
      { numRuns: 100 }
    );
  });

  it("IPs inside 192.168.0.0/16 (private C) are blocked", () => {
    fc.assert(
      fc.property(arbitraryIpv4InRange('192.168.0.0', 16), (ip) => isBlockedIp(ip) === true),
      { numRuns: 100 }
    );
  });

  it("IPs inside 169.254.0.0/16 (link-local) are blocked", () => {
    fc.assert(
      fc.property(arbitraryIpv4InRange('169.254.0.0', 16), (ip) => isBlockedIp(ip) === true),
      { numRuns: 100 }
    );
  });

  it("IPs inside 100.64.0.0/10 (CGNAT) are blocked", () => {
    fc.assert(
      fc.property(arbitraryIpv4InRange('100.64.0.0', 10), (ip) => isBlockedIp(ip) === true),
      { numRuns: 100 }
    );
  });

  it("IPs inside 224.0.0.0/4 (multicast) are blocked", () => {
    fc.assert(
      fc.property(arbitraryIpv4InRange('224.0.0.0', 4), (ip) => isBlockedIp(ip) === true),
      { numRuns: 100 }
    );
  });

  it("IPs inside 240.0.0.0/4 (reserved) are blocked", () => {
    fc.assert(
      fc.property(arbitraryIpv4InRange('240.0.0.0', 4), (ip) => isBlockedIp(ip) === true),
      { numRuns: 100 }
    );
  });
});
