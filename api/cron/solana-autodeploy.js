// @ts-check
// GET/POST /api/cron/solana-autodeploy — autonomous Solana on-chain deployment.
//
// Mints every undeployed three.ws agent as a real Metaplex Core asset inside the
// "three.ws Agents" collection and enrols it in the Metaplex Agent Registry — the
// same server-custodial path as the admin bulk-launch / register-agents tools,
// but on a schedule with no human in the loop. The collection authority signs and
// pays the ~0.004 SOL mint; agent owners never sign and need no SOL (the owner of
// a Core asset does not sign the mint). This is what makes on-chain agent identity
// happen continuously instead of one manual admin run at a time.
//
// Two phases per tick, sharing one funded-authority balance gate and time budget:
//   1. mint     — fetchUndeployedAgents → deployAgentOnce (mints AND auto-enrols
//                 the freshly minted asset in the registry as its post-mint step).
//   2. register — fetchUnregisteredAgents → registerAgentOnce, back-filling any
//                 agent minted earlier whose registry enrolment didn't land.
//
// Gated, by design, so it never spends real mainnet SOL until ops opts in:
//   • SOLANA_AUTODEPLOY_ENABLED=true            — the go-live switch.
//   • SOLANA_AGENT_COLLECTION_AUTHORITY_KEY     — the funded authority (already
//     used by bulk-launch). With either absent it 200s as a no-op with a reason.
// A balance floor and small per-tick batches bound spend; one agent's failure is
// recorded and the run continues — never a partial sweep that strands the rest.
//
// Reuses api/_lib/onchain-deploy.js verbatim (shared with the admin endpoints and
// the CLI runners) so every path mints byte-identical assets.

import { LAMPORTS_PER_SOL } from '@solana/web3.js';

import { json, method, wrapCron } from '../_lib/http.js';
import { publishFeedEvent } from '../_lib/feed.js';
import {
	authoritySecret,
	buildAuthorityUmi,
	funderLamports,
	fetchUndeployedAgents,
	fetchUnregisteredAgents,
	resolveAgentCollection,
	loadCollectionAsset,
	deployAgentOnce,
	registerAgentOnce,
	explorerUrl,
	EST_MINT_LAMPORTS,
	EST_REGISTER_LAMPORTS,
} from '../_lib/onchain-deploy.js';
import { requireCron } from '../_lib/cron-auth.js';

// Per-tick caps. Each mint is ~0.004 SOL + one tx; at a 10-min cadence this lands
// hundreds of agents/day without any run going long or draining the authority
// faster than it can be topped up.
const MINT_BATCH = Number.parseInt(process.env.SOLANA_AUTODEPLOY_MINT_BATCH || '8', 10);
const REGISTER_BATCH = Number.parseInt(process.env.SOLANA_AUTODEPLOY_REGISTER_BATCH || '12', 10);

// Stop before Vercel's 300s kill; each agent is a pin + 1-2 confirmed txs.
const BUDGET_MS = 110_000;

