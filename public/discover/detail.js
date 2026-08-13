// ─── Detail page for /discover/a/:chainId/:agentId and /discover/avatar/:id ──

const LIB_CDN_URL = 'https://three.ws/agent-3d/latest/agent-3d.js';

// Parse URL: /discover/a/{chainId}/{agentId}  or  /discover/avatar/{id}
function parseRoute() {
	const path = location.pathname;
	const solana = path.match(/^\/discover\/a\/sol\/([A-Za-z0-9]+)/);
	if (solana) return { kind: 'solana', id: solana[1] };
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

	const badges = $('badges');
	if (item.kind === 'solana') {
		badges.innerHTML = `
			<span class="explore-badge explore-badge--solana">◎ Solana</span>
			${item.has3d ? '<span class="explore-badge explore-badge--3d">3D</span>' : ''}
		`;
	} else if (item.kind === 'onchain') {
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

	const metaRow = $('meta-row');
	const metaItems = [];
	if (item.kind === 'solana') {
		if (item.owner) metaItems.push(`<span class="detail-meta-item">Owner <a href="${escapeAttr(item.ownerExplorerUrl || '#')}" target="_blank" rel="noopener">${escapeHtml(item.ownerShort)}</a></span>`);
		if (item.createdAt) metaItems.push(`<span class="detail-meta-item">Registered ${fmtDate(item.createdAt)}</span>`);
		if (item.skills?.length) metaItems.push(`<span class="detail-meta-item">${item.skills.length} skill${item.skills.length === 1 ? '' : 's'}</span>`);
	} else if (item.kind === 'onchain') {
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
		if (item.createdAt) metaItems.push(`<span class="detail-meta-item">Added ${fmtDate(item.createdAt)}</span>`);
	}
	metaRow.innerHTML = metaItems.join('');

	const actions = $('actions');
	if (item.kind === 'solana') {
		if (item.has3d && item.viewerUrl) {
			actions.innerHTML += `<a class="detail-btn detail-btn--primary" href="${escapeAttr(item.viewerUrl)}">View 3D</a>`;
		}
		actions.innerHTML += `<a class="detail-btn detail-btn--ghost" href="${escapeAttr(item.explorerUrl || '#')}" target="_blank" rel="noopener">Solscan ↗</a>`;
	} else if (item.kind === 'onchain') {
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

	if (item.kind === 'solana') {
		const panel = $('onchain-panel');
		panel.hidden = false;
		const dl = $('onchain-dl');
		const rows = [
			['Chain', 'Solana (mainnet)'],
			['Mint', `<a href="${escapeAttr(item.explorerUrl || '#')}" target="_blank" rel="noopener">${escapeHtml(item.asset)}</a>`],
			['Owner', `<a href="${escapeAttr(item.ownerExplorerUrl || '#')}" target="_blank" rel="noopener">${escapeHtml(item.owner)}</a>`],
			['Registered', fmtDate(item.createdAt)],
		];
		if (item.skills?.length) {
			rows.push(['Skills', item.skills.map((s) => escapeHtml(s)).join(', ')]);
		}
		dl.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join('');

		fetchSolanaReputation(item.asset, panel, dl);
		fetchOnchainHistory({ asset: item.asset }, $);
	}

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
		fetchOnchainHistory({ chain: item.chainId, id: item.agentId }, $);
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

	if (item.kind === 'solana') {
		const pageUrl = `${origin}/discover/a/sol/${item.asset}`;
		const cardUrl = `${origin}/a/sol/${item.asset}/.well-known/agent-card.json`;
		const name = item.name || 'Solana Agent';
		snippets = [
			{ label: 'Link', key: 'link', value: pageUrl, rows: 1 },
			{ label: 'Agent card', key: 'card', value: cardUrl, rows: 1 },
			{
				label: 'Markdown',
				key: 'md',
				value: `[${name}](${pageUrl})`,
				rows: 1,
			},
		];
	} else if (item.kind === 'onchain') {
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
		const flash = (label) => {
			const orig = btn.textContent;
			btn.textContent = label;
			setTimeout(() => { btn.textContent = orig; }, 1800);
		};
		Promise.resolve(navigator.clipboard?.writeText(textarea.value))
			.then(() => flash('Copied!'))
			.catch(() => {
				// Clipboard API can reject (permissions, insecure context) — fall
				// back to selecting the text so the user can copy manually.
				textarea.focus();
				textarea.select();
				flash('Press ⌘C / Ctrl+C');
			});
	});
}

async function fetchSolanaReputation(asset, panel, dl) {
	try {
		const res = await fetch(`/api/agents/solana-reputation?asset=${encodeURIComponent(asset)}&network=mainnet`);
		if (!res.ok) return;
		const data = await res.json();
		const rep = data.reputation;
		if (!rep) return;

		const extra = [];
		if (rep.feedback?.total > 0) {
			const avg = rep.feedback.score_avg != null ? Number(rep.feedback.score_avg).toFixed(1) : '—';
			extra.push(['Feedback', `${avg} ★ · ${rep.feedback.total} review${rep.feedback.total === 1 ? '' : 's'} (${rep.feedback.unique_attesters} attester${rep.feedback.unique_attesters === 1 ? '' : 's'})`]);
		}
		if (rep.validation) {
			const passed = (rep.validation.self_passed || 0) + (rep.validation.event_passed || 0);
			const failed = (rep.validation.self_failed || 0) + (rep.validation.event_failed || 0);
			if (passed + failed > 0) {
				extra.push(['Validation', `${passed} passed · ${failed} failed`]);
			}
		}
		if (rep.stake?.total_lamports > 0) {
			const sol = (Number(rep.stake.total_lamports) / 1e9).toFixed(4);
			extra.push(['Stake', `${sol} SOL from ${rep.stake.unique_stakers} staker${rep.stake.unique_stakers === 1 ? '' : 's'}`]);
		}
		if (rep.token_activity?.graduated) {
			extra.push(['Token', `Graduated · ${rep.token_activity.trade_count || 0} trades`]);
		}
		if (extra.length) {
			dl.innerHTML += '<dt style="grid-column:1/-1;border-top:1px solid rgba(255,255,255,0.06);padding-top:10px;margin-top:6px;font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:#888">Reputation</dt><dd style="display:none"></dd>';
			dl.innerHTML += extra.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
		}
	} catch (_) {}
}

// ─── On-chain history ────────────────────────────────────────────────────────
// Reads the platform's own cross-chain index (agent_onchain_events) rather than
// scanning an RPC in the browser, so an agent's registrations, token launches,
// reputation attestations, transfers and delegations render on one timeline for
// both Solana and EVM. Every row links to the transaction on a block explorer,
// so nothing here has to be taken on trust.

const HISTORY_CLASS_LABEL = {
	registration: 'Registered',
	metadata: 'Metadata',
	transfer: 'Transfer',
	token_launch: 'Token launch',
	reputation: 'Reputation',
	validation: 'Validation',
	delegation: 'Delegation',
};

function fmtDateTime(iso) {
	if (!iso) return '';
	return new Date(iso).toLocaleString('en-US', {
		year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
	});
}

/**
 * One line of human detail per event class, drawn from the indexed payload.
 * Returns '' when the payload adds nothing the class name did not already say.
 */
function historyDetail(ev) {
	const p = ev.payload || {};
	if (ev.eventClass === 'token_launch' && p.mint) return p.mint;
	if (ev.eventClass === 'transfer' && ev.counterparty) return `→ ${shortAddr(ev.counterparty)}`;
	if (ev.eventClass === 'metadata' && p.key) return p.value ? `${p.key} = ${p.value}` : p.key;
	if (ev.eventClass === 'reputation') {
		if (p.value != null && p.valueDecimals != null) {
			const scaled = Number(p.value) / 10 ** Number(p.valueDecimals);
			return Number.isFinite(scaled) ? `${scaled} ${p.tag1 || ''}`.trim() : '';
		}
		if (p.score != null) return `${p.score} ★`;
	}
	if (ev.eventClass === 'metadata' && p.agentUri) return p.agentUri;
	return '';
}

async function fetchOnchainHistory(query, $) {
	const panel = $('history-panel');
	if (!panel) return;
	const list = $('history');
	const foot = $('history-foot');

	const params = new URLSearchParams(
		Object.fromEntries(Object.entries(query).filter(([, v]) => v != null && v !== '')),
	);
	params.set('limit', '50');

	let data;
	try {
		const res = await fetch(`/api/agents/onchain-history?${params}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		data = await res.json();
	} catch (_) {
		// The index being unreachable is not the agent having no history, and
		// saying so is the whole point of showing this panel at all.
		panel.hidden = false;
		list.innerHTML = '<li class="detail-history-empty">On-chain history is unavailable right now. Reload to try again.</li>';
		return;
	}

	panel.hidden = false;
	const events = Array.isArray(data.events) ? data.events : [];
	$('history-count').textContent = String(events.length);

	if (!events.length) {
		list.innerHTML = data.indexLag?.crawled
			? '<li class="detail-history-empty">No on-chain events recorded for this agent yet. The indexer has looked and found nothing beyond its registration.</li>'
			: '<li class="detail-history-empty">This agent has not been crawled yet. Its history will appear here after the next indexer pass.</li>';
	} else {
		list.innerHTML = events
			.map((ev) => {
				const label = HISTORY_CLASS_LABEL[ev.eventClass] || ev.eventClass;
				const detail = historyDetail(ev);
				const link = ev.explorerUrl
					? `<a class="detail-history-link" href="${escapeAttr(ev.explorerUrl)}" target="_blank" rel="noopener" title="${escapeAttr(ev.tx)}">${escapeHtml(shortAddr(ev.tx))} ↗</a>`
					: '';
				return `<li class="detail-history-row">
					<time class="detail-history-when" datetime="${escapeAttr(ev.occurredAt)}">${escapeHtml(fmtDateTime(ev.occurredAt))}</time>
					<span class="detail-history-what">
						<span class="detail-history-class" data-class="${escapeAttr(ev.eventClass)}">${escapeHtml(label)}</span>
						<span>${escapeHtml(ev.eventName)}</span>
						${detail ? `<span class="detail-history-detail">${escapeHtml(detail)}</span>` : ''}
					</span>
					${link}
				</li>`;
			})
			.join('');
	}

	// Freshness is part of the answer: "no events" from an index last updated
	// four hours ago means something different from the same answer live.
	const lag = data.indexLag || {};
	if (!lag.crawled) {
		foot.textContent = 'Not yet crawled by the agent indexer.';
	} else if (lag.error) {
		foot.textContent = `Indexer last reported: ${lag.error}`;
	} else if (lag.lagMinutes != null) {
		foot.textContent =
			lag.lagMinutes < 1
				? 'Index up to date as of less than a minute ago.'
				: `Index last updated ${lag.lagMinutes} minute${lag.lagMinutes === 1 ? '' : 's'} ago.`;
	} else {
		foot.textContent = '';
	}
}

function showError(status, onRetry) {
	const $ = (role) => document.querySelector(`[data-role="${role}"]`);
	$('loading').hidden = true;
	$('error').hidden = false;
	const retryBtn = $('error-retry');
	if (status === 404) {
		$('error-title').textContent = 'Not found';
		$('error-msg').textContent = 'This item does not exist or has been removed.';
		// 404 is terminal — retry won't help. Offer only "Back to Discover".
		if (retryBtn) retryBtn.hidden = true;
	} else {
		$('error-title').textContent = 'Something went wrong';
		$('error-msg').textContent = 'Could not load this item. Check your connection and try again.';
		if (retryBtn && typeof onRetry === 'function') {
			retryBtn.hidden = false;
			retryBtn.onclick = onRetry;
		}
	}
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

(async function init() {
	const route = parseRoute();
	if (!route) {
		showError(404);
		return;
	}

	async function load() {
		const $ = (role) => document.querySelector(`[data-role="${role}"]`);
		$('error').hidden = true;
		$('loading').hidden = false;
		try {
			const item = await fetchItem(route);
			render(item);
		} catch (err) {
			showError(err.status || 500, load);
		}
	}

	load();
})();
