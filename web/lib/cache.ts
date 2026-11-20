// Tiny localStorage cache so a reload paints the last known vault straight away and refreshes behind it.
// bigint and Map survive the round trip; anything else is plain JSON.
const PREFIX = "warrant:cache:v1:";

const replacer = (_k: string, v: unknown) =>
  typeof v === "bigint" ? `bigint:${v}` : v instanceof Map ? { __map: [...v.entries()] } : v;
const reviver = (_k: string, v: unknown) =>
  typeof v === "string" && v.startsWith("bigint:") ? BigInt(v.slice(7)) : v && typeof v === "object" && "__map" in (v as object) ? new Map((v as { __map: [unknown, unknown][] }).__map) : v;

export function loadCache<T>(key: string): T | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw, reviver) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function saveCache(key: string, value: unknown) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value, replacer));
  } catch {
    /* storage full or blocked: the next load is just slower */
  }
}
