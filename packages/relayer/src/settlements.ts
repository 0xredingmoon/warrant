import type { Db } from "@warrant/store";

export type SettlementStatus = "settled" | "queued" | "refused" | "failed";

export interface Settlement {
  key: string;
  vault: string;
  merchant: string;
  invoiceRef: string;
  amount: string;
  payer: string;
  status: SettlementStatus;
  txHash: string | null;
  pendingId: string | null;
  queueBlock: string | null;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}

/** x402 settlements by (vault, mandate, nonce): makes /settle idempotent across retries and restarts. */
export class SettlementStore {
  constructor(private readonly db: Db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS settlements (
        key TEXT PRIMARY KEY, vault TEXT NOT NULL, merchant TEXT NOT NULL, invoice_ref TEXT NOT NULL,
        amount TEXT NOT NULL, payer TEXT NOT NULL, status TEXT NOT NULL, tx_hash TEXT, pending_id TEXT,
        queue_block TEXT, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
    `);
  }

  static key(vault: string, mandateId: bigint | string, nonce: string) {
    return `${vault}:${mandateId}:${nonce}`.toLowerCase();
  }

  get(key: string): Settlement | undefined {
    const r = this.db.prepare("SELECT * FROM settlements WHERE key = ?").get(key) as any;
    if (!r) return undefined;
    return {
      key: r.key,
      vault: r.vault,
      merchant: r.merchant,
      invoiceRef: r.invoice_ref,
      amount: r.amount,
      payer: r.payer,
      status: r.status,
      txHash: r.tx_hash,
      pendingId: r.pending_id,
      queueBlock: r.queue_block,
      reason: r.reason,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  put(s: Omit<Settlement, "createdAt" | "updatedAt">, now = Date.now()) {
    this.db
      .prepare(
        `INSERT INTO settlements (key, vault, merchant, invoice_ref, amount, payer, status, tx_hash, pending_id, queue_block, reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET status = excluded.status, tx_hash = excluded.tx_hash, pending_id = excluded.pending_id,
           queue_block = excluded.queue_block, reason = excluded.reason, updated_at = excluded.updated_at`,
      )
      .run(s.key, s.vault, s.merchant, s.invoiceRef, s.amount, s.payer, s.status, s.txHash, s.pendingId, s.queueBlock, s.reason, now, now);
  }
}
