/**
 * Cron dispatcher — single Vercel serverless function for every /api/cron/* job.
 *
 * Vercel routes /api/cron/<name> to this file via the [name] dynamic segment;
 * `req.query.name` carries the kebab-case job id. Each branch below is a
 * verbatim move of the original per-file handler body — no logic changes,
 * especially around auth / CRON_SECRET checks.
 *
 * Cron paths handled (kebab-case → handler):
 *   audit-log-cleanup             → handleAuditLogCleanup
 *   erc8004-crawl                 → handleErc8004Crawl
 *   index-delegations             → handleIndexDelegations
 *   process-subscriptions         → handleProcessSubscriptions
 *   pump-agent-stats              → handlePumpAgentStats
 *   pumpfun-monitor               → handlePumpfunMonitor
 *   pumpfun-signals               → handlePumpfunSignals
 *   run-buyback                   → handleRunBuyback
 *   run-dca                       → handleRunDca
 *   run-distribute-payments       → handleRunDistributePayments
 *   run-subscriptions             → handleRunSubscriptions
 *   solana-attest-event-cleanup   → handleSolanaAttestEventCleanup
 *   solana-attestations-crawl     → handleSolanaAttestationsCrawl
 */

import { id as keccakId, AbiCoder, getAddress, Interface } from 'ethers';
import { createPublicClient, http, encodeFunctionData, parseAbi } from 'viem';
import { baseSepolia, base } from 'viem/chains';

import { sql } from '../_lib/db.js';
import { cors, error, json, method, wrap } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { CHAINS } from '../_lib/erc8004-chains.js';
import { DELEGATION_MANAGER_DEPLOYMENTS, DELEGATION_MANAGER_ABI } from '../../src/erc7710/abi.js';
import {
	getPumpAgent,
	getPumpAgentOffline,
	getConnection,
	getRpcFallback,
	getPumpSdk,
	getAmmPoolState,
	buildUnsignedTxBase64,
	solanaPubkey,
} from '../_lib/pump.js';
import { mintAttestation, deriveEventId, loadAttesterKeypair } from '../_lib/attest-event.js';
import { pumpfunMcp, pumpfunBotEnabled } from '../_lib/pumpfun-mcp.js';
import { crawlAgentAttestations } from '../_lib/solana-attestations.js';
import { SOLANA_USDC_MINT, SOLANA_USDC_MINT_DEVNET } from '../payments/_config.js';
import { chargeSubscription, failPayment } from '../_lib/subscription-billing.js';
import { sendEmail } from '../_lib/email.js';

// ─── Dispatcher ──────────────────────────────────────────────────────────────

const HANDLERS = {
	'erc8004-crawl': handleErc8004Crawl,
	'index-delegations': handleIndexDelegations,
	'process-subscriptions': handleProcessSubscriptions,
	'pump-agent-stats': handlePumpAgentStats,
	'pumpfun-monitor': handlePumpfunMonitor,
	'pumpfun-signals': handlePumpfunSignals,
	'run-buyback': handleRunBuyback,
	'run-dca': handleRunDca,
	'run-distribute-payments': handleRunDistributePayments,
	'run-subscriptions': handleRunSubscriptions,
	'audit-log-cleanup': handleAuditLogCleanup,
	'settle-royalties': handleSettleRoyalties,
	'solana-attest-event-cleanup': handleSolanaAttestEventCleanup,
	'solana-attestations-crawl': handleSolanaAttestationsCrawl,
	'expire-pending-purchases': handleExpirePendingPurchases,
	'cleanup-csrf-tokens': handleCleanupCsrfTokens,
	'process-withdrawals': handleProcessWithdrawals,
	'run-x-scheduled-posts': handleRunXScheduledPosts,
	'run-x-triggers': handleRunXTriggers,
	'fetch-x-metrics': handleFetchXMetrics,
	'run-coin-cycle': handleRunCoinCycle,
	'run-coin-payouts': handleRunCoinPayouts,
	'club-payouts': handleClubPayouts,
	'siwx-gc': handleSiwxGc,
	'unstoppable-tick': handleUnstoppableTick,
};

export default wrap(async (req, res) => {
	const name = req.query?.name;
	const handler = typeof name === 'string' ? HANDLERS[name] : null;
	if (!handler) return error(res, 404, 'not_found', 'unknown cron');
	return handler(req, res);
});

// ═══════════════════════════════════════════════════════════════════════════
// erc8004-crawl
// ═══════════════════════════════════════════════════════════════════════════

const REGISTERED_TOPIC = keccakId('Registered(uint256,string,address)');
const ABI_CODER = AbiCoder.defaultAbiCoder();

// Blocks scanned per chain per cron invocation. Public RPCs typically allow
// 2000-block ranges; lower this if a chain's RPC rejects with "block range".
const ERC8004_BLOCK_CHUNK = 1_000;

// On first run (no cursor), scan this many recent blocks. Keep small so the
// initial cron run stays well under Vercel's 300s limit. Set
// ERC8004_CRAWL_LOOKBACK=50000 in Vercel env only for a one-time manual backfill.
const ERC8004_DEFAULT_LOOKBACK = parseInt(process.env.ERC8004_CRAWL_LOOKBACK || '2000', 10);

// Metadata enrichment per invocation.
const ERC8004_METADATA_BATCH = 25;

const ERC8004_FETCH_TIMEOUT_MS = 10_000;

// Hard budget: stop processing and return before Vercel's 300s limit.
const CRAWL_BUDGET_MS = 240_000;

async function handleErc8004Crawl(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	const auth = req.headers['authorization'] || '';
	const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && (!expected || auth !== expected)) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	const crawlStart = Date.now();
	const report = { chains: [], enriched: 0, errors: [] };

	for (const chain of CHAINS) {
		if (Date.now() - crawlStart > CRAWL_BUDGET_MS) break;
		try {
			const r = await erc8004CrawlChain(chain);
			report.chains.push({ chainId: chain.id, name: chain.name, ...r });
		} catch (err) {
			report.errors.push({ chainId: chain.id, error: err.message || String(err) });
		}
	}

	if (Date.now() - crawlStart <= CRAWL_BUDGET_MS) {
		try {
			report.enriched = await erc8004EnrichMetadata(ERC8004_METADATA_BATCH);
		} catch (err) {
			report.errors.push({ stage: 'metadata', error: err.message || String(err) });
		}
	}

	return json(res, 200, report);
}

async function erc8004CrawlChain(chain) {
	const [cursor] = await sql`
		SELECT last_block FROM erc8004_crawl_cursor WHERE chain_id = ${chain.id}
	`;

	const latestHex = await erc8004RpcCall(chain.rpcUrl, 'eth_blockNumber', []);
	const latestBlock = Number.parseInt(latestHex, 16);

	const fromBlock = cursor
		? Number(cursor.last_block) + 1
		: Math.max(0, latestBlock - ERC8004_DEFAULT_LOOKBACK);

	if (fromBlock > latestBlock) {
		return { inserted: 0, scanned: 0, lastBlock: latestBlock, fromBlock };
	}

	const toBlock = Math.min(fromBlock + ERC8004_BLOCK_CHUNK - 1, latestBlock);

	const logs = await erc8004RpcCall(chain.rpcUrl, 'eth_getLogs', [
		{
			address: chain.registry,
			topics: [REGISTERED_TOPIC],
			fromBlock: '0x' + fromBlock.toString(16),
			toBlock: '0x' + toBlock.toString(16),
		},
	]);

	// Fetch block timestamps for any blocks that produced events.
	const blockTimes = {};
	if (logs.length > 0) {
		const uniqueBlockHexes = [...new Set(logs.map((l) => l.blockNumber))];
		await Promise.all(
			uniqueBlockHexes.map(async (bn) => {
				try {
					const block = await erc8004RpcCall(chain.rpcUrl, 'eth_getBlockByNumber', [bn, false]);
					blockTimes[bn] = block ? Number.parseInt(block.timestamp, 16) : null;
				} catch {
					// registered_at will be null for this block
				}
			}),
		);
	}

	let inserted = 0;
	for (const log of logs) {
		try {
			const agentId = BigInt(log.topics[1]).toString();
			const ownerHex = '0x' + log.topics[2].slice(-40);
			const owner = getAddress(ownerHex).toLowerCase();
			const [agentURI] = ABI_CODER.decode(['string'], log.data);
			const blockNumber = Number.parseInt(log.blockNumber, 16);
			const ts = blockTimes[log.blockNumber];
			const registeredAt = ts ? new Date(ts * 1000).toISOString() : null;

			await sql`
				INSERT INTO erc8004_agents_index
					(chain_id, agent_id, owner, registry, agent_uri,
					 registered_block, registered_tx, registered_at, last_seen_at)
				VALUES
					(${chain.id}, ${agentId}, ${owner}, ${chain.registry.toLowerCase()},
					 ${agentURI || null}, ${blockNumber}, ${log.transactionHash},
					 ${registeredAt}, now())
				ON CONFLICT (chain_id, agent_id) DO UPDATE SET
					owner = excluded.owner,
					agent_uri = COALESCE(excluded.agent_uri, erc8004_agents_index.agent_uri),
					last_seen_at = now()
			`;
			inserted += 1;
		} catch (decodeErr) {
			console.warn('[crawl] decode failed', chain.id, log.transactionHash, decodeErr.message);
		}
	}

	// Always advance cursor to toBlock so the next run continues from here.
	await sql`
		INSERT INTO erc8004_crawl_cursor (chain_id, last_block, updated_at)
		VALUES (${chain.id}, ${toBlock}, now())
		ON CONFLICT (chain_id) DO UPDATE SET
			last_block = GREATEST(erc8004_crawl_cursor.last_block, ${toBlock}),
			updated_at = now()
	`;

	return { inserted, scanned: toBlock - fromBlock + 1, lastBlock: toBlock, fromBlock };
}

async function erc8004EnrichMetadata(limit) {
	const rows = await sql`
		SELECT chain_id, agent_id, agent_uri
		FROM erc8004_agents_index
		WHERE agent_uri IS NOT NULL
		  AND (last_metadata_at IS NULL OR last_metadata_at < now() - interval '7 days')
		ORDER BY last_metadata_at NULLS FIRST, registered_at DESC NULLS LAST
		LIMIT ${limit}
	`;

	let done = 0;
	for (const row of rows) {
		try {
			const meta = await erc8004FetchAgentMetadata(row.agent_uri);
			if (!meta) {
				await sql`
					UPDATE erc8004_agents_index
					SET metadata_error = 'fetch failed',
					    last_metadata_at = now()
					WHERE chain_id = ${row.chain_id} AND agent_id = ${row.agent_id}
				`;
				continue;
			}
			const name = erc8004Truncate(meta.name || '', 200);
			const description = erc8004Truncate(meta.description || '', 1000);
			const image = erc8004ResolveGateway(meta.image || '');
			const services = Array.isArray(meta.services) ? meta.services : [];
			const avatarSvc = services.find(
				(s) => String(s?.name || '').toLowerCase() === 'avatar' && s?.endpoint,
			);
			const glbUrl = avatarSvc ? erc8004ResolveGateway(avatarSvc.endpoint) : null;
			const has3d = !!glbUrl;
			const active = meta.active !== false;
			const x402 = !!(meta.x402Support || meta.x402);

			await sql`
				UPDATE erc8004_agents_index
				SET name = ${name || null},
				    description = ${description || null},
				    image = ${image || null},
				    glb_url = ${glbUrl},
				    services = ${JSON.stringify(services)}::jsonb,
				    has_3d = ${has3d},
				    active = ${active},
				    x402_support = ${x402},
				    metadata_error = null,
				    last_metadata_at = now()
				WHERE chain_id = ${row.chain_id} AND agent_id = ${row.agent_id}
			`;
			done += 1;
		} catch (err) {
			await sql`
				UPDATE erc8004_agents_index
				SET metadata_error = ${erc8004Truncate(err.message || String(err), 500)},
				    last_metadata_at = now()
				WHERE chain_id = ${row.chain_id} AND agent_id = ${row.agent_id}
			`;
		}
	}
	return done;
}

async function erc8004RpcCall(url, method, params) {
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), ERC8004_FETCH_TIMEOUT_MS);
	try {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
			signal: ac.signal,
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		if (data.error) throw new Error(`RPC ${data.error.code}: ${data.error.message}`);
		return data.result;
	} finally {
		clearTimeout(t);
	}
}

async function erc8004FetchAgentMetadata(uri) {
	const url = erc8004ResolveGateway(uri);
	if (!url) return null;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(ERC8004_FETCH_TIMEOUT_MS) });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

function erc8004ResolveGateway(uri) {
	if (!uri || typeof uri !== 'string') return '';
	if (uri.startsWith('ipfs://')) return 'https://ipfs.io/ipfs/' + uri.slice(7);
	if (uri.startsWith('ar://')) return 'https://arweave.net/' + uri.slice(5);
	if (uri.startsWith('http://') || uri.startsWith('https://')) return uri;
	return '';
}

function erc8004Truncate(s, max) {
	if (!s) return '';
	return s.length > max ? s.slice(0, max) : s;
}

// ═══════════════════════════════════════════════════════════════════════════
// index-delegations
// ═══════════════════════════════════════════════════════════════════════════

// Topic hashes are derived from the ABI so they stay in sync with contract changes.
const dmIface = new Interface(DELEGATION_MANAGER_ABI);
const DISABLED_TOPIC = dmIface.getEvent('DisabledDelegation').topicHash;
const REDEEMED_TOPIC = dmIface.getEvent('RedeemedDelegation').topicHash;

// Max blocks per eth_getLogs call. Public RPCs 429 above ~2000.
// Ethereum mainnet (chainId 1) nodes cap eth_getLogs at 50 blocks; use 25 to
// stay safely under the limit and avoid 504s.
const IDX_BLOCK_CAP = 2000;
const IDX_MAINNET_BLOCK_CAP = 25; // ETH mainnet is far more restrictive
const IDX_RPC_TIMEOUT_MS = 10_000;
// Hard time budget per cron invocation — leave 8 s headroom before Vercel's 30 s limit.
const IDX_TIME_BUDGET_MS = 22_000;

// Approximate blocks per day, used only to seed the cursor on first run.
const BLOCKS_PER_DAY = {
	84532: 43200, // Base Sepolia ~2 s/block
	11155111: 7200, // Sepolia ~12 s/block
};

