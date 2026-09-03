/**
 * Oracle - the model, published.
 *
 *   GET /api/oracle/model                    the active model, whole
 *   GET /api/oracle/model?view=registry      every version, promoted or refused
 *   GET /api/oracle/model?view=diff&from=&to= what the machine learned between two
 *   GET /api/oracle/model?view=card          the short human summary
 *
 * Most prediction products publish a number. This publishes the machine that
 * makes the number: every bucket weight, the sample count behind it, the
 * held-out reliability curve, the features it threw away for carrying no
 * information, and the promotion decision that let it near production. The
 * model is a lookup table, roughly 32KB of JSON, so anyone can download it and
 * reproduce any score we have ever shown offline, with no API key and no call
 * back to us. `@three-ws/oracle-model` on npm does exactly that in a few lines.
 *
 * The registry view is the part that matters most. Every refit is recorded,
 * including the ones the promotion gate refused and why, so the track record
 * cannot be quietly edited after the fact: a model that lost is still in the
 * table next to the one that won.
 *
 * Public, no auth, cached at the edge. Reads only.
 */

import { cors, json, method, wrap, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql, isDbUnavailableError } from '../_lib/db.js';
import { activeModel, PREDICTED_EVENT, SCORE_ANCHORS, PILLAR_WEIGHTS } from '../_lib/oracle/conviction.js';
import { ensureActiveModel, modelProvenance } from '../_lib/oracle/model-store.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const MAX_REGISTRY = 50;

/** Tier boundaries as a table anyone can check a card against. */
function ladder(model) {
	const a = model.tier_probability_anchors || {};
	const holdout = model.holdout?.[model.score_head]?.reliability || [];
	const rows = [
		{ tier: 'prime', label: 'Prime', min_score: 86, claims: a.prime ?? null },
		{ tier: 'strong', label: 'Strong', min_score: 72, claims: a.strong ?? null },
		{ tier: 'lean', label: 'Lean', min_score: 56, claims: a.lean ?? null },
		{ tier: 'watch', label: 'Watch', min_score: 34, claims: a.watch ?? null },
		{ tier: 'avoid', label: 'Avoid', min_score: 0, claims: 0 },
	];
	// Staple each rung to the band of the holdout curve it sits in, so the claim
	// and the measurement are printed together or not at all.
	return rows.map((r) => {
		const band = holdout.find((b) => r.claims != null && r.claims >= b.lo && r.claims < b.hi) || null;
		return { ...r, observed: band?.observed ?? null, samples: band?.n ?? 0 };
	});
}

/** The short version: what it predicts, how well, how old, what it dropped. */
function card(model, provenance) {
	const head = model.score_head;
	const h = model.holdout?.[head] || null;
	return {
		version: model.version,
		score_head: head,
		predicts: PREDICTED_EVENT,
		fitted_at: model.fitted_at,
		training_rows: model.training_rows,
		features: model.features.length,
		bucket_weights: model.features.reduce((n, f) => n + Object.keys(f.buckets).length, 0),
		pillar_weights: PILLAR_WEIGHTS,
		holdout: h && {
			n: model.holdout.n,
			auc: h.auc,
			brier: h.brier,
			base_rate: h.base_rate,
			precision: h.precision,
		},
		heads: Object.fromEntries(Object.entries(model.holdout || {})
			.filter(([k, v]) => v && typeof v === 'object' && v.auc != null)
			.map(([k, v]) => [k, { auc: v.auc, base_rate: v.base_rate }])),
		// Named out loud rather than silently absent: a signal that stopped
		// arriving is an outage somewhere upstream, and the model is the first
		// place it becomes visible.
		dropped_features: model.dropped_features || [],
		tier_ladder: ladder(model),
		score_anchors: SCORE_ANCHORS,
		provenance,
	};
}

/**
 * What changed between two fits, in the terms a reader cares about: which
 * buckets moved, which features arrived or left, and whether the ranking got
 * better. This is the closest thing to watching a model think.
 */
