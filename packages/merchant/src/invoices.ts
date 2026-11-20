import type { Db } from "@warrant/store";
import type { Address, Hex } from "viem";

/** What a 402 response carries. An agent pays `amount` tUSD8 to `payTo` quoting `ref` as the invoice reference. */
export interface Invoice {
  ref: Hex;
  /** decimal tUSD8, e.g. "0.15" */
  amount: string;
  asset: "tUSD8";
  token: Address;
  network: string;
  chainId: number;
  payTo: Address;
  description: string;
  resource: string;
  expiresAt: string;
}

export interface StoredInvoice {
  invoice: Invoice;
  /** atomic units */
  amount: bigint;
  /** unix seconds */
  expires: number;
  paidTx?: Hex;
  /** set once the resource was served for this invoice: an invoice buys one response */
  consumedAt?: number;
}

export interface InvoiceStore {
  put(s: StoredInvoice): void;
  get(ref: string): StoredInvoice | undefined;
  markPaid(ref: string, tx: Hex): void;
  /** atomically mark consumed; false if it already was */
  consume(ref: string, now?: number): boolean;
  /** delete invoices that expired unpaid more than `graceSeconds` ago */
  prune(now?: number, graceSeconds?: number): number;
}

/** Invoices in SQLite (survive a restart; `":memory:"` for tests). */
export class SqliteInvoiceStore implements InvoiceStore {
  constructor(private readonly db: Db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS invoices (
        ref TEXT PRIMARY KEY, invoice TEXT NOT NULL, amount TEXT NOT NULL, expires INTEGER NOT NULL,
        paid_tx TEXT, consumed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS invoices_expires ON invoices (expires);
    `);
  }

  put(s: StoredInvoice) {
    this.db
      .prepare("INSERT INTO invoices (ref, invoice, amount, expires, paid_tx, consumed_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(s.invoice.ref.toLowerCase(), JSON.stringify(s.invoice), s.amount.toString(), s.expires, s.paidTx ?? null, s.consumedAt ?? null);
  }

  get(ref: string): StoredInvoice | undefined {
    const r = this.db.prepare("SELECT * FROM invoices WHERE ref = ?").get(ref.toLowerCase()) as any;
    if (!r) return undefined;
    return {
      invoice: JSON.parse(r.invoice),
      amount: BigInt(r.amount),
      expires: r.expires,
      paidTx: r.paid_tx ?? undefined,
      consumedAt: r.consumed_at ?? undefined,
    };
  }

  markPaid(ref: string, tx: Hex) {
    this.db.prepare("UPDATE invoices SET paid_tx = ? WHERE ref = ?").run(tx, ref.toLowerCase());
  }

  consume(ref: string, now = Math.floor(Date.now() / 1000)): boolean {
    const r = this.db.prepare("UPDATE invoices SET consumed_at = ? WHERE ref = ? AND consumed_at IS NULL").run(now, ref.toLowerCase());
    return Number(r.changes) === 1;
  }

  prune(now = Math.floor(Date.now() / 1000), graceSeconds = 86_400): number {
    const r = this.db.prepare("DELETE FROM invoices WHERE paid_tx IS NULL AND expires < ?").run(now - graceSeconds);
    return Number(r.changes);
  }
}
