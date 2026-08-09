// GET/POST /api/cron/intel-learn — close the Coin Intelligence learning loop.
//
// The watcher (workers/agent-sniper/intel) records launch-time signals for every
// coin. This cron supplies the other half of "learns from watching":
//
//   1. labelOutcomes — revisit coins old enough to judge and record what
//      actually happened (graduated / pumped / flat / rugged) as ground truth.
//   2. trainWeights  — recompute per-signal predictive weights from all labeled
//      coins and persist them. The sniper's scoreIntel reads the latest weights,
//      so its judgment sharpens as the dataset grows.
//
// Reads/writes only the intel system's own tables (pump_coin_intel,
// pump_coin_outcomes, pump_intel_weights). Mainnet-only — pump_coin_* are
// mainnet. Idempotent + bounded so a frequent cron can never run away.

import { json, method, wrapCron } from '../_lib/http.js';
import { env } from '../_lib/env.js';
import { labelOutcomes, trainWeights } from '../../workers/agent-sniper/intel/learn.js';
import { requireCron } from '../_lib/cron-auth.js';

const NETWORK = 'mainnet';

export default wrapCron(async (req, res) => {
	if (!method(req, res, ['GET', 'POST'])) return;
	if (!requireCron(req, res)) return;

	const started = Date.now();

	// Label coins observed ≥ 60 min ago (enough time for a verdict to form) that
	// have no outcome yet. The budget must OUTRUN the firehose: ~30k new coins/day
	// against this cron's 96 runs/day means anything under ~350/run falls behind
	// forever (the serial 100/run era ended with an 11-day labeling blackout and a
	// 370k backlog). 1500/run ≈ 144k/day: catches up a backlog in days, then
	// idles cheaply (the query returns only unlabeled coins).
	const { labeled } = await labelOutcomes({ network: NETWORK, limit: 1500, minAgeMinutes: 60 });

	// Retrain once there's enough labeled history. Skips quietly below the floor.
	// The sample ceiling keeps the training query's memory bounded (the signals
	// JSONB per row is heavy), freshest labeled coins win, which also tracks
	// regime shifts in the launch meta.
	const maxSamples = Number.parseInt(process.env.INTEL_TRAIN_MAX_SAMPLES || '', 10);
	const train = await trainWeights({
		network: NETWORK,
		minSamples: 50,
		maxSamples: Number.isFinite(maxSamples) && maxSamples > 0 ? maxSamples : 20_000,
	});

	return json(res, 200, {
		ok: true,
		labeled,
		trained: train.trained,
		sample_size: train.sample_size,
		weights: train.weights || null,
		conditional_win_rates: train.conditional_win_rates || null,
		ms: Date.now() - started,
	});
}, { requireWriteCapacity: true });
