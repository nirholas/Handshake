// Draft agent mint - roadmap Phase 1 deliverable: every successful
// reconstruction output is not only persisted to durable storage (R2, done by
// reconstruct-finalize.js) but also minted as a DRAFT on-chain agent identity.
//
// Solana leads: the draft identity is a Metaplex Core asset minted into the
// three.ws Agent Collection, reusing the exact machinery of the batch deployer
// (api/_lib/onchain-deploy.js) so a draft mint is indistinguishable in shape
// from any other platform mint - collection membership, brand attributes,
// royalties, and Metaplex Agent Registry enrolment included.
//
// Network policy (the spend gate):
//   • DRAFT_AGENT_MINT_NETWORK = devnet (default) | mainnet | off
//     Devnet is the automated proof path: it runs whenever an authority secret
//     is configured and costs nothing real. MAINNET IS NEVER IMPLICIT - it
//     activates only when an operator explicitly sets
//     DRAFT_AGENT_MINT_NETWORK=mainnet AND funds
//     SOLANA_AGENT_COLLECTION_AUTHORITY_KEY on mainnet. That single flag is the
//     documented mainnet switch.
//   • Without an authority secret the leg reports 'skipped' - a no-op, so a
//     deployment without mint credentials behaves exactly as before.
//
// EVM leg (ERC-8004): behind DRAFT_AGENT_MINT_EVM_ENABLED=1 with
// DRAFT_AGENT_MINT_EVM_CHAIN_ID (default 84532, Base Sepolia). It registers the
// agent's card URI through the canonical Identity Registry from the agent's own
// custodial EVM wallet, gas topped up from EVM_TREASURY_PRIVATE_KEY. With no
// treasury key configured the leg is fully dry-run: it builds the real
// register(string) calldata and estimates it against the chain's public RPC,
// proving the wiring without broadcasting.
//
// The whole orchestration is best-effort by contract: callers (the
// reconstruction finalize path) must treat a throw as non-fatal. Idempotent:
// an agent already minted on a network short-circuits to 'already'.

import { sql } from './db.js';
import { env } from './env.js';
import { resolveOrCreateAgentForAvatar } from './agent-identity.js';

export const DRAFT_MINT_NETWORKS = /** @type {const} */ (['devnet', 'mainnet']);

/**
 * Resolve the Solana draft-mint network. Devnet is the default automated path;
 * mainnet requires an explicit opt-in; 'off' disables the leg entirely.
 * @param {NodeJS.ProcessEnv} [e]
 * @returns {'devnet'|'mainnet'|'off'}
 */
export function resolveDraftMintNetwork(e = process.env) {
	const v = String(e.DRAFT_AGENT_MINT_NETWORK || 'devnet').trim().toLowerCase();
	if (v === 'off' || v === 'disabled' || v === '0') return 'off';
	if (v === 'mainnet') return 'mainnet';
	return 'devnet';
}

/**
 * Resolve the EVM (ERC-8004) leg configuration. Off unless explicitly enabled.
 * @param {NodeJS.ProcessEnv} [e]
 * @returns {{ enabled: boolean, chainId: number }}
 */
export function resolveDraftMintEvm(e = process.env) {
	const enabled = ['1', 'true', 'yes', 'on'].includes(
		String(e.DRAFT_AGENT_MINT_EVM_ENABLED || '').trim().toLowerCase(),
	);
	const chainId = Number.parseInt(e.DRAFT_AGENT_MINT_EVM_CHAIN_ID || '84532', 10);
	return { enabled, chainId: Number.isFinite(chainId) ? chainId : 84532 };
}

// ── Context loading ──────────────────────────────────────────────────────────

/**
 * Load the agent row joined with its avatar's storage keys - the exact shape
 * deployAgentOnce() (onchain-deploy.js) consumes.
 */
async function loadAgentContext(agentId) {
	const [row] = await sql`
		SELECT ai.id, ai.user_id, ai.name, ai.description, ai.meta, ai.avatar_id,
		       av.thumbnail_key, av.storage_key
		FROM agent_identities ai
		LEFT JOIN avatars av ON av.id = ai.avatar_id AND av.deleted_at IS NULL
		WHERE ai.id = ${agentId} AND ai.deleted_at IS NULL
		LIMIT 1
	`;
	return row || null;
}

