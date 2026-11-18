import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createApprovals, type ApprovalsRedis } from "../../lib/safety/approvals";
import { createFakeApprovalsRedis } from "../helpers/fake-approvals-redis";

const SVC = "svc12345";
const NEW = {
  serviceId: SVC,
  tool: "CloseAccount",
  args: { accountId: "A-1", password: "hunter2" },
  risk: "destructive" as const,
  reason: "Destructive operation",
};

function setup(start = 1_700_000_000_000) {
  const redis = createFakeApprovalsRedis();
  const clock = { t: start };
  const approvals = createApprovals(redis, { now: () => clock.t });
  return { redis, clock, approvals };
}

describe("approvals", () => {
  it("happy path: create -> approve -> claim -> executed", async () => {
    const { approvals, redis } = setup();
    const a = await approvals.createApproval(SVC, NEW);
    expect(a.id.length).toBeGreaterThanOrEqual(21);
    expect(a.status).toBe("pending");
    expect(a.args).toEqual(NEW.args);
    expect(redis.ttls.get(`approval:${SVC}:${a.id}`)).toBe(900);
    expect(Date.parse(a.expiresAt) - Date.parse(a.createdAt)).toBe(900_000);

    expect(await approvals.resolveApproval(SVC, a.id, "approve", "ok by me")).toBe("ok");
    const approved = await approvals.getApproval(SVC, a.id);
    expect(approved?.status).toBe("approved");
    expect(approved?.note).toBe("ok by me");
    expect(approved?.args).toEqual(NEW.args);
    expect(approved?.resolvedAt).toBeTypeOf("string");

    expect(await approvals.claimExecution(SVC, a.id)).toBe(true);
    await approvals.markExecuted(SVC, a.id);
    expect((await approvals.getApproval(SVC, a.id))?.status).toBe("executed");
    expect(await approvals.claimExecution(SVC, a.id)).toBe(false);
    expect((await approvals.listApprovals(SVC)).map((x) => x.id)).toEqual([a.id]);
  });

  it("generates distinct unguessable ids", async () => {
    const { approvals } = setup();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) ids.add((await approvals.createApproval(SVC, NEW)).id);
    expect(ids.size).toBe(50);
  });

  it("unknown id: get is null, resolve is not_found, claim is false", async () => {
    const { approvals } = setup();
    expect(await approvals.getApproval(SVC, "nope")).toBeNull();
    expect(await approvals.resolveApproval(SVC, "nope", "approve")).toBe("not_found");
    expect(await approvals.claimExecution(SVC, "nope")).toBe(false);
  });

  it("deny blocks claim and later approve", async () => {
    const { approvals } = setup();
    const a = await approvals.createApproval(SVC, NEW);
    expect(await approvals.claimExecution(SVC, a.id)).toBe(false); // pending
    expect(await approvals.resolveApproval(SVC, a.id, "deny")).toBe("ok");
    expect(await approvals.resolveApproval(SVC, a.id, "approve")).toBe("conflict");
    expect(await approvals.claimExecution(SVC, a.id)).toBe(false);
    expect((await approvals.getApproval(SVC, a.id))?.status).toBe("denied");
  });

  it("expiry: pending reads expired, resolve conflicts, claim is false", async () => {
    const { approvals, clock } = setup();
    const a = await approvals.createApproval(SVC, NEW);
    clock.t += 900_000;
    expect((await approvals.getApproval(SVC, a.id))?.status).toBe("expired");
    expect(await approvals.resolveApproval(SVC, a.id, "approve")).toBe("conflict");
    expect(await approvals.claimExecution(SVC, a.id)).toBe(false);
  });

  it("an approved approval cannot be claimed after it expires", async () => {
    const { approvals, clock } = setup();
    const a = await approvals.createApproval(SVC, NEW);
    await approvals.resolveApproval(SVC, a.id, "approve");
    clock.t += 900_000;
    expect(await approvals.claimExecution(SVC, a.id)).toBe(false);
  });

  it("20 concurrent resolves: exactly one ok, the rest conflict", async () => {
    const { approvals } = setup();
    const a = await approvals.createApproval(SVC, NEW);
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        approvals.resolveApproval(SVC, a.id, i % 2 === 0 ? "approve" : "deny"),
      ),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "conflict")).toHaveLength(19);
  });

  it("20 concurrent claims on an approved approval: exactly one true", async () => {
    const { approvals } = setup();
    const a = await approvals.createApproval(SVC, NEW);
    await approvals.resolveApproval(SVC, a.id, "approve");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => approvals.claimExecution(SVC, a.id)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("markExecuted does not recreate a missing approval", async () => {
    const { approvals, redis } = setup();
    await approvals.markExecuted(SVC, "ghostid");
    expect(redis.hashes.size).toBe(0);
  });

  it("Redis errors become a plain Error with a fixed message and no upstream text", async () => {
    const secret = "UPSTASH_TOKEN_abc https://redis.example/secret";
    const boom = async (): Promise<never> => {
      throw new Error(secret);
    };
    const broken: ApprovalsRedis = {
      hset: boom,
      hgetall: boom,
      expire: boom,
      eval: boom,
      lpush: boom,
      ltrim: boom,
      lrange: boom,
    };
    const approvals = createApprovals(broken);
    const calls: Array<() => Promise<unknown>> = [
      () => approvals.createApproval(SVC, NEW),
      () => approvals.getApproval(SVC, "x"),
      () => approvals.resolveApproval(SVC, "x", "approve"),
      () => approvals.claimExecution(SVC, "x"),
      () => approvals.markExecuted(SVC, "x"),
      () => approvals.listApprovals(SVC),
    ];
    for (const call of calls) {
      const err = await call().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).constructor).toBe(Error);
      expect((err as Error).message).toBe("Approval store unavailable.");
      expect((err as Error).message).not.toContain("UPSTASH");
      expect((err as Error).cause).toBeUndefined();
    }
  });
});