// Public RPC fallbacks per chain — tried in order. Override primary via env RPC_URL_<chainId>.
const PUBLIC_RPCS = {
	1: [
		'https://cloudflare-eth.com',
		'https://eth.llamarpc.com',
		'https://rpc.ankr.com/eth',
		'https://ethereum.publicnode.com',
		'https://1rpc.io/eth',
	],
	8453: [
		'https://mainnet.base.org',
		'https://base.llamarpc.com',
		'https://rpc.ankr.com/base',
		'https://base.publicnode.com',
		'https://1rpc.io/base',
	],
	84532: [
		'https://sepolia.base.org',
		'https://base-sepolia-rpc.publicnode.com',
		'https://rpc.ankr.com/base_sepolia',
	],
	11155111: [
		'https://rpc.sepolia.org',
		'https://ethereum-sepolia-rpc.publicnode.com',
		'https://rpc.ankr.com/eth_sepolia',
		'https://1rpc.io/sepolia',
	],
	421614: [
		'https://sepolia-rollup.arbitrum.io/rpc',
		'https://arbitrum-sepolia.publicnode.com',
		'https://rpc.ankr.com/arbitrum_sepolia',
	],
	11155420: [
		'https://sepolia.optimism.io',
		'https://optimism-sepolia.publicnode.com',
		'https://rpc.ankr.com/optimism_sepolia',
	],
};

function idxRpcUrls(chainId) {
	const envUrl = process.env[`RPC_URL_${chainId}`];
	const fallbacks = PUBLIC_RPCS[chainId] ?? [];
	return envUrl ? [envUrl, ...fallbacks] : fallbacks;
}

async function handleIndexDelegations(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	const auth = req.headers['authorization'] || '';
	const expected = env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : null;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && (!expected || auth !== expected)) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	const started = Date.now();
	const report = { chains: [], expiredSwept: 0, errors: [] };

	// Index each chain independently — one chain's RPC failure must not abort others.
	for (const [chainIdStr, contract] of Object.entries(DELEGATION_MANAGER_DEPLOYMENTS)) {
		const chainId = Number(chainIdStr);
		const t0 = Date.now();
		try {
			const r = await idxIndexChain(chainId, contract, started);
			const summary = { chainId, ...r, elapsedMs: Date.now() - t0 };
			report.chains.push(summary);
			console.log(JSON.stringify({ stage: 'index-delegations', ...summary }));
		} catch (err) {
			const entry = { chainId, error: err.message || String(err) };
			report.errors.push(entry);
			console.error(JSON.stringify({ stage: 'index-delegations', ...entry }));
		}
	}

	// Expiry sweep — idempotent, catches expirations missed between grant and indexer.
	try {
		const swept = await sql`
			UPDATE agent_delegations
			SET status = 'expired'
			WHERE status = 'active' AND expires_at < NOW()
			RETURNING id
		`;
		report.expiredSwept = swept.length;
	} catch (err) {
		report.errors.push({ stage: 'expiry-sweep', error: err.message || String(err) });
		console.error(JSON.stringify({ stage: 'expiry-sweep', error: err.message }));
	}

	// Emit summary to usage_events (best-effort — non-fatal if table shape differs).
	try {
		await sql`
			INSERT INTO usage_events (kind, tool, status, latency_ms)
			VALUES ('permissions.indexer.tick', 'index-delegations', 'ok', ${Date.now() - started})
		`;
	} catch {
		/* non-fatal */
	}

	return json(res, 200, report);
}

async function idxIndexChain(chainId, contract, cronStart = Date.now()) {
	const urls = idxRpcUrls(chainId);
	if (!urls.length) throw new Error(`no RPC URL configured for chain ${chainId}`);

	// Per-chain batch size: ETH mainnet nodes cap eth_getLogs at 50 blocks.
	const BATCH = chainId === 1 ? IDX_MAINNET_BLOCK_CAP : IDX_BLOCK_CAP;

	const latestHex = await idxRpc(urls, 'eth_blockNumber', []);
	const latestBlock = parseInt(latestHex, 16);

	const [cursor] = await sql`
		SELECT last_indexed_block FROM indexer_state
		WHERE contract = ${contract.toLowerCase()} AND chain_id = ${chainId}
	`;
	const initialFrom = cursor
		? Number(cursor.last_indexed_block) + 1
		: Math.max(0, latestBlock - (BLOCKS_PER_DAY[chainId] ?? 7200));

	let fromBlock = initialFrom;
	let toBlock = latestBlock; // updated each iteration; reflects final processed range
	let revokedCount = 0;
	let redeemedCount = 0;
	let logErrorCount = 0;
	let earlyExit = false;

	while (fromBlock <= latestBlock) {
		// Hard time budget: save cursor and break before the function times out.
		if (Date.now() - cronStart > IDX_TIME_BUDGET_MS) {
			console.warn(
				JSON.stringify({
					stage: 'index-delegations',
					chainId,
					warning: 'time-budget-exceeded',
					elapsedMs: Date.now() - cronStart,
					stoppedAtBlock: fromBlock,
				}),
			);
			earlyExit = true;
			break;
		}

		toBlock = Math.min(fromBlock + BATCH - 1, latestBlock);

		let logs;
		try {
			logs = await idxRpc(urls, 'eth_getLogs', [
				{
					address: contract,
					topics: [[DISABLED_TOPIC, REDEEMED_TOPIC]],
					fromBlock: '0x' + fromBlock.toString(16),
					toBlock: '0x' + toBlock.toString(16),
				},
			]);
		} catch (fetchErr) {
			// AbortError means this batch timed out — save the cursor at the start
			// of this batch so the next invocation can retry it, then stop.
			if (fetchErr.name === 'AbortError' || fetchErr.name === 'TimeoutError') {
				console.warn(
					JSON.stringify({
						stage: 'index-delegations',
						chainId,
						warning: 'rpc-abort',
						message: fetchErr.message,
						stoppedAtBlock: fromBlock,
					}),
				);
				// Rewind cursor to fromBlock-1 so the next run retries this batch.
				await sql`
					INSERT INTO indexer_state (contract, chain_id, last_indexed_block, updated_at)
					VALUES (${contract.toLowerCase()}, ${chainId}, ${fromBlock - 1}, NOW())
					ON CONFLICT (contract, chain_id) DO UPDATE SET
						last_indexed_block = LEAST(indexer_state.last_indexed_block, ${fromBlock - 1}),
						updated_at = NOW()
				`;
				earlyExit = true;
				break;
			}
			throw fetchErr;
		}

		if (logs.length > 0) {
			// Fetch block timestamps only for blocks that have events.
			const uniqueBlocks = [...new Set(logs.map((l) => l.blockNumber))];
			const blockTs = {};
			for (const bn of uniqueBlocks) {
				const block = await idxRpc(urls, 'eth_getBlockByNumber', [bn, false]);
				blockTs[bn] = new Date(parseInt(block.timestamp, 16) * 1000).toISOString();
			}

			for (const log of logs) {
				try {
					const ts = blockTs[log.blockNumber];
					const topic = log.topics[0];

					if (topic === DISABLED_TOPIC) {
						// DisabledDelegation indexes delegationHash as topics[1].
						const delegationHash = log.topics[1];
						const rows = await sql`
							UPDATE agent_delegations
							SET status = 'revoked',
							    revoked_at = ${ts}::timestamptz,
							    tx_hash_revoke = ${log.transactionHash}
							WHERE delegation_hash = ${delegationHash} AND status = 'active'
							RETURNING id
						`;
						revokedCount += rows.length;
					} else if (topic === REDEEMED_TOPIC) {
						// RedeemedDelegation does not index delegationHash. Decode the
						// non-indexed `delegation` tuple from log.data and defer to the
						// contract's getDelegationHash() rather than reimplementing the
						// EIP-712 struct hash locally — provably matches the on-chain
						// value and survives any future ABI change to the struct.
						const parsed = dmIface.parseLog({
							topics: log.topics,
							data: log.data,
						});
						const callData = dmIface.encodeFunctionData('getDelegationHash', [
							parsed.args.delegation,
						]);
						const raw = await idxRpc(urls, 'eth_call', [
							{ to: contract, data: callData },
							'latest',
						]);
						const [delegationHash] = dmIface.decodeFunctionResult(
							'getDelegationHash',
							raw,
						);
						const rows = await sql`
							UPDATE agent_delegations
							SET redemption_count = redemption_count + 1,
							    last_redeemed_at = ${ts}::timestamptz
							WHERE delegation_hash = ${delegationHash}
							RETURNING id
						`;
						redeemedCount += rows.length;
					} else {
						// eth_getLogs filter restricts to the two topics above, so this
						// branch is unreachable under current configuration. Guard
						// anyway so future filter widening fails loudly in logs
						// rather than silently miscategorizing events.
						logErrorCount++;
						console.warn(
							JSON.stringify({
								stage: 'index-delegations',
								chainId,
								warning: 'unknown-topic',
								topic,
								tx: log.transactionHash,
							}),
						);
					}
				} catch (err) {
					// Isolate per-log failures so one bad event doesn't abort the
					// batch and force a full re-scan on the next tick.
					logErrorCount++;
					console.error(
						JSON.stringify({
							stage: 'index-delegations',
							chainId,
							error: 'log-process-failed',
							message: err.message || String(err),
							tx: log.transactionHash,
							topic: log.topics?.[0],
						}),
					);
				}
			}
		}

		// Advance cursor after each batch so a timeout preserves partial progress.
		await sql`
			INSERT INTO indexer_state (contract, chain_id, last_indexed_block, updated_at)
			VALUES (${contract.toLowerCase()}, ${chainId}, ${toBlock}, NOW())
			ON CONFLICT (contract, chain_id) DO UPDATE SET
				last_indexed_block = GREATEST(indexer_state.last_indexed_block, excluded.last_indexed_block),
				updated_at = NOW()
		`;

		fromBlock = toBlock + 1;
	}

	return { fromBlock: initialFrom, toBlock, revokedCount, redeemedCount, logErrorCount, earlyExit };
}

async function idxRpc(urls, method, params) {
	let lastErr;
	for (const url of urls) {
		const ac = new AbortController();
		const t = setTimeout(() => ac.abort(), IDX_RPC_TIMEOUT_MS);
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
				signal: ac.signal,
			});
			if (!res.ok) throw new Error(`RPC HTTP ${res.status} from ${url}`);
			const data = await res.json();
			if (data.error) {
				throw new Error(
					`RPC ${method} error: ${data.error.message ?? JSON.stringify(data.error)}`,
				);
			}
			return data.result;
		} catch (err) {
			lastErr = err;
		} finally {
			clearTimeout(t);
		}
	}
	throw lastErr;
}

// ═══════════════════════════════════════════════════════════════════════════
// pump-agent-stats
// ═══════════════════════════════════════════════════════════════════════════

// Keep small: each mint makes 2-3 Solana RPC calls; public RPC rate-limits at
// 429 immediately, so large batches reliably 504 within Vercel's 30s window.
const PUMP_STATS_MAX_PER_RUN = 20;
const PUMP_STATS_MINT_TIMEOUT_MS = 8_000;

// Pump.fun graduation threshold (mainnet curve). Used only as a UI hint —
// progress_pct is a coarse bar, not financial advice.
const GRADUATION_REAL_SOL = 85_000_000_000n; // ~85 SOL in lamports

async function handlePumpAgentStats(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = req.headers.authorization || '';
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron) {
		if (!env.CRON_SECRET) return error(res, 503, 'not_configured', 'CRON_SECRET unset');
		if (auth !== `Bearer ${env.CRON_SECRET}`)
			return error(res, 401, 'unauthorized', 'cron auth required');
	}

	const mints = await sql`
		select id, mint, network from pump_agent_mints
		order by id limit ${PUMP_STATS_MAX_PER_RUN}
	`;

	const DEADLINE = Date.now() + 22_000;
	const report = { scanned: mints.length, updated: 0, errors: 0, graduations: 0, timeouts: 0, rate_limited: 0, skipped: 0 };
	let consecutiveRateLimit = 0;

	for (const m of mints) {
		if (Date.now() >= DEADLINE) {
			report.skipped += mints.length - mints.indexOf(m);
			break;
		}
		if (consecutiveRateLimit >= 3) {
			report.skipped += mints.length - mints.indexOf(m);
			console.log(JSON.stringify({ event: 'pump_agent_stats.circuit_open', consecutive_429: consecutiveRateLimit }));
			break;
		}

		try {
			const stats = await Promise.race([
				pumpStatsSnapshotMint(m),
				new Promise((_, rej) =>
					setTimeout(() => rej(Object.assign(new Error('snapshot timeout'), { code: 'TIMEOUT' })), PUMP_STATS_MINT_TIMEOUT_MS),
				),
			]);

			consecutiveRateLimit = 0;

			// Detect graduation flip false→true vs prior snapshot.
			const [prior] = await sql`
				select graduated from pump_agent_stats where mint_id=${m.id} limit 1
			`;
			const justGraduated = stats.graduated && prior && !prior.graduated;

			await sql`
				insert into pump_agent_stats
					(mint_id, network, mint, graduated, bonding_curve, amm,
					 last_signature, last_signature_at, recent_tx_count, refreshed_at, error)
				values (
					${m.id}, ${m.network}, ${m.mint}, ${stats.graduated},
					${stats.bonding_curve ? JSON.stringify(stats.bonding_curve) : null}::jsonb,
					${stats.amm ? JSON.stringify(stats.amm) : null}::jsonb,
					${stats.last_signature}, ${stats.last_signature_at},
					${stats.recent_tx_count}, now(), null
				)
				on conflict (mint_id) do update set
					graduated         = excluded.graduated,
					bonding_curve     = excluded.bonding_curve,
					amm               = excluded.amm,
					last_signature    = excluded.last_signature,
					last_signature_at = excluded.last_signature_at,
					recent_tx_count   = excluded.recent_tx_count,
					refreshed_at      = now(),
					error             = null
			`;

			// Price-point time series.
			const price = pumpStatsDerivePrice(stats);
			if (price) {
				await sql`
					insert into pump_agent_price_points (mint_id, sol_per_token, market_cap_lamports, source)
					values (${m.id}, ${price.sol_per_token}, ${price.market_cap_lamports?.toString() ?? null}, ${price.source})
				`;
			}

			// Emit a self-sourced graduation signal (no upstream bot needed).
			if (justGraduated) {
				report.graduations++;
				try {
					await sql`
						insert into pumpfun_signals (wallet, agent_asset, kind, weight, payload, tx_signature)
						values (
							null, ${m.mint}, 'graduation', 0.3,
							${JSON.stringify({ source: 'pump-agent-stats', network: m.network })}::jsonb,
							${`graduated:${m.mint}:${Date.now()}`}
						)
						on conflict (tx_signature) do nothing
					`;
				} catch {
					// pumpfun_signals table optional
				}
			}

			report.updated++;
		} catch (e) {
			if (e.code === 'TIMEOUT') {
				report.timeouts++;
			} else if (e.code === 'RATE_LIMITED' || /429/.test(e.message)) {
				report.rate_limited++;
				consecutiveRateLimit++;
			} else {
				report.errors++;
				consecutiveRateLimit = 0;
			}
			await sql`
				insert into pump_agent_stats (mint_id, network, mint, error, refreshed_at)
				values (${m.id}, ${m.network}, ${m.mint}, ${e.message || 'snapshot failed'}, now())
				on conflict (mint_id) do update set error = excluded.error, refreshed_at = now()
			`.catch(() => {});
		}
	}

	return json(res, 200, report);
}

