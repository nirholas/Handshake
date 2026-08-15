// Agent wallet generation and management.
// Generates a random EVM/Solana wallet per agent and encrypts the private key at
// rest using AES-256-GCM.
//
// Key management (v2): the encryption key derives from a DEDICATED secret
// (WALLET_ENCRYPTION_KEY) — independent of JWT_SECRET — with a RANDOM per-record
// salt embedded in each ciphertext. This fixes two problems with the original v1
// scheme: (1) it tied every custodial wallet's confidentiality to JWT_SECRET, the
// highest-circulation secret on the platform (every session/bearer check), so a
// single JWT_SECRET leak decrypted all wallets and rotating it to invalidate
// sessions would have bricked every wallet; (2) v1 used a constant salt, so all
// records shared one derived key.
//
// Migration is dual-read, no data backfill required: ciphertexts written by v1
// (no version tag) still decrypt with the legacy JWT_SECRET + constant-salt
// derivation; new writes use v2 and records re-encrypt opportunistically on their
// next write. Set WALLET_ENCRYPTION_KEY in every environment that holds custodial
// keys; until it is set the code falls back to JWT_SECRET (with a warning) so
// deploys don't break, but the per-record salt still applies.

import { webcrypto } from 'node:crypto';
import { evmFallbackProvider } from './evm/rpc.js';
// Single source of truth for the AES-256-GCM secret box (HKDF key derivation,
// per-record salt, v1 legacy read). Shared with the coin treasury + launcher so
// every custodial secret on the platform uses the same at-rest scheme.
import { encryptSecret, decryptSecret, isEncryptedSecret } from './secret-box.js';

const randomBytes = (n) => {
	const b = new Uint8Array(n);
	(globalThis.crypto || webcrypto).getRandomValues(b);
	return b;
};

// Local aliases preserve the original call sites below; re-exported so existing
// importers of these names from agent-wallet.js keep working.
const encrypt = encryptSecret;
const decrypt = decryptSecret;
export { encryptSecret, decryptSecret, isEncryptedSecret };

// ── Wallet generation ───────────────────────────────────────────────────────

/**
 * Generate a new Ethereum wallet for an agent.
 * Returns { address, encrypted_key } where encrypted_key is the AES-GCM
 * encrypted private key (base64). Store encrypted_key in agent meta.
 */
export async function generateAgentWallet() {
	// Generate 32 random bytes for a private key
	const pk = randomBytes(32);
	const pkHex = '0x' + Array.from(pk, (b) => b.toString(16).padStart(2, '0')).join('');

	// Compute address from private key using ethers
	const { computeAddress } = await import('ethers');
	const address = computeAddress(pkHex);

	const encrypted_key = await encrypt(pkHex);
	return { address, encrypted_key };
}

/**
 * Recover an agent wallet's private key from its encrypted form.
 * Only call this when the agent needs to sign a transaction.
 *
 * Audit hook (mirrors recoverSolanaAgentKeypair): pass
 * `audit: { agentId, userId, reason, meta }` and a usage_events row + an
 * owner-viewable custody event are written fire-and-forget, so every decrypt of
 * a custodial EVM key is traceable with its reason — parity with the Solana path.
 */
export async function recoverAgentKey(encryptedKey, audit = null) {
	const pkHex = await decrypt(encryptedKey);
	if (audit && audit.agentId) {
		let address = null;
		try {
			const { computeAddress } = await import('ethers');
			address = computeAddress(pkHex);
		} catch { /* address is decoration on the audit row */ }
		import('./usage.js')
			.then(({ recordEvent }) =>
				recordEvent({
					userId: audit.userId ?? null,
					agentId: audit.agentId,
					kind: 'evm_key_use',
					tool: audit.reason || 'sign',
					status: 'ok',
					meta: { address, ...(audit.meta || {}) },
				}),
			)
			.catch(() => {});
		import('./agent-trade-guards.js')
			.then(({ recordCustodyEvent }) =>
				recordCustodyEvent({
					agentId: audit.agentId,
					userId: audit.userId ?? null,
					eventType: 'key_recover',
					reason: audit.reason || 'sign',
					meta: { address, chain: 'evm', ...(audit.meta || {}) },
				}),
			)
			.catch(() => {});
	}
	return pkHex;
}

