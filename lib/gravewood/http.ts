// lib/gravewood/http.ts
// Framework-free request logic for the Gravewood routes. Routes are thin
// wrappers that turn the plain result into a Response.

import { handleSoap } from "./handler";
import { store as defaultStore, type GwStore } from "./store";
import { buildWsdl } from "./wsdl";
import { buildFault } from "./xml";

export type HttpResult = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type HttpDeps = { store?: GwStore };

export const MAX_SOAP_BYTES = 65536;

const XML = "text/xml; charset=utf-8";
const JSON_TYPE = "application/json; charset=utf-8";
const UNAVAILABLE = "The bank is temporarily unavailable.";
const NOT_FOUND_TEXT = "Sandbox not found or expired.";

function json(
  status: number,
  data: Record<string, unknown>,
  extra: Record<string, string> = {},
): HttpResult {
  return {
    status,
    headers: { "Content-Type": JSON_TYPE, "Cache-Control": "no-store", ...extra },
    body: JSON.stringify(data),
  };
}

function fault(
  status: number,
  kind: "Client" | "Server",
  message: string,
  extra: Record<string, string> = {},
): HttpResult {
  return {
    status,
    headers: { "Content-Type": XML, "Cache-Control": "no-store", ...extra },
    body: buildFault(kind, message),
  };
}

function retryHeader(retryAfter: number): Record<string, string> {
  const n = Number.isFinite(retryAfter) ? Math.max(1, Math.ceil(retryAfter)) : 1;
  return { "Retry-After": String(n) };
}

/** Logs only a short label and the error name, never the message. */
function logFailure(label: string, e: unknown): void {
  console.error(`gravewood ${label} failed:`, e instanceof Error ? e.name : "unknown");
}

type HeaderLike = { get(name: string): string | null };

/** First x-forwarded-for value, else x-real-ip, else "unknown". */
export function clientIp(headers: HeaderLike): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd !== null) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip")?.trim();
  return real ? real : "unknown";
}

/** True when a declared content-length exceeds the SOAP size cap. */
export function declaredTooLarge(headers: HeaderLike): boolean {
  const raw = headers.get("content-length");
  if (raw === null) return false;
  const n = Number(raw);
  return Number.isFinite(n) && n > MAX_SOAP_BYTES;
}

/** The 413 response shared by the header check and the actual-size check. */
export function requestTooLarge(): HttpResult {
  return fault(413, "Client", "Request too large");
}

export async function createSandboxHttp(
  ip: string,
  origin: string,
  deps: HttpDeps = {},
): Promise<HttpResult> {
  const s = deps.store ?? defaultStore;
  try {
    const rate = await s.allowCreate(ip);
    if (!rate.allowed) {
      return json(
        429,
        { error: "Too many requests. Try again later.", code: "RATE_LIMITED" },
        retryHeader(rate.retryAfter),
      );
    }
    const { id, expiresAt } = await s.createSandbox();
    return json(201, {
      sandboxId: id,
      wsdlUrl: `${origin}/api/gravewood/${id}/wsdl`,
      expiresAt,
    });
  } catch (e) {
    logFailure("create", e);
    return json(503, { error: UNAVAILABLE, code: "UNAVAILABLE" });
  }
}

export async function wsdlHttp(
  id: string,
  origin: string,
  deps: HttpDeps = {},
): Promise<HttpResult> {
  const s = deps.store ?? defaultStore;
  try {
    const state = await s.loadState(id);
    if (state === null) {
      return {
        status: 404,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
        body: NOT_FOUND_TEXT,
      };
    }
    return {
      status: 200,
      headers: { "Content-Type": XML, "Cache-Control": "no-store" },
      body: buildWsdl(`${origin}/api/gravewood/${id}`),
    };
  } catch (e) {
    logFailure("wsdl", e);
    return {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      body: UNAVAILABLE,
    };
  }
}

export async function soapHttp(
  id: string,
  soapActionHeader: string | null,
  bodyText: string,
  deps: HttpDeps = {},
): Promise<HttpResult> {
  const s = deps.store ?? defaultStore;
  try {
    if (Buffer.byteLength(bodyText, "utf8") > MAX_SOAP_BYTES) return requestTooLarge();

    const rate = await s.allowCall(id);
    if (!rate.allowed) {
      return fault(429, "Client", "Too many requests", retryHeader(rate.retryAfter));
    }

    const state = await s.loadState(id);
    if (state === null) return fault(404, "Client", "Sandbox not found or expired");

    const run = await s.runOnSandbox(id, (cur) => {
      const r = handleSoap(cur, soapActionHeader, bodyText, new Date().toISOString());
      return { state: r.state, response: r };
    });

    if (run.ok) {
      return {
        status: run.response.status,
        headers: { "Content-Type": XML, "Cache-Control": "no-store" },
        body: run.response.xml,
      };
    }
    switch (run.reason) {
      case "conflict":
        return fault(500, "Server", "Please retry");
      case "too-large":
        return fault(500, "Server", "Sandbox is full. Reset it to continue.");
      case "not-found":
        return fault(404, "Client", "Sandbox not found or expired");
      case "unavailable":
        return fault(503, "Server", UNAVAILABLE);
    }
  } catch (e) {
    logFailure("soap", e);
    return fault(503, "Server", UNAVAILABLE);
  }
}

export async function resetHttp(id: string, deps: HttpDeps = {}): Promise<HttpResult> {
  const s = deps.store ?? defaultStore;
  try {
    const rate = await s.allowCall(id);
    if (!rate.allowed) {
      return json(
        429,
        { error: "Too many requests. Try again later.", code: "RATE_LIMITED" },
        retryHeader(rate.retryAfter),
      );
    }
    const ok = await s.resetSandbox(id);
    if (!ok) return json(404, { error: NOT_FOUND_TEXT, code: "NOT_FOUND" });
    return json(200, { reset: true });
  } catch (e) {
    logFailure("reset", e);
    return json(503, { error: UNAVAILABLE, code: "UNAVAILABLE" });
  }
}

/** Converts a plain result into a web Response. */
export function toResponse(r: HttpResult): Response {
  return new Response(r.body, { status: r.status, headers: r.headers });
}