async function pumpStatsSnapshotMint({ network, mint }) {
	const mintPk = solanaPubkey(mint);
	if (!mintPk) throw new Error('invalid mint pubkey');

	const out = {
		graduated: false,
		bonding_curve: null,
		amm: null,
		last_signature: null,
		last_signature_at: null,
		recent_tx_count: 0,
	};

	// Bonding curve
	let curve = null;
	try {
		const { sdk } = await getPumpSdk({ network });
		if (sdk.fetchBuyState) {
			const state = await sdk.fetchBuyState(mintPk, mintPk);
			curve = state.bondingCurve;
		} else if (sdk.fetchBondingCurve) {
			curve = await sdk.fetchBondingCurve(mintPk);
		}
	} catch {
		curve = null;
	}

	if (curve && !curve.complete) {
		const realSol = BigInt(curve.realSolReserves?.toString?.() ?? '0');
		const pct =
			GRADUATION_REAL_SOL > 0n
				? Number((realSol * 10000n) / GRADUATION_REAL_SOL) / 100
				: null;
		out.bonding_curve = {
			real_sol: realSol.toString(),
			real_token: curve.realTokenReserves?.toString?.() ?? null,
			virtual_sol: curve.virtualSolReserves?.toString?.() ?? null,
			virtual_token: curve.virtualTokenReserves?.toString?.() ?? null,
			complete: curve.complete ?? false,
			progress_pct: pct != null ? Math.min(100, Math.max(0, pct)) : null,
		};
	} else {
		// Try AMM pool
		try {
			const amm = await getAmmPoolState({ network, mint: mintPk });
			out.graduated = true;
			out.amm = {
				pool: amm.poolKey.toString(),
				base_reserve: amm.baseReserve.toString(),
				quote_reserve: amm.quoteReserve.toString(),
				lp_supply: amm.pool.lpSupply?.toString?.() ?? null,
			};
		} catch (e) {
			if (e.code !== 'pool_not_found') throw e;
			// graduated state inferred from curve.complete only
			if (curve?.complete) out.graduated = true;
		}
	}

	// Recent activity snapshot via RPC (use fallback pool if Helius is configured)
	try {
		const conn = getRpcFallback({ network });
		const sigs = await conn.getSignaturesForAddress(mintPk, { limit: 50 });
		out.recent_tx_count = sigs.length;
		if (sigs.length > 0) {
			out.last_signature = sigs[0].signature;
			if (sigs[0].blockTime) {
				out.last_signature_at = new Date(sigs[0].blockTime * 1000).toISOString();
			}
		}
	} catch (e) {
		if (/429|rate.limit|max usage/i.test(e?.message || '')) {
			throw Object.assign(new Error(`RPC 429: ${e.message}`), { code: 'RATE_LIMITED' });
		}
		// Other RPC hiccup — leave activity fields null
	}

	return out;
}

// Compute coarse sol-per-token + market_cap_lamports from a stats snapshot.
// Bonding curve: virtual_sol / virtual_token (the AMM-style invariant pump uses).
// AMM: quote_reserve / base_reserve.
function pumpStatsDerivePrice(stats) {
	if (stats.bonding_curve) {
		const vSol = Number(stats.bonding_curve.virtual_sol || 0);
		const vTok = Number(stats.bonding_curve.virtual_token || 0);
		if (vSol > 0 && vTok > 0) {
			const sol_per_token = vSol / vTok;
			// total supply ≈ virtual_token + real_token (heuristic, sufficient for charting)
			const totalTok =
				BigInt(stats.bonding_curve.virtual_token || 0) +
				BigInt(stats.bonding_curve.real_token || 0);
			const market_cap_lamports =
				totalTok > 0n ? BigInt(Math.floor(sol_per_token * Number(totalTok))) : null;
			return { sol_per_token, market_cap_lamports, source: 'bonding_curve' };
		}
	}
	if (stats.amm) {
		const q = Number(stats.amm.quote_reserve || 0);
		const b = Number(stats.amm.base_reserve || 0);
		if (q > 0 && b > 0) {
			return { sol_per_token: q / b, market_cap_lamports: null, source: 'amm' };
		}
	}
	return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// pumpfun-monitor
// ═══════════════════════════════════════════════════════════════════════════

const PUMPFUN_MONITOR_MAX_PER_RUN = 50;
const WHALE_TRADE_USD_FLOOR = 1_000;

async function handlePumpfunMonitor(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	const auth = req.headers['authorization'] || '';
	const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && (!expected || auth !== expected)) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	if (!process.env.ATTEST_AGENT_SECRET_KEY) {
		// Skip cleanly when the attester key isn't provisioned — returning 503
		// every 3 min would mark the cron job as failing in the dashboard.
		return json(res, 200, { skipped: true, reason: 'attester_not_configured' });
	}

	// Pull the latest stats joined with the agent's Metaplex Core asset and
	// the prior cursor state. Only consider mints whose stats have changed
	// since the last cursor checkpoint.
	const rows = await sql`
		select
			m.id            as mint_id,
			m.mint          as token_mint,
			m.network,
			m.agent_id,
			m.agent_authority,
			s.graduated,
			s.last_signature,
			s.last_signature_at,
			a.id            as agent_row_id,
			a.user_id,
			coalesce(a.meta->'onchain'->>'sol_asset', a.meta->>'sol_mint_address') as agent_asset,
			c.last_graduated,
			c.last_authority,
			c.last_trade_signature
		from pump_agent_mints m
		join pump_agent_stats  s on s.mint_id = m.id
		join agent_identities  a on a.id = m.agent_id
		left join pumpfun_monitor_cursor c on c.mint_id = m.id
		where coalesce(a.meta->'onchain'->>'sol_asset', a.meta->>'sol_mint_address') is not null
		  and (
		     c.mint_id is null
		  or c.last_graduated      is distinct from s.graduated
		  or c.last_authority      is distinct from m.agent_authority
		  or c.last_trade_signature is distinct from s.last_signature
		  )
		order by s.refreshed_at desc nulls last
		limit ${PUMPFUN_MONITOR_MAX_PER_RUN}
	`;

	const attester = loadAttesterKeypair();
	const report = { scanned: rows.length, minted: 0, deduped: 0, in_progress: 0, errors: 0, events: [] };

	for (const r of rows) {
		const events = detectEvents(r);
		for (const ev of events) {
			try {
				const result = await mintAttestation({
					...ev,
					agent_asset: r.agent_asset,
					network:     r.network,
					token_mint:  r.token_mint,
					attester,
				});
				report[result.status === 'minted' ? 'minted'
					: result.status === 'deduped' ? 'deduped' : 'in_progress']++;
				report.events.push({
					mint: r.token_mint, type: ev.event_type, status: result.status,
					signature: result.signature,
				});
			} catch (e) {
				report.errors++;
				report.events.push({
					mint: r.token_mint, type: ev.event_type,
					status: 'error', error: e?.message || String(e),
				});
			}
		}

		// Always update the cursor — even when nothing was emitted — so we
		// don't re-scan unchanged rows next tick.
		await sql`
			insert into pumpfun_monitor_cursor (mint_id, last_graduated, last_authority, last_trade_signature, last_processed_at)
			values (${r.mint_id}, ${r.graduated}, ${r.agent_authority}, ${r.last_signature}, now())
			on conflict (mint_id) do update set
				last_graduated       = excluded.last_graduated,
				last_authority       = excluded.last_authority,
				last_trade_signature = excluded.last_trade_signature,
				last_processed_at    = now()
		`;
	}

	return json(res, 200, report);
}

/** Map a single (stats, cursor) row to the attestation events to emit. */
function detectEvents(r) {
	const out = [];
	const slot_or_ts = r.last_signature_at
		? new Date(r.last_signature_at).getTime()
		: Date.now();

	// Graduation flip false -> true.
	if (r.graduated === true && r.last_graduated !== true) {
		out.push({
			event_type: 'graduation',
			source:     'pumpfun.graduation',
			event_id:   deriveEventId({ event_type: 'graduation', mint: r.token_mint, slot_or_ts: 'final' }),
			task_id:    `pumpfun:${r.token_mint}:graduation`,
			detail:     { network: r.network },
		});
	}

	// CTO: agent_authority changed (creator takeover).
	if (r.agent_authority && r.last_authority && r.agent_authority !== r.last_authority) {
		out.push({
			event_type: 'cto_detected',
			source:     'pumpfun.cto',
			event_id:   deriveEventId({
				event_type: 'cto',
				mint:       r.token_mint,
				slot_or_ts: `${r.last_authority}->${r.agent_authority}`,
			}),
			task_id:    `pumpfun:${r.token_mint}:cto:${slot_or_ts}`,
			detail:     { from: r.last_authority, to: r.agent_authority, network: r.network },
		});
	}

	return out;
}

// Exported for tests.
export { detectEvents, WHALE_TRADE_USD_FLOOR };

// ═══════════════════════════════════════════════════════════════════════════
// pumpfun-signals
// ═══════════════════════════════════════════════════════════════════════════

const CLAIMS_PER_RUN = 200;
const GRADS_PER_RUN = 50;

const SIGNAL_WEIGHT = {
	first_claim: +0.2,
	graduation: +0.3,
	influencer: +0.2,
	fake_claim: -0.6,
	new_account: -0.2,
};

async function handlePumpfunSignals(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	const auth = req.headers['authorization'] || '';
	const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && (!expected || auth !== expected)) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	if (!pumpfunBotEnabled()) {
		return json(res, 200, { skipped: 'pumpfun bot not configured' });
	}

	const [claims, grads] = await Promise.all([
		pumpfunMcp.recentClaims({ limit: CLAIMS_PER_RUN }),
		pumpfunMcp.graduations({ limit: GRADS_PER_RUN }),
	]);

	const report = { claims: 0, graduations: 0, inserted: 0, skipped: 0, errors: [] };

	const claimItems = pumpfunArr(claims.ok ? claims.data : null);
	const gradItems = pumpfunArr(grads.ok ? grads.data : null);
	report.claims = claimItems.length;
	report.graduations = gradItems.length;

	const wallets = pumpfunCollectWallets(claimItems, gradItems);
	const linked = await pumpfunLinkedWalletMap(wallets);

	for (const ev of claimItems) {
		const wallet = ev.claimer || ev.github_wallet;
		if (!wallet || !linked.has(wallet)) {
			report.skipped++;
			continue;
		}
		try {
			const inserts = pumpfunSignalsFromClaim(ev);
			for (const sig of inserts) {
				const ok = await pumpfunInsertSignal({
					wallet,
					agent_asset: linked.get(wallet) || null,
					kind: sig.kind,
					weight: SIGNAL_WEIGHT[sig.kind] ?? 0,
					payload: sig.payload,
					tx_signature: sig.tx_signature,
				});
				if (ok) report.inserted++;
			}
		} catch (err) {
			report.errors.push({ tx: ev.tx_signature, error: err.message });
		}
	}

	for (const ev of gradItems) {
		const wallet = ev.creator || ev.dev_wallet;
		if (!wallet || !linked.has(wallet)) {
			report.skipped++;
			continue;
		}
		try {
			const ok = await pumpfunInsertSignal({
				wallet,
				agent_asset: linked.get(wallet) || null,
				kind: 'graduation',
				weight: SIGNAL_WEIGHT.graduation,
				payload: { mint: ev.mint, symbol: ev.symbol, name: ev.name },
				tx_signature: ev.tx_signature || ev.signature,
			});
			if (ok) report.inserted++;
		} catch (err) {
			report.errors.push({ tx: ev.tx_signature, error: err.message });
		}
	}

	return json(res, 200, report);
}

function pumpfunArr(x) {
	if (!x) return [];
	return Array.isArray(x) ? x : x.items || [];
}

function pumpfunCollectWallets(claims, grads) {
	const out = new Set();
	for (const c of claims) {
		if (c.claimer) out.add(c.claimer);
		if (c.github_wallet) out.add(c.github_wallet);
	}
	for (const g of grads) {
		if (g.creator) out.add(g.creator);
		if (g.dev_wallet) out.add(g.dev_wallet);
	}
	return [...out];
}

async function pumpfunLinkedWalletMap(wallets) {
	const map = new Map();
	if (wallets.length === 0) return map;
	const rows = await sql`
		select uw.address, ai.meta->>'sol_mint_address' as agent_asset
		from user_wallets uw
		left join agent_identities ai
			on ai.user_id = uw.user_id
			and ai.deleted_at is null
			and ai.meta->>'chain_type' = 'solana'
		where uw.chain_type = 'solana'
		  and uw.address = any(${wallets})
	`;
	for (const r of rows) map.set(r.address, r.agent_asset);
	return map;
}

function pumpfunSignalsFromClaim(ev) {
	const out = [];
	const base = { tx_signature: ev.tx_signature, payload: ev };
	if (ev.first_time_claim) out.push({ kind: 'first_claim', ...base });
	if (ev.fake_claim) out.push({ kind: 'fake_claim', ...base });
	if (ev.tier === 'mega' || ev.tier === 'influencer') out.push({ kind: 'influencer', ...base });
	if (ev.github_account_age_days != null && ev.github_account_age_days < 30) {
		out.push({ kind: 'new_account', ...base });
	}
	return out;
}

