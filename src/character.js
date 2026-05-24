/**
 * /character/:id — consumer-facing character profile page
 *
 * Fetches /api/agents/:id (public GET) and renders a charms-style page:
 *   hero avatar, name, creator, stats (chats + holders), description,
 *   chat CTA, token card with price/trade, and memes gallery.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function $(id) { return document.getElementById(id); }

function formatNum(n) {
	if (n == null) return '0';
	if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
	if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
	return String(n);
}

function formatUsd(n) {
	if (n == null) return '$0';
	if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(2) + 'M';
	if (n >= 1_000) return '$' + (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
	return '$' + Number(n).toFixed(2);
}

function avatarPlaceholder(name) {
	const letter = (name || '?')[0].toUpperCase();
	const hue = [...(name || 'X')].reduce((acc, c) => acc + c.charCodeAt(0), 0) % 360;
	return { letter, color: `hsl(${hue}, 55%, 45%)` };
}

function agentId() {
	const parts = location.pathname.split('/').filter(Boolean);
	return parts[1] || null;
}

async function fetchAgent(id) {
	const res = await fetch(`/api/agents/${encodeURIComponent(id)}`);
	if (!res.ok) throw Object.assign(new Error('not found'), { status: res.status });
	const json = await res.json();
	return json.agent;
}

function renderHero(agent) {
	// Avatar
	const avatarImg = $('ch-avatar-img');
	const avatarPH = $('ch-avatar-ph');
	const imageUrl =
		agent.meta?.profile_image_url ||
		agent.avatar_thumbnail_url ||
		agent.meta?.thumbnail_url ||
		agent.meta?.avatar_url ||
		null;

	if (imageUrl) {
		avatarImg.src = imageUrl;
		avatarImg.alt = agent.name;
		avatarImg.style.display = 'block';
		avatarPH.style.display = 'none';
		avatarImg.onerror = () => {
			avatarImg.style.display = 'none';
			showPlaceholder(agent, avatarPH);
		};
	} else {
		avatarImg.style.display = 'none';
		showPlaceholder(agent, avatarPH);
	}

	// Name
	$('ch-name').textContent = agent.name || 'Unnamed';
	document.title = `${agent.name || 'Character'} — three.ws`;

	// Creator
	const authorName = agent.author_name || 'Unknown';
	const authorAvatar = agent.author_avatar || null;
	const creatorEl = $('ch-creator');

	if (authorAvatar) {
		const img = document.createElement('img');
		img.src = authorAvatar;
		img.className = 'ch-creator-avatar';
		img.alt = authorName;
		img.onerror = () => img.remove();
		creatorEl.appendChild(img);
	}

	const byText = document.createElement('span');
	byText.textContent = 'by ';
	creatorEl.appendChild(byText);

	const handle = document.createElement('span');
	handle.textContent = '@' + (authorName.toLowerCase().replace(/\s+/g, ''));
	creatorEl.appendChild(handle);

	// Stats
	$('ch-stat-chats').textContent = formatNum(agent.chat_count ?? 0);
	const holders = agent.token?.holders ?? agent.meta?.token?.holders ?? 0;
	$('ch-stat-holders').textContent = formatNum(holders);

	// Description
	$('ch-desc').textContent = agent.description || '';

	// Chat button
	const chatBtn = $('ch-chat-btn');
	chatBtn.href = `/agent/${agent.id}`;
}

function showPlaceholder(agent, el) {
	const { letter, color } = avatarPlaceholder(agent.name);
	el.textContent = letter;
	el.style.background = color;
	el.style.display = 'flex';
}

async function fetchDexScreener(mint) {
	try {
		const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
		if (!res.ok) return null;
		const data = await res.json();
		const pairs = (data.pairs || []).filter(p => p.chainId === 'solana');
		if (!pairs.length) return null;
		// Pick highest-liquidity pair
		pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
		const p = pairs[0];
		return {
			priceUsd: parseFloat(p.priceUsd) || null,
			marketCapUsd: p.marketCap ?? null,
			change24h: p.priceChange?.h24 ?? null,
			volume24h: p.volume?.h24 ?? null,
			liquidity: p.liquidity?.usd ?? null,
			dexUrl: p.url ?? `https://dexscreener.com/solana/${mint}`,
		};
	} catch {
		return null;
	}
}

function buildTokenHtml(symbol, mint, marketCapUsd, priceUsd, change24h, holders, volume24h) {
	const displayPrice = marketCapUsd != null
		? formatUsd(marketCapUsd)
		: priceUsd != null
		? formatUsd(priceUsd)
		: '—';

	const priceLabel = marketCapUsd != null ? 'MCAP' : 'PRICE';

	let changeHtml = '';
	if (change24h != null) {
		const sign = change24h >= 0 ? '+' : '';
		const cls = change24h >= 0 ? 'up' : 'down';
		const arrow = change24h >= 0 ? '▲' : '▼';
		changeHtml = `<span class="ch-price-change ${cls}">${arrow} ${sign}${Number(change24h).toFixed(2)}%</span>`;
	}

	const tradeUrl = mint ? `https://dexscreener.com/solana/${mint}` : '#';
	const chartUrl = mint ? `https://birdeye.so/token/${mint}?chain=solana` : '#';

	const metaItems = [];
	if (holders) metaItems.push({ label: 'Holders', val: formatNum(holders) });
	if (volume24h) metaItems.push({ label: '24h Vol', val: formatUsd(volume24h) });
	if (symbol) metaItems.push({ label: 'Symbol', val: '$' + symbol });

	const metaHtml = metaItems.map(m =>
		`<div class="ch-token-meta-item">
			<span class="ch-token-meta-label">${m.label}</span>
			<span class="ch-token-meta-val">${m.val}</span>
		</div>`
	).join('');

	return `
		<div class="ch-token-header">
			<span class="ch-token-name">${symbol}</span>
			<span class="ch-token-dot"></span>
		</div>
		<div class="ch-token-price">
			<span class="ch-price-main">${displayPrice}</span>
			${changeHtml}
			<span style="font-size:11px;color:#9ca3af;font-weight:500;margin-left:2px">${priceLabel}</span>
		</div>
		<div class="ch-token-actions">
			<a class="ch-trade-btn" href="${tradeUrl}" target="_blank" rel="noopener">Trade</a>
			<a class="ch-chart-btn" href="${chartUrl}" target="_blank" rel="noopener" title="View chart">
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
					<path d="M3 3v18h18"/>
					<path d="M18.5 8L13 13.5 8.5 10 3 15"/>
				</svg>
			</a>
		</div>
		${metaItems.length ? `<div class="ch-token-meta">${metaHtml}</div>` : ''}
	`;
}

async function renderToken(agent) {
	const tokenSection = $('ch-token-section');
	const token = agent.token || agent.meta?.token || null;

	if (!token) {
		tokenSection.innerHTML = '<p class="ch-no-token">No token linked yet.</p>';
		return;
	}

	const symbol = token.symbol || token.name || 'TOKEN';
	const mint = token.mint || token.contract_address || token.contractAddress || null;

	// Render immediately from stored data
	let priceUsd = token.price_usd ?? token.priceUsd ?? null;
	let marketCapUsd = token.market_cap_usd ?? token.marketCapUsd ?? token.usd_market_cap ?? null;
	let change24h = token.change_24h_percent ?? token.change24hPercent ?? null;
	let holders = token.holders ?? 0;
	let volume24h = token.volume_24h_usd ?? token.volume24hUsd ?? null;

	const displayPrice = marketCapUsd != null
		? formatUsd(marketCapUsd)
		: priceUsd != null
		? formatUsd(priceUsd)
		: '—';

	const priceLabel = marketCapUsd != null ? 'MCAP' : 'PRICE';

	let changeHtml = '';
	if (change24h != null) {
		const sign = change24h >= 0 ? '+' : '';
		const cls = change24h >= 0 ? 'up' : 'down';
		const arrow = change24h >= 0 ? '▲' : '▼';
		changeHtml = `<span class="ch-price-change ${cls}">${arrow} ${sign}${Number(change24h).toFixed(2)}%</span>`;
	}

	const tradeUrl = mint
		? `https://dexscreener.com/solana/${mint}`
		: '#';
	const chartUrl = mint
		? `https://birdeye.so/token/${mint}?chain=solana`
		: '#';

	const metaItems = [];
	if (holders) metaItems.push({ label: 'Holders', val: formatNum(holders) });
	if (volume24h) metaItems.push({ label: '24h Vol', val: formatUsd(volume24h) });
	if (symbol) metaItems.push({ label: 'Symbol', val: '$' + symbol });

	const metaHtml = metaItems.map(m =>
		`<div class="ch-token-meta-item">
			<span class="ch-token-meta-label">${m.label}</span>
			<span class="ch-token-meta-val">${m.val}</span>
		</div>`
	).join('');

	tokenSection.innerHTML = buildTokenHtml(symbol, mint, marketCapUsd, priceUsd, change24h, holders, volume24h);

	// Fetch live market data from DexScreener and update card
	if (mint) {
		fetchDexScreener(mint).then(live => {
			if (!live) return;
			tokenSection.innerHTML = buildTokenHtml(
				symbol, mint,
				live.marketCapUsd ?? marketCapUsd,
				live.priceUsd ?? priceUsd,
				live.change24h ?? change24h,
				holders,
				live.volume24h ?? volume24h,
			);
		}).catch(() => { /* DexScreener unavailable — static data already rendered */ });
	}
}

function renderMemes(agent) {
	const grid = $('ch-memes-grid');
	const memes = agent.meta?.memes || [];

	const createCard = `
		<a class="ch-meme-create" href="/agent/${agent.id}?meme=1" title="Create meme">
			<div class="ch-meme-create-icon">
				<img src="${agent.meta?.profile_image_url || agent.avatar_thumbnail_url || ''}"
				     onerror="this.style.display='none'"
				     alt="${agent.name}" />
			</div>
			<span class="ch-meme-create-label">Create Meme</span>
		</a>
	`;

	if (!memes.length) {
		grid.innerHTML = createCard + '<div class="ch-memes-empty">No memes yet. Be first!</div>';
		return;
	}

	const memeCards = memes.slice(0, 5).map(m => `
		<div class="ch-meme-item">
			<img src="${m.image_url}" alt="meme" loading="lazy" />
			${m.creator ? `<div class="ch-meme-author">${m.creator}</div>` : ''}
		</div>
	`).join('');

	grid.innerHTML = createCard + memeCards;
}

function showError(msg) {
	const shell = document.querySelector('.ch-shell');
	if (shell) {
		shell.innerHTML = `
			<div class="ch-error">
				<h2>Character not found</h2>
				<p>${msg || 'This character does not exist or has been removed.'}</p>
				<br>
				<a href="/" class="ch-btn-primary" style="display:inline-block;margin-top:8px">Go home</a>
			</div>
		`;
	}
}

async function init() {
	const id = agentId();
	if (!id || !UUID_RE.test(id)) {
		showError('Invalid character ID.');
		return;
	}

	let agent;
	try {
		agent = await fetchAgent(id);
	} catch (e) {
		showError(e.status === 404 ? 'Character not found.' : 'Failed to load. Please try again.');
		return;
	}

	document.querySelector('.ch-shell')?.classList.remove('ch-loading');

	renderHero(agent);
	renderToken(agent); // async — DexScreener fetch updates card in background
	renderMemes(agent);
}

init();
