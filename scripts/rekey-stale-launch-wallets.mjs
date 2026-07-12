#!/usr/bin/env node
// Re-key launch-pool agents whose custodial Solana wallet was encrypted under a
// RETIRED WALLET_ENCRYPTION_KEY (the key changed during the Vercel→Cloud Run
// migration, 2026-07), so it can no longer be decrypted and every autonomous
// launch dies on a DOMException OperationError.
//
// This is the eager companion to the self-heal in loadAgentForSigning
// (api/_lib/agent-pumpfun.js): it walks the current global launch queue, and for
// any agent whose stored wallet fails to decrypt with BOTH live keys, mints a
// fresh wallet under the CURRENT key and persists it — keeping the dead address
// in meta.stale_solana_address for the audit trail. A wallet that still decrypts
// is left untouched. Nothing recoverable is lost: the old address is already
// unreachable because we can't sign for it.
//
// Requires (from the deploy env — pull with gcloud, do NOT hardcode):
//   DATABASE_URL, WALLET_ENCRYPTION_KEY, JWT_SECRET
//
//   node scripts/rekey-stale-launch-wallets.mjs [--apply]
//
// Dry-run by default: reports which agents WOULD be re-keyed. Pass --apply to write.

import { neon } from '@neondatabase/serverless';
import { Connection, PublicKey } from '@solana/web3.js';
import { generateSolanaAgentWallet, recoverSolanaAgentKeypair } from '../api/_lib/agent-wallet.js';

const APPLY = process.argv.includes('--apply');
// Re-keying abandons the old address, so a FUNDED stale wallet is skipped by default
// (its SOL is recoverable only with the retired key). Pass --force-drop-funds to
// re-key anyway, knowingly abandoning whatever SOL sits behind the retired key.
const FORCE_DROP = process.argv.includes('--force-drop-funds');
const DUST_SOL = 0.01;
const sql = neon(process.env.DATABASE_URL);
const rpc = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com', 'confirmed');

async function solBalance(addr) {
	if (!addr) return 0;
	try { return (await rpc.getBalance(new PublicKey(addr))) / 1e9; } catch { return NaN; }
}

async function decryptsOk(encryptedSecret) {
	if (!encryptedSecret) return false;
	try {
		await recoverSolanaAgentKeypair(encryptedSecret);
		return true;
	} catch {
		return false;
	}
}

const rows = await sql`
	select a.id, a.name, a.meta->>'solana_address' as addr, a.meta->>'encrypted_solana_secret' as sec
	from launcher_queue q
	join agent_identities a on a.id = q.agent_id
	where q.scope = 'global' and q.enabled = true
	order by q.last_launched_at nulls first
`;

console.log(`\nlaunch-pool agents in the global queue: ${rows.length}  (${APPLY ? 'APPLY' : 'DRY RUN'})\n`);

let rekeyed = 0;
let healthy = 0;
let fundedSkipped = 0;
let strandedSol = 0;
for (const r of rows) {
	if (await decryptsOk(r.sec)) {
		healthy++;
		console.log(`  ✓ ${r.name.padEnd(14)} ${r.addr} — decrypts, left as-is`);
		continue;
	}
	// Undecryptable. Protect funds: don't abandon a wallet that still holds SOL
	// unless explicitly forced — that SOL is recoverable only with the retired key.
	const bal = await solBalance(r.addr);
	if (Number.isNaN(bal)) {
		console.log(`  ? ${r.name.padEnd(14)} ${r.addr} — balance unknown (RPC), SKIP`);
		continue;
	}
	if (bal > DUST_SOL && !FORCE_DROP) {
		fundedSkipped++;
		strandedSol += bal;
		console.log(`  💰 ${r.name.padEnd(14)} ${r.addr} — holds ${bal.toFixed(4)} SOL, SKIP (recover with old key first, or --force-drop-funds)`);
		continue;
	}
	if (!APPLY) {
		console.log(`  ⟳ ${r.name.padEnd(14)} ${r.addr} — WOULD re-key (empty/undecryptable)`);
		rekeyed++;
		continue;
	}
	const fresh = await generateSolanaAgentWallet();
	const [cur] = await sql`select meta from agent_identities where id = ${r.id}`;
	const meta = {
		...(cur?.meta || {}),
		solana_address: fresh.address,
		encrypted_solana_secret: fresh.encrypted_secret,
		solana_wallet_source: 're_provisioned_stale_key',
		stale_solana_address: r.addr,
		rekeyed_at: new Date().toISOString(),
	};
	await sql`update agent_identities set meta = ${JSON.stringify(meta)}::jsonb where id = ${r.id}`;
	const ok = await decryptsOk(fresh.encrypted_secret);
	console.log(`  ${ok ? '✅' : '❌'} ${r.name.padEnd(14)} ${r.addr} → ${fresh.address} ${ok ? '(re-keyed, decrypts)' : '(RE-KEY FAILED VERIFY)'}`);
	rekeyed++;
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`healthy: ${healthy}   ${APPLY ? 're-keyed' : 'to re-key'}: ${rekeyed}   funded-skipped: ${fundedSkipped} (${strandedSol.toFixed(4)} SOL)`);
if (fundedSkipped) {
	console.log(`\n⚠️  ${fundedSkipped} wallet(s) hold ${strandedSol.toFixed(4)} SOL under the retired key.`);
	console.log('   Recover them first (decrypt+sweep with the OLD WALLET_ENCRYPTION_KEY), then re-run.');
	console.log('   Or --force-drop-funds to re-key anyway, knowingly abandoning that SOL.');
}
if (!APPLY && rekeyed) console.log('\nRe-run with --apply to re-key the empty undecryptable wallets.');
