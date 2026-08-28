// Oracle Lab: the conviction model, rendered honestly.
//
// The page has one job that everything else follows from: make it impossible to
// read a score without also seeing the evidence behind it and the sample size of
// that evidence. So every weight ships with its n, every tier claim ships with
// the rate it actually earned on held-out data, and the version history shows
// the candidates the promotion gate refused alongside the ones it accepted.
//
// The interactive scorer runs the published weights locally, in the browser,
// with the same arithmetic the server uses. That is not a demo trick: if the two
// ever disagreed, one of them would be lying about what the platform does.

const MODEL_API = '/api/oracle/model';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v, digits = 1) => (v == null ? '-' : `${(100 * v).toFixed(digits)}%`);
const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

/** Whole numbers with separators; the model quotes counts in the hundreds of thousands. */
const int = (v) => (v == null ? '-' : Number(v).toLocaleString());

function ago(iso) {
	if (!iso) return 'unknown';
	const ms = Date.now() - new Date(iso).getTime();
	if (!Number.isFinite(ms)) return 'unknown';
	const mins = Math.round(ms / 60000);
	if (mins < 60) return `${mins}m ago`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

// ── state ────────────────────────────────────────────────────────────────────
const state = {
	model: null,
	card: null,
	registry: [],
	signals: {},
	sort: 'impact',
};

// ── scoring, client side, from the published weights ────────────────────────

function bucketLabel(feature, value) {
	if (feature.categorical) return String(value ?? 'unknown');
	if (value == null) return 'null';
	const edges = feature.edges || [];
	for (let i = 0; i < edges.length; i++) {
		if (value < edges[i]) return i === 0 ? `<${edges[0]}` : `${edges[i - 1]}-${edges[i]}`;
	}
	return `>=${edges[edges.length - 1]}`;
}

function featureValue(feature, signals) {
	if (feature.categorical) return String(signals[feature.key] ?? 'unknown').toLowerCase();
	if (feature.key === 'dev_sold') {
		const raw = signals.dev_sold;
		return raw === true || raw === 1 ? 1 : raw === false || raw === 0 ? 0 : null;
	}
	return num(signals[feature.key]);
}

function scoreLocally(model, signals) {
	const heads = Object.keys(model.heads || {});
	const z = {};
	for (const h of heads) z[h] = num(model.heads[h]?.intercept) ?? 0;
	const why = [];
	let observed = 0;

	for (const feature of model.features) {
		const value = featureValue(feature, signals);
		const bucket = bucketLabel(feature, value);
		const stats = feature.buckets?.[bucket];
		if (value != null && bucket !== 'null' && bucket !== 'unknown') observed++;
		if (!stats) continue;
		for (const h of heads) z[h] += num(stats.w?.[h]) ?? 0;
		why.push({
			key: feature.key,
			bucket,
			weight: num(stats.w?.[model.score_head]) ?? 0,
			samples: stats.n ?? 0,
			rate: stats.rate || null,
		});
	}
	why.sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));

	const probabilities = {};
	for (const h of heads) probabilities[h] = sigmoid(z[h]);

	const a = model.tier_probability_anchors || {};
	const anchors = [[0, 0], [a.watch, 34], [a.lean, 56], [a.strong, 72], [a.prime, 86], [1, 100]];
	const p = probabilities[model.score_head] ?? 0;
	let score = 100;
	for (let i = 1; i < anchors.length; i++) {
		const [p0, s0] = anchors[i - 1];
		const [p1, s1] = anchors[i];
		if (p <= p1) { score = clamp(Math.round(s0 + ((p - p0) / (p1 - p0)) * (s1 - s0))); break; }
	}

	const tiers = [[86, 'prime', 'Prime'], [72, 'strong', 'Strong'], [56, 'lean', 'Lean'], [34, 'watch', 'Watch'], [0, 'avoid', 'Avoid']];
	const tier = tiers.find(([min]) => score >= min);

	const rugRisk = probabilities.rug != null ? clamp(Math.round(probabilities.rug * 100)) : null;
	const upside = probabilities.moon != null ? clamp(Math.round(probabilities.moon * 100)) : null;
	const giveBackRisk = probabilities.moon > 0 && probabilities.win != null
		? clamp(Math.round((1 - Math.min(1, probabilities.win / probabilities.moon)) * 100))
		: null;

	return {
		score, tier: tier[1], tierLabel: tier[2], probabilities, rugRisk, upside, giveBackRisk,
		confidence: clamp(Math.round((observed / Math.max(1, model.features.length)) * 100)),
		why,
	};
}

