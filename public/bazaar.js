// public/bazaar.js — discovery UI logic.
//
// Talks to /api/bazaar/list and /api/bazaar/search, renders normalized result
// cards, applies sidebar filters, and routes "Try it" through the drop-in
// x402.js modal so the same on-chain payment flow used elsewhere ships here
// too.

const $ = (sel) => document.querySelector(sel);

const els = {
	form: $('#search-form'),
	q: $('#q'),
	clear: $('#clear-btn'),
	type: $('#f-type'),
	network: $('#f-network'),
	max: $('#f-max'),
	ext: $('#f-ext'),
	sort: $('#f-sort'),
	reset: $('#reset-btn'),
	count: $('#count'),
	qlabel: $('#query-label'),
	sources: $('#sources'),
	results: $('#results'),
	empty: $('#empty'),
	moreRow: $('#more-row'),
	moreBtn: $('#more-btn'),
	moreNote: $('#more-note'),
	tryLive: $('#try-live'),
	modal: $('#details-modal'),
	modalTitle: $('#dm-title'),
	modalBody: $('#dm-body'),
	modalClose: $('#dm-close'),
};

// One page of results per request; the endpoints cap `limit` well below the
// live catalog size, so `offset` is how the rest of it is reachable at all.
const PAGE_SIZE = { list: 200, search: 100 };

const state = {
	lastQuery: '',
	items: [],
	peers: new Map(),
	total: 0,
	// Every request carries a sequence number and the newest one wins. Dropping a
	// filter change because an earlier request was still in flight left the
	// sidebar claiming a filter the rendered cards had never been through, and on
	// a slow connection that state stuck until the user touched a control again.
	seq: 0,
	inflight: null,
};

const STOP_WORDS = new Set([
	'api', 'apis', 'service', 'endpoint', 'endpoints', 'paid', 'free',
	'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'on', 'in', 'by',
	'tool', 'tools', 'mcp', 'http',
]);

function tokenize(s) {
	return String(s || '')
		.toLowerCase()
		.split(/[^a-z0-9]+/g)
		.map((w) => w.trim())
		.filter((w) => w && !STOP_WORDS.has(w) && w.length >= 2);
}

function tailFromUrl(url) {
	try {
		const u = new URL(url);
		const tail = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop() || '';
		return tail.replace(/-[a-z0-9]{4,12}$/i, '');
	} catch {
		return '';
	}
}

function capabilityKey(it) {
	if (it.type === 'mcp' && it.toolName) {
		const k = tokenize(it.toolName).join('');
		return k ? `mcp:${k}` : null;
	}
	const nameTokens = tokenize(it.serviceName).slice(0, 3);
	if (nameTokens.length && nameTokens.join('-').length >= 3) return `http:${nameTokens.join('-')}`;
	const urlTokens = tokenize(tailFromUrl(it.resource)).slice(0, 3);
	if (urlTokens.length >= 2 && urlTokens.join('-').length >= 6) return `http:${urlTokens.join('-')}`;
	return null;
}

function minUsdcAtomic(item) {
	const accepts = (item.accepts || []).filter((a) => {
		const sym = String(a?.assetInfo?.symbol || '').toUpperCase();
		return sym === 'USDC' || sym === '';
	});
	if (accepts.length === 0) return null;
	let min = null;
	for (const a of accepts) {
		const n = Number(a.amountAtomic);
		if (Number.isFinite(n) && n > 0 && (min == null || n < min)) min = n;
	}
	return min;
}

