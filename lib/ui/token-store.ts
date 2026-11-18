import { isServiceId } from "../registry/ids";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;

function keyFor(serviceId: string): string {
  return `lazarus:owner:${serviceId}`;
}

/** Resolves the storage to use. Reading globalThis.localStorage can throw, so it is guarded. */
function resolve(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Returns the stored owner token, or null if missing, malformed or storage is unavailable. */
export function getOwnerToken(serviceId: string, storage?: Storage): string | null {
  if (!isServiceId(serviceId)) return null;
  try {
    const store = resolve(storage);
    if (!store) return null;
    const value = store.getItem(keyFor(serviceId));
    return typeof value === "string" && TOKEN_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Stores the owner token. Does nothing for invalid input or unavailable storage. */
export function setOwnerToken(serviceId: string, token: string, storage?: Storage): void {
  if (!isServiceId(serviceId) || !TOKEN_PATTERN.test(token)) return;
  try {
    resolve(storage)?.setItem(keyFor(serviceId), token);
  } catch {
    // storage blocked or full: ignore
  }
}

/** Removes the stored owner token. Never throws. */
export function clearOwnerToken(serviceId: string, storage?: Storage): void {
  if (!isServiceId(serviceId)) return;
  try {
    resolve(storage)?.removeItem(keyFor(serviceId));
  } catch {
    // storage blocked: ignore
  }
}
