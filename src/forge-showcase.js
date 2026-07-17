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

import { skeletonHTML, errorStateHTML, ensureStateKitStyles } from './shared/state-kit.js';
ensureStateKitStyles();

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

function buildCard(c) {
	const card = document.createElement('div');
	card.className = 'creation showcase-card';
	// No title attribute: the prompt is already visible in .meta below the thumb,
	// and the native tooltip clips over the card art on hover.
	card.dataset.prompt = c.prompt || '';
	card.tabIndex = 0;
	card.setAttribute('role', 'button');
	card.setAttribute('aria-label', `Open in viewer: ${c.prompt || 'forged model'}`);
	// The whole card opens the viewer, but a nested Remix <button> lives in the
	// footer — a clickable card wrapping a button is a nested-interactive WCAG
	// failure (4.1.2). Instead the card is a plain container and the primary
	// "open" action is a stretched, transparent <button> overlay (.showcase-open)
	// that covers the card; Remix sits above it via z-index. One real button per
	// action, no nesting, native keyboard (Enter/Space) on both.

	if (c.preview_image_url) {
		// Plan A: stored thumbnail
		const img = document.createElement('img');
		img.className = 'thumb';
		img.loading = 'lazy';
		img.alt = '';
		img.src = c.preview_image_url;
		img.onerror = () => {
			// Plan B: image URL broken → try GLB capture, then gradient
			if (c.glb_url) {
				card.dataset.glbUrl = c.glb_url;
				captureObserver ? captureObserver.observe(card) : applyGradientFallback(card, c.prompt);
			} else {
				applyGradientFallback(card, c.prompt);
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
		foot.appendChild(remix);
	}
	card.appendChild(foot);

	const open = () =>
		document.dispatchEvent(new CustomEvent('forge:open-creation', { detail: { creation: c } }));
	card.addEventListener('click', open);
	card.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			open();
		}
	});

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
		const res = await fetch('/api/forge-gallery?scope=community&limit=24');
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
	if (els.count) els.count.textContent = `${creations.length} recent`;
}

els.refresh?.addEventListener('click', loadShowcase);

loadShowcase();
