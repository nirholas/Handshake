// Shared tracked-wallet loader — bundled curation file + R2 admin imports.
//
// Extracted from api/kol/[action].js so the tracker aggregator (src/kol/tracker.js)
// and the wallets/import-gmgn endpoints read the exact same merged list instead of
// two independently-maintained copies of this logic.
//
// These entries carry curation (label, xHandle, an imported P&L figure), not the
// tracker's wallet universe: that comes from the live kolscan board. The bundled
// wallets.json ships empty on purpose — every wallet in it is an explicit admin
// decision, never a placeholder to make a page look populated.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { putObject, getObjectBuffer } from '../../api/_lib/r2.js';

const WALLETS_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	'wallets.json',
);

// Imported wallets live in R2 — the Vercel filesystem is read-only at runtime,
// so writes to the bundled wallets.json can never persist (or even succeed).
export const WALLETS_R2_KEY = 'kol/wallets.json';

async function loadBundledWallets() {
	try {
		return JSON.parse(await readFile(WALLETS_PATH, 'utf8'));
	} catch {
		return [];
	}
}

async function loadImportedWallets() {
	try {
		const buf = await getObjectBuffer(WALLETS_R2_KEY);
		const parsed = JSON.parse(buf.toString('utf8'));
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return []; // nothing imported yet (or storage unreachable) — bundled list only
	}
}

// Merged view: R2-stored imports take precedence over the bundled seed file.
export async function loadWallets() {
	const [bundled, imported] = await Promise.all([loadBundledWallets(), loadImportedWallets()]);
	const byWallet = new Map(bundled.map((w) => [w.wallet, w]));
	for (const w of imported) byWallet.set(w.wallet, w);
	return [...byWallet.values()];
}

export async function saveImportedWallets(merged) {
	await putObject({
		key: WALLETS_R2_KEY,
		body: JSON.stringify(merged, null, '\t') + '\n',
		contentType: 'application/json',
	});
}