describe("approvals property: at most one claim, never after deny or expiry", () => {
  // Property 21 (approvals execute at most once), storage level.
  const op = fc.constantFrom("approve", "deny", "claim");
  const batch = fc.record({
    ops: fc.array(op, { minLength: 1, maxLength: 6 }),
    advanceMs: fc.constantFrom(0, 0, 300_000, 600_000, 900_000),
  });

  it("holds for any interleaving", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(batch, { minLength: 1, maxLength: 8 }), async (batches) => {
        const { approvals, clock } = setup();
        const a = await approvals.createApproval(SVC, NEW);
        const expiresMs = Date.parse(a.expiresAt);
        let winner: "approve" | "deny" | null = null;
        let claims = 0;
        let claimTimeOk = true;

        for (const b of batches) {
          const t = clock.t;
          const results = await Promise.all(
            b.ops.map(async (o) => {
              if (o === "claim") {
                const ok = await approvals.claimExecution(SVC, a.id);
                return { o, ok, r: "" as string };
              }
              const r = await approvals.resolveApproval(SVC, a.id, o);
              return { o, ok: false, r };
            }),
          );
          for (const x of results) {
            if (x.o !== "claim" && x.r === "ok") {
              expect(winner).toBeNull(); // only one resolve ever wins
              expect(t).toBeLessThan(expiresMs); // never resolved after expiry
              winner = x.o as "approve" | "deny";
            }
          }
          for (const x of results) {
            if (x.o === "claim" && x.ok) {
              claims += 1;
              if (t >= expiresMs) claimTimeOk = false;
              expect(winner).toBe("approve"); // never claimed after deny / without approval
            }
          }
          clock.t += b.advanceMs;
        }
        expect(claims).toBeLessThanOrEqual(1);
        expect(claimTimeOk).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});