// ── Solana leg (Metaplex Core) ───────────────────────────────────────────────

/** True when the agent already carries a minted identity on this network. */
function alreadyMintedOn(meta, network) {
	if (network === 'mainnet') return !!meta?.sol_mint_address;
	return !!meta?.devnet?.sol_mint_address;
}

async function solanaDraftMint({ agent, network }) {
	if (alreadyMintedOn(agent.meta, network)) {
		const asset =
			network === 'mainnet' ? agent.meta.sol_mint_address : agent.meta.devnet.sol_mint_address;
		return { status: 'already', network, asset };
	}

	// Late import: the Umi/mpl-core stack is heavy and only needed on the mint
	// path, never for flag parsing or the EVM leg.
	const {
		authoritySecret,
		buildAuthorityUmi,
		resolveAgentCollection,
		loadCollectionAsset,
		deployAgentOnce,
		explorerUrl,
	} = await import('./onchain-deploy.js');

	if (!authoritySecret()) {
		return { status: 'skipped', reason: 'authority_unconfigured', network };
	}

	const { umi, authoritySigner } = buildAuthorityUmi(network);
	const collectionAddr = await resolveAgentCollection({ umi, authoritySigner, network });
	const collectionAsset = await loadCollectionAsset(umi, collectionAddr);
	const result = await deployAgentOnce({
		umi,
		authoritySigner,
		collectionAddr,
		collectionAsset,
		agent,
		network,
	});
	return {
		status: 'minted',
		network,
		asset: result.asset,
		signature: result.signature,
		collection: collectionAddr,
		owner: result.ownerAddress,
		explorer: explorerUrl(result.asset, network),
		registry: result.registry
			? { identity_pda: result.registry.identityPda, signature: result.registry.signature }
			: null,
	};
}

// ── EVM leg (ERC-8004 Identity Registry) ─────────────────────────────────────

const ERC8004_REGISTER_ABI = [
	'function register(string) returns (uint256)',
	'event Registered(uint256 indexed agentId, string metadataURI, address indexed owner)',
];

/** Gas floor for the agent's custodial EVM wallet before it can self-sign. */
const EVM_GAS_FLOOR_WEI = 250_000_000_000_000n; // 0.00025 native

function evmExplorerTx(chain, txHash) {
	return chain.explorer ? `${chain.explorer}/tx/${txHash}` : null;
}

/** Build the agent card the registry URI resolves to (three.ws Card v1 shape). */
function buildDraftAgentCard({ agent, origin, publicUrl }) {
	const image = agent.thumbnail_key ? publicUrl(agent.thumbnail_key) : `${origin}/og.png`;
	const glb = agent.storage_key ? publicUrl(agent.storage_key) : null;
	return {
		name: agent.name || 'Agent',
		description: agent.description || `${agent.name || 'Agent'}, an autonomous agent on three.ws`,
		image,
		url: `${origin}/agent/${agent.id}`,
		active: false, // draft identity: registered on-chain, not yet live
		x402Support: true,
		services: glb ? [{ name: 'avatar', endpoint: glb, type: 'model/gltf-binary' }] : [],
	};
}

/**
 * Pin the draft card: real IPFS when a provider is configured, else the R2
 * manifest fallback (same policy as onchain-deploy's pinManifest).
 */
async function pinDraftCard(card, agentId) {
	const bytes = Buffer.from(JSON.stringify(card, null, 2), 'utf-8');
	const { pinToIPFS } = await import('./ipfs-pin.js');
	const pinned = await pinToIPFS(bytes, `agent-${agentId}.json`).catch(() => null);
	if (pinned?.uri) return pinned.uri;
	const { putObject, publicUrl } = await import('./r2.js');
	const key = `agent-manifests/draft-evm/${agentId}.json`;
	await putObject({ key, body: bytes, contentType: 'application/json' });
	return publicUrl(key);
}