function priceLabel(atomic) {
	if (atomic == null) return '—';
	const n = atomic / 1_000_000;
	if (n === 0) return '0 USDC';
	if (n < 0.01) return `${n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
	if (n < 1) return `${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} USDC`;
	return `${n.toFixed(2)} USDC`;
}

function recomputePeers(items) {
	const groups = new Map();
	for (const it of items) {
		const k = capabilityKey(it);
		if (!k) continue;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(it);
	}
	state.peers = groups;
}

function computePeerHint(it) {
	const k = capabilityKey(it);
	if (!k) return null;
	const peers = state.peers.get(k);
	if (!peers || peers.length < 2) return null;
	const prices = peers.map(minUsdcAtomic).filter((n) => n != null);
	if (prices.length < 2) return null;
	const min = Math.min(...prices);
	const max = Math.max(...prices);
	const other = peers.length - 1;
	if (max === min) {
		return {
			count: other,
			label: `${other} peer${other === 1 ? '' : 's'} at same price`,
			minLabel: priceLabel(min),
			maxLabel: priceLabel(max),
		};
	}
	const spreadPct = ((max - min) / min) * 100;
	return {
		count: other,
		label: `${other} peer${other === 1 ? '' : 's'} · +${spreadPct.toFixed(0)}% spread`,
		minLabel: priceLabel(min),
		maxLabel: priceLabel(max),
	};
}

function readFilters() {
	return {
		type: els.type.value || 'http',
		network: els.network.value || '',
		maxPriceUsdc: els.max.value ? Number(els.max.value) : null,
		extension: els.ext.value || '',
		sort: els.sort.value || '',
	};
}

function paramsFor(query, f, offset) {
	const p = new URLSearchParams();
	if (query) p.set('query', query);
	p.set('type', f.type);
	if (f.network) p.set('network', f.network);
	if (f.maxPriceUsdc != null && !Number.isNaN(f.maxPriceUsdc)) {
		// USDC is 6 decimals; we store integers as strings to avoid float math.
		const atomic = Math.round(f.maxPriceUsdc * 1_000_000);
		p.set('maxPrice', String(atomic));
		p.set('asset', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'); // base USDC reference; backend matches by lowercase
	}
	if (f.extension) p.set('extension', f.extension);
	if (f.sort) p.set('sort', f.sort);
	p.set('maxItems', '500');
	p.set('limit', String(query ? PAGE_SIZE.search : PAGE_SIZE.list));
	if (offset > 0) p.set('offset', String(offset));
	return p;
}

// `append` keeps the rows already on screen and adds the next page after them,
// which is what the "Load more" button does; a fresh search replaces them.
async function load({ append = false } = {}) {
	const seq = ++state.seq;
	// A newer request replaces the one in flight rather than being dropped, so
	// what is on screen always matches the controls the user last touched.
	state.inflight?.abort();
	const controller = new AbortController();
	state.inflight = controller;
	const query = els.q.value.trim();
	state.lastQuery = query;
	const filters = readFilters();
	const endpoint = query ? '/api/bazaar/search' : '/api/bazaar/list';
	const offset = append ? state.items.length : 0;
	const url = `${endpoint}?${paramsFor(query, filters, offset).toString()}`;
	if (append) renderLoadingMore();
	else renderLoading(query);
	try {
		const r = await fetch(url, { headers: { accept: 'application/json' }, signal: controller.signal });
		const data = await r.json();
		if (seq !== state.seq) return;
		if (!r.ok) throw new Error(data?.error_description || data?.error || `HTTP ${r.status}`);
		const page = data.resources || data.items || [];
		state.items = append ? state.items.concat(page) : page;
		state.total = Number.isFinite(data.total) ? data.total : state.items.length;
		recomputePeers(state.items);
		renderResults(state.items, query, data.sources || [], data.errors || [], { append, page });
	} catch (e) {
		// A superseded request is not a failure the buyer needs to hear about:
		// the request that replaced it owns the screen now.
		if (e?.name === 'AbortError' || seq !== state.seq) return;
		if (append) renderLoadMoreError(e);
		else renderError(e);
	} finally {
		if (seq === state.seq) state.inflight = null;
	}
}

function renderLoading(query) {
	els.results.innerHTML = '';
	els.empty.hidden = true;
	els.moreRow.hidden = true;
	els.count.innerHTML = '<span class="spinner"></span>';
	els.qlabel.textContent = query ? `for "${query}"` : '';
	els.sources.textContent = '';
}

function renderLoadingMore() {
	els.moreBtn.disabled = true;
	els.moreBtn.textContent = 'Loading…';
	els.moreNote.textContent = '';
}

function renderError(e) {
	// Replace the spinner and any prior cards so a network failure can never
	// leave the loading state stuck.
	els.count.textContent = '0';
	els.qlabel.textContent = '';
	els.sources.textContent = '';
	els.results.innerHTML = '';
	els.moreRow.hidden = true;
	// fetch() rejects with a TypeError on offline / DNS / CORS failures — those
	// never reach `r.ok`, so call them out as a connection problem distinctly
	// from an HTTP/API error.
	const isNetwork = e instanceof TypeError;
	const title = isNetwork ? "Couldn't reach the catalog" : 'Failed to load services';
	const sub = isNetwork
		? 'Check your connection and try again.'
		: escape(e?.message || String(e));
	els.empty.hidden = false;
	els.empty.className = 'empty state-err';
	els.empty.innerHTML = `
		<div class="empty-title">${title}</div>
		<div class="empty-sub">${sub}</div>
		<button type="button" class="retry-btn">Retry</button>
	`;
	els.empty.querySelector('.retry-btn').addEventListener('click', () => {
		els.empty.className = 'empty';
		load();
	});
}

// A failed "Load more" must not discard the rows already on screen: keep them,
// put the button back, and say what went wrong next to it.
function renderLoadMoreError(e) {
	els.moreBtn.disabled = false;
	els.moreBtn.textContent = 'Load more';
	els.moreNote.textContent = e instanceof TypeError
		? "Couldn't reach the catalog. Try again."
		: `Could not load more: ${e?.message || e}`;
}

function renderResults(items, query, sources, errors, { append = false, page = [] } = {}) {
	els.count.textContent = String(items.length);
	els.qlabel.textContent = query ? `for "${query}"` : '';
	els.sources.innerHTML = sourcesLine(sources, errors);
	if (items.length === 0) {
		els.results.innerHTML = '';
		els.moreRow.hidden = true;
		els.empty.hidden = false;
		els.empty.className = 'empty';
		els.empty.textContent = 'No matching services. Try fewer filters or a different query.';
		return;
	}
	els.empty.hidden = true;
	const frag = document.createDocumentFragment();
	// Appending re-renders only the new page, so the peer hints on rows already
	// on screen stay as they were rather than every card being rebuilt.
	for (const it of (append ? page : items)) frag.appendChild(card(it));
	if (append) els.results.appendChild(frag);
	else els.results.replaceChildren(frag);
	renderMoreRow(items.length, append, page.length);
}

// The catalog is several times a single page, and reporting the page size as
// the result count read as "this is everything there is".
function renderMoreRow(shown, append, pageLength) {
	const total = Math.max(state.total, shown);
	els.count.textContent = total > shown ? `${shown} of ${total}` : String(shown);
	els.moreBtn.disabled = false;
	els.moreBtn.textContent = 'Load more';
	// A page that comes back empty means the catalog moved under us between
	// requests; stop offering a button that would fetch nothing again.
	if (shown >= total || (append && pageLength === 0)) {
		els.moreRow.hidden = true;
		els.moreNote.textContent = '';
		return;
	}
	els.moreRow.hidden = false;
	els.moreNote.textContent = `${total - shown} more`;
}

function sourcesLine(sources, errors) {
	const parts = sources.map((s) => {
		const host = safeHost(s.facilitator);
		return s.ok
			? `<span class="ok">${host} (${s.count})</span>`
			: `<span class="err">${host} (failed)</span>`;
	});
	if (errors.length) {
		for (const e of errors) {
			parts.push(`<span class="err" title="${escape(e.error)}">${safeHost(e.facilitator)} ✗</span>`);
		}
	}
	return parts.join(' · ');
}

function safeHost(u) {
	try { return new URL(u).host; } catch { return String(u); }
}

function card(it) {
	const el = document.createElement('div');
	el.className = 'card';

	const head = document.createElement('div');
	head.className = 'head';
	const icon = document.createElement('div');
	icon.className = 'icon';
	if (it.iconUrl) {
		const img = document.createElement('img');
		img.src = it.iconUrl;
		img.alt = '';
		img.referrerPolicy = 'no-referrer';
		img.onerror = () => {
			icon.textContent = initial(it);
			img.remove();
		};
		icon.appendChild(img);
	} else {
		icon.textContent = initial(it);
	}
	const titleBox = document.createElement('div');
	titleBox.style.flex = '1';
	titleBox.style.minWidth = '0';
	const title = document.createElement('div');
	title.className = 'title';
	title.textContent = it.serviceName || prettyTitle(it);
	const sub = document.createElement('div');
	sub.className = 'subtitle';
	sub.textContent = it.toolName ? `${it.toolName} — ${it.resource}` : it.resource;
	titleBox.append(title, sub);
	head.append(icon, titleBox);

	const desc = document.createElement('div');
	desc.className = 'desc';
	desc.textContent = it.description || '';

	const meta = document.createElement('div');
	meta.className = 'meta';
	if (it.minPriceLabel) meta.appendChild(tag('price', it.minPriceLabel));
	if (it.method) meta.appendChild(tag('method', it.method));
	for (const n of it.networks || []) meta.appendChild(tag('net', shortNet(n)));
	for (const ext of it.extensions || []) {
		if (ext === 'bazaar') continue; // implied
		meta.appendChild(tag('ext', ext));
	}

	const host = safeHost(it.resource);
	if (host) {
		const hostPill = document.createElement('a');
		hostPill.className = 'tag host';
		hostPill.href = `/providers?host=${encodeURIComponent(host)}`;
		hostPill.textContent = host;
		hostPill.title = `View ${host} profile`;
		meta.appendChild(hostPill);
	}

	const peerHint = computePeerHint(it);
	if (peerHint) {
		const a = document.createElement('a');
		a.className = 'peer-hint';
		a.href = `/arbitrage?focus=${encodeURIComponent(it.serviceName || it.toolName || '')}`;
		a.title = `${peerHint.count} similar listings, ${peerHint.minLabel}–${peerHint.maxLabel}`;
		a.textContent = peerHint.label;
		meta.appendChild(a);
	}

	const actions = document.createElement('div');
	actions.className = 'actions';
	const tryBtn = document.createElement('button');
	tryBtn.type = 'button';
	tryBtn.className = 'btn-pay';
	tryBtn.textContent = it.type === 'mcp' ? 'Inspect tool' : 'Try it';
	tryBtn.onclick = () => onTry(el, it, tryBtn);
	const detailsBtn = document.createElement('button');
	detailsBtn.type = 'button';
	detailsBtn.className = 'btn-details';
	detailsBtn.textContent = 'Details';
	detailsBtn.onclick = () => openDetails(it);
	actions.append(tryBtn, detailsBtn);

	const receipt = document.createElement('div');
	receipt.className = 'receipt';
	receipt.hidden = true;
	receipt.dataset.role = 'receipt';

	el.append(head, desc, meta, actions, receipt);
	return el;
}

function tag(kind, text) {
	const t = document.createElement('span');
	t.className = `tag ${kind}`;
	t.textContent = text;
	return t;
}

function shortNet(n) {
	if (!n) return '';
	if (n.startsWith('eip155:8453')) return 'base';
	if (n.startsWith('eip155:84532')) return 'base-sepolia';
	if (n.startsWith('eip155:42161')) return 'arbitrum';
	if (n.startsWith('eip155:10')) return 'optimism';
	if (n.startsWith('eip155:137')) return 'polygon';
	if (n.startsWith('solana')) return 'solana';
	return n;
}

function initial(it) {
	const s = (it.serviceName || it.resource || '?').replace(/^https?:\/\//, '');
	return s.charAt(0).toUpperCase() || '?';
}

function prettyTitle(it) {
	if (it.toolName) return it.toolName;
	try {
		const u = new URL(it.resource);
		const tail = u.pathname.replace(/\/$/, '').split('/').pop();
		return tail ? `${u.host} · ${tail}` : u.host;
	} catch {
		return it.resource || 'Untitled';
	}
}

// Polite screen-reader announcement for async "Try it" outcomes.
function announce(msg) {
	if (!els.tryLive) return;
	els.tryLive.textContent = '';
	// Force the live region to re-fire even when the text repeats.
	requestAnimationFrame(() => { els.tryLive.textContent = msg; });
}

// The pay flow depends on the drop-in modal in /x402.js. If that script 404s
// or fails to evaluate, window.X402 is never defined — feature-detect it so the
// button explains the problem instead of silently no-opping.
function x402Available() {
	return !!(window.X402 && typeof window.X402.pay === 'function');
}

async function onTry(cardEl, it, btn) {
	if (it.type === 'mcp') {
		// MCP tools require a JSON-RPC tools/call envelope, which the drop-in modal
		// doesn't speak. Show the details panel so callers can wire it themselves.
		openDetails(it);
		return;
	}
	const receipt = cardEl.querySelector('[data-role=receipt]');
	if (!x402Available()) {
		receipt.hidden = false;
		receipt.className = 'receipt err';
		receipt.textContent = 'Payment module failed to load (x402.js). Reload the page to retry.';
		announce('Payment module unavailable. Reload the page to try a paid call.');
		return;
	}
	receipt.hidden = false;
	receipt.className = 'receipt';
	receipt.textContent = 'Opening x402 payment modal…';
	announce(`Opening payment for ${it.serviceName || prettyTitle(it)}.`);
	btn.disabled = true;
	try {
		const opts = {
			endpoint: it.resource,
			method: it.input?.method || it.method || 'GET',
			merchant: safeHost(it.resource),
			action: it.serviceName || prettyTitle(it),
		};
		if (it.input?.body) opts.body = it.input.body;
		if (it.input?.queryParams && Object.keys(it.input.queryParams).length) {
			const u = new URL(opts.endpoint);
			for (const [k, v] of Object.entries(it.input.queryParams)) u.searchParams.set(k, String(v));
			opts.endpoint = u.toString();
		}
		const out = await window.X402.pay(opts);
		if (out?.ok) {
			receipt.className = 'receipt ok';
			receipt.innerHTML = renderReceipt(out);
			announce(`Payment succeeded for ${it.serviceName || prettyTitle(it)}.`);
		} else {
			receipt.className = 'receipt err';
			receipt.textContent = `Failed: ${out?.error || 'unknown error'}`;
			announce(`Payment failed: ${out?.error || 'unknown error'}.`);
		}
	} catch (e) {
		if (e?.code === 'cancelled') {
			receipt.hidden = true;
			announce('Payment cancelled.');
		} else {
			receipt.className = 'receipt err';
			receipt.textContent = `Error: ${e?.message || e}`;
			announce(`Payment error: ${e?.message || e}.`);
		}
	} finally {
		btn.disabled = false;
	}
}

function renderReceipt(out) {
	const tx = out.payment?.transaction || out.payment?.tx || '';
	const net = out.payment?.network || '';
	const explorer = explorerLink(net, tx);
	const head = explorer
		? `<a href="${explorer}" target="_blank" rel="noopener">on-chain receipt</a> · ${escape(net)} · ${escape(short(tx))}`
		: `paid${net ? ` on ${escape(net)}` : ''}${tx ? ' · ' + escape(short(tx)) : ''}`;
	const body = typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 2);
	return `${head}\n\n${escape(body)}`;
}

function explorerLink(net, tx) {
	if (!tx) return null;
	if (net.startsWith('solana')) return `https://solscan.io/tx/${tx}`;
	if (net.includes('8453')) return `https://basescan.org/tx/${tx}`;
	if (net.includes('84532')) return `https://sepolia.basescan.org/tx/${tx}`;
	if (net.includes('42161')) return `https://arbiscan.io/tx/${tx}`;
	if (net.includes('10')) return `https://optimistic.etherscan.io/tx/${tx}`;
	if (net.includes('137')) return `https://polygonscan.com/tx/${tx}`;
	return null;
}

