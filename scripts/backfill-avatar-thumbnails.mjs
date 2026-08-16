#!/usr/bin/env node
/**
 * Backfill thumbnails for avatars that don't have one.
 *
 * Operator-driven bulk counterpart to the steady-state cron
 * (api/cron/avatar-thumbnail-backfill.js). Both share api/_lib/avatar-thumbs.js
 * — the same claim ledger, the same "never persist a key without confirming the
 * object exists" invariant — so it is safe to run this while the cron is live.
 * Neither will claim an avatar the other is already rendering.
 *
 * Two phases, cheapest first:
 *   1. adopt  — an avatar forged from a forge_creations row points its
 *               thumbnail_key at that creation's already-uploaded preview image.
 *               Free: no render, no new bytes.
 *   2. render — everything else. Boots headless chromium, renders the GLB to a
 *               768² PNG, uploads to thumb/<avatarId>.png, commits the key.
 *               ~6s per model, so run it with --concurrency.
 *
 * Avatars are drained most-visible-first (featured → public → view_count →
 * newest), so the surfaces users actually look at heal before the long tail.
 * A model that fails to render MAX_ATTEMPTS times is retired and stops consuming
 * budget.
 *
 * Usage. Needs DATABASE_URL and the S3_* set. Only DATABASE_URL is in
 * .env.local; the authoritative S3_* copy lives on the Cloud Run service, so
 * export those into the shell first (docs/avatar-thumbnails.md has the one
 * liner that reads them off the service).
 *
 *   node --env-file=.env.local scripts/backfill-avatar-thumbnails.mjs --status
 *   node --env-file=.env.local scripts/backfill-avatar-thumbnails.mjs --adopt-only
 *   node --env-file=.env.local scripts/backfill-avatar-thumbnails.mjs --limit=50 --concurrency=3
 *   node --env-file=.env.local scripts/backfill-avatar-thumbnails.mjs --limit=2000 --concurrency=4 --loop
 *
 * Flags:
 *   --status            print coverage and exit
 *   --limit=N           render at most N avatars (default 25)
 *   --concurrency=N     parallel renders, shared chromium (default 2)
 *   --adopt-only        run phase 1 only, never boot chromium
 *   --render-only       skip phase 1
 *   --loop              keep refilling the budget until nothing is left to claim
 *   --reset-infra       un-retire avatars whose only failures were the
 *                       environment's fault: a dead browser (an OOM-killed
 *                       chromium fails every render in the batch with
 *                       "Connection closed.") or unreachable object storage.
 *                       Genuinely broken models record a model-attributable
 *                       error (e.g. "glb fetch failed") and are never reset.
 *   --repair-only       run --reset-infra / --restyle and stop before touching
 *                       R2. Needs DATABASE_URL only, so the undo still works
 *                       while object storage is the thing that is broken.
 *   --restyle=N         re-queue up to N posters baked by an older renderer so
 *                       they re-render with the current camera/backdrop. Only
 *                       server-rendered thumb/<uuid>.png keys are cleared; user
 *                       snapshots and forge previews are never touched. Run after
 *                       deploying a renderer change, with --limit sized to match.
 *
 * Unlike the previous version this talks to Postgres + R2 directly, so it needs
 * no ADMIN_BEARER and no running server.
 */

import {
	adoptForgePreviews,
	renderBatch,
	coverage,
	ensureBackfillSchema,
	resetInfrastructureFailures,
	queueRestyle,
	MAX_ATTEMPTS,
} from '../api/_lib/avatar-thumbs.js';

const argv = process.argv.slice(2);
const has = (name) => argv.includes(`--${name}`);
const num = (name, fallback) => {
	const hit = argv.find((a) => a.startsWith(`--${name}=`));
	return hit ? Number(hit.split('=')[1]) : fallback;
};

const LIMIT = num('limit', 25);
const CONCURRENCY = Math.max(1, num('concurrency', 2));
const ADOPT_ONLY = has('adopt-only');
const RENDER_ONLY = has('render-only');
const LOOP = has('loop');

// The ledger repairs are pure Postgres work: they delete rows or clear a column,
// and never presign, render, or upload. --repair-only runs them and stops, so it
// needs no S3_* set. That matters because storage being broken is precisely when
// an operator needs the repair, and sending them to fetch Cloud Run credentials
// first made the undo unreachable at the only moment it counts.
const REPAIR_ONLY = has('repair-only');
const NEEDS_STORAGE = !has('status') && !REPAIR_ONLY;

// DATABASE_URL ships in .env.local, but the S3_* set does not: its authoritative
// copy is the Cloud Run service env. Pointing every miss at --env-file sends the
// operator back to the file that just failed them, so name the real source.
for (const required of ['DATABASE_URL', ...(NEEDS_STORAGE ? ['S3_BUCKET', 'S3_ACCESS_KEY_ID'] : [])]) {
	if (!process.env[required]) {
		const where = required.startsWith('S3_')
			? 'export the S3_* set from the Cloud Run service first (see docs/avatar-thumbnails.md, "Operating the backfill")'
			: `run with: node --env-file=.env.local ${process.argv[1]}`;
		console.error(`[backfill] ${required} is unset. ${where}`);
		process.exit(1);
	}
}

