// Cross-platform on-chain identity-claim verifier.
// ---------------------------------------------------------------------------
// Given a CLAIM that some `identity` controls some `address` on a `chain`, this
// module returns cryptographic / on-chain EVIDENCE that the claim is real —
// never a bare yes/no. It works for ANY claimed identity↔address link, not just
// three.ws agents:
//
//   identity may be   an ENS name (vitalik.eth), an SNS name (bonfida.sol), an
//                     EVM wallet (0x…), a Solana wallet (base58), an ERC-8004
//                     agent id (eip155:8453:42 / 8453:42), or a three.ws
//                     agent_id (uuid).
//   address  is       the mint / contract / wallet the identity asserts control
//                     of.
//
// The agent use-case: before Agent A pays / trades / delegates to a counterparty
// that says "I am the deployer of contract X" or "I own wallet W / name N", A
// calls this once and gets deploy-tx + signer + ownership / name-resolution
// proof. A cross-platform trust check.
//
// Verdict discipline (CLAUDE.md "no errors without solutions", no false
// positives):
//   verified === true            concrete on-chain evidence links identity→address
//   verified === false           we read the authoritative source and it links
//                                 the address to someone ELSE (or nobody)
//   verified === 'unverifiable'  we could not read enough to decide (name did not
//                                 resolve, explorer key absent, RPC down, address
//                                 is an opaque EOA with nothing to compare). Comes
//                                 with a `caveats[]` list of exactly what is
//                                 missing. NEVER a false positive.
//
// Every network-touching resolver is injectable via `deps` (real defaults below)
// so the whole matrix is unit-testable without a live chain, and so a single
// upstream outage degrades one evidence source rather than failing the call.

// UUID v-any check, inlined so this trust primitive drags in no import-time
// dependency (every heavier resolver is lazy-imported on demand below).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value) {
	return typeof value === 'string' && UUID_RE.test(value);
}

const EVM_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX_RE = /^0x[0-9a-fA-F]{64}$/;
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ENS_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;
// A dotted `.sol` name (bare label rejected — that would collide with a base58
// address ending in a real TLD is impossible since base58 has no dots).
const SNS_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.sol$/i;
// ERC-8004 id: `<chainId>:<agentId>` optionally CAIP-2-prefixed (`eip155:`).
const ERC8004_RE = /^(?:eip155:)?(\d+):(\d+)$/;

// CAIP-2 → EVM chainId for the chains we can resolve ENS / contract creation on.
// ENS itself only lives on Ethereum mainnet (1); the rest are for contract
// deploy / ownership reads.
const CAIP2_TO_EVM_CHAINID = {
	'eip155:1': 1,
	'eip155:10': 10,
	'eip155:56': 56,
	'eip155:100': 100,
	'eip155:137': 137,
	'eip155:8453': 8453,
	'eip155:42161': 42161,
	'eip155:43114': 43114,
	'eip155:59144': 59144,
	'eip155:534352': 534352,
	'eip155:84532': 84532,
	'eip155:11155111': 11155111,
};

// Etherscan V2 unified multichain API — one key covers every chain via `chainid`.
const ETHERSCAN_V2 = 'https://api.etherscan.io/v2/api';

function normEvm(addr) {
	return typeof addr === 'string' && EVM_ADDR_RE.test(addr) ? addr.toLowerCase() : null;
}
function eqEvm(a, b) {
	const na = normEvm(a);
	const nb = normEvm(b);
	return !!na && na === nb;
}
function eqSol(a, b) {
	return typeof a === 'string' && typeof b === 'string' && a === b && SOL_ADDR_RE.test(a);
}

function evmChainIdFor(chain) {
	if (!chain) return null;
	if (CAIP2_TO_EVM_CHAINID[chain] != null) return CAIP2_TO_EVM_CHAINID[chain];
	const m = /^eip155:(\d+)$/.exec(chain);
	return m ? Number(m[1]) : null;
}

function isSolanaChain(chain) {
	return typeof chain === 'string' && chain.startsWith('solana:');
}

/**
 * Classify the claimed identity string into a resolver family. `chain` is an
 * optional CAIP-2 hint that disambiguates address-shaped identities.
 * @returns {{ type: string, chainId?: number, agentId?: string }}
 */