/**
 * Idempotently provision a custodial EVM wallet for an agent.
 *
 * Mirrors getOrCreateAgentSolanaWallet(): generate a keypair via
 * generateAgentWallet(), store the address in agent_identities.wallet_address
 * and the encrypted key in meta.encrypted_wallet_key, and never re-create if one
 * already exists. Returns { address, created }.
 */
export async function getOrCreateAgentEvmWallet(agentId, { chainId = 8453 } = {}) {
	const { sql } = await import('./db.js');
	const [row] = await sql`
		select id, wallet_address, meta from agent_identities
		where id = ${agentId} and deleted_at is null
		limit 1
	`;
	if (!row) throw new Error('agent not found');
	if (row.wallet_address && row.meta?.encrypted_wallet_key) {
		return { address: row.wallet_address, created: false };
	}

	const wallet = await generateAgentWallet();
	const meta = {
		...(row.meta || {}),
		encrypted_wallet_key: wallet.encrypted_key,
		evm_wallet_source: 'generated',
	};
	await sql`
		update agent_identities
		set wallet_address = ${wallet.address},
		    chain_id = coalesce(chain_id, ${chainId}),
		    meta = ${JSON.stringify(meta)}::jsonb
		where id = ${agentId}
	`;
	return { address: wallet.address, created: true };
}

/**
 * Idempotently provision BOTH the EVM and Solana custodial wallets for an agent.
 * Used by the "create wallet" action on every avatar surface and by the
 * auto-provision on first avatar save. Returns the live addresses.
 * @returns {Promise<{ evm: string, solana: string, created: boolean }>}
 */
export async function provisionAgentWallets(agentId, { chainId = 8453 } = {}) {
	const evm = await getOrCreateAgentEvmWallet(agentId, { chainId });
	const sol = await getOrCreateAgentSolanaWallet(agentId);
	return { evm: evm.address, solana: sol.address, created: evm.created || sol.created };
}

// ── EVM on-chain balance + spend helpers ────────────────────────────────────

let _ethUsdPrice = null;
let _ethUsdPriceAt = 0;
const ETH_USD_CACHE_MS = 5 * 60_000;

// ETH/USD for the affordability checks below. The read goes through the shared
// coin-price failover (CoinGecko → DefiLlama → Kraken/Coinbase/Bitfinex) rather
// than a bare CoinGecko fetch, so a keyless-tier 429 no longer turns "can this
// agent afford the call?" into a hard error. Still throws when every source is
// down: the callers divide by this price, and a guessed rate would silently
// mis-size a spend.
async function fetchEthUsdPrice() {
	if (_ethUsdPrice && Date.now() - _ethUsdPriceAt < ETH_USD_CACHE_MS) return _ethUsdPrice;
	const { fetchCoinPriceUsd } = await import('./market-fallbacks.js');
	_ethUsdPrice = await fetchCoinPriceUsd('ethereum');
	_ethUsdPriceAt = Date.now();
	return _ethUsdPrice;
}

/**
 * Query the live ETH balance of an agent's wallet_address on its registered chain.
 * @returns {{ address: string, chain_id: number, balance_wei: string, balance_eth: string }}
 */
export async function getAgentBalance(agentId) {
	const { sql } = await import('./db.js');
	const [agent] = await sql`
		select wallet_address, chain_id
		from agent_identities
		where id = ${agentId} and deleted_at is null
		limit 1
	`;
	if (!agent?.wallet_address) throw new Error('agent has no wallet_address');
	const chainId = agent.chain_id || 8453;

	const { formatEther } = await import('ethers');
	const provider = await evmFallbackProvider(chainId);
	const balanceBigInt = await provider.getBalance(agent.wallet_address);
	return {
		address: agent.wallet_address,
		chain_id: chainId,
		balance_wei: balanceBigInt.toString(),
		balance_eth: formatEther(balanceBigInt),
	};
}

