// Live agent-to-agent hire visualizer.
//
// Consumes the `kind: 'a2a_hire'` screen frames emitted by /api/agents/a2a-hire
// (see api/_lib/a2a-hire-phases.js) and renders the watchable moment: one agent
// hiring another over x402 — discover → quote → reserve (cap badge) → run →
// settle (coin flies wallet-to-wallet) → deliver → on-chain receipt with real
// Solana explorer links.
//
// Pure DOM + CSS. The coin-transfer animation fires ONLY on a live `settled`
// frame — never during reconnect backfill (that's history), never before real
// settlement. Stale / out-of-order frames for the active hire are dropped by
// phase index, so a reconnect can't paint `settled` after the receipt resolved.

// Display order + labels for the happy-path stepper. Mirrors HIRE_PHASES in
// api/_lib/a2a-hire-phases.js; kept local so the browser bundle has no cross-root
// import. The two lists must stay in sync (the test pins the server list).
const STEPS = [
	{ key: 'discover', label: 'Discover' },
	{ key: 'quote', label: 'Quote' },
	{ key: 'reserved', label: 'Reserve' },
	{ key: 'running', label: 'Run' },
	{ key: 'settled', label: 'Settle' },
	{ key: 'delivered', label: 'Deliver' },
	{ key: 'recorded', label: 'Receipt' },
];
const STEP_INDEX = Object.fromEntries(STEPS.map((s, i) => [s.key, i]));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
	{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function fmtUsd(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '—';
	if (v !== 0 && Math.abs(v) < 0.01) return `$${v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '.0')}`;
	return `$${v.toFixed(2)}`;
}

function truncMid(s, max = 20) {
	const str = String(s || '');
	if (str.length <= max) return str;
	const head = Math.ceil((max - 1) / 2);
	const tail = Math.floor((max - 1) / 2);
	return `${str.slice(0, head)}…${str.slice(str.length - tail)}`;
}

// Create the visualizer inside `bodyEl`. Returns { ingest, reset }.
export function createHireVisualizer(bodyEl, opts = {}) {
	const onSettled = typeof opts.onSettled === 'function' ? opts.onSettled : null;

	bodyEl.innerHTML = `
		<div class="asc-hire">
			<div class="asc-hire-cap" id="asc-hire-cap" hidden></div>
			<div class="asc-hire-empty" id="asc-hire-empty">
				<div class="asc-hire-empty-icon">⇄</div>
				<p>Idle — this agent hires others for skills it doesn't have.</p>
				<small>The next hire shows here: quote, settlement, and on-chain receipt.</small>
			</div>
			<div class="asc-hire-active" id="asc-hire-active" hidden></div>
			<div class="asc-hire-history" id="asc-hire-history"></div>
		</div>
	`;

	const capEl = bodyEl.querySelector('#asc-hire-cap');
	const emptyEl = bodyEl.querySelector('#asc-hire-empty');
	const activeEl = bodyEl.querySelector('#asc-hire-active');
	const historyEl = bodyEl.querySelector('#asc-hire-history');

	// Active-hire state keyed by hireId so out-of-order frames are deduped.
	let cur = null; // { id, meta, phaseIndex, coinFired }
	const done = new Map(); // hireId → final meta (for history)

	function renderCap(cap) {
		if (!cap || (cap.perCallCap == null && cap.dailyRemaining == null && cap.dailyUsd == null)) {
			capEl.hidden = true;
			return;
		}
		const bits = [];
		if (cap.perCallCap != null) bits.push(`<span class="asc-hire-cap-item"><span class="k">per-call cap</span><span class="v">${fmtUsd(cap.perCallCap)}</span></span>`);
		if (cap.dailyRemaining != null && cap.dailyUsd != null) {
			bits.push(`<span class="asc-hire-cap-item"><span class="k">daily left</span><span class="v">${fmtUsd(cap.dailyRemaining)} / ${fmtUsd(cap.dailyUsd)}</span></span>`);
		} else if (cap.dailyUsd != null) {
			bits.push(`<span class="asc-hire-cap-item"><span class="k">daily cap</span><span class="v">${fmtUsd(cap.dailyUsd)}</span></span>`);
		}
		capEl.innerHTML = `<span class="asc-hire-cap-shield" aria-hidden="true">🛡</span>${bits.join('')}`;
		capEl.hidden = bits.length === 0;
	}

	function stepper(phaseIndex) {
		return `<div class="asc-hire-steps" role="list">${STEPS.map((s, i) => {
			const state = i < phaseIndex ? 'done' : i === phaseIndex ? 'active' : 'todo';
			return `<div class="asc-hire-step ${state}" role="listitem"><span class="dot"></span><span class="lbl">${s.label}</span></div>`;
		}).join('')}</div>`;
	}

	function explorerLink(sig, url, label) {
		if (!sig) return `<span class="asc-hire-link pending">${label}: pending…</span>`;
		const href = url || `https://solscan.io/tx/${encodeURIComponent(sig)}`;
		return `<a class="asc-hire-link" href="${esc(href)}" target="_blank" rel="noopener">${label} ↗<span class="sig">${esc(truncMid(sig, 16))}</span></a>`;
	}

	function renderActive(meta, { live }) {
		emptyEl.hidden = true;
		activeEl.hidden = false;

		const phaseIndex = typeof meta.phaseIndex === 'number' && meta.phaseIndex >= 0
			? meta.phaseIndex
			: (STEP_INDEX[meta.phase] ?? 0);
		const provider = meta.providerName || 'provider';
		const skill = meta.skill || meta.slug || 'a skill';

		// ── error phases: amber over-cap / red failed, not a step ──────────────
		if (meta.phase === 'over_cap') {
			activeEl.innerHTML = `
				${quoteCardHtml(meta)}
				<div class="asc-hire-result amber">
					<span class="ico">⚠</span>
					<div><strong>Above cap — skipped</strong>
					<small>${fmtUsd(meta.usd)} would exceed the ${meta.cap?.perCallCap != null ? `${fmtUsd(meta.cap.perCallCap)} ` : ''}per-call limit. No funds moved.</small></div>
				</div>`;
			return;
		}
		if (meta.phase === 'failed') {
			activeEl.innerHTML = `
				${quoteCardHtml(meta)}
				<div class="asc-hire-result red">
					<span class="ico">✕</span>
					<div><strong>Skill failed — no charge</strong>
					<small>Verify-then-settle: the remote skill didn't complete, so nothing was paid.${meta.error ? ` ${esc(truncMid(meta.error, 80))}` : ''}</small></div>
				</div>`;
			return;
		}

		// ── happy path ─────────────────────────────────────────────────────────
		const settledOrLater = phaseIndex >= STEP_INDEX.settled;
		const isRunning = meta.phase === 'running';
		const isReceipt = meta.phase === 'recorded';

		activeEl.innerHTML = `
			${quoteCardHtml(meta)}
			${stepper(phaseIndex)}
			<div class="asc-hire-coinrail ${settledOrLater ? 'settled' : ''}" aria-hidden="true">
				<span class="wallet from"><span class="dot"></span>${esc(truncMid(meta.hirerName || 'hirer', 14))}</span>
				<span class="rail"><span class="coin">$</span></span>
				<span class="wallet to"><span class="dot"></span>${esc(truncMid(provider, 14))}</span>
			</div>
			${isRunning ? `<div class="asc-hire-running"><span class="spin"></span>Running remote skill: <code>${esc(meta.slug || skill)}</code></div>` : ''}
			${settledOrLater ? receiptCardHtml(meta, isReceipt) : ''}
		`;

		// Fire the coin only on a LIVE settle, once per hire.
		if (live && settledOrLater && cur && !cur.coinFired) {
			cur.coinFired = true;
			const rail = activeEl.querySelector('.asc-hire-coinrail');
			if (rail) {
				rail.classList.remove('flying');
				void rail.offsetWidth; // restart keyframe
				rail.classList.add('flying');
			}
		} else if (settledOrLater) {
			// Backfill / already-settled: show the coin parked at the provider.
			activeEl.querySelector('.asc-hire-coinrail')?.classList.add('arrived');
		}
	}

	function quoteCardHtml(meta) {
		const provider = meta.providerName || 'provider';
		const capStr = meta.cap?.perCallCap != null ? `<span class="cap">cap ${fmtUsd(meta.cap.perCallCap)}</span>` : '';
		return `
			<div class="asc-hire-quote" tabindex="0">
				<div class="asc-hire-quote-top">
					<span class="asc-hire-badge">HIRE</span>
					<span class="asc-hire-price">${fmtUsd(meta.usd)} <span class="ccy">USDC</span></span>
				</div>
				<div class="asc-hire-quote-mid">
					<span class="prov">${esc(truncMid(provider, 22))}</span>
					<span class="sep">·</span>
					<code class="slug">${esc(truncMid(meta.slug || '', 24))}</code>
				</div>
				<div class="asc-hire-quote-bot">${capStr}${meta.skill ? `<span class="skill">${esc(truncMid(meta.skill, 28))}</span>` : ''}</div>
			</div>`;
	}

	function receiptCardHtml(meta, terminal) {
		return `
			<div class="asc-hire-receipt ${terminal ? 'resolved' : ''}" tabindex="0">
				<div class="asc-hire-receipt-head">
					<span class="ico">${terminal ? '✓' : '◷'}</span>
					<strong>Provenance receipt</strong>
					${terminal ? '<span class="asc-hire-receipt-tag">on-chain</span>' : ''}
				</div>
				${meta.resultSummary ? `<div class="asc-hire-receipt-summary">${esc(truncMid(meta.resultSummary, 120))}</div>` : ''}
				<div class="asc-hire-receipt-links">
					${explorerLink(meta.txSig, meta.paymentExplorer, 'USDC settlement')}
					${explorerLink(meta.invocationSig, meta.invocationExplorer, 'Invocation')}
				</div>
				${meta.error ? `<div class="asc-hire-receipt-note">Receipt note: ${esc(truncMid(meta.error, 90))}</div>` : ''}
			</div>`;
	}

	function pushHistory(meta) {
		const provider = meta.providerName || 'provider';
		const ok = meta.phase === 'recorded';
		const cls = meta.phase === 'over_cap' ? 'amber' : meta.phase === 'failed' ? 'red' : 'ok';
		const link = meta.paymentExplorer
			? `<a href="${esc(meta.paymentExplorer)}" target="_blank" rel="noopener" data-stop-propagation>tx ↗</a>`
			: '';
		const row = document.createElement('div');
		row.className = `asc-hire-hrow ${cls}`;
		row.innerHTML = `
			<span class="t">${ok ? '✓' : cls === 'amber' ? '⚠' : '✕'}</span>
			<span class="m">${esc(truncMid(provider, 16))} · <code>${esc(truncMid(meta.slug || '', 16))}</code></span>
			<span class="u">${fmtUsd(meta.usd)}</span>
			${link}
		`;
		historyEl.prepend(row);
		while (historyEl.children.length > 12) historyEl.lastElementChild?.remove();
	}

	// Ingest one hire frame's meta. `live` true for a real-time frame, false for
	// reconnect backfill (no coin animation).
	function ingest(meta, { live = true } = {}) {
		if (!meta || meta.kind !== 'a2a_hire') return;
		renderCap(meta.cap);

		const id = meta.hireId || `${meta.slug}:${meta.providerId}`;
		const phaseIndex = typeof meta.phaseIndex === 'number' ? meta.phaseIndex : (STEP_INDEX[meta.phase] ?? 0);
		const isError = meta.phase === 'over_cap' || meta.phase === 'failed';

		// New hire, or a fresh hire replacing a settled one: archive the prior.
		if (cur && cur.id !== id) {
			done.set(cur.id, cur.meta);
			pushHistory(cur.meta);
			cur = null;
		}
		if (!cur) {
			cur = { id, meta, phaseIndex, coinFired: false };
		} else {
			// Same hire: drop stale/out-of-order happy-path frames.
			if (!isError && phaseIndex < cur.phaseIndex) return;
			cur.meta = { ...cur.meta, ...meta };
			cur.phaseIndex = Math.max(cur.phaseIndex, phaseIndex);
		}

		renderActive(cur.meta, { live });

		if (live && meta.phase === 'settled' && onSettled) {
			try { onSettled(cur.meta); } catch { /* viewer hook must not break the flow */ }
		}

		// Terminal: roll the active hire into history so the next hire starts clean.
		if (meta.phase === 'recorded' || isError) {
			done.set(id, cur.meta);
		}
	}

	function reset() {
		cur = null;
		done.clear();
		emptyEl.hidden = false;
		activeEl.hidden = true;
		activeEl.innerHTML = '';
		historyEl.innerHTML = '';
		capEl.hidden = true;
	}

	return { ingest, reset };
}
