// lib/demo/index.ts
// Demo_Bootstrap logic for POST /api/demo (seance-ui Requirement 2). The route file stays thin.
// Takes no client input: the only URL ever summoned is this app's own sandbox WSDL.
// Every error body is fixed text; no upstream, Redis or summon text reaches the client.

import { isDemoService } from "../auth/owner";
import { hit, type RateRedis } from "../rate-limit";
import type { SummonResponse } from "../summon";

export const IP_LIMIT = 10;
export const IP_WINDOW_SEC = 60;
export const GLOBAL_LIMIT = 500;
export const GLOBAL_WINDOW_SEC = 3600;

const NO_STORE = { "cache-control": "no-store" } as const;

export type DemoDeps = {
  createSandbox: () => Promise<{ id: string }>;
  /** Runs the shared summon pipeline on a raw JSON body (summonFromBody). */
  summon: (rawBody: string, origin: string) => Promise<SummonResponse>;
  rateRedis: RateRedis;
  origin: string;
};

function fail(status: number, code: string, error: string, extra: Record<string, string> = {}): Response {
  return Response.json({ error, code }, { status, headers: { ...NO_STORE, ...extra } });
}

const unavailable = (): Response => fail(503, "UNAVAILABLE", "The demo is not available right now.");
const summonFailed = (): Response =>
  fail(502, "SUMMON_FAILED", "The spirits could not be raised. Please try again in a moment.");

function rateLimited(retryAfter: number): Response {
  return fail(429, "RATE_LIMITED", "The spirits are tired. Please wait a little and try again.", {
    "retry-after": String(retryAfter),
  });
}

export function methodNotAllowed(): Response {
  return fail(405, "METHOD_NOT_ALLOWED", "Method not allowed. Use POST.", { allow: "POST" });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Order: per-IP limit -> global limit -> create sandbox -> verify the WSDL URL is a demo URL
 * -> summon. Never throws.
 */
export async function bootstrapDemo(deps: DemoDeps, clientIp: string): Promise<Response> {
  try {
    const perIp = await hit(deps.rateRedis, `demo:ip:${clientIp}`, IP_LIMIT, IP_WINDOW_SEC);
    if (!perIp.allowed) return rateLimited(perIp.retryAfter);
    const global = await hit(deps.rateRedis, "demo:global", GLOBAL_LIMIT, GLOBAL_WINDOW_SEC);
    if (!global.allowed) return rateLimited(global.retryAfter);
  } catch {
    console.error("demo: limiter failure");
    return unavailable();
  }

  try {
    const { id } = await deps.createSandbox();
    const wsdlUrl = `${deps.origin}/api/gravewood/${id}/wsdl`;
    // Requirement 2.3: summon nothing that is not one of our own sandboxes.
    if (!isDemoService({ wsdlUrl })) {
      console.error("demo: sandbox URL is not a demo URL");
      return unavailable();
    }

    const result = await deps.summon(JSON.stringify({ wsdlUrl }), deps.origin);
    if (result.status === 503) return unavailable();
    const body = result.body;
    if (
      result.status !== 200 ||
      !isRecord(body) ||
      typeof body.id !== "string" ||
      typeof body.ownerToken !== "string"
    ) {
      return summonFailed();
    }
    return Response.json(
      { serviceId: body.id, ownerToken: body.ownerToken, sandboxId: id },
      { status: 200, headers: NO_STORE },
    );
  } catch {
    console.error("demo: bootstrap failed");
    return unavailable();
  }
}
