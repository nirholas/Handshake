// Recover sniper positions wedged in `reconcile_pending`.
//
// A sell whose confirmation timed out may still have LANDED. The worker detects
// that (real wallet balance 0) and looks for the transaction that emptied the
// bag so it can book the real proceeds. When that search comes up empty the
// position parks as `reconcile_pending` — and a parked position still counts
// against its arm's max_concurrent_positions, so a park that never resolves
// silently costs the arm a trading slot.
//
// The worker's own search missed one case: a sell usually CLOSES the token
// account in the same transaction to reclaim rent, so looking only at live token
// accounts finds nothing to search. Deriving the associated-token address (for
// both token programs) recovers the history regardless, because a closed
// account's address keeps its signatures. That fix ships in
// workers/agent-sniper/reconcile.js; this script is the same logic runnable
// against the database on demand, for clearing a wedge without waiting on a
// worker deploy.
//
// Safe by construction: it re-reads each position's real on-chain balance first
// and skips anything still holding tokens, so a live position is never closed.
// Proceeds come from the emptying transaction's actual SOL delta — never
// estimated. A position whose emptying tx cannot be found is reported and left
// untouched.
//
//   node scripts/sniper-reconcile-wedged.mjs
//
// Requires DATABASE_URL (and optionally SOLANA_RPC_URL) in .env.

import { neon } from '@neondatabase/serverless';
import * as web3 from '@solana/web3.js';
import 'dotenv/config';
const sql = neon(process.env.DATABASE_URL);
const conn = new web3.Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');
const ATP = new web3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const PROGS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA','TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'].map(p => new web3.PublicKey(p));

const pos = await sql`SELECT id, symbol, mint, wallet, buy_sig, entry_quote_lamports, realized_pnl_lamports
                      FROM agent_sniper_positions
                      WHERE status IN ('open','closing') AND error = 'reconcile_pending'`;
if (!pos.length) console.log('nothing wedged');
for (const p of pos) {
  const ownerPk = new web3.PublicKey(p.wallet), mintPk = new web3.PublicKey(p.mint);
  let bal = 0n;
  try {
    const acc = await conn.getParsedTokenAccountsByOwner(ownerPk, { mint: mintPk });
    for (const { account } of acc.value) bal += BigInt(account.data.parsed.info.tokenAmount.amount);
  } catch { console.log(p.symbol, '| balance read failed, left alone'); continue; }
  if (bal > 0n) { console.log(p.symbol, '| STILL HOLDS tokens, left open (real position)'); continue; }
  let done = false;
  for (const tp of PROGS) {
    if (done) break;
    const [ata] = web3.PublicKey.findProgramAddressSync([ownerPk.toBuffer(), tp.toBuffer(), mintPk.toBuffer()], ATP);
    const sigs = await conn.getSignaturesForAddress(ata, { limit: 20 }).catch(() => []);
    for (const s of sigs) {
      if (s.err || s.signature === p.buy_sig) continue;
      const tx = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }).catch(() => null);
      if (!tx || tx.meta?.err) continue;
      const pre = (tx.meta?.preTokenBalances || []).find(b => b.owner === p.wallet && b.mint === p.mint);
      const post = (tx.meta?.postTokenBalances || []).find(b => b.owner === p.wallet && b.mint === p.mint);
      const preAmt = pre ? BigInt(pre.uiTokenAmount.amount) : 0n;
      const postAmt = post ? BigInt(post.uiTokenAmount.amount) : 0n;
      if (preAmt > 0n && postAmt === 0n) {
        const keys = tx.transaction.message.accountKeys || [];
        const idx = keys.findIndex(k => (k.pubkey?.toBase58?.() || String(k.pubkey)) === p.wallet);
        const delta = idx >= 0 ? BigInt(tx.meta.postBalances[idx]) - BigInt(tx.meta.preBalances[idx]) : 0n;
        const proceeds = delta > 0n ? delta : 0n;
        const entry = BigInt(p.entry_quote_lamports || '0');
        const realized = BigInt(p.realized_pnl_lamports || '0') + proceeds - entry;
        const pct = entry > 0n ? (Number(realized) / Number(entry)) * 100 : 0;
        await sql`UPDATE agent_sniper_positions SET status='closed', exit_reason='timeout', sell_sig=${s.signature},
                  exit_quote_lamports=${proceeds.toString()}, realized_pnl_lamports=${realized.toString()},
                  realized_pnl_pct=${pct}, error='reconciled_onchain', reconcile_pending_since=NULL, closed_at=now()
                  WHERE id=${p.id} AND status <> 'closed'`;
        console.log('RECONCILED', p.symbol, (Number(realized)/1e9).toFixed(4), 'SOL (' + pct.toFixed(1) + '%)');
        done = true; break;
      }
    }
  }
  if (!done) console.log('UNRESOLVED', p.symbol, '(bag gone, emptying tx not found)');
}
