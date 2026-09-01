// Forge community showcase — "Fresh from the Forge".
//
// Renders the newest finished models across all Forge users into the
// #showcase section on /forge (GET /api/forge-gallery?scope=community).
// Two affordances per card:
//   • click the card  → opens the model in the page's main viewer via the
//     `forge:open-creation` hook in src/forge.js, so the full result bar
//     (download, share, stylize, optimize, split) works on it
//   • Remix           → copies the creation's prompt into the composer and
//     focuses it, so a visitor starts from something that demonstrably works
//
// The section stays hidden when the deployment has no durable store or the
// feed is empty — a first-time visitor never sees a broken or hollow strip.

import { resizedImageUrl } from './shared/image-url.js';
import { skeletonHTML, errorStateHTML, ensureStateKitStyles } from './shared/state-kit.js';
ensureStateKitStyles();
ensureShowcaseVoteStyles();

// ── Forge-Off voting ─────────────────────────────────────────────────────────
// The community showcase doubles as the live Forge-Off board: every card can be
// upvoted (auth-free, one vote per browser) and the strip can be re-sorted from
// "Fresh" (newest) to "Top this week" (most-voted over the current Forge-Off
// week). Votes settle through POST /api/forge-vote; the sort re-queries
// /api/forge-gallery?scope=community&sort=…. The button is optimistic and
// reconciles against the server's authoritative tally.

let currentSort = 'fresh'; // 'fresh' | 'top'

