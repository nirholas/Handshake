// Read-only probe: can the platform decrypt the two agent wallets the reclaim
// plan targets? No transfer is built or sent.
import { readFileSync } from 'node:fs';
for (const f of ['.env', '.env.local']) {
	try {
		for (const line of readFileSync(f, 'utf8').split('\n')) {
			const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
			if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
		}
	} catch {}
}
const { sql } = await import('./api/_lib/db.js');
const rows = await sql`
	SELECT a.id, a.name, a.meta->>'solana_address' AS address,
	       a.meta->>'encrypted_solana_secret' AS secret, LOWER(u.email) AS owner
	FROM agent_identities a JOIN users u ON u.id = a.user_id
	WHERE a.id IN ('00bf4380-a6dd-4693-80d3-52bf23a8855b','73da6b13-223a-481e-ab4c-4c293a462d62')`;
const { recoverSolanaAgentKeypair } = await import('./api/_lib/agent-wallet.js');
for (const r of rows) {
	let verdict;
	try {
		const kp = await recoverSolanaAgentKeypair(r.secret, { agentId: r.id, reason: 'reclaim_probe', meta: { probe: true } });
		verdict = kp.publicKey.toBase58() === r.address ? 'DECRYPT OK, address matches' : `DECRYPT OK but address MISMATCH (${kp.publicKey.toBase58()})`;
	} catch (e) {
		verdict = `DECRYPT FAILED: ${e?.message}`;
	}
	console.log(`${r.name.padEnd(12)} ${r.address} owner=${r.owner} -> ${verdict}`);
}