function diffModels(from, to) {
	const head = to.score_head;
	const index = (m) => {
		const out = new Map();
		for (const f of m.features || []) {
			for (const [bucket, stats] of Object.entries(f.buckets || {})) {
				out.set(`${f.key}/${bucket}`, { w: Number(stats.w?.[head] ?? stats.w ?? 0), n: stats.n, rate: stats.rate?.[head] ?? null });
			}
		}
		return out;
	};
	const a = index(from);
	const b = index(to);

	const moved = [];
	for (const [key, cur] of b) {
		const prev = a.get(key);
		if (!prev) { moved.push({ key, kind: 'new', from: null, to: cur.w, delta: cur.w, samples: cur.n, rate: cur.rate }); continue; }
		const delta = Number((cur.w - prev.w).toFixed(4));
		if (Math.abs(delta) >= 0.02) moved.push({ key, kind: 'moved', from: prev.w, to: cur.w, delta, samples: cur.n, rate: cur.rate });
	}
	for (const [key, prev] of a) {
		if (!b.has(key)) moved.push({ key, kind: 'gone', from: prev.w, to: null, delta: -prev.w, samples: prev.n, rate: prev.rate });
	}
	moved.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));

	const featureSet = (m) => new Set((m.features || []).map((f) => f.key));
	const fa = featureSet(from);
	const fb = featureSet(to);

	return {
		score_head: head,
		rows: { from: from.training_rows, to: to.training_rows },
		fitted_at: { from: from.fitted_at, to: to.fitted_at },
		holdout_auc: Object.fromEntries(['win', 'rug', 'moon'].map((k) => {
			const x = from.holdout?.[k]?.auc ?? null;
			const y = to.holdout?.[k]?.auc ?? null;
			return [k, { from: x, to: y, delta: x != null && y != null ? Number((y - x).toFixed(4)) : null }];
		})),
		features_added: [...fb].filter((k) => !fa.has(k)),
		features_removed: [...fa].filter((k) => !fb.has(k)),
		buckets_changed: moved.length,
		// Bounded: the whole point is to be readable, and the tail below 0.02
		// log-odds is refitting noise nobody can act on.
		top_moves: moved.slice(0, 40),
	};
}

async function loadVersion(id, network) {
	const rows = await sql`
		select id, model, fitted_at, training_rows, status, decision, promoted_at, created_at,
		       holdout_auc_win, holdout_auc_rug, holdout_auc_moon
		from oracle_model_versions where id = ${id} and network = ${network} limit 1
	`;
	return rows[0] || null;
}

export default wrap(async (req, res) => {
	if (cors(req, res)) return;
	if (!method(req, res, ['GET'])) return;
	const rl = await limits.publicIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, 'http://localhost');
	const network = NETWORKS.has(url.searchParams.get('network')) ? url.searchParams.get('network') : 'mainnet';
	const view = url.searchParams.get('view') || 'active';

	// Best effort: a database that is down should still let the endpoint publish
	// the model the container is currently scoring with, which is the honest
	// answer to "what is running right now".
	let provenance;
	try {
		provenance = await ensureActiveModel({ network });
	} catch {
		provenance = modelProvenance();
	}
	const model = activeModel();

	res.setHeader('cache-control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');

	if (view === 'card') {
		return json(res, 200, { ok: true, network, card: card(model, provenance) });
	}

	if (view === 'registry') {
		try {
			const rows = await sql`
				select id, fitted_at, training_rows, status, decision, promoted_at, created_at,
				       holdout_auc_win, holdout_auc_rug, holdout_auc_moon
				from oracle_model_versions
				where network = ${network}
				order by created_at desc
				limit ${MAX_REGISTRY}
			`;
			return json(res, 200, {
				ok: true,
				network,
				active_version_id: provenance.version_id,
				// Refused candidates are listed too, on purpose. A registry that only
				// shows the winners is a highlight reel, not a record.
				versions: rows.map((r) => ({
					id: Number(r.id),
					status: r.status,
					decision: r.decision,
					fitted_at: r.fitted_at,
					training_rows: r.training_rows,
					promoted_at: r.promoted_at,
					created_at: r.created_at,
					holdout_auc: { win: r.holdout_auc_win, rug: r.holdout_auc_rug, moon: r.holdout_auc_moon },
				})),
			});
		} catch (err) {
			if (isDbUnavailableError(err)) {
				return json(res, 200, { ok: true, network, degraded: true, versions: [], active_version_id: null });
			}
			throw err;
		}
	}

	if (view === 'diff') {
		const from = Number(url.searchParams.get('from'));
		const to = Number(url.searchParams.get('to'));
		if (!Number.isInteger(from) || !Number.isInteger(to) || from <= 0 || to <= 0) {
			return json(res, 400, { ok: false, error: 'diff needs integer from and to version ids (see view=registry)' });
		}
		const [a, b] = await Promise.all([loadVersion(from, network), loadVersion(to, network)]);
		if (!a) return json(res, 404, { ok: false, error: `model version ${from} not found` });
		if (!b) return json(res, 404, { ok: false, error: `model version ${to} not found` });
		return json(res, 200, { ok: true, network, from: from, to: to, diff: diffModels(a.model, b.model) });
	}

	// Default: the whole thing. Weights included, deliberately.
	return json(res, 200, {
		ok: true,
		network,
		card: card(model, provenance),
		model,
		usage: {
			npm: '@three-ws/oracle-model',
			example: "import { OracleModel } from '@three-ws/oracle-model';\nconst oracle = await OracleModel.fetch();\nconsole.log(oracle.score({ organic_score: 0.82, unique_buyers: 41, smart_money_count: 2 }));",
			docs: 'https://three.ws/docs/oracle-model',
			lab: 'https://three.ws/oracle-lab',
		},
	});
});