export function classifyIdentity(identity, chain) {
	const id = String(identity || '').trim();
	if (!id) return { type: 'unknown' };
	if (isUuid(id)) return { type: 'threews_agent_id' };
	if (SNS_RE.test(id)) return { type: 'sns' };
	if (ENS_RE.test(id)) return { type: 'ens' };
	const erc = ERC8004_RE.exec(id);
	if (erc) return { type: 'erc8004', chainId: Number(erc[1]), agentId: erc[2] };
	if (EVM_ADDR_RE.test(id)) return { type: 'evm_address' };
	// A bare integer is an ERC-8004 agent id only when the chain hint is EVM.
	if (/^\d+$/.test(id) && evmChainIdFor(chain)) {
		return { type: 'erc8004', chainId: evmChainIdFor(chain), agentId: id };
	}
	if (SOL_ADDR_RE.test(id)) return { type: 'solana_address' };
	return { type: 'unknown' };
}

// ---------------------------------------------------------------------------
// Real resolvers (default deps). Each is defensive: it resolves to a value or
// null/❴reason❵ and never throws, so a degraded upstream becomes an
// 'unverifiable' verdict with a caveat rather than a 500.
// ---------------------------------------------------------------------------

async function realEvmProvider(chainId) {
	const { evmFallbackProvider } = await import('../evm/rpc.js');
	const { SERVER_CHAIN_META } = await import('../onchain.js');
	const primaryUrl = SERVER_CHAIN_META[chainId]?.rpc || null;
	return evmFallbackProvider(chainId, { primaryUrl });
}

function withTimeout(promise, ms, label) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error(`${label || 'op'} timeout ${ms}ms`)), ms);
		Promise.resolve(promise).then(
			(v) => { clearTimeout(t); resolve(v); },
			(e) => { clearTimeout(t); reject(e); },
		);
	});
}

