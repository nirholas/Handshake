// GET/POST /api/cron/oracle-refit: the Oracle learns from itself, on a clock.
//
// This is the loop that was missing. Every ingredient existed before today:
// 365,000 observed launches, 750,000 labeled outcomes, a fitter, a scorer. The
// one thing nothing did was connect them. The conviction weights shipped as a
// JSON file baked into the container, and refitting meant a human remembering to
// run a script. Between 2026-08-09 and 2026-08-28 nobody did, so the model
// answered every question with a 92,906-row opinion while eight times that much
// evidence piled up behind it.
//
// What runs here every six hours:
//
//   1. Load the labeled set, oldest first, price-independent labels only.
//   2. Fit three heads with a time-split holdout the model has never seen.
//   3. Put the candidate through a promotion gate that can, and does, say no.
//   4. Promote or archive. Either way, record the decision and the numbers.
//
// The gate is the part that makes this safe to run unattended. An automated
// retrain that always ships whatever it just fitted is not a learning loop, it
// is a single point of failure on a timer: one bad data day and production is
// serving a model nobody looked at. Every candidate has to beat the incumbent on
// held-out ranking, stay honest about its own tier claims, and keep its feature
// set intact. A candidate that fails is stored with the reason, not discarded,
// so the record of what the machine tried is as durable as what it shipped.

import { json, method, wrapCron } from '../_lib/http.js';
import { sql } from '../_lib/db.js';
import { requireCron } from '../_lib/cron-auth.js';
import { buildModel, LABEL_VERSION, MIN_TRAINING_ROWS, TIER_PROBABILITY_ANCHORS } from '../_lib/oracle/fit.js';
import { ensureActiveModel } from '../_lib/oracle/model-store.js';

/** Wall-clock budget. The route is configured for 300s; stop with room to write. */
const FIT_BUDGET_MS = 210_000;
/** Hard cap on rows pulled into memory for one fit. */
const MAX_ROWS = 400_000;
/** SGD passes per head. Fourteen converges on this design; more buys noise. */
const EPOCHS = 14;

/**
 * How much better a challenger has to be before it takes over.
 *
 * Not zero. Two fits on almost the same data differ by a few thousandths of AUC
 * from SGD ordering alone, and promoting on that noise would rewrite the live
 * model every six hours for no reason, making every published score a moving
 * target and every track record unreproducible. A challenger has to be visibly
 * better, or the incumbent keeps the job.
 */
const MIN_AUC_GAIN = 0.004;
/** A challenger may not be worse than this on any head, even if `win` improved. */
const MAX_HEAD_REGRESSION = 0.01;
/** Below this the ranking is not good enough to publish at all. */
const MIN_ABSOLUTE_AUC = 0.70;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * Load labeled launches, oldest first.
 *
 * `label_version >= 2` is load-bearing, not a filter of convenience. Version 1
 * rows carry a `rugged` flag decided by comparing a bonding curve's dollar value
 * to a hardcoded $3,000, and since an empty pump.fun curve is worth a fixed
 * 27.958993 SOL, that flag tracks the price of SOL rather than the coin. Two
 * heads out of three read it. Training on those rows produced a survival model
 * with an AUC of 0.484, which is to say worse than guessing.
 */
async function loadRows(network) {
	const PAGE = 20_000;
	const rows = [];
	for (let off = 0; rows.length < MAX_ROWS; off += PAGE) {
		const take = Math.min(PAGE, MAX_ROWS - rows.length);
		const page = await sql`
			select features, category, creator_launches, creator_wins,
			       outcome, graduated, ath_multiple, hold_multiple, retained
			from oracle_training_set
			where network = ${network} and outcome <> 'unknown' and label_version >= ${LABEL_VERSION}
			order by first_seen_at asc, mint asc
			limit ${take} offset ${off}
		`;
		rows.push(...page);
		if (page.length < take) break;
	}
	return rows;
}

