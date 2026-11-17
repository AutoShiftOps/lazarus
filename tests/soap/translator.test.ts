import { describe, expect, it } from "vitest";
import { XMLValidator, XMLParser } from "fast-xml-parser";
import { readFileSync } from "node:fs";
import { parseWsdl } from "../../lib/soap/parser";
import { fromEnvelope, normaliseFault, toEnvelope, xmlEscape } from "../../lib/soap/translator";
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
    risk: "write",
    riskReason: "test",
    riskSource: "heuristic",
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

// ─── fromEnvelope / normaliseFault ────────────────────────────────────────────

const NS11 = "http://schemas.xmlsoap.org/soap/envelope/";
const NS12 = "http://www.w3.org/2003/05/soap-envelope";
const XSI = "http://www.w3.org/2001/XMLSchema-instance";

function env11(body: string, extraNs = ""): string {
  return `<soap:Envelope xmlns:soap="${NS11}"${extraNs}><soap:Body>${body}</soap:Body></soap:Envelope>`;
}

const outSchema = (fields: FieldDescriptor[]): OperationSchema =>
  op([], { outputDescriptor: fields });

function okData(r: ReturnType<typeof fromEnvelope>): Record<string, unknown> {
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r.error)}`);
  return r.data;
}

describe("normaliseFault", () => {
  it("normalises a SOAP 1.1 fault", () => {
    const r = fromEnvelope(
      env11(
        "<soap:Fault><faultcode>soap:Server</faultcode><faultstring>Boom</faultstring>" +
          "<detail><e>Bad  thing</e><f>here</f></detail></soap:Fault>",
      ),
      outSchema([]),
    );
    expect(r).toEqual({
      ok: false,
      error: { type: "fault", faultCode: "soap:Server", faultString: "Boom", detail: "Bad  thing here" },
    });
  });

  it("normalises a SOAP 1.2 fault, including a Text with xml:lang", () => {
    const xml =
      `<env:Envelope xmlns:env="${NS12}"><env:Body><env:Fault>` +
      "<env:Code><env:Value>env:Receiver</env:Value></env:Code>" +
      '<env:Reason><env:Text xml:lang="en">Broken</env:Text><env:Text xml:lang="fr">Casse</env:Text></env:Reason>' +
      "<env:Detail>why</env:Detail></env:Fault></env:Body></env:Envelope>";
    expect(fromEnvelope(xml, outSchema([]))).toEqual({
      ok: false,
      error: { type: "fault", faultCode: "env:Receiver", faultString: "Broken", detail: "why" },
    });
  });

  it("uses 'unknown' for missing parts and omits empty detail", () => {
    expect(normaliseFault({}, "1.1")).toEqual({ type: "fault", faultCode: "unknown", faultString: "unknown" });
    expect(normaliseFault({}, "1.2")).toEqual({ type: "fault", faultCode: "unknown", faultString: "unknown" });
  });

  it("caps detail at 1000 characters", () => {
    const f = normaliseFault({ detail: "x".repeat(5000) }, "1.1");
    expect(f.detail).toHaveLength(1000);
  });

  it("fault wins over a normal-looking body", () => {
    const xml = env11(
      "<AddResponse><AddResult>5</AddResult></AddResponse><soap:Fault><faultcode>c</faultcode><faultstring>s</faultstring></soap:Fault>",
    );
    const r = fromEnvelope(xml, outSchema([field("AddResult", { xsdType: "int" })]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.type).toBe("fault");
  });
});

describe("fromEnvelope values", () => {
  const body = (inner: string) => env11(`<R xmlns="urn:x">${inner}</R>`, ` xmlns:xsi="${XSI}"`);

  it("maps xsi:nil to null (any prefix, true or 1) and omits absent elements", () => {
    const schema = outSchema([field("a"), field("b"), field("c"), field("d", { minOccurs: 0 })]);
    const xml = env11(
      `<R><a xmlns:q="${XSI}" q:nil="1"/><b xsi:nil="true"/><c>x</c></R>`,
      ` xmlns:xsi="${XSI}"`,
    );
    const data = okData(fromEnvelope(xml, schema));
    expect(data).toEqual({ a: null, b: null, c: "x" });
    expect("d" in data).toBe(false);
  });

  it("normalises one and many repeated items to arrays", () => {
    const schema = outSchema([field("n", { xsdType: "int", maxOccurs: "unbounded" })]);
    expect(okData(fromEnvelope(body("<n>1</n>"), schema))).toEqual({ n: [1] });
    expect(okData(fromEnvelope(body("<n>1</n><n>2</n><n>3</n>"), schema))).toEqual({ n: [1, 2, 3] });
    const bounded = outSchema([field("n", { maxOccurs: 5 })]);
    expect(okData(fromEnvelope(body("<n>a</n>"), bounded))).toEqual({ n: ["a"] });
  });

  it("converts integers, numbers and booleans", () => {
    const schema = outSchema([
      field("i", { xsdType: "int" }),
      field("d", { xsdType: "double" }),
      field("t", { xsdType: "boolean" }),
      field("f", { xsdType: "boolean" }),
      field("one", { xsdType: "boolean" }),
      field("zero", { xsdType: "boolean" }),
    ]);
    const r = fromEnvelope(
      body("<i>-42</i><d>3.5e2</d><t>true</t><f>false</f><one>1</one><zero>0</zero>"),
      schema,
    );
    expect(r).toEqual({
      ok: true,
      data: { i: -42, d: 350, t: true, f: false, one: true, zero: false },
      warnings: [],
    });
  });

  it("omits unconvertible numbers and booleans and adds warnings", () => {
    const schema = outSchema([
      field("i", { xsdType: "int" }),
      field("j", { xsdType: "int" }),
      field("d", { xsdType: "decimal" }),
      field("b", { xsdType: "boolean" }),
    ]);
    const r = fromEnvelope(body("<i>abc</i><j>1.5</j><d></d><b>maybe</b>"), schema);
    expect(r.ok && r.data).toEqual({});
    expect(r.ok && r.warnings).toHaveLength(4);
  });

  it("recurses into children and turns empty complex elements into {}", () => {
    const schema = outSchema([
      field("p", {
        xsdType: "Person",
        children: [field("name"), field("age", { xsdType: "int" })],
      }),
      field("e", { xsdType: "Empty", children: [field("x", { minOccurs: 0 })] }),
    ]);
    const r = fromEnvelope(body("<p><name>Ann</name><age>7</age></p><e/>"), schema);
    expect(okData(r)).toEqual({ p: { name: "Ann", age: 7 }, e: {} });
  });

  it("preserves whitespace inside strings", () => {
    const schema = outSchema([field("s")]);
    expect(okData(fromEnvelope(body("<s> a  b </s>"), schema))).toEqual({ s: " a  b " });
  });

  it("warns on missing required elements, ignores extras, caps warnings at 10", () => {
    const schema = outSchema([field("AddResult")]);
    const r = fromEnvelope(body("<Other>1</Other>"), schema);
    expect(r).toEqual({ ok: true, data: {}, warnings: ["Missing required element AddResult"] });

    const many = outSchema(Array.from({ length: 15 }, (_, i) => field(`f${i}`)));
    const r2 = fromEnvelope(body(""), many);
    expect(r2.ok && r2.warnings).toHaveLength(10);
  });

  it("returns {} for an empty output descriptor", () => {
    expect(fromEnvelope(body("<a>1</a>"), outSchema([]))).toEqual({ ok: true, data: {}, warnings: [] });
  });
});

describe("fromEnvelope XML handling", () => {
  const schema = outSchema([field("v")]);

  it.each([
    ["soap", `<soap:Envelope xmlns:soap="${NS11}"><soap:Body><R><v>1</v></R></soap:Body></soap:Envelope>`],
    ["env", `<env:Envelope xmlns:env="${NS12}"><env:Body><R><v>1</v></R></env:Body></env:Envelope>`],
    ["s", `<s:Envelope xmlns:s="${NS11}"><s:Body><R><v>1</v></R></s:Body></s:Envelope>`],
    ["SOAP-ENV", `<SOAP-ENV:Envelope xmlns:SOAP-ENV="${NS11}"><SOAP-ENV:Body><R><v>1</v></R></SOAP-ENV:Body></SOAP-ENV:Envelope>`],
    ["default xmlns", `<Envelope xmlns="${NS12}"><Body><R xmlns="urn:x"><v>1</v></R></Body></Envelope>`],
  ])("parses with %s prefix", (_name, xml) => {
    expect(okData(fromEnvelope(xml, schema))).toEqual({ v: "1" });
  });

  it("decodes the five predefined entities and numeric references", () => {
    const xml = env11("<R><v>&lt;&gt;&amp;&quot;&apos;&#65;</v></R>");
    expect(okData(fromEnvelope(xml, schema))).toEqual({ v: `<>&"'A` });
  });

  it("rejects a DOCTYPE with an entity as parseError", () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY x "boom">]>' +
      env11("<R><v>&x;</v></R>");
    const r = fromEnvelope(xml, schema);
    expect(r).toMatchObject({ ok: false, error: { type: "parseError" } });
    expect(JSON.stringify(r)).not.toContain("boom");
  });

  it("returns parseError for malformed XML without echoing it", () => {
    const r = fromEnvelope("<soap:Envelope><SECRET>", schema);
    expect(r).toMatchObject({ ok: false, error: { type: "parseError" } });
    if (!r.ok && r.error.type === "parseError") {
      expect(r.error.message.length).toBeLessThanOrEqual(200);
      expect(r.error.message).not.toContain("SECRET");
    }
  });

  it("returns parseError for an empty body, no Body, no wrapper, unknown root and unknown namespace", () => {
    const cases = [
      "",
      `<soap:Envelope xmlns:soap="${NS11}"><soap:Header/></soap:Envelope>`,
      `<soap:Envelope xmlns:soap="${NS11}"><soap:Body/></soap:Envelope>`,
      "<html><body/></html>",
      '<soap:Envelope xmlns:soap="urn:other"><soap:Body><R/></soap:Body></soap:Envelope>',
    ];
    for (const xml of cases) {
      expect(fromEnvelope(xml, schema)).toMatchObject({ ok: false, error: { type: "parseError" } });
    }
  });

  it("parses the calculator AddResponse fixture schema to { AddResult: 5 }", async () => {
    const parsed = await parseWsdl(readFileSync("fixtures/calculator.wsdl", "utf8"));
    if (!parsed.ok) throw new Error("fixture failed to parse");
    const add = parsed.definition.ports.flatMap((p) => p.operations).find((o) => o.name === "Add");
    if (add === undefined) throw new Error("Add not found");
    const xml = env11('<AddResponse xmlns="http://tempuri.org/"><AddResult>5</AddResult></AddResponse>');
    expect(fromEnvelope(xml, add)).toEqual({ ok: true, data: { AddResult: 5 }, warnings: [] });
  });
});