async function pumpfunInsertSignal({ wallet, agent_asset, kind, weight, payload, tx_signature }) {
	if (!tx_signature) return false;
	const result = await sql`
		insert into pumpfun_signals (wallet, agent_asset, kind, weight, payload, tx_signature)
		values (${wallet}, ${agent_asset}, ${kind}, ${weight}, ${JSON.stringify(payload)}::jsonb, ${tx_signature})
		on conflict (tx_signature) do nothing
		returning id
	`;
	return result.length > 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// run-buyback
// ═══════════════════════════════════════════════════════════════════════════

async function buybackLoadRelayer() {
	const b64 = process.env.PUMP_CRON_RELAYER_SECRET_KEY_B64;
	if (!b64) return null;
	const [{ Keypair }] = await Promise.all([import('@solana/web3.js')]);
	return Keypair.fromSecretKey(Buffer.from(b64, 'base64'));
}

async function handleRunBuyback(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = req.headers.authorization || '';
	if (!env.CRON_SECRET) return error(res, 503, 'not_configured', 'CRON_SECRET unset');
	if (auth !== `Bearer ${env.CRON_SECRET}`) {
		return error(res, 401, 'unauthorized', 'cron auth required');
	}

	const relayer = await buybackLoadRelayer();

	const mints = await sql`
		select id, mint, network, full_swap, slippage_bps from pump_agent_mints limit 200
	`;

	const results = [];
	for (const m of mints) {
		const currencyStr = m.network === 'devnet' ? SOLANA_USDC_MINT_DEVNET : SOLANA_USDC_MINT;
		const currency = solanaPubkey(currencyStr);
		const fullSwap = m.full_swap === true;

		try {
			const { agent } = await getPumpAgent({ network: m.network, mint: m.mint });
			const balances = await agent.getBalances(currency);
			const buyback = BigInt(balances.buybackVault?.balance ?? 0);

			if (buyback === 0n) {
				const [run] = await sql`
					insert into pump_buyback_runs (mint_id, currency_mint, status)
					values (${m.id}, ${currencyStr}, 'skipped') returning id
				`;
				results.push({ mint: m.mint, status: 'skipped', run_id: run.id });
				continue;
			}

			const { offline } = await getPumpAgentOffline({ network: m.network, mint: m.mint });
			const [{ PUMP_PROGRAM_ID }] = await Promise.all([
				import('@pump-fun/agent-payments-sdk'),
			]);

			const payerPk = relayer ? relayer.publicKey : solanaPubkey(m.mint);
			const params = {
				globalBuybackAuthority: payerPk,                  // gated by globalConfig — for skipped-swap form, can be relayer
				currencyMint: currency,
				swapProgramToInvoke: PUMP_PROGRAM_ID,             // pump bonding-curve program (same for burn-only and full-swap)
				swapInstructionData: Buffer.alloc(0),             // empty = skip swap, just burn
				remainingAccounts: [],
			};

			if (fullSwap) {
				const { buildPumpSwapInnerIx } = await import('../_lib/pump-swap-ix.js');
				const inner = await buildPumpSwapInnerIx({
					mint: m.mint,
					currency,
					amountIn: buyback,
					slippageBps: m.slippage_bps ?? 500,
					cluster: m.network,
				});
				params.swapInstructionData = inner.data;
				params.remainingAccounts = inner.accounts;
			}

			let ix;
			try {
				ix = await offline.buybackTrigger(params);
			} catch (e) {
				const [run] = await sql`
					insert into pump_buyback_runs (mint_id, currency_mint, swap_program, status, error)
					values (${m.id}, ${currencyStr}, ${PUMP_PROGRAM_ID.toBase58()}, 'failed', ${'buybackTrigger build failed: ' + e.message})
					returning id
				`;
				results.push({ mint: m.mint, status: 'failed', error: e.message, run_id: run.id });
				continue;
			}

			if (!relayer) {
				const txBase64 = await buildUnsignedTxBase64({
					network: m.network,
					payer: payerPk,
					instructions: [ix],
				});
				const [run] = await sql`
					insert into pump_buyback_runs (mint_id, currency_mint, swap_program, status, burn_amount)
					values (${m.id}, ${currencyStr}, ${PUMP_PROGRAM_ID.toBase58()}, 'pending', ${buyback.toString()})
					returning id
				`;
				results.push({ mint: m.mint, status: 'pending', run_id: run.id, tx_base64: txBase64 });
				continue;
			}

			const connection = getConnection({ network: m.network });
			const [{ Transaction }] = await Promise.all([import('@solana/web3.js')]);
			const tx = new Transaction();
			tx.add(ix);
			const { blockhash } = await connection.getLatestBlockhash('confirmed');
			tx.recentBlockhash = blockhash;
			tx.feePayer = relayer.publicKey;
			tx.sign(relayer);
			const sig = await connection.sendRawTransaction(tx.serialize());
			await connection.confirmTransaction(sig, 'confirmed');

			const [run] = await sql`
				insert into pump_buyback_runs
					(mint_id, currency_mint, swap_program, tx_signature, status, burn_amount)
				values
					(${m.id}, ${currencyStr}, ${PUMP_PROGRAM_ID.toBase58()}, ${sig}, 'confirmed', ${buyback.toString()})
				returning id
			`;
			results.push({ mint: m.mint, status: 'confirmed', tx_signature: sig, run_id: run.id });
		} catch (err) {
			await sql`
				insert into pump_buyback_runs (mint_id, currency_mint, status, error)
				values (${m.id}, ${currencyStr}, 'failed', ${err.message || String(err)})
			`;
			results.push({ mint: m.mint, status: 'failed', error: err.message });
		}
	}

	return json(res, 200, { ok: true, processed: results.length, results });
}

// ═══════════════════════════════════════════════════════════════════════════
// run-dca
// ═══════════════════════════════════════════════════════════════════════════

const DCA_CHAIN_CONFIG = {
	84532: {
		chain: baseSepolia,
		swap_router: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
		quoter_v2: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27',
	},
	8453: {
		chain: base,
		swap_router: '0x2626664c2603336E57B271c5C0b26F421741e481',
		quoter_v2: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
	},
};

const QUOTER_V2_ABI = parseAbi([
	'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
]);

const SWAP_ROUTER_ABI = parseAbi([
	'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
]);

const ERC20_ABI = parseAbi([
	'function approve(address spender, uint256 amount) external returns (bool)',
]);

// Uniswap V3 standard fee tier — 0.3% pool is the most liquid USDC/WETH tier
const FEE_TIER = 3000;

const DCA_RPC_TIMEOUT_MS = 10_000;
const DCA_RPC_MAX_RETRIES = 2; // total attempts = 1 + retries
const DCA_RELAYER_TIMEOUT_MS = 30_000;
const DCA_RELAYER_MAX_RETRIES = 1;
const DCA_RELAYER_RETRY_BACKOFF_MS = 1_500;

function isTableMissing(err) {
	return String(err?.message || '').includes('does not exist');
}

function dcaLog(level, event, fields = {}) {
	const line = JSON.stringify({
		level,
		event,
		ts: new Date().toISOString(),
		component: 'cron/run-dca',
		...fields,
	});
	if (level === 'error') console.error(line);
	else console.log(line);
}

async function insertDcaExecution(row) {
	const keys = Object.keys(row);
	const cols = keys.map((k) => `"${k}"`).join(', ');
	const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
	const values = keys.map((k) => row[k]);
	return sql(`INSERT INTO dca_executions (${cols}) VALUES (${placeholders})`, values);
}

function dcaIsTransient(err) {
	// Network-level & RPC transport errors
	const code = err?.code;
	const name = err?.name;
	const status = err?.status;
	if (name === 'AbortError' || name === 'TimeoutError') return true;
	if (
		code === 'ETIMEDOUT' ||
		code === 'ECONNRESET' ||
		code === 'ECONNREFUSED' ||
		code === 'ENOTFOUND' ||
		code === 'EAI_AGAIN'
	)
		return true;
	if (typeof status === 'number' && status >= 500 && status < 600) return true;
	// viem transport errors
	const msg = String(err?.message || '');
	if (/HttpRequestError|TimeoutError|fetch failed|network|socket hang up/i.test(msg)) return true;
	return false;
}

async function dcaWithRetry(fn, { retries, backoffMs = 500, label }) {
	let attempt = 0;
	// eslint-disable-next-line no-constant-condition
	while (true) {
		try {
			return await fn();
		} catch (err) {
			attempt++;
			if (attempt > retries || !dcaIsTransient(err)) throw err;
			const delay = backoffMs * 2 ** (attempt - 1);
			dcaLog('warn', 'retry', {
				label,
				attempt,
				delay_ms: delay,
				message: err?.message,
				code: err?.code,
			});
			await new Promise((r) => setTimeout(r, delay));
		}
	}
}

function dcaGetViemClient(chainId) {
	const cfg = DCA_CHAIN_CONFIG[chainId];
	if (!cfg) throw new Error(`Unsupported chainId: ${chainId}`);
	const rpcUrl = env.getRpcUrl(chainId);
	const transport = rpcUrl
		? http(rpcUrl, { timeout: DCA_RPC_TIMEOUT_MS, retryCount: 0 })
		: http(undefined, { timeout: DCA_RPC_TIMEOUT_MS, retryCount: 0 });
	return createPublicClient({ chain: cfg.chain, transport });
}

/**
 * Fetch a quote twice 15s apart; abort if they diverge by more than 0.5%.
 * Returns { amountOut, divergenceBps } or throws if divergence exceeds limit.
 */
async function dcaGetVerifiedQuote(client, quoterAddress, tokenIn, tokenOut, amountIn, logCtx) {
	const params = {
		tokenIn,
		tokenOut,
		amountIn: BigInt(amountIn),
		fee: FEE_TIER,
		sqrtPriceLimitX96: 0n,
	};

	const readQuote = () =>
		client.readContract({
			address: quoterAddress,
			abi: QUOTER_V2_ABI,
			functionName: 'quoteExactInputSingle',
			args: [params],
		});

	// First quote (with retry on transient RPC failures)
	const [q1] = await dcaWithRetry(readQuote, {
		retries: DCA_RPC_MAX_RETRIES,
		backoffMs: 500,
		label: `quote1:${logCtx?.strategy_id ?? ''}`,
	});

	// Wait 15s then quote again
	await new Promise((r) => setTimeout(r, 15_000));

	const [q2] = await dcaWithRetry(readQuote, {
		retries: DCA_RPC_MAX_RETRIES,
		backoffMs: 500,
		label: `quote2:${logCtx?.strategy_id ?? ''}`,
	});

	// Divergence in basis points: |q2-q1| / q1 * 10000
	const divergenceBps = q1 === 0n ? 0 : Number(((q2 > q1 ? q2 - q1 : q1 - q2) * 10000n) / q1);

	if (divergenceBps > 50) {
		throw Object.assign(
			new Error(`Quote divergence ${divergenceBps}bps exceeds 50bps limit — aborting`),
			{ code: 'quote_divergence', divergenceBps },
		);
	}

	// Use the more conservative (lower) of the two quotes
	const amountOut = q1 < q2 ? q1 : q2;
	return { amountOut, divergenceBps };
}

function dcaBuildApproveCalldata(spender, amount) {
	return encodeFunctionData({
		abi: ERC20_ABI,
		functionName: 'approve',
		args: [spender, BigInt(amount)],
	});
}

function dcaBuildSwapCalldata(tokenIn, tokenOut, recipient, amountIn, amountOutMinimum) {
	return encodeFunctionData({
		abi: SWAP_ROUTER_ABI,
		functionName: 'exactInputSingle',
		args: [
			{
				tokenIn,
				tokenOut,
				fee: FEE_TIER,
				recipient,
				amountIn: BigInt(amountIn),
				amountOutMinimum: BigInt(amountOutMinimum),
				sqrtPriceLimitX96: 0n,
			},
		],
	});
}

async function dcaRedeemViaRelayer(delegationId, calls, logCtx) {
	const relayerUrl = `${env.APP_ORIGIN}/api/permissions/redeem`;

	const doFetch = async () => {
		const res = await fetch(relayerUrl, {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				authorization: `Bearer ${env.CRON_SECRET}`,
			},
			body: JSON.stringify({ id: delegationId, calls }),
			signal: AbortSignal.timeout(DCA_RELAYER_TIMEOUT_MS),
		});

		if (!res.ok) {
			const body = await res.json().catch(() => ({ message: res.statusText }));
			throw Object.assign(
				new Error(body.error_description || body.message || `Relayer ${res.status}`),
				{ code: body.error || 'relayer_error', status: res.status },
			);
		}
		return res.json();
	};

	return dcaWithRetry(doFetch, {
		retries: DCA_RELAYER_MAX_RETRIES,
		backoffMs: DCA_RELAYER_RETRY_BACKOFF_MS,
		label: `relayer:${logCtx?.strategy_id ?? ''}`,
	});
}

async function dcaOnPeriod(strategy) {
	const {
		id: strategyId,
		delegation_id: delegationId,
		chain_id: chainId,
		token_in: tokenIn,
		token_out: tokenOut,
		amount_per_execution: amountIn,
		slippage_bps: slippageBps,
	} = strategy;

	const cfg = DCA_CHAIN_CONFIG[chainId];
	if (!cfg)
		throw Object.assign(new Error(`No config for chainId ${chainId}`), {
			code: 'unsupported_chain',
		});

	const client = dcaGetViemClient(chainId);
	const logCtx = { strategy_id: strategyId, chain_id: chainId };

	// Get verified quote
	const { amountOut, divergenceBps } = await dcaGetVerifiedQuote(
		client,
		cfg.quoter_v2,
		tokenIn,
		tokenOut,
		amountIn,
		logCtx,
	);

	// Apply slippage: amountOutMinimum = amountOut * (10000 - slippageBps) / 10000
	const amountOutMinimum = (amountOut * BigInt(10000 - slippageBps)) / 10000n;

	// Resolve recipient — use the delegator address from the delegation row
	const [delegationRow] = await sql`
		SELECT delegator_address FROM agent_delegations
		WHERE id = ${delegationId} AND status = 'active'
		LIMIT 1
	`;
	if (!delegationRow) {
		throw Object.assign(new Error('Delegation not found or no longer active'), {
			code: 'delegation_gone',
		});
	}
	const recipient = delegationRow.delegator_address;

	// Build calls: [approve USDC → SwapRouter, exactInputSingle]
	const calls = [
		{
			to: tokenIn,
			value: '0',
			data: dcaBuildApproveCalldata(cfg.swap_router, amountIn),
		},
		{
			to: cfg.swap_router,
			value: '0',
			data: dcaBuildSwapCalldata(tokenIn, tokenOut, recipient, amountIn, amountOutMinimum),
		},
	];

	// Submit via relayer
	const result = await dcaRedeemViaRelayer(delegationId, calls, logCtx);

	return { txHash: result.txHash, quoteAmountOut: amountOut.toString(), divergenceBps };
}