// The same browser-local id /forge scopes creations by (forge:cid). Sharing it
// means a visitor's own votes light up across the strip and their "Your
// creations" identity is one and the same. Generated once, then stable.
let _clientId = null;
function clientId() {
	if (_clientId) return _clientId;
	try {
		const k = 'forge:cid';
		let v = localStorage.getItem(k);
		if (!v) {
			v =
				(typeof crypto !== 'undefined' && crypto.randomUUID?.()) ||
				`c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
			localStorage.setItem(k, v);
		}
		_clientId = v;
	} catch {
		// Private mode / storage blocked: an ephemeral per-load id still lets the
		// user vote this session; it just won't persist across reloads.
		_clientId = `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
	}
	return _clientId;
}

// One-shot <style> injection so the module owns its own CSS and never races a
// concurrent editor of the host page. Mirrors ensureStateKitStyles().
function ensureShowcaseVoteStyles() {
	if (document.getElementById('showcase-vote-styles')) return;
	const style = document.createElement('style');
	style.id = 'showcase-vote-styles';
	style.textContent = `
		.showcase-sort { display: inline-flex; gap: 2px; padding: 2px; border: 1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: 999px; background: var(--surface-1, rgba(255,255,255,.03)); }
		.showcase-sort-btn { font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; letter-spacing: .03em; padding: 4px 12px; border-radius: 999px; border: 0; background: transparent; color: var(--ink-dim, #9aa0a6); cursor: pointer; transition: color .15s, background .15s; }
		.showcase-sort-btn:hover { color: var(--ink, #fff); }
		.showcase-sort-btn.is-active { background: var(--accent, #fff); color: var(--bg-0, #0a0a0a); }
		.showcase-sort-btn:focus-visible { outline: 2px solid var(--accent, #fff); outline-offset: 2px; }
		.showcase-foot-actions { display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
		/* The card footer is [when . category] ......... [votes] [Remix]. Both ends
		   are deliberately non-shrinking (a truncated vote count or a hyphenated
		   "Remix" reads as broken), so on a 320px-wide card the row has nowhere to
		   give and the actions overflow past the card's right edge: Remix ends up
		   clipped and untappable. Let the row wrap instead. The actions drop to a
		   second line only when they genuinely do not fit, and space-between still
		   holds them right-aligned. */
		.showcase-foot { flex-wrap: wrap; row-gap: 6px; }
		.showcase-when { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
		.showcase-vote { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; line-height: 1; padding: 3px 9px; border-radius: 999px; border: 1px solid var(--stroke, rgba(255,255,255,.08)); background: transparent; color: var(--ink-dim, #9aa0a6); cursor: pointer; transition: color .15s, border-color .15s, background .15s; }
		.showcase-vote:hover { color: var(--ink, #fff); border-color: var(--accent, #fff); }
		.showcase-vote:focus-visible { outline: 2px solid var(--accent, #fff); outline-offset: 2px; }
		.showcase-vote svg { width: 12px; height: 12px; display: block; }
		.showcase-vote.is-voted { color: var(--bg-0, #0a0a0a); background: var(--accent, #fff); border-color: var(--accent, #fff); }
		.showcase-vote[data-busy="1"] { opacity: .6; pointer-events: none; }
		.showcase-vote-count { font-variant-numeric: tabular-nums; min-width: 6px; text-align: right; }
		.showcase-vote.vote-bump { animation: showcase-vote-bump .32s ease; }
		@keyframes showcase-vote-bump { 0% { transform: scale(1); } 40% { transform: scale(1.22); } 100% { transform: scale(1); } }
		@media (prefers-reduced-motion: reduce) { .showcase-vote.vote-bump { animation: none; } }
		.showcase-cat-badge { font-family: var(--font-mono, ui-monospace, monospace); font-size: 10px; letter-spacing: .04em; line-height: 1; padding: 3px 7px; border-radius: 999px; flex-shrink: 0; }
		.showcase-cat-badge.model-cat-avatar    { background: rgba(99,102,241,.18);  color: #a5b4fc; }
		.showcase-cat-badge.model-cat-accessory { background: rgba(236,72,153,.18);  color: #f9a8d4; }
		.showcase-cat-badge.model-cat-item      { background: rgba(245,158,11,.18);  color: #fcd34d; }
		.showcase-cat-badge.model-cat-scene     { background: rgba(16,185,129,.18);  color: #6ee7b7; }
		.showcase-cat-badge.model-cat-creature  { background: rgba(251,146,60,.18);  color: #fdba74; }
		.showcase-cat-badge.model-cat-vehicle   { background: rgba(56,189,248,.18);  color: #7dd3fc; }
		.showcase-cat-badge.model-cat-other     { background: rgba(255,255,255,.08); color: #a1a1aa; }
		.showcase-x402-badge { background: rgba(20,241,149,.14); color: #5eead4; text-decoration: none; transition: background .15s ease; z-index: 2; position: relative; }
		.showcase-x402-badge:hover, .showcase-x402-badge:focus-visible { background: rgba(20,241,149,.28); outline: none; }
	`;
	document.head.appendChild(style);
}

const ENGINE_LABELS = {
	nvidia: 'Free',
	huggingface: 'Hunyuan3D',
	trellis: 'Fast',
	trellis_selfhost: 'TRELLIS',
	meshy: 'Meshy',
	tripo: 'Tripo',
	rodin: 'Rodin',
	stability: 'Stability',
	replicate_byok: 'Replicate',
	hunyuan3d: 'Hunyuan3D',
	triposg: 'TripoSG',
};

const MODEL_CAT_LABELS = {
	avatar: 'Avatar', accessory: 'Accessory', item: 'Item',
	scene: 'Scene', creature: 'Creature', vehicle: 'Vehicle', other: 'Other',
};

// ── Thumbnail fallback chain ──────────────────────────────────────────────────
// Plan A: preview_image_url from DB → <img>
// Plan B: img onerror or no preview_image_url + has glb_url → capture a frame
//         from a hidden <model-viewer> (queued, max 1 concurrent load so we
//         don't slam the network with a dozen 10MB GLBs simultaneously)
// Plan C: model-viewer fails / times out → gradient card generated from prompt
// Plan D: no glb_url at all → gradient card

const CAPTURE_TIMEOUT_MS = 20_000;
const captureQueue = [];
let captureActive = false;

function drainCaptureQueue() {
	if (captureActive || captureQueue.length === 0) return;
	captureActive = true;
	const { card, glbUrl, resolve } = captureQueue.shift();
	captureFromGlb(card, glbUrl)
		.then(resolve)
		.catch(() => resolve(null))
		.finally(() => {
			captureActive = false;
			drainCaptureQueue();
		});
}

function enqueueCaptureFromGlb(card, glbUrl) {
	return new Promise((resolve) => {
		captureQueue.push({ card, glbUrl, resolve });
		drainCaptureQueue();
	});
}

async function captureFromGlb(card, glbUrl) {
	if (!window.customElements?.get('model-viewer')) return null;
	return new Promise((resolve) => {
		const viewer = document.createElement('model-viewer');
		// Render at a real resolution off-screen — model-viewer sizes its WebGL
		// canvas to the element box, so a 1px element would capture a 1px frame
		// (a solid block once stretched over the 200px thumb). 384px gives a
		// crisp, retina-ish thumbnail. position:fixed keeps it out of layout;
		// opacity:0 + negative z-index keep it invisible while it still paints.
		viewer.style.cssText =
			'position:fixed;left:0;top:0;width:384px;height:384px;opacity:0;pointer-events:none;z-index:-1;';
		viewer.setAttribute('src', glbUrl);
		viewer.setAttribute('shadow-intensity', '0');
		viewer.setAttribute('exposure', '0.9');
		viewer.setAttribute('environment-image', 'neutral');
		viewer.setAttribute('aria-hidden', 'true');

		let done = false;
		const finish = (dataUrl) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			viewer.remove();
			resolve(dataUrl);
		};

		const timer = setTimeout(() => finish(null), CAPTURE_TIMEOUT_MS);

		viewer.addEventListener(
			'load',
			async () => {
				try {
					// Brief settle so the mesh textures are uploaded to GPU.
					await new Promise((r) => setTimeout(r, 800));
					const url = viewer.toDataURL?.('image/webp') ?? null;
					// A real 384px model render encodes to several KB; a blank or
					// transparent frame compresses to a few hundred bytes. Reject
					// the near-empty case so the readable gradient+prompt fallback
					// wins instead of an invisible card.
					finish(url && url.length > 1024 ? url : null);
				} catch {
					finish(null);
				}
			},
			{ once: true },
		);
		viewer.addEventListener('error', () => finish(null), { once: true });

		document.body.appendChild(viewer);
	});
}

