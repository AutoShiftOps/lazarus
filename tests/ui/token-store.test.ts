import { afterEach, describe, expect, it, vi } from "vitest";
import { clearOwnerToken, getOwnerToken, setOwnerToken } from "../../lib/ui/token-store";

const ID_A = "AbCd1234";
const ID_B = "Zz9Yy8Xx";
const TOKEN_A = "aaaaaaaaaaaaaaaaaaaa_-AA";
const TOKEN_B = "bbbbbbbbbbbbbbbbbbbbbbbbBB12";

function fakeStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    removeItem: (k: string) => void data.delete(k),
    setItem: (k: string, v: string) => void data.set(k, v),
  };
}

function throwingStorage(): Storage {
  const boom = (): never => {
    throw new Error("blocked");
  };
  return {
    get length(): number {
      return boom();
    },
    clear: boom,
    getItem: boom,
    key: boom,
    removeItem: boom,
    setItem: boom,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("token-store with a fake Storage", () => {
  it("round-trips a token under lazarus:owner:{id}", () => {
    const s = fakeStorage();
    setOwnerToken(ID_A, TOKEN_A, s);
    expect(s.data.get(`lazarus:owner:${ID_A}`)).toBe(TOKEN_A);
    expect(getOwnerToken(ID_A, s)).toBe(TOKEN_A);
  });

  it("returns null when nothing is stored", () => {
    expect(getOwnerToken(ID_A, fakeStorage())).toBeNull();
  });

  it("clear removes the token", () => {
    const s = fakeStorage();
    setOwnerToken(ID_A, TOKEN_A, s);
    clearOwnerToken(ID_A, s);
    expect(getOwnerToken(ID_A, s)).toBeNull();
    expect(s.data.size).toBe(0);
  });

  it("ignores an invalid service id", () => {
    const s = fakeStorage();
    setOwnerToken("bad id!", TOKEN_A, s);
    expect(s.data.size).toBe(0);
    s.data.set("lazarus:owner:bad id!", TOKEN_A);
    expect(getOwnerToken("bad id!", s)).toBeNull();
    clearOwnerToken("bad id!", s);
    expect(s.data.size).toBe(1);
  });

  it.each([
    ["too short", "a".repeat(19)],
    ["too long", "a".repeat(65)],
    ["bad chars", "a".repeat(19) + "!"],
    ["empty", ""],
  ])("does not store an invalid token (%s)", (_name, token) => {
    const s = fakeStorage();
    setOwnerToken(ID_A, token, s);
    expect(s.data.size).toBe(0);
  });

  it("accepts boundary token lengths 20 and 64", () => {
    const s = fakeStorage();
    setOwnerToken(ID_A, "a".repeat(20), s);
    expect(getOwnerToken(ID_A, s)).toBe("a".repeat(20));
    setOwnerToken(ID_B, "b".repeat(64), s);
    expect(getOwnerToken(ID_B, s)).toBe("b".repeat(64));
  });

  it("reads a malformed stored value as null", () => {
    const s = fakeStorage();
    s.data.set(`lazarus:owner:${ID_A}`, "not a token!");
    expect(getOwnerToken(ID_A, s)).toBeNull();
  });

  it("keeps services isolated", () => {
    const s = fakeStorage();
    setOwnerToken(ID_A, TOKEN_A, s);
    setOwnerToken(ID_B, TOKEN_B, s);
    expect(getOwnerToken(ID_A, s)).toBe(TOKEN_A);
    expect(getOwnerToken(ID_B, s)).toBe(TOKEN_B);
    clearOwnerToken(ID_A, s);
    expect(getOwnerToken(ID_A, s)).toBeNull();
    expect(getOwnerToken(ID_B, s)).toBe(TOKEN_B);
  });

  it("uses globalThis.localStorage by default", () => {
    const s = fakeStorage();
    vi.stubGlobal("localStorage", s);
    setOwnerToken(ID_A, TOKEN_A);
    expect(s.data.get(`lazarus:owner:${ID_A}`)).toBe(TOKEN_A);
    expect(getOwnerToken(ID_A)).toBe(TOKEN_A);
    clearOwnerToken(ID_A);
    expect(s.data.size).toBe(0);
  });
});

describe("token-store with a throwing Storage", () => {
  it("get returns null and set/clear do not throw", () => {
    const s = throwingStorage();
    expect(() => setOwnerToken(ID_A, TOKEN_A, s)).not.toThrow();
    expect(() => clearOwnerToken(ID_A, s)).not.toThrow();
    expect(getOwnerToken(ID_A, s)).toBeNull();
  });

  it("handles a globalThis.localStorage getter that throws", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(() => setOwnerToken(ID_A, TOKEN_A)).not.toThrow();
      expect(() => clearOwnerToken(ID_A)).not.toThrow();
      expect(getOwnerToken(ID_A)).toBeNull();
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
});

describe("token-store with missing storage", () => {
  it("get returns null and set/clear do not throw", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(() => setOwnerToken(ID_A, TOKEN_A)).not.toThrow();
    expect(() => clearOwnerToken(ID_A)).not.toThrow();
    expect(getOwnerToken(ID_A)).toBeNull();
  });
});
