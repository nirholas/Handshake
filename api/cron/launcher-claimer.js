// @ts-check
// GET/POST /api/cron/launcher-claimer — auto-claim pump.fun creator fees from global
// launcher runs. Fires every 5 minutes via Vercel cron. For each minted coin in
// launcher_runs that has accumulated >= CLAIM_THRESHOLD_SOL in creator fees and hasn't
// been claimed in the last 24 hours:
//   1. Query live fee-info from the platform pump API
//   2. Claim via collect-creator-fee-agent (agent signs its own claim, same as the launch)
//   3. Record in launcher_claims (claimed_sol, buyback_sol earmarked, claim_sig)
//
// This closes the creator-fee loop: launch → creator fees accrue → claim → record.
// buyback_sol records the buyback-earmarked share of those CREATOR fees (the run's
// buyback_bps) for revenue tracking — it is NOT a transfer made here. The on-chain
// $THREE-aligned buy pressure for these coins comes from the buyback_bps binding baked
// into each launch (handleLaunchAgent → PumpAgent.create), which routes a share of TRADE
// fees into the coin's on-chain buyback vault; the hourly run-buyback cron
// (api/cron/[name].js) then executes the buyback+burn from that vault.
//
// Auth: CRON_SECRET Bearer (same pattern as all cron endpoints).

import { json, error, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { constantTimeEquals } from '../_lib/crypto.js';
import { sql } from '../_lib/db.js';
import { createSession } from '../_lib/auth.js';

const CLAIM_THRESHOLD_SOL = 0.01;
const ORIGIN = env.APP_ORIGIN || 'https://three.ws';
const MAX_PER_TICK = 20;

let _schemaDone = false;
async function ensureSchema() {
	if (_schemaDone) return;
	// Idempotent — launcher-engine.js creates the same table on runLauncherTick().
	// Duplicated here so the claimer works even when the engine hasn't ticked yet.
	await sql`
		create table if not exists launcher_claims (
			id uuid primary key default gen_random_uuid(),
			run_id uuid references launcher_runs(id) on delete set null,
			agent_id uuid,
			mint text not null,
			claimed_lamports bigint not null default 0,
			claimed_sol float8 not null default 0,
			buyback_sol float8 not null default 0,
			buyback_sig text,
			claim_sig text,
			network text not null default 'mainnet',
			scope text not null default 'global',
			created_at timestamptz not null default now()
		)
	`;
	await sql`create index if not exists launcher_claims_run_idx on launcher_claims (run_id, created_at desc)`;
	await sql`create index if not exists launcher_claims_created_idx on launcher_claims (created_at desc)`;
	_schemaDone = true;
}

function requireCron(req, res) {
	const secret = process.env.CRON_SECRET || env.CRON_SECRET;
	if (!secret) { error(res, 503, 'not_configured', 'CRON_SECRET unset'); return false; }
	const auth = req.headers['authorization'] || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
	if (!constantTimeEquals(presented, secret)) { error(res, 401, 'unauthorized', 'invalid cron secret'); return false; }
	return true;
}

// Create a session as an agent's owner, then make a fetch call to an internal API
// path. The agent's owner session is required because collect-creator-fee-agent
// verifies the caller owns the agent.
async function agentFetch(ownerUserId, urlOrPath, opts = {}) {
	const token = await createSession({ userId: ownerUserId, userAgent: 'launcher-claimer', ip: null });
	const url = urlOrPath.startsWith('http') ? urlOrPath : `${ORIGIN}${urlOrPath}`;
	const res = await fetch(url, {
		...opts,
		headers: {
			'user-agent': 'threews-launcher-claimer/1.0',
			...(opts.headers || {}),
			cookie: `__Host-sid=${token}`,
		},
		signal: opts.signal ?? AbortSignal.timeout(15_000),
	}).catch(() => null);
	return res;
}

async function processMint(run) {
	const { id: runId, mint, agent_id: agentId, network, buyback_bps, owner_user_id: userId } = run;

	// 1. Fetch live claimable balance.
	const feeRes = await agentFetch(
		userId,
		`/api/pump/fee-info?mint=${encodeURIComponent(mint)}&network=${encodeURIComponent(network)}`,
	);
	if (!feeRes || !feeRes.ok) return { runId, status: 'fee-info-failed' };
	const feeInfo = await feeRes.json().catch(() => null);
	if (!feeInfo) return { runId, status: 'fee-info-unparseable' };

	const claimableSol = Number(feeInfo.claimable_lamports ?? 0) / 1e9;
	if (claimableSol < CLAIM_THRESHOLD_SOL) {
		return { runId, status: 'below-threshold', claimableSol };
	}

	// 2. Claim — the agent signs its own fee claim (same identity that created the coin).
	const claimRes = await agentFetch(userId, '/api/pump/collect-creator-fee-agent', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ agentId, mint, network }),
	});
	if (!claimRes || !claimRes.ok) return { runId, status: 'claim-failed' };
	const claimData = await claimRes.json().catch(() => null);
	if (!claimData?.ok) return { runId, status: 'claim-rejected', error: claimData?.error };

	// The endpoint reports the exact lamports the sweep delivered (balance delta).
	// Fall back to the pre-claim claimable figure if the node couldn't be sampled,
	// so the recorded revenue is never silently zeroed (the prior code read a
	// non-existent `lamports`/`sig` field, storing 0 SOL + a null signature on
	// every claim — defeating the revenue rollup and the 24h dedup guard).
	const claimSig = claimData.signature ?? claimData.sig ?? null;
	const claimedLamports = Number(claimData.lamports ?? Math.round(claimableSol * 1e9));
	const claimedSol = claimedLamports / 1e9;
	const buybackBps = Number(buyback_bps ?? 5000);
	// Earmark only: the on-chain $THREE buy pressure for these coins is delivered by the
	// buyback_bps binding baked into the launch (see header), not a transfer made here.
	const buybackSol = Math.round(claimedSol * buybackBps) / 10_000;

	// 3. Record the claim. Multiple claims per run_id are allowed (fees re-accrue).
	await sql`
		insert into launcher_claims
			(run_id, agent_id, mint, claimed_lamports, claimed_sol, buyback_sol, claim_sig, network, scope)
		values (
			${runId}, ${agentId}, ${mint},
			${claimedLamports}, ${claimedSol}, ${buybackSol},
			${claimSig}, ${network}, 'global'
		)
	`;

	return { runId, status: 'claimed', claimedSol, buybackSol, sig: claimSig };
}

