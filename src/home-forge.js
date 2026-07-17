// Mini Forge — homepage slice of /forge (text → 3D, real pipeline).
//
// Drives the same /api/forge endpoint as the full page on its free default:
// the standard tier with NO explicit backend, so the server's health-aware
// router picks the best live lane. Today that is the self-hosted TRELLIS L4
// worker (textured GLBs, GCP-credit funded), with Hunyuan3D and the hosted
// free lanes beneath it as automatic degrades, so no single lane outage ever
// dead-ends a visitor. Pinning a backend here would skip that health routing
// entirely (api/forge.js treats a named backend as an explicit user choice):
// this page once pinned the paid Replicate lane and every homepage job was
// silently failing over to an untextured fallback. The primary lane is
// asynchronous (the POST returns a job_id; we poll to the finished GLB); the
// synchronous done-on-POST branch is kept for when the server degrades to a
// lane that returns immediately. The only timer is the honest elapsed counter —
// progress states come from real API responses.
//
// Presentation: the section is a single state-reactive "chamber" —
// [data-hf-state] on the chamber root drives the ring/floor/telemetry CSS.
// This module adds the typewriter suggestion (Tab accepts), pointer parallax
// on the ambient layers, the scanline + materialize reveal on results, a
// session history rail (real frames captured from the viewer, persisted on
// this device), and a wired result toolbar that carries the model straight
// into Scene Studio, a shareable link, a same-prompt variation, or download.
// All motion respects prefers-reduced-motion.

import {
	absoluteGlb,
	buildIframeSnippet,
	buildWebComponentSnippet,
	embedPageUrl,
	embedPreviewUrl,
	embedSize,
} from './forge-embed-snippets.js';
import { milestoneNote } from './forge-milestones.js';

const POLL_INTERVAL_MS = 2500;
// Max-tier texture bakes legitimately run past 10 minutes at full quality; the
// ceiling must sit above the slowest real generation. Queue wait does not count
// against this window (see pollUntilDone).
const MAX_POLL_MS = 12 * 60 * 1000;
const MODEL_VIEWER_SRC =
	'https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js';
const HISTORY_KEY = 'forge:home:history';
const HISTORY_MAX = 6;
// Cumulative models forged on this device, driving the sparse milestone nudge
// (src/forge-milestones.js). Distinct from HISTORY_KEY, which is capped at 6.
const COUNT_KEY = 'forge:home:count';

// Increment and return the device's lifetime forge count. Fail-open: a blocked
// or full localStorage just means no milestone this time, never a broken forge.
function bumpForgeCount() {
	try {
		const n = (parseInt(localStorage.getItem(COUNT_KEY), 10) || 0) + 1;
		localStorage.setItem(COUNT_KEY, String(n));
		return n;
	} catch {
		return 0;
	}
}
const THUMB_SIZE = 96;

const root = document.getElementById('home-forge');

const els = root && {
	chamber: root.querySelector('[data-hf-chamber]'),
	form: root.querySelector('[data-hf-form]'),
	prompt: root.querySelector('[data-hf-prompt]'),
	generate: root.querySelector('[data-hf-generate]'),
	generateLabel: root.querySelector('[data-hf-generate-label]'),
	chips: root.querySelector('[data-hf-chips]'),
	states: {
		idle: root.querySelector('[data-hf-idle]'),
		generating: root.querySelector('[data-hf-generating]'),
		result: root.querySelector('[data-hf-result]'),
		error: root.querySelector('[data-hf-error]'),
	},
	telState: root.querySelector('[data-hf-tel-state]'),
	preview: root.querySelector('[data-hf-preview]'),
	steps: {
		mesh: root.querySelector('[data-hf-step="mesh"]'),
		finish: root.querySelector('[data-hf-step="finish"]'),
	},
	elapsed: root.querySelector('[data-hf-elapsed]'),
	cancel: root.querySelector('[data-hf-cancel]'),
	resultRegion: root.querySelector('[data-hf-result-region]'),
	resultMeta: root.querySelector('[data-hf-result-meta]'),
	spin: root.querySelector('[data-hf-spin]'),
	vary: root.querySelector('[data-hf-vary]'),
	scene: root.querySelector('[data-hf-scene]'),
	share: root.querySelector('[data-hf-share]'),
	download: root.querySelector('[data-hf-download]'),
	again: root.querySelector('[data-hf-again]'),
	errorMessage: root.querySelector('[data-hf-error-message]'),
	retry: root.querySelector('[data-hf-retry]'),
	viewerSlot: root.querySelector('[data-hf-viewer-slot]'),
	scan: root.querySelector('[data-hf-scan]'),
	history: root.querySelector('[data-hf-history]'),
	historyTrack: root.querySelector('[data-hf-history-track]'),
	toast: root.querySelector('[data-hf-toast]'),
	embedOpen: root.querySelector('[data-hf-embed-open]'),
	embed: root.querySelector('[data-hf-embed]'),
	embedFrame: root.querySelector('[data-hf-embed-frame]'),
	embedPreview: root.querySelector('[data-hf-embed-preview]'),
	embedTabs: root.querySelector('[data-hf-embed-tabs]'),
	embedSizes: root.querySelector('[data-hf-embed-sizes]'),
	embedCode: root.querySelector('[data-hf-embed-code]'),
	embedCopy: root.querySelector('[data-hf-embed-copy]'),
	embedCopyLabel: root.querySelector('[data-hf-embed-copy-label]'),
	embedStandalone: root.querySelector('[data-hf-embed-standalone]'),
	embedCloseEls: root ? Array.from(root.querySelectorAll('[data-hf-embed-close]')) : [],
};

