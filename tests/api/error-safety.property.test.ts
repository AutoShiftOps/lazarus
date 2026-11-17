import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { summon, type SummonDeps } from "../../lib/summon";
import type { ErrorCode, LazarusError, ServiceDefinition } from "../../lib/soap/types";

// Feature: summon, Property 10: Error responses never exceed 500 characters and contain no stack traces
// **Validates: Requirements 9.1, 9.2, 9.3**

const ERROR_CODES: ErrorCode[] = [
  "INVALID_REQUEST",
  "SSRF_BLOCKED",
  "WSDL_TOO_LARGE",
  "WSDL_PARSE_FAILED",
  "WSDL_FETCH_FAILED",
  "TIMEOUT",
  "REGISTRY_UNAVAILABLE",
  "INTERNAL_ERROR",
];

const STAGES = ["fetch", "parse", "upsert"] as const;
type Stage = (typeof STAGES)[number];

const ORIGIN = "https://lazarus.test";
const URL_OK = "http://example.com/c?WSDL";

const DEF: ServiceDefinition = {
  name: "Calc",
  wsdlUrl: URL_OK,
  ports: [],
  warnings: [],
};

function depsFailingAt(stage: Stage, error: LazarusError): SummonDeps {
  return {
    fetchWsdl: async () =>
      stage === "fetch"
        ? { ok: false, error }
        : { ok: true, xml: "<x/>", finalUrl: "http://final.example.com/c" },
    parseWsdl: async () => (stage === "parse" ? { ok: false, error } : { ok: true, definition: DEF }),
    generateSchemas: () => new Map(),
    upsertService: async () =>
      stage === "upsert" ? { ok: false, error } : { ok: true, id: "abcd1234", created: true },
  };
}

// Fragments that look like stack traces, filesystem paths and URLs, mixed with noise.
const fragment = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ unit: "grapheme", maxLength: 20 }),
  fc.constant("    at Foo (C:\\x\\y.ts:1:1)"),
  fc.constant("\n    at async run (/srv/app/dist/index.mjs:10:5)\n"),
  fc.constant("/node_modules/x/y.js"),
  fc.constant("C:\\proj\\node_modules\\pkg\\lib.cjs"),
  fc.constant("Error: boom\n    at "),
  fc.constant("https://example.com/a.js"),
  fc.constant("http://example.com/path/to/script.mjs?x=1"),
  fc
    .tuple(
      fc.constantFrom("/", "\\", "C:\\", "./", "../"),
      fc.stringMatching(/^[a-z0-9_-]{1,8}$/),
      fc.constantFrom(".ts", ".js", ".mjs", ".cjs", ".tsx", ".json"),
    )
    .map(([a, b, c]) => `${a}${b}${c}`),
  fc.constant("x".repeat(600)),
);

const message = fc.oneof(
  fc.array(fragment, { maxLength: 12 }).map((parts) => parts.join("")),
  fc.array(fragment, { minLength: 1, maxLength: 12 }).map((parts) => parts.join(" ")),
  fc.string({ minLength: 501, maxLength: 5000 }),
  fc.constant(""),
);

/** URLs are removed first (they are allowed), then the remainder is checked for path segments. */
function stripUrls(s: string): string {
  return s.replace(/https?:\/\/\S+/gi, "");
}
const PATH_SEGMENT = /[\\/][\w.-]+\.(?:ts|js|mjs|cjs)\b/;

describe("Property 10: error response safety", () => {
  it("error field is non-empty, <= 500 chars, with no stack frames or source paths", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ERROR_CODES),
        fc.constantFrom(...STAGES),
        message,
        fc.option(message, { nil: undefined }),
        async (code, stage, msg, detail) => {
          const error = { code, message: msg, detail } as LazarusError;
          const res = await summon(URL_OK, ORIGIN, depsFailingAt(stage, error));
          expect(res.status).toBeGreaterThanOrEqual(400);
          const body = res.body as { error: unknown };
          expect(typeof body.error).toBe("string");
          const text = body.error as string;
          expect(text.length).toBeGreaterThan(0);
          expect(text.length).toBeLessThanOrEqual(500);
          expect(text).not.toContain("    at ");
          expect(text).not.toContain("node_modules");
          expect(stripUrls(text)).not.toMatch(PATH_SEGMENT);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("the path check ignores URLs but flags filesystem paths", () => {
    expect(stripUrls("see https://example.com/a.js now")).not.toMatch(PATH_SEGMENT);
    expect(PATH_SEGMENT.test("at C:\\x\\y.ts")).toBe(true);
    expect(PATH_SEGMENT.test("/srv/app/index.mjs")).toBe(true);
  });
});