/**
 * Decide whether a candidate replaces the incumbent.
 *
 * Returns a verdict plus the sentence explaining it, because six months from now
 * "why is the model from the 14th still live" is a question somebody will ask
 * and the answer should be in the row, not in a log that has rolled over.
 *
 * @param {object} candidate the freshly fitted model
 * @param {object|null} incumbent the active model document, if any
 * @returns {{promote:boolean, reason:string, checks:object[]}}
 */
export function judgeCandidate(candidate, incumbent) {
	const checks = [];
	const fail = (reason) => ({ promote: false, reason, checks });

	const head = candidate.score_head;
	const candAuc = num(candidate.holdout?.[head]?.auc);
	if (candAuc == null) return fail('candidate has no holdout AUC for its score head');

	// 1. Did the fit finish? A deadline-truncated fit is not wrong, it is
	//    under-trained, and under-trained weights should never quietly ship.
	checks.push({ check: 'fit_complete', pass: !!candidate.fit?.complete, detail: `${candidate.fit?.epochs_run}/${candidate.fit?.epochs} epochs` });
	if (!candidate.fit?.complete) return fail(`fit ran out of time at ${candidate.fit?.epochs_run}/${candidate.fit?.epochs} epochs`);

	// 2. Is it good enough to publish at all, incumbent or not?
	checks.push({ check: 'absolute_auc', pass: candAuc >= MIN_ABSOLUTE_AUC, detail: `${head} AUC ${candAuc}` });
	if (candAuc < MIN_ABSOLUTE_AUC) return fail(`${head} AUC ${candAuc} is below the ${MIN_ABSOLUTE_AUC} publish floor`);

	// 3. Does every tier still earn the probability it claims? The ladder is a
	//    public promise. A model whose top band claims 45% and delivers 20% is
	//    accurate in aggregate and lying on every card that renders it.
	const bands = candidate.holdout?.[head]?.reliability || [];
	const dishonest = bands.filter((b) => b.n >= 100 && b.observed != null && b.observed < b.lo * 0.7);
	checks.push({
		check: 'tier_honesty',
		pass: !dishonest.length,
		detail: dishonest.length
			? dishonest.map((b) => `band ${b.lo}-${b.hi} claims ${b.lo} observed ${b.observed} (n=${b.n})`).join('; ')
			: `all ${bands.filter((b) => b.n >= 100).length} populated bands clear their claim`,
	});
	if (dishonest.length) return fail(`tier bands do not earn their claim: ${checks[checks.length - 1].detail}`);

	// 4. Did the feature set collapse? A schema change or a broken enrichment
	//    lane shows up here as a model that suddenly fits on four signals.
	const featureCount = candidate.features?.length || 0;
	const incumbentFeatures = incumbent?.features?.length || 0;
	const collapsed = incumbentFeatures > 0 && featureCount < incumbentFeatures - 3;
	checks.push({ check: 'feature_set', pass: !collapsed, detail: `${featureCount} features (incumbent ${incumbentFeatures || 'none'})` });
	if (collapsed) return fail(`feature set collapsed from ${incumbentFeatures} to ${featureCount}; a signal source is probably broken`);

	if (!incumbent) {
		return { promote: true, reason: `first model on the price-independent labels: ${head} AUC ${candAuc}`, checks };
	}

	// 5. Beat the incumbent on the head we score, by more than fit noise.
	const baseAuc = num(incumbent.holdout?.[head]?.auc);
	if (baseAuc == null) {
		return { promote: true, reason: `incumbent has no comparable ${head} holdout; promoting the measured model`, checks };
	}
	const gain = Number((candAuc - baseAuc).toFixed(4));
	checks.push({ check: 'auc_gain', pass: gain >= MIN_AUC_GAIN, detail: `${head} ${baseAuc} -> ${candAuc} (${gain >= 0 ? '+' : ''}${gain})` });

	// 6. And do not go backwards anywhere else while doing it.
	for (const other of ['rug', 'moon']) {
		if (other === head) continue;
		const a = num(candidate.holdout?.[other]?.auc);
		const b = num(incumbent.holdout?.[other]?.auc);
		if (a == null || b == null) continue;
		const delta = Number((a - b).toFixed(4));
		const pass = delta >= -MAX_HEAD_REGRESSION;
		checks.push({ check: `no_regression_${other}`, pass, detail: `${other} ${b} -> ${a} (${delta >= 0 ? '+' : ''}${delta})` });
		if (!pass) return fail(`${other} head regressed ${delta} (${b} -> ${a}), beyond the ${MAX_HEAD_REGRESSION} tolerance`);
	}

	if (gain < MIN_AUC_GAIN) {
		return fail(`no material gain: ${head} AUC ${baseAuc} -> ${candAuc} (+${gain}), below the ${MIN_AUC_GAIN} bar`);
	}
	return { promote: true, reason: `${head} AUC ${baseAuc} -> ${candAuc} (+${gain}) on ${candidate.training_rows.toLocaleString()} rows`, checks };
}

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const network = 'mainnet';
	const startedAt = Date.now();

	const rows = await loadRows(network);
	if (rows.length < MIN_TRAINING_ROWS) {
		// Not an error. The labeler stamps label_version as it relabels, so a
		// freshly migrated database legitimately has too few correct rows for a
		// while, and the right behaviour is to keep the current model and wait.
		return json(res, 200, {
			ok: true, promoted: false, rows: rows.length,
			reason: `only ${rows.length} rows carry label_version >= ${LABEL_VERSION}; need ${MIN_TRAINING_ROWS}`,
		});
	}

	const [incumbentRow] = await sql`
		select id, model from oracle_model_versions
		where network = ${network} and status = 'active'
		order by promoted_at desc nulls last limit 1
	`;
	const incumbent = incumbentRow?.model || null;

	const { model } = buildModel(rows, {
		epochs: EPOCHS,
		deadlineAt: startedAt + FIT_BUDGET_MS,
		fittedAt: new Date().toISOString(),
	});
	// Anchors are a platform constant, not a per-fit choice: stamp the current
	// ones so a stored model is self-describing even if the constant later moves.
	model.tier_probability_anchors = { ...TIER_PROBABILITY_ANCHORS };

	const verdict = judgeCandidate(model, incumbent);
	const auc = (head) => num(model.holdout?.[head]?.auc);

	const [stored] = await sql`
		insert into oracle_model_versions
			(network, model, fitted_at, training_rows, holdout_auc_win, holdout_auc_rug, holdout_auc_moon, status, decision)
		values (${network}, ${JSON.stringify(model)}::jsonb, ${model.fitted_at}, ${model.training_rows},
			${auc('win')}, ${auc('rug')}, ${auc('moon')},
			${verdict.promote ? 'promoting' : 'candidate'}, ${verdict.reason})
		returning id
	`;

	if (verdict.promote) {
		// One transaction, because a unique partial index enforces exactly one
		// active model per network: demote first or the promote is rejected, and
		// a half-applied promotion would leave the platform with none at all.
		await sql.transaction([
			sql`update oracle_model_versions set status = 'superseded'
				where network = ${network} and status = 'active'`,
			sql`update oracle_model_versions set status = 'active', promoted_at = now()
				where id = ${stored.id}`,
		]);
		await ensureActiveModel({ force: true, network });
	}

	return json(res, 200, {
		ok: true,
		promoted: verdict.promote,
		version_id: stored.id,
		rows: model.training_rows,
		reason: verdict.reason,
		checks: verdict.checks,
		holdout: { win: auc('win'), rug: auc('rug'), moon: auc('moon') },
		dropped_features: model.dropped_features,
		took_ms: Date.now() - startedAt,
	});
});
