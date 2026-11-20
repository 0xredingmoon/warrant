import { EXPLORER } from "./config";

export const short = (a: string, n = 4) => `${a.slice(0, 2 + n)}…${a.slice(-n)}`;
export const txLink = (h: string) => `${EXPLORER}/tx/${h}`;
export const addrLink = (a: string) => `${EXPLORER}/address/${a}`;

export function duration(seconds: number): string {
  const s = Math.abs(Math.round(seconds));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}

export function until(unix: number, now = Date.now() / 1000): string {
  const d = unix - now;
  return d >= 0 ? `in ${duration(d)}` : `${duration(d)} ago`;
}

export const dateTime = (unix: number) =>
  new Date(unix * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function pct(part: bigint, whole: bigint): number {
  if (whole === 0n) return 0;
  return Math.min(100, Number((part * 10000n) / whole) / 100);
}

/** "12" or "12.5" -> wallet-friendly input filter: digits and one dot, at most 6 decimals */
export const cleanAmount = (v: string) => {
  const t = v.replace(/[^\d.]/g, "");
  const [i, ...rest] = t.split(".");
  return rest.length ? `${i}.${rest.join("").slice(0, 6)}` : (i ?? "");
};
