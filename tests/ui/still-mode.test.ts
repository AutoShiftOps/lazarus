import { describe, expect, it } from "vitest";
import {
  STILL_INIT_SCRIPT,
  STILL_STORAGE_KEY,
  getStill,
  setStill,
  type StillStorage,
} from "../../lib/ui/still-mode";

function memoryStorage(initial: Record<string, string> = {}): StillStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v);
    },
  };
}

const throwing: StillStorage = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("quota", "QuotaExceededError");
  },
};

describe("still mode storage", () => {
  it("uses the documented key", () => {
    expect(STILL_STORAGE_KEY).toBe("lazarus:still");
  });

  it("round-trips true and false", () => {
    const s = memoryStorage();
    expect(getStill(s)).toBe(false);
    expect(setStill(s, true)).toBe(true);
    expect(s.data.get(STILL_STORAGE_KEY)).toBe("true");
    expect(getStill(s)).toBe(true);
    expect(setStill(s, false)).toBe(true);
    expect(getStill(s)).toBe(false);
  });

  it("treats unexpected stored values as not still", () => {
    expect(getStill(memoryStorage({ [STILL_STORAGE_KEY]: "yes" }))).toBe(false);
  });

  it("does not throw and reports failure when storage throws", () => {
    expect(getStill(throwing)).toBe(false);
    expect(setStill(throwing, true)).toBe(false);
  });

  it("does not throw when storage is blocked (null or undefined)", () => {
    expect(getStill(null)).toBe(false);
    expect(getStill(undefined)).toBe(false);
    expect(setStill(null, true)).toBe(false);
    expect(setStill(undefined, true)).toBe(false);
  });

  it("head script reads the same key, sets data-still and guards storage access with try/catch", () => {
    expect(STILL_INIT_SCRIPT).toContain(`"${STILL_STORAGE_KEY}"`);
    expect(STILL_INIT_SCRIPT).toContain('"data-still"');
    expect(STILL_INIT_SCRIPT.startsWith("try{")).toBe(true);
    expect(STILL_INIT_SCRIPT).toContain("catch");
    expect(() => new Function(STILL_INIT_SCRIPT)).not.toThrow();
  });

  it("head script is safe to run when localStorage access throws", () => {
    const attrs: Record<string, string> = {};
    const run = new Function(
      "localStorage",
      "document",
      STILL_INIT_SCRIPT,
    ) as (ls: unknown, doc: unknown) => void;
    const doc = { documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) } };
    expect(() => run({ getItem: () => { throw new Error("blocked"); } }, doc)).not.toThrow();
    expect(attrs).toEqual({});
    run({ getItem: () => "true" }, doc);
    expect(attrs["data-still"]).toBe("true");
  });
});