async function handleRunDca(req, res) {
	// Vercel cron passes Authorization: Bearer $CRON_SECRET
	const cronSecret = env.CRON_SECRET;
	if (cronSecret) {
		const auth = req.headers.authorization || '';
		if (auth !== `Bearer ${cronSecret}`) {
			return error(res, 401, 'unauthorized', 'invalid cron secret');
		}
	}

	const runId = globalThis.crypto?.randomUUID?.() ?? `run_${Date.now()}`;
	dcaLog('info', 'tick_start', { run_id: runId });

	// Fetch all due active strategies
	let strategies;
	try {
		strategies = await sql`
			SELECT
				s.id, s.delegation_id, s.chain_id,
				s.token_in, s.token_out, s.amount_per_execution,
				s.period_seconds, s.slippage_bps, s.agent_id,
				ad.status AS delegation_status, ad.expires_at AS delegation_expires_at
			FROM dca_strategies s
			JOIN agent_delegations ad ON ad.id = s.delegation_id
			WHERE s.status = 'active'
			  AND s.next_execution_at <= NOW()
			ORDER BY s.next_execution_at ASC
			LIMIT 50
		`;
	} catch (err) {
		if (isTableMissing(err)) {
			dcaLog('info', 'tick_skip', { run_id: runId, reason: 'dca_strategies table not yet created' });
			return json(res, 200, { ok: true, skipped: true, reason: 'table_not_ready' });
		}
		dcaLog('error', 'fetch_due_failed', { run_id: runId, message: err?.message });
		throw err;
	}

	const results = [];
	for (const strategy of strategies) {
		const logCtx = { run_id: runId, strategy_id: strategy.id, chain_id: strategy.chain_id };

		const execRow = {
			strategy_id: strategy.id,
			chain_id: strategy.chain_id,
			amount_in: strategy.amount_per_execution,
			slippage_bps_used: strategy.slippage_bps,
			status: 'pending',
		};

		// Check delegation is still alive before spending gas on a quote
		if (strategy.delegation_status !== 'active') {
			await sql`
				UPDATE dca_strategies SET status = 'paused' WHERE id = ${strategy.id}
			`;
			execRow.status = 'aborted';
			execRow.error = `Delegation ${strategy.delegation_status}`;
			await insertDcaExecution(execRow).catch((e) =>
				dcaLog('error', 'exec_insert_failed', { ...logCtx, message: e?.message }),
			);
			dcaLog('info', 'skipped', { ...logCtx, reason: execRow.error });
			results.push({ id: strategy.id, skipped: true, reason: execRow.error });
			continue;
		}

		if (new Date(strategy.delegation_expires_at) <= new Date()) {
			await sql`
				UPDATE dca_strategies SET status = 'expired' WHERE id = ${strategy.id}
			`;
			execRow.status = 'aborted';
			execRow.error = 'Delegation expired';
			await insertDcaExecution(execRow).catch((e) =>
				dcaLog('error', 'exec_insert_failed', { ...logCtx, message: e?.message }),
			);
			dcaLog('info', 'skipped', { ...logCtx, reason: execRow.error });
			results.push({ id: strategy.id, skipped: true, reason: execRow.error });
			continue;
		}

		// ── Idempotency claim ───────────────────────────────────────────────
		// Atomically advance next_execution_at so a concurrent tick (or a retry
		// of this tick) will not re-pick this row. We advance by period_seconds
		// provisionally; on success we leave it; on failure we reset to NOW so
		// the next tick retries it.
		const nowIso = new Date().toISOString();
		const provisionalNextIso = new Date(
			Date.now() + strategy.period_seconds * 1000,
		).toISOString();

		const claim = await sql`
			UPDATE dca_strategies
			SET next_execution_at = ${provisionalNextIso}
			WHERE id = ${strategy.id}
			  AND status = 'active'
			  AND next_execution_at <= ${nowIso}
			RETURNING id
		`;
		if (claim.length === 0) {
			dcaLog('info', 'claim_lost', { ...logCtx });
			results.push({ id: strategy.id, skipped: true, reason: 'claim_lost' });
			continue;
		}

		dcaLog('info', 'execute_start', { ...logCtx });

		try {
			const { txHash, quoteAmountOut, divergenceBps } = await dcaOnPeriod(strategy);

			execRow.tx_hash = txHash;
			execRow.quote_amount_out = quoteAmountOut;
			execRow.quote_divergence_bps = divergenceBps;
			execRow.status = 'success';

			await sql`
				UPDATE dca_strategies
				SET last_execution_at = NOW()
				WHERE id = ${strategy.id}
			`;

			dcaLog('info', 'execute_success', {
				...logCtx,
				tx_hash: txHash,
				divergence_bps: divergenceBps,
			});
			results.push({ id: strategy.id, txHash, quoteAmountOut });
		} catch (err) {
			execRow.status = err.code === 'quote_divergence' ? 'aborted' : 'failed';
			execRow.error = err.message;
			execRow.quote_divergence_bps = err.divergenceBps ?? null;

			// Release the idempotency claim so the next tick can retry this
			// strategy — but only for transient / recoverable failures. For
			// aborts (quote_divergence, delegation_gone) leave the advanced
			// next_execution_at in place so we wait the full period.
			const shouldRetryNextTick =
				err.code !== 'quote_divergence' &&
				err.code !== 'delegation_gone' &&
				err.code !== 'unsupported_chain';
			if (shouldRetryNextTick) {
				await sql`
					UPDATE dca_strategies
					SET next_execution_at = ${nowIso}
					WHERE id = ${strategy.id}
				`.catch((e) => dcaLog('error', 'claim_release_failed', { ...logCtx, message: e?.message }));
			}

			dcaLog('error', 'execute_failed', {
				...logCtx,
				code: err.code,
				message: err.message,
				status: err.status,
				will_retry_next_tick: shouldRetryNextTick,
			});
			results.push({ id: strategy.id, error: err.message, code: err.code });
		}

		// Insert execution record regardless of outcome
		await insertDcaExecution(execRow).catch((e) =>
			dcaLog('error', 'exec_insert_failed', { ...logCtx, message: e?.message }),
		);
	}

	dcaLog('info', 'tick_done', { run_id: runId, processed: strategies.length });

	return json(res, 200, {
		ok: true,
		processed: strategies.length,
		results,
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// run-distribute-payments
// ═══════════════════════════════════════════════════════════════════════════

const DISTRIBUTE_CRON_RELAYER_SECRET_KEY_B64 = () =>
	process.env.PUMP_CRON_RELAYER_SECRET_KEY_B64 || null;

async function distributeLoadRelayer() {
	const b64 = DISTRIBUTE_CRON_RELAYER_SECRET_KEY_B64();
	if (!b64) return null;
	const [{ Keypair }] = await Promise.all([import('@solana/web3.js')]);
	return Keypair.fromSecretKey(Buffer.from(b64, 'base64'));
}

async function handleRunDistributePayments(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	// Auth: cron secret OR admin bearer.
	const auth = req.headers.authorization || '';
	const cronSecret = env.CRON_SECRET;
	if (!cronSecret) return error(res, 503, 'not_configured', 'CRON_SECRET unset');
	if (auth !== `Bearer ${cronSecret}`) {
		return error(res, 401, 'unauthorized', 'cron auth required');
	}

	// Pick mints to consider: those with confirmed payments since last
	// distribute run, or never run before.
	const mints = await sql`
		select m.id, m.mint, m.network, m.buyback_bps
		from pump_agent_mints m
		where exists (
			select 1 from pump_agent_payments p
			where p.mint_id = m.id and p.status = 'confirmed'
			  and (
				p.confirmed_at > coalesce(
					(select max(created_at) from pump_distribute_runs r where r.mint_id = m.id),
					'epoch'::timestamptz
				)
			  )
		)
		limit 200
	`;

	const relayer = await distributeLoadRelayer();
	const results = [];

	for (const m of mints) {
		const currencyStr = m.network === 'devnet' ? SOLANA_USDC_MINT_DEVNET : SOLANA_USDC_MINT;
		const currency = solanaPubkey(currencyStr);

		try {
			const { agent } = await getPumpAgent({ network: m.network, mint: m.mint });
			const balancesBefore = await agent.getBalances(currency);
			const paymentBalance = BigInt(balancesBefore.paymentVault.balance ?? 0);

			if (paymentBalance === 0n) {
				const [run] = await sql`
					insert into pump_distribute_runs (mint_id, currency_mint, status, balances_before)
					values (${m.id}, ${currencyStr}, 'skipped', ${JSON.stringify({ payment: paymentBalance.toString() })}::jsonb)
					returning id
				`;
				results.push({ mint: m.mint, status: 'skipped', run_id: run.id });
				continue;
			}

			const { offline } = await getPumpAgentOffline({ network: m.network, mint: m.mint });

			if (!relayer) {
				// No relayer: build unsigned tx for an external keeper. Persist run as 'pending'.
				const ixs = await offline.distributePayments({
					user: solanaPubkey(process.env.PUMP_DISTRIBUTE_FALLBACK_PAYER || m.mint),
					currencyMint: currency,
				});
				const txBase64 = await buildUnsignedTxBase64({
					network: m.network,
					payer: solanaPubkey(process.env.PUMP_DISTRIBUTE_FALLBACK_PAYER || m.mint),
					instructions: Array.isArray(ixs) ? ixs : [ixs],
				});
				const [run] = await sql`
					insert into pump_distribute_runs (mint_id, currency_mint, status, balances_before)
					values (${m.id}, ${currencyStr}, 'pending', ${JSON.stringify({ payment: paymentBalance.toString() })}::jsonb)
					returning id
				`;
				results.push({ mint: m.mint, status: 'pending', run_id: run.id, tx_base64: txBase64 });
				continue;
			}

			// Relayer path: sign + send.
			const ixs = await offline.distributePayments({
				user: relayer.publicKey,
				currencyMint: currency,
			});
			const connection = getConnection({ network: m.network });
			const [{ Transaction }] = await Promise.all([import('@solana/web3.js')]);
			const tx = new Transaction();
			tx.add(...(Array.isArray(ixs) ? ixs : [ixs]));
			const { blockhash } = await connection.getLatestBlockhash('confirmed');
			tx.recentBlockhash = blockhash;
			tx.feePayer = relayer.publicKey;
			tx.sign(relayer);
			const sig = await connection.sendRawTransaction(tx.serialize(), {
				skipPreflight: false,
			});
			await connection.confirmTransaction(sig, 'confirmed');

			const balancesAfter = await agent.getBalances(currency);
			const [run] = await sql`
				insert into pump_distribute_runs
					(mint_id, currency_mint, tx_signature, status, balances_before, balances_after)
				values
					(${m.id}, ${currencyStr}, ${sig}, 'confirmed',
					 ${JSON.stringify({ payment: paymentBalance.toString() })}::jsonb,
					 ${JSON.stringify({
						buyback: balancesAfter.buybackVault?.balance?.toString?.(),
						withdraw: balancesAfter.withdrawVault?.balance?.toString?.(),
					})}::jsonb)
				returning id
			`;
			results.push({ mint: m.mint, status: 'confirmed', tx_signature: sig, run_id: run.id });
		} catch (err) {
			await sql`
				insert into pump_distribute_runs (mint_id, currency_mint, status, error)
				values (${m.id}, ${currencyStr}, 'failed', ${err.message || String(err)})
			`;
			results.push({ mint: m.mint, status: 'failed', error: err.message });
		}
	}

	return json(res, 200, {
		ok: true,
		processed: results.length,
		relayer: relayer ? relayer.publicKey.toBase58() : null,
		results,
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// run-subscriptions
// ═══════════════════════════════════════════════════════════════════════════

// USDC contract addresses by chain ID.
const USDC_BY_CHAIN = {
	84532: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
	11155111: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', // Sepolia
};

// Max time we'll wait for the skill's onPeriod (which fetches the relayer).
// Override via SUBSCRIPTION_CHARGE_TIMEOUT_MS.
const ONPERIOD_TIMEOUT_MS = parseInt(process.env.SUBSCRIPTION_CHARGE_TIMEOUT_MS ?? '30000', 10);

// Structured log helper — single-line JSON so Vercel log drains can parse it.
function subLog(event, fields = {}) {
	try {
		console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
	} catch {
		// Never let logging throw.
	}
}

function subLogError(event, fields = {}) {
	try {
		console.error(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
	} catch {
		// Never let logging throw.
	}
}

// Race a promise against a timeout. Rejects with a tagged error on timeout.
function subWithTimeout(promise, ms, label) {
	return new Promise((resolve, reject) => {
		const t = setTimeout(() => {
			const err = new Error(`${label} timed out after ${ms}ms`);
			err.code = 'timeout';
			reject(err);
		}, ms);
		Promise.resolve(promise).then(
			(v) => {
				clearTimeout(t);
				resolve(v);
			},
			(e) => {
				clearTimeout(t);
				reject(e);
			},
		);
	});
}

async function handleRunSubscriptions(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	// Auth: Vercel Cron header OR explicit Bearer $CRON_SECRET.
	// If neither is configured AND no Vercel cron header is present, reject.
	const auth = req.headers['authorization'] ?? '';
	const expected = env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : null;
	const fromVercelCron = req.headers['x-vercel-cron'] === '1';
	if (!fromVercelCron) {
		if (!expected || auth !== expected) {
			return error(res, 401, 'unauthorized', 'cron secret required');
		}
	}

	const runId = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const runStart = Date.now();
	subLog('subscription_cron.start', { runId, fromVercelCron });

	const origin = env.APP_ORIGIN;
	const relayerToken = env.CRON_SECRET ?? '';

	const report = {
		runId,
		processed: 0,
		charged: 0,
		skipped: 0,
		paused: 0,
		claimLost: 0,
		errors: [],
	};

	// Load the skill's onPeriod handler once per invocation.
	let onPeriod;
	try {
		({ onPeriod } = await import('../../public/skills/subscription/skill.js'));
	} catch (err) {
		subLogError('subscription_cron.skill_load_failed', { runId, message: err.message });
		return error(res, 500, 'internal_error', 'failed to load subscription skill');
	}

	// Select all active subscriptions whose charge window has arrived.
	let rows;
	try {
		rows = await sql`
			SELECT
				s.id,
				s.user_id,
				s.agent_id,
				s.delegation_id,
				s.period_seconds,
				s.amount_per_period,
				s.next_charge_at,
				s.last_charge_at,
				d.status          AS delegation_status,
				d.expires_at      AS delegation_expires_at,
				d.chain_id,
				ai.wallet_address AS owner_address
			FROM agent_subscriptions s
			JOIN agent_delegations d  ON d.id  = s.delegation_id
			JOIN agent_identities  ai ON ai.id = s.agent_id
			WHERE s.status = 'active'
			  AND s.next_charge_at <= NOW()
		`;
	} catch (err) {
		if (isTableMissing(err)) {
			subLog('subscription_cron.skip', { runId, reason: 'agent_subscriptions table not yet created' });
			return json(res, 200, { ok: true, skipped: true, reason: 'table_not_ready' });
		}
		subLogError('subscription_cron.select_failed', { runId, message: err.message });
		return error(res, 500, 'internal_error', 'failed to load subscriptions');
	}

	subLog('subscription_cron.selected', { runId, count: rows.length });

	for (const row of rows) {
		report.processed++;
		const rowStart = Date.now();
		const ctx = { runId, subscriptionId: row.id, agentId: row.agent_id };

		try {
			// Guard: delegation must still be active.
			if (row.delegation_status !== 'active') {
				await subPause(row.id, `delegation_${row.delegation_status}`);
				report.paused++;
				report.errors.push({ id: row.id, reason: `delegation_${row.delegation_status}` });
				subLog('subscription_cron.paused', {
					...ctx,
					reason: `delegation_${row.delegation_status}`,
				});
				continue;
			}

			// Guard: delegation must not be expired.
			if (row.delegation_expires_at && new Date(row.delegation_expires_at) <= new Date()) {
				await subPause(row.id, 'delegation_expired');
				report.paused++;
				report.errors.push({ id: row.id, reason: 'delegation_expired' });
				subLog('subscription_cron.paused', { ...ctx, reason: 'delegation_expired' });
				continue;
			}

			const usdcAddress = USDC_BY_CHAIN[row.chain_id];
			if (!usdcAddress) {
				await subPause(row.id, `chain_${row.chain_id}_unsupported`);
				report.skipped++;
				report.errors.push({ id: row.id, reason: `chain_${row.chain_id}_unsupported` });
				subLog('subscription_cron.skipped', {
					...ctx,
					reason: `chain_${row.chain_id}_unsupported`,
				});
				continue;
			}

			// Atomic claim: mark this period as being processed by writing
			// last_charge_at = NOW(). Matches only if:
			//   - next_charge_at hasn't moved (no racing writer),
			//   - status is still active,
			//   - last_charge_at is NULL OR < next_charge_at (not already claimed for this period).
			// If 0 rows returned, another worker claimed this period — skip.
			const claim = await sql`
				UPDATE agent_subscriptions
				SET last_charge_at = NOW()
				WHERE id = ${row.id}
				  AND status = 'active'
				  AND next_charge_at = ${row.next_charge_at}
				  AND (last_charge_at IS NULL OR last_charge_at < next_charge_at)
				RETURNING id
			`;
			if (claim.length === 0) {
				report.claimLost++;
				subLog('subscription_cron.claim_lost', ctx);
				continue;
			}

			let result;
			try {
				result = await subWithTimeout(
					onPeriod({
						agent: {
							agentId: row.agent_id,
							chainId: row.chain_id,
							ownerAddress: row.owner_address,
							usdcAddress,
							relayerToken,
							origin,
						},
						subscription: {
							id: row.id,
							delegationId: row.delegation_id,
							amountPerPeriod: row.amount_per_period,
						},
					}),
					ONPERIOD_TIMEOUT_MS,
					'onPeriod',
				);
			} catch (err) {
				const reason =
					(err.code === 'timeout' ? 'timeout: ' : '') + (err.message ?? 'unknown');
				await subSafePause(row.id, reason, ctx);
				report.paused++;
				report.errors.push({ id: row.id, reason });
				subLogError('subscription_cron.onperiod_threw', {
					...ctx,
					code: err.code ?? 'unknown',
					message: err.message ?? 'unknown',
					durationMs: Date.now() - rowStart,
				});
				continue;
			}

			if (result && result.ok) {
				// Advance next_charge_at by exactly one period to enforce idempotency.
				const nextChargeAt = new Date(
					Date.parse(row.next_charge_at) + row.period_seconds * 1000,
				);
				try {
					await sql`
						UPDATE agent_subscriptions
						SET next_charge_at = ${nextChargeAt.toISOString()},
						    last_error     = NULL
						WHERE id = ${row.id}
					`;
				} catch (err) {
					// Charge succeeded on-chain but we failed to advance — log loudly.
					// Do NOT pause: next run's claim guard will prevent double-charge
					// since last_charge_at >= next_charge_at for this period.
					subLogError('subscription_cron.advance_failed', {
						...ctx,
						message: err.message,
						txHash: result.txHash,
					});
					report.errors.push({
						id: row.id,
						reason: 'advance_failed',
						message: err.message,
					});
					continue;
				}

				// Emit usage event — non-fatal if the table schema differs.
				await sql`
					INSERT INTO usage_events (user_id, kind, tool, status)
					VALUES (${row.user_id}, 'subscription_charge', 'subscription', 'success')
				`.catch((err) =>
					subLogError('subscription_cron.usage_event_failed', {
						...ctx,
						message: err.message,
					}),
				);

				report.charged++;
				subLog('subscription_cron.charged', {
					...ctx,
					txHash: result.txHash,
					durationMs: Date.now() - rowStart,
				});
			} else {
				const code = result?.code ?? 'unknown';
				const message = result?.message ?? '';
				await subSafePause(row.id, `${code}: ${message}`.slice(0, 500), ctx);
				report.paused++;
				report.errors.push({ id: row.id, code, message });
				subLog('subscription_cron.paused', {
					...ctx,
					code,
					message,
					durationMs: Date.now() - rowStart,
				});
			}
		} catch (err) {
			// Catch-all so one bad row can't kill the run.
			subLogError('subscription_cron.row_unhandled', {
				...ctx,
				message: err.message ?? 'unknown',
				stack: err.stack,
			});
			report.errors.push({ id: row.id, reason: 'unhandled', message: err.message });
			// Best-effort pause so we don't loop on the same broken row next hour.
			await subSafePause(row.id, `unhandled: ${(err.message ?? 'unknown').slice(0, 480)}`, ctx);
			report.paused++;
		}
	}

	subLog('subscription_cron.done', {
		runId,
		durationMs: Date.now() - runStart,
		processed: report.processed,
		charged: report.charged,
		paused: report.paused,
		skipped: report.skipped,
		claimLost: report.claimLost,
		errorCount: report.errors.length,
	});

	return json(res, 200, report);
}

async function subPause(id, lastError) {
	await sql`
		UPDATE agent_subscriptions
		SET status = 'paused', last_error = ${lastError}
		WHERE id = ${id}
	`;
}

// Like subPause but swallows its own errors so a DB hiccup during pause doesn't
// propagate out of the per-row handler. Logs the failure for ops visibility.
async function subSafePause(id, lastError, ctx) {
	try {
		await subPause(id, lastError);
	} catch (err) {
		subLogError('subscription_cron.pause_failed', {
			...ctx,
			lastError,
			message: err.message,
		});
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// solana-attest-event-cleanup
// ═══════════════════════════════════════════════════════════════════════════

const STALE_AFTER_SECS = 60 * 60; // 1 hour

async function handleSolanaAttestEventCleanup(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	const auth = req.headers['authorization'] || '';
	const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && (!expected || auth !== expected)) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	const result = await sql`
		delete from solana_attest_event_claims
		where signature is null
		  and claimed_at < now() - (${STALE_AFTER_SECS} || ' seconds')::interval
		returning agent_asset, network, event_id, claimed_at
	`;

	return json(res, 200, {
		deleted: result.length,
		stale_after_secs: STALE_AFTER_SECS,
		samples: result.slice(0, 10),
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// solana-attestations-crawl
// ═══════════════════════════════════════════════════════════════════════════

const SOL_ATTEST_PER_RUN_MAX = 50; // bound RPC fan-out per cron tick

async function handleSolanaAttestationsCrawl(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	const auth = req.headers['authorization'] || '';
	const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && (!expected || auth !== expected)) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	// Pull Solana agents, oldest-cursor first.
	const agents = await sql`
		select
			a.id,
			a.meta->>'sol_mint_address' as agent_asset,
			coalesce(a.meta->>'network', 'mainnet') as network,
			a.wallet_address as owner_wallet,
			c.last_indexed_at
		from agent_identities a
		left join solana_attestations_cursor c
			on c.agent_asset = a.meta->>'sol_mint_address'
		where a.deleted_at is null
		  and a.meta ? 'sol_mint_address'
		order by c.last_indexed_at nulls first
		limit ${SOL_ATTEST_PER_RUN_MAX}
	`;

	const report = { agents: [], errors: [] };
	for (const row of agents) {
		try {
			const r = await crawlAgentAttestations({
				agentAsset:  row.agent_asset,
				network:     row.network,
				ownerWallet: row.owner_wallet,
			});
			report.agents.push({ asset: row.agent_asset, ...r });
		} catch (err) {
			report.errors.push({ asset: row.agent_asset, error: err.message || String(err) });
		}
	}

	return json(res, 200, report);
}

// ═══════════════════════════════════════════════════════════════════════════
// process-subscriptions
// ═══════════════════════════════════════════════════════════════════════════

async function handleProcessSubscriptions(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	const auth = req.headers['authorization'] || '';
	const cronSecret = env.CRON_SECRET;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && cronSecret && auth !== `Bearer ${cronSecret}`) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	const runId = `psub-${Date.now()}`;
	const report = {
		runId,
		processed: 0,
		charged: 0,        // succeeded outright (instantaneous settlement)
		pendingApproval: 0, // payment intent created; subscriber must approve
		pastDue: 0,
		errors: [],
	};

	// Find subscriptions whose period ends within the next hour (charge a bit
	// early to allow for retry windows before period actually expires).
	const dues = await sql`
		SELECT
			cs.id, cs.subscriber_user_id, cs.plan_id, cs.current_period_end,
			sp.price_usd,
			u.email AS subscriber_email,
			u.display_name AS subscriber_name
		FROM creator_subscriptions cs
		JOIN subscription_plans sp ON sp.id = cs.plan_id
		JOIN users u ON u.id = cs.subscriber_user_id
		WHERE cs.status = 'active'
		  AND cs.current_period_end < now() + interval '1 hour'
		ORDER BY cs.current_period_end ASC
		LIMIT 200
	`;

	for (const row of dues) {
		report.processed++;
		try {
			// Count prior failed payments to decide retry vs. past_due.
			const [{ failCount }] = await sql`
				SELECT count(*)::int AS "failCount"
				FROM subscription_payments
				WHERE subscription_id = ${row.id} AND status = 'failed'
			`;

			if (failCount >= 3) {
				// Mark past_due and notify subscriber.
				await sql`
					UPDATE creator_subscriptions
					SET status = 'past_due'
					WHERE id = ${row.id} AND status = 'active'
				`;
				report.pastDue++;
				console.log(JSON.stringify({
					event: 'process_subscriptions.past_due',
					runId,
					subscriptionId: row.id,
					failCount,
				}));
				// Fire-and-forget email notification.
				sendEmail({
					to: row.subscriber_email,
					subject: 'Action required: subscription payment failed',
					html: `<p>Hi ${row.subscriber_name || 'there'},</p>
<p>We were unable to process your subscription payment of $${row.price_usd}. Your subscription has been paused. Please update your payment method to continue.</p>
<p><a href="${env.APP_ORIGIN}/dashboard#subscriptions">Manage subscriptions</a></p>`,
					text: `Your subscription payment of $${row.price_usd} could not be processed. Visit ${env.APP_ORIGIN}/dashboard#subscriptions to manage your subscriptions.`,
				}).catch((e) => console.error(JSON.stringify({
					event: 'process_subscriptions.email_failed',
					subscriptionId: row.id,
					error: e.message,
				})));
				continue;
			}

			const result = await chargeSubscription(row.id);
			if (result.success) {
				report.charged++;
			} else if (result.pending) {
				// A payment intent was created and the subscriber was notified
				// in-app. Do not increment `charged` — the subscription has
				// NOT been paid yet. A follow-up email reminder is best-effort
				// and only fires when subscriber_email is present.
				report.pendingApproval++;
				if (row.subscriber_email && result.payUrl) {
					sendEmail({
						to: row.subscriber_email,
						subject: 'Your subscription renewal is due',
						html: `<p>Hi ${row.subscriber_name || 'there'},</p>
<p>Your subscription is up for renewal. The amount is $${result.amount_usd?.toFixed(2) || row.price_usd}.</p>
<p><a href="${result.payUrl}">Approve renewal payment</a></p>`,
						text: `Your subscription renewal of $${result.amount_usd?.toFixed(2) || row.price_usd} is ready. Approve at ${result.payUrl}`,
					}).catch((e) => console.error(JSON.stringify({
						event: 'process_subscriptions.email_failed',
						subscriptionId: row.id,
						error: e.message,
					})));
				}
			} else {
				if (result.paymentId) {
					await failPayment(result.paymentId, row.id);
				}
				report.errors.push({ id: row.id, error: result.error || 'charge_failed' });
			}
		} catch (e) {
			report.errors.push({ id: row.id, error: e.message || String(e) });
			console.error(JSON.stringify({
				event: 'process_subscriptions.row_error',
				runId,
				subscriptionId: row.id,
				error: e.message,
			}));
		}
	}

	console.log(JSON.stringify({ event: 'process_subscriptions.done', ...report }));
	return json(res, 200, report);
}

// ═══════════════════════════════════════════════════════════════════════════
// settle-royalties
// ═══════════════════════════════════════════════════════════════════════════

async function handleSettleRoyalties(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	const auth = req.headers['authorization'] || '';
	const cronSecret = env.CRON_SECRET;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && cronSecret && auth !== `Bearer ${cronSecret}`) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	const { settleAllPendingRoyalties } = await import('../_lib/royalty.js');
	const report = await settleAllPendingRoyalties();
	return json(res, 200, { ok: true, ...report });
}

// ═══════════════════════════════════════════════════════════════════════════
// audit-log-cleanup — retention policy: keep 365 days of audit_log rows.
// ═══════════════════════════════════════════════════════════════════════════

const AUDIT_LOG_RETENTION_DAYS = 365;

async function handleAuditLogCleanup(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	const auth = req.headers['authorization'] || '';
	const cronSecret = env.CRON_SECRET;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && cronSecret && auth !== `Bearer ${cronSecret}`) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	const result = await sql`
		delete from audit_log
		where created_at < now() - (${AUDIT_LOG_RETENTION_DAYS} || ' days')::interval
		returning id
	`;
	return json(res, 200, { deleted: result.length, retention_days: AUDIT_LOG_RETENTION_DAYS });
}

// ═══════════════════════════════════════════════════════════════════════════
// expire-pending-purchases — fail-close stale pending skill purchases.
// Schedule: every 5 minutes. Marks rows past expires_at as 'expired' so the
// idempotent-create path issues a fresh reference on the buyer's next attempt.
// ═══════════════════════════════════════════════════════════════════════════

async function handleExpirePendingPurchases(req, res) {
	if (!method(req, res, ['GET'])) return;
	const result = await sql`
		UPDATE skill_purchases
		SET status = 'expired', updated_at = now()
		WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < now()
		RETURNING id
	`;
	return json(res, 200, { expired: result.length });
}

// ═══════════════════════════════════════════════════════════════════════════
// cleanup-csrf-tokens — drop expired tokens. Run hourly.
// ═══════════════════════════════════════════════════════════════════════════

async function handleCleanupCsrfTokens(req, res) {
	if (!method(req, res, ['GET'])) return;
	const result = await sql`DELETE FROM csrf_tokens WHERE expires_at < now() RETURNING token`;
	return json(res, 200, { deleted: result.length });
}

// ═══════════════════════════════════════════════════════════════════════════
// siwx-gc — prune SIWX nonces (replay window) and expired payment grants.
// Hourly. Nonce window of 10 min is well above the 5-min SIWX maxAge;
// payments grace of 7 days avoids cutting off slow clients at the boundary.
// ═══════════════════════════════════════════════════════════════════════════

async function handleSiwxGc(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	const auth = req.headers['authorization'] || '';
	const expected = env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : null;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && (!expected || auth !== expected)) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	const { pruneOldNonces, pruneExpiredPayments } = await import('../_lib/siwx-storage.js');

	const noncesDeleted = await pruneOldNonces(10 * 60);
	const paymentsDeleted = await pruneExpiredPayments(7 * 24 * 3600);

	return json(res, 200, {
		ok: true,
		noncesDeleted,
		paymentsDeleted,
		ranAt: new Date().toISOString(),
	});
}

// ═══════════════════════════════════════════════════════════════════════════
// process-withdrawals — pick up pending Solana USDC withdrawals and execute
// them from the treasury keypair. Runs hourly.
// State machine: pending → processing → completed (with tx_signature) | failed (with error_message)
// ═══════════════════════════════════════════════════════════════════════════

const WITHDRAWALS_BATCH = 20;

async function handleProcessWithdrawals(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;

	const auth = req.headers['authorization'] || '';
	const cronSecret = env.CRON_SECRET;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && cronSecret && auth !== `Bearer ${cronSecret}`) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	const treasuryKeypair = process.env.TREASURY_KEYPAIR;
	const evmTreasuryKey = process.env.EVM_TREASURY_PRIVATE_KEY;
	if (!treasuryKeypair && !evmTreasuryKey) {
		return json(res, 200, {
			skipped: true,
			reason: 'No treasury key configured (set TREASURY_KEYPAIR for Solana, EVM_TREASURY_PRIVATE_KEY for EVM)',
		});
	}

	const { transferSolanaUSDC } = await import('../_lib/solana-transfer.js');
	const { sendEvmUsdc, resolveEvmChainId } = await import('../_lib/evm-transfer.js');
	const { insertNotification } = await import('../_lib/notify.js');

	// Build the chain filter to match what we can actually process. A row whose
	// chain has no treasury key configured stays 'pending' for the next pass
	// once an operator wires the key.
	const supportedChains = [];
	if (treasuryKeypair) supportedChains.push('solana');
	if (evmTreasuryKey) supportedChains.push('ethereum', 'base', 'optimism', 'arbitrum', 'polygon', 'sepolia', 'base-sepolia', '1', '8453', '10', '42161', '137', '11155111', '84532');

	// Fetch pending withdrawals across all supported chains, join user earnings
	// to verify available balance.
	const pending = await sql`
		SELECT
			w.id,
			w.user_id,
			w.amount,
			w.currency_mint,
			w.to_address,
			w.chain,
			(
				SELECT coalesce(sum(re.net_amount), 0)::bigint
				FROM agent_revenue_events re
				JOIN agent_identities ai ON ai.id = re.agent_id
				WHERE ai.user_id = w.user_id AND re.currency_mint = w.currency_mint
			) -
			(
				SELECT coalesce(sum(w2.amount), 0)::bigint
				FROM agent_withdrawals w2
				WHERE w2.user_id = w.user_id
				  AND w2.id != w.id
				  AND w2.status IN ('pending', 'processing', 'completed')
				  AND w2.currency_mint = w.currency_mint
			) AS available
		FROM agent_withdrawals w
		WHERE w.status = 'pending' AND w.chain = ANY(${supportedChains})
		ORDER BY w.created_at ASC
		LIMIT ${WITHDRAWALS_BATCH}
	`;

	const report = { processed: 0, completed: 0, failed: 0, skipped: 0, errors: [] };

	for (const w of pending) {
		report.processed++;
		const available = Number(w.available ?? 0);

		// Skip if user doesn't have enough available balance
		if (w.amount > available) {
			await sql`
				UPDATE agent_withdrawals
				SET status = 'failed',
				    error_message = 'Insufficient referral balance at processing time',
				    updated_at = now()
				WHERE id = ${w.id}
			`;
			insertNotification(w.user_id, 'withdrawal_failed', {
				withdrawal_id: w.id,
				amount: w.amount,
				currency_mint: w.currency_mint,
				reason: 'insufficient_balance',
			});
			report.failed++;
			report.errors.push({ id: w.id, error: 'insufficient_balance' });
			continue;
		}

		// Mark as processing atomically — only if still pending
		const [claimed] = await sql`
			UPDATE agent_withdrawals
			SET status = 'processing', updated_at = now()
			WHERE id = ${w.id} AND status = 'pending'
			RETURNING id
		`;
		if (!claimed) {
			report.skipped++;
			continue;
		}

		try {
			let sig;
			if (w.chain === 'solana') {
				if (!treasuryKeypair) {
					throw new Error('TREASURY_KEYPAIR not configured for solana withdrawal');
				}
				sig = await transferSolanaUSDC({
					fromWallet: treasuryKeypair,
					toAddress: w.to_address,
					amount: BigInt(w.amount),
					mint: w.currency_mint,
				});
			} else {
				// EVM dispatch — resolve the chain name/id to a viem chain ID,
				// then send the real USDC transfer.
				const chainId = resolveEvmChainId(w.chain);
				if (!chainId) {
					throw new Error(`unsupported chain for withdrawal: ${w.chain}`);
				}
				const result = await sendEvmUsdc({
					chainId,
					recipient: w.to_address,
					amount: BigInt(w.amount),
				});
				sig = result.hash;
			}

			await sql`
				UPDATE agent_withdrawals
				SET status = 'completed', tx_signature = ${sig}, updated_at = now()
				WHERE id = ${w.id}
			`;

			// Deduct from referral_earnings_total (best-effort; earnings are tracked via revenue_events)
			await sql`
				UPDATE users
				SET referral_earnings_total = greatest(0, coalesce(referral_earnings_total, 0) - ${w.amount})
				WHERE id = ${w.user_id}
			`.catch((e) => console.error('[process-withdrawals] referral deduct failed:', e.message));

			insertNotification(w.user_id, 'withdrawal_completed', {
				withdrawal_id: w.id,
				amount: w.amount,
				currency_mint: w.currency_mint,
				chain: w.chain,
				tx_signature: sig,
			});

			report.completed++;
		} catch (err) {
			const msg = err.message || String(err);
			await sql`
				UPDATE agent_withdrawals
				SET status = 'failed', error_message = ${msg}, updated_at = now()
				WHERE id = ${w.id}
			`;
			insertNotification(w.user_id, 'withdrawal_failed', {
				withdrawal_id: w.id,
				amount: w.amount,
				currency_mint: w.currency_mint,
				reason: msg,
			});
			report.failed++;
			report.errors.push({ id: w.id, error: msg });
		}
	}

	return json(res, 200, { ok: true, ...report });
}

// ═══════════════════════════════════════════════════════════════════════════
// run-x-scheduled-posts
//
// Publishes due rows from x_scheduled_posts. Terminal errors (quota, dedup,
// not connected, reauth) are recorded once; transient errors retry up to 3x.
// ═══════════════════════════════════════════════════════════════════════════

async function handleRunXScheduledPosts(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	const auth = req.headers['authorization'] || '';
	const expected = env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : null;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && (!expected || auth !== expected)) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	const { publishTweet, XPostError } = await import('../_lib/x-post.js');

	const due = await sql`
		select id, user_id, agent_id, text, thread_parts, reply_to_tweet_id, attempts
		from x_scheduled_posts
		where posted_at is null and error is null
		  and scheduled_at <= now()
		order by scheduled_at asc
		limit 50
	`;

	const report = { processed: 0, posted: 0, errored: 0 };
	const TERMINAL = new Set(['quota_exceeded', 'duplicate', 'not_connected', 'validation_error', 'reauth_required']);

	for (const row of due) {
		report.processed++;
		try {
			const result = await publishTweet({
				userId: row.user_id,
				agentId: row.agent_id,
				text: row.thread_parts ? null : row.text,
				threadParts: Array.isArray(row.thread_parts) ? row.thread_parts : null,
				replyTo: row.reply_to_tweet_id || null,
				appendLink: Boolean(row.agent_id),
			});
			await sql`
				update x_scheduled_posts
				set posted_at = now(), tweet_id = ${result.tweet_id}, attempts = attempts + 1
				where id = ${row.id}
			`;
			report.posted++;
		} catch (err) {
			report.errored++;
			const code = err instanceof XPostError ? err.code : 'internal_error';
			const terminal = TERMINAL.has(code) || row.attempts >= 2;
			await sql`
				update x_scheduled_posts
				set attempts = attempts + 1,
				    error = ${terminal ? `${code}: ${err.message}`.slice(0, 500) : null}
				where id = ${row.id}
			`;
		}
	}

	return json(res, 200, report);
}

// ═══════════════════════════════════════════════════════════════════════════
// run-x-triggers
//
// Evaluates enabled rows in x_triggers. Each kind has its own predicate;
// when it fires, we draft post text (LLM for personas, formatted for
// milestones) and insert into x_scheduled_posts with scheduled_at=now().
// The run-x-scheduled-posts cron picks it up on the next tick.
// ═══════════════════════════════════════════════════════════════════════════

const TRIGGER_BUDGET_MS = 60_000;
const SOL_USD_FALLBACK = 150;

async function handleRunXTriggers(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	const auth = req.headers['authorization'] || '';
	const expected = env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : null;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && (!expected || auth !== expected)) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	const started = Date.now();
	let rows;
	try {
		rows = await sql`
			select id, user_id, agent_id, kind, config, auto_publish, last_fired_at, last_state
			from x_triggers
			where enabled = true
			order by coalesce(last_fired_at, '1970-01-01'::timestamptz) asc
			limit 200
		`;
	} catch (err) {
		if (err.code === '42703') {
			rows = await sql`
				select id, user_id, null::uuid as agent_id, kind, config,
				       coalesce(auto_publish, false) as auto_publish,
				       last_fired_at,
				       null::jsonb as last_state
				from x_triggers
				where enabled = true
				order by coalesce(last_fired_at, '1970-01-01'::timestamptz) asc
				limit 200
			`;
		} else {
			throw err;
		}
	}

	const report = { evaluated: 0, fired: 0, skipped: 0, errors: 0 };
	for (const t of rows) {
		if (Date.now() - started > TRIGGER_BUDGET_MS) break;
		report.evaluated++;
		try {
			const fired = await evalTrigger(t);
			if (fired) report.fired++;
			else report.skipped++;
		} catch (err) {
			report.errors++;
			console.error('[run-x-triggers] error', t.id, t.kind, err.message);
		}
	}
	return json(res, 200, report);
}

async function evalTrigger(t) {
	if (t.kind === 'daily_persona')    return await evalDailyPersona(t);
	if (t.kind === 'weekly_digest')    return await evalWeeklyDigest(t);
	if (t.kind === 'price_milestone')  return await evalPriceMilestone(t);
	if (t.kind === 'payment_received') return await evalPaymentReceived(t);
	return false;
}

function utcHour(d) { return d.getUTCHours(); }
function utcDay(d)  { return d.getUTCDay(); }
function ymdUTC(d)  { return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`; }

// Either enqueue for immediate publish (auto_publish=true) or stash in the
// pending-review queue for the user to approve (auto_publish=false).
async function enqueueTriggerPost(t, text) {
	if (t.auto_publish === false) {
		try {
			await sql`
				insert into x_pending_reviews (user_id, trigger_id, agent_id, text)
				values (${t.user_id}, ${t.id}, ${t.agent_id}, ${text})
			`;
		} catch (err) {
			if (err.code !== '42703') throw err;
			// agent_id column not yet present — insert without it
			await sql`
				insert into x_pending_reviews (user_id, trigger_id, text)
				values (${t.user_id}, ${t.id}, ${text})
			`;
		}
		return;
	}
	try {
		await sql`
			insert into x_scheduled_posts (user_id, agent_id, text, scheduled_at)
			values (${t.user_id}, ${t.agent_id}, ${text}, now())
		`;
	} catch (err) {
		if (err.code !== '42703') throw err;
		await sql`
			insert into x_scheduled_posts (user_id, text, scheduled_at)
			values (${t.user_id}, ${text}, now())
		`;
	}
}

async function setTriggerState(t, state) {
	await sql`update x_triggers set last_state = ${JSON.stringify(state)}::jsonb, last_fired_at = now() where id = ${t.id}`;
}

async function loadAvatarFromAgent(agentId) {
	if (!agentId) return null;
	// avatars has no direct agent_id column — the link is agent_identities.avatar_id.
	// Look up the avatar by joining through agent_identities, or fall back to the
	// case where the caller passes an avatar id directly (legacy behavior).
	const r = await sql`
		select a.id, a.name, a.description, ai.id as agent_id
		from avatars a
		left join agent_identities ai on ai.avatar_id = a.id
		where a.id::text = ${agentId} OR ai.id::text = ${agentId}
		limit 1
	`;
	return r[0] || null;
}

const DRAFT_SYSTEM = `You write tweets for AI agents on three.ws. Tweets must be:
- Under 280 characters (hard limit).
- In the agent's voice (first person, matching the description).
- No hashtag spam. At most 1 hashtag.
- No leading/trailing quotes. Plain text only.
- Avoid em-dashes.
Output ONLY the tweet text, nothing else.`;

async function llmDraft({ system, user, max = 200 }) {
	const r = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'anthropic-version': '2023-06-01',
			'x-api-key': env.ANTHROPIC_API_KEY,
		},
		body: JSON.stringify({
			model: 'claude-haiku-4-5-20251001',
			max_tokens: max,
			system,
			messages: [{ role: 'user', content: user }],
		}),
	});
	if (!r.ok) throw new Error(`llm failed: ${await r.text()}`);
	const data = await r.json();
	let text = (data.content?.[0]?.text || '').trim();
	if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1).trim();
	if (text.length > 280) text = text.slice(0, 279) + '…';
	return text;
}

async function evalDailyPersona(t) {
	const now = new Date();
	if (utcHour(now) !== Number(t.config.hour_utc)) return false;
	const today = ymdUTC(now);
	if (t.last_state?.fired_ymd === today) return false;

	const avatar = await loadAvatarFromAgent(t.agent_id);
	const ctx = avatar
		? `Agent name: ${avatar.name || 'Unnamed'}\nAgent description: ${avatar.description || '(none)'}`
		: '';
	const topic = t.config.topic ? `Topic for today: ${t.config.topic}` : 'Write something engaging and in-character about being an autonomous AI agent today.';
	const text = await llmDraft({ system: DRAFT_SYSTEM, user: [ctx, topic].filter(Boolean).join('\n\n') });
	await enqueueTriggerPost(t, text);
	await setTriggerState(t, { fired_ymd: today });
	return true;
}

async function evalWeeklyDigest(t) {
	const now = new Date();
	if (utcDay(now) !== Number(t.config.day_of_week) || utcHour(now) !== Number(t.config.hour_utc)) return false;
	const week = `${now.getUTCFullYear()}-W${Math.floor((now.getUTCDate()+6)/7)}`;
	if (t.last_state?.fired_week === week) return false;

	const avatar = await loadAvatarFromAgent(t.agent_id);
	const mint = avatar ? (await sql`
		select m.symbol, m.name, s.recent_tx_count
		from pump_agent_mints m left join pump_agent_stats s on s.mint_id = m.id
		where m.agent_id::text = ${avatar.agent_id ?? null} or m.agent_id::text = ${avatar.id}
		order by m.created_at desc limit 1
	`)[0] : null;

	const ctx = avatar ? `Agent name: ${avatar.name || 'Unnamed'}\nDescription: ${avatar.description || '(none)'}` : '';
	const stats = mint ? `\nToken: $${mint.symbol || 'TOKEN'} on pump.fun. Recent transactions: ${mint.recent_tx_count || 0}.` : '';
	const text = await llmDraft({
		system: DRAFT_SYSTEM,
		user: `${ctx}${stats}\n\nWrite a weekly recap tweet covering the agent's progress this week. If token stats are present, mention them naturally.`,
	});
	await enqueueTriggerPost(t, text);
	await setTriggerState(t, { fired_week: week });
	return true;
}

async function evalPriceMilestone(t) {
	const thresholds = (t.config.thresholds_usd || []).slice().sort((a, b) => a - b);
	if (!thresholds.length) return false;
	const avatar = await loadAvatarFromAgent(t.agent_id);
	if (!avatar) return false;
	const mintRow = (await sql`
		select m.id as mint_id, m.symbol, p.market_cap_lamports
		from pump_agent_mints m
		left join lateral (
			select market_cap_lamports from pump_agent_price_points
			where mint_id = m.id order by ts desc limit 1
		) p on true
		where m.agent_id::text = ${avatar.agent_id ?? null} or m.agent_id::text = ${avatar.id}
		order by m.created_at desc limit 1
	`)[0];
	if (!mintRow || !mintRow.market_cap_lamports) return false;

	const solUsd = Number(t.config.sol_usd) || SOL_USD_FALLBACK;
	const mcapUsd = (Number(mintRow.market_cap_lamports) / 1e9) * solUsd;
	const lastFired = Number(t.last_state?.last_threshold_fired_usd || 0);
	const nextThreshold = thresholds.find((th) => mcapUsd >= th && th > lastFired);
	if (!nextThreshold) return false;

	const text = await llmDraft({
		system: DRAFT_SYSTEM,
		user: `Agent name: ${avatar.name || 'Unnamed'}\nDescription: ${avatar.description || '(none)'}\nToken: $${mintRow.symbol || 'TOKEN'} on pump.fun.\nMilestone: market cap just crossed $${nextThreshold.toLocaleString()} (now ≈ $${Math.round(mcapUsd).toLocaleString()}).\n\nWrite a tweet celebrating this milestone in the agent's voice.`,
	});
	await enqueueTriggerPost(t, text);
	await setTriggerState(t, { last_threshold_fired_usd: nextThreshold, mcap_usd: mcapUsd });
	return true;
}

async function evalPaymentReceived(t) {
	const avatar = await loadAvatarFromAgent(t.agent_id);
	if (!avatar) return false;
	const since = t.last_state?.last_payment_id ?? '00000000-0000-0000-0000-000000000000';
	const minUsd = Number(t.config.min_amount_usd || 0);

	const payments = await sql`
		select p.id, p.amount_atomics, p.currency_mint, p.skill_id, p.tool_name, m.symbol
		from pump_agent_payments p
		join pump_agent_mints m on m.id = p.mint_id
		where (m.agent_id::text = ${avatar.agent_id ?? null} or m.agent_id::text = ${avatar.id})
		  and p.status = 'confirmed'
		  and p.id::text > ${since}
		order by p.confirmed_at asc
		limit 3
	`;
	if (!payments.length) return false;

	let lastId = null;
	for (const p of payments) {
		const approxUsd = Number(p.amount_atomics) / 1e6;
		if (approxUsd < minUsd) { lastId = p.id; continue; }
		const label = p.tool_name ? `for "${p.tool_name}"` : (p.skill_id ? `for skill ${p.skill_id}` : 'for a paid action');
		const text = await llmDraft({
			system: DRAFT_SYSTEM,
			user: `Agent name: ${avatar.name || 'Unnamed'}\nDescription: ${avatar.description || '(none)'}\nA user just paid ~$${approxUsd.toFixed(2)} ${label}.\n\nWrite a short thank-you tweet in the agent's voice.`,
		});
		await enqueueTriggerPost(t, text);
		lastId = p.id;
	}
	if (lastId) await setTriggerState(t, { last_payment_id: lastId });
	return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// fetch-x-metrics
//
// Pulls public_metrics (likes, retweets, replies, impressions) for posts
// older than ~1h and not refreshed in last 6h. Stored on x_posts.metrics.
// ═══════════════════════════════════════════════════════════════════════════

async function handleFetchXMetrics(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	const auth = req.headers['authorization'] || '';
	const expected = env.CRON_SECRET ? `Bearer ${env.CRON_SECRET}` : null;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && (!expected || auth !== expected)) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	const { decryptToken } = await import('../auth/x/[action].js');

	// Pick distinct users with posts needing refresh.
	const users = await sql`
		select distinct user_id
		from x_posts
		where created_at < now() - interval '1 hour'
		  and (metrics_fetched_at is null or metrics_fetched_at < now() - interval '6 hours')
		limit 50
	`;

	const report = { users: 0, fetched: 0, errors: 0 };
	for (const u of users) {
		report.users++;
		const conn = (await sql`
			select access_token, expires_at, refresh_token, id
			from social_connections
			where user_id = ${u.user_id} and provider = 'x' and disconnected_at is null
			limit 1
		`)[0];
		if (!conn || !conn.access_token) continue;
		let accessToken;
		try { accessToken = decryptToken(conn.access_token); } catch { continue; }

		const posts = await sql`
			select id, tweet_id from x_posts
			where user_id = ${u.user_id}
			  and created_at < now() - interval '1 hour'
			  and (metrics_fetched_at is null or metrics_fetched_at < now() - interval '6 hours')
			order by created_at desc
			limit 100
		`;
		if (!posts.length) continue;

		// X allows up to 100 ids per /2/tweets lookup.
		const ids = posts.map((p) => p.tweet_id).join(',');
		const r = await fetch(`https://api.twitter.com/2/tweets?ids=${ids}&tweet.fields=public_metrics`, {
			headers: { authorization: `Bearer ${accessToken}` },
		});
		if (!r.ok) { report.errors++; continue; }
		const { data = [] } = await r.json();
		const byId = new Map(data.map((d) => [d.id, d.public_metrics]));

		for (const p of posts) {
			const m = byId.get(p.tweet_id);
			if (!m) continue;
			await sql`
				update x_posts
				set metrics = ${JSON.stringify(m)}::jsonb, metrics_fetched_at = now()
				where id = ${p.id}
			`;
			report.fetched++;
		}
	}

	return json(res, 200, report);
}

// ═══════════════════════════════════════════════════════════════════════════
// run-coin-cycle
// ═══════════════════════════════════════════════════════════════════════════
//
// One unified pass over every active coin_launches row:
//   1. refresh holder snapshot via Helius RPC
//   2. claim creator-vault SOL from pump.fun and split into pots
//   3. commit the next lottery draw (one per draw_interval_seconds)
//   4. resolve any committed draws whose Drand round has been published
//   5. allocate the reflection pot pro-rata to eligible holders
//
// Payouts (SOL transfers) are NOT done here — see run-coin-payouts which
// drains the coin_payouts queue. Splitting these two crons means a slow
// or stuck payout tx can't block the next cycle from being committed.
//
// Scheduled every 5 minutes by Vercel. Each step is idempotent — running
// twice within the same draw/reflection bucket is a no-op.

async function handleRunCoinCycle(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = req.headers['authorization'] || '';
	const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && (!expected || auth !== expected)) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	// Demo gate: cron is wired in vercel.json but stays a no-op until the
	// operator opts in by setting COIN_DEMO_ENABLED=true in env. Until then
	// neither Vercel cron nor a manual call can touch any coin_launches row.
	if (process.env.COIN_DEMO_ENABLED !== 'true') {
		return json(res, 200, { ok: true, disabled: true, hint: 'set COIN_DEMO_ENABLED=true to enable' });
	}

	const coinLib = await import('../_lib/coin/index.js');
	const coins = await coinLib.listActiveCoins();

	const phaseFilter = (req.query?.phase || '').toString();
	const onlyPhase = phaseFilter
		? new Set(phaseFilter.split(',').map((s) => s.trim()).filter(Boolean))
		: null;
	const wantPhase = (name) => !onlyPhase || onlyPhase.has(name);

	const report = { coins: [], errors: [] };

	for (const coin of coins) {
		const result = { mint: coin.mint, symbol: coin.symbol, steps: {} };
		try {
			if (wantPhase('snapshot')) {
				result.steps.snapshot = await coinLib.snapshotHolders(coin);
			}
		} catch (err) {
			result.steps.snapshot = { error: err.message || String(err) };
			report.errors.push({ mint: coin.mint, step: 'snapshot', error: result.steps.snapshot.error });
		}

		// Refresh row after snapshot so we have current last_snapshot_at.
		const refreshed1 = await coinLib.loadCoinById(coin.id);
		const c1 = refreshed1 || coin;

		try {
			if (wantPhase('claim')) {
				result.steps.claim = await coinLib.claimAndSplit(c1);
			}
		} catch (err) {
			result.steps.claim = { error: err.message || String(err) };
			report.errors.push({ mint: coin.mint, step: 'claim', error: result.steps.claim.error });
		}

		const refreshed2 = await coinLib.loadCoinById(coin.id);
		const c2 = refreshed2 || c1;

		try {
			if (wantPhase('commit')) {
				result.steps.commit_lottery = await coinLib.commitLottery(c2);
			}
		} catch (err) {
			result.steps.commit_lottery = { error: err.message || String(err) };
			report.errors.push({ mint: coin.mint, step: 'commit_lottery', error: result.steps.commit_lottery.error });
		}

		try {
			if (wantPhase('resolve')) {
				result.steps.resolve_lottery = await coinLib.resolvePendingDraws(c2);
			}
		} catch (err) {
			result.steps.resolve_lottery = { error: err.message || String(err) };
			report.errors.push({ mint: coin.mint, step: 'resolve_lottery', error: result.steps.resolve_lottery.error });
		}

		const refreshed3 = await coinLib.loadCoinById(coin.id);
		const c3 = refreshed3 || c2;

		try {
			if (wantPhase('reflection')) {
				result.steps.reflection = await coinLib.allocateReflection(c3);
			}
		} catch (err) {
			result.steps.reflection = { error: err.message || String(err) };
			report.errors.push({ mint: coin.mint, step: 'reflection', error: result.steps.reflection.error });
		}

		report.coins.push(result);
	}

	return json(res, 200, { ok: true, processed: report.coins.length, report });
}

