import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { handleSoap } from "../../lib/gravewood/handler";
import { createStore, type GwRedis, type GwStore } from "../../lib/gravewood/store";

const NOW = "2024-01-01T00:00:00.000Z";
const SEED_TOTAL_CENTS = 6365000;
const REAL_IDS = ["4471", "5530", "9902", "7718"] as const;

/** In-memory Redis fake (mirrors store.test.ts). Never networked. */
class FakeRedis implements GwRedis {
  data = new Map<string, string>();
  /** When true, compareAndSet yields to the event loop before checking and writing. */
  yieldInCas = false;

  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
    return "OK";
  }
  async compareAndSet(key: string, expected: number, value: string) {
    if (this.yieldInCas) await new Promise<void>((r) => setImmediate(r));
    const cur = this.data.get(key);
    if (cur === undefined) return false;
    if ((JSON.parse(cur) as { version: number }).version !== expected) return false;
    this.data.set(key, value);
    return true;
  }
  async incr(key: string) {
    const n = Number(this.data.get(key) ?? 0) + 1;
    this.data.set(key, String(n));
    return n;
  }
  async expire() {
    return 1;
  }
  async ttl() {
    return 60;
  }
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function buildRequest(op: string, fields: Record<string, string>): string {
  const inner = Object.entries(fields)
    .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
    .join("");
  return (
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>` +
    `<${op} xmlns="urn:gravewood">${inner}</${op}></soap:Body></soap:Envelope>`
  );
}

type Step = { op: string; fields: Record<string, string> };

/** Applies one SOAP request to a sandbox through runOnSandbox. */
function apply(store: GwStore, id: string, step: Step) {
  return store.runOnSandbox(id, (s) => {
    const r = handleSoap(s, `"urn:gravewood:${step.op}"`, buildRequest(step.op, step.fields), NOW);
    return { state: r.state, response: r };
  });
}

const accountIdArb = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...REAL_IDS) },
  { weight: 1, arbitrary: fc.stringMatching(/^[0-9]{1,12}$/) },
  { weight: 1, arbitrary: fc.string({ maxLength: 8 }) },
);
const amountArb = fc.oneof(
  fc.integer({ min: 0, max: 2_000_000 }).map((c) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`),
  fc.constantFrom("0", "-1", "abc", "1.234", ""),
);

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ op: fc.constant("TransferFunds"), fields: fc.record({ fromAccount: accountIdArb, toAccount: accountIdArb, amount: amountArb }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("CloseAccount"), fields: fc.record({ accountId: accountIdArb }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("UpdateAddress"), fields: fc.record({ accountId: accountIdArb, address: fc.string({ maxLength: 30 }) }) }) },
  { weight: 2, arbitrary: fc.record({ op: fc.constant("GetBalance"), fields: fc.record({ accountId: accountIdArb }) }) },
  { weight: 1, arbitrary: fc.record({ op: fc.constant("ListAccounts"), fields: fc.constant({} as Record<string, string>) }) },
);

describe("Property 14: sandbox isolation", () => {
  /** **Validates: Requirements 2.2** */
  it("operations on sandbox A never change sandbox B's stored JSON", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 12 }), async (steps) => {
        const redis = new FakeRedis();
        const store = createStore(redis);
        const a = await store.createSandbox();
        const b = await store.createSandbox();
        const bKey = `gw:${b.id}`;
        const bBefore = redis.data.get(bKey);
        expect(bBefore).toBeDefined();

        for (const step of steps) {
          const r = await apply(store, a.id, step);
          expect(r.ok).toBe(true);
          expect(redis.data.get(bKey)).toBe(bBefore);
        }
        // Only A's key and B's key exist.
        expect([...redis.data.keys()].sort()).toEqual([`gw:${a.id}`, bKey].sort());
      }),
      { numRuns: 150 },
    );
  });

  it("A's changes are real: a transfer on A leaves B at the seed balances", async () => {
    const redis = new FakeRedis();
    const store = createStore(redis);
    const a = await store.createSandbox();
    const b = await store.createSandbox();
    const r = await apply(store, a.id, {
      op: "TransferFunds",
      fields: { fromAccount: "4471", toAccount: "5530", amount: "10.00" },
    });
    expect(r.ok && r.response.ok).toBe(true);
    expect((await store.loadState(a.id))?.version).toBe(1);
    expect((await store.loadState(b.id))?.version).toBe(0);
  });
});

describe("concurrent transfers on one sandbox", () => {
  it("preserve money and never apply a transfer twice", async () => {
    const redis = new FakeRedis();
    redis.yieldInCas = true;
    const store = createStore(redis);
    const { id } = await store.createSandbox();

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        apply(store, id, {
          op: "TransferFunds",
          fields: { fromAccount: "4471", toAccount: "5530", amount: "1.00" },
        }),
      ),
    );

    const okResults = results.filter((r) => r.ok);
    const others = results.filter((r) => !r.ok && r.reason !== "conflict");
    expect(others).toEqual([]);
    expect(okResults.length).toBeGreaterThanOrEqual(1);

    const confirmations = okResults.map((r) => {
      if (!r.ok || !r.response.ok) throw new Error("expected a successful transfer");
      const m = /<confirmationId>(GW-\d+)<\/confirmationId>/.exec(r.response.xml);
      if (!m) throw new Error("no confirmation id");
      return m[1];
    });
    expect(new Set(confirmations).size).toBe(confirmations.length);

    const final = await store.loadState(id);
    expect(final).not.toBeNull();
    expect(final!.accounts.reduce((sum, a) => sum + a.balanceCents, 0)).toBe(SEED_TOTAL_CENTS);
    // Each applied transfer moved exactly 100 cents and bumped the version once.
    expect(final!.version).toBe(okResults.length);
    expect(final!.nextConfirmation).toBe(1001 + okResults.length);
    expect(final!.accounts.find((a) => a.id === "4471")!.balanceCents).toBe(1245000 - 100 * okResults.length);
    expect(final!.accounts.find((a) => a.id === "5530")!.balanceCents).toBe(4800000 + 100 * okResults.length);
  });
});