async function runClaimerTick() {
	await ensureSchema();

	// Find minted coins that either have never been claimed or whose last successful
	// claim was > 24 hours ago (fees re-accrue after each claim).
	const runs = await sql`
		select lr.id, lr.mint, lr.agent_id, lr.network, lr.buyback_bps,
		       ai.user_id as owner_user_id, ai.name as agent_name
		from launcher_runs lr
		join agent_identities ai on ai.id = lr.agent_id and ai.deleted_at is null
		where lr.mint is not null
		  and lr.status in ('confirmed', 'launched')
		  and ai.user_id is not null
		  and not exists (
		      select 1 from launcher_claims lc
		      where lc.run_id = lr.id
		        and lc.claimed_sol > 0
		        and lc.created_at > now() - interval '24 hours'
		  )
		order by lr.created_at asc
		limit ${MAX_PER_TICK}
	`;

	if (!runs.length) return { checked: 0, claimed: 0, skipped: 0, errors: 0 };

	let claimed = 0, skipped = 0, errors = 0;
	const details = [];

	for (const run of runs) {
		const result = await processMint(run).catch((err) => ({
			runId: run.id, status: 'error', error: err?.message,
		}));
		details.push(result);
		if (result.status === 'claimed') claimed++;
		else if (result.status === 'below-threshold') skipped++;
		else errors++;
	}

	return { checked: runs.length, claimed, skipped, errors };
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;
	const out = await runClaimerTick().catch((err) => ({ ok: false, error: err?.message, checked: 0, claimed: 0 }));
	return json(res, 200, { ok: true, ...out });
});
