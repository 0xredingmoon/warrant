import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RateStore, openDb, openDbWithFallback } from "../src";

describe("RateStore", () => {
  it("limits per key inside a sliding window and frees up afterwards", () => {
    const rs = new RateStore(openDb(":memory:"));
    const t = 1_000_000;
    expect([1, 2, 3].map(() => rs.take("ip", "a", 3, 60_000, t))).toEqual([true, true, true]);
    expect(rs.take("ip", "a", 3, 60_000, t + 1)).toBe(false);
    expect(rs.take("ip", "b", 3, 60_000, t + 1)).toBe(true); // other key unaffected
    expect(rs.take("vault", "a", 3, 60_000, t + 1)).toBe(true); // other scope unaffected
    expect(rs.take("ip", "a", 3, 60_000, t + 60_001)).toBe(true); // window slid
  });

  it("counts a daily budget per UTC day", () => {
    const rs = new RateStore(openDb(":memory:"));
    const day1 = Date.UTC(2026, 10, 20, 23, 59);
    expect([rs.takeDaily("tx", 2, day1), rs.takeDaily("tx", 2, day1), rs.takeDaily("tx", 2, day1)]).toEqual([true, true, false]);
    expect(rs.today("tx", day1)).toBe(2);
    expect(rs.takeDaily("tx", 2, day1 + 120_000)).toBe(true); // next UTC day
  });

  it("survives a restart: a second connection to the same file sees the same state", () => {
    const dir = mkdtempSync(join(tmpdir(), "warrant-store-"));
    try {
      const file = join(dir, "nested", "r.db");
      const a = openDb(file);
      const r1 = new RateStore(a);
      const t = Date.now();
      r1.take("ip", "x", 1, 60_000, t);
      r1.takeDaily("tx", 1, t);
      a.close();
      const b = openDb(file);
      const r2 = new RateStore(b);
      expect(r2.take("ip", "x", 1, 60_000, t + 10)).toBe(false);
      expect(r2.takeDaily("tx", 1, t)).toBe(false);
      b.close(); // Windows keeps an open SQLite file locked, so the temp dir cannot be removed until every handle is closed
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
  it("falls back to /tmp or memory when the requested path is not writable", () => {
    const dir = mkdtempSync(join(tmpdir(), "warrant-store-ro-"));
    try {
      const blocked = join(dir, "blocked");
      mkdirSync(blocked, { mode: 0o500 });
      // Windows ignores POSIX mode bits, so a 0500 directory stays writable and the fallback would never be reached.
      // Handing in a directory path instead makes the first candidate fail on every platform: openDb cannot create
      // the database on top of an existing directory.
      const unwritable = process.platform === "win32" ? blocked : join(blocked, "r.db");
      const { db, path } = openDbWithFallback(unwritable);
      expect(path === "/tmp/relayer.db" || path === ":memory:").toBe(true);
      const rates = new RateStore(db);
      expect(rates.take("ip", `fallback-${Date.now()}-${Math.random()}`, 1, 60_000)).toBe(true);
      db.close();
    } finally {
      chmodSync(join(dir, "blocked"), 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });
