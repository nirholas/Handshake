// /airdrops: airdrop eligibility checker for any Solana or Ethereum wallet.
//
// Data flow: address (form, ?address= deep link, recent chip) -> GET
// /api/crypto/airdrops (api/crypto/airdrops.js: wallet-activity scan +
// airdrop-eligibility scoring over data/airdrops.json) -> overview ring,
// measured-activity stat cards, filterable program cards with met/missing/
// manual checklists. With no address the page shows the tracked-program
// directory from the same endpoint. Shares the recent-wallet list with
// /portfolio (same localStorage key) so the two surfaces feel like one tool.

import { enterStagger } from './ui-juice.js';
import { formatUsd, timeAgo, escapeHtml } from './shared/coin-format.js';
import { createLogger } from './shared/log.js';

const log = createLogger('airdrops');
const $ = (id) => document.getElementById(id);

const RECENT_KEY = 'twx_portfolio_recent';
const RECENT_MAX = 5;

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const state = {
	address: '',
	data: null,
	filter: 'all',
	loading: false,
};

function detectFamily(address) {
	if (EVM_RE.test(address)) return 'evm';
	if (SOLANA_RE.test(address)) return 'solana';
	return null;
}

function shortAddr(a) {
	return a.length > 13 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/* ---------------- recents (shared with /portfolio) ---------------- */

function loadRecent() {
	try {
		const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
		return Array.isArray(list) ? list.filter((r) => r && detectFamily(r.address)) : [];
	} catch {
		return [];
	}
}

function saveRecent(address) {
	const chain = detectFamily(address) === 'evm' ? 'ethereum' : 'solana';
	const list = loadRecent().filter((r) => r.address !== address);
	list.unshift({ address, chain });
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_MAX)));
	} catch {
		/* storage full or blocked: recents are a convenience, not state */
	}
	renderRecent();
}

function renderRecent() {
	const list = loadRecent();
	const wrap = $('ad-recent');
	if (!list.length) {
		wrap.hidden = true;
		return;
	}
	wrap.hidden = false;
	$('ad-recent-list').innerHTML = list
		.map(
			(r) =>
				`<button type="button" class="ad-recent-chip" data-address="${escapeHtml(r.address)}" title="${escapeHtml(r.address)}">${escapeHtml(shortAddr(r.address))}</button>`,
		)
		.join(' ');
}

/* ---------------- view switching ---------------- */

function show(view) {
	$('ad-directory').hidden = view !== 'directory';
	$('ad-report').hidden = view !== 'report';
	$('ad-loading').hidden = view !== 'loading';
	$('ad-error').hidden = view !== 'error';
}

/* ---------------- directory (no-address state) ---------------- */

async function loadDirectory() {
	show('loading');
	try {
		const res = await fetch('/api/crypto/airdrops', { headers: { accept: 'application/json' } });
		const body = await res.json().catch(() => null);
		if (!res.ok) return renderError(res.status, body);
		$('ad-dir-sub').textContent = `${body.registry.length} programs · registry updated ${body.updated}`;
		$('ad-dir-grid').innerHTML = body.registry.map((e) => directoryCard(e)).join('');
		show('directory');
		enterStagger($('ad-dir-grid').children);
	} catch (err) {
		log.warn('directory load failed', err);
		renderError(0, null);
	}
}

function statusLabel(s) {
	return s === 'confirmed' ? 'Confirmed' : s === 'upcoming' ? 'Upcoming' : 'Speculation';
}

function directoryCard(e) {
	return `<article class="ad-card">
		<div class="ad-card-top">
			<span class="ad-card-name">${escapeHtml(e.name)}</span>
			<span class="ad-card-chain">${escapeHtml(e.chain)}</span>
			<span class="ad-status" data-s="${escapeHtml(e.status)}">${statusLabel(e.status)}</span>
		</div>
		<ul class="ad-crit">
			${(e.criteria || []).map((c) => `<li><span class="u" aria-hidden="true">•</span><span class="txt">${escapeHtml(c.description)}</span></li>`).join('')}
		</ul>
		${e.note ? `<p class="ad-card-note">${escapeHtml(e.note)}</p>` : ''}
		<div class="ad-card-foot">
			<span class="ad-card-est">${e.estimatedValue ? `Est. ${escapeHtml(e.estimatedValue)}` : ''}</span>
			<a class="ad-card-src" href="${escapeHtml(e.source)}" target="_blank" rel="noopener noreferrer nofollow">Site ↗</a>
		</div>
	</article>`;
}