// Deterministic gradient from a string — same prompt always gets the same colours.
function promptGradient(str) {
	let h = 0;
	for (let i = 0; i < (str || '').length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
	const hue = Math.abs(h) % 360;
	const hue2 = (hue + 40) % 360;
	return `linear-gradient(135deg, hsl(${hue},28%,14%) 0%, hsl(${hue2},22%,10%) 100%)`;
}

function applyGradientFallback(card, prompt) {
	const existing = card.querySelector('.thumb');
	if (existing) existing.remove();
	if (card.querySelector('.thumb.gradient-ph')) return;
	const ph = document.createElement('span');
	ph.className = 'thumb gradient-ph';
	ph.style.background = promptGradient(prompt);
	// Show the prompt text as the visual — makes the card feel intentional, not broken.
	if (prompt) {
		const label = document.createElement('span');
		label.className = 'gradient-ph-text';
		label.textContent = prompt;
		ph.appendChild(label);
	}
	card.prepend(ph);
}

// IntersectionObserver: only attempt GLB capture when the card is actually
// visible — no wasted work on cards the user never scrolls to.
const captureObserver =
	'IntersectionObserver' in window
		? new IntersectionObserver(
				(entries) => {
					entries.forEach((e) => {
						if (!e.isIntersecting) return;
						captureObserver.unobserve(e.target);
						const card = e.target;
						const glbUrl = card.dataset.glbUrl;
						if (!glbUrl) return;
						enqueueCaptureFromGlb(card, glbUrl).then((dataUrl) => {
							if (dataUrl) {
								const img = document.createElement('img');
								img.className = 'thumb';
								img.loading = 'lazy';
								img.alt = '';
								img.src = dataUrl;
								img.onerror = () => applyGradientFallback(card, card.dataset.prompt);
								const existing = card.querySelector('.thumb');
								existing ? existing.replaceWith(img) : card.prepend(img);
							} else {
								applyGradientFallback(card, card.dataset.prompt);
							}
						});
					});
				},
				{ rootMargin: '200px' },
			)
		: null;

const els = {
	section: document.getElementById('showcase'),
	grid: document.getElementById('showcase-grid'),
	count: document.getElementById('showcase-count'),
	refresh: document.getElementById('showcase-refresh'),
};

// "3m ago" / "2h ago" / "5d ago" — compact, no library.
function timeAgo(iso) {
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, (Date.now() - t) / 1000);
	if (s < 60) return 'just now';
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

// Upvote pill: chevron + live count, filled when the caller has voted. The
// count reflects the whole community; the fill reflects only this browser.
function buildVoteButton(c) {
	const btn = document.createElement('button');
	btn.type = 'button';
	btn.className = 'showcase-vote' + (c.voted ? ' is-voted' : '');
	btn.dataset.creationId = c.id;
	const count = document.createElement('span');
	count.className = 'showcase-vote-count';
	count.textContent = String(Number(c.vote_count) || 0);
	btn.innerHTML =
		'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 15l-6-6-6 6"/></svg>';
	btn.appendChild(count);
	applyVoteA11y(btn, Boolean(c.voted), Number(c.vote_count) || 0);
	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		toggleVote(c, btn);
	});
	return btn;
}

