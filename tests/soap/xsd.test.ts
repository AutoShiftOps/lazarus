import { XMLParser } from "fast-xml-parser";
import { describe, expect, it } from "vitest";
import { buildDescriptors } from "../../lib/soap/xsd";
import type { DescriptorContext } from "../../lib/soap/xsd";
import type { FieldDescriptor } from "../../lib/soap/types";

const DOC: DescriptorContext = { style: "document", parts: [] };

function rootOf(schemaBody: string): Record<string, unknown> {
  const xml = `<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:tns="urn:t" targetNamespace="urn:t"><wsdl:types><xsd:schema targetNamespace="urn:t">${schemaBody}</xsd:schema></wsdl:types></wsdl:definitions>`;
  const tree = new XMLParser({ processEntities: false, ignoreAttributes: false }).parse(xml) as Record<
    string,
    Record<string, unknown>
  >;
  return tree["wsdl:definitions"];
}

function run(schemaBody: string, el: string | null = "tns:Op", ctx: DescriptorContext = DOC) {
  return buildDescriptors(rootOf(schemaBody), el, ctx);
}

function names(fields: FieldDescriptor[]): string[] {
  return fields.map((f) => f.name);
}

function maxDepth(fields: FieldDescriptor[]): number {
  return fields.reduce((m, f) => Math.max(m, 1 + maxDepth(f.children ?? [])), 0);
}

