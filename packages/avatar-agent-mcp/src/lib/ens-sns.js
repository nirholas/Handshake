// ENS (Ethereum) + SNS (Solana) name resolution.
//
// SNS: read straight from the SPL Name Service accounts on Solana with
// `@bonfida/spl-name-service` over SOLANA_RPC_URL. Resolution is a pair of
// getAccountInfo reads on a deterministically-derived PDA, so it depends on
// nothing but the chain itself and matches what the three.ws backend does
// (api/agents/sns.js). Bonfida's `sns-api.bonfida.com` REST service used to
// back this lane; it now answers 404 on every path, which is exactly why the
// chain is the source of truth here.
//
// ENS: ethers JsonRpcProvider against the configured ETH_RPC_URL, falling
// back to ethers' default public provider rotation. A `.eth` lookup is a
// multi-round-trip call (registry → resolver → addr), and the community
// endpoints behind the default rotation are heavily throttled, so the budget
// is per-lane and overridable with NAME_RESOLVE_TIMEOUT_MS.

import { ethers } from 'ethers';
import { PublicKey } from '@solana/web3.js';

import { ETH_RPC_URL, NAME_RESOLVE_TIMEOUT_MS } from '../config.js';
import { getConnection } from './solana.js';

const ENS_RE = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+\.eth$/i;
const SOL_RE = /^[a-z0-9-]{1,63}(?:\.sol)?$/i;

// A reverse/favorite lookup is a bonus field, never the answer, so it gets a
// tighter budget than the resolution it decorates.
const EXTRA_RATIO = 0.6;
// getAllDomains is a getProgramAccounts scan: valuable, but the slowest call in
// the set and the first thing a throttled RPC drops. Bounded and best-effort.
const DOMAIN_LIST_LIMIT = 25;

async function withTimeout(promise, ms, label) {
	let timer;
	const timeout = new Promise((_, rej) => {
		timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function resolveEns(name) {
	const provider = ETH_RPC_URL
		? new ethers.JsonRpcProvider(ETH_RPC_URL)
		: ethers.getDefaultProvider('mainnet');
	try {
		const address = await withTimeout(provider.resolveName(name), NAME_RESOLVE_TIMEOUT_MS, 'ens');
		if (!address) return null;
		let reverseName = null;
		try {
			reverseName = await withTimeout(
				provider.lookupAddress(address),
				Math.round(NAME_RESOLVE_TIMEOUT_MS * EXTRA_RATIO),
				'ens-reverse',
			);
		} catch {
			// best effort
		}
		return { network: 'ethereum', name, address, reverseName, rpc: ETH_RPC_URL || 'ethers-default' };
	} finally {
		// ethers keeps a poller alive per provider; without this the process
		// hangs after the tool returns.
		provider.destroy?.();
	}
}

// Owner of `<bare>.sol`, read from the name-registry account. Returns null when
// the domain has never been registered (the PDA has no account).
async function snsOwner(connection, bare) {
	const { getDomainKeySync, NameRegistryState } = await import('@bonfida/spl-name-service');
	const { pubkey } = getDomainKeySync(bare);
	const { registry } = await NameRegistryState.retrieve(connection, pubkey);
	return registry?.owner instanceof PublicKey ? registry.owner : null;
}

async function snsFavoriteDomain(connection, owner) {
	const { getFavoriteDomain } = await import('@bonfida/spl-name-service');
	const fav = await getFavoriteDomain(connection, owner);
	return fav?.reverse ? `${fav.reverse}.sol` : null;
}

async function snsOwnedDomains(connection, owner) {
	const { getAllDomains, reverseLookupBatch } = await import('@bonfida/spl-name-service');
	const keys = await getAllDomains(connection, owner);
	if (!keys.length) return [];
	const names = await reverseLookupBatch(connection, keys.slice(0, DOMAIN_LIST_LIMIT));
	return names.filter(Boolean).map((n) => `${n}.sol`);
}

async function resolveSns(name) {
	const bare = name.toLowerCase().replace(/\.sol$/, '');
	if (!/^[a-z0-9-]{1,63}$/.test(bare)) return null;

	const connection = getConnection();
	const owner = await withTimeout(snsOwner(connection, bare), NAME_RESOLVE_TIMEOUT_MS, 'sns').catch((e) => {
		// An unregistered domain is a clean "no", not an upstream failure: the
		// library throws the same way for both, so only a real transport error
		// should surface as one.
		if (/account.*not.*(found|exist)|Invalid name account/i.test(e?.message || '')) return null;
		throw e;
	});
	if (!owner) return null;

	const extraMs = Math.round(NAME_RESOLVE_TIMEOUT_MS * EXTRA_RATIO);
	const [favoriteDomain, allDomains] = await Promise.all([
		withTimeout(snsFavoriteDomain(connection, owner), extraMs, 'sns-favorite').catch(() => null),
		withTimeout(snsOwnedDomains(connection, owner), extraMs, 'sns-domains').catch(() => []),
	]);

	return {
		network: 'solana',
		name: `${bare}.sol`,
		address: owner.toBase58(),
		favoriteDomain,
		allDomains,
		source: 'spl-name-service (on-chain)',
	};
}

export async function resolveName(name) {
	const trimmed = String(name || '').trim().toLowerCase();
	const isEns = ENS_RE.test(trimmed);
	const isSol = /\.sol$/.test(trimmed) || (!isEns && SOL_RE.test(trimmed));

	const tasks = [];
	if (isEns) tasks.push(['ens', resolveEns(trimmed).catch((e) => ({ error: e?.message || 'ens failed' }))]);
	if (isSol) tasks.push(['sns', resolveSns(trimmed).catch((e) => ({ error: e?.message || 'sns failed' }))]);
	if (!isEns && !isSol) {
		return { ok: false, error: 'invalid_name', message: 'name does not look like a .eth, .sol, or bare label' };
	}
	const results = await Promise.all(tasks.map((t) => t[1]));
	const out = { ok: false, input: trimmed, ens: null, sns: null };
	tasks.forEach(([key], i) => {
		out[key] = results[i] || null;
	});
	if (out.ens && !out.ens.error) out.ok = true;
	if (out.sns && !out.sns.error) out.ok = true;
	if (!out.ok) {
		out.error = 'not_found';
		out.message = 'name did not resolve in either ENS or SNS';
	}
	out.fetchedAt = new Date().toISOString();
	return out;
}
