// @ts-check
// Single source of truth for every Solana fee-paying signer the platform reads.
//
// Each signer is a keypair stored in an env var (NEVER committed). The platform
// loads it to pay transaction fees / rent for an on-chain flow. If one silently
// runs dry, that flow stops working with no warning — so the balance-check cron
// (api/cron/relayer-balance-check.js) and the operator script
// (scripts/check-relayer-balances.mjs) both read this registry, derive each
// pubkey, and compare its SOL balance against `minSol`.
//
// This registry is the source of truth for signer purpose, network, encoding,
// and funding floors — docs/economy-master.md and docs/money-map.md link here.
//
// Encodings differ across signers (base64 of 64 raw bytes, base58, JSON array).
// `loadKeypairFromSecret` auto-detects, so callers never need to know which.

/**
 * @typedef {Object} SignerSpec
 * @property {string} name      human label for alerts/logs
 * @property {string} env       the env var holding the secret
 * @property {number} minSol    alert/refill threshold in SOL (mainnet)
 * @property {string} purpose   what this keypair pays for
 * @property {'mainnet'|'devnet'|'both'} network where it spends real SOL
 * @property {string} [fallbackEnv] secondary env var to try when `env` is unset
 * @property {number} [refillTo] SOL to bring this signer up to when the economy
 *   master auto-tops it up (defaults to minSol×3 in the treasury-topup cron)
 * @property {boolean} [isMaster] the funding root itself — watched for a low
 *   balance, but never a refill TARGET (it funds the others, not itself)
 * @property {boolean} [settleCritical] a fee wallet the x402 payment rail pays
 *   from: under its floor the facilitator refuses every settle, so a thin
 *   funding run brings this signer up BEFORE any float or feed wallet
 * @property {boolean} [holdsTokens] this wallet operationally HOLDS SPL token
 *   balances (revenue, payout float, tip inventory). The sweepback module
 *   (api/_lib/economy-sweepback.js) never takes its tokens in excess mode —
 *   only an explicit drain consolidates them to the master.
 */