describe("buildDescriptors", () => {
  it("keeps xsd:sequence order for an inline complexType", () => {
    const r = run(
      `<xsd:element name="Op"><xsd:complexType><xsd:sequence>
        <xsd:element name="zeta" type="xsd:string"/><xsd:element name="alpha" type="xsd:int"/><xsd:element name="mid" type="xsd:boolean"/>
      </xsd:sequence></xsd:complexType></xsd:element>`,
    );
    expect(names(r.fields)).toEqual(["zeta", "alpha", "mid"]);
    expect(r.fields.map((f) => f.xsdType)).toEqual(["string", "int", "boolean"]);
    expect(r.warnings).toEqual([]);
  });

  it("parses minOccurs, maxOccurs and nillable with defaults", () => {
    const r = run(
      `<xsd:element name="Op"><xsd:complexType><xsd:sequence>
        <xsd:element name="a" type="xsd:string"/>
        <xsd:element name="b" type="xsd:string" minOccurs="0" maxOccurs="unbounded" nillable="true"/>
        <xsd:element name="c" type="xsd:string" minOccurs="2" maxOccurs="5"/>
      </xsd:sequence></xsd:complexType></xsd:element>`,
    );
    expect(r.fields[0]).toEqual({ name: "a", xsdType: "string", minOccurs: 1, maxOccurs: 1, nillable: false });
    expect(r.fields[1]).toMatchObject({ minOccurs: 0, maxOccurs: "unbounded", nillable: true });
    expect(r.fields[2]).toMatchObject({ minOccurs: 2, maxOccurs: 5, nillable: false });
  });

  it("resolves a named complexType", () => {
    const r = run(
      `<xsd:complexType name="Person"><xsd:sequence><xsd:element name="first" type="xsd:string"/><xsd:element name="age" type="xsd:int"/></xsd:sequence></xsd:complexType>
       <xsd:element name="Op"><xsd:complexType><xsd:sequence><xsd:element name="who" type="tns:Person"/></xsd:sequence></xsd:complexType></xsd:element>`,
    );
    expect(r.fields).toHaveLength(1);
    expect(r.fields[0].xsdType).toBe("Person");
    expect(names(r.fields[0].children ?? [])).toEqual(["first", "age"]);
  });

  it("resolves an element ref to a global element", () => {
    const r = run(
      `<xsd:element name="Bar" type="xsd:date"/>
       <xsd:element name="Op"><xsd:complexType><xsd:sequence><xsd:element ref="tns:Bar" minOccurs="0"/></xsd:sequence></xsd:complexType></xsd:element>`,
    );
    expect(r.fields).toEqual([{ name: "Bar", xsdType: "date", minOccurs: 0, maxOccurs: 1, nillable: false }]);
  });

  it("puts base fields before extension fields", () => {
    const r = run(
      `<xsd:complexType name="Base"><xsd:sequence><xsd:element name="id" type="xsd:long"/></xsd:sequence></xsd:complexType>
       <xsd:complexType name="Derived"><xsd:complexContent><xsd:extension base="tns:Base"><xsd:sequence><xsd:element name="extra" type="xsd:string"/></xsd:sequence></xsd:extension></xsd:complexContent></xsd:complexType>
       <xsd:element name="Op" type="tns:Derived"/>`,
    );
    expect(names(r.fields)).toEqual(["id", "extra"]);
  });

  it("makes xsd:choice members optional and treats xsd:all like a sequence", () => {
    const r = run(
      `<xsd:element name="Op"><xsd:complexType><xsd:choice>
        <xsd:element name="x" type="xsd:string"/><xsd:element name="y" type="xsd:string"/>
      </xsd:choice></xsd:complexType></xsd:element>
      <xsd:element name="All"><xsd:complexType><xsd:all><xsd:element name="p" type="xsd:string"/></xsd:all></xsd:complexType></xsd:element>`,
    );
    expect(r.fields.map((f) => f.minOccurs)).toEqual([0, 0]);
    const all = run(
      `<xsd:element name="Op"><xsd:complexType><xsd:all><xsd:element name="p" type="xsd:string"/></xsd:all></xsd:complexType></xsd:element>`,
    );
    expect(all.fields[0]).toMatchObject({ name: "p", minOccurs: 1 });
  });

  it("uses the base type of a restricted simpleType", () => {
    const r = run(
      `<xsd:simpleType name="Code"><xsd:restriction base="xsd:string"><xsd:maxLength value="3"/></xsd:restriction></xsd:simpleType>
       <xsd:element name="Op"><xsd:complexType><xsd:sequence><xsd:element name="code" type="tns:Code"/></xsd:sequence></xsd:complexType></xsd:element>`,
    );
    expect(r.fields[0].xsdType).toBe("string");
    expect(r.fields[0].children).toBeUndefined();
  });

  it("terminates on a recursive type and emits XSD_CYCLE", () => {
    const r = run(
      `<xsd:complexType name="Node"><xsd:sequence><xsd:element name="value" type="xsd:string"/><xsd:element name="next" type="tns:Node" minOccurs="0"/></xsd:sequence></xsd:complexType>
       <xsd:element name="Op" type="tns:Node"/>`,
    );
    expect(r.warnings.map((w) => w.code)).toContain("XSD_CYCLE");
    const next = r.fields[1];
    expect(next.name).toBe("next");
    expect(next.children).toBeUndefined();
  });

  it("stops at depth 8 and emits XSD_DEPTH_LIMIT", () => {
    let body = "";
    for (let i = 1; i <= 10; i++) {
      const inner =
        i < 10
          ? `<xsd:element name="n${i + 1}" type="tns:T${i + 1}"/>`
          : `<xsd:element name="leaf" type="xsd:string"/>`;
      body += `<xsd:complexType name="T${i}"><xsd:sequence>${inner}</xsd:sequence></xsd:complexType>`;
    }
    body += `<xsd:element name="Op" type="tns:T1"/>`;
    const r = run(body);
    expect(r.warnings.map((w) => w.code)).toContain("XSD_DEPTH_LIMIT");
    expect(maxDepth(r.fields)).toBeLessThanOrEqual(8);
  });

  it("marks an unresolvable type as unknown with a short warning", () => {
    const r = run(
      `<xsd:element name="Op"><xsd:complexType><xsd:sequence><xsd:element name="m" type="tns:Missing"/></xsd:sequence></xsd:complexType></xsd:element>`,
    );
    expect(r.fields[0].xsdType).toBe("unknown");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0].code).toBe("XSD_TYPE_UNRESOLVED");
    expect(r.warnings[0].message.length).toBeLessThanOrEqual(200);
  });

  it("builds one field per part for rpc style", () => {
    const r = run(
      `<xsd:complexType name="Pt"><xsd:sequence><xsd:element name="x" type="xsd:int"/></xsd:sequence></xsd:complexType>`,
      null,
      {
        style: "rpc",
        parts: [
          { name: "count", element: null, type: "int" },
          { name: "point", element: null, type: "Pt" },
        ],
      },
    );
    expect(names(r.fields)).toEqual(["count", "point"]);
    expect(r.fields[0].xsdType).toBe("int");
    expect(names(r.fields[1].children ?? [])).toEqual(["x"]);
    expect(r.warnings).toEqual([]);
  });
});
