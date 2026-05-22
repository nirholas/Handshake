// ENS (Ethereum) + SNS (Solana) name resolution.
//
// ENS: ethers JsonRpcProvider against the configured ETH_RPC_URL, falling
// back to ethers' default public provider rotation.
// SNS: Bonfida's sns-api (the same service three.ws uses on the web side).

import { ethers } from 'ethers';

import { ETH_RPC_URL } from '../config.js';

const ENS_RE = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+\.eth$/i;
const SOL_RE = /^[a-z0-9-]{1,63}(?:\.sol)?$/i;
const SNS_API = 'https://sns-api.bonfida.com';

async function withTimeout(promise, ms, label) {
	const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms));
	return Promise.race([promise, timeout]);
}

async function resolveEns(name) {
	const provider = ETH_RPC_URL
		? new ethers.JsonRpcProvider(ETH_RPC_URL)
		: ethers.getDefaultProvider('mainnet');
	const address = await withTimeout(provider.resolveName(name), 4000, 'ens');
	if (!address) return null;
	let reverseName = null;
	try {
		reverseName = await withTimeout(provider.lookupAddress(address), 3000, 'ens-reverse');
	} catch {
		// best effort
	}
	return { network: 'ethereum', name, address, reverseName, rpc: ETH_RPC_URL || 'ethers-default' };
}

async function resolveSns(name) {
	const bare = name.toLowerCase().replace(/\.sol$/, '');
	if (!/^[a-z0-9-]{1,63}$/.test(bare)) return null;
	const lookup = await fetch(`${SNS_API}/v2/domain/lookup/${bare}.sol`).catch(() => null);
	if (!lookup || !lookup.ok) return null;
	const data = await lookup.json().catch(() => null);
	const owner = data?.owner || data?.[bare + '.sol']?.owner || data?.data?.owner || null;
	if (!owner) return null;

	let allDomains = [];
	try {
		const r = await fetch(`${SNS_API}/v2/user/domains/${owner}`);
		if (r.ok) {
			const body = await r.json();
			const list = body?.[owner] || body?.data?.[owner] || [];
			if (Array.isArray(list)) {
				allDomains = list
					.map((d) => (typeof d === 'string' ? d : d?.domain || d?.name))
					.filter(Boolean);
			}
		}
	} catch {
		// best effort
	}

	let favoriteDomain = null;
	try {
		const r = await fetch(`${SNS_API}/v2/user/fav-domains/${owner}`);
		if (r.ok) {
			const body = await r.json();
			favoriteDomain = body?.[owner] || body?.data?.[owner] || null;
		}
	} catch {
		// best effort
	}

	return {
		network: 'solana',
		name: `${bare}.sol`,
		address: owner,
		favoriteDomain,
		allDomains,
		source: `${SNS_API}/v2/domain/lookup/${bare}.sol`,
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
