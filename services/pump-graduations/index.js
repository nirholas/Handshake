/**
 * pump-graduations worker
 * -----------------------
 * Subscribes to Pump program logs and pushes graduation (bonding-curve to
 * PumpAMM migration) events into Upstash-protocol Redis. The three.ws side
 * reads them back from Redis; this service is the only piece of the platform
 * that holds a long-lived Solana WebSocket.
 *
 * Detection lives in graduation-event.js, enrichment in token-info.js. This
 * file wires a source to Redis and is the process entrypoint. Everything below
 * the entrypoint guard is exported so the core path can be exercised by tests
 * without opening a subscription.
 *
 * Env:
 *   SOLANA_RPC_URL              Helius (or any) HTTPS RPC
 *   SOLANA_WS_URL               Helius (or any) WSS endpoint
 *   UPSTASH_REDIS_REST_URL
 *   UPSTASH_REDIS_REST_TOKEN
 *   GRADUATIONS_LIST_KEY        default: pf:graduations
 *   GRADUATIONS_MAX_LEN         default: 500
 *   PUMP_GRADUATIONS_SOURCE     "legacy" (default) | "carbon"
 *                               Selects the graduation event source at startup.
 *                               Both sources emit the same events to Redis.
 */

import { pathToFileURL } from 'node:url';
import { Connection } from '@solana/web3.js';
import { Redis } from '@upstash/redis';
import { CarbonGraduationSource } from './carbon-source.js';
import {
	PUMP_PROGRAM_ID,
	SeenSignatures,
	isCandidateEntry,
	parseCompleteEvent,
} from './graduation-event.js';
import { canonicalPumpPoolAddress, fetchTokenMetadata } from './token-info.js';

export const DEFAULT_LIST_KEY = 'pf:graduations';
export const DEFAULT_MAX_LEN = 500;

/**
 * Turn a decoded CompleteEvent into the record shape stored in Redis, reading
 * the mint's real name and symbol and deriving the PumpSwap pool it migrates
 * into. Consumers (`api/_lib/pumpfun-mcp.js`) read exactly these field names.
 *
 * @param {import('@solana/web3.js').Connection} connection
 * @param {{signature: string, mint: string, timestamp?: number}} event
 */
export async function buildGraduationRecord(connection, event) {
	const { name, symbol } = await fetchTokenMetadata(connection, event.mint);
	return {
		signature: event.signature,
		mint: event.mint,
		tokenName: name,
		tokenSymbol: symbol,
		poolAddress: canonicalPumpPoolAddress(event.mint),
		timestamp: event.timestamp || Math.floor(Date.now() / 1000),
	};
}

/**
 * Append a graduation to the capped list and fan it out to live subscribers.
 *
 * @param {{lpush: Function, ltrim: Function, publish: Function}} redis
 * @param {object} record
 * @param {{listKey?: string, maxLen?: number}} [opts]
 */
export async function pushGraduation(redis, record, { listKey = DEFAULT_LIST_KEY, maxLen = DEFAULT_MAX_LEN } = {}) {
	const json = JSON.stringify(record);
	await redis.lpush(listKey, json);
	await redis.ltrim(listKey, 0, maxLen - 1);
	await redis.publish(`${listKey}:pub`, json);
	return json;
}

/**
 * Build the handler both sources funnel through: dedupe, enrich, push, log.
 *
 * @param {{connection: object, redis: object, listKey?: string, maxLen?: number, seen?: SeenSignatures, label?: string}} deps
 * @returns {(event: {signature: string, mint: string, timestamp?: number}) => Promise<object|null>}
 */
export function createGraduationHandler({
	connection,
	redis,
	listKey = DEFAULT_LIST_KEY,
	maxLen = DEFAULT_MAX_LEN,
	seen = new SeenSignatures(),
	label = 'legacy',
}) {
	return async function handleGraduation(event) {
		try {
			if (!seen.add(event.signature)) return null;
			const record = await buildGraduationRecord(connection, event);
			await pushGraduation(redis, record, { listKey, maxLen });
			console.log(
				'[pump-graduations] pushed (%s) %s %s',
				label,
				record.tokenSymbol || record.mint,
				record.signature,
			);
			return record;
		} catch (err) {
			console.error('[pump-graduations] handler error (%s):', label, err?.message || err);
			return null;
		}
	};
}

function required(name) {
	const v = process.env[name];
	if (!v) {
		console.error(`missing env ${name}`);
		process.exit(1);
	}
	return v;
}

function main() {
	const rpc = required('SOLANA_RPC_URL');
	const ws = required('SOLANA_WS_URL');
	const listKey = process.env.GRADUATIONS_LIST_KEY || DEFAULT_LIST_KEY;
	const maxLen = Number(process.env.GRADUATIONS_MAX_LEN || DEFAULT_MAX_LEN);
	const source = process.env.PUMP_GRADUATIONS_SOURCE || 'legacy';

	const redis = new Redis({
		url: required('UPSTASH_REDIS_REST_URL'),
		token: required('UPSTASH_REDIS_REST_TOKEN'),
	});
	const connection = new Connection(rpc, { wsEndpoint: ws, commitment: 'confirmed' });

	console.log(
		'[pump-graduations] starting; program=%s source=%s list=%s',
		PUMP_PROGRAM_ID.toBase58(),
		source,
		listKey,
	);

	const onGraduation = createGraduationHandler({
		connection,
		redis,
		listKey,
		maxLen,
		label: source,
	});

	if (source === 'carbon') {
		const src = new CarbonGraduationSource({ connection });
		src.start((ev) => onGraduation({ signature: ev.signature, mint: ev.mint, timestamp: ev.ts }));
		const shutdown = () => { src.stop(); process.exit(0); };
		process.on('SIGTERM', shutdown);
		process.on('SIGINT', shutdown);
		return;
	}

	// Dedupe happens inside the handler, keyed on graduations only, so the
	// bounded seen-set is never spent on unrelated Pump traffic.
	connection.onLogs(
		PUMP_PROGRAM_ID,
		(entry) => {
			if (!isCandidateEntry(entry)) return;
			const ev = parseCompleteEvent(entry.signature, entry.logs);
			if (ev) onGraduation(ev);
		},
		'confirmed',
	);
	process.on('SIGTERM', () => process.exit(0));
	process.on('SIGINT', () => process.exit(0));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