function applyVoteA11y(btn, voted, count) {
	btn.setAttribute('aria-pressed', voted ? 'true' : 'false');
	btn.title = voted ? 'Remove your vote' : 'Upvote this model';
	btn.setAttribute(
		'aria-label',
		`${voted ? 'Remove your upvote' : 'Upvote'} — ${count} ${count === 1 ? 'vote' : 'votes'}`,
	);
}

// Reflect a (voted, count) state onto the button, with a bump on increment.
function setVoteState(btn, voted, count, { bump = false } = {}) {
	btn.classList.toggle('is-voted', voted);
	const countEl = btn.querySelector('.showcase-vote-count');
	if (countEl) countEl.textContent = String(Math.max(0, count));
	applyVoteA11y(btn, voted, Math.max(0, count));
	if (bump) {
		btn.classList.remove('vote-bump');
		void btn.offsetWidth; // restart the animation on a rapid re-vote
		btn.classList.add('vote-bump');
	}
}

// Optimistic toggle: flip the UI immediately, POST, then reconcile against the
// server's authoritative tally (or roll back on failure). Concurrent taps on
// the same card are ignored while one is in flight.
async function toggleVote(c, btn) {
	if (btn.dataset.busy === '1') return;
	const wasVoted = btn.classList.contains('is-voted');
	const countEl = btn.querySelector('.showcase-vote-count');
	const prevCount = Number(countEl?.textContent) || 0;
	const nextVoted = !wasVoted;

	setVoteState(btn, nextVoted, prevCount + (nextVoted ? 1 : -1), { bump: nextVoted });
	btn.dataset.busy = '1';
	try {
		const res = await fetch('/api/forge-vote', {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-forge-client': clientId() },
			body: JSON.stringify({ creation_id: c.id, vote: nextVoted }),
		});
		const data = await res.json().catch(() => ({}));
		if (!res.ok || !data?.ok) throw new Error(data?.message || 'vote failed');
		// Reconcile to the real numbers — another voter may have moved the count.
		setVoteState(btn, Boolean(data.voted), Number(data.vote_count) || 0);
		c.voted = Boolean(data.voted);
		c.vote_count = Number(data.vote_count) || 0;
	} catch {
		setVoteState(btn, wasVoted, prevCount); // roll back the optimistic change
		showVoteToast("Couldn't save your vote — try again");
	} finally {
		btn.dataset.busy = '0';
	}
}