/**
 * Returns true if the agent's EVM wallet can afford priceUsd (at current ETH/USD).
 */
export async function canAfford(agentId, priceUsd) {
	const { parseEther } = await import('ethers');
	const [bal, ethUsd] = await Promise.all([getAgentBalance(agentId), fetchEthUsdPrice()]);
	const priceEth = priceUsd / ethUsd;
	const priceWei = parseEther(priceEth.toFixed(18));
	return BigInt(bal.balance_wei) >= priceWei;
}

const SPEND_ABI = [
	'function spend(uint256 agentId, address payable recipient, uint256 amountWei, string calldata memo) external',
];

/**
 * Calls IdentityRegistry.spend() via the agent's delegated signer key.
 * @param {{ agentId: string, recipient: string, amountWei: bigint|string, memo: string, signer: import('ethers').Signer }} opts
 * @returns {Promise<string>} tx hash
 */
export async function delegatedSpend({ agentId, recipient, amountWei, memo, signer }) {
	const { sql } = await import('./db.js');
	const [agent] = await sql`
		select erc8004_agent_id, chain_id from agent_identities
		where id = ${agentId} and deleted_at is null
		limit 1
	`;
	if (!agent?.erc8004_agent_id) throw new Error('agent has no on-chain erc8004_agent_id');

	const chainId = agent.chain_id || 8453;
	const { CHAIN_BY_ID, IDENTITY_REGISTRY_MAINNET, IDENTITY_REGISTRY_TESTNET } = await import('./erc8004-chains.js');
	const chain = CHAIN_BY_ID[chainId];
	const registryAddress = chain?.testnet ? IDENTITY_REGISTRY_TESTNET : IDENTITY_REGISTRY_MAINNET;

	const { Contract } = await import('ethers');
	const registry = new Contract(registryAddress, SPEND_ABI, signer);
	const tx = await registry.spend(agent.erc8004_agent_id, recipient, amountWei, memo || '');
	return tx.hash;
}

/**
 * Fire-and-forget: charge an agent for a paid skill call.
 * Records in agent_payments; broadcasts on-chain via delegatedSpend if affordable.
 * Never throws — errors are logged and the payment row reflects the outcome.
 */
