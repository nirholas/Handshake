import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DecisionRecord, EquityPoint, TradeRecord } from './types.js'

/**
 * The decision journal — the agent's black box recorder. Every observe, every
 * refusal, every trade (paper or live), and every equity mark lands here so the
 * dashboard can answer "why did this trade fire?" and the whole run is auditable
 * after the fact.
 *
 * SQLite via better-sqlite3 (synchronous, zero-config, embedded). bigints are
 * stored as decimal TEXT — SQLite integers are 64-bit signed and token amounts
 * routinely exceed that, so TEXT is the only lossless option.
 */
export class Journal {
  private readonly db: Database.Database

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.migrate()
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        ts INTEGER NOT NULL,
        side TEXT NOT NULL,
        token TEXT NOT NULL,
        token_symbol TEXT NOT NULL,
        quote_token TEXT NOT NULL,
        quote_symbol TEXT NOT NULL,
        amount_in TEXT NOT NULL,
        amount_out TEXT NOT NULL,
        tx_hash TEXT,
        reason TEXT NOT NULL,
        slippage_bps INTEGER NOT NULL,
        gas_estimate TEXT NOT NULL,
        meta TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_trades_agent_ts ON trades(agent_id, ts);

      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        detail TEXT NOT NULL,
        meta TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_agent_ts ON decisions(agent_id, ts);

      CREATE TABLE IF NOT EXISTS equity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        realized_usd REAL NOT NULL,
        open_value_usd REAL NOT NULL,
        equity_usd REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_equity_agent_ts ON equity(agent_id, ts);
    `)
  }

  recordTrade(t: TradeRecord): number {
    const info = this.db
      .prepare(
        `INSERT INTO trades
          (agent_id, mode, ts, side, token, token_symbol, quote_token, quote_symbol,
           amount_in, amount_out, tx_hash, reason, slippage_bps, gas_estimate, meta)
         VALUES (@agent_id,@mode,@ts,@side,@token,@token_symbol,@quote_token,@quote_symbol,
           @amount_in,@amount_out,@tx_hash,@reason,@slippage_bps,@gas_estimate,@meta)`,
      )
      .run({
        agent_id: t.agentId,
        mode: t.mode,
        ts: t.ts,
        side: t.side,
        token: t.token,
        token_symbol: t.tokenSymbol,
        quote_token: t.quoteToken,
        quote_symbol: t.quoteSymbol,
        amount_in: t.amountIn.toString(),
        amount_out: t.amountOut.toString(),
        tx_hash: t.txHash,
        reason: t.reason,
        slippage_bps: t.slippageBps,
        gas_estimate: t.gasEstimate.toString(),
        meta: JSON.stringify(t.meta ?? {}),
      })
    return Number(info.lastInsertRowid)
  }

  recordDecision(d: DecisionRecord): number {
    const info = this.db
      .prepare(
        `INSERT INTO decisions (agent_id, ts, kind, detail, meta)
         VALUES (@agent_id,@ts,@kind,@detail,@meta)`,
      )
      .run({
        agent_id: d.agentId,
        ts: d.ts,
        kind: d.kind,
        detail: d.detail,
        meta: JSON.stringify(d.meta ?? {}),
      })
    return Number(info.lastInsertRowid)
  }

  recordEquity(e: EquityPoint): void {
    this.db
      .prepare(
        `INSERT INTO equity (agent_id, ts, realized_usd, open_value_usd, equity_usd)
         VALUES (?,?,?,?,?)`,
      )
      .run(e.agentId, e.ts, e.realizedUsd, e.openValueUsd, e.equityUsd)
  }

  /** Sum of USDG-denominated spend by an agent since a UTC-day boundary (ms). */
  spentSince(agentId: string, sinceMs: number, quoteSymbol = 'USDG'): number {
    const rows = this.db
      .prepare(
        `SELECT amount_in FROM trades
         WHERE agent_id=? AND ts>=? AND side='buy' AND quote_symbol=?`,
      )
      .all(agentId, sinceMs, quoteSymbol) as { amount_in: string }[]
    // amount_in is USDG (6dp) smallest units → dollars
    return rows.reduce((sum, r) => sum + Number(BigInt(r.amount_in)) / 1e6, 0)
  }

  recentTrades(agentId: string, limit = 50): TradeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM trades WHERE agent_id=? ORDER BY ts DESC LIMIT ?`)
      .all(agentId, limit) as Record<string, unknown>[]
    return rows.map(rowToTrade)
  }

  recentDecisions(agentId: string, limit = 100): DecisionRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM decisions WHERE agent_id=? ORDER BY ts DESC LIMIT ?`)
      .all(agentId, limit) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: r.id as number,
      agentId: r.agent_id as string,
      ts: r.ts as number,
      kind: r.kind as DecisionRecord['kind'],
      detail: r.detail as string,
      meta: JSON.parse((r.meta as string) || '{}'),
    }))
  }

  equityCurve(agentId: string, limit = 500): EquityPoint[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM equity WHERE agent_id=? ORDER BY ts DESC LIMIT ?
         ) ORDER BY ts ASC`,
      )
      .all(agentId, limit) as Record<string, unknown>[]
    return rows.map((r) => ({
      agentId: r.agent_id as string,
      ts: r.ts as number,
      realizedUsd: r.realized_usd as number,
      openValueUsd: r.open_value_usd as number,
      equityUsd: r.equity_usd as number,
    }))
  }

  /** All trades across every agent, newest first — for the fleet-wide feed. */
  allRecentTrades(limit = 100): TradeRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM trades ORDER BY ts DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[]
    return rows.map(rowToTrade)
  }

  close(): void {
    this.db.close()
  }
}

function rowToTrade(r: Record<string, unknown>): TradeRecord {
  return {
    id: r.id as number,
    agentId: r.agent_id as string,
    mode: r.mode as TradeRecord['mode'],
    ts: r.ts as number,
    side: r.side as 'buy' | 'sell',
    token: r.token as `0x${string}`,
    tokenSymbol: r.token_symbol as string,
    quoteToken: r.quote_token as `0x${string}`,
    quoteSymbol: r.quote_symbol as string,
    amountIn: BigInt(r.amount_in as string),
    amountOut: BigInt(r.amount_out as string),
    txHash: (r.tx_hash as `0x${string}` | null) ?? null,
    reason: r.reason as string,
    slippageBps: r.slippage_bps as number,
    gasEstimate: BigInt(r.gas_estimate as string),
    meta: JSON.parse((r.meta as string) || '{}'),
  }
}