function showVoteToast(message) {
	const existing = document.querySelector('.remix-toast');
	if (existing) existing.remove();
	const toast = document.createElement('div');
	toast.className = 'remix-toast';
	const dot = document.createElement('span');
	dot.className = 'toast-dot';
	dot.setAttribute('aria-hidden', 'true');
	toast.appendChild(dot);
	toast.appendChild(document.createTextNode(message));
	document.body.appendChild(toast);
	setTimeout(() => toast.classList.add('fade-out'), 2400);
	setTimeout(() => toast.remove(), 2800);
}

function buildCard(c) {
	const card = document.createElement('div');
	card.className = 'creation showcase-card';
	// No title attribute: the prompt is already visible in .meta below the thumb,
	// and the native tooltip clips over the card art on hover.
	card.dataset.prompt = c.prompt || '';
	// The whole card opens the viewer, but nested vote/Remix <button>s and the
	// x402 <a> live in the footer, and a role="button" card wrapping them is a
	// nested-interactive WCAG failure (4.1.2, axe flagged 12 nodes per page).
	// So the card is a plain container and the primary "open" action is a
	// stretched, transparent <button> overlay (.showcase-open) appended at the
	// end of buildCard; the footer sits above it via z-index. One real button
	// per action, no nesting, native keyboard (Enter/Space) on both.

	if (c.preview_image_url) {
		// Plan A: stored thumbnail
		const img = document.createElement('img');
		img.className = 'thumb';
		img.loading = 'lazy';
		// Decode off the critical path: showcase thumbs are full-size renders
		// painted into a 200px-tall box, and a synchronous decode of a grid's
		// worth of them shows up as main-thread blocking time. The box is
		// CSS-reserved (`#showcase .creation .thumb` is a fixed height), so
		// deferring the decode cannot shift layout.
		img.decoding = 'async';
		img.alt = '';
		// Full-resolution render, 200px-tall box: fetch it at the box's size.
		img.src = resizedImageUrl(c.preview_image_url, 480);
		img.onerror = () => {
			// Drop the broken <img> the moment it fails. GLB capture is queued one
			// at a time behind a 20s timeout, so leaving it in place parks a row of
			// broken-image boxes on screen for minutes while Plan B works. The
			// gradient stands in immediately and the capture upgrades it in place.
			applyGradientFallback(card, c.prompt);
			// Plan B: image URL broken → try GLB capture, gradient already stands in
			if (c.glb_url && captureObserver) {
				card.dataset.glbUrl = c.glb_url;
				captureObserver.observe(card);
			}
		};
		card.appendChild(img);
	} else if (c.glb_url) {
		// Plan B: no thumbnail yet → gradient placeholder now, GLB capture when visible
		applyGradientFallback(card, c.prompt);
		card.dataset.glbUrl = c.glb_url;
		captureObserver ? captureObserver.observe(card) : undefined;
	} else {
		// Plan C: no assets at all → gradient placeholder
		applyGradientFallback(card, c.prompt);
	}

	// Engine · tier provenance, same convention as "Your creations".
	if (c.backend || c.tier) {
		const prov = document.createElement('span');
		prov.className = 'badge';
		prov.style.left = '6px';
		prov.style.right = 'auto';
		prov.textContent = [ENGINE_LABELS[c.backend] || c.backend, c.tier].filter(Boolean).join(' · ');
		card.appendChild(prov);
	}

	attachHoverPreview(card, c);
	if (Number(c.views_used) > 1) {
		const mv = document.createElement('span');
		mv.className = 'badge';
		mv.textContent = `${c.views_used}×`;
		mv.title = `${c.views_used} reference views`;
		card.appendChild(mv);
	}

	const meta = document.createElement('span');
	meta.className = 'meta';
	meta.textContent = c.prompt || 'Untitled';
	card.appendChild(meta);

	const foot = document.createElement('div');
	foot.className = 'showcase-foot';

	const when = document.createElement('span');
	when.className = 'showcase-when';
	when.textContent = timeAgo(c.created_at);
	foot.appendChild(when);

	// Model category badge — shows what type of 3D model was forged.
	const cat = c.model_category || 'other';
	const catLabel = MODEL_CAT_LABELS[cat] || cat;
	if (cat !== 'other') {
		const catBadge = document.createElement('span');
		catBadge.className = `showcase-cat-badge model-cat-${cat}`;
		catBadge.textContent = catLabel;
		catBadge.title = `Model category: ${catLabel}`;
		foot.appendChild(catBadge);
	}

	// x402 provenance: this model was bought by an agent with real on-chain
	// USDC. The badge links to the settle transaction so the receipt is one
	// click away; stopPropagation keeps it from opening the viewer.
	if (c.x402?.tx_sig) {
		const pay = document.createElement('a');
		pay.className = 'showcase-cat-badge showcase-x402-badge';
		pay.href = `https://solscan.io/tx/${encodeURIComponent(c.x402.tx_sig)}`;
		pay.target = '_blank';
		pay.rel = 'noopener noreferrer';
		pay.textContent = c.x402.price_usdc != null ? `x402 · $${c.x402.price_usdc}` : 'x402';
		pay.title = `Paid via x402 by ${c.x402.payer ? `${c.x402.payer.slice(0, 4)}…${c.x402.payer.slice(-4)}` : 'an agent'}. View settle transaction`;
		pay.setAttribute('aria-label', 'Paid via x402. View settle transaction on Solscan');
		pay.addEventListener('click', (e) => e.stopPropagation());
		foot.appendChild(pay);
	}

	// Right-aligned actions: upvote + Remix, kept together so the footer reads
	// as [when · category] ……… [▲ votes] [Remix].
	const actions = document.createElement('div');
	actions.className = 'showcase-foot-actions';

	// Upvote — every showcase row is a public artifact and therefore votable.
	if (c.id) actions.appendChild(buildVoteButton(c));

	// Model page: the full detail view (stats, comments, likes, suggested).
	if (c.id) {
		const page = document.createElement('a');
		page.className = 'showcase-remix';
		page.href = `/m/${encodeURIComponent(c.id)}`;
		page.textContent = 'Details';
		page.title = 'Open the model page: stats, comments, likes';
		page.addEventListener('click', (e) => e.stopPropagation());
		actions.appendChild(page);
	}

	// Remix — only meaningful when there is a prompt to start from.
	if (c.prompt) {
		const remix = document.createElement('button');
		remix.type = 'button';
		remix.className = 'showcase-remix';
		remix.textContent = 'Remix';
		remix.title = 'Copy this prompt into the composer';
		remix.setAttribute('aria-label', `Remix prompt: ${c.prompt}`);
		remix.addEventListener('click', (e) => {
			e.stopPropagation();
			remixPrompt(c.prompt);
		});
		actions.appendChild(remix);
	}
	foot.appendChild(actions);
	card.appendChild(foot);

	const open = () =>
		document.dispatchEvent(new CustomEvent('forge:open-creation', { detail: { creation: c } }));
	// The stretched primary action (see the nested-interactive note at the top
	// of buildCard). A real <button>, so Enter/Space come free.
	const openBtn = document.createElement('button');
	openBtn.type = 'button';
	openBtn.className = 'showcase-open';
	openBtn.setAttribute('aria-label', `Open in viewer: ${c.prompt || 'forged model'}`);
	openBtn.addEventListener('click', open);
	card.appendChild(openBtn);

	return card;
}

