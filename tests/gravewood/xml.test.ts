import { describe, expect, it } from "vitest";
import { XMLValidator } from "fast-xml-parser";
import { buildEnvelope, buildFault, parseRequest, safeId } from "../../lib/gravewood/xml";

const SOAP_NS = "http://schemas.xmlsoap.org/soap/envelope/";

function wrap(prefix: string, inner: string): string {
  const p = prefix ? `${prefix}:` : "";
  const ns = prefix ? `xmlns:${prefix}="${SOAP_NS}"` : `xmlns="${SOAP_NS}"`;
  return `<${p}Envelope ${ns}><${p}Body>${inner}</${p}Body></${p}Envelope>`;
}

describe("parseRequest: DOCTYPE and entities", () => {
  it("rejects a DOCTYPE", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE foo>${wrap("soap", "<GetBalance/>")}`;
    expect(parseRequest(xml)).toEqual({ ok: false, reason: "doctype" });
  });

  it("rejects a DOCTYPE hidden after 5000 chars of comment padding", () => {
    const pad = `<!--${"x".repeat(5000)}-->`;
    const xml = `${pad}<!DOCTYPE foo>${wrap("soap", "<GetBalance/>")}`;
    expect(parseRequest(xml)).toEqual({ ok: false, reason: "doctype" });
  });

  it("rejects <!ENTITY on its own", () => {
    const xml = `<!ENTITY a "b">${wrap("soap", "<GetBalance/>")}`;
    expect(parseRequest(xml)).toEqual({ ok: false, reason: "doctype" });
  });

  it("rejects a billion-laughs sample quickly without expanding it", () => {
    const xml =
      `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">` +
      `<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">` +
      `<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">` +
      `<!ENTITY lol4 "&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;&lol3;">]>` +
      wrap("soap", "<GetBalance><accountId>&lol4;</accountId></GetBalance>");
    const start = performance.now();
    const result = parseRequest(xml);
    const elapsed = performance.now() - start;
    expect(result).toEqual({ ok: false, reason: "doctype" });
    expect(elapsed).toBeLessThan(1000);
  });
});

describe("parseRequest: namespaces and values", () => {
  it.each(["soap", "s", "env", "SOAP-ENV"])("accepts the %s: prefix", (prefix) => {
    const result = parseRequest(wrap(prefix, "<GetBalance><accountId>4471</accountId></GetBalance>"));
    expect(result).toEqual({ ok: true, operation: "GetBalance", params: { accountId: "4471" } });
  });

  it("accepts a default xmlns", () => {
    const result = parseRequest(wrap("", "<GetBalance><accountId>4471</accountId></GetBalance>"));
    expect(result).toEqual({ ok: true, operation: "GetBalance", params: { accountId: "4471" } });
  });

  it("decodes &amp; and &lt; in a text value", () => {
    const result = parseRequest(wrap("soap", "<UpdateAddress><address>A &amp; B &lt; C</address></UpdateAddress>"));
    expect(result).toEqual({ ok: true, operation: "UpdateAddress", params: { address: "A & B < C" } });
  });

  it('keeps "0042" as the string "0042"', () => {
    const result = parseRequest(wrap("soap", "<GetBalance><accountId>0042</accountId></GetBalance>"));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.accountId).toBe("0042");
  });

  it('returns "malformed" for malformed XML', () => {
    expect(parseRequest("<soap:Envelope><soap:Body></soap:Envelope>")).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it('returns "no-operation" when there is no Body', () => {
    const xml = `<soap:Envelope xmlns:soap="${SOAP_NS}"><soap:Header/></soap:Envelope>`;
    expect(parseRequest(xml)).toEqual({ ok: false, reason: "no-operation" });
  });
});

describe("buildEnvelope", () => {
  it("escapes injected markup and stays well-formed", () => {
    const xml = buildEnvelope({
      name: "GetBalanceResponse",
      children: [{ name: "owner", text: `</owner><evil a="1">&'` }],
    });
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).not.toContain("<evil");
    expect(xml).toContain("&lt;/owner&gt;&lt;evil a=&quot;1&quot;&gt;&amp;&apos;");
  });

  it('renders a nil element as xsi:nil="true"', () => {
    const xml = buildEnvelope({
      name: "Response",
      children: [{ name: "closedAt", nil: true }],
    });
    expect(xml).toContain('<closedAt xsi:nil="true"/>');
    expect(XMLValidator.validate(xml)).toBe(true);
  });

  it('puts xmlns="urn:gravewood" on the root response element', () => {
    const xml = buildEnvelope({ name: "ListAccountsResponse", children: [] });
    expect(xml).toContain('<ListAccountsResponse xmlns="urn:gravewood">');
  });

  it("throws on an invalid element name", () => {
    expect(() => buildEnvelope({ name: "bad name" })).toThrow();
    expect(() => buildEnvelope({ name: "ok", children: [{ name: "a><b" }] })).toThrow();
    expect(() => buildEnvelope({ name: "1abc" })).toThrow();
  });
});

describe("buildFault", () => {
  it.each(["Client", "Server"] as const)("builds a %s fault with unqualified children", (kind) => {
    const xml = buildFault(kind, "Something broke");
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).toContain("<soap:Fault>");
    expect(xml).toContain(`<faultcode>soap:${kind}</faultcode>`);
    expect(xml).toContain("<faultstring>Something broke</faultstring>");
  });

  it("truncates a long message to 200 chars", () => {
    const xml = buildFault("Server", "a".repeat(500));
    const match = /<faultstring>(.*)<\/faultstring>/.exec(xml);
    expect(match?.[1]).toBe("a".repeat(200));
  });

  it("escapes markup in the message", () => {
    const xml = buildFault("Client", "<script>&</script>");
    expect(XMLValidator.validate(xml)).toBe(true);
    expect(xml).not.toContain("<script>");
    expect(xml).toContain("&lt;script&gt;&amp;&lt;/script&gt;");
  });
});

describe("safeId", () => {
  it('accepts "4471"', () => {
    expect(safeId("4471")).toBe("4471");
  });

  it.each([
    ["quote suffix", "4471'"],
    ["empty string", ""],
    ["13 digits", "1234567890123"],
    ["prefixed", "gw:1"],
  ])("rejects %s", (_label, value) => {
    expect(safeId(value)).toBeNull();
  });

  it.each([
    ["number", 4471],
    ["null", null],
    ["undefined", undefined],
    ["object", { id: "4471" }],
  ])("rejects non-string %s", (_label, value) => {
    expect(safeId(value)).toBeNull();
  });
});