const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : 'n/a');

async function printCoverage(label) {
	const c = await coverage();
	console.log(
		`[backfill] ${label}: ${c.covered}/${c.total} public avatars have a thumbnail ` +
			`(${pct(c.covered, c.total)}) — ${c.missing} missing, ` +
			`${c.exhausted} retired after ${MAX_ATTEMPTS} failed renders`,
	);
	return c;
}

async function main() {
	await ensureBackfillSchema();
	await printCoverage('before');
	if (has('status')) return;

	// Un-retire avatars whose only failures were the browser dying. Cheap, safe to
	// run every time: a genuinely broken model records a model-attributable error
	// (e.g. "glb fetch failed") and is never reset.
	if (has('reset-infra')) {
		const { reset } = await resetInfrastructureFailures();
		console.log(`[backfill] reset ${reset} ledger row(s) whose failure was infrastructure, not the model`);
		await printCoverage('after reset');
	}

	// Re-queue posters baked by an older renderer (flat dark background, dead-on
	// camera) so this run re-renders them with the current look. Only clears
	// server-rendered thumb/<uuid>.png keys — user-uploaded snapshots and forge
	// previews are never touched. Run AFTER deploying a renderer change; pair
	// with --limit sized to match.
	if (num('restyle', 0) > 0) {
		const { queued } = await queueRestyle({ limit: num('restyle', 0) });
		console.log(`[backfill] restyle: cleared ${queued} old server-rendered poster(s) for re-render`);
	}

	// Repairs done; everything past here touches R2.
	if (REPAIR_ONLY) return;

	// ── Phase 1: free adoption ────────────────────────────────────────────────
	if (!RENDER_ONLY) {
		let totalAdopted = 0;
		let totalMissing = 0;
		for (;;) {
			const { adopted, missing } = await adoptForgePreviews({ limit: 200 });
			totalAdopted += adopted;
			totalMissing += missing;
			if (adopted) console.log(`[backfill] adopted ${adopted} forge preview(s)`);
			// Candidates whose preview object is absent from R2 can never be adopted
			// and stay in the candidate set, so a batch of only those would spin
			// forever. Stop as soon as a pass adopts nothing.
			if (!adopted) break;
		}
		console.log(
			`[backfill] phase 1 done — ${totalAdopted} adopted` +
				(totalMissing
					? `, ${totalMissing} preview object(s) absent from R2 (those avatars get rendered instead)`
					: ''),
		);
	}

	if (ADOPT_ONLY) {
		await printCoverage('after');
		return;
	}

	// ── Phase 2: render ───────────────────────────────────────────────────────
	let rendered = 0;
	let failed = 0;
	let remaining = LIMIT;

	while (remaining > 0) {
		const batch = Math.min(remaining, Math.max(CONCURRENCY * 2, 4));
		const t0 = Date.now();
		const r = await renderBatch({
			limit: batch,
			concurrency: CONCURRENCY,
			onResult: (res) => {
				const tag = `${String(res.id).slice(0, 8)} (${(res.name || '?').slice(0, 28)})`;
				if (res.status === 'done') console.log(`[backfill]   ✓ ${tag} — ${res.bytes}b in ${res.ms}ms`);
				else if (res.status === 'aborted') console.error(`[backfill]   ⚠ ${tag} — browser died: ${res.error}`);
				else console.error(`[backfill]   ✗ ${tag} — ${res.error}`);
			},
		});

		if (!r.claimed) {
			console.log('[backfill] nothing left to claim');
			break;
		}
		if (r.aborted) {
			// chromium died (usually the OOM killer). Claims were rolled back, so no
			// model was charged a retry. Bail loudly rather than spin: rerun with a
			// lower --concurrency.
			console.error(
				`[backfill] aborted — the browser died mid-batch (${r.aborted}). ` +
					`No retries were charged. Re-run with a lower --concurrency.`,
			);
			rendered += r.rendered;
			failed += r.failed;
			break;
		}
		rendered += r.rendered;
		failed += r.failed;
		remaining -= r.claimed;
		console.log(
			`[backfill] batch: ${r.rendered} rendered, ${r.failed} failed in ` +
				`${((Date.now() - t0) / 1000).toFixed(1)}s — ${rendered} rendered this run, ` +
				`${Math.max(0, remaining)} of budget left`,
		);

		if (remaining <= 0 && LOOP) remaining = LIMIT; // --loop: refill the budget
	}

	console.log(`[backfill] phase 2 done — ${rendered} rendered, ${failed} failed`);
	await printCoverage('after');
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('[backfill] fatal:', err?.stack || err);
		process.exit(1);
	});
