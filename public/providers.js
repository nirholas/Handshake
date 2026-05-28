// public/providers.js — directory + single-provider profile UI.
//
// Reads ?host=<host> from the URL: present → render the deep profile,
// absent → render the directory grid. Both modes pull /api/bazaar/providers
// which already does the aggregation server-side.

const $ = (sel) => document.querySelector(sel);
const root = $('#root');

const state = {
	host: new URLSearchParams(location.search).get('host') || '',
	directory: null,
	q: '',
	sort: 'count',
};

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
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

function renderSkeleton(count = 6) {
	const frag = document.createDocumentFragment();
	for (let i = 0; i < count; i++) {
		const sk = document.createElement('div');
		sk.className = 'skeleton sk-card';
		frag.appendChild(sk);
	}
	const g = document.createElement('div');
	g.className = 'grid';
	g.appendChild(frag);
	root.replaceChildren(g);
}

async function loadDirectory() {
	root.innerHTML = `
		<header class="hero">
			<h1>Providers</h1>
			<p>Operator profiles for the merged x402 catalog. Click any provider for the full price ladder, networks, and category mix.</p>
		</header>
		<div class="toolbar">
			<input type="search" id="q" placeholder="Search providers by host…" />
			<select id="sort">
				<option value="count">Most services</option>
				<option value="price-low">Cheapest median</option>
				<option value="price-high">Most expensive median</option>
				<option value="networks">Most networks</option>
			</select>
			<div class="count"><strong id="count">…</strong> providers</div>
		</div>
		<div id="dgrid" class="grid"></div>
		<div id="dempty" class="empty" hidden></div>
	`;
	const dgrid = $('#dgrid');
	const dempty = $('#dempty');
	const countEl = $('#count');
	const qEl = $('#q');
	const sortEl = $('#sort');

	renderSkeleton();
	try {
		const r = await fetch('/api/bazaar/providers?limit=500');
		const data = await r.json();
		if (!r.ok) throw new Error(data?.error_description || data?.error || `HTTP ${r.status}`);
		state.directory = data.providers || [];
	} catch (e) {
		dgrid.innerHTML = '';
		dempty.hidden = false;
		dempty.className = 'err';
		dempty.textContent = `Failed to load providers: ${e?.message || e}`;
		return;
	}

	function render() {
		const q = state.q.trim().toLowerCase();
		let list = state.directory.filter((p) => !q || p.host.toLowerCase().includes(q) || (p.topTags || []).some((t) => t.toLowerCase().includes(q)));
		switch (state.sort) {
			case 'price-low':
				list = list.sort((a, b) => (a.medianPriceAtomic ?? Infinity) - (b.medianPriceAtomic ?? Infinity));
				break;
			case 'price-high':
				list = list.sort((a, b) => (b.medianPriceAtomic ?? -1) - (a.medianPriceAtomic ?? -1));
				break;
			case 'networks':
				list = list.sort((a, b) => (b.networks?.length || 0) - (a.networks?.length || 0));
				break;
			default:
				list = list.sort((a, b) => b.serviceCount - a.serviceCount);
		}
		countEl.textContent = String(list.length);
		if (list.length === 0) {
			dgrid.innerHTML = '';
			dempty.hidden = false;
			dempty.className = 'empty';
			dempty.textContent = 'No providers match. Clear the search to see all.';
			return;
		}
		dempty.hidden = true;
		const frag = document.createDocumentFragment();
		for (const p of list) frag.appendChild(directoryCard(p));
		dgrid.replaceChildren(frag);
	}

	function directoryCard(p) {
		const el = document.createElement('a');
		el.className = 'prov';
		el.href = `/providers?host=${encodeURIComponent(p.host)}`;

		const head = document.createElement('div');
		head.className = 'head';
		const icon = document.createElement('div');
		icon.className = 'icon';
		if (p.iconUrl) {
			const img = document.createElement('img');
			img.src = p.iconUrl;
			img.alt = '';
			img.referrerPolicy = 'no-referrer';
			img.onerror = () => { icon.textContent = (p.host || '?').charAt(0).toUpperCase(); img.remove(); };
			icon.appendChild(img);
		} else {
			icon.textContent = (p.host || '?').charAt(0).toUpperCase();
		}
		const info = document.createElement('div');
		info.style.flex = '1';
		info.style.minWidth = '0';
		info.innerHTML = `<div class="host">${escapeHtml(p.host)}</div><div class="submeta">${p.serviceCount} ${p.serviceCount === 1 ? 'service' : 'services'} · ${p.networks.length} ${p.networks.length === 1 ? 'network' : 'networks'}</div>`;
		head.append(icon, info);

		const kpis = document.createElement('div');
		kpis.className = 'kpis';
		kpis.innerHTML = `
			<div><div class="k">Services</div><div class="v">${p.serviceCount}</div></div>
			<div><div class="k">Median</div><div class="v green">${escapeHtml(p.medianPriceLabel || '—')}</div></div>
			<div><div class="k">Min</div><div class="v green">${escapeHtml(p.minPriceLabel || '—')}</div></div>
		`;

		const tagrow = document.createElement('div');
		tagrow.className = 'tagrow';
		for (const t of (p.topTags || []).slice(0, 4)) {
			const tag = document.createElement('span');
			tag.className = 'tag';
			tag.textContent = t;
			tagrow.appendChild(tag);
		}
		for (const n of (p.networks || []).slice(0, 3)) {
			const tag = document.createElement('span');
			tag.className = 'tag net';
			tag.textContent = shortNet(n);
			tagrow.appendChild(tag);
		}

		el.append(head, kpis, tagrow);
		return el;
	}

	qEl.addEventListener('input', () => { state.q = qEl.value; render(); });
	sortEl.addEventListener('change', () => { state.sort = sortEl.value; render(); });
	render();
}

