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
import { solPriceUsd } from '../../_lib/sol-price.js';
import { recordEvent } from '../../_lib/usage.js';

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

		// recordEvent is fire-and-forget and returns nothing: it queues the write on
		// a microtask and swallows its own failures. Chaining .catch() onto it threw
		// a TypeError here AFTER the wallet row was already committed, so every first
		// provision answered 500 and the page told the user it had failed.
		recordEvent({
			userId: session.id,
			event: 'master_wallet_created',
			meta: { solana_address: row.solana_address, evm_address: row.evm_address },
		});

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

	// Read every leg in parallel; no single failure may block the others. The SOL
	// price is a third leg rather than something the balance read carries, because
	// getSolanaAddressBalances returns raw amounts only: `{ sol, usdc }`. Reading
	// it as `{ native, tokens, total_usd }` (a shape it has never returned) is what
	// made every Solana balance on /wallet render "unavailable" for every account.
	const [solBalances, evmUsdc, solPrice] = await Promise.allSettled([
		row.solana_address ? getSolanaAddressBalances(row.solana_address, 'mainnet') : null,
		fetchEvmUsdcBalance(row.evm_address),
		solPriceUsd(),
	]);

	// A null here means the network did not answer, which is not the same as zero:
	// the page renders it as "unavailable" and leaves it out of the total.
	const solRead = solBalances.status === 'fulfilled' ? solBalances.value : null;
	const solNative = typeof solRead?.sol === 'number' ? solRead.sol : null;
	const solUsdc = typeof solRead?.usdc === 'number' ? solRead.usdc : null;
	const evmUsdcNum = evmUsdc.status === 'fulfilled' && typeof evmUsdc.value === 'number' ? evmUsdc.value : null;
	const price =
		solPrice.status === 'fulfilled' && Number(solPrice.value) > 0 ? Number(solPrice.value) : null;

	// Total only sums the legs that answered. A held SOL balance with no price is
	// the one case that voids the total outright: counting it at zero would
	// under-report real money, and a zero balance needs no price to value.
	const legs = [];
	let solValueUnknown = false;
	if (solNative != null) {
		if (solNative === 0) legs.push(0);
		else if (price != null) legs.push(solNative * price);
		else solValueUnknown = true;
	}
	if (solUsdc != null) legs.push(solUsdc);
	if (evmUsdcNum != null) legs.push(evmUsdcNum);
	const totalUsd =
		solValueUnknown || !legs.length
			? null
			: Math.round(legs.reduce((a, b) => a + b, 0) * 100) / 100;

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
