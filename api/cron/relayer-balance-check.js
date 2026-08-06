// @ts-check
// GET /api/cron/relayer-balance-check — Solana signer low-balance watchdog.
//
// Every Solana fee-paying signer (the pump buyback/distribute relayer, the SNS
// parent owner, the x402 launcher, the coin/club treasuries, …) pays real SOL
// for fees and rent. If one silently runs dry, its flow stops working with no
// error anyone sees — buybacks stop confirming, subdomain mints 502, withdrawals
// stall. This cron checks each configured signer's mainnet SOL balance against
// the documented minimum in api/_lib/solana-signers.js and fires a Telegram ops
// alert the moment one drops below it, so signers never silently run dry.
//
// Runs every 6 hours — slow on purpose. It only reads on-chain balances (one
// getBalance RPC per configured signer) and touches the Redis-backed alert
// dedup, so it adds negligible load and cannot burn the Upstash request quota.
//
// Env (reuses existing infra; no new secrets):
//   CRON_SECRET             — Vercel cron bearer auth (shared with other crons)
//   TELEGRAM_BOT_TOKEN      — ops alert bot (via sendOpsAlert)
//   TELEGRAM_ALERTS_CHAT_ID — private ops channel (via sendOpsAlert)
//   SOLANA_RPC_URL          — mainnet RPC (defaults to api.mainnet-beta)
// Signer secrets themselves are optional: an unconfigured signer is skipped, not
// flagged — only configured-but-underfunded signers alert.

import { error, json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { sendOpsAlert } from '../_lib/alerts.js';
import { SOLANA_SIGNERS, resolveSignerPubkey } from '../_lib/solana-signers.js';
import { requireCron } from '../_lib/cron-auth.js';

const LAMPORTS_PER_SOL = 1_000_000_000;

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const rpcUrl = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
	const { PublicKey } = await import('@solana/web3.js');
	const { solanaConnection } = await import('../_lib/solana/connection.js');
	// Use the failover Connection rather than a raw one: a bare Connection on the
	// keyless public endpoint 429s under shared load and triggers web3.js's
	// internal "Server responded with 429 … Retrying after 500ms" backoff loop
	// (visible in the logs as repeated retries on this 6-hourly cron). The
	// failover Connection rotates the public endpoint → Ankr → keyed providers and
	// fails fast instead of retry-looping a rate-limited lane.
	const connection = solanaConnection({ url: rpcUrl, network: 'mainnet', commitment: 'confirmed' });

	const checked = [];
	const low = [];
	const errors = [];

	for (const spec of SOLANA_SIGNERS) {
		const resolved = await resolveSignerPubkey(spec);
		if (!resolved.configured) {
			checked.push({ name: spec.name, status: 'unconfigured' });
			continue;
		}
		if (resolved.decodeError || !resolved.pubkey) {
			errors.push({ name: spec.name, env: spec.env, reason: 'secret_decode_failed' });
			continue;
		}

		let lamports;
		try {
			lamports = await connection.getBalance(new PublicKey(resolved.pubkey), 'confirmed');
		} catch (e) {
			errors.push({ name: spec.name, pubkey: resolved.pubkey, reason: `rpc_error: ${e.message}` });
			continue;
		}

		const sol = lamports / LAMPORTS_PER_SOL;
		const entry = {
			name: spec.name,
			pubkey: resolved.pubkey,
			sol: Number(sol.toFixed(6)),
			minSol: spec.minSol,
			ok: sol >= spec.minSol,
		};
		checked.push(entry);
		if (!entry.ok) low.push({ ...entry, purpose: spec.purpose });
	}

	// One alert per underfunded signer (deduped hourly by pubkey, so a chronically
	// low signer pings once an hour, not on every run). A decode/RPC failure also
	// alerts — a signer we can't even read is itself an outage.
	for (const s of low) {
		await sendOpsAlert(
			`⛽ Solana signer low: ${s.name} ${s.sol} < ${s.minSol} SOL`,
			`${s.purpose}\npubkey: ${s.pubkey}\nFund it on mainnet, then this clears within 6h.`,
			{ signature: `relayer-low:${s.pubkey}` },
		);
	}
	for (const e of errors) {
		await sendOpsAlert(
			`⛽ Solana signer unreadable: ${e.name}`,
			`reason: ${e.reason}${e.pubkey ? `\npubkey: ${e.pubkey}` : `\nenv: ${e.env}`}`,
			{ signature: `relayer-err:${e.name}` },
		);
	}

	return json(res, 200, {
		ok: true,
		rpc: rpcUrl,
		checked,
		low_count: low.length,
		error_count: errors.length,
	});
});