export const realDeps = {
	// ENS forward resolution (name → address). Mainnet only — ENS canonical
	// registry lives on chain 1.
	// Both directions go through the shared Universal Resolver helper (one
	// eth_call each). The previous ethers walk cost 9.7-12.4s on the keyless
	// public endpoints, so this 5s budget expired on every ENS claim in
	// production and silently downgraded to "no ENS evidence". A miss and a
	// failure are both null here on purpose: this is corroborating evidence,
	// and absent evidence is simply not counted.
	async resolveEns(name) {
		try {
			const { ensResolveAddress } = await import('../evm/ens.js');
			return normEvm(await ensResolveAddress(name, { timeoutMs: 5000 }));
		} catch { return null; }
	},
	// ENS reverse resolution (address → primary name) — extra corroborating evidence.
	async reverseEns(address) {
		try {
			const { ensLookupName } = await import('../evm/ens.js');
			return (await ensLookupName(address, { timeoutMs: 5000 })) || null;
		} catch { return null; }
	},
	async resolveSns(name) {
		try {
			const { resolveSnsName } = await import('../../../src/solana/sns.js');
			const addr = await withTimeout(resolveSnsName(name), 6000, 'sns_resolve');
			return addr && SOL_ADDR_RE.test(addr) ? addr : null;
		} catch { return null; }
	},
	async reverseSns(address) {
		try {
			const { reverseLookupAddress } = await import('../../../src/solana/sns.js');
			return (await withTimeout(reverseLookupAddress(address), 6000, 'sns_reverse')) || null;
		} catch { return null; }
	},
	// EVM bytecode presence — distinguishes a contract from an EOA.
	async getEvmCode(chainId, address) {
		try {
			const provider = await realEvmProvider(chainId);
			return await withTimeout(provider.getCode(address), 5000, 'eth_getCode');
		} catch { return null; }
	},
	// Contract creator + creation tx via Etherscan V2. Without a key we cannot
	// read the deployer keylessly — return a reason so the caller degrades to
	// 'unverifiable' rather than guessing.
	async getEvmContractCreation(chainId, address) {
		const key = process.env.ETHERSCAN_API_KEY;
		if (!key) return { deployer: null, txHash: null, reason: 'no_explorer_key' };
		try {
			const url = `${ETHERSCAN_V2}?chainid=${chainId}&module=contract&action=getcontractcreation&contractaddresses=${address}&apikey=${key}`;
			const res = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
			if (!res.ok) return { deployer: null, txHash: null, reason: `explorer_http_${res.status}` };
			const data = await res.json();
			const row = Array.isArray(data?.result) ? data.result[0] : null;
			if (!row?.contractCreator) return { deployer: null, txHash: null, reason: 'no_creation_record' };
			return {
				deployer: normEvm(row.contractCreator),
				txHash: EVM_TX_RE.test(row.txHash || '') ? row.txHash : null,
			};
		} catch { return { deployer: null, txHash: null, reason: 'explorer_unreachable' }; }
	},
	// Optional `owner()` getter — many contracts (Ownable) expose it.
	async getEvmOwner(chainId, address) {
		try {
			const { Contract } = await import('ethers');
			const provider = await realEvmProvider(chainId);
			const c = new Contract(address, ['function owner() view returns (address)'], provider);
			const owner = await withTimeout(c.owner(), 5000, 'owner');
			return normEvm(owner);
		} catch { return null; }
	},
	// Solana mint/metadata authorities. Returns null when the account isn't a
	// mint (or doesn't exist) so a wallet-vs-wallet claim degrades cleanly.
	async getSolanaMintInfo(mint) {
		try {
			const { PublicKey } = await import('@solana/web3.js');
			const { getConnection } = await import('../pump.js');
			const connection = getConnection({ network: 'mainnet' });
			const pk = new PublicKey(mint);
			const parsed = await withTimeout(connection.getParsedAccountInfo(pk), 6000, 'sol_mint');
			const value = parsed?.value;
			if (!value) return null;
			const info = value.data?.parsed?.info;
			const isMint = value.data?.program === 'spl-token' && value.data?.parsed?.type === 'mint';
			if (!isMint || !info) return null;
			const out = {
				mintAuthority: info.mintAuthority || null,
				freezeAuthority: info.freezeAuthority || null,
				updateAuthority: null,
			};
			// Metaplex metadata update authority (the "creator" that controls the
			// token's name/URI). Decoded from the metadata PDA: key(1) + updateAuth(32).
			try {
				const bs58 = (await import('bs58')).default;
				const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
				const [metaPda] = PublicKey.findProgramAddressSync(
					[Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), pk.toBuffer()],
					METADATA_PROGRAM,
				);
				const acc = await withTimeout(connection.getAccountInfo(metaPda), 6000, 'sol_meta');
				if (acc?.data && acc.data.length >= 33) {
					out.updateAuthority = bs58.encode(acc.data.subarray(1, 33));
				}
			} catch { /* metadata optional — mint authority alone is evidence */ }
			return out;
		} catch { return null; }
	},
	// three.ws canonical meta.onchain index row for a platform agent_id.
	async lookupThreewsIndex(agentId) {
		try {
			const { sql } = await import('../db.js');
			const [row] = await sql`
				select meta
				  from agent_identities
				 where id = ${agentId}
				   and deleted_at is null
				 limit 1
			`;
			return row?.meta || null;
		} catch { return null; }
	},
	// ERC-8004 Identity Registry ownerOf / getAgentWallet.
	async resolveErc8004(chainId, agentId) {
		try {
			const { resolveOnChainAgent } = await import('../onchain.js');
			const r = await resolveOnChainAgent({ chainId, agentId, fetchManifest: false, timeoutMs: 5000 });
			if (r?.error && !r.owner && !r.wallet) return { owner: null, wallet: null, reason: r.error };
			return { owner: r.owner || null, wallet: r.wallet || null, registry: r.registry || null, explorer: r.explorer || null };
		} catch (err) { return { owner: null, wallet: null, reason: err.message }; }
	},
};

// ---------------------------------------------------------------------------
// Verdict assembly
// ---------------------------------------------------------------------------

function result({ identity, address, chain, identity_type, verified, method, evidence, caveats }) {
	return {
		claim: { identity, address, chain: chain || null },
		identity_type,
		verified,
		method,
		evidence: evidence || [],
		caveats: caveats || [],
		ts: new Date().toISOString(),
	};
}

async function verifyEns({ identity, address, chain, deps }) {
	const evidence = [];
	const caveats = [];
	if (!EVM_ADDR_RE.test(address)) {
		caveats.push('an ENS name resolves to an EVM address; the claimed address is not a valid 0x… address');
		return { verified: 'unverifiable', method: 'ens-resolution', evidence, caveats };
	}
	const resolved = await deps.resolveEns(identity);
	if (!resolved) {
		caveats.push('ENS name did not resolve to any address (unregistered, no address record, or Ethereum RPC unavailable)');
		evidence.push({ kind: 'ens_resolution', ref: identity, detail: 'no address record found' });
		return { verified: 'unverifiable', method: 'ens-resolution', evidence, caveats };
	}
	evidence.push({ kind: 'ens_forward_resolution', ref: identity, detail: `resolves to ${resolved}` });
	const rev = await deps.reverseEns(address);
	if (rev) evidence.push({ kind: 'ens_reverse_resolution', ref: address, detail: `primary name ${rev}` });
	const match = eqEvm(resolved, address);
	if (!match) {
		caveats.push(`${identity} resolves to ${resolved}, which is not the claimed address`);
	}
	return { verified: match, method: 'ens-resolution', evidence, caveats };
}

