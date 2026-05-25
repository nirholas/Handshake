// ─── Detail page for /discover/a/:chainId/:agentId and /discover/avatar/:id ──

const LIB_CDN_URL = 'https://three.ws/agent-3d/latest/agent-3d.js';

// Parse URL: /discover/a/{chainId}/{agentId}  or  /discover/avatar/{id}
function parseRoute() {
	const path = location.pathname;
	const onchain = path.match(/^\/discover\/a\/(\d+)\/(\d+)/);
	if (onchain) return { kind: 'onchain', chainId: onchain[1], id: onchain[2] };
	const avatar = path.match(/^\/discover\/avatar\/([^/]+)/);
	if (avatar) return { kind: 'avatar', id: avatar[1] };
	return null;
}

async function fetchItem(route) {
	// SSR handler may have pre-loaded the item to avoid a round-trip
	if (window.__DETAIL_ITEM__) return window.__DETAIL_ITEM__;
	const params = new URLSearchParams({ kind: route.kind, id: route.id });
	if (route.kind === 'onchain') params.set('chain', route.chainId);
	const res = await fetch(`/api/explore-item?${params}`);
	if (!res.ok) throw Object.assign(new Error('fetch failed'), { status: res.status });
	const data = await res.json();
	return data.item;
}

// Derive a smart back URL: restore the referrer if it was the discover page so
// filters and search state are not lost.
function backUrl() {
	try {
		const ref = document.referrer;
		if (ref) {
			const u = new URL(ref);
			if (u.hostname === location.hostname && u.pathname === '/discover') {
				return ref; // preserves ?q=, ?chain=, etc.
			}
		}
	} catch (_) { /* ignore */ }
	return '/discover';
}

