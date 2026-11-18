import { isServiceId } from "../registry/ids";

export type SummonOutcome =
  | { ok: true; serviceId: string; ownerToken?: string }
  | { ok: false; message: string };

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export const MAX_MESSAGE_LENGTH = 300;
export const MSG_RATE_LIMITED = "The spirits are tired. Please wait a little and try again.";
export const MSG_GENERIC = "The spirits could not be raised. Please try again in a moment.";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

function failure(message: string): { ok: false; message: string } {
  return { ok: false, message };
}

function interpret(res: Response, body: unknown, idField: "id" | "serviceId"): SummonOutcome {
  if (res.status === 429) return failure(MSG_RATE_LIMITED);
  if (!res.ok) {
    const err = isRecord(body) ? body.error : undefined;
    if (typeof err === "string" && err.trim().length > 0) {
      return failure(err.trim().slice(0, MAX_MESSAGE_LENGTH));
    }
    return failure(MSG_GENERIC);
  }
  if (!isRecord(body)) return failure(MSG_GENERIC);
  const id = body[idField];
  if (typeof id !== "string" || !isServiceId(id)) return failure(MSG_GENERIC);
  const token = body.ownerToken;
  return typeof token === "string" && token.length > 0
    ? { ok: true, serviceId: id, ownerToken: token }
    : { ok: true, serviceId: id };
}

async function post(
  fetchFn: FetchFn,
  url: string,
  init: RequestInit,
  idField: "id" | "serviceId",
): Promise<SummonOutcome> {
  try {
    const res = await fetchFn(url, init);
    const body = res.status === 429 ? undefined : await readJson(res);
    return interpret(res, body, idField);
  } catch {
    return failure(MSG_GENERIC);
  }
}

/** Summons a WSDL via POST /api/summon. Never throws. */
export function summonWsdl(fetchFn: FetchFn, wsdlUrl: string): Promise<SummonOutcome> {
  return post(
    fetchFn,
    "/api/summon",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wsdlUrl }),
    },
    "id",
  );
}

/** Raises the Gravewood Bank demo via POST /api/demo. Never throws. */
export function raiseDemo(fetchFn: FetchFn): Promise<SummonOutcome> {
  return post(fetchFn, "/api/demo", { method: "POST" }, "serviceId");
}