function short(s) {
	if (!s) return '';
	return s.length > 14 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s;
}

function escape(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function openDetails(it) {
	els.modalTitle.textContent = it.serviceName || prettyTitle(it);
	const pre = document.createElement('pre');
	pre.textContent = JSON.stringify(it.raw, null, 2);
	const summary = document.createElement('div');
	summary.style.marginBottom = '12px';
	summary.style.fontSize = '13px';
	summary.style.color = 'var(--muted)';
	const host = safeHost(it.resource);
	summary.innerHTML = `
		<div><strong style="color:var(--text)">${escape(it.resource)}</strong></div>
		<div>type: ${escape(it.type)}${it.toolName ? ' · tool: ' + escape(it.toolName) : ''} · method: ${escape(it.method || '')}</div>
		<div>networks: ${(it.networks || []).map(escape).join(', ')}</div>
		<div>price: ${escape(it.minPriceLabel || '—')}</div>
		<div>provider: <a href="/providers?host=${encodeURIComponent(host)}">${escape(host)}</a> · facilitator: ${escape(safeHost(it.facilitator))}</div>
	`;

	const ctx = document.createElement('div');
	ctx.className = 'ctx loading';
	ctx.innerHTML = `
		<div class="head">
			<span class="dot"></span>
			<span>What's the context?</span>
		</div>
		<div class="body">Reading the catalog…</div>
	`;
	els.modalBody.replaceChildren(summary, ctx, pre);
	if (typeof els.modal.showModal === 'function') els.modal.showModal();
	fetchContext(it, ctx);
}

async function fetchContext(it, ctxEl) {
	const params = new URLSearchParams({ resource: it.resource });
	if (it.toolName) params.set('toolName', it.toolName);
	try {
		const r = await fetch(`/api/bazaar/context?${params.toString()}`);
		const data = await r.json();
		if (!r.ok) throw new Error(data?.error_description || data?.error || `HTTP ${r.status}`);
		renderContext(ctxEl, data);
	} catch (e) {
		ctxEl.className = 'ctx err';
		ctxEl.querySelector('.body').textContent = `Couldn't load context: ${e?.message || e}`;
	}
}

function renderContext(ctxEl, data) {
	const sentiment = ['up', 'down'].includes(data.sentiment) ? data.sentiment : 'neutral';
	const cits = Array.isArray(data.citations) ? data.citations : [];
	const summaryHtml = renderCitedText(data.summary || '', cits);
	const stats = data.stats || {};
	const statBits = [];
	if (typeof stats.peerCount === 'number') statBits.push(`<strong>${stats.peerCount}</strong> peer${stats.peerCount === 1 ? '' : 's'}`);
	if (typeof stats.providerSiblingsCount === 'number') statBits.push(`<strong>${stats.providerSiblingsCount}</strong> sibling${stats.providerSiblingsCount === 1 ? '' : 's'}`);
	if (typeof stats.pricePercentile === 'number') statBits.push(`<strong>P${stats.pricePercentile}</strong> by price`);

	ctxEl.className = 'ctx';
	ctxEl.innerHTML = `
		<div class="head">
			<span class="dot"></span>
			<span>What's the context?</span>
			<span class="pill ${sentiment}">${sentiment}</span>
		</div>
		<div class="body">${summaryHtml}</div>
		${statBits.length ? `<div class="stat-row">${statBits.join('<span>·</span>')}</div>` : ''}
		${cits.length ? `<div class="citations">${cits.map((c, i) => {
			const ext = c.external ? ' target="_blank" rel="noopener"' : '';
			return `<a href="${escape(c.url)}"${ext}><strong>[${i + 1}]</strong>${escape(c.label)}</a>`;
		}).join('')}</div>` : ''}
	`;
}

function renderCitedText(text, citations) {
	const safe = escape(text);
	return safe.replace(/\[(\d+)\]/g, (_, n) => {
		const idx = Number(n) - 1;
		const cit = citations[idx];
		if (!cit) return `<span class="cite">${n}</span>`;
		const ext = cit.external ? ' target="_blank" rel="noopener"' : '';
		return `<a class="cite" href="${escape(cit.url)}"${ext} title="${escape(cit.label)}">${n}</a>`;
	});
}

els.modalClose.addEventListener('click', () => els.modal.close());
els.modal.addEventListener('click', (e) => {
	const rect = els.modal.getBoundingClientRect();
	if (e.clientY < rect.top || e.clientY > rect.bottom || e.clientX < rect.left || e.clientX > rect.right) {
		els.modal.close();
	}
});

els.moreBtn.addEventListener('click', () => load({ append: true }));
els.form.addEventListener('submit', (e) => { e.preventDefault(); load(); });
els.clear.addEventListener('click', () => { els.q.value = ''; load(); });
els.reset.addEventListener('click', () => {
	els.type.value = 'http';
	els.network.value = '';
	els.max.value = '';
	els.ext.value = '';
	els.sort.value = '';
	els.q.value = '';
	load();
});
[els.type, els.network, els.max, els.ext, els.sort].forEach((el) => {
	const ev = el.tagName === 'SELECT' ? 'change' : 'input';
	let t;
	el.addEventListener(ev, () => {
		clearTimeout(t);
		t = setTimeout(load, 200);
	});
});

// Inbound deep links carry the search they want run: /arbitrage sends
// /bazaar?q=<capability>&type=<http|mcp> from its "Avoid" and MCP actions, and
// the same shape makes any bazaar search shareable. Without this the query
// string was decorative and every deep link landed on the unfiltered catalog.
function applyDeepLink() {
	const p = new URLSearchParams(location.search);
	const q = p.get('q') || p.get('query') || '';
	if (q) els.q.value = q;
	const type = String(p.get('type') || '').toLowerCase();
	if (type === 'http' || type === 'mcp') els.type.value = type;
	const network = p.get('network');
	if (network && [...els.network.options].some((o) => o.value === network)) els.network.value = network;
}

// Initial render.
applyDeepLink();
load();
