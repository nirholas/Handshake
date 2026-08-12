// Durable persistence for metered inference jobs + their signed settlement
// receipts (Roadmap phase 4). Backed by Postgres (Neon), same posture as
// api/_lib/x402/receipt-storage.js: writes are fire-and-forget from the paid
// hot path, so a DB hiccup never 5xxs a response whose payment already
// settled on-chain. The buyer's copy of the receipt travels on the
// X-PAYMENT-RESPONSE header; this table is the operator-side audit trail and
// the dispute-resolution record. Schema:
// api/_lib/migrations/20260812000000_inference_jobs.sql.

import { sql } from './db.js';
import { clampInt } from './http-params.js';

/**
 * Persist one metered, settled inference job. Returns nothing; the caller
 * does not await. Receipt-bearing rows are written once, after settlement.
 *
 * @param {object} args
 * @param {object} args.job      metered job core from meterInferenceJob()
 * @param {object} [args.receipt] signed receipt from issueInferenceReceipt()
 */
export function recordInferenceJob({ job, receipt }) {
	if (!job || typeof job.jobId !== 'string') return;
	const payment = receipt?.payment || {};
	sql`
		insert into inference_jobs (
			job_id, route, network, payer, model, provider,
			prompt_sha256, response_sha256,
			input_tokens, output_tokens, tokens_used, latency_ms,
			response_signature, response_signer,
			amount_atomics, asset, tx_hash, receipt, receipt_signer
		) values (
			${job.jobId}, ${job.route}, ${payment.network || null}, ${payment.payer || null},
			${job.model}, ${job.provider},
			${job.promptSha256}, ${job.responseSha256},
			${job.inputTokens}, ${job.outputTokens}, ${job.tokensUsed},
			${Number.isFinite(job.latencyMs) ? job.latencyMs : null},
			${job.responseSignature}, ${job.responseSigner},
			${payment.amountAtomics ?? null}, ${payment.asset || null},
			${payment.transaction || null},
			${receipt ? JSON.stringify(receipt) : null}::jsonb,
			${receipt?.signer || null}
		)
		on conflict (job_id) do nothing
	`.catch((err) => {
		console.error('[inference-jobs] insert failed:', err?.message || err);
	});
}

/**
 * Read one metered job back by id. Used by the verification surface to let an
 * operator cross-check a receipt against the platform's own record.
 */
export async function getInferenceJob(jobId) {
	if (!jobId || typeof jobId !== 'string') return null;
	const [row] = await sql`
		select job_id, route, network, payer, model, provider,
		       prompt_sha256, response_sha256,
		       input_tokens, output_tokens, tokens_used, latency_ms,
		       response_signature, response_signer,
		       amount_atomics, asset, tx_hash, receipt, receipt_signer, created_at
		from inference_jobs
		where job_id = ${jobId}
		limit 1
	`;
	if (!row) return null;
	return {
		jobId: row.job_id,
		route: row.route,
		network: row.network,
		payer: row.payer,
		model: row.model,
		provider: row.provider,
		promptSha256: row.prompt_sha256,
		responseSha256: row.response_sha256,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		tokensUsed: row.tokens_used,
		latencyMs: row.latency_ms,
		responseSignature: row.response_signature,
		responseSigner: row.response_signer,
		amountAtomics: row.amount_atomics,
		asset: row.asset,
		txHash: row.tx_hash,
		receipt: row.receipt,
		receiptSigner: row.receipt_signer,
		createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
	};
}

/**
 * Recent jobs for an operator dashboard / audit export. Filterable by payer
 * or settlement tx so a dispute resolves in one query.
 */
export async function listInferenceJobs({ payer, txHash, limit } = {}) {
	const clamped = clampInt(limit, { max: 200, fallback: 50 });
	const rows = payer
		? await sql`
			select job_id, route, network, payer, model, provider, tokens_used,
			       amount_atomics, asset, tx_hash, created_at
			from inference_jobs
			where payer = ${payer}
			order by created_at desc
			limit ${clamped}
		`
		: txHash
			? await sql`
				select job_id, route, network, payer, model, provider, tokens_used,
				       amount_atomics, asset, tx_hash, created_at
				from inference_jobs
				where tx_hash = ${txHash}
				order by created_at desc
				limit ${clamped}
			`
			: await sql`
				select job_id, route, network, payer, model, provider, tokens_used,
				       amount_atomics, asset, tx_hash, created_at
				from inference_jobs
				order by created_at desc
				limit ${clamped}
			`;
	return rows.map((r) => ({
		jobId: r.job_id,
		route: r.route,
		network: r.network,
		payer: r.payer,
		model: r.model,
		provider: r.provider,
		tokensUsed: r.tokens_used,
		amountAtomics: r.amount_atomics,
		asset: r.asset,
		txHash: r.tx_hash,
		createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
	}));
}
