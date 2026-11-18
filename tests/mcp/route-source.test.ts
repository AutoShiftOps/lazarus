import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("app/api/mcp/[id]/route.ts", "utf8");

describe("app/api/mcp/[id]/route.ts source", () => {
  it("exports maxDuration = 60", () => {
    expect(source).toMatch(/export\s+const\s+maxDuration\s*=\s*60\b/);
  });

  it("has no runtime export", () => {
    expect(source).not.toMatch(/export\s+(const|let|var)\s+runtime\b/);
    expect(source).not.toMatch(/export\s*\{[^}]*\bruntime\b/);
  });

  it("exports POST, GET, DELETE and OPTIONS handlers", () => {
    for (const m of ["POST", "GET", "DELETE", "OPTIONS"]) {
      expect(source).toMatch(new RegExp(`export\\s+(async\\s+)?function\\s+${m}\\b`));
    }
  });

  it("reads params as a Promise", () => {
    expect(source).toMatch(/params:\s*Promise</);
  });
});
