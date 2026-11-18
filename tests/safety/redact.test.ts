import { describe, it, expect } from "vitest";
import { SENSITIVE, redactJson, redactXml, truncate } from "../../lib/safety/redact";

const R = "[redacted]";

describe("SENSITIVE", () => {
  it("is not stateful across repeated tests", () => {
    expect(SENSITIVE.test("password")).toBe(true);
    expect(SENSITIVE.test("password")).toBe(true);
    expect(SENSITIVE.test("name")).toBe(false);
  });
});

describe("redactJson", () => {
  it("masks sensitive keys at the top level and keeps the others exactly", () => {
    expect(redactJson({ user: "ada", password: "hunter2", n: 3, ok: true, none: null })).toStrictEqual({
      user: "ada",
      password: R,
      n: 3,
      ok: true,
      none: null,
    });
  });

  it("masks nested sensitive keys", () => {
    const input = { a: { b: { c: { token: "t0k", keep: "yes" } }, secret: "s" } };
    expect(redactJson(input)).toStrictEqual({ a: { b: { c: { token: R, keep: "yes" } }, secret: R } });
  });

  it("masks sensitive keys inside arrays of objects", () => {
    const input = {
      accounts: [
        { id: 1, apiKey: "k1" },
        { id: 2, nested: [{ Authorization: "Bearer x", id: 3 }] },
      ],
    };
    expect(redactJson(input)).toStrictEqual({
      accounts: [
        { id: 1, apiKey: R },
        { id: 2, nested: [{ Authorization: R, id: 3 }] },
      ],
    });
  });

  it("handles a top-level array and primitives inside arrays", () => {
    expect(redactJson([1, "a", null, true, { ssn: "123" }])).toStrictEqual([1, "a", null, true, { ssn: R }]);
  });

  it("matches keys case-insensitively and on substrings", () => {
    const input = {
      PASSWORD: "1",
      Passwd: "2",
      ApiKey: "3",
      "x-api-key": "4",
      API_KEY: "5",
      "Client-Secret": "6",
      accessToken: "7",
      credentials: "8",
      SSN: "9",
      authorization: "10",
    };
    const out = redactJson(input) as Record<string, unknown>;
    expect(Object.keys(out)).toStrictEqual(Object.keys(input));
    for (const k of Object.keys(out)) expect(out[k]).toBe(R);
  });

  it("masks the whole value when a sensitive key holds an object or array", () => {
    expect(redactJson({ credentials: { user: "u", pw: "p" }, token: ["a", "b"], x: 1 })).toStrictEqual({
      credentials: R,
      token: R,
      x: 1,
    });
  });

  it("does not mask keys that merely resemble sensitive ones", () => {
    expect(redactJson({ key: "k", api: "a", name: "n", sn: "s" })).toStrictEqual({
      key: "k",
      api: "a",
      name: "n",
      sn: "s",
    });
  });

  it("does not inspect values, only keys", () => {
    expect(redactJson({ note: "my password is hunter2" })).toStrictEqual({ note: "my password is hunter2" });
  });

  it("preserves non-sensitive data exactly, including odd strings and numbers", () => {
    const input = {
      s: "a<b>&amp;\n\t\"quote\" ünï 😀",
      empty: "",
      neg: -0.5,
      big: 1e21,
      list: [[], {}, [[1]]],
      deep: { x: { y: [{ z: "w" }] } },
    };
    expect(redactJson(input)).toStrictEqual(input);
  });

  it("returns primitives and undefined as they are", () => {
    expect(redactJson("plain")).toBe("plain");
    expect(redactJson(42)).toBe(42);
    expect(redactJson(false)).toBe(false);
    expect(redactJson(null)).toBeNull();
    expect(redactJson(undefined)).toBeUndefined();
  });

  it("converts bigint and Date to strings", () => {
    expect(redactJson({ b: BigInt(10), d: new Date("2020-01-02T03:04:05.000Z") })).toStrictEqual({
      b: "10",
      d: "2020-01-02T03:04:05.000Z",
    });
  });

  it("masks values that are not JSON data", () => {
    expect(redactJson({ f: () => 1, s: Symbol("x"), m: new Map([[1, 2]]), set: new Set([1]), bad: new Date(NaN) })).toStrictEqual({
      f: R,
      s: R,
      m: R,
      set: R,
      bad: R,
    });
  });

  it("accepts objects with a null prototype", () => {
    const o = Object.create(null) as Record<string, unknown>;
    o.a = 1;
    o.password = "p";
    expect(redactJson(o)).toStrictEqual({ a: 1, password: R });
  });

  it("fails closed on a cyclic object: the back-reference is masked", () => {
    const a: Record<string, unknown> = { name: "x" };
    a.self = a;
    expect(redactJson(a)).toStrictEqual({ name: "x", self: R });
  });

  it("fails closed on a cycle through an array", () => {
    const arr: unknown[] = [1];
    arr.push({ back: arr });
    expect(redactJson(arr)).toStrictEqual([1, { back: R }]);
  });

  it("keeps a shared, non-cyclic reference intact in both places", () => {
    const shared = { v: 1 };
    expect(redactJson({ a: shared, b: shared })).toStrictEqual({ a: { v: 1 }, b: { v: 1 } });
  });

  it("masks anything nested 50 levels or deeper without overflowing the stack", () => {
    const root: Record<string, unknown> = {};
    let cur = root;
    for (let i = 0; i < 10000; i++) {
      const next: Record<string, unknown> = {};
      cur.n = next;
      cur = next;
    }
    let out = redactJson(root) as Record<string, unknown>;
    for (let i = 0; i < 49; i++) out = out.n as Record<string, unknown>;
    // `out` is the object at depth 49; its child sits at depth 50.
    expect(typeof out).toBe("object");
    expect(out.n).toBe(R);
  });

  it("keeps data at depth 49 intact", () => {
    let v: unknown = { leaf: "ok" };
    for (let i = 0; i < 48; i++) v = { n: v };
    let out = redactJson(v) as Record<string, unknown>;
    for (let i = 0; i < 48; i++) out = out.n as Record<string, unknown>;
    expect(out).toStrictEqual({ leaf: "ok" });
  });

  it("masks the whole object when a getter throws", () => {
    const o: Record<string, unknown> = { a: 1 };
    Object.defineProperty(o, "boom", {
      enumerable: true,
      get() {
        throw new Error("nope");
      },
    });
    expect(redactJson({ wrapper: o, other: 2 })).toStrictEqual({ wrapper: R, other: 2 });
  });

  it("does not mutate the input", () => {
    const input = {
      password: "p",
      list: [{ token: "t", keep: [1, 2] }],
      nested: { secret: "s", d: { x: "y" } },
    };
    const snapshot = structuredClone(input);
    const out = redactJson(input);
    expect(input).toStrictEqual(snapshot);
    expect(out).not.toBe(input);
    expect((out as typeof input).list).not.toBe(input.list);
    expect((out as typeof input).nested.d).not.toBe(input.nested.d);
  });

  it("treats a __proto__ key as plain data and does not pollute", () => {
    const input = JSON.parse('{"__proto__":{"polluted":"yes","password":"p"},"a":1}') as unknown;
    const out = redactJson(input) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toStrictEqual(["__proto__", "a"]);
    expect(Object.getOwnPropertyDescriptor(out, "__proto__")?.value).toStrictEqual({
      polluted: "yes",
      password: R,
    });
    expect(out.a).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).password).toBeUndefined();
  });
});