async function evmDraftMint({ agent, userId, chainId }) {
	const { CHAIN_BY_ID } = await import('./erc8004-chains.js');
	const chain = CHAIN_BY_ID[chainId];
	if (!chain) return { status: 'skipped', reason: 'unsupported_chain', chainId };
	if (agent.meta?.onchain?.chain === `eip155:${chainId}` && agent.meta.onchain.onchain_id) {
		return {
			status: 'already',
			chainId,
			onchainId: agent.meta.onchain.onchain_id,
			txHash: agent.meta.onchain.tx_hash || null,
		};
	}

	const { evmFallbackProvider } = await import('./evm/rpc.js');
	const { getOrCreateAgentEvmWallet, recoverAgentKey } = await import('./agent-wallet.js');
	const { address: evmAddress } = await getOrCreateAgentEvmWallet(agent.id, { chainId });
	const provider = await evmFallbackProvider(chainId);

	const { publicUrl } = await import('./r2.js');
	const card = buildDraftAgentCard({ agent, origin: env.APP_ORIGIN, publicUrl });
	const metadataUri = await pinDraftCard(card, agent.id);

	const { Contract, Wallet, Interface, parseEther, formatEther } = await import('ethers');
	const iface = new Interface(ERC8004_REGISTER_ABI);
	const data = iface.encodeFunctionData('register(string)', [metadataUri]);

	const treasurySecret = (process.env.EVM_TREASURY_PRIVATE_KEY || '').trim();
	if (!treasurySecret) {
		// Dry-run proof path: the calldata is real, the chain is reachable, and
		// the estimate is produced by the chain itself. Nothing is broadcast.
		let estimatedGas = null;
		try {
			estimatedGas = (
				await provider.estimateGas({ from: evmAddress, to: chain.registry, data, gasPrice: 0 })
			).toString();
		} catch (err) {
			estimatedGas = `unavailable: ${err?.shortMessage || err?.message || 'estimate failed'}`;
		}
		return {
			status: 'dry_run',
			chainId,
			chain: chain.name,
			registry: chain.registry,
			from: evmAddress,
			to: chain.registry,
			data,
			metadataUri,
			estimatedGas,
			missing: 'EVM_TREASURY_PRIVATE_KEY',
		};
	}

	// Fund the agent wallet for gas from the EVM treasury when it is light.
	const treasury = new Wallet(treasurySecret, provider);
	const bal = await provider.getBalance(evmAddress);
	if (bal < EVM_GAS_FLOOR_WEI) {
		const topUp = EVM_GAS_FLOOR_WEI - bal;
		const tbal = await provider.getBalance(treasury.address);
		if (tbal < topUp + parseEther('0.0001')) {
			return {
				status: 'skipped',
				reason: `treasury_low:${formatEther(tbal)}`,
				chainId,
			};
		}
		const fundTx = await treasury.sendTransaction({ to: evmAddress, value: topUp });
		await fundTx.wait();
	}

	const full = await loadAgentContext(agent.id);
	const encKey = full?.meta?.encrypted_wallet_key;
	if (!encKey) return { status: 'skipped', reason: 'no_evm_key', chainId };
	const pkHex = await recoverAgentKey(encKey, {
		agentId: agent.id,
		userId,
		reason: 'draft_agent_mint',
	});
	const signer = new Wallet(pkHex, provider);
	const registry = new Contract(chain.registry, ERC8004_REGISTER_ABI, signer);
	const tx = await registry['register(string)'](metadataUri);
	const receipt = await tx.wait();

	let onChainId = null;
	for (const lg of receipt.logs || []) {
		try {
			const parsed = registry.interface.parseLog(lg);
			if (parsed?.name === 'Registered') {
				onChainId = parsed.args[0].toString();
				break;
			}
		} catch { /* not our event */ }
	}
	if (!onChainId) throw new Error('Registered event not found in draft-mint receipt');

	// Persist exactly what register-confirm.js persists after verifying a mint:
	// the crawler index row plus the unified meta.onchain block on the agent.
	await sql`
		INSERT INTO erc8004_agents_index
			(chain_id, agent_id, owner, registry, agent_uri,
			 registered_block, registered_tx, registered_at, last_seen_at)
		VALUES
			(${chainId}, ${onChainId}, ${evmAddress.toLowerCase()}, ${chain.registry.toLowerCase()},
			 ${metadataUri}, ${Number(receipt.blockNumber)}, ${receipt.hash}, now(), now())
		ON CONFLICT (chain_id, agent_id) DO NOTHING
	`;
	const [cur] = await sql`SELECT meta FROM agent_identities WHERE id = ${agent.id}`;
	const onchain = {
		chain: `eip155:${chainId}`,
		family: 'evm',
		tx_hash: receipt.hash,
		onchain_id: onChainId,
		contract_or_mint: chain.registry,
		wallet: evmAddress.toLowerCase(),
		metadata_uri: metadataUri,
		draft: true,
		confirmed_at: new Date().toISOString(),
	};
	await sql`
		UPDATE agent_identities
		SET meta = ${JSON.stringify({ ...(cur?.meta || {}), onchain })}::jsonb, updated_at = NOW()
		WHERE id = ${agent.id}
	`;

	return {
		status: 'minted',
		chainId,
		chain: chain.name,
		registry: chain.registry,
		onchainId,
		owner: evmAddress,
		txHash: receipt.hash,
		metadataUri,
		explorer: evmExplorerTx(chain, receipt.hash),
	};
}