/* ---------------- lookup ---------------- */

async function lookup(address, { push = true } = {}) {
	if (state.loading) return;
	state.loading = true;
	state.address = address;
	$('ad-address').value = address;
	show('loading');
	if (push) history.replaceState(null, '', `/airdrops?address=${encodeURIComponent(address)}`);

	try {
		const res = await fetch(`/api/crypto/airdrops?address=${encodeURIComponent(address)}`, {
			headers: { accept: 'application/json' },
		});
		const body = await res.json().catch(() => null);
		if (!res.ok) {
			renderError(res.status, body);
			return;
		}
		state.data = body;
		state.filter = 'all';
		saveRecent(address);
		renderReport(body);
		show('report');
	} catch (err) {
		log.warn('lookup failed', err);
		renderError(0, null);
	} finally {
		state.loading = false;
	}
}

function renderError(status, body) {
	const title = $('ad-error-title');
	const msg = $('ad-error-body');
	if (status === 400) {
		title.textContent = 'That address does not look right';
		msg.textContent = body?.error?.message || body?.message || 'Check the address and try again.';
	} else if (status === 429) {
		title.textContent = 'Slow down a moment';
		msg.textContent = 'Too many scans in a short burst. Wait a few seconds and retry.';
	} else if (status === 503) {
		title.textContent = 'Scan source unavailable';
		msg.textContent = body?.error?.message || body?.message || 'The activity sources are unreachable right now. Retry shortly.';
	} else {
		title.textContent = 'Could not scan this wallet';
		msg.textContent = 'The request failed before reaching the data sources. Check your connection and retry.';
	}
	show('error');
}

/* ---------------- report ---------------- */

function renderReport(d) {
	const report = $('ad-report');
	report.classList.remove('ad-enter');
	void report.offsetWidth;
	report.classList.add('ad-enter');

	const addrEl = $('ad-addr');
	addrEl.textContent = shortAddr(d.address);
	addrEl.title = d.address;
	$('ad-chain-tag').textContent = d.family === 'solana' ? 'solana' : 'evm';
	$('ad-portfolio-link').href = `/portfolio?address=${encodeURIComponent(d.address)}`;

	renderRing(d.summary);
	const est = $('ad-est');
	const estLabel = $('ad-est-label');
	if (d.summary.estimatedValue) {
		estLabel.textContent = `Estimated across ${d.summary.estimatedValue.entries} qualified program${d.summary.estimatedValue.entries === 1 ? '' : 's'} (public speculation, not a promise)`;
		est.textContent = `${formatUsd(d.summary.estimatedValue.lo)} - ${formatUsd(d.summary.estimatedValue.hi)}`;
	} else {
		estLabel.textContent = 'Tracking';
		est.textContent = `${d.summary.tracked} program${d.summary.tracked === 1 ? '' : 's'} on this chain family`;
	}
	$('ad-c-qualified').textContent = d.summary.qualified;
	$('ad-c-progress').textContent = d.summary.in_progress;
	$('ad-c-not').textContent = d.summary.not_eligible;
	$('ad-c-tracked').textContent = d.summary.tracked;

	renderActivity(d);
	renderCards();
	renderOtherFamily(d);

	$('ad-report-fineprint').textContent =
		`Registry updated ${d.registryUpdated} · scanned ${timeAgo(d.ts) || 'just now'} · ` +
		'Statuses and criteria are public reporting, not endorsements; estimated ranges are speculation, not promises. ' +
		'Scores reflect only what an on-chain scan can measure; protocol-specific steps are listed as manual to-dos.';
}

