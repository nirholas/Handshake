// Fact Check — frontend surface.
//
// Explains the product, renders the published accuracy benchmark (a designed
// empty state when the runner hasn't executed against this environment yet —
// never a fabricated score), links the claim set for transparency, and hosts a
// live "try one free check" box that calls the real POST /api/x402/fact-check
// endpoint from the browser (free daily lane, 3/day per IP).

import { enterStagger } from './ui-juice.js';

const root = document.getElementById('fc-root');

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pct(n) {
	return typeof n === 'number' ? `${n.toFixed(1)}%` : '—';
}

// Presentation order for the two breakdown tables. Mirrors the verdict classes
// and difficulties in api/_lib/fact-check-benchmark.js.
const VERDICT_ORDER = ['supported', 'contradicted', 'mixed', 'insufficient'];
const DIFFICULTY_ORDER = ['easy', 'medium', 'hard'];

function renderStats(bench) {
	if (!bench) {
		return `<div class="fc-empty">Benchmark data is unavailable right now — try reloading.</div>`;
	}
	if (!bench.ran || !bench.report) {
		const total = bench.fixture?.total ?? 40;
		return `
			<div class="fc-empty">
				<strong>Not yet run in this environment.</strong> The ${total}-claim benchmark suite
				is committed and ready — <code>scripts/fact-check-benchmark.mjs</code> runs it through
				the real chain and publishes the score here the moment it executes. No score is shown
				until then; this page never fabricates one.
			</div>`;
	}
	const r = bench.report;
	const cls = r.accuracy_pct >= 80 ? 'fc-good' : r.accuracy_pct >= 60 ? 'fc-warn' : '';
	// Render in a fixed order, not object order: a report that round-tripped
	// through Postgres jsonb comes back with its keys reordered, which showed
	// difficulty as easy/hard/medium. Also skip a bucket with no claims, since a
	// null score rendered as a dash beside real numbers reads as a failure rather
	// than an absence.
	const cells = (table, order) =>
		order
			.map((k) => [k, table?.[k]])
			.filter(([, v]) => v && v.total > 0)
			.map(
				([k, v]) =>
					`<div class="fc-stat"><div class="fc-stat-label">${esc(k)}</div><div class="fc-stat-value">${pct(v.accuracy_pct)}</div><div class="fc-stat-sub">${v.correct}/${v.total}</div></div>`,
			)
			.join('');
	const byClass = cells(r.by_class, VERDICT_ORDER);
	const byDifficulty = cells(r.by_difficulty, DIFFICULTY_ORDER);
	const ran = r.generated_at ? new Date(r.generated_at) : null;
	return `
		<div class="fc-stats-grid">
			<div class="fc-stat"><div class="fc-stat-label">Overall accuracy</div><div class="fc-stat-value ${cls}">${pct(r.accuracy_pct)}</div><div class="fc-stat-sub">${r.correct ?? 0}/${r.total ?? 0} claims</div></div>
			<div class="fc-stat"><div class="fc-stat-label">Claims run</div><div class="fc-stat-value">${r.total ?? 0}</div><div class="fc-stat-sub">${esc(String(r.fixture_version || '1.0.0'))} suite</div></div>
			<div class="fc-stat"><div class="fc-stat-label">Errors</div><div class="fc-stat-value">${r.errors ?? 0}</div><div class="fc-stat-sub">unreachable checks</div></div>
		</div>
		${byClass ? `<h3 class="fc-stats-heading">By expected verdict</h3><div class="fc-stats-grid">${byClass}</div>` : ''}
		${byDifficulty ? `<h3 class="fc-stats-heading">By difficulty</h3><div class="fc-stats-grid">${byDifficulty}</div>` : ''}
		<p class="fc-hint" style="margin-top:12px">
			Last run: ${ran ? `<time datetime="${esc(ran.toISOString())}">${esc(ran.toLocaleString())}</time>` : 'unknown'}
		</p>`;
}

async function loadBenchmark() {
	const el = document.getElementById('fc-bench-body');
	try {
		const res = await fetch('/api/fact-check-benchmark');
		if (!res.ok) throw new Error(`benchmark ${res.status}`);
		const { data } = await res.json();
		el.innerHTML = renderStats(data);
		const links = document.getElementById('fc-bench-links');
		if (links && data) {
			links.innerHTML = `
				<a href="${esc(data.claims_source)}" target="_blank" rel="noopener">View the 40 benchmark claims →</a>
				<a href="${esc(data.runner_source)}" target="_blank" rel="noopener">View the scoring runner →</a>`;
		}
	} catch {
		el.innerHTML = `<div class="fc-empty">Couldn't load the benchmark right now — try reloading.</div>`;
	}
}

function verdictLabel(v) {
	return { supported: 'Supported', contradicted: 'Contradicted', mixed: 'Mixed evidence', insufficient: 'Insufficient evidence' }[v] || v;
}

