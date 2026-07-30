// GET  /api/user/wallet         — returns the user's master wallet (addresses + balances)
// POST /api/user/wallet         — create the master wallet (idempotent)
//
// The master wallet is a platform-custodied EVM + Solana keypair attached to a
// user account rather than a specific agent. It acts as the single financial hub
// for all platform activity: funding agents, x402 micropayments, skill purchases,
// tips. One wallet per user, lazy-provisioned on first request.
//
// Storage: master_wallets table. Its canonical definition is the migration
// api/_lib/migrations/20260730040000_master_wallets.sql; the inline bootstrap
// below is only a net for environments whose migrations lag.
// Encryption: same AES-256-GCM scheme as agent wallets (WALLET_ENCRYPTION_KEY).

import { getSessionUser } from '../../_lib/auth.js';
import { sql } from '../../_lib/db.js';
import { cors, json, error, wrap, method } from '../../_lib/http.js';
import { requireCsrf } from '../../_lib/csrf.js';
import { limits, clientIp } from '../../_lib/rate-limit.js';
import { generateAgentWallet, generateSolanaAgentWallet, getSolanaAddressBalances } from '../../_lib/agent-wallet.js';
import { evmFallbackProvider } from '../../_lib/evm/rpc.js';
import { recordEvent } from '../../_lib/usage.js';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Safety net only, and it must stay shape-identical to the migration named above.
// The earlier version of this bootstrap omitted the foreign key, so whichever of
// the two ran first decided the table's constraints; the migration now converges
// any table this path created. Three sibling handlers (history.js, send.js,
// fund-agent.js) read master_wallets without calling this, so the migration, not
// this function, is what guarantees the table exists.
let _tableReady = false;
async function ensureTable() {
	if (_tableReady) return;
	await sql`
		CREATE TABLE IF NOT EXISTS master_wallets (
			id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
			user_id       uuid        NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
			solana_address text,
			encrypted_solana_secret text,
			evm_address   text,
			encrypted_evm_key text,
			created_at    timestamptz NOT NULL DEFAULT now(),
			updated_at    timestamptz NOT NULL DEFAULT now()
		)
	`;
	_tableReady = true;
}

async function fetchEvmUsdcBalance(address) {
	if (!address) return null;
	try {
		const provider = await evmFallbackProvider(8453);
		// ERC-20 balanceOf(address) — minimal ABI call
		const data = '0x70a08231' + address.replace('0x', '').padStart(64, '0');
		const result = await provider.call({ to: BASE_USDC, data });
		const raw = BigInt(result || '0x0');
		return Number(raw) / 1e6; // USDC has 6 decimals
	} catch {
		return null;
	}
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const session = await getSessionUser(req);
	if (!session) return error(res, 401, 'unauthorized', 'sign in required');

	await ensureTable();

	if (req.method === 'POST') {
		const rl = await limits.authIp(clientIp(req));
		if (!rl.success) return json(res, 429, { error: 'rate_limited' });

		if (!(await requireCsrf(req, res, session.id))) return;

		// Idempotent: return existing wallet if already created
		const [existing] = await sql`
			SELECT solana_address, evm_address, created_at
			FROM master_wallets WHERE user_id = ${session.id}
		`;
		if (existing) {
			return json(res, 200, {
				wallet: {
					solana_address: existing.solana_address,
					evm_address: existing.evm_address,
					created_at: existing.created_at,
					created: false,
				},
			});
		}

		const [solWallet, evmWallet] = await Promise.all([
			generateSolanaAgentWallet(),
			generateAgentWallet(),
		]);

		const [row] = await sql`
			INSERT INTO master_wallets
				(user_id, solana_address, encrypted_solana_secret, evm_address, encrypted_evm_key)
			VALUES
				(${session.id}, ${solWallet.address}, ${solWallet.encrypted_secret},
				 ${evmWallet.address}, ${evmWallet.encrypted_key})
			ON CONFLICT (user_id) DO UPDATE
				SET updated_at = now()
			RETURNING solana_address, evm_address, created_at
		`;

		recordEvent({
			userId: session.id,
			event: 'master_wallet_created',
			meta: { solana_address: row.solana_address, evm_address: row.evm_address },
		}).catch(() => {});

		return json(res, 201, {
			wallet: {
				solana_address: row.solana_address,
				evm_address: row.evm_address,
				created_at: row.created_at,
				created: true,
			},
		});
	}

	// GET — return wallet info + live balances
	const rl = await limits.walletRead(session.id);
	if (!rl.success) return json(res, 429, { error: 'rate_limited' });

	const [row] = await sql`
		SELECT solana_address, evm_address, created_at
		FROM master_wallets WHERE user_id = ${session.id}
	`;

	if (!row) {
		return json(res, 200, { wallet: null });
	}

	// Fetch balances in parallel — never block the page on a price failure
	const [solBalances, evmUsdc] = await Promise.allSettled([
		row.solana_address ? getSolanaAddressBalances(row.solana_address, 'mainnet') : null,
		fetchEvmUsdcBalance(row.evm_address),
	]);

	const sol = solBalances.status === 'fulfilled' ? solBalances.value : null;
	const evm_usdc = evmUsdc.status === 'fulfilled' ? evmUsdc.value : null;

	const solNative = sol?.native ?? null;
	const solUsdc = sol?.tokens?.find((t) => t.mint === USDC_MINT)?.uiAmount ?? null;
	const solUsd = sol?.total_usd ?? null;
	const evmUsdcNum = typeof evm_usdc === 'number' ? evm_usdc : null;

	const totalUsd =
		typeof solUsd === 'number' ? solUsd + (evmUsdcNum ?? 0) : null;

	return json(res, 200, {
		wallet: {
			solana_address: row.solana_address,
			evm_address: row.evm_address,
			created_at: row.created_at,
			balances: {
				sol: solNative,
				sol_usdc: solUsdc,
				evm_usdc: evmUsdcNum,
				total_usd: totalUsd,
			},
		},
	});
});
