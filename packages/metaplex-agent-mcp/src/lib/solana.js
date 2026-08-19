// Umi construction, key handling, balances, and explorer links.

import bs58 from 'bs58';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { mplCore, findAssetSignerPda } from '@metaplex-foundation/mpl-core';
import { keypairIdentity, publicKey as umiPublicKey } from '@metaplex-foundation/umi';
import { mplAgentIdentity } from '@metaplex-foundation/mpl-agent-registry';

import { NETWORK, rpcFor, SOLANA_DEFAULT_SECRET } from '../config.js';

export const LAMPORTS_PER_SOL = 1_000_000_000;

// Conservative cost ceilings, mirrored from the three.ws deploy pipeline:
// a Core mint is ~0.004 SOL (rent + fee), the identity PDA ~0.003 SOL.
export const EST_MINT_LAMPORTS = Math.floor(0.004 * LAMPORTS_PER_SOL);
export const EST_REGISTER_LAMPORTS = Math.floor(0.003 * LAMPORTS_PER_SOL);

/** Parse a base58 secret key or a JSON byte array into a 64-byte secret. */
export function parseSecretKey(secret) {
	const raw = String(secret || '').trim();
	if (!raw) {
		throw Object.assign(
			new Error('No Solana key configured. Set SOLANA_SECRET_KEY (base58 or JSON byte array) or pass `secret`.'),
			{ code: 'no_signer' },
		);
	}
	let bytes;
	if (raw.startsWith('[')) {
		try {
			bytes = Uint8Array.from(JSON.parse(raw));
		} catch {
			throw Object.assign(new Error('secret looks like a JSON array but does not parse'), { code: 'bad_secret' });
		}
	} else {
		try {
			bytes = bs58.decode(raw);
		} catch {
			throw Object.assign(new Error('secret is not valid base58'), { code: 'bad_secret' });
		}
	}
	if (bytes.length !== 64) {
		throw Object.assign(new Error(`secret must be a 64-byte keypair (got ${bytes.length} bytes)`), {
			code: 'bad_secret',
		});
	}
	return bytes;
}

/**
 * Build a Umi instance with the Core and Agent Identity programs registered.
 * Pass `secret` (or rely on SOLANA_SECRET_KEY) to attach a signing identity;
 * omit both for read-only or noop-signer (wallet prep) usage.
 */
export function buildUmi({ network = NETWORK, secret, requireSigner = false } = {}) {
	const umi = createUmi(rpcFor(network)).use(mplCore()).use(mplAgentIdentity());
	const material = secret !== undefined && String(secret).trim() !== '' ? secret : SOLANA_DEFAULT_SECRET;
	if (material) {
		const keypair = umi.eddsa.createKeypairFromSecretKey(parseSecretKey(material));
		umi.use(keypairIdentity(keypair));
	} else if (requireSigner) {
		parseSecretKey(''); // throws no_signer with the actionable message
	}
	return umi;
}

/** SOL balance of an address, as a number of SOL. */
export async function solBalance(umi, address) {
	const value = await umi.rpc.getBalance(umiPublicKey(address));
	return Number(value.basisPoints) / LAMPORTS_PER_SOL;
}

/** The asset's built-in wallet: the mpl-core Asset Signer PDA. */
export function assetSignerAddress(umi, asset) {
	const [pda] = findAssetSignerPda(umi, { asset: umiPublicKey(asset) });
	return pda.toString();
}

const cluster = (network) => (network === 'devnet' ? '?cluster=devnet' : '');

/** Everywhere a freshly minted agent can be seen. */
export function agentLinks(asset, network = NETWORK) {
	return {
		metaplex_agents: `https://www.metaplex.com/agents/${asset}`,
		core_explorer: `https://core.metaplex.com/explorer/${asset}${network === 'devnet' ? '?env=devnet' : ''}`,
		solscan: `https://solscan.io/account/${asset}${cluster(network)}`,
	};
}

export function txLink(signature, network = NETWORK) {
	return `https://solscan.io/tx/${signature}${cluster(network)}`;
}

export function toBase58Signature(signature) {
	return typeof signature === 'string' ? signature : bs58.encode(signature);
}