async function runFreeCheck() {
	const textarea = document.getElementById('fc-claim-input');
	const btn = document.getElementById('fc-try-btn');
	const resultEl = document.getElementById('fc-try-result');
	const claim = textarea.value.trim();
	if (claim.length < 5) {
		resultEl.innerHTML = `<p class="fc-error">Enter a claim of at least 5 characters.</p>`;
		return;
	}
	btn.disabled = true;
	btn.textContent = 'Checking…';
	resultEl.innerHTML = `<p class="fc-try-meta">Running live search + LLM analysis — this takes a few seconds…</p>`;
	try {
		const res = await fetch('/api/x402/fact-check', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ claim }),
		});
		const body = await res.json().catch(() => null);
		if (res.status === 402) {
			resultEl.innerHTML = `<p class="fc-error">Free daily quota used up for your IP — the paid x402 lane ($0.10 USDC) picks up from here. Come back tomorrow for more free checks.</p>`;
			return;
		}
		if (!res.ok || !body) {
			resultEl.innerHTML = `<p class="fc-error">${esc(body?.error_description || `Check failed (${res.status}).`)}</p>`;
			return;
		}
		const sources = (body.sources || [])
			.slice(0, 5)
			.map(
				(s) =>
					`<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title || s.url)}</a><span class="fc-stance">${esc(s.stance)}</span><div>${esc(s.excerpt || '')}</div></li>`,
			)
			.join('');
		resultEl.innerHTML = `
			<div class="fc-result">
				<span class="fc-verdict ${esc(body.verdict)}">${esc(verdictLabel(body.verdict))} · ${Math.round((body.confidence || 0) * 100)}% confidence</span>
				<p class="fc-try-meta">lane: ${esc(body.lane)}${body.lane === 'free' && typeof body.free_remaining_today === 'number' ? ` · ${body.free_remaining_today} free checks left today` : ''}</p>
				<ul class="fc-sources">${sources || '<li>No cited sources for this check.</li>'}</ul>
				<div class="fc-attestation">${esc(body.attestation || '')}</div>
			</div>`;
	} catch (err) {
		resultEl.innerHTML = `<p class="fc-error">Network error: ${esc(err?.message || 'request failed')}. Try again.</p>`;
	} finally {
		btn.disabled = false;
		btn.textContent = 'Run free check';
	}
}

function render() {
	root.innerHTML = `
		<p class="fc-kicker"><span class="fc-dot"></span>Fact Check</p>
		<h1 class="fc-title" id="fc-title">Sourced verdicts. Cryptographic attestations. A benchmark you can check.</h1>
		<p class="fc-sub">
			Submit a claim and get a verdict — <code>supported</code> / <code>contradicted</code> /
			<code>mixed</code> / <code>insufficient</code> — backed by live web search and LLM stance
			analysis, cited sources, a confidence score, and a SHA-256 attestation over the result.
			<strong>3 free checks a day per IP</strong> run the exact same real chain, then it's
			$0.10 USDC per check via x402 on Base or Solana. No account, no API key.
		</p>

		<section class="fc-card">
			<h2>Accuracy benchmark</h2>
			<p class="fc-hint">
				A published, checkable quality bar: 40 curated claims, 10 per verdict class, scored
				against the real chain — not an asserted number. The claim set and the scoring code
				are both public.
			</p>
			<div id="fc-bench-body"><div class="fc-empty">Loading benchmark…</div></div>
			<div class="fc-links" id="fc-bench-links"></div>
		</section>

		<section class="fc-card fc-try">
			<h2>Try one free check</h2>
			<p class="fc-hint">Runs the real chain against three.ws production — the same one paid checks use.</p>
			<textarea id="fc-claim-input" placeholder="e.g. Solana uses a proof-of-history mechanism to order transactions." maxlength="1000"></textarea>
			<div class="fc-try-row">
				<span class="fc-try-meta">5–1000 characters</span>
				<button class="fc-btn" id="fc-try-btn" type="button">Run free check</button>
			</div>
			<div id="fc-try-result"></div>
		</section>

		<section class="fc-card">
			<h2>Pricing</h2>
			<div class="fc-pricing">
				<div><strong>Free</strong>3 checks/day per IP, real chain</div>
				<div><strong>$0.10</strong>per check via x402, Base or Solana USDC</div>
			</div>
			<p class="fc-hint" style="margin-top:12px">
				<a href="/docs/api-reference#fact-check-api" style="color:var(--fc-cyan)">Full API reference →</a>
			</p>
		</section>
	`;
	document.getElementById('fc-try-btn').addEventListener('click', runFreeCheck);
	enterStagger(Array.from(document.querySelectorAll('.fc-card')));
	loadBenchmark();
}

render();
