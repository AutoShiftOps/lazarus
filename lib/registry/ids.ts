// Dependency-free service id helpers. Safe to import from client components.

export const ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const ID_LENGTH = 8;
export const ID_PATTERN = /^[A-Za-z0-9]{8,12}$/;

/** True when `id` has the shape of a registry service id. Does not touch Redis. */
export function isServiceId(id: string): boolean {
  return ID_PATTERN.test(id);
}
