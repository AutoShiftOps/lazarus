import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  collectSchemaRefs,
  guardXml,
  indexDocument,
  inlineSchemas,
  inspectDocument,
  parseWsdl,
  verifyNoLocations,
} from "../../lib/soap/parser";
import type { SchemaFetchDeps, WsdlIndex } from "../../lib/soap/parser";
import type { FetchResult } from "../../lib/soap/fetcher";
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

// ─── Stages 3 & 4 ─────────────────────────────────────────────────────────────

const httpSpy = vi.spyOn(http, "request").mockImplementation(() => {
  throw new Error("real network access attempted");
});
const httpsSpy = vi.spyOn(https, "request").mockImplementation(() => {
  throw new Error("real network access attempted");
});
afterAll(() => {
  expect(httpSpy).not.toHaveBeenCalled();
  expect(httpsSpy).not.toHaveBeenCalled();
});

const XSD_NS = "http://www.w3.org/2001/XMLSchema";
const BASE = "http://host.test/dir/service.wsdl";

function schemaDoc(ns: string, imports: string[] = []): string {
  const body = imports
    .map((l) => `<xsd:import namespace="urn:dep" schemaLocation="${l}"/>`)
    .join("");
  return `<?xml version="1.0"?><xsd:schema xmlns:xsd="${XSD_NS}" targetNamespace="${ns}">${body}</xsd:schema>`;
}

function wsdlWith(types: string, extra = ""): string {
  return `<wsdl:definitions xmlns:wsdl="${WSDL_NS}" targetNamespace="urn:t">${extra}<wsdl:types>${types}</wsdl:types><wsdl:service name="S"/></wsdl:definitions>`;
}

type FetchOpts = { timeoutMs: number; maxBytes: number };

function fakeFetch(responses: Record<string, FetchResult | string>): {
  deps: SchemaFetchDeps;
  calls: string[];
  opts: FetchOpts[];
} {
  const calls: string[] = [];
  const opts: FetchOpts[] = [];
  const deps: SchemaFetchDeps = {
    fetch: (url, o) => {
      calls.push(url);
      opts.push(o);
      const r = responses[url];
      if (r === undefined) {
        return Promise.resolve({
          ok: false,
          error: { code: "WSDL_FETCH_FAILED", message: "nope" },
        });
      }
      return Promise.resolve(
        typeof r === "string" ? { ok: true, xml: r, finalUrl: url } : r,
      );
    },
  };
  return { deps, calls, opts };
}

describe("collectSchemaRefs (Stage 3)", () => {
  it("resolves relative and absolute refs in document order and de-duplicates", () => {
    const xml = wsdlWith(
      `<xsd:schema xmlns:xsd="${XSD_NS}"><xsd:import schemaLocation="a.xsd"/><xs:include xmlns:xs="${XSD_NS}" schemaLocation="../b.xsd"/><xsd:import schemaLocation="http://other.test/c.xsd"/><xsd:import schemaLocation="a.xsd"/><xsd:import namespace="urn:none"/></xsd:schema>`,
    );
    expect(collectSchemaRefs(xml, BASE)).toEqual([
      "http://host.test/dir/a.xsd",
      "http://host.test/b.xsd",
      "http://other.test/c.xsd",
    ]);
  });
});