function renderRing(summary) {
	const svg = $('ad-ring');
	const pct = summary.tracked > 0 ? summary.qualified / summary.tracked : 0;
	const r = 52;
	const c = 2 * Math.PI * r;
	svg.innerHTML = `
		<circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--cv-surface-3, #1c1c21)" stroke-width="10"></circle>
		<circle cx="60" cy="60" r="${r}" fill="none" stroke="var(--ad-q)" stroke-width="10" stroke-linecap="round"
			stroke-dasharray="${(pct * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 60 60)"></circle>`;
	svg.setAttribute(
		'aria-label',
		`Qualified for ${summary.qualified} of ${summary.tracked} tracked airdrops`,
	);
	$('ad-ring-center').innerHTML = `<b>${summary.qualified}/${summary.tracked}</b><span>qualified</span>`;
}

function renderActivity(d) {
	const a = d.activity;
	const fmtN = (v) => (v == null ? null : Number(v).toLocaleString('en-US'));
	const stats = [
		['Transactions', fmtN(a.tx_count), a.capped ? 'minimum, scan capped' : null],
		['Active days', fmtN(a.days_active), null],
		['Wallet age', a.account_age_days == null ? null : `${fmtN(a.account_age_days)}d`, null],
		['Last active', a.last_active_days == null ? null : a.last_active_days === 0 ? 'today' : `${fmtN(a.last_active_days)}d ago`, null],
		['Tokens held', fmtN(a.unique_tokens), null],
		['Chains active', fmtN(a.chains_active), Array.isArray(a.chains) && a.chains.length ? a.chains.join(', ') : null],
		['Contract calls', fmtN(a.contract_interactions), null],
		['Native volume', a.volume_usd == null ? null : formatUsd(a.volume_usd), null],
	];
	$('ad-stats').innerHTML = stats
		.map(
			([k, v, sub]) => `<div class="ad-stat">
				<div class="k">${escapeHtml(k)}</div>
				<div class="v${v == null ? ' na' : ''}">${v == null ? 'not measured' : escapeHtml(v)}</div>
				${sub ? `<div class="k">${escapeHtml(sub)}</div>` : ''}
			</div>`,
		)
		.join('');
	$('ad-act-note').textContent = a.capped
		? 'Scan hit its history cap; totals are honest minimums.'
		: 'Fields a scan cannot measure are shown as such, never guessed.';
}

function eligLabel(e) {
	return e === 'qualified' ? '✓ Qualified' : e === 'in_progress' ? 'In progress' : 'Not eligible';
}

function scoreColor(e) {
	return e === 'qualified' ? 'var(--ad-q)' : e === 'in_progress' ? 'var(--ad-p)' : 'var(--ad-n)';
}

function renderCards() {
	const d = state.data;
	const list = state.filter === 'all'
		? d.opportunities
		: d.opportunities.filter((o) => o.eligibility === state.filter);
	const grid = $('ad-grid');
	if (!list.length) {
		grid.innerHTML = `<p class="ad-empty-filter">No programs in this bucket for this wallet. Try another filter.</p>`;
		return;
	}
	grid.innerHTML = list.map((o) => opportunityCard(o)).join('');
	enterStagger(grid.children);
}

