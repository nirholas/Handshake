// /portfolio: live portfolio viewer for any Solana or Ethereum wallet.
//
// Data flow: address (form input, ?address= deep link, or a recent-wallet chip)
// -> GET /api/crypto/portfolio?address=&chain= (api/crypto/portfolio.js, built
// on api/_lib/balances.js + api/_lib/portfolio-overview.js) -> hero value card,
// stable/major/token summary, allocation donut, holdings table. Series colors
// are the dataviz-validated categorical slots defined in src/portfolio.css;
// the server assigns slot ranks, the CSS supplies the theme-stepped hex.

import { updateValue, enterStagger } from './ui-juice.js';
import { formatUsd, formatPrice, formatPercent, formatSupply, timeAgo, escapeHtml } from './shared/coin-format.js';
import { createLogger } from './shared/log.js';

const log = createLogger('portfolio');
const $ = (id) => document.getElementById(id);

const RECENT_KEY = 'twx_portfolio_recent';
const RECENT_MAX = 5;
const SMALL_SHARE_PCT = 1;

const EXPLORERS = {
	solana: (a) => `https://solscan.io/account/${a}`,
	ethereum: (a) => `https://etherscan.io/address/${a}`,
};

const state = {
	address: '',
	chain: 'solana',
	data: null,
	showSmall: false,
	loading: false,
};

/* ---------------- address helpers ---------------- */

const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function detectChain(address) {
	if (EVM_RE.test(address)) return 'ethereum';
	if (SOLANA_RE.test(address)) return 'solana';
	return null;
}