// Hover a card for a beat → its actual model spins in the thumb. One live
// mini-viewer at a time (GLBs are megabytes; a grid of twelve would jank the
// page), created only on real intent (300ms dwell) and torn down on leave.
// <model-viewer> is already registered on this page. Pointer-only by design:
// on touch, tapping the card opens the full viewer anyway.
let activePreview = null; // { card, viewer }
let previewTimer = null;

function teardownHoverPreview() {
	clearTimeout(previewTimer);
	previewTimer = null;
	if (activePreview) {
		activePreview.viewer.remove();
		activePreview.card.classList.remove('is-previewing');
		activePreview = null;
	}
}

function attachHoverPreview(card, c) {
	if (!c.glb_url || !window.customElements?.get('model-viewer')) return;
	if (matchMedia('(hover: none)').matches) return;

	card.addEventListener('mouseenter', () => {
		teardownHoverPreview();
		previewTimer = setTimeout(() => {
			const thumb = card.querySelector('.thumb');
			if (!thumb) return;
			const viewer = document.createElement('model-viewer');
			viewer.className = 'showcase-preview';
			viewer.setAttribute('src', c.glb_url);
			viewer.setAttribute('auto-rotate', '');
			viewer.setAttribute('auto-rotate-delay', '0');
			viewer.setAttribute('rotation-per-second', '24deg');
			viewer.setAttribute('interaction-prompt', 'none');
			viewer.setAttribute('disable-zoom', '');
			viewer.setAttribute('shadow-intensity', '0');
			viewer.setAttribute('exposure', '0.9');
			viewer.setAttribute('environment-image', 'neutral');
			viewer.setAttribute('aria-hidden', 'true');
			// Fade in only once the GLB is actually ready — no pop, no void.
			viewer.addEventListener('load', () => card.classList.add('is-previewing'), { once: true });
			thumb.insertAdjacentElement('afterend', viewer);
			activePreview = { card, viewer };
		}, 300);
	});
	card.addEventListener('mouseleave', teardownHoverPreview);
}