// ── the interactive scorer ───────────────────────────────────────────────────

// One control per signal a person can reason about. Deliberately not one per
// feature: a slider for every fitted bucket would be a wall nobody touches, and
// the point of the panel is that moving something teaches you what the model
// believes. Everything omitted lands in its fitted null bucket, exactly as it
// does when the observer genuinely did not see it.
const CONTROLS = [
	{ key: 'organic_score', label: 'Organic demand', min: 0, max: 1, step: 0.01, value: 0.5, fmt: (v) => v.toFixed(2) },
	{ key: 'bundle_score', label: 'Bundling', min: 0, max: 1, step: 0.01, value: 0.1, fmt: (v) => v.toFixed(2) },
	{ key: 'snipe_ratio', label: 'Sniped at open', min: 0, max: 1, step: 0.01, value: 0.2, fmt: (v) => v.toFixed(2) },
	{ key: 'timing_entropy', label: 'Buy-timing spread', min: 0, max: 1, step: 0.01, value: 0.5, fmt: (v) => v.toFixed(2) },
	{ key: 'concentration_top10', label: 'Top-10 holder share', min: 0, max: 1, step: 0.01, value: 0.6, fmt: (v) => v.toFixed(2) },
	{ key: 'unique_buyers', label: 'Unique buyers', min: 0, max: 120, step: 1, value: 12, fmt: (v) => String(v) },
	{ key: 'unique_sellers', label: 'Unique sellers', min: 0, max: 60, step: 1, value: 2, fmt: (v) => String(v) },
	{ key: 'buy_volume_sol', label: 'Buy volume (SOL)', min: 0, max: 60, step: 0.5, value: 6, fmt: (v) => v.toFixed(1) },
	{ key: 'sell_volume_sol', label: 'Sell volume (SOL)', min: 0, max: 40, step: 0.5, value: 1, fmt: (v) => v.toFixed(1) },
	{ key: 'largest_buy_sol', label: 'Largest single buy (SOL)', min: 0, max: 20, step: 0.1, value: 1, fmt: (v) => v.toFixed(1) },
	{ key: 'dev_buy_sol', label: 'Dev buy (SOL)', min: 0, max: 10, step: 0.05, value: 0.3, fmt: (v) => v.toFixed(2) },
	{ key: 'dev_sell_sol', label: 'Dev sell (SOL)', min: 0, max: 10, step: 0.05, value: 0, fmt: (v) => v.toFixed(2) },
	{ key: 'mc_sol_first_seen', label: 'Cap at first sight (SOL)', min: 27, max: 60, step: 0.5, value: 30, fmt: (v) => v.toFixed(1) },
	{ key: 'smart_money_count', label: 'Proven wallets in', min: 0, max: 8, step: 1, value: 0, fmt: (v) => String(v) },
];

const SELECTS = [
	{
		key: 'dev_sold', label: 'Dev sold in the window', value: '0',
		options: [['0', 'held'], ['1', 'sold']],
		coerce: (v) => Number(v),
	},
	{
		key: 'creator_record', label: 'Creator history', value: 'unknown',
		options: [
			['unknown', 'unknown'], ['first_launch', 'first launch'], ['repeat_no_wins', 'repeat, no graduations'],
			['serial_no_wins', '5+ launches, none graduated'], ['has_wins', 'has graduated before'],
		],
	},
];