export async function triggerSkillPayment({ agentId, skillSlug, skillId }) {
	try {
		const { sql } = await import('./db.js');

		// Resolve skill price and author wallet
		const [skill] = await sql`
			select ms.id, ms.price_per_call_usd, ms.author_id,
			       uw.address as author_wallet
			from marketplace_skills ms
			left join user_wallets uw on uw.user_id = ms.author_id
			    and uw.chain_type = 'evm' and uw.is_primary = true
			where ms.slug = ${skillSlug}
			limit 1
		`;
		if (!skill || Number(skill.price_per_call_usd) <= 0) return;

		const priceUsd = Number(skill.price_per_call_usd);

		// Validate the payout recipient shape before it can be used as a transfer
		// target — never sign a spend to a malformed/unexpected address.
		if (skill.author_wallet && !/^0x[0-9a-fA-F]{40}$/.test(String(skill.author_wallet))) {
			console.warn(`[agent-payments] skill ${skillSlug} has a malformed author_wallet; skipping`);
			return;
		}

		// Load agent to get chain + encrypted key
		const [agent] = await sql`
			select wallet_address, chain_id, erc8004_agent_id, meta
			from agent_identities
			where id = ${agentId} and deleted_at is null
			limit 1
		`;
		if (!agent) return;

		// Enforce the agent's per-transaction USD ceiling so a server-signed skill
		// charge can't exceed the owner's configured limit (this path previously
		// bypassed the spend policy entirely — only an affordability check applied).
		const { getSpendLimits } = await import('./agent-trade-guards.js');
		const spendLimits = getSpendLimits(agent.meta);
		if (spendLimits.per_tx_usd != null && priceUsd > spendLimits.per_tx_usd + 1e-9) {
			console.warn(
				`[agent-payments] skill ${skillSlug} ($${priceUsd}) exceeds agent ${agentId} per_tx_usd ` +
					`($${spendLimits.per_tx_usd}); skipping`,
			);
			await sql`
				insert into agent_payments
					(payer_agent_id, skill_id, amount_wei, chain_id, memo, status)
				values (${agentId}, ${skill.id ?? null}, '0', ${agent.chain_id || 8453}, ${skillSlug}, 'failed')
			`.catch(() => {});
			return;
		}

		const chainId = agent.chain_id || 8453;
		const encryptedKey = agent.meta?.encrypted_wallet_key;
		if (!encryptedKey) return;

		// Convert USD → wei
		const ethUsd = await fetchEthUsdPrice();
		const priceEth = priceUsd / ethUsd;
		const { parseEther, Wallet } = await import('ethers');
		const amountWei = parseEther(priceEth.toFixed(18));

		const affordable = BigInt(
			(await getAgentBalance(agentId).catch(() => ({ balance_wei: '0' }))).balance_wei,
		) >= amountWei;

		if (!affordable) {
			await sql`
				insert into agent_payments
					(payer_agent_id, skill_id, amount_wei, chain_id, memo, status)
				values (
					${agentId}, ${skill.id ?? null}, ${amountWei.toString()},
					${chainId}, ${skillSlug}, 'failed'
				)
			`;
			console.warn(`[agent-payments] agent ${agentId} cannot afford skill ${skillSlug}`);
			return;
		}

		// Insert pending row first
		const [row] = await sql`
			insert into agent_payments
				(payer_agent_id, skill_id, amount_wei, chain_id, memo, status)
			values (
				${agentId}, ${skill.id ?? null}, ${amountWei.toString()},
				${chainId}, ${skillSlug}, 'pending'
			)
			returning id
		`;

		// Build signer + dispatch tx (fire-and-forget)
		(async () => {
			try {
				const pkHex = await decrypt(encryptedKey);
				const provider = await evmFallbackProvider(chainId);
				const signer = new Wallet(pkHex, provider);
				const recipient = skill.author_wallet || signer.address;
				const txHash = await delegatedSpend({
					agentId,
					recipient,
					amountWei,
					memo: skillSlug,
					signer,
				});
				await sql`
					update agent_payments set status = 'confirmed', tx_hash = ${txHash}
					where id = ${row.id}
				`;
			} catch (e) {
				await sql`
					update agent_payments set status = 'failed'
					where id = ${row.id}
				`.catch(() => {});
				console.error(`[agent-payments] tx failed for ${agentId}/${skillSlug}`, e?.message);
			}
		})();
	} catch (e) {
		console.error('[agent-payments] triggerSkillPayment error', e?.message);
	}
}

// ── Solana wallet ───────────────────────────────────────────────────────────

/**
 * Generate a new Solana keypair for an agent.
 * Returns { address, encrypted_secret } where encrypted_secret is the base64
 * AES-GCM ciphertext of the 64-byte secret key (also base64-encoded inside).
 */
export async function generateSolanaAgentWallet() {
	const { Keypair } = await import('@solana/web3.js');
	const kp = Keypair.generate();
	const secretB64 = Buffer.from(kp.secretKey).toString('base64');
	const encrypted_secret = await encrypt(secretB64);
	return { address: kp.publicKey.toBase58(), encrypted_secret };
}

// Circle USDC mints — the x402 settlement asset, per cluster. Used for the
// USDC balance readout on a freshly provisioned wallet (not a coin token; $THREE
// is the only coin, USDC is the payment rail).
const USDC_MINT_BY_CLUSTER = {
	mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};

