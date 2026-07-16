import type { Address, Hex } from 'viem'
import { DUST_MODULUS, DUST_SLOTS, randomDust } from '../reference.js'
import type { HoodPayNetwork } from '../networks.js'
import type { MatchedTransfer, PaymentStatus } from './types.js'

/**
 * Idempotent merchant ledger on SQLite (`node:sqlite`, zero native deps;
 * Node >= 22.5 - on Node 22 start with `--experimental-sqlite`).
 *
 * Guarantees:
 * - **Idempotent event recording**: `(txHash, logIndex)` is the primary key
 *   of the transfers table, so replaying a webhook, re-running a watcher, or
 *   double-processing a poll can never double-credit an invoice.
 * - **Monotonic status transitions**: an invoice can only move forward
 *   (pending -> underpaid -> paid -> overpaid -> refunded; expired only from
 *   pending/underpaid). A stale writer can never un-pay an invoice.
 * - **Atomic dust reservation** (direct mode): a partial UNIQUE index over
 *   pending invoices on `(payTo, token, expectedRaw)` means two concurrent
 *   invoices at the same base price can never hold the same fingerprinted
 *   amount - collisions are impossible by construction, not by probability.
 */

const STATUS_RANK: Record<PaymentStatus, number> = {
  pending: 0,
  expired: 1,
  underpaid: 2,
  paid: 3,
  overpaid: 4,
  refunded: 5,
}

/** A ledger row. */
export interface LedgerInvoice {
  id: string
  network: HoodPayNetwork
  payTo: Address
  token: Address
  /** Raw units expected, dust included for direct mode. */
  expectedRaw: bigint
  /** Direct-mode dust component of expectedRaw (0n for router mode). */
  dust: bigint
  reference?: Hex
  memo?: string
  status: PaymentStatus
  payer?: Address
  receivedRaw: bigint
  createdAt: number
  updatedAt: number
}

export interface CreateDirectInvoiceInput {
  network: HoodPayNetwork
  payTo: Address
  token: Address
  /** Raw base amount; its low 4 decimal digits must be zero (see reference scheme). */
  baseRaw: bigint
  memo?: string
}

export interface CreateRouterInvoiceInput {
  network: HoodPayNetwork
  payTo: Address
  token: Address
  expectedRaw: bigint
  reference: Hex
  memo?: string
}

export interface WebhookDeliveryRecord {
  paymentId: string
  event: string
  ok: boolean
  attempts: number
  lastError?: string
}

export interface Ledger {
  /** Reserve a unique fingerprinted amount and open a direct-mode invoice. */
  createDirectInvoice(input: CreateDirectInvoiceInput): LedgerInvoice
  /** Open a router-mode invoice keyed by its reference. */
  createRouterInvoice(input: CreateRouterInvoiceInput): LedgerInvoice
  getInvoice(id: string): LedgerInvoice | undefined
  /**
   * Credit an on-chain event to an invoice. Returns the refreshed invoice,
   * or `undefined` when the event was already recorded (idempotent replay).
   */
  recordTransfer(id: string, transfer: MatchedTransfer): LedgerInvoice | undefined
  /** Move an invoice's status forward. Backward transitions are ignored. */
  setStatus(id: string, status: PaymentStatus): LedgerInvoice
  /** List invoices, newest first. */
  listInvoices(limit?: number): LedgerInvoice[]
  /** Record the outcome of a webhook delivery attempt. */
  recordWebhookDelivery(record: WebhookDeliveryRecord): void
  close(): void
}

interface SqliteStatement {
  run(...args: unknown[]): { changes: number | bigint }
  get(...args: unknown[]): unknown
  all(...args: unknown[]): unknown[]
}
interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): SqliteStatement
  close(): void
}

interface InvoiceRow {
  id: string
  network: string
  pay_to: string
  token: string
  expected_raw: string
  dust: string
  reference: string | null
  memo: string | null
  status: string
  payer: string | null
  received_raw: string
  created_at: number
  updated_at: number
}

