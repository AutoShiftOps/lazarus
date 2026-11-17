// lib/owner-token.ts
// Owner tokens: a random secret returned once at creation; only its SHA-256 hash is stored.

import { timingSafeEqual } from "node:crypto";
import type { ServiceDefinition } from "./soap/types";

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function toHex(buf: ArrayBuffer): string {
  return Buffer.from(buf).toString("hex");
}

export async function hashOwnerToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(digest);
}

export async function generateOwnerToken(): Promise<{ token: string; hash: string }> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = toBase64Url(bytes);
  return { token, hash: await hashOwnerToken(token) };
}

export async function verifyOwnerToken(token: string, hash: string): Promise<boolean> {
  if (typeof token !== "string" || typeof hash !== "string") return false;
  const actual = Buffer.from(await hashOwnerToken(token), "utf8");
  const expected = Buffer.from(hash, "utf8");
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** Copy of the definition without the owner token hash. Use before any serialisation. */
export function publicDefinition(def: ServiceDefinition): Omit<ServiceDefinition, "ownerTokenHash"> {
  const { ownerTokenHash: _omit, ...rest } = def;
  void _omit;
  return structuredClone(rest);
}