function derivedSignals() {
	const s = { ...state.signals };
	// Two signals the observer computes rather than reads, mirrored here so the
	// sliders behave the way the live pipeline does.
	const buys = num(s.buy_volume_sol) ?? 0;
	const sells = num(s.sell_volume_sol) ?? 0;
	const buyers = num(s.unique_buyers) ?? 0;
	const sellers = num(s.unique_sellers) ?? 0;
	s.net_volume_sol = Number((buys - sells).toFixed(3));
	s.buy_sell_ratio = sells > 0 ? Number((buys / sells).toFixed(3)) : null;
	s.trade_count = buyers + sellers;
	s.avg_buy_sol = buyers > 0 ? Number((buys / buyers).toFixed(4)) : null;
	return s;
}

function renderControls() {
	const host = $('controls');
	host.innerHTML = '';

	for (const c of CONTROLS) {
		if (state.signals[c.key] === undefined) state.signals[c.key] = c.value;
		const wrap = document.createElement('div');
		wrap.className = 'ctl';
		const id = `ctl-${c.key}`;
		wrap.innerHTML = `<label for="${id}">${esc(c.label)}<b id="v-${esc(c.key)}">${esc(c.fmt(state.signals[c.key]))}</b></label>`;
		const input = document.createElement('input');
		input.type = 'range';
		input.id = id;
		input.min = String(c.min); input.max = String(c.max); input.step = String(c.step);
		input.value = String(state.signals[c.key]);
		input.setAttribute('aria-label', c.label);
		input.addEventListener('input', () => {
			state.signals[c.key] = Number(input.value);
			const out = document.getElementById(`v-${c.key}`);
			if (out) out.textContent = c.fmt(Number(input.value));
			renderVerdict();
		});
		wrap.appendChild(input);
		host.appendChild(wrap);
	}

	for (const s of SELECTS) {
		if (state.signals[s.key] === undefined) state.signals[s.key] = s.coerce ? s.coerce(s.value) : s.value;
		const wrap = document.createElement('div');
		wrap.className = 'ctl';
		const id = `ctl-${s.key}`;
		wrap.innerHTML = `<label for="${id}">${esc(s.label)}</label>`;
		const sel = document.createElement('select');
		sel.id = id;
		sel.innerHTML = s.options.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('');
		sel.value = s.value;
		sel.addEventListener('change', () => {
			state.signals[s.key] = s.coerce ? s.coerce(sel.value) : sel.value;
			renderVerdict();
		});
		wrap.appendChild(sel);
		host.appendChild(wrap);
	}
}

function riskRow(label, value, colour, hint) {
	if (value == null) return '';
	return `
		<div class="risk">
			<span class="lbl">${esc(label)}${hint ? ` <span class="dim" title="${esc(hint)}">?</span>` : ''}</span>
			<span class="val" style="color:${colour}">${value}%</span>
			<span class="track"><i style="width:${clamp(value)}%;background:${colour}"></i></span>
		</div>`;
}

