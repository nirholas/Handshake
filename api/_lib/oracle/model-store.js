// Oracle: the bridge between the learned model in the database and the pure
// scoring engine in memory.
//
// conviction.js is deliberately pure, so something has to fetch the current
// weights and install them. That is this module, and keeping it separate is
// what lets the scorer stay a function of its inputs while the model behind it
// changes underneath production without a deploy.
//
// Failure policy: never stop scoring. A database hiccup leaves whatever model is
// already installed in force (the bootstrap JSON on a cold container, the last
// good promotion on a warm one) and the next call retries. A scoring engine that
// returns nothing because it could not check for a newer opinion is strictly
// worse than one that keeps using a slightly older one.

import { sql } from '../db.js';
import { setActiveModel, activeModel, resetModel } from './conviction.js';

/**
 * How long an installed model is trusted before we look for a newer one.
 *
 * The refit cron promotes at most once every six hours, so this is not about
 * keeping up. It is about how long a freshly promoted model takes to reach every
 * warm container, and two minutes is short enough that a promotion is live
 * platform-wide inside one scoring cycle without adding a query to the hot path.
 */
const TTL_MS = 120_000;

const state = {
	loadedAt: 0,
	id: null,
	fittedAt: null,
	source: 'bootstrap',
	inflight: null,
	lastError: null,
};

/** Provenance of the model currently scoring: which row, from where, how old. */
export function modelProvenance() {
	const model = activeModel();
	return {
		source: state.source,
		version_id: state.id,
		model_version: model.version,
		score_head: model.score_head,
		fitted_at: model.fitted_at,
		training_rows: model.training_rows,
		loaded_at: state.loadedAt ? new Date(state.loadedAt).toISOString() : null,
		stale_after: state.loadedAt ? new Date(state.loadedAt + TTL_MS).toISOString() : null,
		last_error: state.lastError,
	};
}

async function fetchActive(network) {
	const rows = await sql`
		select id, model, fitted_at
		from oracle_model_versions
		where network = ${network} and status = 'active'
		order by promoted_at desc nulls last
		limit 1
	`;
	return rows[0] || null;
}

/**
 * Make sure the newest promoted model is the one scoring, and return its
 * provenance.
 *
 * Concurrency-safe: parallel callers inside one container share a single
 * in-flight query rather than each opening their own, which matters because the
 * score loop fans out over a batch of coins and would otherwise stampede the
 * database on every cache expiry.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] refetch even if the cached model is fresh
 * @param {string} [opts.network]
 * @returns {Promise<object>} provenance of the model now in force
 */
export async function ensureActiveModel({ force = false, network = 'mainnet' } = {}) {
	const fresh = state.loadedAt && Date.now() - state.loadedAt < TTL_MS;
	if (fresh && !force) return modelProvenance();
	if (state.inflight) { await state.inflight; return modelProvenance(); }

	state.inflight = (async () => {
		try {
			const row = await fetchActive(network);
			if (!row?.model) {
				// No promotion has happened yet. The bootstrap in the image is the
				// model, and saying so beats pretending a database read succeeded.
				state.source = 'bootstrap';
				state.id = null;
				state.lastError = null;
			} else if (row.id !== state.id) {
				setActiveModel(row.model);
				state.source = 'database';
				state.id = row.id;
				state.fittedAt = row.fitted_at;
				state.lastError = null;
				console.log(`[oracle] model v${row.id} installed (fitted ${row.fitted_at})`);
			}
			state.loadedAt = Date.now();
		} catch (err) {
			// Keep serving. Record why, so /api/oracle/model can say so out loud
			// instead of quietly publishing a stale model as if it were current.
			state.lastError = err?.message || String(err);
			console.warn('[oracle] model load failed, keeping the installed model:', state.lastError);
		} finally {
			state.inflight = null;
		}
	})();

	await state.inflight;
	return modelProvenance();
}

/**
 * Drop back to the model compiled into this build and forget the cache.
 * Used by tests, and by anything that needs a known-good scorer after a bad
 * promotion is rolled back.
 */
export function useBootstrapModel() {
	resetModel();
	state.loadedAt = 0;
	state.id = null;
	state.source = 'bootstrap';
	state.lastError = null;
	return modelProvenance();
}