// Same anonymous handle as src/forge.js — keep the storage key in sync so the
// full page's gallery picks up models forged here.
const CLIENT_ID = (() => {
	const KEY = 'forge:cid';
	try {
		let id = localStorage.getItem(KEY);
		if (!id) {
			id =
				crypto?.randomUUID?.() ||
				`c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
			localStorage.setItem(KEY, id);
		}
		return id;
	} catch {
		return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
	}
})();

const CLIENT_HEADERS = { 'x-forge-client': CLIENT_ID };

const REDUCED_MOTION =
	typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

let busy = false;
let pollAbort = false;
let elapsedTimer = null;
let lastPrompt = '';
let modelViewerReady = null;
let currentViewer = null; // the live <model-viewer> on stage
let currentGlbUrl = ''; // what the toolbar acts on
let currentCreationId = ''; // persisted creation id → real shareable permalink
let toastTimer = null;
let embedCopyTimer = null;
let embedTrigger = null; // element to restore focus to when the embed sheet closes
const embedState = { tab: 'iframe', sizeId: 'wide' };
// Monotonic run token: cancel-then-regenerate must not let the first run's
// poll loop wake up and fight the new one over the shared stage.
let runSeq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// model-viewer carries its own renderer (~700 KB) — fetch it only once a
// generation is actually running, so it's registered by the time the GLB lands.
function ensureModelViewer() {
	if (modelViewerReady) return modelViewerReady;
	modelViewerReady = customElements.get('model-viewer')
		? Promise.resolve()
		: new Promise((resolve, reject) => {
				const s = document.createElement('script');
				s.type = 'module';
				s.src = MODEL_VIEWER_SRC;
				s.crossOrigin = 'anonymous';
				s.onload = () => resolve();
				s.onerror = () => reject(new Error('Failed to load the 3D viewer.'));
				document.head.appendChild(s);
			});
	return modelViewerReady;
}

// Honest telemetry words for the HUD readout, keyed by state.
const TEL_WORDS = { idle: 'standby', generating: 'forging', result: 'complete', error: 'error' };

function showState(name) {
	for (const [key, node] of Object.entries(els.states)) {
		node.hidden = key !== name;
	}
	els.chamber.dataset.hfState = name;
	els.telState.textContent = TEL_WORDS[name] || name;
	if (name !== 'generating' && name !== 'result') els.elapsed.textContent = '';
}

function setStep(name, state) {
	els.steps[name].dataset.state = state;
}

function startElapsed() {
	const t0 = performance.now();
	stopElapsed();
	els.elapsed.textContent = '0s';
	elapsedTimer = setInterval(() => {
		els.elapsed.textContent = `${Math.round((performance.now() - t0) / 1000)}s`;
	}, 1000);
}

function stopElapsed() {
	if (elapsedTimer) clearInterval(elapsedTimer);
	elapsedTimer = null;
}

function setBusy(b) {
	busy = b;
	els.generate.disabled = b;
	els.generateLabel.textContent = b ? 'Forging…' : 'Forge';
	if (els.vary) els.vary.disabled = b;
}

function showError(message) {
	stopElapsed();
	els.errorMessage.textContent = message;
	showState('error');
}

function showToast(message) {
	if (!els.toast) return;
	els.toast.textContent = message;
	els.toast.hidden = false;
	// Reflow so the .is-on transition runs even on a rapid second copy.
	void els.toast.offsetWidth;
	els.toast.classList.add('is-on');
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => {
		els.toast.classList.remove('is-on');
		setTimeout(() => {
			if (!els.toast.classList.contains('is-on')) els.toast.hidden = true;
		}, 240);
	}, 1800);
}

// ── Session history ────────────────────────────────────────────────
// Each entry: { glbUrl, prompt, thumb (data URL | null), ts }. Persisted on
// this device so a visitor's recent forges survive a scroll-away or reload.

function loadHistory() {
	try {
		const raw = JSON.parse(localStorage.getItem(HISTORY_KEY));
		return Array.isArray(raw) ? raw.filter((it) => it && it.glbUrl) : [];
	} catch {
		return [];
	}
}

function saveHistory(list) {
	try {
		localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(0, HISTORY_MAX)));
	} catch {
		// Quota or private-mode — the rail just won't persist; not fatal.
	}
}

function pushHistory(entry) {
	const list = loadHistory().filter((it) => it.glbUrl !== entry.glbUrl);
	list.unshift(entry);
	const trimmed = list.slice(0, HISTORY_MAX);
	saveHistory(trimmed);
	renderHistory(trimmed);
}

function renderHistory(list = loadHistory()) {
	if (!els.history || !els.historyTrack) return;
	els.history.hidden = list.length === 0;
	els.historyTrack.innerHTML = '';
	for (const item of list) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'hf-thumb';
		btn.setAttribute('role', 'listitem');
		btn.dataset.glb = item.glbUrl;
		const label = item.prompt || '3D model';
		btn.title = label;
		btn.setAttribute('aria-label', `Bring back: ${label}`);
		btn.setAttribute('aria-current', item.glbUrl === currentGlbUrl ? 'true' : 'false');
		if (item.thumb) {
			btn.style.backgroundImage = `url("${item.thumb}")`;
		} else {
			const fb = document.createElement('span');
			fb.className = 'hf-thumb-fallback';
			fb.textContent = (label.trim()[0] || '?').toUpperCase();
			fb.setAttribute('aria-hidden', 'true');
			btn.appendChild(fb);
		}
		btn.addEventListener('click', () => {
			if (busy) return;
			lastPrompt = item.prompt || lastPrompt;
			showResult(item.glbUrl, item.prompt || '', { fromHistory: true });
		});
		els.historyTrack.appendChild(btn);
	}
}

function markActiveThumb() {
	if (!els.historyTrack) return;
	for (const btn of els.historyTrack.querySelectorAll('.hf-thumb')) {
		btn.setAttribute('aria-current', btn.dataset.glb === currentGlbUrl ? 'true' : 'false');
	}
}

// Grab a real frame off the live viewer's canvas, square-crop and shrink it to
// a tiny WebP so a session's worth of thumbnails fits comfortably in storage.
async function captureThumb(viewer) {
	try {
		if (viewer.updateComplete) await viewer.updateComplete;
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
		const full = viewer.toDataURL('image/webp', 0.85);
		return await downscaleDataUrl(full, THUMB_SIZE);
	} catch {
		return null; // tainted canvas / unsupported — fall back to a letter tile.
	}
}

function downscaleDataUrl(src, size) {
	return new Promise((resolve) => {
		const img = new Image();
		img.onload = () => {
			try {
				const canvas = document.createElement('canvas');
				canvas.width = canvas.height = size;
				const ctx = canvas.getContext('2d');
				const side = Math.min(img.width, img.height);
				const sx = (img.width - side) / 2;
				const sy = (img.height - side) / 2;
				ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
				resolve(canvas.toDataURL('image/webp', 0.7));
			} catch {
				resolve(null);
			}
		};
		img.onerror = () => resolve(null);
		img.src = src;
	});
}

// ── Pipeline ───────────────────────────────────────────────────────

async function startJob(prompt) {
	const res = await fetch('/api/forge', {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...CLIENT_HEADERS },
		// No backend field: an explicit backend disables the server's health-aware
		// lane selection (see the header note), and the whole point here is letting
		// the router route around a cold or unhealthy lane before submit.
		body: JSON.stringify({
			prompt,
			aspect_ratio: '1:1',
			path: 'image',
			tier: 'standard',
			// Granite art-director pass (fail-soft): same photoreal-biased prompt
			// rewrite the full /forge page and every MCP tool already get.
			director: true,
		}),
	});
	const data = await res.json().catch(() => ({}));
	if (res.status === 503 || data.error === 'unconfigured') {
		throw new Error('The generator is offline right now — try again in a bit.');
	}
	if (res.status === 429 || data.error === 'rate_limited') {
		const secs = Number(data.retry_after) > 0 ? Math.ceil(Number(data.retry_after)) : 10;
		throw new Error(data.message || `The forge is busy. Try again in about ${secs} seconds.`);
	}
	if (!res.ok) throw new Error(data.message || `The generator returned ${res.status}.`);
	return data;
}

async function pollUntilDone(jobId, seq) {
	let deadline = performance.now() + MAX_POLL_MS;
	while (!pollAbort && seq === runSeq && performance.now() < deadline) {
		await sleep(POLL_INTERVAL_MS);
		if (pollAbort || seq !== runSeq) return null;
		const res = await fetch(`/api/forge?job=${encodeURIComponent(jobId)}`, {
			headers: CLIENT_HEADERS,
		});
		const data = await res.json().catch(() => ({}));
		if (data.status === 'done' && data.glb_url) return data;
		if (data.status === 'failed') throw new Error(data.error || 'Generation failed.');
		if (data.status === 'queued') {
			// A queued job is alive and waiting for a GPU: keep the step live and
			// never spend the run budget on line time.
			setStep('mesh', 'active');
			deadline = performance.now() + MAX_POLL_MS;
		}
		if (data.status === 'running') setStep('mesh', 'active');
	}
	if (pollAbort || seq !== runSeq) return null;
	throw new Error('Generation timed out — try a simpler, single-subject prompt.');
}

function sceneLinkFor(glbUrl, prompt) {
	const q = new URLSearchParams({ model: glbUrl });
	if (prompt) q.set('name', prompt.slice(0, 80));
	return `/scene?${q.toString()}`;
}

// A create-oriented share link. Instead of pointing at one finished file, it
// drops the recipient on the homepage forge with the prompt pre-loaded and
// auto-building — so "share" grows into a loop: create → share → the next
// person watches it build → they tweak and share their own. The `scene` action
// still links the exact finished model; this shares the *idea*, remixable.
export function remixLinkFor(prompt) {
	const clean = (prompt || '').trim().slice(0, 1000);
	if (!clean) return '/';
	return `/?prompt=${encodeURIComponent(clean)}&remix=1`;
}

// Read a forge intent off a URL — a shared remix link, a bookmark, or a
// hand-made one:
//   /?prompt=a%20brass%20compass          → prefill the hero (one tap to forge)
//   /?prompt=a%20brass%20compass&remix=1  → auto-forge on arrival (zero clicks)
// `forge=1` / `auto=1` alias `remix=1`; `p` aliases `prompt`. Never throws.
export function parseForgeIntent(search) {
	let params;
	try {
		params = new URLSearchParams(search || '');
	} catch {
		return { prompt: '', auto: false };
	}
	const prompt = (params.get('prompt') || params.get('p') || '').trim().slice(0, 1000);
	const truthy = (k) => {
		if (!params.has(k)) return false;
		const v = params.get(k);
		return v === '' || v === '1' || v === 'true';
	};
	const auto = Boolean(prompt) && (truthy('remix') || truthy('forge') || truthy('auto'));
	return { prompt, auto };
}

function downloadName(prompt) {
	return (
		`${(prompt || 'forge')
			.replace(/[^a-z0-9]+/gi, '-')
			.slice(0, 48)
			.replace(/^-|-$/g, '')}` || 'forge'
	);
}

function showResult(glbUrl, prompt, { fromHistory = false, creationId = '' } = {}) {
	stopElapsed();
	currentGlbUrl = glbUrl;
	// A fresh forge carries a persisted creation id (real OG permalink); a reload
	// from the on-device history rail does not, so it shares the remix link.
	currentCreationId = creationId || '';
	// Reloading from the history rail can happen before any forge this session,
	// so the viewer library may not be registered yet. The element upgrades
	// retroactively once the script lands — fire the load and let it catch up.
	ensureModelViewer().catch(() => {});
	const viewer = document.createElement('model-viewer');
	viewer.setAttribute('src', glbUrl);
	viewer.setAttribute('alt', prompt ? `3D model: ${prompt}` : '3D model');
	viewer.setAttribute('camera-controls', '');
	viewer.setAttribute('auto-rotate', '');
	viewer.setAttribute('auto-rotate-delay', '0');
	viewer.setAttribute('rotation-per-second', '18deg');
	viewer.setAttribute('interaction-prompt', 'none');
	viewer.setAttribute('shadow-intensity', '1');
	viewer.setAttribute('exposure', '1.05');
	viewer.setAttribute('environment-image', 'neutral');
	viewer.setAttribute('touch-action', 'pan-y');
	// AR where the device supports it — a real, free win on phones.
	viewer.setAttribute('ar', '');
	viewer.setAttribute('ar-modes', 'webxr scene-viewer quick-look');
	els.viewerSlot.innerHTML = '';
	els.viewerSlot.appendChild(viewer);
	currentViewer = viewer;

	// Reset the rotate toggle to its default-on state for the new model.
	if (els.spin) {
		els.spin.setAttribute('aria-pressed', 'true');
		els.spin.title = 'Pause auto-rotate';
	}

	els.resultMeta.textContent = prompt || 'Untitled model';
	els.resultMeta.title = prompt || '';
	if (els.download) {
		els.download.href = glbUrl;
		els.download.setAttribute('download', `${downloadName(prompt)}.glb`);
	}
	if (els.scene) els.scene.href = sceneLinkFor(glbUrl, prompt);

	showState('result');
	markActiveThumb();

	// Capture a frame off this render for the history rail (fresh forges only —
	// a reload from history already has its thumbnail).
	if (!fromHistory) {
		viewer.addEventListener(
			'load',
			() => {
				captureThumb(viewer).then((thumb) => {
					pushHistory({ glbUrl, prompt, thumb, ts: Date.now() });
					markActiveThumb();
				});
			},
			{ once: true },
		);
	}

	// Materialize: blur-in on the viewer + a one-shot scanline sweep.
	if (!REDUCED_MOTION) {
		els.viewerSlot.classList.remove('is-in');
		els.scan.classList.remove('is-scan');
		void els.viewerSlot.offsetWidth; // restart both animations
		els.viewerSlot.classList.add('is-in');
		els.scan.classList.add('is-scan');
	}

	// Hand keyboard focus to the action bar so the model is operable without a
	// mouse the instant it lands.
	if (els.resultRegion) {
		try {
			els.resultRegion.focus({ preventScroll: true });
		} catch {
			els.resultRegion.focus();
		}
	}

	// Same signal the full page emits — the discovery layer turns it into a
	// "what's next?" card (embed it, drop it in a world, …). Only on fresh
	// forges, so reloading a thumbnail doesn't re-trigger the cards.
	if (!fromHistory) {
		document.dispatchEvent(
			new CustomEvent('tws:feature-done', {
				detail: { feature: 'forge', model: { glbUrl, label: prompt } },
			}),
		);
		// Retention beat: acknowledge a growing collection at a few milestones.
		// Delayed so it follows the reveal rather than competing with it, and rare
		// by design (most forges get nothing), so it stays special when it lands.
		const note = milestoneNote(bumpForgeCount());
		if (note) setTimeout(() => showToast(note), 1400);
	}
}

async function run(prompt) {
	if (busy) return;
	closeEmbed();
	lastPrompt = prompt;
	pollAbort = false;
	const seq = ++runSeq;
	setBusy(true);
	setStep('mesh', 'active');
	setStep('finish', 'pending');
	els.preview.classList.remove('is-on');
	els.preview.innerHTML = '';
	startElapsed();
	showState('generating');
	// Fetch the viewer in parallel with the job — a failure surfaces only if a
	// model actually arrives.
	const viewerLoad = ensureModelViewer().catch((err) => err);

	try {
		const job = await startJob(prompt);
		if (seq !== runSeq) return; // cancelled while the POST was in flight

		if (job.preview_image_url) {
			const img = new Image();
			img.alt = 'Reference image';
			img.src = job.preview_image_url;
			img.onload = () => {
				if (seq !== runSeq) return;
				els.preview.innerHTML = '';
				els.preview.appendChild(img);
				els.preview.classList.add('is-on');
			};
		}

		// TRELLIS returns a job_id to poll; a server degrade to a synchronous
		// lane (NVIDIA) instead returns the finished model on the POST itself
		// (job_id null), where polling would loop on invalid_job. Handle both.
		const done =
			job.status === 'done' && job.glb_url ? job : await pollUntilDone(job.job_id, seq);
		if (pollAbort || seq !== runSeq || !done) return; // cancelled
		setStep('mesh', 'done');
		setStep('finish', 'done');

		const viewerErr = await viewerLoad;
		if (viewerErr instanceof Error) throw viewerErr;
		// The initial POST always carries the persisted creation id; the async
		// poll result may not, so prefer the job's id and fall back to done's.
		showResult(done.glb_url, prompt, { creationId: job.creation_id || done.creation_id || '' });
	} catch (err) {
		if (!pollAbort && seq === runSeq) {
			showError(err.message || 'Something went wrong. Try a simpler prompt.');
		}
	} finally {
		if (seq === runSeq) setBusy(false);
	}
}

function reset() {
	pollAbort = true;
	stopElapsed();
	setBusy(false);
	closeEmbed();
	currentGlbUrl = '';
	currentCreationId = '';
	currentViewer = null;
	markActiveThumb();
	showState('idle');
	els.prompt.focus();
}

// Typewriter suggestion — types real example prompts into the placeholder;
// Tab accepts the one currently showing. Pauses while the user has text, a
// run is live, or the tab is hidden. Reduced motion gets a static placeholder.
const SUGGESTIONS = [
	'a glazed ceramic teapot, studio lighting',
	'a low-poly red fox, sitting',
	'a sci-fi combat helmet, brushed metal',
	'a potted monstera plant',
	'a vintage film camera',
];
let suggestion = ''; // full text of the suggestion currently on screen

function startTypewriter() {
	if (REDUCED_MOTION) {
		suggestion = SUGGESTIONS[0];
		els.prompt.placeholder = suggestion;
		return;
	}
	let i = 0; // suggestion index
	let pos = 0; // chars typed
	let deleting = false;
	const tick = () => {
		const paused = busy || els.prompt.value || document.hidden;
		if (paused) {
			setTimeout(tick, 600);
			return;
		}
		const full = SUGGESTIONS[i];
		pos += deleting ? -1 : 1;
		els.prompt.placeholder = full.slice(0, pos) || '…';
		suggestion = full;
		let delay = deleting ? 22 : 55 + Math.random() * 45;
		if (!deleting && pos === full.length) {
			deleting = true;
			delay = 2400; // hold the finished suggestion
		} else if (deleting && pos === 0) {
			deleting = false;
			i = (i + 1) % SUGGESTIONS.length;
			delay = 350;
		}
		setTimeout(tick, delay);
	};
	setTimeout(tick, 900);
}

// Pointer parallax on the ambient layers (ring + floor) via --px/--py on the
// chamber. Skipped for coarse pointers and reduced motion.
function startParallax() {
	if (REDUCED_MOTION) return;
	if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return;
	let raf = 0;
	let px = 0;
	let py = 0;
	els.chamber.addEventListener('pointermove', (e) => {
		const r = els.chamber.getBoundingClientRect();
		px = ((e.clientX - r.left) / r.width - 0.5) * 2;
		py = ((e.clientY - r.top) / r.height - 0.5) * 2;
		if (!raf) {
			raf = requestAnimationFrame(() => {
				raf = 0;
				els.chamber.style.setProperty('--px', px.toFixed(3));
				els.chamber.style.setProperty('--py', py.toFixed(3));
			});
		}
	});
	els.chamber.addEventListener('pointerleave', () => {
		els.chamber.style.setProperty('--px', '0');
		els.chamber.style.setProperty('--py', '0');
	});
}

// The prompt is a one-line bar that grows with multi-line prompts (capped in CSS).
function autoGrow() {
	els.prompt.style.height = 'auto';
	els.prompt.style.height = `${els.prompt.scrollHeight}px`;
}

async function copyShareLink() {
	if (!currentGlbUrl) return;
	// A freshly forged model has a persisted creation id, so share its real
	// permalink: /forge/share/:id unfurls with an OG card (api/forge-share.js)
	// and opens the actual model, not just its prompt. Only a reload from the
	// on-device history rail lacks an id, so there we share the remix link, which
	// rebuilds the prompt for whoever opens it. Either way the copied link is a
	// real, working destination, never a dead file URL.
	const sharesModel = Boolean(currentCreationId);
	const path = sharesModel ? `/forge/share/${currentCreationId}` : remixLinkFor(lastPrompt);
	const url = new URL(path, location.origin).href;
	const okMsg = sharesModel
		? 'Link copied. Opens your model with a preview card'
		: 'Remix link copied. Whoever opens it builds their own';
	try {
		await navigator.clipboard.writeText(url);
		showToast(okMsg);
	} catch {
		// Clipboard blocked (permissions / insecure context) — fall back to a
		// transient selectable field the user can copy manually.
		const input = document.createElement('input');
		input.value = url;
		input.style.cssText = 'position:fixed;top:-1000px;left:0;opacity:0;';
		document.body.appendChild(input);
		input.select();
		let ok = false;
		try {
			ok = document.execCommand('copy');
		} catch {
			ok = false;
		}
		document.body.removeChild(input);
		showToast(ok ? 'Share link copied' : 'Press ⌘/Ctrl-C to copy');
	}
}

function toggleAutoRotate() {
	if (!currentViewer || !els.spin) return;
	const on = currentViewer.hasAttribute('auto-rotate');
	if (on) currentViewer.removeAttribute('auto-rotate');
	else currentViewer.setAttribute('auto-rotate', '');
	els.spin.setAttribute('aria-pressed', String(!on));
	els.spin.title = on ? 'Resume auto-rotate' : 'Pause auto-rotate';
}

// ── Embed sheet ────────────────────────────────────────────────────
// Drop the forged model on any site. Snippet shapes, size presets, and the
// /forge/embed URLs are shared with the full Forge embed modal via
// ./forge-embed-snippets.js, so the two surfaces never drift.

function currentEmbedSnippet(glb) {
	return embedState.tab === 'iframe'
		? buildIframeSnippet(glb, lastPrompt, embedState.sizeId)
		: buildWebComponentSnippet(glb, lastPrompt, embedState.sizeId);
}

function renderEmbed() {
	if (!els.embed) return;
	const glb = absoluteGlb(currentGlbUrl);
	if (!glb) return;
	els.embedCode.value = currentEmbedSnippet(glb);
	if (els.embedPreview) els.embedPreview.style.aspectRatio = embedSize(embedState.sizeId).ratio;
	if (els.embedStandalone) els.embedStandalone.href = embedPageUrl(glb, lastPrompt);
	for (const b of els.embedTabs.querySelectorAll('[data-hf-embed-tab]')) {
		b.setAttribute('aria-pressed', String(b.dataset.hfEmbedTab === embedState.tab));
	}
	for (const b of els.embedSizes.querySelectorAll('[data-hf-embed-size]')) {
		b.setAttribute('aria-pressed', String(b.dataset.hfEmbedSize === embedState.sizeId));
	}
}

function openEmbed() {
	if (!els.embed || !currentGlbUrl) return;
	const glb = absoluteGlb(currentGlbUrl);
	embedTrigger = document.activeElement;
	// Point the live preview at the real embed viewer so what you see is what
	// ships. Set once on open; size changes only restyle the frame's aspect box.
	els.embedFrame.src = embedPreviewUrl(glb, lastPrompt);
	renderEmbed();
	els.embed.hidden = false;
	document.addEventListener('keydown', onEmbedKeydown, true);
	// Focus the first control so the sheet is operable from the keyboard.
	const first = els.embed.querySelector('[data-hf-embed-close], button, [href], textarea');
	if (first) first.focus();
}

function closeEmbed() {
	if (!els.embed || els.embed.hidden) return;
	els.embed.hidden = true;
	els.embedFrame.removeAttribute('src'); // release the preview's WebGL context
	document.removeEventListener('keydown', onEmbedKeydown, true);
	if (embedTrigger && typeof embedTrigger.focus === 'function') embedTrigger.focus();
	embedTrigger = null;
}

function onEmbedKeydown(e) {
	if (e.key === 'Escape') {
		e.preventDefault();
		closeEmbed();
	}
}

async function copyEmbedCode() {
	const text = els.embedCode.value;
	if (!text) return;
	const label = els.embedCopyLabel;
	const original = label ? label.textContent : '';
	let ok = true;
	try {
		if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
		else {
			els.embedCode.focus();
			els.embedCode.select();
			ok = document.execCommand('copy');
		}
	} catch {
		ok = false;
	}
	els.embedCopy.classList.toggle('is-copied', ok);
	if (label) label.textContent = ok ? 'Copied ✓' : 'Press ⌘/Ctrl-C to copy';
	clearTimeout(embedCopyTimer);
	embedCopyTimer = setTimeout(() => {
		els.embedCopy.classList.remove('is-copied');
		if (label) label.textContent = original;
	}, 2200);
}

function wireEmbed() {
	if (!els.embed || !els.embedOpen) return;
	els.embedOpen.addEventListener('click', openEmbed);
	for (const el of els.embedCloseEls) el.addEventListener('click', closeEmbed);
	els.embedTabs.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-hf-embed-tab]');
		if (!btn) return;
		embedState.tab = btn.dataset.hfEmbedTab;
		renderEmbed();
	});
	els.embedSizes.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-hf-embed-size]');
		if (!btn) return;
		embedState.sizeId = btn.dataset.hfEmbedSize;
		renderEmbed();
	});
	els.embedCopy.addEventListener('click', copyEmbedCode);
}

function boot() {
	els.form.addEventListener('submit', (e) => {
		e.preventDefault();
		const prompt = els.prompt.value.trim();
		if (prompt) run(prompt);
		else if (suggestion) {
			// Forging straight from the live suggestion is a valid ask.
			els.prompt.value = suggestion;
			autoGrow();
			run(suggestion);
		} else els.prompt.focus();
	});

	els.prompt.addEventListener('input', autoGrow);

	els.prompt.addEventListener('keydown', (e) => {
		// Tab accepts the suggestion currently typed into the placeholder.
		if (e.key === 'Tab' && !e.shiftKey && !els.prompt.value && suggestion) {
			e.preventDefault();
			els.prompt.value = suggestion;
			autoGrow();
			return;
		}
		// Cmd/Ctrl+Enter submits — same convention as the full page. Plain
		// Enter submits too: this is a one-line command bar, not a document.
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			els.form.requestSubmit();
		}
	});

	els.chips.addEventListener('click', (e) => {
		const chip = e.target.closest('button[data-prompt]');
		if (!chip || busy) return;
		els.prompt.value = chip.dataset.prompt;
		autoGrow();
		run(chip.dataset.prompt);
	});

	els.cancel.addEventListener('click', reset);
	els.again.addEventListener('click', reset);
	els.retry.addEventListener('click', () => {
		if (lastPrompt) run(lastPrompt);
		else reset();
	});

	if (els.spin) els.spin.addEventListener('click', toggleAutoRotate);
	if (els.share) els.share.addEventListener('click', copyShareLink);
	if (els.vary)
		els.vary.addEventListener('click', () => {
			if (lastPrompt && !busy) run(lastPrompt);
		});

	wireEmbed();
	wireHeroBar();
	renderHistory();
	startTypewriter();
	startParallax();
}

// The hero prompt bar (pages/home.html, #hero-forge-form) is a remote control
// for this chamber: it lets a visitor forge from the very first thing they see,
// no scroll, no navigation. Submitting mirrors the text into the chamber's own
// input and calls the same run() path the dock and chips use, then reveals and
// scrolls the chamber into view so the model builds where the eye follows. The
// chamber owns all generation state; the hero bar only kicks it off. Absent on
// pages without the hero (defensive: the whole thing no-ops).
function wireHeroBar() {
	const heroForm = document.getElementById('hero-forge-form');
	if (!heroForm) return;
	const heroInput = document.getElementById('hero-forge-input');
	const heroGo = document.getElementById('hero-forge-go');
	const tries = document.querySelector('.hero-forge-tries');

	// Reflect the chamber's busy state on the hero button so a visitor who stays
	// at the top sees the generation is running and can't double-fire it.
	const reflectBusy = () => {
		if (heroGo) heroGo.dataset.busy = busy ? '1' : '0';
	};

	const forgeFromHero = (text) => {
		const prompt = (text || '').trim();
		if (!prompt || busy) return;
		// Reveal the chamber (it may still be pre-scroll-reveal at opacity 0) and
		// bring it into view so the build is watched, not hidden below the fold.
		els.chamber.querySelectorAll('.reveal').forEach((el) => el.classList.add('vis'));
		els.chamber.classList.add('vis');
		els.prompt.value = prompt;
		autoGrow();
		els.chamber.scrollIntoView({ behavior: 'smooth', block: 'center' });
		run(prompt);
		reflectBusy();
	};

	heroForm.addEventListener('submit', (e) => {
		e.preventDefault();
		const value = heroInput?.value || '';
		if (value.trim()) forgeFromHero(value);
		else if (suggestion) forgeFromHero(suggestion);
		else heroInput?.focus();
	});

	tries?.addEventListener('click', (e) => {
		const chip = e.target.closest('button[data-prompt]');
		if (!chip) return;
		if (heroInput) heroInput.value = chip.dataset.prompt;
		forgeFromHero(chip.dataset.prompt);
	});

	// A shared remix link (or any /?prompt=… URL) lands the visitor mid-create:
	// prefill the bar, and when the link opts into it (remix=1), forge on arrival
	// so the model builds itself with zero clicks. Guarded so it fires once and
	// not on a hidden/prerendered load.
	const intent = parseForgeIntent(typeof location !== 'undefined' ? location.search : '');
	if (intent.prompt) {
		if (heroInput) heroInput.value = intent.prompt;
		if (intent.auto && !document.hidden) {
			forgeFromHero(intent.prompt);
		} else if (heroInput) {
			try { heroInput.focus({ preventScroll: true }); } catch { heroInput.focus(); }
		}
	}

	// Keep the hero button's busy state honest as generation starts/ends by
	// observing the chamber's state attribute (set by showState()/setBusy()).
	if (window.MutationObserver && els.chamber) {
		new MutationObserver(reflectBusy).observe(els.chamber, {
			attributes: true,
			attributeFilter: ['data-hf-state'],
		});
	}

	// A rotating placeholder makes the empty bar feel alive and quietly teaches
	// what a good prompt looks like (a subject + a material/finish cue). It cycles
	// only while the field is empty and unfocused, pauses on focus/typing, and
	// respects reduced-motion. Pure decoration, never touches the field's value.
	if (heroInput) {
		const HERO_EXAMPLES = [
			'a brass compass, weathered',
			'a low-poly red fox, sitting',
			'a sci-fi combat helmet, brushed metal',
			'a glazed ceramic teapot',
			'a worn leather armchair',
			'a potted monstera plant',
			'a vintage film camera',
			'a crystal geode, amethyst',
		];
		const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
		let idx = 0;
		let paused = false;
		const basePlaceholder = heroInput.getAttribute('placeholder') || '';
		heroInput.addEventListener('focus', () => (paused = true));
		heroInput.addEventListener('blur', () => {
			paused = false;
			if (!heroInput.value) heroInput.placeholder = basePlaceholder;
		});
		// English only: the rotator's template is English, and for a non-English
		// locale the i18n runtime has already set a translated placeholder we must
		// not clobber. `documentElement.lang` carries the active locale (set by
		// src/i18n.js); default/unset is treated as English.
		const isEnglish = () => {
			const lang = (document.documentElement.lang || 'en').toLowerCase();
			return lang === 'en' || lang.startsWith('en-');
		};
		if (!reduce) {
			setInterval(() => {
				if (paused || heroInput.value || document.hidden || !isEnglish()) return;
				idx = (idx + 1) % HERO_EXAMPLES.length;
				heroInput.placeholder = `describe anything: ${HERO_EXAMPLES[idx]}…`;
			}, 3200);
		}
	}
}

if (root && els.form) boot();