/**
 * Idempotently provision a custodial Solana wallet for an agent.
 *
 * Mirrors the POST branch of api/agents/solana-wallet.js: generate a keypair via
 * generateSolanaAgentWallet(), store the address + encrypted secret in agent
 * meta, and never re-create if one already exists. Returns { address, created }.
 */
export async function getOrCreateAgentSolanaWallet(agentId) {
	const { sql } = await import('./db.js');
	const [row] = await sql`
		select id, meta from agent_identities
		where id = ${agentId} and deleted_at is null
		limit 1
	`;
	if (!row) throw new Error('agent not found');

	let meta = { ...(row.meta || {}) };
	if (meta.solana_address) {
		return { address: meta.solana_address, created: false };
	}

	const sol = await generateSolanaAgentWallet();
	meta = {
		...meta,
		solana_address: sol.address,
		encrypted_solana_secret: sol.encrypted_secret,
		solana_wallet_source: 'generated',
	};
	await sql`update agent_identities set meta = ${JSON.stringify(meta)}::jsonb where id = ${agentId}`;
	return { address: sol.address, created: true };
}

/**
 * Read the live SOL + USDC balances for a Solana address on the given cluster.
 * Never throws — an RPC failure returns nulls so a provision call still succeeds
 * with the wallet address (balances can be re-read later via wallet_status).
 * @returns {Promise<{ sol: number|null, usdc: number|null }>}
 */
export async function getSolanaAddressBalances(address, cluster = 'mainnet') {
	const net = cluster === 'devnet' ? 'devnet' : 'mainnet';
	let sol = null;
	let usdc = null;
	try {
		const { PublicKey } = await import('@solana/web3.js');
		const { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } =
			await import('@solana/spl-token');
		const { solanaConnection } = await import('./agent-pumpfun.js');
		const conn = solanaConnection(net);
		const owner = new PublicKey(address);
		const lamports = await conn.getBalance(owner);
		sol = lamports / 1e9;
		try {
			const ata = getAssociatedTokenAddressSync(
				new PublicKey(USDC_MINT_BY_CLUSTER[net]),
				owner,
				false,
				TOKEN_PROGRAM_ID,
				ASSOCIATED_TOKEN_PROGRAM_ID,
			);
			const bal = await conn.getTokenAccountBalance(ata);
			usdc = bal?.value?.uiAmount ?? 0;
		} catch {
			usdc = 0; // no ATA yet → zero USDC
		}
	} catch (err) {
		// RPC failure: report nulls rather than throw, so a caller that only needed
		// the address still succeeds. Log it, because a null here is indistinguishable
		// from a genuinely empty wallet everywhere downstream, and a silent swallow
		// leaves an operator no way to tell an outage from a zero balance.
		console.warn('[agent-wallet] solana balance read failed', net, err?.message);
	}
	return { sol, usdc };
}

// Validate a string is a syntactically valid Solana (base58, 32-byte) address.
// A truthy meta.solana_address that does not parse is treated as missing so the
// wallet is re-provisioned rather than handed downstream to crash a PublicKey().
async function isValidSolanaAddress(address) {
	if (typeof address !== 'string' || address.length < 32 || address.length > 44) return false;
	if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(address)) return false;
	try {
		const { PublicKey } = await import('@solana/web3.js');
		// Constructing throws on a malformed (non-32-byte) base58 string.
		// eslint-disable-next-line no-new
		new PublicKey(address);
		return true;
	} catch {
		return false;
	}
}