describe("redactXml", () => {
  it("masks a sensitive element and keeps the rest exactly", () => {
    expect(redactXml("<a><Name>ada</Name><Password>hunter2</Password><Id>7</Id></a>")).toBe(
      `<a><Name>ada</Name><Password>${R}</Password><Id>7</Id></a>`,
    );
  });

  it("matches on the local name when elements have namespace prefixes", () => {
    const xml =
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="urn:t">' +
      "<soap:Body><t:Login><t:User>ada</t:User><t:Password>hunter2</t:Password></t:Login></soap:Body>" +
      "</soap:Envelope>";
    expect(redactXml(xml)).toBe(
      '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="urn:t">' +
        `<soap:Body><t:Login><t:User>ada</t:User><t:Password>${R}</t:Password></t:Login></soap:Body>` +
        "</soap:Envelope>",
    );
  });

  it("does not treat the prefix as part of the name", () => {
    // Prefix "token" is not sensitive on its own; only the local name counts.
    expect(redactXml("<token:Name>ada</token:Name>")).toBe("<token:Name>ada</token:Name>");
  });

  it("is case-insensitive on element names", () => {
    expect(redactXml("<PASSWORD>a</PASSWORD><apiKey>b</apiKey><API_KEY>c</API_KEY><Ssn>d</Ssn>")).toBe(
      `<PASSWORD>${R}</PASSWORD><apiKey>${R}</apiKey><API_KEY>${R}</API_KEY><Ssn>${R}</Ssn>`,
    );
  });

  it("masks every occurrence, including repeated siblings", () => {
    expect(redactXml("<l><Token>1</Token><Token>2</Token></l>")).toBe(`<l><Token>${R}</Token><Token>${R}</Token></l>`);
  });

  it("masks the whole subtree of a sensitive element", () => {
    expect(redactXml("<Credentials><User>u</User><Pw>p</Pw></Credentials><Ok>1</Ok>")).toBe(
      `<Credentials>${R}</Credentials><Ok>1</Ok>`,
    );
  });

  it("masks nested elements of the same name until the right closing tag", () => {
    expect(redactXml("<Secret><Secret>in</Secret>still</Secret><Ok>1</Ok>")).toBe(
      `<Secret>${R}</Secret><Ok>1</Ok>`,
    );
  });

  it("masks values containing entities, and keeps entities in non-sensitive values", () => {
    expect(redactXml("<Token>a&lt;b&amp;c&#x41;</Token><Name>a &amp; b &lt; c</Name>")).toBe(
      `<Token>${R}</Token><Name>a &amp; b &lt; c</Name>`,
    );
  });

  it("masks a sensitive CDATA section", () => {
    expect(redactXml("<Secret><![CDATA[<x>&raw</x>]]></Secret>")).toBe(`<Secret>${R}</Secret>`);
  });

  it("is not fooled by markup inside CDATA in a sensitive element", () => {
    expect(redactXml("<Password><![CDATA[</Password><Name>leak</Name>]]></Password><Id>1</Id>")).toBe(
      `<Password>${R}</Password><Id>1</Id>`,
    );
  });

  it("is not fooled by a comment inside a sensitive element", () => {
    expect(redactXml("<Password>a<!-- </Password> -->b</Password><Id>1</Id>")).toBe(
      `<Password>${R}</Password><Id>1</Id>`,
    );
  });

  it("keeps non-sensitive CDATA, comments and processing instructions exactly", () => {
    const xml = '<?xml version="1.0" encoding="utf-8"?><a><!-- note --><v><![CDATA[1 < 2 && 3 > 2]]></v></a>';
    expect(redactXml(xml)).toBe(xml);
  });

  it("masks sensitive attributes and keeps the other attributes", () => {
    expect(redactXml(`<a id="1" token="abc" Api-Key='k' x:password="p">v</a>`)).toBe(
      `<a id="1" token="${R}" Api-Key="${R}" x:password="${R}">v</a>`,
    );
  });

  it("handles '>' inside attribute values", () => {
    expect(redactXml('<a note="x>y" secret="s"/>')).toBe(`<a note="x>y" secret="${R}"/>`);
  });

  it("keeps a self-closing sensitive element as is", () => {
    expect(redactXml("<a><Password/><b>1</b></a>")).toBe("<a><Password/><b>1</b></a>");
  });

  it("masks the content of a sensitive element that has attributes", () => {
    expect(redactXml('<Password type="plain">p</Password>')).toBe(`<Password type="plain">${R}</Password>`);
  });

  it("preserves non-sensitive documents byte for byte, including whitespace", () => {
    const xml =
      '<?xml version="1.0"?>\n<s:Envelope xmlns:s="urn:s">\n  <s:Body>\n    <Add><a>1</a><b>2</b></Add>\n  </s:Body>\n</s:Envelope>\n';
    expect(redactXml(xml)).toBe(xml);
  });

  it("returns the empty string and plain text unchanged", () => {
    expect(redactXml("")).toBe("");
    expect(redactXml("just text, no tags")).toBe("just text, no tags");
  });

  it("drops a DOCTYPE declaration", () => {
    expect(redactXml("<!DOCTYPE a><a>1</a>")).toBe("<a>1</a>");
  });

  it("masks the rest of the document when a tag is malformed", () => {
    expect(redactXml("<a><Name>x</Name><b")).toBe(`<a><Name>x</Name>${R}`);
    expect(redactXml("<a><Name>x</Name><b attr=unquoted>secret-data</b></a>")).toBe(`<a><Name>x</Name>${R}`);
  });

  it("masks the rest when a comment, CDATA or PI is unterminated", () => {
    expect(redactXml("<a><!-- Password=hunter2")).toBe(`<a>${R}`);
    expect(redactXml("<a><![CDATA[Password=hunter2")).toBe(`<a>${R}`);
    expect(redactXml("<a><?pi Password=hunter2")).toBe(`<a>${R}`);
  });

  it("masks the rest when a closing tag is malformed", () => {
    expect(redactXml("<a>1</a hunter2")).toBe(`<a>1${R}`);
  });

  it("does not leak the rest of a document after a sensitive element with mismatched nesting", () => {
    const out = redactXml("<Password>hunter2</Wrong>leak<b>1</b>");
    expect(out).toBe(`<Password>${R}`);
  });

  it("keeps the mask when a sensitive element is never closed", () => {
    expect(redactXml("<a><Password>hunter2")).toBe(`<a><Password>${R}`);
  });

  it("masks a stray '<' in text as malformed", () => {
    expect(redactXml("<a>1 < 2</a>")).toBe(`<a>1 ${R}`);
  });
});