function renderVerdict() {
	const host = $('verdict');
	if (!state.model) { host.innerHTML = '<div class="skeleton" style="height:120px"></div>'; return; }
	const v = scoreLocally(state.model, derivedSignals());

	const why = v.why.slice(0, 6).map((w) => `
		<li>
			<span class="t">${esc(w.key)} <span class="dim">= ${esc(w.bucket)}</span></span>
			<span class="w ${w.weight >= 0 ? 'pos' : 'neg'}">${w.weight >= 0 ? '+' : ''}${w.weight.toFixed(3)}</span>
			<span class="m">${int(w.samples)} launches: ${pct(w.rate?.win)} won, ${pct(w.rate?.rug)} rugged</span>
		</li>`).join('');

	host.innerHTML = `
		<div><span class="score">${v.score}</span><span class="tierpill t-${esc(v.tier)}">${esc(v.tierLabel)}</span></div>
		<div class="dim" style="font-size:12.5px;margin-top:6px">
			claims a ${pct(v.probabilities.win, 1)} chance of running without giving it back
		</div>
		<div class="risks">
			${riskRow('Upside', v.upside, 'var(--lab-good)', 'Chance it graduates or peaks at 3x or more')}
			${riskRow('Give-back risk', v.giveBackRisk, 'var(--lab-warn)', 'Given it runs, how often a coin like this hands the run straight back')}
			${riskRow('Rug risk', v.rugRisk, 'var(--lab-bad)', 'Chance a first-sight holder ends down more than half')}
			${riskRow('Signals supplied', v.confidence, 'var(--lab-accent)', 'How much of the model you actually gave values for')}
		</div>
		<div class="why">
			<h4>Why</h4>
			<ol>${why || '<li class="dim">no decisive evidence either way</li>'}</ol>
		</div>`;
}

// ── static sections ──────────────────────────────────────────────────────────

function renderStats() {
	const c = state.card;
	const h = c.holdout;
	const cells = [
		['Model', `v${c.version}`, `${c.provenance?.source === 'database' ? `promotion #${c.provenance.version_id}` : 'shipped with the build'}`],
		['Fitted', ago(c.fitted_at), new Date(c.fitted_at).toISOString().slice(0, 16).replace('T', ' ')],
		['Trained on', int(c.training_rows), 'labeled launches'],
		['Held-out AUC', h ? h.auc.toFixed(4) : '-', h ? `on ${int(h.n)} it never saw` : ''],
		['Top 1% precision', h ? pct(h.precision.top1.rate, 1) : '-', h ? `${h.precision.top1.lift}x base rate` : ''],
		['Weights', int(c.bucket_weights), `across ${c.features} signals`],
	];
	$('stats').innerHTML = cells.map(([k, v, n]) => `
		<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="n">${esc(n)}</div></div>
	`).join('');

	const dropped = (c.dropped_features || []).map((d) => d.key);
	$('predicts').innerHTML = `
		<b>What the score predicts:</b> ${esc(c.predicts?.label || 'unknown')}.
		${c.predicts?.caveat ? ` ${esc(c.predicts.caveat)}` : ''}
		${dropped.length ? `<br><b>Dropped as uninformative:</b> ${dropped.map((d) => `<span class="pill">${esc(d)}</span>`).join(' ')}. These signals are null across the whole corpus, so the fitter refuses to invent a weight for them. If they start arriving, the next refit picks them up on its own.` : ''}`;
}

function renderLadder() {
	const rows = state.card.tier_ladder || [];
	$('ladder').innerHTML = `
		<thead><tr>
			<th>Tier</th><th class="num">Score</th><th class="num">Claims</th>
			<th class="num">Observed</th><th class="num">n</th><th>Verdict</th>
		</tr></thead>
		<tbody>${rows.map((r) => {
			const honest = r.observed != null && r.claims != null ? r.observed >= r.claims * 0.7 : null;
			return `<tr>
				<td><span class="tierpill t-${esc(r.tier)}">${esc(r.label)}</span></td>
				<td class="num">${r.min_score}+</td>
				<td class="num">${r.claims == null ? '-' : pct(r.claims, 0)}</td>
				<td class="num ${honest === false ? 'neg' : ''}">${pct(r.observed)}</td>
				<td class="num dim">${int(r.samples)}</td>
				<td>${r.samples < 100 ? '<span class="pill">thin</span>'
					: honest ? '<span class="pill ok">earns it</span>' : '<span class="pill no">falls short</span>'}</td>
			</tr>`;
		}).join('')}</tbody>`;
}

function weightRows() {
	const head = state.model.score_head;
	const rows = [];
	for (const f of state.model.features) {
		for (const [bucket, stats] of Object.entries(f.buckets || {})) {
			rows.push({
				feature: f.key, pillar: f.pillar, bucket,
				w: num(stats.w?.[head]) ?? 0,
				n: stats.n ?? 0,
				win: stats.rate?.win ?? null,
				rug: stats.rate?.rug ?? null,
				moon: stats.rate?.moon ?? null,
			});
		}
	}
	const by = {
		impact: (a, b) => Math.abs(b.w) - Math.abs(a.w),
		win: (a, b) => (b.win ?? 0) - (a.win ?? 0),
		rug: (a, b) => (b.rug ?? 0) - (a.rug ?? 0),
		n: (a, b) => b.n - a.n,
		feature: (a, b) => a.feature.localeCompare(b.feature) || a.bucket.localeCompare(b.bucket),
	};
	return rows.sort(by[state.sort] || by.impact);
}

function renderWeights() {
	const rows = weightRows();
	const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(r.w)), 0.001);
	$('wcount').textContent = `${rows.length} buckets`;
	$('weights').innerHTML = `
		<thead><tr>
			<th>Signal</th><th>Bucket</th><th>Pillar</th>
			<th class="num">Log-odds</th><th>Influence</th>
			<th class="num">Win</th><th class="num">Rug</th><th class="num">Run</th><th class="num">n</th>
		</tr></thead>
		<tbody>${rows.map((r) => {
			const width = (Math.abs(r.w) / maxAbs) * 50;
			return `<tr>
				<td>${esc(r.feature)}</td>
				<td class="dim">${esc(r.bucket)}</td>
				<td class="dim">${esc(r.pillar)}</td>
				<td class="num ${r.w >= 0 ? 'pos' : 'neg'}">${r.w >= 0 ? '+' : ''}${r.w.toFixed(4)}</td>
				<td><span class="bar"><i class="${r.w >= 0 ? 'up' : 'down'}" style="width:${width}%"></i></span></td>
				<td class="num">${pct(r.win)}</td>
				<td class="num">${pct(r.rug)}</td>
				<td class="num">${pct(r.moon)}</td>
				<td class="num ${r.n < 200 ? 'dim' : ''}">${int(r.n)}</td>
			</tr>`;
		}).join('')}</tbody>`;
}

