// lib/safety/transcript.ts
// Redis-backed transcripts. No Redis or env access at import time: the caller injects the client.
//
// List at `transcripts:{svc}`, newest first (LPUSH), capped at 200 items, TTL 30 days.
// Each item is a JSON string of a TranscriptEntry that was already redacted on the way in.

import { redactJson, redactXml, truncate } from "./redact";
import type { TranscriptEntry } from "./types";

const LIST_TTL_SECONDS = 2_592_000; // 30 days
const LIST_MAX = 200;
const LIST_RETURN_MAX = 100;
const SOAP_MAX = 8192; // UTF-16 units
const SUMMARY_MAX = 500;
const STORE_ERROR_MESSAGE = "Transcript store unavailable.";
const UNSERIALISABLE_SUMMARY = "unserialisable entry";

/** Minimal Redis surface used by transcripts (matches the @upstash/redis client methods). */
export interface TranscriptRedis {
  lpush(key: string, ...elements: string[]): Promise<unknown>;
  ltrim(key: string, start: number, stop: number): Promise<unknown>;
  lrange(key: string, start: number, stop: number): Promise<unknown[]>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface Transcripts {
  appendTranscript(svc: string, entry: TranscriptEntry): Promise<void>;
  /** Newest first, at most 100. `since` is an ISO string; only entries strictly after it are kept. */
  listTranscripts(svc: string, since?: string): Promise<TranscriptEntry[]>;
}

const listKey = (svc: string): string => `transcripts:${svc}`;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function redactSoap(v: unknown): string | undefined {
  return typeof v === "string" ? truncate(redactXml(v), SOAP_MAX) : undefined;
}

/** Redacts and bounds an entry. Redaction always runs before truncation. */
function sanitize(entry: TranscriptEntry): TranscriptEntry {
  const out: TranscriptEntry = {
    ...entry,
    args: redactJson(entry.args),
    summary: truncate(typeof entry.summary === "string" ? entry.summary : "", SUMMARY_MAX),
  };
  const req = redactSoap(entry.soapRequest);
  const res = redactSoap(entry.soapResponse);
  if (req === undefined) delete out.soapRequest;
  else out.soapRequest = req;
  if (res === undefined) delete out.soapResponse;
  else out.soapResponse = res;
  return out;
}

function minimalEntry(entry: TranscriptEntry): TranscriptEntry {
  return {
    id: String(entry.id),
    ts: String(entry.ts),
    tool: String(entry.tool),
    args: null,
    risk: entry.risk,
    decision: entry.decision,
    outcome: entry.outcome,
    durationMs: Number.isFinite(entry.durationMs) ? entry.durationMs : 0,
    summary: UNSERIALISABLE_SUMMARY,
  };
}

function serialise(entry: TranscriptEntry): string {
  try {
    const json = JSON.stringify(sanitize(entry));
    if (typeof json === "string") return json;
  } catch {
    // fall through to the minimal entry
  }
  try {
    return JSON.stringify(minimalEntry(entry));
  } catch {
    return JSON.stringify({
      id: "",
      ts: "",
      tool: "",
      args: null,
      risk: "read",
      decision: "allow",
      outcome: "error",
      durationMs: 0,
      summary: UNSERIALISABLE_SUMMARY,
    });
  }
}

/** Parses one stored item (string, or an object when the client already deserialised it). */
function fromStored(raw: unknown): TranscriptEntry | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (
    !isRecord(v) ||
    typeof v.id !== "string" ||
    typeof v.ts !== "string" ||
    typeof v.tool !== "string" ||
    typeof v.summary !== "string"
  ) {
    return null;
  }
  // Redact again on read: stored data is not trusted to be clean.
  return sanitize(v as unknown as TranscriptEntry);
}

export function createTranscripts(redis: TranscriptRedis): Transcripts {
  /** Any Redis failure becomes one fixed-message Error; upstream text is dropped. */
  async function guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      throw new Error(STORE_ERROR_MESSAGE);
    }
  }

  return {
    appendTranscript: (svc, entry) =>
      guard(async () => {
        const key = listKey(svc);
        await redis.lpush(key, serialise(entry));
        await redis.ltrim(key, 0, LIST_MAX - 1);
        await redis.expire(key, LIST_TTL_SECONDS);
      }),

    listTranscripts: (svc, since) =>
      guard(async () => {
        const sinceMs = since === undefined ? Number.NaN : Date.parse(since);
        const items = await redis.lrange(listKey(svc), 0, LIST_MAX - 1);
        const out: TranscriptEntry[] = [];
        for (const item of items) {
          const e = fromStored(item);
          if (!e) continue;
          if (!Number.isNaN(sinceMs)) {
            const t = Date.parse(e.ts);
            if (Number.isNaN(t) || t <= sinceMs) continue;
          }
          out.push(e);
          if (out.length >= LIST_RETURN_MAX) break;
        }
        return out;
      }),
  };
}