// ═══════════════════════════════════════════════════════════════════════════
// run-coin-payouts
// ═══════════════════════════════════════════════════════════════════════════
//
// Drains pending coin_payouts rows for every active coin. Each row already has
// a committed amount + recipient (queued by run-coin-cycle); this cron just
// signs + submits the batched SystemProgram.transfer txs.
//
// Runs on a separate schedule from run-coin-cycle so RPC issues on the
// payout side never block fresh draws/reflection from being committed.

async function handleRunCoinPayouts(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = req.headers['authorization'] || '';
	const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && (!expected || auth !== expected)) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	// Demo gate — see handleRunCoinCycle. Until COIN_DEMO_ENABLED=true is set,
	// the payout drainer cannot fire even if rows are pending.
	if (process.env.COIN_DEMO_ENABLED !== 'true') {
		return json(res, 200, { ok: true, disabled: true, hint: 'set COIN_DEMO_ENABLED=true to enable' });
	}

	const coinLib = await import('../_lib/coin/index.js');
	const coins = await coinLib.listActiveCoins();

	const report = { coins: [], errors: [] };
	for (const coin of coins) {
		try {
			const result = await coinLib.drainPendingPayouts(coin);
			report.coins.push({ mint: coin.mint, ...result });
		} catch (err) {
			report.errors.push({ mint: coin.mint, error: err.message || String(err) });
		}
	}

	return json(res, 200, { ok: true, processed: report.coins.length, report });
}