/** @type {SignerSpec[]} */
export const SOLANA_SIGNERS = [
	{
		name: 'economy-master',
		env: 'ECONOMY_MASTER_SECRET_BASE58',
		// The funding root. Keeps a large reserve because it tops up every other
		// engine — see ECONOMY_MASTER_RESERVE_SOL in api/_lib/economy-master.js.
		minSol: 1,
		isMaster: true,
		purpose:
			'economy funding root (WwwuGbqHrwF5RG89KhUbmRWEvjnRH9k5kVM5p7T3WwW): auto-tops-up every other engine signer below its floor. Funder-only — never trades, launches, or settles.',
		network: 'mainnet',
	},
	{
		name: 'pump-cron-relayer',
		env: 'PUMP_CRON_RELAYER_SECRET_KEY_B64',
		minSol: 0.1,
		purpose: 'pays fees + swap gas for the buyback and distribute-payments crons',
		network: 'both',
	},
	{
		name: 'pump-x402-launcher',
		env: 'PUMP_X402_LAUNCHER_SECRET_KEY_B64',
		minSol: 0.1,
		// CRITICAL — do NOT remove holdsTokens. This env resolves to the SAME physical
		// wallet as the x402 ring TREASURY / receiver (X402_PAY_TO_SOLANA /
		// X402_TREASURY_SECRET_BASE58 → secret `wallet-x402-treasury-b64`, pubkey
		// wwwww…ccrU). Its LIVE, load-bearing role is the treasury: it holds the ring's
		// USDC float + platform x402 revenue and signs the rebalancer's treasury→payer
		// sweeps (so it keeps a SOL floor). The pump.fun x402 launch role that named
		// this entry is not in active use. Without holdsTokens, the excess-mode
		// treasury-sweepback consolidated its USDC up to the master AND closed its USDC
		// ATA every run — so every following ring settle recreated the ATA at ~2,039,280
		// lamports of rent, dragging the per-settle fee to ~570k lamports (114× the 5k
		// self-pay floor) and draining the closed loop's float into the master. It reads
		// like "just a launcher fee wallet" that wouldn't need holdsTokens — it is not.
		// holdsTokens keeps the ring float where the rebalancer can recirculate it; only
		// an explicit drain may still consolidate it.
		holdsTokens: true,
		purpose:
			'x402 ring treasury/receiver (pubkey wwwww…ccrU): holds USDC revenue + the ring float and signs treasury→payer sweeps; keeps a SOL floor for those fees. holdsTokens protects its USDC from excess-mode sweepback. (Legacy name: also the pump.fun x402 launch fee wallet, a role not in active use.)',
		network: 'mainnet',
	},
	{
		name: 'coin-launcher-master',
		env: 'LAUNCHER_MASTER_SECRET_KEY_B64',
		fallbackEnv: 'PUMP_X402_LAUNCHER_SECRET_KEY_B64',
		// Funds many autonomous launches per day — keep a higher floor than a
		// single-flow relayer so the autonomous launcher does not stall mid-run.
		minSol: 1,
		purpose:
			'master wallet for the autonomous coin launcher: tops up the next agent in the rotation with the per-launch SOL (deploy cost + dev-buy) just before it signs its own pump.fun create',
		network: 'mainnet',
	},
	{
		name: 'sns-parent-owner',
		env: 'THREEWS_SOL_PARENT_SECRET_BASE58',
		minSol: 0.05,
		purpose: 'owns threews.sol; pays rent/fees minting *.threews.sol subdomains',
		network: 'mainnet',
	},
	{
		name: 'coin-treasury',
		env: 'COIN_TREASURY_SECRET_KEY_B64',
		minSol: 0.05,
		holdsTokens: true,
		purpose: 'signs lottery/reflection distribution txs for launched coins',
		network: 'mainnet',
	},
	{
		name: 'three-buyback',
		env: 'THREE_BUYBACK_SECRET_KEY_B64',
		minSol: 0.05,
		holdsTokens: true,
		purpose: 'holds platform USDC revenue; pays gas for the run-three-buyback cron (market-buy $THREE → treasury)',
		network: 'mainnet',
	},
	{
		name: 'club-treasury',
		env: 'CLUB_SOLANA_TREASURY_SECRET_KEY_B64',
		minSol: 0.05,
		holdsTokens: true,
		purpose: 'pays USDC tip-sweep transfers + recipient ATA rent (club-payouts cron)',
		network: 'mainnet',
	},
	{
		name: 'platform-treasury',
		env: 'PLATFORM_TREASURY_KEYPAIR',
		fallbackEnv: 'TREASURY_KEYPAIR',
		minSol: 0.05,
		holdsTokens: true,
		purpose: 'pays SPL withdrawal gas (process-withdrawals cron)',
		network: 'mainnet',
	},
	{
		name: 'marketplace-payer',
		env: 'MARKETPLACE_PAYER_KEYPAIR',
		fallbackEnv: 'PLATFORM_TREASURY_KEYPAIR',
		minSol: 0.05,
		purpose: 'sponsors network fees for gasless skill/asset checkout (fee-payer on prepared VersionedTransactions)',
		network: 'mainnet',
	},
	{
		name: 'a2a-payer',
		env: 'A2A_PAYER_SOLANA_SECRET',
		fallbackEnv: 'A2A_PAYER_SOLANA_PRIVATE_KEY',
		minSol: 0.02,
		// Settles mandates in USDC, so its USDC float is working capital: without
		// this flag treasury-sweepback's token sweep clawed any refill straight
		// back to the master on the next excess-mode run.
		holdsTokens: true,
		purpose: 'co-signs SPL TransferChecked for agent-to-agent mandate settlements',
		network: 'mainnet',
	},
	{
		name: 'x402-ring-sponsor',
		env: 'X402_FEE_PAYER_SECRET_BASE58',
		// The self-hosted facilitator's fee payer: co-signs + burns SOL on every
		// ring settle. If it drops below X402_SPONSOR_SOL_FLOOR_LAMPORTS (0.02 SOL)
		// the facilitator refuses to settle and the ring silently halts — so keep
		// the topup floor a hair above that hard floor and let the economy master's
		// treasury-topup cron refill it before the loop stops.
		minSol: 0.03,
		settleCritical: true,
		purpose: 'x402 ring sponsor (fee payer): co-signs + pays SOL on every self-hosted-facilitator settle; below-floor pauses the whole ring',
		network: 'mainnet',
	},
	{
		name: 'x402-ring-payer',
		env: 'X402_SEED_SOLANA_SECRET_BASE58',
		fallbackEnv: 'X402_AGENT_SOLANA_SECRET_BASE58',
		// In self-pay mode (X402_RING_SELF_PAY) the payer signs and pays its own
		// 1-signature fee, so it needs its own SOL headroom just like the sponsor.
		// Its USDC float is watched separately by the wallet-balance monitor; the
		// economy master only ever tops up SOL, never USDC.
		minSol: 0.03,
		settleCritical: true,
		holdsTokens: true,
		purpose: 'x402 ring payer (self-pay mode): signs + pays its own 1-sig fee on each ring settle; USDC float watched by the balance monitor',
		network: 'mainnet',
	},
	{
		name: 'circulation-treasury',
		env: 'CIRCULATION_TREASURY_SECRET',
		// Funds the circulation engine's whole agent pool (pulse-tick seeds every
		// operated agent from this wallet), so it burns SOL faster than any
		// single-flow relayer. Keep a real float and refill it generously — a dry
		// circulation treasury is exactly the slow flatline the Money Pulse showed
		// in late June.
		minSol: 0.2,
		refillTo: 0.5,
		holdsTokens: true,
		purpose: 'circulation engine treasury: seeds and tops up the operated agent pool each pulse-tick; dry ⇒ the live money feed goes quiet',
		network: 'mainnet',
	},
	{
		name: 'collection-authority',
		env: 'SOLANA_AGENT_COLLECTION_AUTHORITY_KEY',
		minSol: 0.02,
		// Holds the agent-collection NFTs themselves — a token sweep here would
		// move the collection, not surplus. Only an explicit drain may touch it.
		holdsTokens: true,
		purpose: 'creates/manages the three.ws agent NFT collection',
		network: 'both',
	},
];