function escapeHtml(s) {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}
function escapeAttr(s) {
	return escapeHtml(s).replace(/'/g, '&#39;');
}

function shortAddr(a) {
	if (!a || a.length < 10) return a || '';
	return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function fmtDate(iso) {
	if (!iso) return '—';
	return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// ─── Render ──────────────────────────────────────────────────────────────────

function render(item) {
	const $ = (role) => document.querySelector(`[data-role="${role}"]`);

	// Update document meta
	document.title = `${item.name} · three.ws`;
	const metaDesc = document.querySelector('meta[name="description"]');
	if (metaDesc) metaDesc.content = item.description || `${item.name} on three.ws`;

	// Smart back link
	const backEl = $('back-link');
	if (backEl) backEl.href = backUrl();

	// Hero media
	const media = $('hero-media');
	if (item.image) {
		const img = document.createElement('img');
		img.src = item.image;
		img.alt = item.name;
		media.appendChild(img);
	} else {
		const ph = document.createElement('div');
		ph.className = 'detail-hero-ph';
		ph.textContent = item.has3d ? '🎭' : '🤖';
		media.appendChild(ph);
	}

	// Badges
	const badges = $('badges');
	if (item.kind === 'onchain') {
		badges.innerHTML = `
			<span class="explore-badge explore-badge--chain">${escapeHtml(item.chainName)}</span>
			${item.has3d ? '<span class="explore-badge explore-badge--3d">3D</span>' : ''}
			${item.x402Support ? '<span class="explore-badge explore-badge--x402">x402</span>' : ''}
		`;
	} else {
		badges.innerHTML = `
			<span class="explore-badge explore-badge--avatar">Public avatar</span>
			<span class="explore-badge explore-badge--3d">3D</span>
			${item.featured ? '<span class="explore-badge">Featured</span>' : ''}
		`;
	}

	// Name + description
	$('name').textContent = item.name;
	const descEl = $('desc');
	if (item.description) {
		descEl.textContent = item.description;
		descEl.hidden = false;
	}

	// Meta row
	const metaRow = $('meta-row');
	const metaItems = [];
	if (item.kind === 'onchain') {
		metaItems.push(`<span class="detail-meta-item">Agent #${escapeHtml(String(item.agentId))}</span>`);
		metaItems.push(`<span class="detail-meta-item">Owner <a href="${escapeAttr(item.ownerExplorerUrl || '#')}" target="_blank" rel="noopener">${escapeHtml(item.ownerShort)}</a></span>`);
		if (item.registeredAt) metaItems.push(`<span class="detail-meta-item">Registered ${fmtDate(item.registeredAt)}</span>`);
	} else {
		if (item.author) {
			const authorLink = item.author.profileUrl
				? `<a href="${escapeAttr(item.author.profileUrl)}">${escapeHtml(item.author.handle)}</a>`
				: escapeHtml(item.author.handle);
			metaItems.push(`<span class="detail-meta-item">By ${authorLink}</span>`);
		}
		if (item.viewCount) metaItems.push(`<span class="detail-meta-item">${item.viewCount.toLocaleString()} views</span>`);
		if (item.createdAt) metaItems.push(`<span class="detail-meta-item">Added ${fmtDate(item.createdAt)}</span>`);
	}
	metaRow.innerHTML = metaItems.join('');

	// Action buttons
	const actions = $('actions');
	if (item.kind === 'onchain') {
		if (item.viewerUrl) {
			actions.innerHTML += `<a class="detail-btn detail-btn--primary" href="${escapeAttr(item.viewerUrl)}">View 3D</a>`;
		}
		actions.innerHTML += `<a class="detail-btn detail-btn--ghost" href="${escapeAttr(item.tokenExplorerUrl || '#')}" target="_blank" rel="noopener">On-chain ↗</a>`;
	} else {
		actions.innerHTML += `<a class="detail-btn detail-btn--primary" href="${escapeAttr(item.viewerUrl || '#')}">View 3D</a>`;
	}

	// 3D viewer
	if (item.has3d) {
		const viewerWrap = $('viewer-wrap');
		viewerWrap.hidden = false;
		const viewer = $('viewer');

		const script = document.createElement('script');
		script.type = 'module';
		script.src = LIB_CDN_URL;
		document.head.appendChild(script);

		if (item.kind === 'onchain' && item.chainId && item.agentId) {
			const agentUri = `agent://${item.chainId}/${item.agentId}`;
			viewer.innerHTML = `<agent-3d src="${escapeAttr(agentUri)}" mode="inline" responsive style="width:100%;height:100%"></agent-3d>`;
		} else if (item.kind === 'avatar' && item.avatarId) {
			// Use /api/avatars/:id — the agent-3d component resolves it as a manifest
			const apiSrc = `${location.origin}/api/avatars/${encodeURIComponent(item.avatarId)}`;
			viewer.innerHTML = `<agent-3d src="${escapeAttr(apiSrc)}" mode="inline" responsive style="width:100%;height:100%"></agent-3d>`;
		}
	}

	// Services panel (onchain)
	if (item.kind === 'onchain' && item.services?.length) {
		const panel = $('services-panel');
		panel.hidden = false;
		$('service-count').textContent = String(item.services.length);
		const list = $('services');
		list.innerHTML = item.services
			.map((s) => {
				const endpointHtml = s.endpoint
					? `<div class="detail-service-endpoint"><a href="${escapeAttr(s.endpoint)}" target="_blank" rel="noopener">${escapeHtml(s.endpoint)}</a></div>`
					: '';
				const versionHtml = s.version ? `<div class="detail-service-version">v${escapeHtml(s.version)}</div>` : '';
				return `<li class="detail-service">
					<div class="detail-service-name">${escapeHtml(s.name || 'Unnamed')}</div>
					${endpointHtml}${versionHtml}
				</li>`;
			})
			.join('');
	}

	// Tags panel (avatar)
	if (item.kind === 'avatar' && item.tags?.length) {
		const panel = $('tags-panel');
		panel.hidden = false;
		$('tags').innerHTML = item.tags.map((t) => `<span class="detail-tag">${escapeHtml(t)}</span>`).join('');
	}

	// On-chain details panel
	if (item.kind === 'onchain') {
		const panel = $('onchain-panel');
		panel.hidden = false;
		const dl = $('onchain-dl');
		const rows = [
			['Chain', `${escapeHtml(item.chainName)} (${escapeHtml(String(item.chainId))})`],
			['Agent ID', `<a href="${escapeAttr(item.tokenExplorerUrl || '#')}" target="_blank" rel="noopener">#${escapeHtml(String(item.agentId))}</a>`],
			['Owner', `<a href="${escapeAttr(item.ownerExplorerUrl || '#')}" target="_blank" rel="noopener">${escapeHtml(item.owner)}</a>`],
			['Registered', fmtDate(item.registeredAt)],
		];
		if (item.registeredTx) {
			const txUrl = item.explorerBase ? `${item.explorerBase}/tx/${item.registeredTx}` : '#';
			rows.push(['Reg. tx', `<a href="${escapeAttr(txUrl)}" target="_blank" rel="noopener">${escapeHtml(shortAddr(item.registeredTx))}</a>`]);
		}
		dl.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('');
	}

	// Avatar details panel
	if (item.kind === 'avatar') {
		const panel = $('avatar-panel');
		panel.hidden = false;
		const dl = $('avatar-dl');
		const rows = [];
		if (item.author) {
			const authorLink = item.author.profileUrl
				? `<a href="${escapeAttr(item.author.profileUrl)}">${escapeHtml(item.author.handle)}</a>`
				: escapeHtml(item.author.handle);
			rows.push(['Creator', authorLink]);
		}
		if (item.source) rows.push(['Source', escapeHtml(item.source)]);
		rows.push(['Added', fmtDate(item.createdAt)]);
		if (item.viewCount) rows.push(['Views', item.viewCount.toLocaleString()]);
		dl.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd class="detail-dl-normal">${v}</dd>`).join('');
	}

	// Embed panel
	buildEmbedPanel(item, $);

	// Show content, hide loading
	$('loading').hidden = true;
	$('content').hidden = false;
}

function buildEmbedPanel(item, $) {
	const panel = $('embed-panel');
	panel.hidden = false;
	panel.classList.add('detail-panel--full');

	const origin = location.origin;
	let snippets;

	if (item.kind === 'onchain') {
		const pageUrl = `${origin}/a/${item.chainId}/${item.agentId}`;
		const embedUrl = `${origin}/a/${item.chainId}/${item.agentId}/embed`;
		const agentUri = `agent://${item.chainId}/${item.agentId}`;
		const name = item.name || `Agent #${item.agentId}`;
		snippets = [
			{
				label: 'Web component',
				key: 'wc',
				value: `<script type="module" src="${LIB_CDN_URL}"></script>\n<agent-3d src="${agentUri}" mode="inline" width="480px" responsive></agent-3d>`,
				rows: 3,
			},
			{
				label: 'iframe',
				key: 'iframe',
				value: `<iframe src="${embedUrl}" width="480" height="600" style="border:0;border-radius:12px" allow="autoplay; xr-spatial-tracking" sandbox="allow-scripts allow-same-origin allow-popups" title="${name}"></iframe>`,
				rows: 3,
			},
			{ label: 'Link', key: 'link', value: pageUrl, rows: 1 },
			{
				label: 'Markdown',
				key: 'md',
				value: `[![${name}](${origin}/api/a-og?chain=${item.chainId}&id=${item.agentId})](${pageUrl})`,
				rows: 2,
			},
		];
	} else {
		const detailUrl = `${origin}/avatars/${item.avatarId}`;
		const name = item.name || 'Avatar';
		const apiSrc = `${origin}/api/avatars/${item.avatarId}`;
		snippets = [
			{
				label: 'Web component',
				key: 'wc',
				value: `<script type="module" src="${LIB_CDN_URL}"></script>\n<agent-3d src="${apiSrc}" mode="inline" width="480px" responsive></agent-3d>`,
				rows: 3,
			},
			{
				label: 'iframe',
				key: 'iframe',
				value: `<iframe src="${origin}/app#model=${encodeURIComponent(item.glbUrl)}" width="480" height="600" style="border:0;border-radius:12px" allow="autoplay; xr-spatial-tracking" title="${name}"></iframe>`,
				rows: 3,
			},
			{ label: 'Link', key: 'link', value: detailUrl, rows: 1 },
			{ label: 'GLB', key: 'glb', value: item.glbUrl, rows: 1 },
		];
	}

	const tabsEl = $('embed-tabs');
	const panesEl = $('embed-panes');
	tabsEl.innerHTML = '';
	panesEl.innerHTML = '';

	snippets.forEach((s, i) => {
		const tab = document.createElement('button');
		tab.type = 'button';
		tab.className = 'detail-embed-tab' + (i === 0 ? ' is-active' : '');
		tab.textContent = s.label;
		tab.dataset.tab = s.key;
		tabsEl.appendChild(tab);

		const pane = document.createElement('div');
		pane.className = 'detail-embed-pane' + (i === 0 ? ' is-active' : '');
		pane.dataset.pane = s.key;
		pane.innerHTML = `
			<textarea class="detail-embed-snippet" readonly rows="${s.rows}">${escapeHtml(s.value)}</textarea>
			<button type="button" class="detail-embed-copy" data-copy-key="${s.key}">Copy</button>
		`;
		panesEl.appendChild(pane);
	});

	// Tab switching
	tabsEl.addEventListener('click', (e) => {
		const tab = e.target.closest('.detail-embed-tab');
		if (!tab) return;
		tabsEl.querySelectorAll('.detail-embed-tab').forEach((t) => t.classList.remove('is-active'));
		panesEl.querySelectorAll('.detail-embed-pane').forEach((p) => p.classList.remove('is-active'));
		tab.classList.add('is-active');
		panesEl.querySelector(`[data-pane="${tab.dataset.tab}"]`)?.classList.add('is-active');
	});

	// Copy buttons
	panesEl.addEventListener('click', (e) => {
		const btn = e.target.closest('.detail-embed-copy');
		if (!btn) return;
		const key = btn.dataset.copyKey;
		const textarea = panesEl.querySelector(`[data-pane="${key}"] textarea`);
		if (!textarea) return;
		navigator.clipboard.writeText(textarea.value).then(() => {
			const orig = btn.textContent;
			btn.textContent = 'Copied!';
			setTimeout(() => { btn.textContent = orig; }, 1800);
		});
	});
}

function showError(status) {
	const $ = (role) => document.querySelector(`[data-role="${role}"]`);
	$('loading').hidden = true;
	$('error').hidden = false;
	if (status === 404) {
		$('error-title').textContent = 'Not found';
		$('error-msg').textContent = 'This item does not exist or has been removed.';
	} else {
		$('error-title').textContent = 'Something went wrong';
		$('error-msg').textContent = 'Could not load this item. Try refreshing.';
	}
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async function init() {
	const route = parseRoute();
	if (!route) {
		showError(404);
		return;
	}

	try {
		const item = await fetchItem(route);
		render(item);
	} catch (err) {
		showError(err.status || 500);
	}
})();
