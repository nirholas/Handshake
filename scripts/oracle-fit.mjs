// Fit the Oracle conviction model from real outcomes, and report what it learned.
//
// The fitting itself lives in api/_lib/oracle/fit.js, shared with the production
// learning loop (api/cron/oracle-refit.js) so the terminal and the cron can
// never disagree about what "the model" means. This file is the CLI around it:
// load rows, fit, print a readable report, optionally write the bootstrap JSON
// that ships in the container image.
//
//   node scripts/oracle-fit.mjs                 fit and report, write nothing
//   node scripts/oracle-fit.mjs --write         also update conviction-model.json
//   node scripts/oracle-fit.mjs --rows 200000   cap the training window
//   node scripts/oracle-fit.mjs --epochs 16     more SGD passes per head
//   node scripts/oracle-fit.mjs --json          machine-readable report on stdout
//
// Production does not need this script to stay current: the refit cron promotes
// new weights into oracle_model_versions on its own schedule. Run it when you
// want to see the numbers, or to refresh the bootstrap a cold container boots on.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';
import { buildModel, LABEL_VERSION, MIN_TRAINING_ROWS } from '../api/_lib/oracle/fit.js';

const MODEL_PATH = new URL('../api/_lib/oracle/conviction-model.json', import.meta.url);

// DATABASE_URL lives in .env.local, not .env (.env holds only the QA audit
// login). Reading just one of them is why a plain run of this script died with
// "DATABASE_URL not set" for weeks, which is a large part of why the model was
// never refit. Read both, and let a real environment variable win over either.
function loadEnvUrl() {
	if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
	for (const name of ['../.env.local', '../.env']) {
		const url = new URL(name, import.meta.url);
		if (!existsSync(url)) continue;
		const match = readFileSync(url, 'utf8').match(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m);
		if (match) return match[1].trim().replace(/^["']|["']$/g, '');
	}
	throw new Error('DATABASE_URL is not set and was not found in .env.local or .env');
}

function flag(name, fallback = null) {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const write = process.argv.includes('--write');
const asJson = process.argv.includes('--json');
const maxRows = Number(flag('rows', 0)) || Infinity;
const epochs = Number(flag('epochs', 0)) || 14;

const sql = neon(loadEnvUrl());

/**
 * Load labeled launches, oldest first, so the holdout is genuinely the future.
 * Only rows judged by the price-independent rule: version 1 rows carry a
 * `rugged` flag that tracks the SOL price instead of the coin, and mixing them
 * in would poison both the survival head and the win head that depends on it.
 */
async function loadRows() {
	const PAGE = 20000;
	const rows = [];
	for (let off = 0; rows.length < maxRows; off += PAGE) {
		const take = Math.min(PAGE, maxRows - rows.length);
		const page = await sql`
			select mint, features, category, creator_launches, creator_wins,
			       outcome, graduated, rugged, ath_multiple, hold_multiple, retained, first_seen_at
			from oracle_training_set
			where network = 'mainnet' and outcome <> 'unknown' and label_version >= ${LABEL_VERSION}
			order by first_seen_at asc, mint asc
			limit ${take} offset ${off}
		`;
		rows.push(...page);
		if (page.length < take) break;
	}
	return rows;
}

const rows = await loadRows();
if (rows.length < MIN_TRAINING_ROWS) {
	console.error(`Only ${rows.length} rows carry label_version >= ${LABEL_VERSION}; refusing to fit on so little.`);
	console.error('The intel labeler stamps that version as it relabels. Let it run, or check api/cron/intel-learn.js.');
	process.exit(2);
}

const startedAt = Date.now();
const { model, report } = buildModel(rows, { epochs });
const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

if (asJson) {
	console.log(JSON.stringify({ report, fit_seconds: Number(seconds) }, null, 2));
} else {
	const pct = (v) => `${(100 * v).toFixed(2)}%`;
	console.log(`training rows: ${report.rows.toLocaleString()}  (label_version >= ${LABEL_VERSION})`);
	console.log(`fit in ${seconds}s: ${model.fit.features} features, ${model.fit.columns} bucket weights, ${model.fit.epochs_run} epochs`);
	if (report.dropped.length) {
		console.log('\ndropped as uninformative on this dataset:');
		for (const d of report.dropped) {
			const runner = d.runner_up ? `runner-up "${d.runner_up.bucket}" n=${d.runner_up.n}` : 'only one bucket';
			console.log(`  ${d.key.padEnd(24)} ${(100 * d.share).toFixed(1)}% in "${d.bucket}", ${runner}`);
		}
	}
	console.log('\nbase rates:');
	for (const [head, rate] of Object.entries(report.base_rates)) console.log(`  ${head.padEnd(6)} ${pct(rate)}`);

	for (const head of ['win', 'rug', 'moon']) {
		const e = model.holdout[head];
		if (!e) continue;
		console.log(`\n[${head}] holdout n=${model.holdout.n.toLocaleString()}  AUC=${e.auc}  Brier=${e.brier}  base=${pct(e.base_rate)}`);
		for (const [k, v] of Object.entries(e.precision)) {
			console.log(`   precision@${k.padEnd(6)} ${(100 * v.rate).toFixed(1).padStart(5)}%  (n=${v.n}, lift ${v.lift}x)`);
		}
		console.log('   reliability (does a claim of X happen X of the time):');
		for (const b of e.reliability) {
			if (!b.n) continue;
			console.log(`     p ${b.lo.toFixed(2)}-${b.hi.toFixed(2)}  n=${String(b.n).padStart(6)}  claimed ${(100 * b.predicted).toFixed(1).padStart(5)}%  observed ${(100 * b.observed).toFixed(1).padStart(5)}%`);
		}
	}
	console.log(`\n${write ? 'writing' : 'dry run'}: pass --write to update the bootstrap model shipped in the image.`);
}

if (write) {
	writeFileSync(MODEL_PATH, `${JSON.stringify(model, null, '\t')}\n`);
	console.log(`wrote ${MODEL_PATH.pathname}`);
}
