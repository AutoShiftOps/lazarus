/** Still mode: the visitor's choice to switch decorative motion off. Pure logic, storage is injected. */

export const STILL_STORAGE_KEY = "lazarus:still";

export interface StillStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Reads the saved choice. Missing, blocked or throwing storage means "not still". */
export function getStill(storage: StillStorage | null | undefined): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(STILL_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** Saves the choice. Returns false when storage is missing or refuses the write. */
export function setStill(storage: StillStorage | null | undefined, still: boolean): boolean {
  if (!storage) return false;
  try {
    storage.setItem(STILL_STORAGE_KEY, still ? "true" : "false");
    return true;
  } catch {
    return false;
  }
}

/** Resolves `window.localStorage` without throwing (access itself can throw when blocked). */
export function browserStorage(): StillStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Runs in <head> before first paint so a saved Still mode never flashes. */
export const STILL_INIT_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(
  STILL_STORAGE_KEY,
)})==="true")document.documentElement.setAttribute("data-still","true")}catch(e){}`;