function renderRegistry() {
	const host = $('registry');
	if (!state.registry.length) {
		host.innerHTML = `<tbody><tr><td><div class="empty">
			<b>No refits recorded yet</b>
			The model shipped with this build is the one scoring. The refit cron runs every six hours;
			the first promotion will appear here with the numbers that earned it.
		</div></td></tr></tbody>`;
		return;
	}
	host.innerHTML = `
		<thead><tr>
			<th>#</th><th>Status</th><th>Fitted</th><th class="num">Rows</th>
			<th class="num">Win AUC</th><th class="num">Rug AUC</th><th class="num">Run AUC</th><th>Decision</th>
		</tr></thead>
		<tbody>${state.registry.map((v) => {
			const cls = v.status === 'active' ? 'ok' : v.status === 'candidate' ? 'no' : '';
			return `<tr>
				<td class="num">${v.id}</td>
				<td><span class="pill ${cls}">${esc(v.status)}</span></td>
				<td class="dim">${esc(ago(v.fitted_at))}</td>
				<td class="num">${int(v.training_rows)}</td>
				<td class="num">${v.holdout_auc?.win?.toFixed?.(4) ?? '-'}</td>
				<td class="num">${v.holdout_auc?.rug?.toFixed?.(4) ?? '-'}</td>
				<td class="num">${v.holdout_auc?.moon?.toFixed?.(4) ?? '-'}</td>
				<td style="white-space:normal;max-width:38ch" class="dim">${esc(v.decision || '')}</td>
			</tr>`;
		}).join('')}</tbody>`;

	// A diff is only meaningful once there are two versions to compare.
	if (state.registry.length >= 2) {
		const [a, b] = [state.registry[1], state.registry[0]];
		$('diff-block').innerHTML = `<p class="note">
			<b>Compare any two:</b>
			<a href="${MODEL_API}?view=diff&from=${a.id}&to=${b.id}" target="_blank" rel="noopener">
				what changed between #${a.id} and #${b.id}</a>,
			or run <code>a.diff(b)</code> locally with the npm package.
		</p>`;
	}
}