// Per-signer floor overrides: SIGNER_MIN_SOL_<NAME> / SIGNER_REFILL_TO_SOL_<NAME>
// (name upper-cased, dashes to underscores, e.g. SIGNER_MIN_SOL_COIN_LAUNCHER_MASTER).
// Applied at module load so every consumer (treasury-topup targets, balance
// alerts, the floors dashboard) agrees on the effective floor. Exists so ops can
// retune one engine's floor without a code deploy; the concrete case: the
// autonomous launcher's 1 SOL floor is the fleet's largest deficit, and while
// launches are paused it would otherwise outrank every active engine in the
// deficit-sorted topup queue and absorb the whole fuel budget.
for (const spec of SOLANA_SIGNERS) {
	const key = spec.name.toUpperCase().replace(/-/g, '_');
	const minSol = Number(process.env[`SIGNER_MIN_SOL_${key}`]);
	if (Number.isFinite(minSol) && minSol >= 0) spec.minSol = minSol;
	const refillTo = Number(process.env[`SIGNER_REFILL_TO_SOL_${key}`]);
	if (Number.isFinite(refillTo) && refillTo > 0) spec.refillTo = refillTo;
}

/**
 * Decode a Solana secret key from any of the encodings used across the env:
 *   - JSON array of 64 ints (Solana CLI keypair file contents)
 *   - base64 of the 64 raw secret-key bytes (…_B64 vars)
 *   - base58 of the 64 raw secret-key bytes (…_BASE58 vars)
 * Returns the 64-byte Uint8Array, or null if it can't be decoded.
 * @param {string} secret
 * @returns {Promise<Uint8Array|null>}
 */
