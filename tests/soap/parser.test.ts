import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { guardXml, inspectDocument } from "../../lib/soap/parser";
import type { DocumentInfo } from "../../lib/soap/parser";
import type { LazarusError } from "../../lib/soap/types";

function isError(r: DocumentInfo | LazarusError): r is LazarusError {
  return "code" in r;
}

function expectError(r: DocumentInfo | LazarusError, message?: string): LazarusError {
  if (!isError(r)) throw new Error("expected an error result");
  expect(r.code).toBe("WSDL_PARSE_FAILED");
  expect(r.message.length).toBeLessThanOrEqual(500);
  if (message !== undefined) expect(r.message).toBe(message);
  return r;
}

const WSDL_NS = "http://schemas.xmlsoap.org/wsdl/";
const PREFIXED = `<wsdl:definitions xmlns:wsdl="${WSDL_NS}" targetNamespace="urn:t"><wsdl:service name="S"/></wsdl:definitions>`;
const DEFAULT_NS = `<definitions xmlns="${WSDL_NS}"><service name="S"/><service name="T"/></definitions>`;

describe("inspectDocument (Stage 2)", () => {
  it("accepts the prefixed calculator fixture", () => {
    const r = inspectDocument(readFileSync("fixtures/calculator.wsdl", "utf8"));
    if (isError(r)) throw new Error(r.message);
    expect(r.rootNamespace).toBe(WSDL_NS);
    expect(r.rootLocalName).toBe("definitions");
    expect(r.serviceCount).toBeGreaterThanOrEqual(1);
  });

  it("accepts the default-namespace countryinfo fixture", () => {
    const r = inspectDocument(readFileSync("fixtures/countryinfo.wsdl", "utf8"));
    if (isError(r)) throw new Error(r.message);
    expect(r.serviceCount).toBeGreaterThanOrEqual(1);
  });

  it("accepts inline prefixed and default-namespace roots", () => {
    const a = inspectDocument(PREFIXED);
    const b = inspectDocument(DEFAULT_NS);
    if (isError(a) || isError(b)) throw new Error("expected acceptance");
    expect(a.serviceCount).toBe(1);
    expect(a.targetNamespace).toBe("urn:t");
    expect(b.serviceCount).toBe(2);
    expect(b.targetNamespace).toBeNull();
  });

  it("rejects WSDL 2.0", () => {
    expectError(
      inspectDocument(`<description xmlns="http://www.w3.org/ns/wsdl"></description>`),
      "WSDL 2.0 is not supported yet.",
    );
  });

  it("rejects non-WSDL XML", () => {
    expectError(inspectDocument(`<root xmlns="urn:x"><a/></root>`), "Not a recognised WSDL document.");
  });

  it("rejects a definitions element in the wrong namespace", () => {
    expectError(inspectDocument(`<definitions xmlns="urn:other"/>`), "Not a recognised WSDL document.");
  });

  it("reports line and column for malformed XML", () => {
    const r = expectError(inspectDocument(`<a>\n<b></a>`));
    expect(r.message).toMatch(/line \d+/);
    expect(r.message).toMatch(/column \d+/);
  });

  it("rejects a WSDL 1.1 document with no service", () => {
    expectError(
      inspectDocument(`<definitions xmlns="${WSDL_NS}"><message name="m"/></definitions>`),
      "No services found in the WSDL.",
    );
  });
});

describe("guardXml (Stage 1)", () => {
  function expectRejected(xml: string): void {
    const r = guardXml(xml);
    expect(r).not.toBeNull();
    expect(r?.code).toBe("WSDL_PARSE_FAILED");
  }

  it("rejects a DOCTYPE declaration", () => {
    expectRejected("<!DOCTYPE foo>");
  });

  it("rejects a lowercase doctype declaration", () => {
    expectRejected("<!doctype foo>");
  });

  it("rejects a DOCTYPE after a 5000-character comment", () => {
    const body = "x".repeat(5000);
    expect(body).toHaveLength(5000);
    expectRejected(`<?xml version="1.0"?><!--${body}--><!DOCTYPE foo><foo/>`);
  });

  it("rejects a billion-laughs document", () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol1 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol2 "&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;&lol1;"><!ENTITY lol9 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><lolz>&lol9;</lolz>`;
    expectRejected(xml);
  });

  it("rejects an empty string", () => {
    expectRejected("");
  });

  it("accepts the calculator fixture", () => {
    expect(guardXml(readFileSync("fixtures/calculator.wsdl", "utf8"))).toBeNull();
  });
});