async function verifySns({ identity, address, chain, deps }) {
	const evidence = [];
	const caveats = [];
	if (!SOL_ADDR_RE.test(address)) {
		caveats.push('an SNS (.sol) name resolves to a Solana address; the claimed address is not valid base58');
		return { verified: 'unverifiable', method: 'sns-resolution', evidence, caveats };
	}
	const resolved = await deps.resolveSns(identity);
	if (!resolved) {
		caveats.push('SNS name did not resolve (unregistered, no owner record, or Solana RPC unavailable)');
		evidence.push({ kind: 'sns_resolution', ref: identity, detail: 'no owner record found' });
		return { verified: 'unverifiable', method: 'sns-resolution', evidence, caveats };
	}
	evidence.push({ kind: 'sns_forward_resolution', ref: identity, detail: `resolves to ${resolved}` });
	const rev = await deps.reverseSns(address);
	if (rev) evidence.push({ kind: 'sns_reverse_resolution', ref: address, detail: `favorite domain ${rev}` });
	const match = eqSol(resolved, address);
	if (!match) caveats.push(`${identity} resolves to ${resolved}, which is not the claimed address`);
	return { verified: match, method: 'sns-resolution', evidence, caveats };
}

async function verifyEvmAddress({ identity, address, chain, deps }) {
	const evidence = [];
	const caveats = [];
	const chainId = evmChainIdFor(chain) || 1;
	if (!chain) caveats.push('no chain supplied; defaulted to Ethereum mainnet (eip155:1) for the contract read');

	if (!EVM_ADDR_RE.test(address)) {
		caveats.push('claimed address is not a valid EVM (0x…) address');
		return { verified: 'unverifiable', method: 'evm-control', evidence, caveats };
	}
	if (eqEvm(identity, address)) {
		evidence.push({ kind: 'same_address', ref: address, detail: 'identity and address are the same account' });
		return { verified: true, method: 'evm-same-address', evidence, caveats };
	}

	const code = await deps.getEvmCode(chainId, address);
	const isContract = typeof code === 'string' && code !== '0x' && code.length > 2;

	if (!isContract) {
		if (code == null) caveats.push(`could not read bytecode at ${address} on eip155:${chainId} (RPC unavailable)`);
		else caveats.push(`${address} is an externally-owned account (no bytecode); two distinct EOAs cannot be linked on-chain without a signature — supply an ENS/SNS name or an ERC-8004 id instead`);
		return { verified: 'unverifiable', method: 'evm-control', evidence, caveats };
	}
	evidence.push({ kind: 'evm_bytecode', ref: address, detail: `contract on eip155:${chainId}` });

	let matched = false;
	let readSomething = false;

	const creation = await deps.getEvmContractCreation(chainId, address);
	if (creation?.deployer) {
		readSomething = true;
		evidence.push({ kind: 'evm_deployer', ref: creation.deployer, detail: 'contract creator (deployer)' });
		if (creation.txHash) evidence.push({ kind: 'evm_deploy_tx', ref: creation.txHash, detail: 'contract creation transaction' });
		if (eqEvm(creation.deployer, identity)) matched = true;
	} else if (creation?.reason === 'no_explorer_key') {
		caveats.push('deployer lookup unavailable (no explorer API key configured); relied on owner() only');
	} else if (creation?.reason) {
		caveats.push(`deployer lookup degraded: ${creation.reason}`);
	}

	const owner = await deps.getEvmOwner(chainId, address);
	if (owner) {
		readSomething = true;
		evidence.push({ kind: 'evm_owner', ref: owner, detail: 'contract owner() getter' });
		if (eqEvm(owner, identity)) matched = true;
	}

	if (matched) return { verified: true, method: 'evm-contract-control', evidence, caveats };
	if (readSomething) {
		caveats.push(`${identity} is neither the deployer nor the owner of ${address}`);
		return { verified: false, method: 'evm-contract-control', evidence, caveats };
	}
	caveats.push('could not read deployer (no explorer key) or an owner() getter; control is undetermined');
	return { verified: 'unverifiable', method: 'evm-contract-control', evidence, caveats };
}