// Put the prompt in the composer, in text mode, ready to edit-and-Generate.
function remixPrompt(prompt) {
	document.querySelector('#mode-switch [data-mode="text"]')?.click();
	const box = document.getElementById('prompt');
	if (!box) return;
	box.value = prompt;
	box.dispatchEvent(new Event('input', { bubbles: true }));
	box.scrollIntoView({ behavior: 'smooth', block: 'center' });
	// Delay focus + flash until after the scroll settles.
	setTimeout(() => {
		box.focus();
		box.setSelectionRange(box.value.length, box.value.length);
		// Flash the border so the user clearly sees the prompt landed.
		box.classList.remove('remix-flash');
		void box.offsetWidth; // force reflow to restart animation if clicked twice
		box.classList.add('remix-flash');
		box.addEventListener('animationend', () => box.classList.remove('remix-flash'), { once: true });
	}, 300);
	showRemixToast();
}

function showRemixToast() {
	const existing = document.querySelector('.remix-toast');
	if (existing) existing.remove();
	const toast = document.createElement('div');
	toast.className = 'remix-toast';
	const dot = document.createElement('span');
	dot.className = 'toast-dot';
	dot.setAttribute('aria-hidden', 'true');
	toast.appendChild(dot);
	toast.appendChild(document.createTextNode('Prompt loaded — edit and Generate'));
	document.body.appendChild(toast);
	setTimeout(() => toast.classList.add('fade-out'), 2400);
	setTimeout(() => toast.remove(), 2800);
}

