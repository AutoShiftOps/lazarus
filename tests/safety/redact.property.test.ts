import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SENSITIVE, redactJson, redactXml } from "../../lib/safety/redact";

const alnum = fc.stringMatching(/^[A-Za-z0-9]{6,16}$/);

const sensitiveBase = [
  "password", "Password", "PASSWORD", "pass", "passwd", "secret", "ClientSecret", "token", "AccessToken",
  "api_key", "apiKey", "API-KEY", "apikey", "Authorization", "credential", "Credentials", "ssn", "SSN",
];
const sensitivePrefix = ["", "x_", "my", "user.", "X-"];
const sensitiveSuffix = ["", "_v2", "Value", "-hash", "1"];
const plainBase = ["name", "amount", "id", "note", "city", "status", "items"];

const sensitiveName = fc
  .tuple(
    fc.constantFrom(...sensitivePrefix),
    fc.constantFrom(...sensitiveBase),
    fc.constantFrom(...sensitiveSuffix),
  )
  .map(([p, b, s]) => `${p}${b}${s}`);

type Template =
  | { t: "leaf"; r: string }
  | { t: "arr"; items: Template[] }
  | { t: "obj"; entries: { sens: boolean; name: string; plain: string; child: Template }[] };

const template: fc.Arbitrary<Template> = fc.letrec<{ node: Template }>((tie) => ({
  node: fc.oneof(
    { depthSize: "small", maxDepth: 4 },
    alnum.map((r): Template => ({ t: "leaf", r })),
    fc.array(tie("node"), { maxLength: 3 }).map((items): Template => ({ t: "arr", items })),
    fc
      .array(
        fc.record({
          sens: fc.boolean(),
          name: sensitiveName,
          plain: fc.constantFrom(...plainBase),
          child: tie("node"),
        }),
        { maxLength: 4 },
      )
      .map((entries): Template => ({ t: "obj", entries })),
  ),
})).node;

interface Built {
  value: unknown;
  secrets: string[];
  plains: string[];
}

function build(tpl: Template, rootKey: string): Built {
  let n = 0;
  const secrets: string[] = [];
  const plains: string[] = [];
  const secret = (r: string): string => {
    const s = `SECRET_${n++}_${r}`;
    secrets.push(s);
    return s;
  };
  const plain = (r: string): string => {
    const s = `PLAIN_${n++}_${r}`;
    plains.push(s);
    return s;
  };
  const walk = (node: Template): unknown => {
    switch (node.t) {
      case "leaf":
        return plain(node.r);
      case "arr":
        return node.items.map(walk);
      case "obj": {
        const out: Record<string, unknown> = {};
        node.entries.forEach((e, i) => {
          // Index suffix keeps keys unique; plain names are chosen not to match SENSITIVE.
          if (e.sens) out[`${e.name}${i}`] = secret(e.name);
          else out[`${e.plain}${i}`] = walk(e.child);
        });
        return out;
      }
    }
  };
  const data = walk(tpl);
  return { value: { [rootKey]: secret("root"), data }, secrets, plains };
}

describe("redact properties", () => {
  it("test keys are classified as intended", () => {
    for (const p of plainBase) expect(SENSITIVE.test(p)).toBe(false);
    for (const b of sensitiveBase) expect(SENSITIVE.test(b)).toBe(true);
  });

  // Feature: mcp-gateway, Property 19: Redaction removes every sensitive value
  it("Property 19: redactJson removes every sensitive value and keeps the rest", () => {
    // **Validates: Requirements 8.3**
    fc.assert(
      fc.property(template, sensitiveName, (tpl, rootKey) => {
        const { value, secrets, plains } = build(tpl, rootKey);
        expect(secrets.length).toBeGreaterThan(0);
        const out = JSON.stringify(redactJson(value));
        for (const s of secrets) expect(out).not.toContain(s);
        for (const p of plains) expect(out).toContain(p);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: mcp-gateway, Property 19 (XML): sensitive element values never appear
  it("Property 19: redactXml removes sensitive element values with namespace prefixes", () => {
    // **Validates: Requirements 8.3**
    const prefix = fc.constantFrom("ns", "soap", "a1", "tns", "ns2");
    type XItem =
      | { k: "sens"; p: string; name: string; r: string }
      | { k: "plain"; p: string; name: string; r: string }
      | { k: "wrap"; p: string; items: XItem[] };
    const item: fc.Arbitrary<XItem> = fc.letrec<{ item: XItem }>((tie) => ({
      item: fc.oneof(
        { depthSize: "small", maxDepth: 3 },
        fc.record({ k: fc.constant("sens" as const), p: prefix, name: sensitiveName, r: alnum }),
        fc.record({ k: fc.constant("plain" as const), p: prefix, name: fc.constantFrom(...plainBase), r: alnum }),
        fc.record({ k: fc.constant("wrap" as const), p: prefix, items: fc.array(tie("item"), { maxLength: 3 }) }),
      ),
    })).item;

    fc.assert(
      fc.property(fc.array(item, { maxLength: 4 }), prefix, sensitiveName, alnum, (items, p, rootName, rootR) => {
        let n = 0;
        const secrets: string[] = [];
        const plains: string[] = [];
        const render = (it: XItem): string => {
          if (it.k === "wrap") {
            const wid = n++;
            return `<${it.p}:Wrap${wid}>${it.items.map(render).join("")}</${it.p}:Wrap${wid}>`;
          }
          const id = n++;
          if (it.k === "sens") {
            const s = `SECRET_${id}_${it.r}`;
            secrets.push(s);
            return `<${it.p}:${it.name}>${s}</${it.p}:${it.name}>`;
          }
          const s = `PLAIN_${id}_${it.r}`;
          plains.push(s);
          return `<${it.p}:${it.name}${id}>${s}</${it.p}:${it.name}${id}>`;
        };
        const rootSecret = `SECRET_root_${rootR}`;
        secrets.push(rootSecret);
        const xml =
          `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
          `<${p}:${rootName}>${rootSecret}</${p}:${rootName}>` +
          items.map(render).join("") +
          `</soap:Body></soap:Envelope>`;
        const out = redactXml(xml);
        for (const s of secrets) expect(out).not.toContain(s);
        for (const s of plains) expect(out).toContain(s);
      }),
      { numRuns: 200 },
    );
  });
});