function rowToInvoice(row: InvoiceRow): LedgerInvoice {
  const invoice: LedgerInvoice = {
    id: row.id,
    network: row.network as HoodPayNetwork,
    payTo: row.pay_to as Address,
    token: row.token as Address,
    expectedRaw: BigInt(row.expected_raw),
    dust: BigInt(row.dust),
    status: row.status as PaymentStatus,
    receivedRaw: BigInt(row.received_raw),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
  if (row.reference) invoice.reference = row.reference as Hex
  if (row.memo !== null) invoice.memo = row.memo
  if (row.payer) invoice.payer = row.payer as Address
  return invoice
}

/**
 * Open (or create) a ledger database. `path` may be `':memory:'` for tests.
 * Async because `node:sqlite` is imported lazily with a version-aware error.
 */
export async function createLedger(path: string): Promise<Ledger> {
  let DatabaseSync: new (path: string) => SqliteDatabase
  try {
    ;({ DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => SqliteDatabase
    })
  } catch {
    throw new Error(
      'hood-pay ledger needs the node:sqlite module (Node >= 23, or Node 22.5+ with --experimental-sqlite)',
    )
  }
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS invoices (
      id TEXT PRIMARY KEY,
      network TEXT NOT NULL,
      pay_to TEXT NOT NULL,
      token TEXT NOT NULL,
      expected_raw TEXT NOT NULL,
      dust TEXT NOT NULL DEFAULT '0',
      reference TEXT,
      memo TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      payer TEXT,
      received_raw TEXT NOT NULL DEFAULT '0',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_amount_reservation
      ON invoices (pay_to, token, expected_raw)
      WHERE status IN ('pending', 'underpaid') AND reference IS NULL;
    CREATE TABLE IF NOT EXISTS transfers (
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      invoice_id TEXT NOT NULL REFERENCES invoices(id),
      payer TEXT NOT NULL,
      amount_raw TEXT NOT NULL,
      block_number INTEGER NOT NULL,
      block_hash TEXT NOT NULL,
      PRIMARY KEY (tx_hash, log_index)
    );
    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id TEXT NOT NULL,
      event TEXT NOT NULL,
      ok INTEGER NOT NULL,
      attempts INTEGER NOT NULL,
      last_error TEXT,
      created_at INTEGER NOT NULL
    );
  `)

  const insertInvoice = db.prepare(
    `INSERT INTO invoices (id, network, pay_to, token, expected_raw, dust, reference, memo, status, received_raw, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', '0', ?, ?)`,
  )
  const selectInvoice = db.prepare('SELECT * FROM invoices WHERE id = ?')
  const selectAll = db.prepare('SELECT * FROM invoices ORDER BY created_at DESC, id DESC LIMIT ?')
  const insertTransfer = db.prepare(
    `INSERT OR IGNORE INTO transfers (tx_hash, log_index, invoice_id, payer, amount_raw, block_number, block_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  // Amounts are summed in JS as BigInt: 18-decimal tokens overflow SQLite's
  // 64-bit integers, so SUM() in SQL would silently lose precision.
  const listTransferAmounts = db.prepare('SELECT amount_raw FROM transfers WHERE invoice_id = ?')
  const updateReceived = db.prepare(
    'UPDATE invoices SET received_raw = ?, payer = COALESCE(payer, ?), status = ?, updated_at = ? WHERE id = ?',
  )
  const updateStatus = db.prepare('UPDATE invoices SET status = ?, updated_at = ? WHERE id = ?')
  const insertDelivery = db.prepare(
    'INSERT INTO webhook_deliveries (invoice_id, event, ok, attempts, last_error, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  )

  function mustGet(id: string): LedgerInvoice {
    const row = selectInvoice.get(id) as InvoiceRow | undefined
    if (!row) throw new RangeError(`unknown invoice "${id}"`)
    return rowToInvoice(row)
  }

  function statusFor(expected: bigint, received: bigint, current: PaymentStatus): PaymentStatus {
    let next: PaymentStatus = current
    if (received > 0n) {
      next = received < expected ? 'underpaid' : received === expected ? 'paid' : 'overpaid'
    }
    return STATUS_RANK[next] > STATUS_RANK[current] ? next : current
  }

  return {
    createDirectInvoice(input) {
      if (input.baseRaw <= 0n) throw new RangeError('baseRaw must be positive')
      if (input.baseRaw % DUST_MODULUS !== 0n) {
        throw new RangeError('baseRaw must leave the low 4 decimal digits free for the fingerprint')
      }
      const now = Date.now()
      // Atomic reservation: the partial unique index rejects a duplicate
      // (payTo, token, expectedRaw) among open direct invoices; retry with
      // fresh dust until a free slot is found.
      for (let attempt = 0; attempt < DUST_SLOTS; attempt++) {
        const dust = randomDust()
        const expected = input.baseRaw + dust
        const id = `hp_${crypto.randomUUID().replaceAll('-', '')}`
        try {
          insertInvoice.run(
            id,
            input.network,
            input.payTo,
            input.token,
            expected.toString(),
            dust.toString(),
            null,
            input.memo ?? null,
            now,
            now,
          )
          return mustGet(id)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!message.includes('UNIQUE')) throw error
        }
      }
      throw new RangeError(
        `all ${DUST_SLOTS} fingerprint slots for this (payTo, token, amount) are reserved by open invoices; ` +
          'settle or expire some, or switch to router mode',
      )
    },

    createRouterInvoice(input) {
      if (input.expectedRaw <= 0n) throw new RangeError('expectedRaw must be positive')
      const now = Date.now()
      insertInvoice.run(
        input.reference,
        input.network,
        input.payTo,
        input.token,
        input.expectedRaw.toString(),
        '0',
        input.reference,
        input.memo ?? null,
        now,
        now,
      )
      return mustGet(input.reference)
    },

    getInvoice(id) {
      const row = selectInvoice.get(id) as InvoiceRow | undefined
      return row ? rowToInvoice(row) : undefined
    },

    recordTransfer(id, transfer) {
      const invoice = mustGet(id)
      const inserted = insertTransfer.run(
        transfer.txHash,
        transfer.logIndex,
        id,
        transfer.payer,
        transfer.amountRaw.toString(),
        Number(transfer.blockNumber),
        transfer.blockHash,
      )
      if (Number(inserted.changes) === 0) return undefined // replay - already credited
      const total = (listTransferAmounts.all(id) as Array<{ amount_raw: string }>).reduce(
        (sum, row) => sum + BigInt(row.amount_raw),
        0n,
      )
      const next = statusFor(invoice.expectedRaw, total, invoice.status)
      updateReceived.run(total.toString(), transfer.payer, next, Date.now(), id)
      return mustGet(id)
    },

    setStatus(id, status) {
      const invoice = mustGet(id)
      if (STATUS_RANK[status] > STATUS_RANK[invoice.status]) {
        updateStatus.run(status, Date.now(), id)
      }
      return mustGet(id)
    },

    listInvoices(limit = 100) {
      return (selectAll.all(limit) as InvoiceRow[]).map(rowToInvoice)
    },

    recordWebhookDelivery(record) {
      insertDelivery.run(
        record.paymentId,
        record.event,
        record.ok ? 1 : 0,
        record.attempts,
        record.lastError ?? null,
        Date.now(),
      )
    },

    close() {
      db.close()
    },
  }
}