function renderSnippet() {
	const html = `<span class="tok-k">import</span> { OracleModel } <span class="tok-k">from</span> <span class="tok-s">'@three-ws/oracle-model'</span>;

<span class="tok-k">const</span> oracle = <span class="tok-k">await</span> OracleModel.fetch();        <span class="tok-c">// one request, ~32KB</span>

<span class="tok-k">const</span> v = oracle.score({
  organic_score: <span class="tok-n">0.82</span>, unique_buyers: <span class="tok-n">41</span>, buy_volume_sol: <span class="tok-n">26</span>,
  snipe_ratio: <span class="tok-n">0.12</span>, smart_money_count: <span class="tok-n">2</span>, dev_sold: <span class="tok-k">false</span>,
});

v.score          <span class="tok-c">// 0-100, anchored on P(runs and holds)</span>
v.upside         <span class="tok-c">// chance it runs at all</span>
v.giveBackRisk   <span class="tok-c">// chance it runs and hands it straight back</span>
v.rugRisk        <span class="tok-c">// chance a first-sight holder ends down 50%+</span>
v.why            <span class="tok-c">// every bucket that moved it, with its sample count</span>

oracle.explain(signals).math   <span class="tok-c">// add the terms up yourself</span>
oracle.performance()           <span class="tok-c">// held-out AUC, Brier, reliability</span>
oracle.verify(yourSamples)     <span class="tok-c">// re-measure us on YOUR data</span>`;
	$('snippet').innerHTML = html;
}

function renderError(message) {
	for (const id of ['stats', 'ladder', 'weights', 'registry', 'verdict']) {
		const host = $(id);
		if (host) host.innerHTML = '';
	}
	$('stats').innerHTML = `<div class="stat err" style="grid-column:1/-1"><div class="empty">
		<b>Could not load the model</b>
		${esc(message)}. The model is also downloadable directly at
		<a href="${MODEL_API}">${MODEL_API}</a>, and the npm package works from a saved copy.
	</div></div>`;
}

function skeletons() {
	$('stats').innerHTML = Array.from({ length: 6 }, () => '<div class="stat"><div class="skeleton" style="width:60%"></div><div class="skeleton" style="height:22px;margin-top:10px"></div></div>').join('');
	$('verdict').innerHTML = '<div class="skeleton" style="height:150px"></div>';
}

async function load() {
	skeletons();
	try {
		const [modelRes, registryRes] = await Promise.all([
			fetch(MODEL_API, { headers: { accept: 'application/json' } }),
			fetch(`${MODEL_API}?view=registry`, { headers: { accept: 'application/json' } }).catch(() => null),
		]);
		if (!modelRes.ok) throw new Error(`the model endpoint returned ${modelRes.status}`);
		const body = await modelRes.json();
		if (!body?.model) throw new Error('the model endpoint returned no model');
		state.model = body.model;
		state.card = body.card;

		if (registryRes?.ok) {
			const reg = await registryRes.json().catch(() => null);
			state.registry = reg?.versions || [];
		}

		renderStats();
		renderLadder();
		renderControls();
		renderVerdict();
		renderWeights();
		renderRegistry();
		renderSnippet();
	} catch (err) {
		renderError(err?.message || String(err));
	}
}

$('wsort').addEventListener('change', (e) => {
	state.sort = e.target.value;
	if (state.model) renderWeights();
});

load();
