/**
 * Pump.fun Live Feed Widget
 *
 * DOM overlay on top of the 3D viewer. Subscribes to /api/agents/pumpfun-feed
 * (SSE) and renders a stack of cards. When `autoNarrate` is on, the agent
 * narrates each event through the existing protocol bus — speak + emote
 * routed through the Empathy Layer (see src/CLAUDE.md "Empathy Layer").
 *
 * Config (validated in widget-types.js):
 *   - kind        'all' | 'claims' | 'graduations'
 *   - minTier     ''    | 'notable' | 'influencer' | 'mega'
 *   - autoNarrate boolean
 *   - maxCards    1..50
 */

import { applyReaction, createReactionDispatcher, mountReactionToast } from './pumpfun-reactions.js';
import { WORD_BLACKLIST } from '../profanity.js';
import { terminalLinks, referralOffers } from '../shared/trading-terminals.js';

const FEED_PATH = '/api/agents/pumpfun-feed';
const TIER_BADGE = { mega: '🔥🔥', influencer: '🔥', notable: '⭐' };

function isBlocked(ev) {
	if (!ev) return false;
	const name = (ev.name || ev.token_name || '').toLowerCase();
	const symbol = (ev.symbol || ev.token_symbol || '').toLowerCase();
	const desc = (ev.description || '').toLowerCase();
	const text = name + ' ' + symbol + ' ' + desc;
	return WORD_BLACKLIST.some((word) => text.includes(word));
}

/**
 * @param {import('../viewer.js').Viewer} viewer
 * @param {object} config
 * @param {HTMLElement} container  parent element to attach the overlay to
 * @param {{ protocol?: any }} [ctx]
 */
export async function mountPumpfunFeed(viewer, config, container, ctx = {}) {
	const root = document.createElement('div');
	root.className = 'pumpfun-feed';
	root.style.cssText = [
		'position:absolute',
		'right:0',
		'top:0',
		'bottom:0',
		'width:320px',
		'max-height:100%',
		'overflow-y:auto',
		'pointer-events:auto',
		'z-index:5',
		'font-family:ui-sans-serif,system-ui,-apple-system,sans-serif',
		'color:#fff',
		'padding: 16px',
		'box-sizing: border-box'
	].join(';');
	(container || document.body).appendChild(root);

	const status = document.createElement('div');
	status.style.cssText = 'opacity:0.6;font-size:12px;padding:4px 8px';
	status.textContent = 'Connecting to pump.fun feed…';
	root.appendChild(status);

	const stack = document.createElement('div');
	root.appendChild(stack);

	const params = new URLSearchParams();
	params.set('kind', config.kind || 'all');
	if (config.minTier) params.set('minTier', config.minTier);

	const es = new EventSource(`${FEED_PATH}?${params.toString()}`, {
		withCredentials: true,
	});

	const maxCards = Math.max(1, Math.min(50, config.maxCards || 8));
	const protocol = ctx.protocol || (typeof window !== 'undefined' ? window.VIEWER?.agent_protocol : null);
	let narrateOn = config.autoNarrate !== false;
	const dispatcher = createReactionDispatcher({
		mood: config.mood || 'normal',
	});
	const detachToast = mountReactionToast(container || document.body, dispatcher);
	const react = (kind, ev) => {
		dispatcher.dispatch(kind, ev, (reaction) => {
			// Even with narration off, still drive emote+gesture so the avatar
			// reacts visually. `speak` is the only channel gated by narrateOn.
			applyReaction(protocol, reaction, { speak: narrateOn });
		});
	};

	const onNarrateToggle = (e) => {
		narrateOn = !!e.detail?.on;
	};
	(container || document.body).addEventListener('pumpfun-feed:set-narrate', onNarrateToggle);

	let focusMint = null;
	const matchesFocus = (ev) =>
		!focusMint || ev?.mint === focusMint || ev?.token_mint === focusMint;

	const onFocus = (e) => {
		focusMint = e.detail?.mint || null;
		// Mark visually when a filter is active.
		status.textContent = focusMint
			? `Live · pump.fun · ${focusMint.slice(0, 6)}…${focusMint.slice(-4)}`
			: 'Live · pump.fun';
		// Highlight: pulse the badge once.
		status.style.transition = 'color .2s';
		status.style.color = focusMint ? '#6ce0c8' : '';
	};
	(container || document.body).addEventListener('pumpfun-feed:focus-mint', onFocus);

	es.addEventListener('open', () => {
		status.textContent = focusMint
			? `Live · pump.fun · ${focusMint.slice(0, 6)}…${focusMint.slice(-4)}`
			: 'Live · pump.fun';
	});

	es.addEventListener('claim', (msg) => {
		const ev = safeJson(msg.data);
		if (!ev) return;
		if (!matchesFocus(ev)) return;
		addCard(stack, renderClaim(ev), maxCards);
		// Replayed (buffered backfill) events render but skip reactions — the
		// agent shouldn't dance to news that's already minutes old.
		if (!ev.replay) react('claim', ev);
	});

	es.addEventListener('graduation', (msg) => {
		const ev = safeJson(msg.data);
		if (!ev) return;
		if (!matchesFocus(ev)) return;
		addCard(stack, renderGraduation(ev), maxCards);
		if (!ev.replay) react('graduation', ev);
	});

	es.addEventListener('mint', (msg) => {
		const ev = safeJson(msg.data);
		if (!ev) return;
		if (!matchesFocus(ev)) return;
		// Mints don't render their own card in this widget (the card stack is
		// claim/graduation focused), but they should still tickle the avatar
		// when something notable lands.
		if (!ev.replay) react('mint', ev);
	});

	es.addEventListener('error', () => {
		if (es.readyState === EventSource.CLOSED) {
			status.textContent = 'Disconnected.';
		}
	});

	es.addEventListener('close', () => {
		status.textContent = 'Reconnecting…';
	});

	const onMood = (e) => {
		const m = e.detail?.mood;
		if (m) dispatcher.setMood(m);
	};
	(container || document.body).addEventListener('pumpfun-feed:set-mood', onMood);

	return {
		destroy() {
			try { es.close(); } catch {}
			(container || document.body).removeEventListener('pumpfun-feed:focus-mint', onFocus);
			(container || document.body).removeEventListener('pumpfun-feed:set-narrate', onNarrateToggle);
			(container || document.body).removeEventListener('pumpfun-feed:set-mood', onMood);
			detachToast?.();
			root.remove();
		},
		dispatcher,
	};
}

function addCard(stack, el, max) {
	stack.prepend(el);
	while (stack.children.length > max) stack.lastChild?.remove();
}

function renderClaim(ev) {
	if (ev.first_time_claim && (ev.github_user || ev.github_repo || ev.github_account_age_days != null)) {
		return renderFirstGithubClaim(ev);
	}
	const el = document.createElement('div');
	el.style.cssText = cardStyle(ev.fake_claim ? '#3a1418' : ev.first_time_claim ? '#0d2d1a' : '#161616');
	const tier = ev.tier ? `${TIER_BADGE[ev.tier] || ''} ${ev.tier}` : '';
	const sol = ev.amount_sol != null ? `${Number(ev.amount_sol).toFixed(3)} SOL` : '';
	el.innerHTML = `
		<div style="display:flex;justify-content:space-between;font-size:11px;opacity:0.7">
			<span>${ev.first_time_claim ? '🚨 FIRST CLAIM' : 'Claim'}</span>
			<span>${tier}</span>
		</div>
		<div style="font-weight:600;margin-top:4px">${escapeHtml(ev.github_user ? '@' + ev.github_user : ev.claimer || '—')}</div>
		<div style="font-size:12px;opacity:0.85">${sol}${ev.token_symbol ? ' · $' + escapeHtml(ev.token_symbol) : ''}</div>
		${ev.ai_take ? `<div style="font-size:11px;opacity:0.75;margin-top:4px;font-style:italic">${escapeHtml(ev.ai_take)}</div>` : ''}
	`;
	return el;
}

function renderFirstGithubClaim(ev) {
	const el = document.createElement('div');
	el.style.cssText = [
		'background:linear-gradient(180deg,#0d2d1a 0%,#0a1f14 100%)',
		'border:1px solid rgba(108,224,200,0.35)',
		'border-radius:10px',
		'padding:12px 14px',
		'margin-bottom:8px',
		'box-shadow:0 4px 14px rgba(0,0,0,0.45)',
		'font-size:12px',
		'line-height:1.5',
	].join(';');

	const tier = ev.tier ? `${TIER_BADGE[ev.tier] || ''} ${cap(ev.tier)}` : '';
	const symbol = ev.token_symbol || ev.symbol;
	const name = ev.token_name || ev.name;
	const mint = ev.mint || ev.token_mint || '';
	const mcUsd = num(ev.market_cap_usd);
	const priceSol = ev.price_sol != null ? Number(ev.price_sol).toFixed(9).replace(/0+$/, '').replace(/\.$/, '') : null;
	const priceUsd = ev.price_usd != null ? Number(ev.price_usd).toFixed(6).replace(/0+$/, '').replace(/\.$/, '') : null;
	const createdAgo = relTime(ev.token_created_at || ev.created_at);
	const status = ev.graduated
		? 'Graduated to PumpAMM'
		: ev.curve_progress != null ? `Bonding curve (${Math.round(ev.curve_progress)}%)` : null;
	const ath = num(ev.ath_usd || ev.market_cap_ath_usd);
	const lastTrade = relTime(ev.last_trade_at);

	const claimNum = ev.claim_count ?? ev.claim_number ?? 1;
	const amtSol = ev.amount_sol != null ? Number(ev.amount_sol).toFixed(4) : null;
	const amtUsd = num(ev.amount_usd);
	const lifeSol = ev.lifetime_claim_sol != null ? Number(ev.lifetime_claim_sol).toFixed(4) : amtSol;
	const lifeUsd = num(ev.lifetime_claim_usd) || amtUsd;
	const claimType = ev.claim_type || 'Claim Social Fee PDA (GitHub)';

	const claimer = ev.claimer || ev.github_wallet;
	const tx = ev.tx_signature || ev.signature;

	const ghUser = ev.github_user;
	const ghName = ev.github_name;
	const ghRepos = ev.github_repos;
	const ghFollowers = ev.github_followers;
	const ghFollowing = ev.github_following;
	const ghAge = ev.github_account_age_days != null ? formatAccountAge(ev.github_account_age_days) : null;
	const ghLoc = ev.github_location;
	const ghBio = ev.github_bio;
	const ghTwitter = ev.github_twitter;

	const repoFull = ev.github_repo_full || (ghUser && ev.github_repo ? `${ghUser}/${ev.github_repo}` : null);
	const repoDesc = ev.github_repo_description;
	const repoLang = ev.github_repo_language;
	const repoStars = ev.github_repo_stars;
	const repoForks = ev.github_repo_forks;
	const repoLastPush = relTime(ev.github_repo_last_push);
	const repoCreated = relTime(ev.github_repo_created_at);
	const repoTopics = Array.isArray(ev.github_repo_topics) ? ev.github_repo_topics : null;

	const creator = ev.token_creator;
	const creatorLaunches = ev.creator_launches;
	const creatorGraduated = ev.creator_graduated;
	const creatorTokens = Array.isArray(ev.creator_recent_tokens) ? ev.creator_recent_tokens : null;

	const verified = ev.verified ?? ev.signal_verified;

	const sections = [];

	sections.push(`
		<div style="font-weight:700;color:#ff6e6e;letter-spacing:0.5px">🚨🚨🚨 FIRST CREATOR FEE CLAIM</div>
		${tier ? `<div style="opacity:0.85;margin-top:2px">${escapeHtml(tier)}</div>` : ''}
		${mint ? `<div style="font-family:ui-monospace,monospace;font-size:11px;opacity:0.7;margin-top:6px;word-break:break-all">${escapeHtml(mint)}</div>` : ''}
	`);

	const tokenLines = [];
	if (symbol || name) tokenLines.push(`🐙 ${symbol ? '$' + escapeHtml(symbol) : ''}${symbol && name ? ' — ' : ''}${name ? escapeHtml(name) : ''}`);
	if (mcUsd) tokenLines.push(`💰 MC: $${mcUsd}`);
	if (priceSol || priceUsd) tokenLines.push(`💲 Price: ${priceSol ? priceSol + ' SOL' : ''}${priceSol && priceUsd ? ' ' : ''}${priceUsd ? '($' + priceUsd + ')' : ''}`);
	if (createdAgo) tokenLines.push(`⏱ Created: ${createdAgo}`);
	if (status) tokenLines.push(`📈 Status: ${escapeHtml(status)}`);
	if (ath) tokenLines.push(`🏆 ATH: $${ath}`);
	if (lastTrade) tokenLines.push(`🕐 Last trade: ${lastTrade}`);
	if (tokenLines.length) sections.push(linesBlock(tokenLines));

	const claimLines = [`<b>Claim #${claimNum}</b>`];
	if (amtSol || amtUsd) claimLines.push(`${amtSol || '?'} SOL${amtUsd ? ' ($' + amtUsd + ')' : ''}`);
	if (lifeSol || lifeUsd) claimLines.push(`Lifetime claims: ${lifeSol || '?'} SOL${lifeUsd ? ' ($' + lifeUsd + ')' : ''}`);
	claimLines.push(`Type: ${escapeHtml(claimType)}`);
	sections.push(headedBlock('💸 Claim Stats', claimLines));

	if (claimer) {
		sections.push(headedBlock('👛 Claimed By', [
			escapeHtml(shortAddr(claimer)),
			`🔗 <a href="https://pump.fun/profile/${encodeURIComponent(claimer)}" target="_blank" rel="noopener" style="color:#6ce0c8">pump.fun/profile/${escapeHtml(shortAddr(claimer))}</a>`,
		]));
	}

	if (tx) {
		sections.push(headedBlock('🔎 Transaction', [
			`<a href="https://solscan.io/tx/${encodeURIComponent(tx)}" target="_blank" rel="noopener" style="color:#6ce0c8;word-break:break-all">solscan.io/tx/${escapeHtml(tx.slice(0, 24))}…</a>`,
		]));
	}

	if (ghUser || ghName) {
		const devLines = [];
		devLines.push(`<b>${escapeHtml(ghUser || '')}</b>${ghName ? ' (' + escapeHtml(ghName) + ')' : ''}`);
		if (ghRepos != null) devLines.push(`📦 Repos: ${ghRepos}`);
		if (ghFollowers != null) devLines.push(`👁 Followers: ${ghFollowers}`);
		if (ghFollowing != null) devLines.push(`👥 Following: ${ghFollowing}`);
		if (ghAge) devLines.push(`📅 Account age: ${ghAge}`);
		if (ghLoc) devLines.push(`📍 Location: ${escapeHtml(ghLoc)}`);
		if (ghBio) devLines.push(`<span style="opacity:0.85;font-style:italic">${escapeHtml(ghBio)}</span>`);
		if (ghTwitter) devLines.push(`𝕏 <a href="https://x.com/${encodeURIComponent(ghTwitter)}" target="_blank" rel="noopener" style="color:#6ce0c8">${escapeHtml(ghTwitter)}</a>`);
		sections.push(headedBlock('👨‍💻 Linked Dev', devLines));
	}

	if (repoFull) {
		const repoLines = [`<b>${escapeHtml(repoFull)}</b>`];
		if (repoDesc) repoLines.push(`<span style="opacity:0.85">${escapeHtml(repoDesc)}</span>`);
		if (repoLang) repoLines.push(`🔤 Language: ${escapeHtml(repoLang)}`);
		if (repoStars != null) repoLines.push(`⭐ Stars: ${repoStars}`);
		if (repoForks != null) repoLines.push(`🍴 Forks: ${repoForks}`);
		if (repoLastPush) repoLines.push(`🕐 Last push: ${repoLastPush}`);
		if (repoCreated) repoLines.push(`📅 Repo created: ${repoCreated}`);
		if (repoTopics?.length) repoLines.push(`🏷 Topics: ${repoTopics.map(escapeHtml).join(', ')}`);
		sections.push(headedBlock('📂 Repo Claimed', repoLines));
	}

	if (creator) {
		const cLines = [escapeHtml(shortAddr(creator))];
		if (creatorLaunches != null) cLines.push(`🚀 Launches: ${creatorLaunches}`);
		if (creatorGraduated != null) cLines.push(`🎓 Graduated: ${creatorGraduated}`);
		if (creatorTokens?.length) {
			const tokenStr = creatorTokens
				.slice(0, 3)
				.map((t) => `${escapeHtml(t.symbol || '?')}${t.tier ? TIER_BADGE[t.tier] || '' : ''}${t.market_cap_usd != null ? ' [' + num(t.market_cap_usd) + ']' : ''}`)
				.join(' · ');
			cLines.push(`🪙 ${tokenStr}`);
		}
		sections.push(headedBlock('🧑‍💻 Token Creator', cLines));
	}

	if (verified || ev.ai_take) {
		const sigLines = [];
		if (verified) sigLines.push('✅ Verified — token GitHub matches claimer');
		if (ev.ai_take) sigLines.push(`<span style="font-style:italic;opacity:0.85">${escapeHtml(ev.ai_take)}</span>`);
		sections.push(headedBlock('⚡ Signals', sigLines));
	}

	const links = [];
	if (mint) links.push(`<a href="/oracle/coin/${encodeURIComponent(mint)}" style="color:#6ce0c8">📈 coin page</a>`);
	if (mint) links.push(`<a href="https://pump.fun/coin/${encodeURIComponent(mint)}" target="_blank" rel="noopener" style="color:#6ce0c8">📊 pump.fun</a>`);
	if (ghTwitter) links.push(`<a href="https://x.com/${encodeURIComponent(ghTwitter)}" target="_blank" rel="noopener" style="color:#6ce0c8">𝕏 ${escapeHtml(ghTwitter)}</a>`);
	if (repoFull) links.push(`<a href="https://github.com/${repoFull.split('/').map(encodeURIComponent).join('/')}" target="_blank" rel="noopener" style="color:#6ce0c8">🌐 github.com/${escapeHtml(repoFull)}</a>`);
	if (links.length) sections.push(`<div style="margin-top:8px;display:flex;flex-direction:column;gap:2px">${links.join('')}</div>`);

	if (mint) {
		const trade = terminalLinks(mint)
			.map((t) => `<a href="${attrEsc(t.url)}" target="_blank" rel="noopener" style="color:#6ce0c8">${t.label}</a>`)
			.join(' | ');
		const offers = referralOffers()
			.map((o) => `<a href="${attrEsc(o.url)}" target="_blank" rel="noopener" style="color:#7a7a8c">${o.label}</a>`)
			.join(' ⋅ ');
		sections.push(`
			<div style="border-top:1px solid rgba(255,255,255,0.08);margin-top:10px;padding-top:8px">
				<div style="font-weight:600">💹 Trade</div>
				<div style="margin-top:2px">${trade}</div>
				<div style="margin-top:4px;font-size:10px;color:#6a6a82">New account? Sign up with a fee discount: ${offers}</div>
			</div>
		`);
	}

	el.innerHTML = sections.join('<div style="height:8px"></div>');
	return el;
}