async function verifySolanaAddress({ identity, address, chain, deps }) {
	const evidence = [];
	const caveats = [];
	if (!SOL_ADDR_RE.test(address)) {
		caveats.push('claimed address is not valid base58 for Solana');
		return { verified: 'unverifiable', method: 'solana-control', evidence, caveats };
	}
	if (eqSol(identity, address)) {
		evidence.push({ kind: 'same_address', ref: address, detail: 'identity and address are the same account' });
		return { verified: true, method: 'solana-same-address', evidence, caveats };
	}

	const info = await deps.getSolanaMintInfo(address);
	if (!info) {
		caveats.push(`${address} is not a readable SPL mint (or RPC unavailable); two distinct Solana wallets cannot be linked on-chain without a signature — supply an SNS (.sol) name instead`);
		return { verified: 'unverifiable', method: 'solana-control', evidence, caveats };
	}

	let matched = false;
	if (info.mintAuthority) {
		evidence.push({ kind: 'solana_mint_authority', ref: info.mintAuthority, detail: 'SPL mint authority' });
		if (eqSol(info.mintAuthority, identity)) matched = true;
	}
	if (info.updateAuthority) {
		evidence.push({ kind: 'solana_update_authority', ref: info.updateAuthority, detail: 'Metaplex metadata update authority (creator)' });
		if (eqSol(info.updateAuthority, identity)) matched = true;
	}
	if (info.freezeAuthority) {
		evidence.push({ kind: 'solana_freeze_authority', ref: info.freezeAuthority, detail: 'SPL freeze authority' });
		if (eqSol(info.freezeAuthority, identity)) matched = true;
	}

	if (matched) return { verified: true, method: 'solana-mint-authority', evidence, caveats };
	if (!info.mintAuthority && !info.updateAuthority && !info.freezeAuthority) {
		caveats.push('all mint authorities are renounced/null; no on-chain authority links this mint to any wallet');
		return { verified: 'unverifiable', method: 'solana-mint-authority', evidence, caveats };
	}
	caveats.push(`${identity} is not the mint, freeze, or update authority of ${address}`);
	return { verified: false, method: 'solana-mint-authority', evidence, caveats };
}

async function verifyErc8004({ identity, address, chain, chainId, agentId, deps }) {
	const evidence = [];
	const caveats = [];
	const cid = chainId || evmChainIdFor(chain);
	if (!cid) {
		caveats.push('ERC-8004 id needs a chain: pass identity as `eip155:<chainId>:<agentId>` or supply chain=eip155:<chainId>');
		return { verified: 'unverifiable', method: 'erc8004-registry', evidence, caveats };
	}
	const r = await deps.resolveErc8004(cid, agentId);
	if (!r || (!r.owner && !r.wallet)) {
		caveats.push(`ERC-8004 agent #${agentId} on eip155:${cid} has no on-chain owner/wallet record${r?.reason ? ` (${r.reason})` : ''}`);
		return { verified: 'unverifiable', method: 'erc8004-registry', evidence, caveats };
	}
	const registryRef = r.registry ? `${r.registry}#${agentId}` : `eip155:${cid}#${agentId}`;
	let matched = false;
	if (r.owner) {
		evidence.push({ kind: 'erc8004_owner_of', ref: r.owner, detail: `Identity Registry ownerOf(${agentId})` });
		if (eqEvm(r.owner, address)) matched = true;
	}
	if (r.wallet) {
		evidence.push({ kind: 'erc8004_agent_wallet', ref: r.wallet, detail: `getAgentWallet(${agentId})` });
		if (eqEvm(r.wallet, address)) matched = true;
	}
	evidence.push({ kind: 'erc8004_registration', ref: registryRef, detail: 'ERC-8004 Identity Registry entry' });
	if (matched) return { verified: true, method: 'erc8004-registry', evidence, caveats };
	caveats.push(`ERC-8004 agent #${agentId} does not resolve to the claimed address`);
	return { verified: false, method: 'erc8004-registry', evidence, caveats };
}

