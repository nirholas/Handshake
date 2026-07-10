// x402 Studio — the merchant console for the "Stripe of x402".
//
// One page to run a paid x402 business on three.ws: products (SKUs), payout +
// agent wallets, a drag-and-drop storefront, an embeddable button builder,
// security/CORS, and charity + round-up giving. Everything here is wired to real
// endpoints — /api/x402-merchant (settings), /api/x402-skus (products),
// /api/x402/pay-by-name (USDC sends), /api/sns (name resolution). No mocks.

const SOLANA_WEB3 = 'https://esm.sh/@solana/web3.js@1.95.3?bundle';
const USDC_DECIMALS = 6;

const S = {
	settings: null,
	skus: [],
	tab: 'overview',
};

// ---------------------------------------------------------------- helpers ----
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function el(tag, attrs = {}, ...kids) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (k === 'class') n.className = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (v != null && v !== false) n.setAttribute(k, v === true ? '' : v);
	}
	for (const kid of kids.flat()) if (kid != null) n.append(kid.nodeType ? kid : document.createTextNode(kid));
	return n;
}
function uid(prefix = 'w') {
	const a = new Uint8Array(6);
	crypto.getRandomValues(a);
	return prefix + '_' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}
function shortAddr(a) {
	if (!a) return '—';
	return a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-5) : a;
}
function fmtUsdc(atomics, decimals = USDC_DECIMALS) {
	const n = Number(atomics || 0) / 10 ** decimals;
	if (!isFinite(n)) return '0';
	if (n === 0) return '0';
	if (n < 0.01) return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
	return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function toAtomics(human, decimals = USDC_DECIMALS) {
	const n = Number(human);
	if (!isFinite(n) || n < 0) return null;
	return Math.round(n * 10 ** decimals).toString();
}
function b64ToBytes(b64) {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
const isEvm = (a) => /^0x[0-9a-fA-F]{40}$/.test(a || '');
const isSol = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a || '');

function toast(msg, kind = 'ok') {
	const host = $('#toasts');
	const t = el('div', { class: `toast ${kind}` }, msg);
	host.append(t);
	setTimeout(() => {
		t.style.transition = 'opacity .3s, transform .3s';
		t.style.opacity = '0';
		t.style.transform = 'translateX(20px)';
		setTimeout(() => t.remove(), 320);
	}, 3600);
}

async function api(path, { method = 'GET', body } = {}) {
	const res = await fetch(path, {
		method,
		credentials: 'include',
		headers: body ? { 'content-type': 'application/json' } : undefined,
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let data = {};
	try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
	if (!res.ok) {
		const e = new Error(data.error_description || data.error || `Request failed (${res.status})`);
		e.status = res.status;
		e.data = data;
		throw e;
	}
	return data;
}

async function copy(text, label = 'Copied') {
	try {
		await navigator.clipboard.writeText(text);
		toast(label);
	} catch {
		toast('Copy failed — select manually', 'err');
	}
}

// ---------------------------------------------------------------- boot --------
async function boot() {
	try {
		const { settings } = await api('/api/x402-merchant');
		S.settings = settings;
	} catch (e) {
		if (e.status === 401) return renderSignIn();
		return renderFatal(e.message);
	}
	try {
		const { skus } = await api('/api/x402-skus');
		S.skus = skus || [];
	} catch {
		S.skus = [];
	}
	renderShell();
	go(location.hash.replace('#', '') || 'overview');
}

function renderSignIn() {
	$('#root').innerHTML = '';
	$('#root').append(
		el('div', { class: 'empty', style: 'min-height:100dvh;display:grid;place-content:center;max-width:420px;margin:0 auto;padding:24px' },
			el('div', { class: 'ico' }, '🔑'),
			el('h3', {}, 'Sign in to open x402 Studio'),
			el('p', { class: 'sub' }, 'Your products, wallets, and storefront live on your three.ws account. Sign in to configure them.'),
			el('a', { class: 'btn primary', href: `/login?next=${encodeURIComponent('/x402/studio')}`, style: 'margin-top:8px' }, 'Sign in →'),
		),
	);
}
function renderFatal(msg) {
	$('#root').innerHTML = '';
	$('#root').append(
		el('div', { class: 'empty', style: 'min-height:100dvh;display:grid;place-content:center;max-width:460px;margin:0 auto;padding:24px' },
			el('div', { class: 'ico' }, '⚠️'),
			el('h3', {}, 'Studio could not load'),
			el('p', { class: 'sub' }, msg),
			el('button', { class: 'btn ghost', onclick: () => location.reload() }, 'Retry'),
		),
	);
}

// ---------------------------------------------------------------- shell -------
const TABS = [
	{ id: 'overview', label: 'Overview', ic: '◆' },
	{ id: 'products', label: 'Products', ic: '⬡' },
	{ id: 'wallets', label: 'Wallets', ic: '◈' },
	{ id: 'store', label: 'Storefront', ic: '▦' },
	{ id: 'embed', label: 'Embed builder', ic: '⌘' },
	{ id: 'giving', label: 'Giving', ic: '♥' },
	{ id: 'settings', label: 'Security & API', ic: '⚙' },
];

function renderShell() {
	const root = $('#root');
	root.innerHTML = '';
	const nav = el('nav', { class: 'nav' });
	for (const t of TABS) {
		nav.append(el('button', { 'data-tab': t.id, onclick: () => go(t.id) }, el('span', { class: 'ic' }, t.ic), t.label));
	}
	const side = el('aside', { class: 'side' },
		el('a', { class: 'brand', href: '/' },
			el('div', { class: 'mark' }, 'x4'),
			el('div', { class: 'name', html: 'x402 Studio<small>the stripe of x402</small>' }),
		),
		nav,
		el('div', { class: 'foot', html: 'On-chain USDC settlement · <a href="/x402">about x402</a> · <a href="/dashboard/x402">classic dashboard</a>' }),
	);
	const topbar = el('header', { class: 'topbar' },
		el('h1', { id: 'tab-title' }, 'Overview'),
		el('span', { class: 'spacer' }),
		el('a', { class: 'btn ghost sm', id: 'view-store', href: '#', target: '_blank', style: 'display:none' }, 'View storefront ↗'),
		el('button', { class: 'btn primary sm', onclick: () => go('products') }, '+ New product'),
	);
	const content = el('div', { class: 'content', id: 'content' });
	for (const t of TABS) content.append(el('section', { id: `sec-${t.id}` }));
	root.append(el('div', { class: 'app' }, side, el('main', { class: 'main' }, topbar, content)));
	updateStoreLink();
}

function updateStoreLink() {
	const a = $('#view-store');
	if (!a) return;
	if (S.settings?.store_published && S.settings?.store_handle) {
		a.href = `/store/${S.settings.store_handle}`;
		a.style.display = '';
	} else a.style.display = 'none';
}

const RENDERERS = {
	overview: renderOverview,
	products: renderProducts,
	wallets: renderWallets,
	store: renderStore,
	embed: renderEmbed,
	giving: renderGiving,
	settings: renderSettings,
};

function go(tab) {
	if (!RENDERERS[tab]) tab = 'overview';
	S.tab = tab;
	history.replaceState(null, '', `#${tab}`);
	$$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
	$$('.content section').forEach((s) => s.classList.toggle('show', s.id === `sec-${tab}`));
	$('#tab-title').textContent = TABS.find((t) => t.id === tab)?.label || 'Overview';
	RENDERERS[tab]($(`#sec-${tab}`));
	$('#content').scrollTo?.({ top: 0 });
}

// PUT a partial settings patch, refresh local state.
async function saveSettings(patch, okMsg = 'Saved') {
	const { settings } = await api('/api/x402-merchant', { method: 'PUT', body: patch });
	S.settings = settings;
	updateStoreLink();
	toast(okMsg);
	return settings;
}

// ---------------------------------------------------------------- overview ----
function renderOverview(host) {
	const totalCalls = S.skus.reduce((a, s) => a + (s.paid_calls || 0), 0);
	const gross = S.skus.reduce((a, s) => a + Number(s.gross_atomics || 0), 0);
	const active = S.skus.filter((s) => s.active).length;
	const m = S.settings || {};
	const payoutSet = !!(m.payout_solana || m.payout_evm);
	const agents = (m.agent_wallets || []).length;

	host.innerHTML = '';
	host.append(
		el('div', { class: 'banner' },
			el('span', { class: 'ic' }, '✦'),
			el('div', { html: 'Welcome to <b>x402 Studio</b> — build products, point them at a payout wallet, drop a pay button onto any site, and publish a storefront. Settlement happens on-chain in USDC.' }),
		),
		el('div', { class: 'stat-grid' },
			stat('Gross settled', `$${fmtUsdc(gross)}`, `${totalCalls} paid call${totalCalls === 1 ? '' : 's'}`),
			stat('Products', String(S.skus.length), `${active} active`),
			stat('Agent wallets', String(agents), 'autopay + payout'),
			stat('Payout', payoutSet ? 'Configured' : 'Not set', m.default_network ? `default: ${m.default_network}` : 'set a wallet'),
		),
	);

	// Checklist of setup steps — each links to the relevant tab.
	const steps = [
		{ done: payoutSet, label: 'Add a payout wallet', tab: 'wallets', hint: 'Where settled USDC lands' },
		{ done: S.skus.length > 0, label: 'Create your first product', tab: 'products', hint: 'A paid endpoint or checkout link' },
		{ done: !!m.business_name, label: 'Set your branding', tab: 'settings', hint: 'Name + logo on every checkout' },
		{ done: !!m.store_published, label: 'Publish a storefront', tab: 'store', hint: 'A shareable /store page' },
	];
	const checklist = el('div', { class: 'card' }, el('h2', {}, 'Get set up'), el('p', { class: 'sub' }, 'Four steps to a live x402 business.'));
	for (const st of steps) {
		checklist.append(
			el('div', { class: 'list-item', style: 'cursor:pointer', onclick: () => go(st.tab) },
				el('div', { class: 'avatar', style: `background:${st.done ? 'color-mix(in oklab,var(--success) 30%,transparent)' : 'var(--surface-3)'};color:${st.done ? 'var(--success)' : 'var(--ink-faint)'}` }, st.done ? '✓' : '○'),
				el('div', { class: 'meta' }, el('div', { class: 't' }, st.label), el('div', { class: 's' }, st.hint)),
				el('div', { class: 'acts' }, el('span', { class: `pill ${st.done ? 'ok' : ''}` }, st.done ? 'Done' : 'To do')),
			),
		);
	}
	host.append(checklist);

	// Per-product performance.
	const perf = el('div', { class: 'card' }, el('h2', {}, 'Product performance'));
	if (!S.skus.length) {
		perf.append(emptyState('⬡', 'No products yet', 'Create a product to start accepting payments.', 'Create product', () => go('products')));
	} else {
		const table = el('table', {}, el('thead', {}, el('tr', {}, el('th', {}, 'Product'), el('th', {}, 'Network'), el('th', {}, 'Paid calls'), el('th', {}, 'Gross'), el('th', {}, ''))));
		const tb = el('tbody');
		for (const s of [...S.skus].sort((a, b) => Number(b.gross_atomics || 0) - Number(a.gross_atomics || 0))) {
			tb.append(el('tr', {},
				el('td', {}, el('b', { style: 'color:var(--ink-bright)' }, s.merchant_name || s.slug), el('div', { class: 's', style: 'color:var(--ink-dim);font-size:var(--text-sm)' }, s.action_name || '')),
				el('td', {}, el('span', { class: 'pill' }, s.price_network || '—')),
				el('td', {}, String(s.paid_calls || 0)),
				el('td', {}, `$${fmtUsdc(s.gross_atomics)}`),
				el('td', { style: 'text-align:right' }, el('a', { class: 'btn ghost sm', href: `/pay/c/${esc(s.slug)}`, target: '_blank' }, 'Open ↗')),
			));
		}
		table.append(tb);
		perf.append(table);
	}
	host.append(perf);
}

function stat(k, v, d) {
	return el('div', { class: 'stat' }, el('div', { class: 'k' }, k), el('div', { class: 'v' }, v), el('div', { class: 'd' }, d || ''));
}
function emptyState(ico, title, body, btnLabel, onClick) {
	return el('div', { class: 'empty' },
		el('div', { class: 'ico' }, ico),
		el('h3', {}, title),
		el('p', { class: 'sub' }, body),
		btnLabel ? el('button', { class: 'btn primary', onclick: onClick }, btnLabel) : null,
	);
}

// ---------------------------------------------------------------- products ----
function renderProducts(host) {
	host.innerHTML = '';
	host.append(
		el('div', { class: 'section-head' },
			el('div', {}, el('h2', { style: 'font-size:var(--text-lg)' }, 'Products'), el('p', { class: 'sub', style: 'margin:0' }, 'Each product is a paid x402 endpoint with a hosted checkout at /pay/c/<slug>.')),
			el('span', { class: 'spacer' }),
			el('button', { class: 'btn primary', onclick: () => productModal() }, '+ New product'),
		),
	);
	if (!S.skus.length) {
		host.append(el('div', { class: 'card' }, emptyState('⬡', 'No products yet', 'A product points the modal at your paid endpoint and gives you a shareable checkout link.', 'Create your first product', () => productModal())));
		return;
	}
	const wrap = el('div', { class: 'card' });
	for (const s of S.skus) {
		const accent = s.accent_color || '#0a84ff';
		wrap.append(
			el('div', { class: 'list-item' },
				el('div', { class: 'avatar', style: `background:linear-gradient(135deg, ${accent}, ${accent}aa)` }, s.logo_url ? el('img', { src: s.logo_url, alt: '', onerror: function () { this.replaceWith(document.createTextNode((s.merchant_name || '·')[0])); } }) : (s.merchant_name || '·')[0]),
				el('div', { class: 'meta' },
					el('div', { class: 't' }, s.merchant_name || s.slug, s.active ? '' : el('span', { class: 'pill warn', style: 'margin-left:8px' }, 'inactive')),
					el('div', { class: 's' }, `${s.action_name || ''} · /pay/c/${s.slug} · ${s.paid_calls || 0} calls · $${fmtUsdc(s.gross_atomics)}`),
				),
				el('div', { class: 'acts' },
					el('button', { class: 'btn ghost sm', onclick: () => copy(`${location.origin}/pay/c/${s.slug}`, 'Checkout link copied') }, 'Copy link'),
					el('button', { class: 'btn ghost sm', onclick: () => { EMBED.sku = s.id; go('embed'); } }, 'Embed'),
					el('button', { class: 'btn ghost sm', onclick: () => productModal(s) }, 'Edit'),
				),
			),
		);
	}
	host.append(wrap);
}

function productModal(sku = null) {
	const editing = !!sku;
	const v = sku || { target_method: 'GET', accent_color: '#0a84ff', active: true };
	const body = el('div', {},
		field('Display name', input({ id: 'p_merchant', value: v.merchant_name || '', placeholder: 'Acme Summaries', maxlength: 80 }), 'Shown on the checkout header'),
		field('Action label', input({ id: 'p_action', value: v.action_name || '', placeholder: 'Summarize article', maxlength: 80 }), 'The button text — what the buyer gets'),
		field('URL slug', input({ id: 'p_slug', value: v.slug || '', placeholder: 'acme-summarize', maxlength: 64, ...(editing ? { disabled: true } : {}) }), editing ? 'Slug is permanent' : 'Lowercase, hyphenated. Becomes /pay/c/<slug>'),
		el('div', { class: 'cols-2' },
			field('Paid endpoint (returns 402)', input({ id: 'p_endpoint', value: v.target_endpoint || '', placeholder: 'https://api.acme.com/paid/x', type: 'url' })),
			field('Method', select('p_method', ['GET', 'POST'], v.target_method || 'GET')),
		),
		field('Request body (JSON, POST only)', textarea({ id: 'p_body', value: v.target_body ? JSON.stringify(v.target_body, null, 2) : '', placeholder: '{ "url": "https://…" }' }), 'Sent with the paid request'),
		field('Description', textarea({ id: 'p_desc', value: v.description || '', placeholder: 'What the buyer receives', maxlength: 2000 })),
		el('div', { class: 'cols-2' },
			field('Logo URL', input({ id: 'p_logo', value: v.logo_url || '', placeholder: 'https://…/logo.png', type: 'url' })),
			field('Accent', input({ id: 'p_accent', value: v.accent_color || '#0a84ff', type: 'color' })),
		),
		el('div', { class: 'cols-2' },
			field('Success redirect (optional)', input({ id: 'p_success', value: v.success_url || '', placeholder: 'https://acme.com/thanks', type: 'url' })),
			field('Active', switchEl('p_active', v.active !== false, 'Accepting payments')),
		),
	);
	const actions = [
		editing ? el('button', { class: 'btn danger', onclick: () => archiveProduct(sku, close) }, 'Archive') : null,
		el('span', { class: 'spacer', style: 'margin-left:auto' }),
		el('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
		el('button', { class: 'btn primary', id: 'p_save', onclick: () => saveProduct(editing, sku, close) }, editing ? 'Save changes' : 'Create product'),
	];
	const close = openModal(editing ? 'Edit product' : 'New product', body, actions);
}

async function saveProduct(editing, sku, close) {
	const btn = $('#p_save');
	btn.disabled = true;
	try {
		const bodyRaw = $('#p_body').value.trim();
		let target_body;
		if (bodyRaw) {
			try { target_body = JSON.parse(bodyRaw); } catch { throw new Error('Request body is not valid JSON'); }
		}
		const patch = {
			merchant_name: $('#p_merchant').value.trim(),
			action_name: $('#p_action').value.trim(),
			target_endpoint: $('#p_endpoint').value.trim(),
			target_method: $('#p_method').value,
			description: $('#p_desc').value.trim() || undefined,
			logo_url: $('#p_logo').value.trim() || undefined,
			accent_color: $('#p_accent').value,
			success_url: $('#p_success').value.trim() || undefined,
			active: $('#p_active').checked,
		};
		if (target_body) patch.target_body = target_body;
		if (!patch.merchant_name || !patch.action_name) throw new Error('Name and action label are required');
		if (!patch.target_endpoint) throw new Error('A paid endpoint is required');

		if (editing) {
			await api(`/api/x402-skus?id=${sku.id}`, { method: 'PATCH', body: patch });
		} else {
			patch.slug = $('#p_slug').value.trim();
			if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(patch.slug)) throw new Error('Slug must be lowercase, hyphenated, 3–64 chars');
			await api('/api/x402-skus', { method: 'POST', body: patch });
		}
		const { skus } = await api('/api/x402-skus');
		S.skus = skus || [];
		close();
		toast(editing ? 'Product updated' : 'Product created');
		renderProducts($('#sec-products'));
	} catch (e) {
		toast(e.message, 'err');
		btn.disabled = false;
	}
}
async function archiveProduct(sku, close) {
	if (!confirm(`Archive “${sku.merchant_name || sku.slug}”? Its checkout link stops accepting payments.`)) return;
	try {
		await api(`/api/x402-skus?id=${sku.id}`, { method: 'DELETE' });
		S.skus = S.skus.filter((s) => s.id !== sku.id);
		close();
		toast('Product archived');
		renderProducts($('#sec-products'));
	} catch (e) {
		toast(e.message, 'err');
	}
}

// ---------------------------------------------------------------- wallets -----
function renderWallets(host) {
	const m = S.settings || {};
	host.innerHTML = '';

	// Payout wallets — where settled funds land.
	const payout = el('div', { class: 'card' },
		el('h2', {}, 'Payout wallets'),
		el('p', { class: 'sub' }, 'The most important setting on the platform: where settled USDC arrives. A wrong address sends real money to the wrong place.'),
		el('div', { class: 'cols-2' },
			field('Solana payout (USDC)', solAddrField('po_sol', m.payout_solana || '')),
			field('Base / EVM payout (USDC)', input({ id: 'po_evm', value: m.payout_evm || '', placeholder: '0x…', class: 'mono' })),
		),
		field('Default settlement network', select('po_net', ['solana', 'base'], m.default_network || 'solana')),
		el('div', { class: 'row', style: 'margin-top:4px' }, el('button', { class: 'btn primary', id: 'po_save', onclick: savePayout }, 'Save payout wallets')),
	);
	host.append(payout);

	// Agent wallets — the fleet that auto-pays / receives with per-wallet caps.
	const agentCard = el('div', { class: 'card' },
		el('div', { class: 'section-head' },
			el('div', {}, el('h2', {}, 'Agent wallets'), el('p', { class: 'sub', style: 'margin:0' }, 'Named on-chain identities authorized to auto-pay (buyer) or receive (seller) on your behalf — each capped independently. The heart of an autonomous x402 business.')),
			el('span', { class: 'spacer' }),
			el('button', { class: 'btn primary sm', onclick: () => agentWalletModal() }, '+ Add agent wallet'),
		),
	);
	const wallets = m.agent_wallets || [];
	if (!wallets.length) {
		agentCard.append(emptyState('◈', 'No agent wallets', 'Add a wallet your agents may use to pay for services or to receive payouts, bounded by a per-call and daily cap.', 'Add agent wallet', () => agentWalletModal()));
	} else {
		for (const w of wallets) {
			agentCard.append(
				el('div', { class: 'list-item' },
					el('div', { class: 'avatar', style: `background:${w.role === 'payer' ? 'linear-gradient(135deg,#6366f1,#0a84ff)' : 'linear-gradient(135deg,#10b981,#059669)'}` }, w.role === 'payer' ? '↑' : '↓'),
					el('div', { class: 'meta' },
						el('div', { class: 't' }, esc(w.label), el('span', { class: `pill ${w.enabled ? 'ok' : 'warn'}`, style: 'margin-left:8px' }, w.enabled ? 'enabled' : 'paused')),
						el('div', { class: 's mono' }, `${w.chain} · ${w.role} · ${shortAddr(w.address)}${w.per_call_cap_atomics ? ` · ≤$${fmtUsdc(w.per_call_cap_atomics)}/call` : ''}${w.daily_cap_atomics ? ` · ≤$${fmtUsdc(w.daily_cap_atomics)}/day` : ''}`),
					),
					el('div', { class: 'acts' },
						el('button', { class: 'btn ghost sm', onclick: () => agentWalletModal(w) }, 'Edit'),
						el('button', { class: 'btn danger sm', onclick: () => removeAgentWallet(w.id) }, 'Remove'),
					),
				),
			);
		}
	}
	host.append(agentCard);

	// Move money — deposit (receive) + send USDC by name/address via Phantom.
	host.append(renderMoneyTools(m));
}

function solAddrField(id, value) {
	// Solana address input with an SNS (.sol / @name) resolver button.
	const inp = input({ id, value, placeholder: 'Solana address or name.sol', class: 'mono' });
	const status = el('div', { class: 'hint', id: `${id}_status` });
	const resolveBtn = el('button', { class: 'btn ghost sm', type: 'button', onclick: async () => {
		const raw = inp.value.trim();
		if (!raw) return;
		if (isSol(raw)) { status.textContent = 'Looks like a valid Solana address.'; return; }
		resolveBtn.disabled = true; status.textContent = 'Resolving…';
		try {
			const { data } = await api(`/api/sns?name=${encodeURIComponent(raw.replace(/^@/, ''))}`);
			if (data?.resolved && data.address) { inp.value = data.address; status.innerHTML = `Resolved <b>${esc(raw)}</b> → ${shortAddr(data.address)}`; }
			else status.textContent = `Could not resolve “${raw}”.`;
		} catch { status.textContent = 'Resolution failed.'; }
		resolveBtn.disabled = false;
	} }, 'Resolve .sol');
	return el('div', {}, el('div', { class: 'row', style: 'gap:8px;align-items:stretch' }, el('div', { style: 'flex:1' }, inp), resolveBtn), status);
}

function renderMoneyTools(m) {
	const card = el('div', { class: 'card' }, el('h2', {}, 'Move money'), el('p', { class: 'sub' }, 'Receive funds to your payout wallet, or send USDC to any address or .sol name with your connected wallet.'));
	const grid = el('div', { class: 'cols-2' });

	// Receive / deposit
	const recvAddr = m.payout_solana || m.payout_evm || '';
	const recv = el('div', {},
		el('h4', { style: 'font-size:var(--text-md);margin-bottom:8px' }, 'Receive'),
		recvAddr
			? el('div', {},
				el('div', { class: 'code', style: 'padding:14px' }, recvAddr),
				el('div', { class: 'row', style: 'margin-top:8px' },
					el('button', { class: 'btn ghost sm', onclick: () => copy(recvAddr, 'Address copied') }, 'Copy address'),
					m.payout_solana ? el('a', { class: 'btn ghost sm', href: `https://solscan.io/account/${m.payout_solana}`, target: '_blank' }, 'View on Solscan ↗') : null,
				),
				el('p', { class: 'hint', style: 'margin-top:8px' }, 'Send USDC to this address to fund your wallet. This is your default payout destination.'),
			)
			: el('p', { class: 'sub' }, 'Set a payout wallet above to get a receive address.'),
	);

	// Send USDC by name/address (Phantom, Solana)
	const send = el('div', {},
		el('h4', { style: 'font-size:var(--text-md);margin-bottom:8px' }, 'Send USDC (Solana)'),
		field('To', input({ id: 'send_to', placeholder: 'address, name.sol, or @handle', class: 'mono' })),
		field('Amount (USDC)', input({ id: 'send_amt', type: 'number', min: '0', step: '0.01', placeholder: '1.00' })),
		el('button', { class: 'btn primary', id: 'send_btn', onclick: sendUsdc }, 'Send with Phantom'),
		el('div', { class: 'hint', id: 'send_status', style: 'margin-top:8px' }),
	);

	grid.append(recv, send);
	card.append(grid);
	return card;
}

async function sendUsdc() {
	const to = $('#send_to').value.trim();
	const amt = $('#send_amt').value.trim();
	const status = $('#send_status');
	const btn = $('#send_btn');
	if (!to) return toast('Enter a recipient', 'err');
	if (!(Number(amt) > 0)) return toast('Enter an amount', 'err');
	const provider = window.phantom?.solana || window.solana;
	if (!provider?.isPhantom) {
		status.innerHTML = 'Phantom wallet not detected. <a href="https://phantom.app" target="_blank">Install Phantom</a> or use <a href="/pay">pay-by-name</a>.';
		return;
	}
	btn.disabled = true;
	try {
		status.textContent = 'Connecting wallet…';
		const { publicKey } = await provider.connect();
		status.textContent = 'Building transfer…';
		const { data } = await api('/api/x402/pay-by-name', { method: 'POST', body: { name: to.replace(/^@/, ''), amount_usdc: Number(amt), mode: 'prep', payer_wallet: publicKey.toString() } });
		status.innerHTML = `Sending <b>${data.amount_usdc} USDC</b> → ${shortAddr(data.recipient?.address)}. Approve in Phantom…`;
		const web3 = await import(/* @vite-ignore */ SOLANA_WEB3);
		const tx = web3.VersionedTransaction.deserialize(b64ToBytes(data.tx_base64));
		const { signature } = await provider.signAndSendTransaction(tx);
		status.innerHTML = `✓ Sent. <a href="https://solscan.io/tx/${signature}" target="_blank">View on Solscan ↗</a>`;
		toast('USDC sent');
		$('#send_amt').value = '';
	} catch (e) {
		status.textContent = e?.message?.includes('User rejected') ? 'Cancelled.' : `Failed: ${e.message || e}`;
	}
	btn.disabled = false;
}

async function savePayout() {
	const btn = $('#po_save');
	btn.disabled = true;
	try {
		const sol = $('#po_sol').value.trim();
		const evm = $('#po_evm').value.trim();
		if (sol && !isSol(sol)) throw new Error('Solana payout is not a valid address');
		if (evm && !isEvm(evm)) throw new Error('EVM payout is not a valid 0x address');
		await saveSettings({ payout_solana: sol || null, payout_evm: evm || null, default_network: $('#po_net').value }, 'Payout wallets saved');
		renderWallets($('#sec-wallets'));
	} catch (e) {
		toast(e.message, 'err');
		btn.disabled = false;
	}
}

function agentWalletModal(w = null) {
	const editing = !!w;
	const v = w || { chain: 'solana', role: 'payer', enabled: true };
	const body = el('div', {},
		field('Label', input({ id: 'aw_label', value: v.label || '', placeholder: 'Research autopay', maxlength: 60 })),
		el('div', { class: 'cols-2' },
			field('Chain', select('aw_chain', ['solana', 'base'], v.chain || 'solana')),
			field('Role', select('aw_role', ['payer', 'payout'], v.role || 'payer', { payer: 'payer — auto-pays for services', payout: 'payout — receives funds' })),
		),
		field('Address', input({ id: 'aw_addr', value: v.address || '', placeholder: 'wallet address', class: 'mono' }), 'Must match the chain above'),
		el('div', { class: 'cols-2' },
			field('Per-call cap (USDC)', input({ id: 'aw_call', value: v.per_call_cap_atomics ? fmtUsdc(v.per_call_cap_atomics) : '', type: 'number', min: '0', step: '0.01', placeholder: 'no cap' }), 'Max a single payment may move'),
			field('Daily cap (USDC)', input({ id: 'aw_day', value: v.daily_cap_atomics ? fmtUsdc(v.daily_cap_atomics) : '', type: 'number', min: '0', step: '0.01', placeholder: 'no cap' }), 'Max in a rolling 24h'),
		),
		field('', switchEl('aw_enabled', v.enabled !== false, 'Enabled — may transact')),
	);
	const close = openModal(editing ? 'Edit agent wallet' : 'Add agent wallet', body, [
		el('span', { class: 'spacer', style: 'margin-left:auto' }),
		el('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
		el('button', { class: 'btn primary', id: 'aw_save', onclick: () => saveAgentWallet(editing, v, close) }, editing ? 'Save' : 'Add wallet'),
	]);
}

async function saveAgentWallet(editing, prev, close) {
	const btn = $('#aw_save');
	btn.disabled = true;
	try {
		const chain = $('#aw_chain').value;
		const address = $('#aw_addr').value.trim();
		const label = $('#aw_label').value.trim();
		if (!label) throw new Error('Label is required');
		const ok = chain === 'base' ? isEvm(address) : isSol(address);
		if (!ok) throw new Error(`Address is not a valid ${chain} address`);
		const entry = {
			id: editing ? prev.id : uid('aw'),
			label,
			chain,
			role: $('#aw_role').value,
			address,
			enabled: $('#aw_enabled').checked,
			per_call_cap_atomics: $('#aw_call').value ? toAtomics($('#aw_call').value) : null,
			daily_cap_atomics: $('#aw_day').value ? toAtomics($('#aw_day').value) : null,
		};
		const list = [...(S.settings.agent_wallets || [])];
		const idx = editing ? list.findIndex((x) => x.id === prev.id) : -1;
		if (idx >= 0) list[idx] = entry; else list.push(entry);
		await saveSettings({ agent_wallets: list }, editing ? 'Wallet updated' : 'Wallet added');
		close();
		renderWallets($('#sec-wallets'));
	} catch (e) {
		toast(e.message, 'err');
		btn.disabled = false;
	}
}
async function removeAgentWallet(id) {
	if (!confirm('Remove this agent wallet? It can no longer transact on your behalf.')) return;
	const list = (S.settings.agent_wallets || []).filter((x) => x.id !== id);
	try {
		await saveSettings({ agent_wallets: list }, 'Wallet removed');
		renderWallets($('#sec-wallets'));
	} catch (e) {
		toast(e.message, 'err');
	}
}

// ---------------------------------------------------------------- giving ------
function renderGiving(host) {
	const m = S.settings || {};
	host.innerHTML = '';
	host.append(
		el('div', { class: 'banner' }, el('span', { class: 'ic' }, '♥'),
			el('div', { html: 'Turn every payment into a donation. <b>Charity</b> earmarks a share of each settled payment for a cause; <b>round-up</b> nudges the buyer total up to the nearest unit and gives the difference. Both are shown to buyers before they pay.' })),
	);

	const charity = el('div', { class: 'card' },
		el('h2', {}, 'Charity split'),
		el('p', { class: 'sub' }, 'A fixed share of every settled payment is earmarked for your cause wallet.'),
		field('', switchEl('ch_enabled', !!m.charity_enabled, 'Enable charity split')),
		field('Cause name', input({ id: 'ch_name', value: m.charity_name || '', placeholder: 'Ocean Cleanup', maxlength: 80 })),
		el('div', { class: 'cols-2' },
			field('Chain', select('ch_chain', ['solana', 'base'], m.charity_chain || 'solana')),
			field('Share (%)', input({ id: 'ch_pct', type: 'number', min: '0', max: '100', step: '0.5', value: m.charity_bps ? (m.charity_bps / 100).toString() : '', placeholder: '1' })),
		),
		field('Cause wallet address', input({ id: 'ch_addr', value: m.charity_address || '', placeholder: 'address (matches chain)', class: 'mono' })),
		el('div', { class: 'row', style: 'margin-top:4px' }, el('button', { class: 'btn primary', id: 'ch_save', onclick: saveCharity }, 'Save charity')),
	);
	host.append(charity);

	const roundup = el('div', { class: 'card' },
		el('h2', {}, 'Round-up giving'),
		el('p', { class: 'sub' }, 'Round the buyer’s total up to the nearest unit; the difference goes to your cause wallet (set above).'),
		field('', switchEl('ru_enabled', !!m.roundup_enabled, 'Enable round-up')),
		field('Round up to nearest (USDC)', select('ru_unit', ['1', '0.5', '0.25', '0.1', '5'], m.roundup_to_atomics ? (Number(m.roundup_to_atomics) / 10 ** USDC_DECIMALS).toString() : '1'), 'e.g. a $2.30 call rounds to $3.00, donating $0.70'),
		el('div', { class: 'row', style: 'margin-top:4px' }, el('button', { class: 'btn primary', id: 'ru_save', onclick: saveRoundup }, 'Save round-up')),
		!m.charity_address ? el('div', { class: 'banner warn', style: 'margin-top:12px' }, el('span', { class: 'ic' }, '!'), el('div', {}, 'Round-up needs a cause wallet. Set a charity address above first.')) : null,
	);
	host.append(roundup);
}

async function saveCharity() {
	const btn = $('#ch_save');
	btn.disabled = true;
	try {
		const enabled = $('#ch_enabled').checked;
		const chain = $('#ch_chain').value;
		const addr = $('#ch_addr').value.trim();
		const pct = Number($('#ch_pct').value || 0);
		if (addr) {
			const ok = chain === 'base' ? isEvm(addr) : isSol(addr);
			if (!ok) throw new Error(`Cause address is not a valid ${chain} address`);
		}
		if (enabled && !addr) throw new Error('A cause wallet is required to enable charity');
		if (enabled && !(pct > 0)) throw new Error('Set a share greater than 0%');
		await saveSettings({
			charity_enabled: enabled,
			charity_name: $('#ch_name').value.trim() || null,
			charity_chain: chain,
			charity_address: addr || null,
			charity_bps: Math.round(pct * 100),
		}, 'Charity saved');
		renderGiving($('#sec-giving'));
	} catch (e) {
		toast(e.message, 'err');
		btn.disabled = false;
	}
}
async function saveRoundup() {
	const btn = $('#ru_save');
	btn.disabled = true;
	try {
		const enabled = $('#ru_enabled').checked;
		if (enabled && !S.settings.charity_address) throw new Error('Set a charity address before enabling round-up');
		await saveSettings({ roundup_enabled: enabled, roundup_to_atomics: toAtomics($('#ru_unit').value) }, 'Round-up saved');
		renderGiving($('#sec-giving'));
	} catch (e) {
		toast(e.message, 'err');
		btn.disabled = false;
	}
}

// ---------------------------------------------------------------- settings ----
function renderSettings(host) {
	const m = S.settings || {};
	host.innerHTML = '';

	// Branding
	host.append(el('div', { class: 'card' },
		el('h2', {}, 'Branding'),
		el('p', { class: 'sub' }, 'Shown across hosted checkout and your storefront.'),
		el('div', { class: 'cols-2' },
			field('Business name', input({ id: 's_name', value: m.business_name || '', placeholder: 'Acme Inc', maxlength: 80 })),
			field('Support email', input({ id: 's_email', value: m.support_email || '', placeholder: 'support@acme.com', type: 'email' })),
		),
		el('div', { class: 'cols-2' },
			field('Logo URL', input({ id: 's_logo', value: m.logo_url || '', placeholder: 'https://…/logo.png', type: 'url' })),
			field('Accent color', input({ id: 's_accent', value: m.accent_color || '#0a84ff', type: 'color' })),
		),
		el('button', { class: 'btn primary', id: 's_brand_save', onclick: saveBranding }, 'Save branding'),
	));

	// Security
	host.append(el('div', { class: 'card' },
		el('h2', {}, 'Security & spend limits'),
		el('p', { class: 'sub' }, 'Bound what may move and require sign-in for re-entry.'),
		el('div', { class: 'cols-2' },
			field('Max per call (USDC)', input({ id: 's_call', type: 'number', min: '0', step: '0.01', value: m.spend_cap_per_call_atomics ? fmtUsdc(m.spend_cap_per_call_atomics) : '', placeholder: 'no cap' })),
			field('Max per day (USDC)', input({ id: 's_day', type: 'number', min: '0', step: '0.01', value: m.spend_cap_daily_atomics ? fmtUsdc(m.spend_cap_daily_atomics) : '', placeholder: 'no cap' })),
		),
		field('', switchEl('s_siwx', !!m.require_siwx, 'Require Sign-In-With-X for free re-entry')),
		field('Settlement networks', networkChecks(m.allowed_networks || ['base', 'solana'])),
		el('button', { class: 'btn primary', id: 's_sec_save', onclick: saveSecurity }, 'Save security'),
	));

	// CORS
	host.append(el('div', { class: 'card' },
		el('h2', {}, 'CORS allow-list'),
		el('p', { class: 'sub' }, 'Origins permitted to embed your checkout. Leave empty to allow your three.ws-hosted pages only.'),
		field('Allowed origins (one per line)', textarea({ id: 's_cors', value: (m.cors_origins || []).join('\n'), placeholder: 'https://acme.com\nhttps://app.acme.com' })),
		el('button', { class: 'btn primary', id: 's_cors_save', onclick: saveCors }, 'Save origins'),
	));

	// Developer — facilitator, webhook, API key
	const keyState = m.api_key_prefix
		? el('div', { class: 'list-item' },
			el('div', { class: 'meta' }, el('div', { class: 't mono' }, `${m.api_key_prefix}……`), el('div', { class: 's' }, m.api_key_created_at ? `created ${new Date(m.api_key_created_at).toLocaleDateString()}` : 'active')),
			el('div', { class: 'acts' }, el('button', { class: 'btn ghost sm', onclick: rotateKey }, 'Rotate')))
		: el('div', { class: 'row' }, el('button', { class: 'btn ghost', onclick: rotateKey }, 'Generate API key'));
	host.append(el('div', { class: 'card' },
		el('h2', {}, 'Developer'),
		el('p', { class: 'sub' }, 'Facilitator override, settlement webhook, and an API key for the key-bypass lane.'),
		el('div', { class: 'cols-2' },
			field('Facilitator URL (optional)', input({ id: 's_fac', value: m.facilitator || '', placeholder: 'https://facilitator.example', type: 'url' })),
			field('Settlement webhook (optional)', input({ id: 's_hook', value: m.webhook_url || '', placeholder: 'https://acme.com/webhooks/x402', type: 'url' })),
		),
		el('button', { class: 'btn primary', id: 's_dev_save', onclick: saveDeveloper, style: 'margin-bottom:16px' }, 'Save developer'),
		el('label', { class: 'field', style: 'margin:0' }, el('span', { style: 'font-size:var(--text-sm);color:var(--ink-dim);font-weight:500' }, 'API key')),
		keyState,
	));
}

function networkChecks(selected) {
	const wrap = el('div', { class: 'row', id: 's_nets', style: 'gap:16px' });
	for (const n of ['base', 'solana']) {
		wrap.append(el('label', { class: 'switch' },
			el('input', { type: 'checkbox', 'data-net': n, ...(selected.includes(n) ? { checked: true } : {}) }),
			el('span', { class: 'track' }), el('span', { class: 'lab' }, n)));
	}
	return wrap;
}

async function saveBranding() {
	const btn = $('#s_brand_save'); btn.disabled = true;
	try {
		await saveSettings({
			business_name: $('#s_name').value.trim() || null,
			support_email: $('#s_email').value.trim() || null,
			logo_url: $('#s_logo').value.trim() || null,
			accent_color: $('#s_accent').value,
		}, 'Branding saved');
	} catch (e) { toast(e.message, 'err'); }
	btn.disabled = false;
}
async function saveSecurity() {
	const btn = $('#s_sec_save'); btn.disabled = true;
	try {
		const nets = $$('#s_nets input:checked').map((i) => i.dataset.net);
		if (!nets.length) throw new Error('Enable at least one settlement network');
		await saveSettings({
			spend_cap_per_call_atomics: $('#s_call').value ? toAtomics($('#s_call').value) : null,
			spend_cap_daily_atomics: $('#s_day').value ? toAtomics($('#s_day').value) : null,
			require_siwx: $('#s_siwx').checked,
			allowed_networks: nets,
		}, 'Security saved');
	} catch (e) { toast(e.message, 'err'); }
	btn.disabled = false;
}
async function saveCors() {
	const btn = $('#s_cors_save'); btn.disabled = true;
	try {
		const origins = $('#s_cors').value.split('\n').map((s) => s.trim()).filter(Boolean);
		for (const o of origins) if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)) throw new Error(`Not a valid origin: ${o}`);
		await saveSettings({ cors_origins: origins }, 'CORS origins saved');
	} catch (e) { toast(e.message, 'err'); }
	btn.disabled = false;
}
async function saveDeveloper() {
	const btn = $('#s_dev_save'); btn.disabled = true;
	try {
		await saveSettings({ facilitator: $('#s_fac').value.trim() || null, webhook_url: $('#s_hook').value.trim() || null }, 'Developer settings saved');
	} catch (e) { toast(e.message, 'err'); }
	btn.disabled = false;
}
async function rotateKey() {
	if (!confirm('Generate a new API key? Any existing key stops working immediately.')) return;
	try {
		const { api_key } = await api('/api/x402-merchant?action=rotate-key', { method: 'POST' });
		const { settings } = await api('/api/x402-merchant');
		S.settings = settings;
		const close = openModal('Your new API key', el('div', {},
			el('p', { class: 'sub' }, 'Copy it now — it is shown once and stored only as a hash.'),
			el('div', { class: 'code' }, api_key, el('button', { class: 'btn primary sm copy', onclick: () => copy(api_key, 'API key copied') }, 'Copy')),
		), [el('span', { class: 'spacer', style: 'margin-left:auto' }), el('button', { class: 'btn primary', onclick: () => { close(); renderSettings($('#sec-settings')); } }, 'Done')]);
	} catch (e) { toast(e.message, 'err'); }
}

// ---------------------------------------------------------------- store -------
const BLOCK_TYPES = [
	{ type: 'hero', ic: '★', label: 'Hero' },
	{ type: 'products', ic: '▦', label: 'Product grid' },
	{ type: 'product', ic: '⬡', label: 'Single product' },
	{ type: 'text', ic: '¶', label: 'Text' },
	{ type: 'image', ic: '▣', label: 'Image' },
	{ type: 'button', ic: '⬢', label: 'Button' },
	{ type: 'divider', ic: '—', label: 'Divider' },
	{ type: 'footer', ic: '▭', label: 'Footer' },
];

function renderStore(host) {
	const m = S.settings || {};
	S.layout = JSON.parse(JSON.stringify(m.store_layout || []));
	host.innerHTML = '';

	host.append(el('div', { class: 'card' },
		el('div', { class: 'section-head' },
			el('div', {}, el('h2', {}, 'Storefront builder'), el('p', { class: 'sub', style: 'margin:0' }, 'Drag blocks onto the canvas, reorder, and publish a shareable storefront — like a Shopify page for your x402 products.')),
			el('span', { class: 'spacer' }),
			el('span', { class: `pill ${m.store_published ? 'ok' : ''}` }, m.store_published ? 'Published' : 'Draft'),
		),
		el('div', { class: 'cols-2' },
			field('Store handle', input({ id: 'st_handle', value: m.store_handle || '', placeholder: 'acme', maxlength: 40 }), 'Lives at /store/<handle>'),
			field('', el('div', { class: 'row', style: 'align-items:flex-end;height:100%;gap:8px' },
				el('button', { class: 'btn ghost', onclick: () => saveStore(false) }, 'Save draft'),
				el('button', { class: 'btn primary', onclick: () => saveStore(true) }, m.store_published ? 'Update store' : 'Publish'),
				m.store_published && m.store_handle ? el('a', { class: 'btn ghost', href: `/store/${m.store_handle}`, target: '_blank' }, 'View ↗') : null,
			)),
		),
	));

	const builder = el('div', { class: 'builder' });
	const palette = el('div', { class: 'palette card' }, el('h4', { style: 'font-size:var(--text-md);margin-bottom:10px' }, 'Blocks'));
	for (const b of BLOCK_TYPES) {
		palette.append(el('button', { class: 'chip', draggable: 'true', 'data-type': b.type,
			ondragstart: (e) => { e.dataTransfer.setData('text/new', b.type); e.dataTransfer.effectAllowed = 'copy'; },
			onclick: () => { addBlock(b.type); } },
			el('span', {}, b.ic), b.label, el('span', { style: 'margin-left:auto;color:var(--ink-faint)' }, '+')));
	}
	const canvas = el('div', { class: 'canvas', id: 'st_canvas',
		ondragover: (e) => { e.preventDefault(); canvas.classList.add('drop'); },
		ondragleave: () => canvas.classList.remove('drop'),
		ondrop: (e) => { e.preventDefault(); canvas.classList.remove('drop'); const nt = e.dataTransfer.getData('text/new'); if (nt) addBlock(nt); } });
	builder.append(palette, canvas);
	host.append(builder);
	drawCanvas();
}

function addBlock(type) {
	const block = { id: uid('b'), type };
	if (type === 'hero') { block.heading = S.settings.business_name || 'Welcome'; block.subheading = 'Pay with USDC — settled on-chain.'; block.align = 'center'; }
	if (type === 'text') block.body = 'Tell buyers what you offer.';
	if (type === 'button') { block.label = 'Get started'; block.href = location.origin; }
	if (type === 'products') block.sku_ids = S.skus.filter((s) => s.active).slice(0, 12).map((s) => s.id);
	if (type === 'product') block.sku_id = S.skus.find((s) => s.active)?.id;
	if (type === 'footer') block.body = `© ${S.settings.business_name || 'your store'}`;
	S.layout.push(block);
	drawCanvas();
}

function drawCanvas() {
	const canvas = $('#st_canvas');
	if (!canvas) return;
	canvas.innerHTML = '';
	if (!S.layout.length) {
		canvas.append(el('div', { class: 'empty' }, el('div', { class: 'ico' }, '▦'), el('h3', {}, 'Empty canvas'), el('p', { class: 'sub' }, 'Drag a block from the left, or click one to add it.')));
		return;
	}
	S.layout.forEach((b, i) => {
		const node = el('div', { class: 'block', draggable: 'true',
			ondragstart: (e) => { e.dataTransfer.setData('text/move', String(i)); node.classList.add('dragging'); },
			ondragend: () => node.classList.remove('dragging'),
			ondragover: (e) => e.preventDefault(),
			ondrop: (e) => { e.preventDefault(); const from = e.dataTransfer.getData('text/move'); if (from === '') return; moveBlock(Number(from), i); } },
			el('div', { class: 'bhead' },
				el('span', { class: 'type' }, b.type),
				el('div', { class: 'acts' },
					el('button', { title: 'Move up', onclick: () => moveBlock(i, Math.max(0, i - 1)) }, '↑'),
					el('button', { title: 'Move down', onclick: () => moveBlock(i, Math.min(S.layout.length - 1, i + 1)) }, '↓'),
					el('button', { title: 'Edit', onclick: () => blockModal(b) }, '✎'),
					el('button', { title: 'Remove', onclick: () => { S.layout.splice(i, 1); drawCanvas(); } }, '✕'),
				)),
			el('div', { class: 'bprev' }, blockPreview(b)),
		);
		canvas.append(node);
	});
}
function moveBlock(from, to) {
	if (from === to) return;
	const [m] = S.layout.splice(from, 1);
	S.layout.splice(to, 0, m);
	drawCanvas();
}
function blockPreview(b) {
	if (b.type === 'hero') return `${b.heading || ''} — ${b.subheading || ''}`;
	if (b.type === 'text' || b.type === 'footer') return (b.body || '').slice(0, 120);
	if (b.type === 'button') return `[ ${b.label || 'Button'} ] → ${b.href || ''}`;
	if (b.type === 'image') return b.image_url ? b.image_url : '(no image set)';
	if (b.type === 'products') return `${(b.sku_ids || []).length} product${(b.sku_ids || []).length === 1 ? '' : 's'}`;
	if (b.type === 'product') { const s = S.skus.find((x) => x.id === b.sku_id); return s ? `${s.merchant_name} · ${s.action_name}` : '(pick a product)'; }
	if (b.type === 'divider') return '———';
	return '';
}

function blockModal(b) {
	const fields = [];
	if (b.type === 'hero') {
		fields.push(field('Heading', input({ id: 'bk_h', value: b.heading || '' })));
		fields.push(field('Subheading', input({ id: 'bk_sh', value: b.subheading || '' })));
		fields.push(field('Align', select('bk_align', ['center', 'left'], b.align || 'center')));
	} else if (b.type === 'text' || b.type === 'footer') {
		fields.push(field('Text', textarea({ id: 'bk_body', value: b.body || '' })));
	} else if (b.type === 'button') {
		fields.push(field('Label', input({ id: 'bk_label', value: b.label || '' })));
		fields.push(field('Link', input({ id: 'bk_href', value: b.href || '', type: 'url' })));
	} else if (b.type === 'image') {
		fields.push(field('Image URL', input({ id: 'bk_img', value: b.image_url || '', type: 'url' })));
	} else if (b.type === 'product') {
		fields.push(field('Product', select('bk_sku', S.skus.map((s) => s.id), b.sku_id, Object.fromEntries(S.skus.map((s) => [s.id, `${s.merchant_name} · ${s.action_name}`])))));
	} else if (b.type === 'products') {
		const list = el('div', {});
		for (const s of S.skus) {
			list.append(el('label', { class: 'switch', style: 'display:flex;margin-bottom:8px' },
				el('input', { type: 'checkbox', 'data-sku': s.id, ...((b.sku_ids || []).includes(s.id) ? { checked: true } : {}) }),
				el('span', { class: 'track' }), el('span', { class: 'lab' }, `${s.merchant_name} · ${s.action_name}`)));
		}
		fields.push(field('Products to show', S.skus.length ? list : el('p', { class: 'sub' }, 'No products yet.')));
	} else {
		fields.push(el('p', { class: 'sub' }, 'This block has no options.'));
	}
	const close = openModal(`Edit ${b.type}`, el('div', {}, ...fields), [
		el('span', { class: 'spacer', style: 'margin-left:auto' }),
		el('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
		el('button', { class: 'btn primary', onclick: () => { applyBlock(b); close(); drawCanvas(); } }, 'Apply'),
	]);
}
function applyBlock(b) {
	if (b.type === 'hero') { b.heading = $('#bk_h').value; b.subheading = $('#bk_sh').value; b.align = $('#bk_align').value; }
	else if (b.type === 'text' || b.type === 'footer') b.body = $('#bk_body').value;
	else if (b.type === 'button') { b.label = $('#bk_label').value; b.href = $('#bk_href').value; }
	else if (b.type === 'image') b.image_url = $('#bk_img').value;
	else if (b.type === 'product') b.sku_id = $('#bk_sku').value;
	else if (b.type === 'products') b.sku_ids = $$('#root input[data-sku]:checked').map((i) => i.dataset.sku);
}

async function saveStore(publish) {
	try {
		const handle = $('#st_handle').value.trim().toLowerCase();
		if (publish && !handle) throw new Error('Set a store handle before publishing');
		if (handle && !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(handle)) throw new Error('Handle must be lowercase, hyphenated, 3–40 chars');
		// Strip empty image/button blocks the API would reject (httpsUrl required).
		const layout = S.layout.filter((b) => {
			if (b.type === 'image') return !!b.image_url;
			if (b.type === 'button') return !!b.href;
			if (b.type === 'product') return !!b.sku_id;
			return true;
		}).map((b) => {
			const c = { ...b };
			if (!c.image_url) delete c.image_url;
			if (!c.href) delete c.href;
			if (c.type !== 'product') delete c.sku_id;
			if (c.type !== 'products') delete c.sku_ids;
			return c;
		});
		const patch = { store_layout: layout };
		if (handle) patch.store_handle = handle;
		if (publish) patch.store_published = true;
		await saveSettings(patch, publish ? 'Storefront published' : 'Draft saved');
		renderStore($('#sec-store'));
	} catch (e) {
		toast(e.message, 'err');
	}
}

// ---------------------------------------------------------------- embed -------
const EMBED = { sku: null, size: 'md', shape: 'md', theme: 'dark', label: '' };

function renderEmbed(host) {
	const m = S.settings || {};
	host.innerHTML = '';
	if (!S.skus.length) {
		host.append(el('div', { class: 'card' }, emptyState('⌘', 'No products to embed', 'Create a product first, then build a copy-paste pay button for any site.', 'Create product', () => go('products'))));
		return;
	}
	if (!EMBED.sku || !S.skus.find((s) => s.id === EMBED.sku)) EMBED.sku = S.skus[0].id;

	host.append(el('div', { class: 'card' },
		el('h2', {}, 'Embed builder'),
		el('p', { class: 'sub' }, 'Configure a pay button and drop it onto any website — Wix, Shopify, a landing page, anywhere. It opens the x402 modal and settles in USDC.'),
		el('div', { class: 'cols-2' },
			field('Product', selectFromSkus('em_sku', EMBED.sku)),
			field('Button label', input({ id: 'em_label', placeholder: 'auto from product', value: EMBED.label })),
		),
		el('div', { class: 'row' },
			field('Size', select('em_size', ['sm', 'md', 'lg'], EMBED.size)),
			field('Shape', select('em_shape', ['sm', 'md', 'pill'], EMBED.shape, { sm: 'square', md: 'rounded', pill: 'pill' })),
			field('Theme', select('em_theme', ['dark', 'light'], EMBED.theme)),
		),
	));

	const preview = el('div', { class: 'card' }, el('h4', { style: 'font-size:var(--text-md);margin-bottom:10px' }, 'Live preview'), el('div', { class: 'embed-preview', id: 'em_prev' }));
	host.append(preview);

	const codeCard = el('div', { class: 'card' },
		el('div', { class: 'section-head' }, el('h4', { style: 'font-size:var(--text-md);margin:0' }, 'Copy-paste embed'), el('span', { class: 'spacer' }), el('button', { class: 'btn ghost sm', onclick: () => copy($('#em_code').textContent, 'Embed copied') }, 'Copy code')),
		el('div', { class: 'code', id: 'em_code' }),
		el('p', { class: 'hint', style: 'margin-top:10px' }, m.cors_origins?.length ? `Allowed on: ${m.cors_origins.join(', ')}` : 'Tip: add your site to the CORS allow-list under Security & API so the checkout loads on your domain.'),
	);
	host.append(codeCard);

	for (const id of ['em_sku', 'em_label', 'em_size', 'em_shape', 'em_theme']) {
		$('#' + id).addEventListener('input', readEmbed);
	}
	readEmbed();
}

function selectFromSkus(id, value) {
	const opts = Object.fromEntries(S.skus.map((s) => [s.id, `${s.merchant_name} · ${s.action_name}`]));
	return select(id, S.skus.map((s) => s.id), value, opts);
}

function readEmbed() {
	EMBED.sku = $('#em_sku').value;
	EMBED.label = $('#em_label').value;
	EMBED.size = $('#em_size').value;
	EMBED.shape = $('#em_shape').value;
	EMBED.theme = $('#em_theme').value;
	drawEmbed();
}

function buttonCss() {
	const pad = EMBED.size === 'sm' ? '8px 14px' : EMBED.size === 'lg' ? '16px 28px' : '12px 20px';
	const fs = EMBED.size === 'sm' ? '14px' : EMBED.size === 'lg' ? '18px' : '16px';
	const radius = EMBED.shape === 'sm' ? '6px' : EMBED.shape === 'pill' ? '999px' : '12px';
	const accent = S.settings?.accent_color || '#0a84ff';
	// Dark theme → white button on dark ink; light theme → accent button on white.
	const bg = EMBED.theme === 'light' ? accent : '#ffffff';
	const fg = EMBED.theme === 'light' ? '#ffffff' : '#061018';
	return { pad, fs, radius, accent, bg, fg };
}

function drawEmbed() {
	const sku = S.skus.find((s) => s.id === EMBED.sku);
	const c = buttonCss();
	const label = EMBED.label || (sku ? `Pay · ${sku.action_name}` : 'Pay with USDC');
	const prev = $('#em_prev');
	prev.innerHTML = '';
	const btn = el('button', { style: `padding:${c.pad};font-size:${c.fs};border-radius:${c.radius};background:${c.bg};color:${c.fg};border:0;font-weight:700;cursor:pointer;font-family:var(--font-body)`,
		'data-x402-endpoint': sku.target_endpoint,
		'data-x402-method': sku.target_method,
		'data-x402-merchant': sku.merchant_name,
		'data-x402-action': sku.action_name,
		...(sku.target_body ? { 'data-x402-body': JSON.stringify(sku.target_body) } : {}),
	}, label);
	prev.append(btn);
	// Bind the live modal so the preview button is fully functional.
	if (window.X402?.init) window.X402.init();

	// Generated snippet.
	const style = `padding:${c.pad};font-size:${c.fs};border-radius:${c.radius};background:${c.bg};color:${c.fg};border:0;font-weight:700;cursor:pointer`;
	const attrs = [
		`data-x402-endpoint="${esc(sku.target_endpoint)}"`,
		`data-x402-method="${esc(sku.target_method)}"`,
		`data-x402-merchant="${esc(sku.merchant_name)}"`,
		`data-x402-action="${esc(sku.action_name)}"`,
	];
	if (sku.target_body) attrs.push(`data-x402-body='${esc(JSON.stringify(sku.target_body))}'`);
	// type="module" (never a classic `defer` script): /x402.js uses import.meta.url,
	// which throws at parse time outside a module. A merchant pasting this snippet
	// gets a working button, not a console full of syntax errors.
	const snippet = `<!-- x402 pay button · powered by three.ws -->\n<script type="module" src="${location.origin}/x402.js"></` + `script>\n<button\n  ${attrs.join('\n  ')}\n  style="${style}">\n  ${esc(label)}\n</button>`;
	$('#em_code').textContent = snippet;
}

// ---------------------------------------------------------------- ui kit ------
function field(label, control, hint) {
	return el('label', { class: 'field' },
		label ? el('span', {}, label) : null,
		control,
		hint ? el('span', { class: 'hint' }, hint) : null);
}
function input(attrs) { return el('input', attrs); }
function textarea(attrs) { const t = el('textarea', { ...attrs }); if (attrs.value) t.value = attrs.value; return t; }
function select(id, values, selected, labels = {}) {
	const s = el('select', { id });
	for (const v of values) s.append(el('option', { value: v, ...(v === selected ? { selected: true } : {}) }, labels[v] || v));
	return s;
}
function switchEl(id, checked, label) {
	return el('label', { class: 'switch' },
		el('input', { type: 'checkbox', id, ...(checked ? { checked: true } : {}) }),
		el('span', { class: 'track' }), el('span', { class: 'lab' }, label));
}

let scrim;
function openModal(title, bodyNode, actions) {
	if (!scrim) { scrim = el('div', { class: 'scrim', onclick: (e) => { if (e.target === scrim) close(); } }); document.body.append(scrim); }
	const modal = el('div', { class: 'modal' },
		el('header', {}, el('h3', {}, title), el('button', { class: 'x', onclick: () => close() }, '×')),
		el('div', { class: 'body' }, bodyNode),
		el('div', { class: 'actions' }, ...actions.filter(Boolean)));
	scrim.innerHTML = '';
	scrim.append(modal);
	scrim.classList.add('show');
	function close() { scrim.classList.remove('show'); scrim.innerHTML = ''; }
	return close;
}

// Load the x402 modal script once so the embed preview button is live.
// type="module" is required, not cosmetic: /x402.js resolves its sibling
// risk-ack module via import.meta.url, which is a syntax error in a classic
// script. Module scripts defer by default, so no `defer` attribute is needed.
function loadX402Modal() {
	if (window.X402 || document.querySelector('script[data-x402-runtime]')) return;
	const s = document.createElement('script');
	s.type = 'module';
	s.src = '/x402.js';
	s.setAttribute('data-x402-runtime', '');
	document.head.append(s);
}

loadX402Modal();
boot();