function headedBlock(heading, lines) {
	return `
		<div>
			<div style="font-weight:600">${heading}</div>
			<div style="margin-top:2px">${lines.map((l) => `<div>${l}</div>`).join('')}</div>
		</div>
	`;
}

function linesBlock(lines) {
	return `<div>${lines.map((l) => `<div>${l}</div>`).join('')}</div>`;
}

function num(x) {
	if (x == null || !isFinite(x)) return null;
	const n = Number(x);
	if (n >= 1000) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
	return n.toFixed(2);
}

function relTime(t) {
	if (t == null) return null;
	const ts = typeof t === 'number' ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
	if (!isFinite(ts)) return null;
	const diff = Date.now() - ts;
	if (diff < 60_000) return `${Math.max(1, Math.round(diff / 1000))}s ago`;
	if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
	if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
	if (diff < 30 * 86_400_000) return `${Math.round(diff / (7 * 86_400_000))}w ago`;
	if (diff < 365 * 86_400_000) return `${Math.round(diff / (30 * 86_400_000))}mo ago`;
	return `${Math.round(diff / (365 * 86_400_000))}y ago`;
}

function formatAccountAge(days) {
	if (days < 30) return `${Math.round(days)}d ago`;
	if (days < 365) return `${Math.round(days / 30)}mo ago`;
	return `${Math.round(days / 365)}y ago`;
}

function shortAddr(s) {
	const str = String(s || '');
	if (str.length <= 12) return str;
	return `${str.slice(0, 6)}…${str.slice(-4)}`;
}

function cap(s) {
	const str = String(s || '');
	return str ? str[0].toUpperCase() + str.slice(1) : '';
}

function renderGraduation(ev) {
	const el = document.createElement('div');
	el.style.cssText = cardStyle('#1a1632') + ';position:relative' + (ev.replay ? ';opacity:0.62' : '');
	const mint = ev.mint || '';
	const m = encodeURIComponent(mint);
	const name = ev.name || ev.symbol || mint || '—';
	const symbol = ev.symbol || '?';
	const age = ev.age || (ev.created_at ? relTime(ev.created_at) : '');
	const desc = ev.description ? String(ev.description) : '';
	const descClip = desc ? escapeHtml(desc.slice(0, 100)) + (desc.length > 100 ? '…' : '') : '';

	const mcInitial = ev.market_cap_usd_initial ?? ev.initial_market_cap_usd ?? ev.market_cap_at_launch;
	const mcCurrent = ev.usd_market_cap ?? ev.market_cap_usd ?? ev.market_cap;
	const mcStr = (mcInitial != null && mcCurrent != null)
		? `$${num(mcInitial)} ⇨ $${num(mcCurrent)}`
		: (mcCurrent != null ? `$${num(mcCurrent)}` : '');
	const ath = ev.ath_market_cap ?? ev.ath_usd ?? null;
	const athStr = ath != null && ath !== mcCurrent ? `$${num(ath)}` : '';

	const launches = ev.creator_launches;
	const graduated = ev.creator_graduated;
	const bestToken = Array.isArray(ev.creator_tokens) && ev.creator_tokens.length
		? ev.creator_tokens.slice().sort((a, b) => (b?.mc || 0) - (a?.mc || 0))[0]
		: null;
	const bestStr = bestToken
		? (bestToken.symbol === symbol
			? `best $${escapeHtml(bestToken.symbol)}${bestToken.mc ? ' $' + num(bestToken.mc) : ''} (this)`
			: `best $${escapeHtml(bestToken.symbol || '?')}${bestToken.mc ? ' $' + num(bestToken.mc) : ''}`)
		: '';
	const amountStr = ev.amount_sol != null
		? `${Number(ev.amount_sol).toFixed(2)} SOL${ev.amount_usd != null ? ' [$' + num(ev.amount_usd) + ']' : ''}`
		: '';
	const launchesPart = launches != null
		? (graduated != null ? `${launches} launches · 🎓 ${graduated}` : `${launches} launches`)
		: '';
	const devLine = [launchesPart, bestStr, amountStr].filter(Boolean).join(' · ');

	const socials = [
		ev.twitter ? `<a href="${attrEsc(twitterHref(ev.twitter))}" target="_blank" rel="noopener" style="color:#cbd5e1">𝕏</a>` : '',
		ev.telegram ? `<a href="${attrEsc(ev.telegram)}" target="_blank" rel="noopener" style="color:#cbd5e1">TG</a>` : '',
		ev.website ? `<a href="${attrEsc(ev.website)}" target="_blank" rel="noopener" style="color:#cbd5e1">🌐</a>` : '',
	].filter(Boolean).join(' ');

	const chartLinks = mint
		? `<a href="https://dexscreener.com/solana/${m}" target="_blank" rel="noopener" style="color:#888888">DEX</a>⋅<a href="https://www.defined.fi/sol/${m}" target="_blank" rel="noopener" style="color:#888888">DEF</a>`
		: '';
	const toolAbbr = mint
		? [
			...terminalLinks(mint).map((t) => [t.short, t.url]),
			['PHO', `https://photon-sol.tinyastro.io/en/lp/${mint}`],
			['BLX', `https://bullx.io/terminal?chainId=1399811149&address=${mint}`],
		].map(([l, u]) => `<a href="${attrEsc(u)}" target="_blank" rel="noopener" style="color:#888888">${l}</a>`).join('⋅')
		: '';

	const sig = ev.signature || ev.tx_signature;
	const ts = ev.timestamp ?? ev.block_time ?? ev.created_at;
	const tsStr = ts ? new Date(ts < 1e12 ? ts * 1000 : ts).toISOString().replace('T', ' ').replace(/\..+$/, '') + ' UTC' : '';

	const replayBadge = ev.replay
		? `<span style="position:absolute;top:8px;right:10px;font-size:9px;letter-spacing:.08em;text-transform:uppercase;color:#6a6a82;padding:1px 6px;border:1px solid #2a2a3c;border-radius:999px;background:#0e0e16">replay</span>`
		: '';
	const thumb = ev.image_uri
		? `<img src="${attrEsc(ev.image_uri)}" alt="" loading="lazy" referrerpolicy="no-referrer" data-fallback="hide" style="width:40px;height:40px;border-radius:6px;object-fit:cover;border:1px solid #2a2a3c;background:#0e0e16;flex:0 0 40px" />`
		: '';

	el.innerHTML = `
		${replayBadge}
		<div style="display:flex;gap:10px;align-items:flex-start">
			${thumb}
			<div style="flex:1;min-width:0">
				<div style="font-weight:700">🆕💊 ${escapeHtml(name)} — $${escapeHtml(symbol)}${age ? ' [' + escapeHtml(age) + ']' : ''}</div>
				${descClip ? `<div style="opacity:0.78;font-size:11px;margin-top:2px">${descClip}</div>` : ''}
				${socials ? `<div style="margin-top:4px;display:flex;gap:6px">${socials}</div>` : ''}
			</div>
		</div>
		${mcStr ? `<div style="margin-top:6px">💎 MC: ${mcStr}${athStr ? ' · 🏆 ATH: ' + athStr : ''}</div>` : ''}
		${devLine ? `<div style="margin-top:4px;font-size:11px;opacity:0.9">👨‍💻 ${devLine}</div>` : ''}
		${chartLinks ? `<div style="margin-top:4px;font-size:11px">💹 Chart: ${chartLinks}</div>` : ''}
		${toolAbbr ? `<div style="font-size:11px">🧰 ${toolAbbr}</div>` : ''}
		<div style="font-family:ui-monospace,monospace;font-size:10px;opacity:0.55;margin-top:4px;word-break:break-all">${escapeHtml(mint)}</div>
		<div style="font-size:10px;opacity:0.55;margin-top:2px;display:flex;gap:8px;flex-wrap:wrap">
			${sig ? `🔗 <a href="https://solscan.io/tx/${encodeURIComponent(sig)}" target="_blank" rel="noopener" style="color:#888888">TX</a>` : ''}
			${mint ? `· <a href="/oracle/coin/${m}" style="color:#888888">coin page</a>` : ''}
			${mint ? `· <a href="https://pump.fun/coin/${m}" target="_blank" rel="noopener" style="color:#888888">pump.fun</a>` : ''}
			${tsStr ? `· 🕐 ${escapeHtml(tsStr)}` : ''}
		</div>
	`;
	return el;
}

function attrEsc(s) { return escapeHtml(s); }
function twitterHref(v) {
	const s = String(v ?? '').trim();
	if (!s) return '';
	if (/^https?:\/\//i.test(s)) return s;
	const handle = s.replace(/^@+/, '').split(/[/?#]/)[0];
	return `https://x.com/${encodeURIComponent(handle)}`;
}

function cardStyle(bg) {
	return [
		`background:${bg}`,
		'border:1px solid rgba(255,255,255,0.08)',
		'border-radius:8px',
		'padding:10px 12px',
		'margin-bottom:6px',
		'box-shadow:0 2px 6px rgba(0,0,0,0.3)',
	].join(';');
}

function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function safeJson(s) {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}