describe("inlineSchemas (Stage 4)", () => {
  it("fetches with the required limits and splices the schema into types", async () => {
    const f = fakeFetch({ "http://host.test/a.xsd": schemaDoc("urn:a") });
    const r = await inlineSchemas(wsdlWith(""), ["http://host.test/a.xsd"], BASE, f.deps);
    expect(f.opts[0]).toEqual({ timeoutMs: 10000, maxBytes: 2_097_152 });
    expect(r.warnings).toEqual([]);
    expect(r.xml).toContain('targetNamespace="urn:a"');
    expect(r.xml.indexOf("urn:a")).toBeLessThan(r.xml.indexOf("</wsdl:types>"));
  });

  it("follows a nested import resolved against the importing schema", async () => {
    const f = fakeFetch({
      "http://host.test/x/a.xsd": schemaDoc("urn:a", ["../y/b.xsd"]),
      "http://host.test/y/b.xsd": schemaDoc("urn:b"),
    });
    const r = await inlineSchemas(wsdlWith(""), ["http://host.test/x/a.xsd"], BASE, f.deps);
    expect(f.calls).toEqual(["http://host.test/x/a.xsd", "http://host.test/y/b.xsd"]);
    expect(r.xml).toContain("urn:b");
  });

  it("terminates on a cycle, fetching each URL once", async () => {
    const f = fakeFetch({
      "http://host.test/a.xsd": schemaDoc("urn:a", ["b.xsd"]),
      "http://host.test/b.xsd": schemaDoc("urn:b", ["a.xsd"]),
    });
    await inlineSchemas(wsdlWith(""), ["http://host.test/a.xsd"], BASE, f.deps);
    expect(f.calls).toEqual(["http://host.test/a.xsd", "http://host.test/b.xsd"]);
  });

  it("fetches exactly 20 of 25 refs and warns once", async () => {
    const refs = Array.from({ length: 25 }, (_, i) => `http://host.test/s${i}.xsd`);
    const responses: Record<string, string> = {};
    for (const u of refs) responses[u] = schemaDoc(`urn:${u}`);
    const f = fakeFetch(responses);
    const r = await inlineSchemas(wsdlWith(""), refs, BASE, f.deps);
    expect(f.calls).toHaveLength(20);
    expect(r.warnings.filter((w) => w.code === "SCHEMA_LIMIT_REACHED")).toHaveLength(1);
  });

  it("warns on a failing fetch and continues", async () => {
    const f = fakeFetch({ "http://host.test/ok.xsd": schemaDoc("urn:ok") });
    const r = await inlineSchemas(
      wsdlWith(""),
      ["http://host.test/bad.xsd", "http://host.test/ok.xsd"],
      BASE,
      f.deps,
    );
    expect(r.warnings).toEqual([
      { code: "SCHEMA_FETCH_FAILED", message: "Could not fetch schema at http://host.test/bad.xsd." },
    ]);
    expect(r.xml).toContain("urn:ok");
  });

  it("maps WSDL_TOO_LARGE to SCHEMA_TOO_LARGE", async () => {
    const f = fakeFetch({
      "http://host.test/big.xsd": { ok: false, error: { code: "WSDL_TOO_LARGE", message: "big" } },
    });
    const r = await inlineSchemas(wsdlWith(""), ["http://host.test/big.xsd"], BASE, f.deps);
    expect(r.warnings.map((w) => w.code)).toEqual(["SCHEMA_TOO_LARGE"]);
  });

  it("never passes non-http refs to fetch", async () => {
    const f = fakeFetch({});
    const r = await inlineSchemas(
      wsdlWith(""),
      ["file:///etc/passwd", "../../.env", "ftp://host.test/a.xsd"],
      BASE,
      f.deps,
    );
    expect(f.calls).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual([
      "SCHEMA_FETCH_FAILED",
      "SCHEMA_FETCH_FAILED",
      "SCHEMA_FETCH_FAILED",
    ]);
  });

  it("skips a fetched schema containing a DOCTYPE", async () => {
    const f = fakeFetch({
      "http://host.test/evil.xsd": `<!DOCTYPE x [<!ENTITY e "boom">]>${schemaDoc("urn:evil")}`,
    });
    const r = await inlineSchemas(wsdlWith(""), ["http://host.test/evil.xsd"], BASE, f.deps);
    expect(r.warnings.map((w) => w.code)).toEqual(["SCHEMA_FETCH_FAILED"]);
    expect(r.xml).not.toContain("urn:evil");
  });

  it("strips every location attribute and warns on wsdl:import", async () => {
    const types = `<xsd:schema xmlns:xsd="${XSD_NS}"><xsd:import schemaLocation="ok.xsd"/><xsd:import schemaLocation="missing.xsd"/><xsd:include schemaLocation='file:///etc/passwd'/><xsd:import namespace="urn:n" schemaLocation="nested.xsd"/></xsd:schema>`;
    const xml = wsdlWith(types, `<wsdl:import namespace="urn:w" location="http://host.test/other.wsdl"/>`);
    const refs = collectSchemaRefs(xml, BASE);
    const f = fakeFetch({
      "http://host.test/dir/ok.xsd": schemaDoc("urn:ok", ["deep.xsd"]),
      "http://host.test/dir/nested.xsd": schemaDoc("urn:nested"),
    });
    const r = await inlineSchemas(xml, [...refs, "file:///etc/passwd"], BASE, f.deps);
    expect(f.calls).not.toContain("http://host.test/other.wsdl");
    expect(f.calls.some((c) => c.startsWith("file:"))).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain("WSDL_IMPORT_NOT_SUPPORTED");
    expect(r.warnings.map((w) => w.code)).toContain("SCHEMA_FETCH_FAILED");
    expect(r.xml).toContain("urn:ok");
    expect(r.xml).not.toContain("schemaLocation=");
    expect(r.xml).not.toMatch(/\blocation\s*=/);
  });

  it("strips locations from non-ASCII prefixed import tags but keeps soap:address", async () => {
    const xml = wsdlWith(
      `<xsd:schema xmlns:xsd="${XSD_NS}"><é:import namespace="urn:x" schemaLocation="http://host.test/a.xsd"/></xsd:schema>`,
      `<é:import location="http://host.test/o.wsdl"/><soap:address location="http://host.test/svc"/>`,
    );
    const refs = collectSchemaRefs(xml, BASE);
    expect(refs).toEqual(["http://host.test/a.xsd"]);
    const f = fakeFetch({ "http://host.test/a.xsd": schemaDoc("urn:a") });
    const r = await inlineSchemas(xml, refs, BASE, f.deps);
    expect(r.xml).not.toContain("schemaLocation=");
    expect(r.xml).toContain('<é:import namespace="urn:x"/>');
    expect(r.xml).toContain("<é:import/>");
    expect(r.xml).not.toContain('location="http://host.test/o.wsdl"');
    expect(r.xml).toContain('<soap:address location="http://host.test/svc"/>');
  });

  it("stops fetching when the 25 s total budget is spent", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const refs = Array.from({ length: 6 }, (_, i) => `http://host.test/t${i}.xsd`);
      const timeouts: number[] = [];
      const deps: SchemaFetchDeps = {
        fetch: (url, o) => {
          timeouts.push(o.timeoutMs);
          vi.setSystemTime(Date.now() + 9000);
          return Promise.resolve({ ok: true, xml: schemaDoc(`urn:${url}`), finalUrl: url });
        },
      };
      const r = await inlineSchemas(wsdlWith(""), refs, BASE, deps);
      expect(timeouts).toEqual([10000, 10000, 7000]);
      expect(r.warnings).toEqual([
        {
          code: "SCHEMA_TIME_BUDGET_EXCEEDED",
          message: "Schema fetching stopped: the time limit was reached.",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("splices into a self-closing <types/>", async () => {
    const xml = `<wsdl:definitions xmlns:wsdl="${WSDL_NS}" targetNamespace="urn:t"><wsdl:types/><wsdl:service name="S"/></wsdl:definitions>`;
    const f = fakeFetch({ "http://host.test/a.xsd": schemaDoc("urn:a") });
    const r = await inlineSchemas(xml, ["http://host.test/a.xsd"], BASE, f.deps);
    expect(r.xml).toContain('targetNamespace="urn:a"');
    expect(isError(inspectDocument(r.xml))).toBe(false);
  });

  it("adds a <types> element when the WSDL has none", async () => {
    const xml = `<wsdl:definitions xmlns:wsdl="${WSDL_NS}" targetNamespace="urn:t"><wsdl:service name="S"/></wsdl:definitions>`;
    const f = fakeFetch({ "http://host.test/a.xsd": schemaDoc("urn:a") });
    const r = await inlineSchemas(xml, ["http://host.test/a.xsd"], BASE, f.deps);
    expect(r.xml).toContain('targetNamespace="urn:a"');
    expect(isError(inspectDocument(r.xml))).toBe(false);
  });

  it("reports an unresolvable schemaLocation as SCHEMA_FETCH_FAILED without fetching", async () => {
    const xml = wsdlWith(`<xsd:schema xmlns:xsd="${XSD_NS}"><xsd:import schemaLocation="a.xsd"/><xsd:import schemaLocation="a.xsd"/></xsd:schema>`);
    const refs = collectSchemaRefs(xml, "");
    expect(refs).toEqual(["a.xsd"]);
    const f = fakeFetch({});
    const r = await inlineSchemas(xml, refs, "", f.deps);
    expect(f.calls).toEqual([]);
    expect(r.warnings.map((w) => w.code)).toEqual(["SCHEMA_FETCH_FAILED"]);
  });
});

// ─── Stage 5 part 1 ───────────────────────────────────────────────────────────

const S11 = "http://schemas.xmlsoap.org/wsdl/soap/";
const S12 = "http://schemas.xmlsoap.org/wsdl/soap12/";

function cleanWsdl(): string {
  return `<wsdl:definitions xmlns:wsdl="${WSDL_NS}" xmlns:xsd="${XSD_NS}" targetNamespace="urn:t"><wsdl:types><xsd:schema targetNamespace="urn:t"><xsd:import namespace="urn:x"/></xsd:schema></wsdl:types><wsdl:service name="S"/></wsdl:definitions>`;
}

describe("verifyNoLocations (Stage 5)", () => {
  it("passes on a clean document and on a fixture", () => {
    expect(verifyNoLocations(cleanWsdl())).toBeNull();
    expect(verifyNoLocations(readFileSync("fixtures/calculator.wsdl", "utf8"))).toBeNull();
  });

  it.each([
    ["xsd:", "xsd:import"],
    ["s:", "s:include"],
    ["é:", "é:import"],
    ["no prefix", "import"],
  ])("fails on a leftover schemaLocation with %s prefix", (_label, tag) => {
    const xml = `<wsdl:definitions xmlns:wsdl="${WSDL_NS}"><wsdl:types><schema><${tag} schemaLocation="http://host.test/a.xsd"/></schema></wsdl:types></wsdl:definitions>`;
    expect(verifyNoLocations(xml)?.code).toBe("WSDL_PARSE_FAILED");
  });

  it("fails on a leftover location on wsdl:import and on redefine", () => {
    expect(
      verifyNoLocations(`<d><wsdl:import location="http://host.test/o.wsdl"/></d>`)?.code,
    ).toBe("WSDL_PARSE_FAILED");
    expect(
      verifyNoLocations(`<d><xs:redefine schemaLocation="a.xsd"><x/></xs:redefine></d>`)?.code,
    ).toBe("WSDL_PARSE_FAILED");
  });

  it("ignores soap:address and other elements carrying location", () => {
    const xml = `<d><s><p><soap:address location="http://host.test/svc"/><other location="x" schemaLocation="y"/></p></s></d>`;
    expect(verifyNoLocations(xml)).toBeNull();
  });
});

function indexed(xml: string): WsdlIndex {
  const r = indexDocument(xml);
  if ("code" in r) throw new Error(r.message);
  return r;
}

function bindingXml(prefix: string, ns: string, style: string, ops: string[]): string {
  const body = ops
    .map(
      (o) =>
        `<wsdl:operation name="${o}"><${prefix}:operation soapAction="urn:${o}"/><wsdl:input><${prefix}:body use="literal"/></wsdl:input><wsdl:output><${prefix}:body use="literal"/></wsdl:output></wsdl:operation>`,
    )
    .join("");
  const ptOps = ops
    .map(
      (o) =>
        `<wsdl:operation name="${o}"><wsdl:input message="tns:AddIn"/><wsdl:output message="tns:AddOut"/></wsdl:operation>`,
    )
    .join("");
  return `<wsdl:definitions xmlns:wsdl="${WSDL_NS}" xmlns:${prefix}="${ns}" targetNamespace="urn:t"><wsdl:message name="AddIn"><wsdl:part name="parameters" element="tns:Add"/></wsdl:message><wsdl:portType name="PT">${ptOps}</wsdl:portType><wsdl:binding name="B" type="tns:PT"><${prefix}:binding transport="http://schemas.xmlsoap.org/soap/http" style="${style}"/>${body}</wsdl:binding><wsdl:service name="S"><wsdl:port name="P" binding="tns:B"><${prefix}:address location="http://host.test/svc"/></wsdl:port></wsdl:service></wsdl:definitions>`;
}

describe("indexDocument (Stage 5)", () => {
  it("indexes a single operation (object, not array, from the parser)", () => {
    const idx = indexed(bindingXml("soap", S11, "document", ["Add"]));
    expect(idx.messages.AddIn.parts[0]).toEqual({ name: "parameters", element: "Add", type: null });
    expect(idx.portTypes.PT.operations).toEqual([{ name: "Add", input: "AddIn", output: "AddOut" }]);
    expect(idx.bindings.B.operations).toEqual([
      { name: "Add", soapAction: "urn:Add", style: null, inputUse: "literal", outputUse: "literal" },
    ]);
    expect(idx.services.S.ports).toEqual([{ name: "P", binding: "B", address: "http://host.test/svc" }]);
  });

  it("indexes many operations", () => {
    const idx = indexed(bindingXml("soap", S11, "document", ["Add", "Sub", "Mul"]));
    expect(idx.portTypes.PT.operations.map((o) => o.name)).toEqual(["Add", "Sub", "Mul"]);
    expect(idx.bindings.B.operations.map((o) => o.name)).toEqual(["Add", "Sub", "Mul"]);
  });

  it("detects SOAP 1.1 and 1.2 from the namespace, not the prefix", () => {
    expect(indexed(bindingXml("soap", S11, "document", ["Add"])).bindings.B.soapVersion).toBe("1.1");
    expect(indexed(bindingXml("soap12", S12, "document", ["Add"])).bindings.B.soapVersion).toBe("1.2");
    expect(indexed(bindingXml("x", S12, "document", ["Add"])).bindings.B.soapVersion).toBe("1.2");
    expect(indexed(bindingXml("soap", S11, "document", ["Add"])).bindings.B.transport).toBe(
      "http://schemas.xmlsoap.org/soap/http",
    );
  });

  it("reads rpc vs document style", () => {
    expect(indexed(bindingXml("soap", S11, "rpc", ["Add"])).bindings.B.style).toBe("rpc");
    expect(indexed(bindingXml("soap", S11, "document", ["Add"])).bindings.B.style).toBe("document");
  });

  it("indexes the calculator fixture with both SOAP versions", () => {
    const calc = indexed(readFileSync("fixtures/calculator.wsdl", "utf8"));
    const versions = Object.values(calc.bindings).map((b) => b.soapVersion);
    expect(versions).toContain("1.1");
    expect(versions).toContain("1.2");
  });

  it("returns WSDL_PARSE_FAILED for a non-definitions root", () => {
    const r = indexDocument("<root/>");
    expect("code" in r && r.code).toBe("WSDL_PARSE_FAILED");
  });
});

// ─── Stage 5 part 2: buildDefinition and parseWsdl ───────────────────────────

type BindingSpec = {
  name: string;
  ns: string;
  transport?: string;
  style?: string;
  opStyle?: string;
  use?: string;
};

const HTTP_11 = "http://schemas.xmlsoap.org/soap/http";
const HTTP_12 = "http://www.w3.org/2003/05/soap/bindings/HTTP/";

function multiWsdl(specs: BindingSpec[], extraSchema = ""): string {
  const bindings = specs
    .map((s) => {
      const opAttrs = `soapAction="urn:Add"${s.opStyle ? ` style="${s.opStyle}"` : ""}`;
      const bAttrs = `transport="${s.transport ?? HTTP_11}"${s.style ? ` style="${s.style}"` : ""}`;
      const use = s.use ?? "literal";
      return `<wsdl:binding name="${s.name}" type="tns:PT"><x:binding ${bAttrs}/><wsdl:operation name="Add"><x:operation ${opAttrs}/><wsdl:input><x:body use="${use}"/></wsdl:input><wsdl:output><x:body use="${use}"/></wsdl:output></wsdl:operation></wsdl:binding>`
        .replace(/x:/g, `${s.name}:`)
        .replace("<wsdl:binding", `<wsdl:binding xmlns:${s.name}="${s.ns}"`);
    })
    .join("");
  const ports = specs
    .map(
      (s) =>
        `<wsdl:port name="P${s.name}" binding="tns:${s.name}"><${s.name}:address xmlns:${s.name}="${s.ns}" location="http://host.test/svc${s.name}"/></wsdl:port>`,
    )
    .join("");
  return `<wsdl:definitions xmlns:wsdl="${WSDL_NS}" xmlns:xsd="${XSD_NS}" targetNamespace="urn:t"><wsdl:types><xsd:schema targetNamespace="urn:t" elementFormDefault="qualified">${extraSchema}<xsd:element name="Add"/><xsd:element name="AddResponse"/></xsd:schema></wsdl:types><wsdl:message name="AddIn"><wsdl:part name="parameters" element="tns:Add"/></wsdl:message><wsdl:message name="AddOut"><wsdl:part name="parameters" element="tns:AddResponse"/></wsdl:message><wsdl:portType name="PT"><wsdl:operation name="Add"><wsdl:input message="tns:AddIn"/><wsdl:output message="tns:AddOut"/></wsdl:operation></wsdl:portType>${bindings}<wsdl:service name="S">${ports}</wsdl:service></wsdl:definitions>`;
}

async function parseOk(xml: string, deps?: Parameters<typeof parseWsdl>[1]) {
  const r = await parseWsdl(xml, deps);
  if (!r.ok) throw new Error(r.error.message);
  return r.definition;
}

describe("parseWsdl (Stage 5 part 2)", () => {
  it("dedupes SOAP 1.1 and 1.2 bindings into one operation", async () => {
    const def = await parseOk(
      multiWsdl([
        { name: "b12", ns: S12 },
        { name: "b11", ns: S11 },
      ]),
    );
    const ops = def.ports.flatMap((p) => p.operations);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      name: "Add",
      soapVersions: ["1.1", "1.2"],
      preferredVersion: "1.1",
      bindingStyle: "document/literal",
      soapAction: "urn:Add",
      targetNamespace: "urn:t",
      inputElementName: "Add",
      outputElementName: "AddResponse",
      endpointAddress: "http://host.test/svcb11",
      elementFormDefault: "qualified",
      inputDescriptor: [],
      outputDescriptor: [],
    });
    expect(def.warnings).toEqual([]);
  });

  it("handles a 1.1-only binding", async () => {
    const def = await parseOk(multiWsdl([{ name: "b11", ns: S11 }]));
    const op = def.ports[0].operations[0];
    expect(op.soapVersions).toEqual(["1.1"]);
    expect(op.preferredVersion).toBe("1.1");
  });

  it("handles a 1.2-only binding", async () => {
    const def = await parseOk(multiWsdl([{ name: "b12", ns: S12, transport: HTTP_12 }]));
    const op = def.ports[0].operations[0];
    expect(op.soapVersions).toEqual(["1.2"]);
    expect(op.preferredVersion).toBe("1.2");
  });

  it("skips an unsupported transport with a warning", async () => {
    const def = await parseOk(
      multiWsdl([
        { name: "b11", ns: S11 },
        { name: "bjms", ns: S12, transport: "http://example.org/jms" },
      ]),
    );
    expect(def.warnings).toEqual([
      {
        code: "UNSUPPORTED_BINDING",
        message: "Binding bjms uses an unsupported transport and was skipped.",
      },
    ]);
    expect(def.ports.flatMap((p) => p.operations)[0].soapVersions).toEqual(["1.1"]);
  });

  it("fails when every binding is unsupported", async () => {
    const r = await parseWsdl(multiWsdl([{ name: "bjms", ns: S11, transport: "urn:jms" }]));
    expect(r.ok).toBe(false);
  });

  it("warns on rpc/encoded and records the style", async () => {
    const def = await parseOk(multiWsdl([{ name: "b11", ns: S11, style: "rpc", use: "encoded" }]));
    const op = def.ports[0].operations[0];
    expect(op.bindingStyle).toBe("rpc/encoded");
    expect(op.warnings.map((w) => w.code)).toEqual(["RPC_ENCODED"]);
    expect(op.inputElementName).toBe("Add");
    expect(op.outputElementName).toBe("AddResponse");
  });

  it("classifies other styles and lets the operation style override the binding style", async () => {
    const rpc = await parseOk(multiWsdl([{ name: "b11", ns: S11, style: "rpc" }]));
    expect(rpc.ports[0].operations[0].bindingStyle).toBe("rpc/literal");
    const over = await parseOk(multiWsdl([{ name: "b11", ns: S11, style: "rpc", opStyle: "document" }]));
    expect(over.ports[0].operations[0].bindingStyle).toBe("document/literal");
    const enc = await parseOk(multiWsdl([{ name: "b11", ns: S11, style: "document", use: "encoded" }]));
    expect(enc.ports[0].operations[0].bindingStyle).toBe("document/encoded");
    expect(enc.ports[0].operations[0].warnings).toEqual([]);
    const unk = await parseOk(multiWsdl([{ name: "b11", ns: S11, style: "weird" }]));
    expect(unk.ports[0].operations[0].bindingStyle).toBe("unknown");
  });

  it("parses the calculator fixture with zero warnings", async () => {
    const def = await parseOk(readFileSync("fixtures/calculator.wsdl", "utf8"));
    expect(def.name).toBe("Calculator");
    const ops = def.ports.flatMap((p) => p.operations);
    expect(ops.map((o) => o.name).sort()).toEqual(["Add", "Divide", "Multiply", "Subtract"]);
    expect(ops.every((o) => o.soapVersions.length === 2 && o.warnings.length === 0)).toBe(true);
    expect(def.warnings).toEqual([]);
  });

  it("fills calculator Add descriptors in order", async () => {
    const def = await parseOk(readFileSync("fixtures/calculator.wsdl", "utf8"));
    const add = def.ports.flatMap((p) => p.operations).find((o) => o.name === "Add");
    expect(add?.inputDescriptor.map((f) => [f.name, f.xsdType])).toEqual([
      ["intA", "int"],
      ["intB", "int"],
    ]);
    expect(add?.outputDescriptor.map((f) => [f.name, f.xsdType])).toEqual([["AddResult", "int"]]);
  });

  it("fills non-empty descriptors for countryinfo", async () => {
    const def = await parseOk(readFileSync("fixtures/countryinfo.wsdl", "utf8"));
    const ops = def.ports.flatMap((p) => p.operations);
    expect(ops.some((o) => o.inputDescriptor.length > 0 && o.outputDescriptor.length > 0)).toBe(true);
  });

  it("uses the rpc/encoded warning text", async () => {
    const def = await parseOk(multiWsdl([{ name: "b11", ns: S11, style: "rpc", use: "encoded" }]));
    expect(def.ports[0].operations[0].warnings[0].message).toBe(
      "Operation Add uses rpc/encoded, which is not supported for live calls.",
    );
  });

  it("parses the countryinfo fixture with zero warnings", async () => {
    const def = await parseOk(readFileSync("fixtures/countryinfo.wsdl", "utf8"));
    const ops = def.ports.flatMap((p) => p.operations);
    expect(ops.map((o) => o.name)).toContain("CapitalCity");
    expect(ops.every((o) => o.warnings.length === 0)).toBe(true);
    expect(def.warnings).toEqual([]);
  });

  it("never touches the network for an import to 127.0.0.1 and still returns a definition", async () => {
    const f = fakeFetch({});
    const xml = multiWsdl(
      [{ name: "b11", ns: S11 }],
      `<xsd:import namespace="urn:evil" schemaLocation="http://127.0.0.1/evil.xsd"/>`,
    );
    const def = await parseOk(xml, { fetch: f.deps.fetch });
    expect(f.calls).toEqual(["http://127.0.0.1/evil.xsd"]);
    expect(def.warnings.map((w) => w.code)).toEqual(["SCHEMA_FETCH_FAILED"]);
    expect(def.ports[0].operations).toHaveLength(1);
    expect(httpSpy).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
  });

  it("returns WSDL_PARSE_FAILED when a location survives inlining", async () => {
    // No whitespace between attributes: the strip regexes miss it, the tree verifier must not.
    const xml = multiWsdl(
      [{ name: "b11", ns: S11 }],
      `<xsd:import namespace="urn:x"schemaLocation="http://host.test/a.xsd"/>`,
    );
    const r = await parseWsdl(xml, { fetch: fakeFetch({}).deps.fetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("WSDL_PARSE_FAILED");
  });

  it("returns earlier-stage errors unchanged", async () => {
    const r = await parseWsdl("<!DOCTYPE x><a/>");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("WSDL_PARSE_FAILED");
  });
});

describe("operation documentation and risk (task 15.1)", () => {
  function docWsdl(ptDoc: string, bindingDoc: string): string {
    return `<?xml version="1.0"?>
<w:definitions xmlns:w="http://schemas.xmlsoap.org/wsdl/" xmlns:s="http://www.w3.org/2001/XMLSchema"
  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:t="urn:t" targetNamespace="urn:t">
  <w:types><s:schema targetNamespace="urn:t" elementFormDefault="qualified">
    <s:element name="Ping"><s:complexType><s:sequence/></s:complexType></s:element>
    <s:element name="PingResponse"><s:complexType><s:sequence/></s:complexType></s:element>
  </s:schema></w:types>
  <w:message name="PingIn"><w:part name="p" element="t:Ping"/></w:message>
  <w:message name="PingOut"><w:part name="p" element="t:PingResponse"/></w:message>
  <w:portType name="PT"><w:operation name="DeleteThing">${ptDoc}
    <w:input message="t:PingIn"/><w:output message="t:PingOut"/></w:operation></w:portType>
  <w:binding name="B" type="t:PT"><soap:binding transport="http://schemas.xmlsoap.org/soap/http" style="document"/>
    <w:operation name="DeleteThing">${bindingDoc}<soap:operation soapAction="urn:x"/>
      <w:input><soap:body use="literal"/></w:input><w:output><soap:body use="literal"/></w:output></w:operation></w:binding>
  <w:service name="S"><w:port name="P" binding="t:B"><soap:address location="http://h.test/s"/></w:port></w:service>
</w:definitions>`;
  }

  async function firstOp(xml: string) {
    const r = await parseWsdl(xml);
    if (!r.ok) throw new Error(r.error.message);
    return r.definition.ports[0].operations[0];
  }

  it("captures portType documentation, strips tags and whitespace", async () => {
    const op = await firstOp(
      docWsdl("<w:documentation>  <b>Removes\n   the   thing.</b>  </w:documentation>", ""),
    );
    expect(op.documentation).toBe("Removes the thing.");
    expect(op.riskSource).toBe("heuristic");
    expect(op.risk).toBe("destructive");
    expect(op.riskReason.length).toBeLessThanOrEqual(120);
  });

  it("falls back to binding operation documentation", async () => {
    const op = await firstOp(docWsdl("", "<w:documentation>From binding</w:documentation>"));
    expect(op.documentation).toBe("From binding");
  });

  it("truncates to 500 characters and leaves undefined when absent", async () => {
    const long = await firstOp(docWsdl(`<w:documentation>${"x".repeat(900)}</w:documentation>`, ""));
    expect(long.documentation).toHaveLength(500);
    const none = await firstOp(docWsdl("", ""));
    expect(none.documentation).toBeUndefined();
  });
});