// ── Avatar traceability ──────────────────────────────────────────────────────

/** Stamp the draft-mint outcome onto the avatar's source_meta for audit. */
async function persistAvatarDraft({ avatarId, jobId, solana, evm }) {
	const stamp = {
		draft_mint: {
			job_id: jobId,
			solana: solana
				? { status: solana.status, network: solana.network, asset: solana.asset || null, signature: solana.signature || null }
				: null,
			evm: evm
				? { status: evm.status, chain_id: evm.chainId ?? null, onchain_id: evm.onchainId || null, tx_hash: evm.txHash || null }
				: null,
			minted_at: new Date().toISOString(),
		},
	};
	await sql`
		UPDATE avatars
		SET source_meta = coalesce(source_meta, '{}'::jsonb) || ${JSON.stringify(stamp)}::jsonb
		WHERE id = ${avatarId}
	`;
}

// ── Orchestration ────────────────────────────────────────────────────────────

function defaultDeps() {
	return {
		resolveAgent: resolveOrCreateAgentForAvatar,
		loadAgentContext,
		solanaMint: solanaDraftMint,
		evmMint: evmDraftMint,
		persistAvatarDraft,
		network: resolveDraftMintNetwork(),
		evm: resolveDraftMintEvm(),
	};
}

/**
 * Mint the draft on-chain identity for a freshly reconstructed avatar.
 *
 * @param {object} input
 * @param {string} input.userId    owner of the avatar
 * @param {string} input.avatarId  the materialized reconstruction avatar
 * @param {string} [input.jobId]   originating regen job (traceability only)
 * @param {object} [deps]          injected dependencies (testing)
 * @returns {Promise<{ status: string, agentId?: string, solana?: object|null, evm?: object|null }>}
 */
export async function mintDraftAgentIdentity({ userId, avatarId, jobId = null }, deps = defaultDeps()) {
	const agent = await deps.resolveAgent({ userId, avatarId });
	if (!agent) return { status: 'no_agent' };

	let solana = null;
	let evm = null;

	if (deps.network !== 'off') {
		const ctx = await deps.loadAgentContext(agent.id);
		if (ctx) {
			solana = await deps.solanaMint({ agent: ctx, network: deps.network });
		}
	}

	if (deps.evm?.enabled) {
		const ctx = await deps.loadAgentContext(agent.id);
		if (ctx) {
			evm = await deps.evmMint({ agent: ctx, userId, chainId: deps.evm.chainId });
		}
	}

	if ((solana && solana.status !== 'skipped') || evm) {
		await deps.persistAvatarDraft({ avatarId, jobId, solana, evm }).catch((err) => {
			console.warn('[draft-mint] avatar stamp failed:', err?.message);
		});
	}

	return { status: 'ok', agentId: agent.id, solana, evm };
}
