import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";

// Loaded through require: bundlers and vitest strip the `node:` prefix from static imports, and `sqlite` alone does not exist.
const { DatabaseSync: Sqlite } = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");

export type Db = DatabaseSync;

/**
 * Open (and create) a SQLite database. `":memory:"` gives a throwaway one for tests.
 * Uses WAL so a reader (a CLI inspecting the file) never blocks the server, and waits a few seconds on a locked file
 * instead of failing.
 */
export function openDb(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Sqlite(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA synchronous = NORMAL;");
  return db;
}

/** Run `fn` inside BEGIN IMMEDIATE ... COMMIT (rolls back if it throws). Synchronous, so it is atomic in one process. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * Sliding-window rate limiter and counters kept in SQLite, so limits survive a restart and are shared by every
 * process that opens the same file.
 */
export class RateStore {
  constructor(private readonly db: Db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rate_hits (scope TEXT NOT NULL, key TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS rate_hits_idx ON rate_hits (scope, key, ts);
      CREATE TABLE IF NOT EXISTS counters (name TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (name, day));
    `);
  }

  /** Record a hit and return true if `key` has had fewer than `limit` hits in the last `windowMs`. */
  take(scope: string, key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    return transaction(this.db, () => {
      this.db.prepare("DELETE FROM rate_hits WHERE scope = ? AND key = ? AND ts <= ?").run(scope, key, now - windowMs);
      const row = this.db.prepare("SELECT COUNT(*) AS n FROM rate_hits WHERE scope = ? AND key = ?").get(scope, key) as { n: number };
      if (row.n >= limit) return false;
      this.db.prepare("INSERT INTO rate_hits (scope, key, ts) VALUES (?, ?, ?)").run(scope, key, now);
      return true;
    });
  }

  /** Count a unit against a per-UTC-day budget. Returns false (and counts nothing) once `cap` is reached. */
  takeDaily(name: string, cap: number, now = Date.now()): boolean {
    const day = new Date(now).toISOString().slice(0, 10);
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT n FROM counters WHERE name = ? AND day = ?").get(name, day) as { n: number } | undefined;
      const n = row?.n ?? 0;
      if (n >= cap) return false;
      this.db.prepare("INSERT INTO counters (name, day, n) VALUES (?, ?, 1) ON CONFLICT (name, day) DO UPDATE SET n = n + 1").run(name, day);
      return true;
    });
  }

  today(name: string, now = Date.now()): number {
    const day = new Date(now).toISOString().slice(0, 10);
    const row = this.db.prepare("SELECT n FROM counters WHERE name = ? AND day = ?").get(name, day) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /** Delete hits older than `olderThanMs` (call now and then). */
  prune(olderThanMs = 24 * 3600_000, now = Date.now()): void {
    this.db.prepare("DELETE FROM rate_hits WHERE ts <= ?").run(now - olderThanMs);
    this.db.prepare("DELETE FROM counters WHERE day < ?").run(new Date(now - 3 * 24 * 3600_000).toISOString().slice(0, 10));
  }
}
