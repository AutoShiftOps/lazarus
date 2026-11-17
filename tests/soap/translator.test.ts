import { describe, expect, it } from "vitest";
import { XMLValidator, XMLParser } from "fast-xml-parser";
import { toEnvelope, xmlEscape } from "../../lib/soap/translator";
import type { FieldDescriptor, OperationSchema } from "../../lib/soap/types";

function field(name: string, extra: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return { name, xsdType: "string", minOccurs: 1, maxOccurs: 1, nillable: false, ...extra };
}

function op(inputDescriptor: FieldDescriptor[], extra: Partial<OperationSchema> = {}): OperationSchema {
  return {
    name: "Op",
    soapVersions: ["1.1"],
    preferredVersion: "1.1",
    bindingStyle: "document/literal",
    soapAction: "http://tempuri.org/Op",
    targetNamespace: "http://tempuri.org/",
    inputElementName: "Op",
    outputElementName: "OpResponse",
    endpointAddress: "http://example.com/svc",
    elementFormDefault: "qualified",
    inputDescriptor,
    outputDescriptor: [],
    warnings: [],
    ...extra,
  };
}

const intField = (name: string): FieldDescriptor => field(name, { xsdType: "int" });

const add = op([intField("intA"), intField("intB")], {
  name: "Add",
  inputElementName: "Add",
  soapAction: "http://tempuri.org/Add",
});

function xmlOf(result: ReturnType<typeof toEnvelope>): string {
  if (!result.ok) throw new Error("expected ok");
  return result.xml;
}

describe("xmlEscape", () => {
  it("escapes all five characters, ampersand first", () => {
    expect(xmlEscape(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&apos;");
  });
});

describe("toEnvelope", () => {
  it("builds the exact SOAP 1.1 envelope for calculator Add", () => {
    const r = toEnvelope({ intA: 2, intB: 3 }, add);
    expect(r).toEqual({
      ok: true,
      xml:
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
        '<soap:Body><Add xmlns="http://tempuri.org/"><intA>2</intA><intB>3</intB></Add></soap:Body>' +
        "</soap:Envelope>",
      headers: {
        "Content-Type": "text/xml; charset=utf-8",
        SOAPAction: '"http://tempuri.org/Add"',
      },
    });
  });

  it("builds the exact SOAP 1.2 envelope for calculator Add", () => {
    const r = toEnvelope({ intA: 2, intB: 3 }, { ...add, preferredVersion: "1.2", soapVersions: ["1.2"] });
    expect(r).toEqual({
      ok: true,
      xml:
        '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">' +
        '<soap:Body><Add xmlns="http://tempuri.org/"><intA>2</intA><intB>3</intB></Add></soap:Body>' +
        "</soap:Envelope>",
      headers: {
        "Content-Type": 'application/soap+xml; charset=utf-8; action="http://tempuri.org/Add"',
      },
    });
  });

  it("strips CR/LF and quotes from the SOAP action header", () => {
    const r = toEnvelope({ intA: 1, intB: 2 }, { ...add, soapAction: 'a"b\r\nc' });
    expect(r.ok && r.headers.SOAPAction).toBe('"abc"');
  });

  it("follows descriptor order even when args keys are reversed", () => {
    const xml = xmlOf(toEnvelope({ intB: 3, intA: 2 }, add));
    expect(xml.indexOf("<intA>")).toBeLessThan(xml.indexOf("<intB>"));
  });

  it("returns a validationError listing missing fields without xml", () => {
    const r = toEnvelope({ intA: 2 }, add);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.type).toBe("validationError");
    if (r.error.type !== "validationError") return;
    expect(r.error.missingFields).toEqual(["intB"]);
    expect(r.error.issues.length).toBeGreaterThan(0);
    expect(r).not.toHaveProperty("xml");
  });

  it("escapes markup injection and keeps the XML well-formed", () => {
    const schema = op([field("a")]);
    const xml = xmlOf(toEnvelope({ a: `</a><evil/>&"'` }, schema));
    expect(xml).toContain("&lt;/a&gt;&lt;evil/&gt;&amp;&quot;&apos;");
    expect(XMLValidator.validate(xml)).toBe(true);
    const tree = new XMLParser().parse(xml);
    expect(JSON.stringify(tree)).not.toContain("evil\":");
    expect(tree["soap:Envelope"]["soap:Body"].Op).not.toHaveProperty("evil");
  });

  it("rejects hostile element names from the descriptor", () => {
    const r = toEnvelope({ "a><evil/><b": "x" }, op([field("a><evil/><b")]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe("validationError");
    const r2 = toEnvelope({}, op([field("a")], { inputElementName: "Op><evil/" }));
    expect(r2.ok).toBe(false);
  });

  it("rejects illegal XML control characters, naming the field", () => {
    const r = toEnvelope({ a: "bad\u0001value" }, op([field("a")]));
    expect(r.ok).toBe(false);
    if (r.ok || r.error.type !== "validationError") throw new Error("expected validationError");
    expect(r.error.issues[0].path).toBe("a");
  });

  it("maps null to xsi:nil and declares xsi on the Envelope", () => {
    const xml = xmlOf(toEnvelope({ a: null }, op([field("a", { nillable: true })])));
    expect(xml).toContain('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">');
    expect(xml).toContain('<a xsi:nil="true"/>');
    expect(XMLValidator.validate(xml)).toBe(true);
  });

  it("repeats array elements, writes nested children, skips optional", () => {
    const schema = op([
      field("tag", { maxOccurs: "unbounded" }),
      field("person", { children: [field("name"), intField("age")] }),
      field("opt", { minOccurs: 0 }),
    ]);
    const xml = xmlOf(
      toEnvelope({ tag: ["x", "y"], person: { age: 4, name: "Ann" } }, schema),
    );
    expect(xml).toContain(
      '<Op xmlns="http://tempuri.org/"><tag>x</tag><tag>y</tag><person><name>Ann</name><age>4</age></person></Op>',
    );
  });

  it("writes booleans as true/false", () => {
    const xml = xmlOf(toEnvelope({ f: false }, op([field("f", { xsdType: "boolean" })])));
    expect(xml).toContain("<f>false</f>");
  });

  it("puts xmlns=\"\" on every child at every depth when unqualified", () => {
    const schema = op([field("p", { children: [field("q")] })], { elementFormDefault: "unqualified" });
    const xml = xmlOf(toEnvelope({ p: { q: "v" } }, schema));
    expect(xml).toContain(
      '<Op xmlns="http://tempuri.org/"><p xmlns=""><q xmlns="">v</q></p></Op>',
    );
  });

  it("uses the operation name as wrapper with unqualified parts for rpc/literal", () => {
    const schema = op([field("a")], {
      bindingStyle: "rpc/literal",
      name: "DoIt",
      inputElementName: "ignored",
    });
    const xml = xmlOf(toEnvelope({ a: "v" }, schema));
    expect(xml).toContain('<DoIt xmlns="http://tempuri.org/"><a xmlns="">v</a></DoIt>');
  });

  it("treats unknown binding style as document/literal", () => {
    const xml = xmlOf(toEnvelope({ a: "v" }, op([field("a")], { bindingStyle: "unknown" })));
    expect(xml).toContain('<Op xmlns="http://tempuri.org/"><a>v</a></Op>');
  });

  it("returns unsupported for encoded styles", () => {
    const a = toEnvelope({}, op([], { bindingStyle: "rpc/encoded" }));
    expect(a).toEqual({
      ok: false,
      error: { type: "unsupported", message: "rpc/encoded is not supported for live calls." },
    });
    const b = toEnvelope({}, op([], { bindingStyle: "document/encoded" }));
    expect(b).toEqual({
      ok: false,
      error: { type: "unsupported", message: "document/encoded is not supported for live calls." },
    });
  });
});