export async function decodeSecretKey(secret) {
	const raw = (secret || '').trim();
	if (!raw) return null;

	// JSON array form
	if (raw.startsWith('[')) {
		try {
			const arr = JSON.parse(raw);
			if (Array.isArray(arr) && (arr.length === 64 || arr.length === 32)) {
				return toFullSecretKey(Uint8Array.from(arr));
			}
		} catch {
			/* fall through */
		}
	}

	// base64 form (…_B64). Buffer.from is lenient, so validate the byte length.
	try {
		const buf = Buffer.from(raw, 'base64');
		if (buf.length === 64 || buf.length === 32) {
			// Guard against base58 strings that happen to base64-decode to 64 bytes:
			// re-encode and compare, accept only on round-trip match.
			if (buf.toString('base64').replace(/=+$/, '') === raw.replace(/=+$/, '')) {
				return toFullSecretKey(new Uint8Array(buf));
			}
		}
	} catch {
		/* fall through */
	}

	// base58 form (…_BASE58)
	try {
		const bs58mod = await import('bs58');
		const bs58 = /** @type {import('bs58').default} */ (bs58mod.default || bs58mod);
		const bytes = bs58.decode(raw);
		if (bytes.length === 64 || bytes.length === 32) return toFullSecretKey(Uint8Array.from(bytes));
	} catch {
		/* fall through */
	}

	return null;
}

// Normalize to a full 64-byte ed25519 secret key. A 32-byte value is a SEED, not
// a secret key — passing it straight to Keypair.fromSecretKey throws or, worse,
// resolves a DIFFERENT pubkey than intended (so a treasury/relayer signer would
// silently sign from the wrong address). Expand the seed deterministically.
async function toFullSecretKey(bytes) {
	if (bytes.length === 64) return bytes;
	if (bytes.length === 32) {
		const { Keypair } = await import('@solana/web3.js');
		return Keypair.fromSeed(bytes).secretKey;
	}
	return null;
}

/**
 * Resolve a SignerSpec to a loaded keypair pubkey (base58) using whichever env
 * var (primary or fallback) is set. Returns null when neither is configured or
 * the secret can't be decoded.
 * @param {SignerSpec & { fallbackEnv?: string }} spec
 * @returns {Promise<{ configured: boolean, pubkey: string|null, decodeError: boolean }>}
 */
export async function resolveSignerPubkey(spec) {
	const secret = process.env[spec.env] || (spec.fallbackEnv ? process.env[spec.fallbackEnv] : '');
	if (!secret) return { configured: false, pubkey: null, decodeError: false };

	const bytes = await decodeSecretKey(secret);
	if (!bytes) return { configured: true, pubkey: null, decodeError: true };

	const { Keypair } = await import('@solana/web3.js');
	try {
		const kp = Keypair.fromSecretKey(bytes);
		return { configured: true, pubkey: kp.publicKey.toBase58(), decodeError: false };
	} catch {
		return { configured: true, pubkey: null, decodeError: true };
	}
}

/**
 * Resolve a SignerSpec to its full signing keypair (primary env var, then
 * fallback). Same contract as resolveSignerPubkey, but for callers that need to
 * SIGN as the wallet — e.g. the sweepback module returning a signer's balance
 * to the economy master. Never throws: an unconfigured signer is
 * `configured:false`, a corrupt secret is `decodeError:true`.
 * @param {SignerSpec & { fallbackEnv?: string }} spec
 * @returns {Promise<{ configured: boolean, keypair: import('@solana/web3.js').Keypair|null, decodeError: boolean }>}
 */
export async function loadSignerKeypair(spec) {
	const secret = process.env[spec.env] || (spec.fallbackEnv ? process.env[spec.fallbackEnv] : '');
	if (!secret) return { configured: false, keypair: null, decodeError: false };

	const bytes = await decodeSecretKey(secret);
	if (!bytes) return { configured: true, keypair: null, decodeError: true };

	const { Keypair } = await import('@solana/web3.js');
	try {
		return { configured: true, keypair: Keypair.fromSecretKey(bytes), decodeError: false };
	} catch {
		return { configured: true, keypair: null, decodeError: true };
	}
}