/**
 * Idempotently guarantee an agent has a usable custodial Solana wallet.
 *
 * This is THE single entry point every wallet-touching endpoint (deposit, trade,
 * x402 pay, withdraw) must call before assuming `meta.solana_address` /
 * `meta.encrypted_solana_secret` exist. It:
 *   1. loads the agent row,
 *   2. returns the existing wallet if both the address is a valid Solana key and
 *      a recoverable encrypted secret is present ({ created: false }),
 *   3. otherwise generates + persists a fresh keypair via the canonical
 *      generateSolanaAgentWallet() and audit-logs the lazy provision
 *      ({ created: true }).
 *
 * A row whose address fails to parse, or whose secret is missing, is repaired —
 * never handed downstream to throw inside a PublicKey() / signing call. The
 * secret never leaves the server and is never returned, logged, or put in an
 * error message.
 *
 * @param {string} agentId
 * @param {string|null} [userId] — owner, for the audit trail (optional)
 * @param {{ reason?: string }} [opts]
 * @returns {Promise<{ address: string, created: boolean }>}
 */
export async function ensureAgentWallet(agentId, userId = null, opts = {}) {
	if (!agentId) throw new Error('agentId required');
	const { sql } = await import('./db.js');
	const [row] = await sql`
		select id, user_id, meta from agent_identities
		where id = ${agentId} and deleted_at is null
		limit 1
	`;
	if (!row) throw new Error('agent not found');

	const meta = { ...(row.meta || {}) };
	const hasValidAddress = await isValidSolanaAddress(meta.solana_address);
	const hasSecret = typeof meta.encrypted_solana_secret === 'string' && meta.encrypted_solana_secret.length > 0;
	if (hasValidAddress && hasSecret) {
		return { address: meta.solana_address, created: false };
	}

	const sol = await generateSolanaAgentWallet();
	const nextMeta = {
		...meta,
		solana_address: sol.address,
		encrypted_solana_secret: sol.encrypted_secret,
		solana_wallet_source: meta.solana_wallet_source || 'lazy_provision',
	};
	await sql`update agent_identities set meta = ${JSON.stringify(nextMeta)}::jsonb where id = ${agentId}`;

	// Audit the lazy provision: custodial keys are real funds, every mint must be
	// traceable. Fire-and-forget — telemetry must never block the wallet path.
	// The address is public; the secret is never recorded.
	try {
		const { recordEvent } = await import('./usage.js');
		recordEvent({
			userId: userId ?? row.user_id ?? null,
			agentId,
			kind: 'solana_wallet_provision',
			tool: opts.reason || 'ensure',
			status: 'ok',
			meta: { address: sol.address, source: 'lazy_provision', repaired: hasValidAddress !== hasSecret },
		});
	} catch {
		/* audit best-effort */
	}
	return { address: sol.address, created: true };
}

/**
 * Recover a Solana Keypair from its encrypted form.
 * Only call this when the agent needs to sign a transaction.
 *
 * Audit hook: pass `audit: { agentId, userId, reason, meta }` and a
 * usage_events row will be written fire-and-forget so every decrypt
 * is traceable.
 */
export async function recoverSolanaAgentKeypair(encryptedSecret, audit = null) {
	const { Keypair } = await import('@solana/web3.js');
	const secretB64 = await decrypt(encryptedSecret);
	const kp = Keypair.fromSecretKey(Buffer.from(secretB64, 'base64'));
	if (audit && audit.agentId) {
		const { recordEvent } = await import('./usage.js');
		recordEvent({
			userId: audit.userId ?? null,
			agentId: audit.agentId,
			kind: 'solana_key_use',
			tool: audit.reason || 'sign',
			status: 'ok',
			meta: { address: kp.publicKey.toBase58(), ...(audit.meta || {}) },
		});
		// Mirror into the owner-viewable custody trail so every decrypt of a
		// custodial key is traceable with its reason, alongside withdraws and
		// limit changes. Fire-and-forget — never block or fail the signing path.
		import('./agent-trade-guards.js')
			.then(({ recordCustodyEvent }) =>
				recordCustodyEvent({
					agentId: audit.agentId,
					userId: audit.userId ?? null,
					eventType: 'key_recover',
					reason: audit.reason || 'sign',
					meta: { address: kp.publicKey.toBase58(), ...(audit.meta || {}) },
				}),
			)
			.catch(() => {});
	}
	return kp;
}
