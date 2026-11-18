import { describe, expect, it } from "vitest";
import { createTranscripts } from "../../lib/safety/transcript";
import type { TranscriptEntry } from "../../lib/safety/types";
import { createFakeTranscriptRedis } from "../helpers/fake-transcript-redis";

const SVC = "svc12345";
const KEY = `transcripts:${SVC}`;

function entry(over: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    id: "e1",
    ts: "2026-01-01T00:00:00.000Z",
    tool: "GetBalance",
    args: { account: "A1" },
    risk: "read",
    decision: "allow",
    outcome: "ok",
    durationMs: 12,
    summary: "ok",
    ...over,
  };
}

function setup() {
  const redis = createFakeTranscriptRedis();
  return { redis, t: createTranscripts(redis) };
}

describe("appendTranscript", () => {
  it("redacts secrets in args and SOAP XML before they reach Redis", async () => {
    const { redis, t } = setup();
    await t.appendTranscript(
      SVC,
      entry({
        args: { password: "pw-VALUE-1", nested: { list: [{ Authorization: "Bearer TOKEN-VALUE-2" }] } },
        soapRequest: "<Body><Login><password>XML-SECRET-3</password><user>bob</user></Login></Body>",
        soapResponse: "<Body><r><apiKey>XML-SECRET-4</apiKey><ok>yes</ok></r></Body>",
      }),
    );
    const raw = redis.lists.get(KEY)?.[0] ?? "";
    for (const secret of ["pw-VALUE-1", "TOKEN-VALUE-2", "XML-SECRET-3", "XML-SECRET-4"]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain("[redacted]");
    expect(raw).toContain("bob");
    expect(raw).toContain("yes");
  });

  it("truncates SOAP bodies to 8 KB after redaction, so a secret at the cut never leaks", async () => {
    const { redis, t } = setup();
    const secret = "ZQXJ-secret-value";
    // The secret value starts at index 8190, so the 8191-unit cut would keep its first letter
    // if truncation ran before redaction.
    const pad = "x".repeat(8180 - "<a>".length);
    const big = `<a>${pad}<password>${secret}</password>${"y".repeat(500)}</a>`;
    expect(big.indexOf("Z")).toBe(8190);
    await t.appendTranscript(SVC, entry({ soapRequest: big, soapResponse: big }));
    const stored = JSON.parse(redis.lists.get(KEY)?.[0] ?? "{}") as TranscriptEntry;
    expect(stored.soapRequest?.length).toBeLessThanOrEqual(8192);
    expect(stored.soapResponse?.length).toBeLessThanOrEqual(8192);
    expect(stored.soapRequest?.endsWith("…")).toBe(true);
    // Both bodies were cut inside "<password>[redacted]"; the secret's first letter must be gone.
    expect(stored.soapRequest).not.toContain("Z");
    expect(stored.soapResponse).not.toContain("Z");
    expect(stored.soapRequest).toContain("<password>[");
  });

  it("truncates summary to 500 units", async () => {
    const { redis, t } = setup();
    await t.appendTranscript(SVC, entry({ summary: "s".repeat(900) }));
    const stored = JSON.parse(redis.lists.get(KEY)?.[0] ?? "{}") as TranscriptEntry;
    expect(stored.summary.length).toBe(500);
  });

  it("keeps 200 items after 250 appends and sets a 30-day TTL", async () => {
    const { redis, t } = setup();
    for (let i = 0; i < 250; i++) await t.appendTranscript(SVC, entry({ id: `e${i}` }));
    const list = redis.lists.get(KEY) ?? [];
    expect(list).toHaveLength(200);
    expect((JSON.parse(list[0]) as TranscriptEntry).id).toBe("e249");
    expect((JSON.parse(list[199]) as TranscriptEntry).id).toBe("e50");
    expect(redis.ttls.get(KEY)).toBe(2_592_000);
  });

  it("stores a minimal entry when the entry cannot be serialised", async () => {
    const { redis, t } = setup();
    // A BigInt in a field that is copied through unchanged makes JSON.stringify throw.
    const bad = entry({ durationMs: BigInt(10) as unknown as number });
    await t.appendTranscript(SVC, bad);
    const stored = JSON.parse(redis.lists.get(KEY)?.[0] ?? "{}") as TranscriptEntry;
    expect(stored.summary).toBe("unserialisable entry");
    expect(stored.id).toBe("e1");
    expect(stored.args).toBeNull();
  });

  it("surfaces Redis errors as a fixed message without upstream text", async () => {
    const { redis, t } = setup();
    redis.failWith = new Error("https://secret.upstash.io token=abc123 refused");
    const err = await t.appendTranscript(SVC, entry()).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err?.message).toBe("Transcript store unavailable.");
    const listErr = await t.listTranscripts(SVC).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(listErr?.message).toBe("Transcript store unavailable.");
  });
});

describe("listTranscripts", () => {
  it("returns newest first", async () => {
    const { t } = setup();
    for (const id of ["a", "b", "c"]) await t.appendTranscript(SVC, entry({ id }));
    expect((await t.listTranscripts(SVC)).map((e) => e.id)).toEqual(["c", "b", "a"]);
  });

  it("caps the result at 100", async () => {
    const { t } = setup();
    for (let i = 0; i < 150; i++) await t.appendTranscript(SVC, entry({ id: `e${i}` }));
    const list = await t.listTranscripts(SVC);
    expect(list).toHaveLength(100);
    expect(list[0].id).toBe("e149");
  });

  it("keeps only entries strictly after `since`", async () => {
    const { t } = setup();
    const times = ["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"];
    for (const ts of times) await t.appendTranscript(SVC, entry({ id: ts, ts }));
    const after = await t.listTranscripts(SVC, "2026-01-02T00:00:00.000Z");
    expect(after.map((e) => e.id)).toEqual(["2026-01-03T00:00:00.000Z"]);
  });

  it("applies no filter when `since` is unparseable", async () => {
    const { t } = setup();
    await t.appendTranscript(SVC, entry({ id: "a" }));
    await t.appendTranscript(SVC, entry({ id: "b" }));
    expect(await t.listTranscripts(SVC, "not a date")).toHaveLength(2);
  });

  it("skips corrupt stored items", async () => {
    const { redis, t } = setup();
    await t.appendTranscript(SVC, entry({ id: "good" }));
    redis.lists.get(KEY)?.unshift("{not json", JSON.stringify({ id: 5 }), JSON.stringify([1]));
    expect((await t.listTranscripts(SVC)).map((e) => e.id)).toEqual(["good"]);
  });

  it("redacts again on read", async () => {
    const { redis, t } = setup();
    redis.lists.set(KEY, [
      JSON.stringify({
        ...entry({ id: "raw" }),
        args: { token: "LEAK-1" },
        soapRequest: "<x><secret>LEAK-2</secret></x>",
      }),
    ]);
    const [e] = await t.listTranscripts(SVC);
    expect(JSON.stringify(e)).not.toContain("LEAK");
  });
});