// ~2 ops/sec — stay well within RPC rate limits, matching the admin runners.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	if (process.env.SOLANA_AUTODEPLOY_ENABLED !== 'true') {
		return json(res, 200, {
			ok: true,
			deployed: 0,
			registered: 0,
			reason: 'autodeploy disabled',
		});
	}
	if (!authoritySecret()) {
		return json(res, 200, {
			ok: true,
			deployed: 0,
			registered: 0,
			reason: 'SOLANA_AGENT_COLLECTION_AUTHORITY_KEY unset',
		});
	}

	const network = process.env.SOLANA_AUTODEPLOY_NETWORK === 'devnet' ? 'devnet' : 'mainnet';
	const started = Date.now();
	const budgetLeft = () => Date.now() - started < BUDGET_MS;

	let umi, authoritySigner;
	try {
		({ umi, authoritySigner } = buildAuthorityUmi(network));
	} catch (e) {
		return json(res, 200, { ok: false, error: `config: ${e.message}` });
	}
	const authorityPk = authoritySigner.publicKey;

	// Refuse to start if the authority can't comfortably cover at least one
	// mint+register — better to skip cleanly than strand an agent mid-flow.
	const FLOOR = EST_MINT_LAMPORTS + EST_REGISTER_LAMPORTS + 10_000;
	const startBalance = await funderLamports(umi, authorityPk);
	if (startBalance < FLOOR) {
		console.warn(
			`[solana-autodeploy] authority ${authorityPk} low: ${startBalance / LAMPORTS_PER_SOL} SOL`,
		);
		return json(res, 200, {
			ok: true,
			deployed: 0,
			registered: 0,
			reason: 'authority below SOL floor',
			authority: authorityPk.toString(),
			authority_balance_sol: startBalance / LAMPORTS_PER_SOL,
		});
	}

	const deployed = [];
	const registered = [];
	const failed = [];

	try {
		// ── Phase 1: mint undeployed agents (deployAgentOnce auto-enrols them). ──
		const toMint = await fetchUndeployedAgents(network, MINT_BATCH);
		if (toMint.length && budgetLeft()) {
			const collectionAddr = await resolveAgentCollection({ umi, authoritySigner, network });
			const collectionAsset = await loadCollectionAsset(umi, collectionAddr);

			for (const agent of toMint) {
				if (!budgetLeft()) break;
				if ((await funderLamports(umi, authorityPk)) < FLOOR) break;
				try {
					const r = await deployAgentOnce({
						umi,
						authoritySigner,
						collectionAddr,
						collectionAsset,
						agent,
						network,
					});
					deployed.push({
						id: agent.id,
						name: agent.name,
						asset: r.asset,
						tx: r.signature,
					});
					console.log(
						`[solana-autodeploy] minted ${agent.name} → ${r.asset} (${r.signature})`,
					);
					publishFeedEvent({
						type: 'agent-onchain',
						ts: Date.now(),
						actor: agent.name || 'An agent',
						agentId: agent.id,
						name: agent.name || 'An agent',
						chain: 'Solana',
						asset: r.asset,
						txUrl: explorerUrl(r.asset, network),
						autonomous: true,
					}).catch(() => {});
				} catch (err) {
					failed.push({
						id: agent.id,
						phase: 'mint',
						error: err?.message || String(err),
					});
					console.error(
						`[solana-autodeploy] mint ${agent.id} failed:`,
						err?.message || err,
					);
				}
				await sleep(400);
			}
		}

		// ── Phase 2: back-fill registry for minted-but-unregistered agents. ──
		if (budgetLeft()) {
			const toRegister = await fetchUnregisteredAgents(network, REGISTER_BATCH);
			for (const agent of toRegister) {
				if (!budgetLeft()) break;
				if ((await funderLamports(umi, authorityPk)) < EST_REGISTER_LAMPORTS + 5000) break;
				try {
					const r = await registerAgentOnce({ umi, authoritySigner, agent, network });
					if (!r.alreadyRegistered) {
						registered.push({
							id: agent.id,
							name: agent.name,
							identity_pda: r.identityPda,
						});
						console.log(
							`[solana-autodeploy] registered ${agent.name} → ${r.identityPda}`,
						);
					}
				} catch (err) {
					failed.push({
						id: agent.id,
						phase: 'register',
						error: err?.message || String(err),
					});
					console.error(
						`[solana-autodeploy] register ${agent.id} failed:`,
						err?.message || err,
					);
				}
				await sleep(400);
			}
		}
	} catch (err) {
		// Never throw: a failed run leaves all prior on-chain state intact.
		console.error('[solana-autodeploy] run failed:', err?.message || err);
		return json(res, 200, {
			ok: false,
			error: err?.message || String(err),
			deployed: deployed.length,
			registered: registered.length,
		});
	}

	return json(res, 200, {
		ok: true,
		network,
		deployed: deployed.length,
		registered: registered.length,
		failed: failed.length,
		authority: authorityPk.toString(),
		deployments: deployed,
		registrations: registered,
		failures: failed,
		elapsed_ms: Date.now() - started,
	});
});
