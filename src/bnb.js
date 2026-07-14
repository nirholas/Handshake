// /bnb — the BNB Chain campaign's front door. Renders (1) a live block-time
// proof strip backed by /api/bnb/block-time (which wraps probeBlockTime from
// api/_lib/bnb/chains.js — a real RPC measurement, never hardcoded) and (2)
// three feature cards, each auto-detecting whether its track has shipped by
// probing the real route/API on this deployment. No hardcoded live/coming-soon
// flags: a card lights up the moment its check target starts resolving.
//
// See prompts/bnb-chain/19-bnb-hub-page.md and 00-CONTEXT.md (verified/refuted
// claims list — every sentence on this page traces back to that list).

import { escapeHtml as esc, timeAgo } from './shared/coin-format.js';
import {
	formatBlockTime,
	formatBlockNumber,
	deltaFromTarget,
	trackLiveness,
	combineTrackStates,
} from './bnb-hub-helpers.js';

const $ = (id) => document.getElementById(id);

// ── Live block-time proof ────────────────────────────────────────────────

async function loadBlockTime() {
	const el = $('bnb-proof-card');
	el.innerHTML = `
		<div class="bnb-proof-loading" role="status" aria-live="polite">
			<span class="bnb-spinner" aria-hidden="true"></span>
			Measuring live BNB Chain block time from a public RPC…
		</div>`;
	try {
		const res = await fetch('/api/bnb/block-time?network=bscMainnet', {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(8000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const data = await res.json();
		renderBlockTime(data);
	} catch {
		el.innerHTML = `
			<div class="bnb-proof-error" role="alert">
				BNB Chain RPC is unreachable right now — every public endpoint we tried timed out.
				<button class="bnb-retry" id="bnb-proof-retry" type="button">Retry</button>
			</div>`;
		const retry = $('bnb-proof-retry');
		if (retry) retry.addEventListener('click', loadBlockTime);
	}
}

function renderBlockTime(data) {
	const el = $('bnb-proof-card');
	const avg = formatBlockTime(data.avgBlockTimeMs);
	const delta = deltaFromTarget(data.avgBlockTimeMs, data.target);
	const deltaClass = delta && delta.startsWith('-') ? 'delta-fast' : 'delta-slow';
	const deltaHtml = delta
		? `<span class="${deltaClass}">${esc(delta)} vs the ${data.target}ms Fermi-hardfork target</span>`
		: 'no published target on this network';

	el.innerHTML = `
		<div class="bnb-proof-num">${esc(avg)}<span class="unit">avg block time</span></div>
		<div class="bnb-proof-mid">
			<p class="bnb-proof-title">Measured live, right now — not a marketing claim</p>
			<p class="bnb-proof-sub">${deltaHtml} · sampled ${esc(String(data.sampleBlocks))} real blocks off a public BSC RPC</p>
		</div>
		<div class="bnb-proof-stats">
			<span>latest block <b>${esc(formatBlockNumber(data.latestBlock))}</b></span>
			<span>updated ${esc(timeAgo(data.measuredAt))}</span>
		</div>`;
}

// ── Track cards ───────────────────────────────────────────────────────────

const ICONS = {
	bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" fill="currentColor"/>',
	lock: '<path d="M6 10V7a6 6 0 0 1 12 0v3" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/><rect x="4" y="10" width="16" height="11" rx="2" stroke="currentColor" stroke-width="2" fill="none"/>',
	globe: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2" fill="none"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18" stroke="currentColor" stroke-width="1.6" fill="none"/>',
};

// Each track gates on ONE canonical, independently-probeable HTTP target —
// the concrete artifact the card's headline claim depends on. A card also
// carries an optional secondary link that only renders once its own probe
// (checked separately) resolves, so nothing on the page ever links to a 404.
const TRACKS = [
	{
		id: 'gasless',
		icon: 'bolt',
		kicker: 'BEP-414 + BEP-322 · MegaFuel',
		title: 'Gasless agent onboarding',
		desc: `A brand-new wallet holding zero BNB mints a real on-chain ERC-8004 agent
			identity — no faucet, no funding step, no smart-account setup first. BSC's
			BEP-414 paymaster API pairs a user's own zero-gas-price transaction with a
			sponsor transaction atomically (BEP-322) — a plain private-key EOA, not a
			smart account. That's mechanically impossible on Ethereum L1 or Base today:
			EIP-1559 rejects a zero-fee transaction outright, and ERC-4337/7702 both
			need extra account setup before the first tx. Built on MegaFuel (NodeReal's
			production implementation), with an automatic self-pay fallback.`,
		caveat: 'MegaFuel is one operator (NodeReal); BEP-414 is still Draft status. Sponsorship decline always falls through to self-pay — it never blocks registration.',
		primary: { label: 'Register an agent gaslessly', href: '/create-agent' },
		// register-agent is POST-only: a HEAD/GET probe 405s (a console error on
		// every page load). OPTIONS resolves the route without invoking it - the
		// handler's CORS preflight answers 204 when deployed, 404 when not.
		primaryCheck: '/api/bnb/register-agent',
		primaryCheckMethod: 'OPTIONS',
		secondary: { label: 'Read the payments guide', href: '/docs/bnb-payments' },
		secondaryCheck: '/docs/bnb-payments.md',
	},
	{
		id: 'vault',
		icon: 'lock',
		kicker: 'Greenfield cross-chain hubs · live on BSC(56)',
		title: 'On-chain-gated 3D vault',
		desc: `Buy access to an encrypted 3D model on BSC, and the unlock key is granted
			through a live cross-chain call into Greenfield's programmable storage —
			bucket, object, and group permissions created and revoked directly from a
			BSC smart contract (six hub contracts, bytecode-verified live on BSC
			mainnet, 2026-07-07). No other chain we've built on lets a smart contract
			program object-level storage permissions on a separate data-availability
			chain in one flow.`,
		caveat: 'Object creation from BSC is still pending in the underlying protocol, and cross-chain grants settle asynchronously — the vault shows "granting access…" honestly instead of hiding the wait. Greenfield is live but deprioritized on BNB’s 2026 roadmap; the vault’s crypto format stays portable to another storage backend.',
		primary: { label: 'Browse the vault', href: '/vault' },
		primaryCheck: '/vault',
	},
	{
		id: 'world',
		icon: 'globe',
		kicker: 'Fermi hardfork · ~0.45s blocks, live',
		title: 'Real-time on-chain world',
		desc: `Every step your avatar takes in Explore can be written on-chain and read
			back by every other player in the room, riding BNB's ~0.45s blocks and
			~1.125s finality (Fermi hardfork BEP-619/590, live since 2026-01-14 —
			measured on a public RPC below, right now). At Base's 2s blocks or
			Ethereum's 12s, a step-by-step on-chain presence layer isn't playable; at
			~0.45s it's the fastest EVM L1 in production — only Solana's ~400ms slot
			cadence comes close, and it isn't an EVM chain.`,
		caveat: 'The on-chain toggle inside Explore/Platformer is opt-in and off by default — no surprise wallet prompts. BEP-670 targets 250ms blocks next; that isn’t live yet, so this page measures and shows only what’s real today.',
		primary: { label: 'Watch the live block race', href: '/bnb-latency' },
		primaryCheck: '/bnb-latency',
	},
];

function iconSvg(name) {
	return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

function ctaHtml(track, state) {
	if (state !== 'live') {
		return `<span class="bnb-cta" aria-disabled="true" title="Ships as part of the BNB Chain campaign — not deployed on this build yet">
			${esc(track.primary.label)} — coming soon
		</span>`;
	}
	return `<a class="bnb-cta" href="${esc(track.primary.href)}">${esc(track.primary.label)} →</a>`;
}

function cardHtml(track) {
	return `
		<article class="bnb-card" data-track="${esc(track.id)}">
			<div class="bnb-card-head">
				<div class="bnb-card-icon">${iconSvg(track.icon)}</div>
				<span class="bnb-status" data-state="checking" aria-live="polite" aria-label="Status: checking">Checking</span>
			</div>
			<p class="kicker">${esc(track.kicker)}</p>
			<h2>${esc(track.title)}</h2>
			<p class="desc">${esc(track.desc.replace(/\s+/g, ' ').trim())}</p>
			<p class="caveat">${esc(track.caveat)}</p>
			<div class="bnb-card-footer" data-cta-slot></div>
		</article>`;
}

/**
 * Probe a URL and resolve to an HTTP status, or null on network failure/timeout.
 * HEAD by default (pages, docs); POST-only APIs pass OPTIONS via the track's
 * *CheckMethod so the probe never triggers a 405 console error.
 */
async function probe(url, probeMethod = 'HEAD') {
	try {
		const res = await fetch(url, { method: probeMethod, signal: AbortSignal.timeout(4000) });
		return res.status;
	} catch {
		return null;
	}
}

async function checkTrack(track) {
	const [primaryStatus, secondaryStatus] = await Promise.all([
		probe(track.primaryCheck, track.primaryCheckMethod),
		track.secondaryCheck ? probe(track.secondaryCheck, track.secondaryCheckMethod) : null,
	]);
	const primaryState = trackLiveness(primaryStatus);
	const secondaryState = track.secondaryCheck ? trackLiveness(secondaryStatus) : 'coming-soon';
	return { cardState: combineTrackStates([primaryState]), primaryState, secondaryState };
}

async function updateCard(track) {
	const card = document.querySelector(`.bnb-card[data-track="${track.id}"]`);
	if (!card) return null;
	const { cardState, secondaryState } = await checkTrack(track);

	const pill = card.querySelector('.bnb-status');
	pill.dataset.state = cardState;
	pill.textContent = cardState === 'live' ? 'Live' : 'Coming soon';
	pill.setAttribute('aria-label', `Status: ${cardState === 'live' ? 'live' : 'coming soon'}`);

	const slot = card.querySelector('[data-cta-slot]');
	const bits = [ctaHtml(track, cardState)];
	if (track.secondary && secondaryState === 'live') {
		bits.push(
			`<a class="bnb-cta-secondary" href="${esc(track.secondary.href)}">${esc(track.secondary.label)} ↗</a>`,
		);
	}
	slot.innerHTML = bits.join('');

	return cardState;
}

function updateProgress(states) {
	const el = $('bnb-progress');
	if (!el) return;
	const liveCount = states.filter((s) => s === 'live').length;
	el.dataset.anyLive = liveCount > 0 ? 'true' : 'false';
	el.textContent =
		liveCount === 0
			? `0 of ${states.length} demo tracks live yet — block-time proof is live below`
			: `${liveCount} of ${states.length} demo track${states.length === 1 ? '' : 's'} live now`;
}

async function loadTracks() {
	const grid = $('bnb-grid');
	grid.innerHTML = TRACKS.map(cardHtml).join('');
	const states = await Promise.all(TRACKS.map(updateCard));
	updateProgress(states);
}

function init() {
	loadBlockTime();
	loadTracks();
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