// ═══════════════════════════════════════════════════════════════════════════
// club-payouts — sweep unpaid Pole Club tips to each dancer's wallet
// ═══════════════════════════════════════════════════════════════════════════

async function handleClubPayouts(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = req.headers['authorization'] || '';
	const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && (!expected || auth !== expected)) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	const { runClubPayoutSweep, expireStaleClaims } = await import('../_lib/club/sweep.js');

	// Pre-pass: any PENDING-* claim older than 10min came from a crashed
	// earlier invocation. Release them so this cycle can retry.
	try {
		await expireStaleClaims();
	} catch (err) {
		console.error('[club-payouts] expireStaleClaims failed', err);
	}

	const summary = await runClubPayoutSweep();
	return json(res, 200, { ok: true, ...summary });
}

// ═══════════════════════════════════════════════════════════════════════════
// unstoppable-tick — autonomous agent lifecycle (sense → think → act → settle)
// ═══════════════════════════════════════════════════════════════════════════

async function handleUnstoppableTick(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const auth = req.headers['authorization'] || '';
	const expected = process.env.CRON_SECRET ? `Bearer ${process.env.CRON_SECRET}` : null;
	const fromCron = req.headers['x-vercel-cron'] === '1';
	if (!fromCron && (!expected || auth !== expected)) {
		return error(res, 401, 'unauthorized', 'cron secret required');
	}

	try {
		const { tick } = await import('../../agents/unstoppable/src/loop.js');
		const result = await tick();
		return json(res, 200, { ok: true, ...result });
	} catch (err) {
		console.error('[unstoppable-tick]', err?.message || err);
		return json(res, 200, { ok: false, error: err?.message || 'tick failed' });
	}
}
