import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export type SettlementStatus = 'pending' | 'settled' | 'failed'

export interface SettlementRow {
  id: string
  network: string
  payer: string
  pay_to: string
  amount: string
  nonce: string
  tx_hash: string | null
  status: SettlementStatus
  reason: string | null
  created_at: number
  updated_at: number
}

/**
 * Idempotent settlement ledger backed by SQLite (`node:sqlite`, no native
 * dependency). The unique key `(network, payer, nonce)` maps 1:1 to an EIP-3009
 * authorization, so a retried `/settle` for the same signed payment returns the
 * original transaction instead of broadcasting twice.
 */
export class Ledger {
  private readonly db: DatabaseSync

  constructor(path: string, clock: () => number = () => Date.now()) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.clock = clock
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settlements (
        id         TEXT PRIMARY KEY,
        network    TEXT NOT NULL,
        payer      TEXT NOT NULL,
        pay_to     TEXT NOT NULL,
        amount     TEXT NOT NULL,
        nonce      TEXT NOT NULL,
        tx_hash    TEXT,
        status     TEXT NOT NULL,
        reason     TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (network, payer, nonce)
      );
      CREATE INDEX IF NOT EXISTS idx_settlements_status ON settlements(status);
    `)
  }

  private readonly clock: () => number

  static key(network: string, payer: string, nonce: string): string {
    return `${network}:${payer.toLowerCase()}:${nonce.toLowerCase()}`
  }

  find(network: string, payer: string, nonce: string): SettlementRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM settlements WHERE id = ?')
      .get(Ledger.key(network, payer, nonce))
    return row as SettlementRow | undefined
  }

  /**
   * Atomically claim a settlement slot. Returns `{ claimed: true }` if this
   * caller now owns the broadcast, or `{ claimed: false, existing }` if another
   * request already recorded this authorization.
   */
  claim(input: {
    network: string
    payer: string
    payTo: string
    amount: string
    nonce: string
  }): { claimed: true } | { claimed: false; existing: SettlementRow } {
    const id = Ledger.key(input.network, input.payer, input.nonce)
    const now = this.clock()
    try {
      this.db
        .prepare(
          `INSERT INTO settlements (id, network, payer, pay_to, amount, nonce, tx_hash, status, reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 'pending', NULL, ?, ?)`,
        )
        .run(
          id,
          input.network,
          input.payer.toLowerCase(),
          input.payTo.toLowerCase(),
          input.amount,
          input.nonce.toLowerCase(),
          now,
          now,
        )
      return { claimed: true }
    } catch {
      // UNIQUE violation — someone already claimed it.
      const existing = this.db.prepare('SELECT * FROM settlements WHERE id = ?').get(id)
      return { claimed: false, existing: existing as SettlementRow }
    }
  }

  markSettled(network: string, payer: string, nonce: string, txHash: string): void {
    this.db
      .prepare(
        `UPDATE settlements SET status = 'settled', tx_hash = ?, reason = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(txHash, this.clock(), Ledger.key(network, payer, nonce))
  }

  markFailed(network: string, payer: string, nonce: string, reason: string): void {
    this.db
      .prepare(`UPDATE settlements SET status = 'failed', reason = ?, updated_at = ? WHERE id = ?`)
      .run(reason, this.clock(), Ledger.key(network, payer, nonce))
  }

  /** Aggregate counters for the metrics endpoint. */
  counts(): Record<SettlementStatus, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) as n FROM settlements GROUP BY status')
      .all() as Array<{ status: SettlementStatus; n: number }>
    const out: Record<SettlementStatus, number> = { pending: 0, settled: 0, failed: 0 }
    for (const r of rows) out[r.status] = r.n
    return out
  }

  /** Total USDG settled, in atomic units, as a string. */
  totalSettledAtomic(): string {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(CAST(amount AS INTEGER)), 0) as total FROM settlements WHERE status = 'settled'`)
      .get() as { total: number | bigint }
    return String(row.total)
  }

  close(): void {
    this.db.close()
  }
}