async function verifyThreewsAgentId({ identity, address, chain, deps }) {
	const evidence = [];
	const caveats = [];
	const meta = await deps.lookupThreewsIndex(identity);
	if (!meta) {
		caveats.push('agent_id is not present in the three.ws registry (deleted, unknown, or DB unavailable)');
		return { verified: 'unverifiable', method: 'threews-onchain-index', evidence, caveats };
	}
	const onchain = meta.onchain || {};
	// Canonical deploy record — the tx_hash/owner here are real on-chain and
	// checkable on any explorer.
	const indexedMint = onchain.contract_or_mint || meta.sol_mint_address || null;
	const custodialWallet = onchain.owner || onchain.wallet || meta.solana_address || null;
	const matchAddr = (cand) =>
		cand && (isSolanaChain(onchain.chain) || SOL_ADDR_RE.test(String(cand)) ? eqSol(cand, address) : eqEvm(cand, address));

	if (indexedMint && matchAddr(indexedMint)) {
		if (onchain.tx_hash) evidence.push({ kind: 'threews_deploy_tx', ref: onchain.tx_hash, detail: `deploy tx on ${onchain.chain || 'chain'}` });
		if (custodialWallet) evidence.push({ kind: 'threews_owner', ref: custodialWallet, detail: 'recorded owner wallet' });
		if (onchain.metadata_uri) evidence.push({ kind: 'threews_metadata_uri', ref: onchain.metadata_uri, detail: 'on-chain metadata URI' });
		evidence.push({ kind: 'threews_onchain_index', ref: indexedMint, detail: `three.ws canonical deploy record${onchain.confirmed_at ? ` (confirmed ${onchain.confirmed_at})` : ''}` });
		return { verified: true, method: 'threews-onchain-index', evidence, caveats };
	}
	if (custodialWallet && matchAddr(custodialWallet)) {
		evidence.push({ kind: 'threews_custodial_wallet', ref: custodialWallet, detail: 'three.ws custodial wallet for this agent' });
		return { verified: true, method: 'threews-custodial-wallet', evidence, caveats };
	}
	if (!indexedMint && !custodialWallet) {
		caveats.push('agent exists but has no on-chain identity recorded yet (never deployed)');
		return { verified: 'unverifiable', method: 'threews-onchain-index', evidence, caveats };
	}
	if (indexedMint) evidence.push({ kind: 'threews_onchain_index', ref: indexedMint, detail: 'agent owns a different address than claimed' });
	caveats.push('the three.ws record for this agent does not link it to the claimed address');
	return { verified: false, method: 'threews-onchain-index', evidence, caveats };
}

/**
 * Verify a claim that `identity` controls `address` on `chain`.
 *
 * @param {{ identity: string, address: string, chain?: string }} claim
 * @param {object} [deps] resolver overrides (defaults to real on-chain sources)
 * @returns {Promise<{
 *   claim: { identity: string, address: string, chain: string|null },
 *   identity_type: string,
 *   verified: boolean|'unverifiable',
 *   method: string,
 *   evidence: Array<{ kind: string, ref: string, detail: string }>,
 *   caveats: string[],
 *   ts: string,
 * }>}
 */
export async function verifyClaim({ identity, address, chain } = {}, deps = realDeps) {
	const id = String(identity || '').trim();
	const addr = String(address || '').trim();
	const chn = chain ? String(chain).trim() : null;

	const { type, chainId, agentId } = classifyIdentity(id, chn);

	let outcome;
	try {
		switch (type) {
			case 'ens':
				outcome = await verifyEns({ identity: id, address: addr, chain: chn, deps });
				break;
			case 'sns':
				outcome = await verifySns({ identity: id, address: addr, chain: chn, deps });
				break;
			case 'evm_address':
				outcome = await verifyEvmAddress({ identity: id, address: addr, chain: chn, deps });
				break;
			case 'solana_address':
				outcome = await verifySolanaAddress({ identity: id, address: addr, chain: chn, deps });
				break;
			case 'erc8004':
				outcome = await verifyErc8004({ identity: id, address: addr, chain: chn, chainId, agentId, deps });
				break;
			case 'threews_agent_id':
				outcome = await verifyThreewsAgentId({ identity: id, address: addr, chain: chn, deps });
				break;
			default:
				outcome = {
					verified: 'unverifiable',
					method: 'none',
					evidence: [],
					caveats: ['could not classify the identity — expected an ENS/SNS name, an EVM or Solana address, an ERC-8004 id (eip155:<chainId>:<agentId>), or a three.ws agent_id (uuid)'],
				};
		}
	} catch (err) {
		// Absolute backstop — a resolver that slipped past its own guard must still
		// degrade to unverifiable, never surface as a 500.
		outcome = {
			verified: 'unverifiable',
			method: 'error',
			evidence: [],
			caveats: [`verification degraded: ${err.message}`],
		};
	}

	return result({ identity: id, address: addr, chain: chn, identity_type: type, ...outcome });
}