async function loadShowcase() {
	if (!els.section || !els.grid) return;

	els.grid.setAttribute('aria-busy', 'true');
	els.grid.innerHTML = skeletonHTML(4, 'card');
	els.section.classList.remove('is-hidden');

	let data;
	try {
		// Over-fetch, then dedupe near-identical prompts client-side — people
		// re-roll the same prompt, and a feed of six teapots sells nothing.
		// The Top view narrows to the current Forge-Off week. Sending the forge
		// client id resolves each card's own voted-state in one round-trip.
		const qs =
			currentSort === 'top'
				? 'scope=community&sort=top&window=week&limit=24'
				: 'scope=community&limit=24';
		const res = await fetch(`/api/forge-gallery?${qs}`, {
			headers: { 'x-forge-client': clientId() },
		});
		data = await res.json().catch(() => ({}));
	} catch {
		els.grid.removeAttribute('aria-busy');
		els.grid.innerHTML = errorStateHTML({
			title: "Couldn't load the community feed",
			body: 'Check your connection and retry — generation itself is unaffected.',
		});
		els.grid.querySelector('[data-sk-retry]')?.addEventListener('click', loadShowcase);
		return;
	}

	els.grid.removeAttribute('aria-busy');
	const all = Array.isArray(data?.creations) ? data.creations : [];
	const seen = new Set();
	const creations = all
		.filter((c) => {
			const key = (c.prompt || c.id || '').toLowerCase().replace(/\s+/g, ' ').trim();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, 12);
	if (!data?.enabled || creations.length === 0) {
		// No durable store, or nothing forged yet — no hollow strip.
		els.section.classList.add('is-hidden');
		return;
	}

	teardownHoverPreview();
	els.grid.innerHTML = '';
	for (const c of creations) els.grid.appendChild(buildCard(c));
	if (els.count) {
		const totalVotes = creations.reduce((n, c) => n + (Number(c.vote_count) || 0), 0);
		els.count.textContent =
			currentSort === 'top' && totalVotes > 0
				? `${totalVotes} ${totalVotes === 1 ? 'vote' : 'votes'} this week`
				: `${creations.length} recent`;
	}
	updateShowcaseCopy();
}

// Swap the section sub-copy to match the active sort so the strip reads as one
// intentional surface rather than a relabelled list.
function updateShowcaseCopy() {
	const sub = document.querySelector('#showcase .showcase-sub');
	if (!sub) return;
	if (currentSort === 'top') {
		sub.innerHTML =
			'The most-voted models this week. <strong>Upvote</strong> your favorites — the weekly winner is crowned every Monday.';
	} else {
		sub.innerHTML =
			'What other people just forged. Open one in the viewer, <strong>Remix</strong> its prompt, or <strong>upvote</strong> the best.';
	}
}

// Build the Fresh / Top toggle from JS and mount it in the section header. Done
// in code (not static markup) so this module owns the whole feature and never
// races a concurrent editor of the host page; if the header isn't present the
// feature degrades to Fresh-only with no error.
function mountSortToggle() {
	const headRight = document.querySelector('#showcase .showcase-head-right');
	if (!headRight || headRight.querySelector('.showcase-sort')) return;
	const nav = document.createElement('div');
	nav.className = 'showcase-sort';
	nav.setAttribute('role', 'tablist');
	nav.setAttribute('aria-label', 'Sort community models');
	for (const [sort, label] of [
		['fresh', 'Fresh'],
		['top', 'Top this week'],
	]) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'showcase-sort-btn' + (sort === currentSort ? ' is-active' : '');
		b.dataset.sort = sort;
		b.setAttribute('role', 'tab');
		b.setAttribute('aria-selected', sort === currentSort ? 'true' : 'false');
		b.textContent = label;
		b.addEventListener('click', () => {
			if (currentSort === sort) return;
			currentSort = sort;
			nav.querySelectorAll('.showcase-sort-btn').forEach((el) => {
				const active = el.dataset.sort === sort;
				el.classList.toggle('is-active', active);
				el.setAttribute('aria-selected', active ? 'true' : 'false');
			});
			loadShowcase();
		});
		nav.appendChild(b);
	}
	// Lead the header controls (before "View all").
	headRight.prepend(nav);
}

els.refresh?.addEventListener('click', loadShowcase);

mountSortToggle();
loadShowcase();