async function loadProfile(host) {
	renderSkeleton(3);
	let data;
	try {
		const r = await fetch(`/api/bazaar/providers?host=${encodeURIComponent(host)}`);
		data = await r.json();
		if (!r.ok) throw new Error(data?.error_description || data?.error || `HTTP ${r.status}`);
	} catch (e) {
		root.innerHTML = `<div class="err">Failed to load provider: ${escapeHtml(e?.message || String(e))}</div><a class="back-link" href="/providers">← Back to all providers</a>`;
		return;
	}

	const totalListings = data.listings.length;
	const tagCounts = new Map();
	for (const l of data.listings) for (const t of l.tags || []) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
	const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
	const maxTagCount = topTags.length ? topTags[0][1] : 1;

	const netCounts = new Map();
	for (const l of data.listings) for (const n of l.networks || []) netCounts.set(n, (netCounts.get(n) || 0) + 1);
	const netRows = [...netCounts.entries()].sort((a, b) => b[1] - a[1]);

	const typeBreakdown = { http: data.httpCount, mcp: data.mcpCount };

	root.innerHTML = `
		<a class="back-link" href="/providers">← All providers</a>
		<div class="profile-grid">
			<div>
				<div class="panel">
					<div class="profile-head">
						<div class="icon" id="phicon">${data.iconUrl ? '' : escapeHtml((data.host || '?').charAt(0).toUpperCase())}</div>
						<div class="info">
							<div class="host">${escapeHtml(data.host)}</div>
							<div class="sub">${data.serviceCount} services · ${data.networks.length} networks</div>
						</div>
					</div>
					<div class="profile-head" style="margin: 0;">
						<div class="actions" style="flex: 1;">
							<a class="btn" href="https://${escapeHtml(data.host)}" target="_blank" rel="noopener">Visit site</a>
							<a class="btn ghost" href="/bazaar?q=${encodeURIComponent(data.host)}">Open in catalog</a>
						</div>
					</div>
				</div>
				<div class="panel" style="margin-top: 14px;">
					<h3>Profile · ${totalListings} listings</h3>
					<div class="metric-list">
						<div class="row"><span class="k">HTTP endpoints</span><span class="v">${typeBreakdown.http}</span></div>
						<div class="row"><span class="k">MCP tools</span><span class="v">${typeBreakdown.mcp}</span></div>
						<div class="row"><span class="k">Median price</span><span class="v green">${escapeHtml(data.medianPriceLabel || '—')}</span></div>
						<div class="row"><span class="k">Min price</span><span class="v green">${escapeHtml(data.minPriceLabel || '—')}</span></div>
						<div class="row"><span class="k">Max price</span><span class="v">${escapeHtml(data.maxPriceLabel || '—')}</span></div>
						<div class="row"><span class="k">Networks</span><span class="v">${data.networks.length}</span></div>
						<div class="row"><span class="k">Facilitators</span><span class="v">${data.facilitators.length}</span></div>
					</div>
				</div>
				${data.facilitators.length ? `
				<div class="panel" style="margin-top: 14px;">
					<h3>Discovered on</h3>
					<div class="tagrow">${data.facilitators.map((f) => `<span class="tag fac">${escapeHtml(f)}</span>`).join('')}</div>
				</div>` : ''}
			</div>
			<div>
				<div class="panel">
					<h3>Category mix</h3>
					${topTags.length ? `<div class="bar-list">${topTags.map(([t, c]) => `
						<div class="bar-row">
							<div class="label">${escapeHtml(t)}</div>
							<div class="bar"><div class="fill" style="width:${Math.round((c / maxTagCount) * 100)}%"></div></div>
							<div class="pct">${c}</div>
						</div>
					`).join('')}</div>` : `<div style="color: var(--muted); font-size: 13px;">No tags set on this provider's listings.</div>`}
				</div>
				${netRows.length ? `
				<div class="panel" style="margin-top: 14px;">
					<h3>Network coverage</h3>
					<div class="bar-list">${netRows.map(([n, c]) => `
						<div class="bar-row">
							<div class="label">${escapeHtml(shortNet(n))}</div>
							<div class="bar"><div class="fill" style="width:${Math.round((c / totalListings) * 100)}%"></div></div>
							<div class="pct">${c}</div>
						</div>
					`).join('')}</div>
				</div>` : ''}
				<div class="panel" style="margin-top: 14px;">
					<h3>Services · price ladder (cheap → expensive)</h3>
					<div class="listing-table" id="ltable"></div>
				</div>
			</div>
		</div>
	`;

	if (data.iconUrl) {
		const iconEl = document.getElementById('phicon');
		const img = document.createElement('img');
		img.src = data.iconUrl;
		img.alt = '';
		img.referrerPolicy = 'no-referrer';
		img.onerror = () => { iconEl.textContent = (data.host || '?').charAt(0).toUpperCase(); img.remove(); };
		iconEl.appendChild(img);
	}

	const ltable = document.getElementById('ltable');
	const frag = document.createDocumentFragment();
	for (const l of data.listings) frag.appendChild(listingRow(l));
	ltable.replaceChildren(frag);

	function listingRow(l) {
		const row = document.createElement('a');
		row.className = 'listing-row';
		row.href = `/bazaar?q=${encodeURIComponent(l.serviceName || l.toolName || l.resource)}`;
		const icon = document.createElement('div');
		icon.className = 'li-icon';
		if (l.iconUrl) {
			const img = document.createElement('img');
			img.src = l.iconUrl; img.alt = ''; img.referrerPolicy = 'no-referrer';
			img.onerror = () => { icon.textContent = (l.serviceName || '?').charAt(0).toUpperCase(); img.remove(); };
			icon.appendChild(img);
		} else {
			icon.textContent = (l.serviceName || l.toolName || '?').charAt(0).toUpperCase();
		}
		const main = document.createElement('div');
		main.className = 'li-main';
		main.innerHTML = `
			<div class="li-name">${escapeHtml(l.serviceName || l.toolName || l.resource)}</div>
			<div class="li-desc">${escapeHtml(l.description || l.resource)}</div>
		`;
		const type = document.createElement('div');
		type.className = 'li-type';
		type.textContent = l.toolName ? `MCP · ${l.toolName}` : (l.method || l.type).toUpperCase();
		const price = document.createElement('div');
		price.className = 'li-price';
		price.textContent = l.priceLabel || '—';
		row.append(icon, main, type, price);
		return row;
	}
}

if (state.host) loadProfile(state.host);
else loadDirectory();