describe("truncate", () => {
  it("returns the string unchanged when it fits", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate("", 5)).toBe("");
    expect(truncate("abc", Infinity)).toBe("abc");
  });

  it("cuts to exactly max units, ending with an ellipsis", () => {
    expect(truncate("abcdef", 4)).toBe("abc…");
    expect(truncate("abcdef", 4)).toHaveLength(4);
    expect(truncate("abcdef", 5)).toBe("abcd…");
  });

  it("handles tiny limits", () => {
    expect(truncate("abcdef", 1)).toBe("…");
    expect(truncate("abcdef", 2)).toBe("a…");
  });

  it("returns the empty string for zero, negative, NaN and sub-1 limits", () => {
    expect(truncate("abc", 0)).toBe("");
    expect(truncate("abc", -5)).toBe("");
    expect(truncate("abc", NaN)).toBe("");
    expect(truncate("abc", 0.5)).toBe("");
  });

  it("floors fractional limits", () => {
    expect(truncate("abcdef", 2.9)).toBe("a…");
  });

  it("never splits a surrogate pair", () => {
    // "😀" is two UTF-16 units.
    expect(truncate("ab😀cd", 4)).toBe("ab…");
    expect(truncate("ab😀cd", 5)).toBe("ab😀…");
    expect(truncate("ab😀cd", 5)).toHaveLength(5);
  });

  it("respects the 8 KB transcript bound", () => {
    const s = "x".repeat(9000);
    const out = truncate(s, 8192);
    expect(out).toHaveLength(8192);
    expect(out).toBe("x".repeat(8191) + "…");
    expect(truncate("x".repeat(8192), 8192)).toBe("x".repeat(8192));
  });
});
