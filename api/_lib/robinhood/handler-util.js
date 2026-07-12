// Shared bits for the api/v1/robinhood/* handlers: network parsing and the
// dedicated per-IP rate-limit gate (the play-lobby-429 lesson — a busy board
// gets its OWN bucket instead of draining the shared read budget).

import { fail } from '../gateway.js';
import { limits, clientIp } from '../rate-limit.js';

/** Resolve the ?network= param to 'mainnet' | 'testnet' (default mainnet). */
export function resolveNetwork(query) {
	const n = String(query.network || 'mainnet').toLowerCase();
	if (n === 'testnet' || n === '46630') return 'testnet';
	if (n === 'mainnet' || n === '4663' || n === '') return 'mainnet';
	fail(400, 'invalid_network', 'network must be "mainnet" or "testnet"');
	return 'mainnet';
}

/** Enforce the dedicated robinhood bucket; 429 with Retry-After on trip. */
export async function gateRobinhood(ctx) {
	const ip = ctx.ip || clientIp(ctx.req);
	const rl = await limits.robinhoodIp(ip);
	if (!rl.success) {
		const retry = Math.max(1, Math.ceil((rl.reset - Date.now()) / 1000));
		fail(429, 'rate_limited', `Robinhood market data is busy — retry in ${retry}s`);
	}
}