function shortAddr(a) {
	return a.length > 13 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function loadRecent() {
	try {
		const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
		return Array.isArray(list) ? list.filter((r) => r && detectChain(r.address)) : [];
	} catch {
		return [];
	}
}

function saveRecent(address, chain) {
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
	const wrap = $('pf-recent');
	if (!list.length) {
		wrap.hidden = true;
		return;
	}
	wrap.hidden = false;
	$('pf-recent-list').innerHTML = list
		.map(
			(r) =>
				`<button type="button" class="pf-recent-chip" data-address="${escapeHtml(r.address)}" data-chain="${escapeHtml(r.chain)}" title="${escapeHtml(r.address)}">${escapeHtml(shortAddr(r.address))}</button>`,
		)
		.join(' ');
}

/* ---------------- view switching ---------------- */

function show(view) {
	$('pf-intro').hidden = view !== 'intro';
	$('pf-report').hidden = view !== 'report';
	$('pf-loading').hidden = view !== 'loading';
	$('pf-error').hidden = view !== 'error';
	$('pf-empty').hidden = view !== 'empty';
}

/* ---------------- data ---------------- */

async function lookup(address, chain, { push = true } = {}) {
	if (state.loading) return;
	state.loading = true;
	state.address = address;
	state.chain = chain;
	$('pf-address').value = address;
	$('pf-chain').value = chain;
	show('loading');

	if (push) {
		const q = new URLSearchParams({ address, chain });
		history.replaceState(null, '', `/portfolio?${q}`);
	}

	try {
		const res = await fetch(`/api/crypto/portfolio?address=${encodeURIComponent(address)}&chain=${chain}`, {
			headers: { accept: 'application/json' },
		});
		const body = await res.json().catch(() => null);
		if (!res.ok) {
			renderError(res.status, body);
			return;
		}
		state.data = body;
		saveRecent(address, chain);
		if (!body.rows.length) {
			$('pf-empty-chain').textContent = body.chain === 'solana' ? 'Solana' : 'Ethereum';
			show('empty');
			return;
		}
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
	const title = $('pf-error-title');
	const msg = $('pf-error-body');
	if (status === 400) {
		title.textContent = 'That address does not look right';
		msg.textContent = body?.error?.message || body?.message || 'Check the address and chain, then try again.';
	} else if (status === 429) {
		title.textContent = 'Slow down a moment';
		msg.textContent = 'Too many lookups in a short burst. Wait a few seconds and retry.';
	} else if (status === 503) {
		title.textContent = 'Data source unavailable';
		msg.textContent = body?.error?.message || body?.message || 'The balance sources for this chain are unreachable right now. Retry shortly.';
	} else {
		title.textContent = 'Could not load this wallet';
		msg.textContent = 'The request failed before reaching the data sources. Check your connection and retry.';
	}
	show('error');
}

/* ---------------- report rendering ---------------- */

function renderReport(d) {
	const report = $('pf-report');
	report.classList.remove('pf-enter');
	void report.offsetWidth;
	report.classList.add('pf-enter');

	$('pf-stale').hidden = !d.stale;

	const addrEl = $('pf-addr');
	addrEl.textContent = shortAddr(d.address);
	addrEl.title = d.address;
	$('pf-chain-tag').textContent = d.chain;
	$('pf-explorer').href = EXPLORERS[d.chain](d.address);

	updateValue($('pf-total'), d.totalUsd, (v) => formatUsd(v));

	const pill = $('pf-change');
	const note = $('pf-change-note');
	if (d.change24h) {
		const up = d.change24h.usd >= 0;
		pill.hidden = false;
		pill.className = `pf-change-pill ${up ? 'up' : 'down'}`;
		pill.innerHTML = `<span aria-hidden="true">${up ? '▲' : '▼'}</span> ${escapeHtml(formatUsd(Math.abs(d.change24h.usd)))} (${escapeHtml(formatPercent(d.change24h.pct))}) <span class="pf-visually-hidden">${up ? 'up' : 'down'} in the last 24 hours</span>`;
		note.hidden = false;
		note.textContent =
			d.change24h.coveragePct >= 99.5
				? 'past 24h'
				: `past 24h, based on ${d.change24h.coveragePct}% of value`;
	} else {
		pill.hidden = true;
		note.hidden = false;
		note.textContent = 'No 24h price history is available for these holdings.';
	}

	for (const key of ['stable', 'major', 'other']) {
		const s = d.summary[key];
		$(`pf-sum-${key}`).textContent = formatUsd(s.usd);
		$(`pf-sum-${key}-sub`).textContent = s.count
			? `${s.pct}% · ${s.count} asset${s.count === 1 ? '' : 's'}`
			: 'none held';
	}

	renderDonut(d);
	renderMeta(d);
	renderTable(d);

	enterStagger($('pf-rows').querySelectorAll('tr'));
}

/* ---------------- donut ---------------- */

function segColor(slot) {
	return slot === 0 ? 'var(--pf-series-other)' : `var(--pf-series-${slot})`;
}

function arcPath(cx, cy, rOuter, rInner, a0, a1) {
	const large = a1 - a0 > Math.PI ? 1 : 0;
	const p = (r, a) => `${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
	return [
		`M ${p(rOuter, a0)}`,
		`A ${rOuter} ${rOuter} 0 ${large} 1 ${p(rOuter, a1)}`,
		`L ${p(rInner, a1)}`,
		`A ${rInner} ${rInner} 0 ${large} 0 ${p(rInner, a0)}`,
		'Z',
	].join(' ');
}

function renderDonut(d) {
	const svg = $('pf-donut');
	const assets = d.topAssets;
	$('pf-alloc-sub').textContent = `top ${Math.min(assets.length, 5)} of ${d.tokenCount} holdings`;

	const total = assets.reduce((s, a) => s + a.usd, 0);
	if (!(total > 0)) {
		svg.innerHTML = '';
		$('pf-legend').innerHTML = '<li class="pf-muted">Nothing priced yet.</li>';
		$('pf-donut-center').innerHTML = '';
		return;
	}

	let angle = -Math.PI / 2;
	const paths = assets.map((a, i) => {
		const sweep = (a.usd / total) * Math.PI * 2;
		const path = arcPath(60, 60, 56, 36, angle, angle + sweep);
		angle += sweep;
		return `<path d="${path}" style="fill:${segColor(a.slot)}" stroke="var(--cv-surface-2, #131316)" stroke-width="2" data-i="${i}" tabindex="0" role="img" aria-label="${escapeHtml(a.symbol)}: ${a.pct}% (${escapeHtml(formatUsd(a.usd))})"></path>`;
	});
	svg.innerHTML = paths.join('');
	svg.setAttribute(
		'aria-label',
		`Portfolio allocation: ${assets.map((a) => `${a.symbol} ${a.pct}%`).join(', ')}`,
	);

	$('pf-donut-center').innerHTML = `<b>${escapeHtml(formatUsd(d.totalUsd))}</b><span>total</span>`;

	$('pf-legend').innerHTML = assets
		.map(
			(a) => `<li>
				<i style="--c:${segColor(a.slot)}" aria-hidden="true"></i>
				<span class="sym">${escapeHtml(a.symbol)}${a.slot === 0 && a.count ? ` <span class="pf-muted">(${a.count})</span>` : ''}</span>
				<span class="pct">${a.pct}%</span>
				<span class="val">${escapeHtml(formatUsd(a.usd))}</span>
			</li>`,
		)
		.join('');

	wireDonutHover(svg, assets);
}

let tipEl = null;
function tip() {
	if (!tipEl) {
		tipEl = document.createElement('div');
		tipEl.className = 'pf-tip';
		tipEl.hidden = true;
		document.body.appendChild(tipEl);
	}
	return tipEl;
}

function wireDonutHover(svg, assets) {
	const t = tip();
	const showTip = (seg, x, y) => {
		const a = assets[Number(seg.dataset.i)];
		if (!a) return;
		svg.classList.add('pf-donut-focus');
		svg.querySelectorAll('path').forEach((p) => p.classList.toggle('pf-seg-active', p === seg));
		t.innerHTML = `<b>${escapeHtml(a.symbol)}</b> ${a.pct}%<br /><span class="sub">${escapeHtml(formatUsd(a.usd))}</span>`;
		t.hidden = false;
		const pad = 12;
		t.style.left = `${Math.min(x + pad, window.innerWidth - t.offsetWidth - pad)}px`;
		t.style.top = `${Math.max(y - t.offsetHeight - pad, pad)}px`;
	};
	const hideTip = () => {
		svg.classList.remove('pf-donut-focus');
		svg.querySelectorAll('path').forEach((p) => p.classList.remove('pf-seg-active'));
		t.hidden = true;
	};
	svg.onmousemove = (e) => {
		const seg = e.target.closest('path');
		if (seg) showTip(seg, e.clientX, e.clientY);
		else hideTip();
	};
	svg.onmouseleave = hideTip;
	svg.onfocusin = (e) => {
		const seg = e.target.closest('path');
		if (!seg) return;
		const r = seg.getBoundingClientRect();
		showTip(seg, r.left + r.width / 2, r.top);
	};
	svg.onfocusout = hideTip;
}

/* ---------------- meta + table ---------------- */

function renderMeta(d) {
	const rows = [
		['Chain', d.chain === 'solana' ? 'Solana' : 'Ethereum'],
		['Holdings', String(d.tokenCount)],
		['Unpriced', d.unpricedCount ? `${d.unpricedCount} token${d.unpricedCount === 1 ? '' : 's'}` : 'none'],
		['24h coverage', d.change24h ? `${d.change24h.coveragePct}% of value` : 'unavailable'],
		['Updated', timeAgo(d.ts) || 'just now'],
		['Sources', d.sources.join(', ')],
	];
	if (d.truncated) rows.splice(2, 0, ['Shown', `top ${d.rows.length} by value`]);
	$('pf-meta').innerHTML = rows
		.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
		.join('');
}

function slotForSymbol(d, symbol) {
	const hit = d.topAssets.find((a) => a.slot > 0 && a.symbol === symbol);
	return hit ? hit.slot : 0;
}

function renderTable(d) {
	const all = d.rows;
	const visible = state.showSmall ? all : all.filter((r) => r.sharePct >= SMALL_SHARE_PCT || r.kind === 'native');
	const hiddenCount = all.length - visible.length;

	$('pf-holdings-count').textContent = `${visible.length} of ${d.tokenCount}`;
	$('pf-rows').innerHTML = visible.map((r) => rowHtml(d, r)).join('');

	const banner = $('pf-small-banner');
	if (!state.showSmall && hiddenCount > 0) {
		banner.hidden = false;
		banner.textContent = `${hiddenCount} balance${hiddenCount === 1 ? '' : 's'} under ${SMALL_SHARE_PCT}% hidden · show all`;
	} else {
		banner.hidden = true;
	}
}

function rowHtml(d, r) {
	const slot = slotForSymbol(d, r.symbol);
	const sym = r.symbol || (r.id ? `${r.id.slice(0, 6)}…` : '?');
	const logo = r.logo
		? `<img src="${escapeHtml(r.logo)}" alt="" loading="lazy" data-ph="${escapeHtml(sym.slice(0, 3))}" />`
		: `<span class="ph">${escapeHtml(sym.slice(0, 3))}</span>`;
	const chg =
		r.change24h == null
			? '<span class="pf-chg na">n/a</span>'
			: `<span class="pf-chg ${r.change24h >= 0 ? 'up' : 'down'}">${escapeHtml(formatPercent(r.change24h))}</span>`;
	const price = r.price == null ? '<span class="pf-muted">unpriced</span>' : escapeHtml(formatPrice(r.price));
	const value = r.usd == null ? '<span class="pf-muted">n/a</span>' : escapeHtml(formatUsd(r.usd));
	return `<tr>
		<td>
			<span class="pf-asset">
				${logo}
				<span>
					<span class="sym">${escapeHtml(sym)}${r.kind === 'native' ? '<span class="pf-badge">native</span>' : ''}</span>
					${r.name ? `<span class="name">${escapeHtml(r.name)}</span>` : ''}
				</span>
			</span>
		</td>
		<td>
			<span class="pf-share-bar"><span style="--c:${segColor(slot)};width:${Math.max(r.sharePct, 0.5)}%"></span></span>
			<span class="pf-share-pct">${r.sharePct}%</span>
		</td>
		<td>${escapeHtml(formatSupply(r.amount))}</td>
		<td>${price}</td>
		<td>${chg}</td>
		<td class="pf-val">${value}</td>
	</tr>`;
}

/* ---------------- wiring ---------------- */

function submit(raw) {
	const address = raw.trim();
	if (!address) {
		$('pf-address').focus();
		return;
	}
	const detected = detectChain(address);
	if (!detected) {
		renderError(400, { message: 'Not a valid Solana or Ethereum address.' });
		return;
	}
	lookup(address, detected);
}

function init() {
	renderRecent();

	// Broken token logos collapse to a monogram placeholder. Error events do not
	// bubble, so this listens in the capture phase over the whole table body.
	$('pf-rows').addEventListener(
		'error',
		(e) => {
			const img = e.target;
			if (img?.tagName !== 'IMG') return;
			const ph = document.createElement('span');
			ph.className = 'ph';
			ph.textContent = img.dataset.ph || '?';
			img.replaceWith(ph);
		},
		true,
	);

	$('pf-form').addEventListener('submit', (e) => {
		e.preventDefault();
		submit($('pf-address').value);
	});

	// The select is a manual override for the rare address shape that is valid
	// on both families; typing an address re-detects on submit.
	$('pf-chain').addEventListener('change', () => {
		const address = $('pf-address').value.trim();
		if (address && detectChain(address)) lookup(address, $('pf-chain').value);
	});

	$('pf-recent').addEventListener('click', (e) => {
		const chip = e.target.closest('.pf-recent-chip');
		if (chip) lookup(chip.dataset.address, chip.dataset.chain);
	});

	$('pf-retry').addEventListener('click', () => {
		if (state.address) lookup(state.address, state.chain);
		else show('intro');
	});

	$('pf-show-small').addEventListener('change', (e) => {
		state.showSmall = e.target.checked;
		if (state.data) renderTable(state.data);
	});
	$('pf-small-banner').addEventListener('click', () => {
		state.showSmall = true;
		$('pf-show-small').checked = true;
		if (state.data) renderTable(state.data);
	});

	$('pf-copy-addr').addEventListener('click', async () => {
		if (!state.data) return;
		await copyWithFeedback($('pf-copy-addr'), state.data.address, 'Copied');
	});
	$('pf-share').addEventListener('click', async () => {
		await copyWithFeedback($('pf-share'), location.href, 'Link copied');
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === '/' && !/^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')) {
			e.preventDefault();
			$('pf-address').focus();
		}
	});

	const params = new URLSearchParams(location.search);
	const address = (params.get('address') || '').trim();
	if (address && detectChain(address)) {
		const chain = ['solana', 'ethereum'].includes(params.get('chain')) ? params.get('chain') : detectChain(address);
		lookup(address, chain, { push: false });
	} else {
		show('intro');
	}
}

async function copyWithFeedback(btn, text, doneLabel) {
	const original = btn.textContent;
	try {
		await navigator.clipboard.writeText(text);
		btn.textContent = doneLabel;
		btn.classList.add('pf-chip-ok');
	} catch {
		btn.textContent = 'Copy failed';
	}
	setTimeout(() => {
		btn.textContent = original;
		btn.classList.remove('pf-chip-ok');
	}, 1600);
}

init();