function opportunityCard(o) {
	const nextStep = o.missing.find((m) => !m.unknown)?.recommendation || o.missing[0]?.recommendation || null;
	return `<article class="ad-card">
		<div class="ad-card-top">
			<span class="ad-card-name">${escapeHtml(o.name)}</span>
			<span class="ad-card-chain">${escapeHtml(o.chain)}</span>
			<span class="ad-status" data-s="${escapeHtml(o.status)}">${statusLabel(o.status)}</span>
		</div>
		<div class="ad-score-row">
			<span class="ad-elig" data-e="${escapeHtml(o.eligibility)}">${eligLabel(o.eligibility)}</span>
			<span class="ad-score-bar"><span style="--c:${scoreColor(o.eligibility)};width:${Math.max(o.score, 2)}%"></span></span>
			<span class="ad-score-num">${o.score}%</span>
		</div>
		<ul class="ad-crit">
			${o.met.map((c) => `<li class="done"><span class="m" aria-hidden="true">✓</span><span class="txt">${escapeHtml(c.description)}</span></li>`).join('')}
			${o.missing.map((c) => `<li><span class="${c.unknown ? 'u' : 'x'}" aria-hidden="true">${c.unknown ? '?' : '✗'}</span><span class="txt">${escapeHtml(c.description)}${c.unknown ? ' (not measurable on-chain)' : ''}</span></li>`).join('')}
		</ul>
		${nextStep && o.eligibility !== 'qualified' ? `<p class="ad-next"><strong>Next:</strong> ${escapeHtml(nextStep)}</p>` : ''}
		${o.manual.length ? `<p class="ad-manual"><b>Do this yourself:</b> ${o.manual.map((m) => escapeHtml(m.description)).join(' · ')}</p>` : ''}
		${o.note ? `<p class="ad-card-note">${escapeHtml(o.note)}</p>` : ''}
		<div class="ad-card-foot">
			<span class="ad-card-est">${o.estimatedValue ? `Est. ${escapeHtml(o.estimatedValue)}` : ''}</span>
			<a class="ad-card-src" href="${escapeHtml(o.source)}" target="_blank" rel="noopener noreferrer nofollow">Site ↗</a>
		</div>
	</article>`;
}

function renderOtherFamily(d) {
	const wrap = $('ad-other');
	if (!d.otherFamily.length) {
		wrap.hidden = true;
		return;
	}
	wrap.hidden = false;
	const other = d.family === 'solana' ? 'an EVM' : 'a Solana';
	$('ad-other-sub').textContent = `These programs live on the other chain family. Check them with ${other} wallet.`;
	$('ad-other-grid').innerHTML = d.otherFamily.map((e) => directoryCard(e)).join('');
}

/* ---------------- wiring ---------------- */

function submit(raw) {
	const address = raw.trim();
	if (!address) {
		$('ad-address').focus();
		return;
	}
	if (!detectFamily(address)) {
		renderError(400, { message: 'Not a valid Solana or Ethereum address.' });
		return;
	}
	lookup(address);
}

async function copyWithFeedback(btn, text, doneLabel) {
	const original = btn.textContent;
	try {
		await navigator.clipboard.writeText(text);
		btn.textContent = doneLabel;
		btn.classList.add('ad-chip-ok');
	} catch {
		btn.textContent = 'Copy failed';
	}
	setTimeout(() => {
		btn.textContent = original;
		btn.classList.remove('ad-chip-ok');
	}, 1600);
}

function init() {
	renderRecent();

	$('ad-form').addEventListener('submit', (e) => {
		e.preventDefault();
		submit($('ad-address').value);
	});

	$('ad-recent').addEventListener('click', (e) => {
		const chip = e.target.closest('.ad-recent-chip');
		if (chip) lookup(chip.dataset.address);
	});

	$('ad-retry').addEventListener('click', () => {
		if (state.address) lookup(state.address);
		else loadDirectory();
	});

	document.querySelectorAll('.ad-filter').forEach((btn) => {
		btn.addEventListener('click', () => {
			state.filter = btn.dataset.filter;
			document.querySelectorAll('.ad-filter').forEach((b) => {
				b.classList.toggle('active', b === btn);
				b.setAttribute('aria-pressed', String(b === btn));
			});
			if (state.data) renderCards();
		});
	});

	$('ad-copy-addr').addEventListener('click', () => {
		if (state.data) copyWithFeedback($('ad-copy-addr'), state.data.address, 'Copied');
	});
	$('ad-share').addEventListener('click', () => {
		copyWithFeedback($('ad-share'), location.href, 'Link copied');
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === '/' && !/^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')) {
			e.preventDefault();
			$('ad-address').focus();
		}
	});

	const params = new URLSearchParams(location.search);
	const address = (params.get('address') || '').trim();
	if (address && detectFamily(address)) lookup(address, { push: false });
	else loadDirectory();
}

init();
