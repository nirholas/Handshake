// Portal: the page controller.
//
// Owns the state machine (intro → building → walking → error), the HUD, the
// minimap, the touch stick, and the three ways a world leaves this page: a
// share link, an embed snippet, and a GLB download. The world itself is built
// by the API (api/portal.js) and rendered by ./render.js; this module never
// parses HTML and never touches WebGL.
//
// A world is addressed by the page's own query string (`/portal?url=…`), so the
// browser's back button walks back through the sites you visited, and any link
// you copy reopens exactly the world you were standing in.

import { createPortalWorld } from './render.js';

const $ = (id) => document.getElementById(id);
const els = {
	canvas: $('pt-canvas'),
	intro: $('pt-intro'),
	introForm: $('pt-intro-form'),
	introInput: $('pt-intro-input'),
	examples: $('pt-examples'),
	loading: $('pt-loading'),
	loadingHost: $('pt-loading-host'),
	steps: $('pt-steps'),
	error: $('pt-error'),
	errorCode: $('pt-error-code'),
	errorMessage: $('pt-error-message'),
	errorForm: $('pt-error-form'),
	errorInput: $('pt-error-input'),
	site: $('pt-site'),
	siteIcon: $('pt-site-icon'),
	siteTitle: $('pt-site-title'),
	siteMeta: $('pt-site-meta'),
	actions: $('pt-actions'),
	copy: $('pt-copy'),
	embed: $('pt-embed'),
	glb: $('pt-glb'),
	newAddress: $('pt-new'),
	address: $('pt-address'),
	addressInput: $('pt-address-input'),
	door: $('pt-door'),
	doorLabel: $('pt-door-label'),
	doorKind: $('pt-door-kind'),
	map: $('pt-map'),
	mapCanvas: $('pt-map-canvas'),
	stick: $('pt-stick'),
	stickKnob: $('pt-stick-knob'),
	toast: $('pt-toast'),
	keys: $('pt-keys'),
};

let active = null; // the running world, if any
let current = null; // { url, world, outline }

// ── small helpers ──────────────────────────────────────────────────────────
function show(el, on) {
	if (el) el.hidden = !on;
}

let toastTimer = 0;
function toast(message) {
	els.toast.textContent = message;
	els.toast.dataset.open = '1';
	clearTimeout(toastTimer);
	toastTimer = window.setTimeout(() => {
		els.toast.dataset.open = '0';
	}, 2400);
}

function setStep(name, state) {
	for (const li of els.steps.querySelectorAll('.pt-step')) {
		if (li.dataset.step === name) li.dataset.state = state;
	}
}

function markStepsUpTo(name) {
	const order = ['fetch', 'read', 'layout', 'render'];
	const at = order.indexOf(name);
	order.forEach((step, i) => setStep(step, i < at ? 'done' : i === at ? 'active' : ''));
}

function formatCount(n) {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

// ── loading and error surfaces ─────────────────────────────────────────────
function showLoading(host) {
	els.loadingHost.textContent = host;
	markStepsUpTo('fetch');
	show(els.intro, false);
	show(els.error, false);
	show(els.loading, true);
}

function showError(code, message) {
	els.errorCode.textContent = String(code || 'error').replace(/_/g, ' ');
	els.errorMessage.textContent = message || 'Something went wrong building that world.';
	show(els.loading, false);
	show(els.intro, false);
	show(els.error, true);
	els.errorInput.value = '';
	els.errorInput.focus();
}

// ── the main flow ──────────────────────────────────────────────────────────
async function openWorld(rawUrl, { push = true } = {}) {
	const target = String(rawUrl || '').trim();
	if (!target) return;
	const host = target.replace(/^https?:\/\//, '').split('/')[0];
	showLoading(host);

	let payload;
	try {
		const res = await fetch(`/api/portal?url=${encodeURIComponent(target)}`, {
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(25_000),
		});
		markStepsUpTo('read');
		payload = await res.json().catch(() => null);
		if (!res.ok || !payload?.world) {
			return showError(payload?.error || `http_${res.status}`, payload?.error_description || payload?.message || `${host} could not be read.`);
		}
	} catch (err) {
		return showError(
			err?.name === 'TimeoutError' ? 'timeout' : 'unreachable',
			err?.name === 'TimeoutError'
				? `${host} took too long to answer. It may be slow rather than gone: try again.`
				: `Could not reach three.ws to build ${host}. Check your connection and try again.`,
		);
	}

	markStepsUpTo('layout');
	current = { url: target, world: payload.world, outline: payload.outline };
	if (push) {
		const next = `/portal?url=${encodeURIComponent(target)}`;
		if (location.pathname + location.search !== next) history.pushState({ url: target }, '', next);
	}
	document.title = `${payload.world.meta.title} as a walkable world · Portal · three.ws`;

	markStepsUpTo('render');
	mountWorld(payload.world);
	paintHud(payload.world, payload.outline, payload.cached);
	show(els.loading, false);
}

function mountWorld(world) {
	active?.dispose();
	active = createPortalWorld({
		canvas: els.canvas,
		world,
		onDoor: handleDoor,
		onReady: () => {
			show(els.keys, !matchMedia('(pointer: coarse)').matches);
		},
	});
	resize();
	startMinimap(world);
}

function paintHud(world, outline, cached) {
	els.siteTitle.textContent = world.meta.title || world.meta.host;
	els.siteMeta.textContent = '';
	const bits = [
		world.meta.host,
		`${world.meta.sections} ${world.meta.sections === 1 ? 'section' : 'sections'}`,
		`${formatCount(world.meta.words)} words`,
		`${world.doors.length} ${world.doors.length === 1 ? 'door' : 'doors'}`,
	];
	if (cached) bits.push('cached');
	for (const bit of bits) {
		const span = document.createElement('span');
		span.textContent = bit;
		els.siteMeta.append(span);
	}
	if (outline?.icon) {
		els.siteIcon.src = `/api/img?url=${encodeURIComponent(outline.icon)}`;
		els.siteIcon.alt = '';
	} else {
		els.siteIcon.removeAttribute('src');
	}
	show(els.site, true);
	show(els.actions, true);
	show(els.address, true);
	show(els.map, true);
	show(els.stick, matchMedia('(pointer: coarse)').matches);
	els.addressInput.value = '';
	els.addressInput.placeholder = world.meta.host;
}

function handleDoor(door, phase) {
	if (!door) {
		els.door.dataset.open = '0';
		return;
	}
	if (phase === 'near') {
		els.doorLabel.textContent = door.label || door.href;
		els.doorKind.textContent = door.internal ? 'same site' : new URL(door.href).host;
		els.door.dataset.open = '1';
		return;
	}
	// Activated: an internal link rebuilds the world in place, an external one
	// opens the page it points at, which is what a door on the edge of a site is.
	if (door.internal) {
		openWorld(door.href);
	} else {
		window.open(door.href, '_blank', 'noopener,noreferrer');
		toast(`Opened ${new URL(door.href).host}`);
	}
}

// ── minimap ────────────────────────────────────────────────────────────────
let mapRaf = 0;
function startMinimap(world) {
	cancelAnimationFrame(mapRaf);
	const ctx = els.mapCanvas.getContext('2d');
	const size = els.mapCanvas.width;
	const scale = size / (world.ground.radius * 2.1);
	const toMap = (x, z) => [size / 2 + x * scale, size / 2 + z * scale];

	const draw = () => {
		mapRaf = requestAnimationFrame(draw);
		ctx.clearRect(0, 0, size, size);
		ctx.fillStyle = 'rgba(255,255,255,0.03)';
		ctx.beginPath();
		ctx.arc(size / 2, size / 2, (world.ground.radius * scale), 0, Math.PI * 2);
		ctx.fill();

		ctx.strokeStyle = 'rgba(255,255,255,0.10)';
		ctx.lineWidth = 1;
		for (const d of world.districts) {
			const [x, y] = toMap(d.x, d.z);
			ctx.beginPath();
			ctx.moveTo(size / 2, size / 2);
			ctx.lineTo(x, y);
			ctx.stroke();
		}
		for (const b of world.buildings) {
			const [x, y] = toMap(b.x, b.z);
			ctx.fillStyle = b.color;
			ctx.fillRect(x - Math.max(2, b.w * scale) / 2, y - Math.max(2, b.d * scale) / 2, Math.max(2, b.w * scale), Math.max(2, b.d * scale));
		}
		for (const door of world.doors) {
			const [x, y] = toMap(door.x, door.z);
			ctx.fillStyle = door.color;
			ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
		}
		const p = active?.player;
		if (p) {
			const [x, y] = toMap(p.x, p.z);
			ctx.save();
			ctx.translate(x, y);
			ctx.rotate(-p.yaw);
			ctx.fillStyle = '#ffffff';
			ctx.beginPath();
			ctx.moveTo(0, -6);
			ctx.lineTo(4.5, 5);
			ctx.lineTo(-4.5, 5);
			ctx.closePath();
			ctx.fill();
			ctx.restore();
		}
	};
	draw();
}

// ── touch stick ────────────────────────────────────────────────────────────
function wireStick() {
	let id = null;
	let origin = { x: 0, y: 0 };
	const radius = 44;
	const set = (dx, dy) => {
		const len = Math.hypot(dx, dy);
		const k = len > radius ? radius / len : 1;
		els.stickKnob.style.transform = `translate(${dx * k}px, ${dy * k}px)`;
		active?.steer((dx * k) / radius, (dy * k) / radius);
	};
	els.stick.addEventListener('pointerdown', (e) => {
		id = e.pointerId;
		origin = { x: e.clientX, y: e.clientY };
		els.stick.setPointerCapture(id);
	});
	els.stick.addEventListener('pointermove', (e) => {
		if (e.pointerId !== id) return;
		set(e.clientX - origin.x, e.clientY - origin.y);
	});
	const end = (e) => {
		if (e.pointerId !== id) return;
		id = null;
		els.stickKnob.style.transform = 'translate(0,0)';
		active?.steer(0, 0);
	};
	els.stick.addEventListener('pointerup', end);
	els.stick.addEventListener('pointercancel', end);
}

// ── sharing ────────────────────────────────────────────────────────────────
async function copyText(text, message) {
	try {
		await navigator.clipboard.writeText(text);
		toast(message);
	} catch {
		// Clipboard permission can be refused (an iframe, a locked-down browser).
		// Selecting the text is the honest fallback: the user can still copy it.
		const box = document.createElement('textarea');
		box.value = text;
		box.setAttribute('readonly', '');
		box.style.position = 'fixed';
		box.style.opacity = '0';
		document.body.append(box);
		box.select();
		const ok = document.execCommand?.('copy');
		box.remove();
		toast(ok ? message : 'Copy blocked by the browser. The link is in the address bar.');
	}
}

function embedSnippet(url) {
	return `<iframe src="https://three.ws/portal?url=${encodeURIComponent(url)}&embed=1" width="100%" height="520" style="border:0;border-radius:14px" loading="lazy" title="Walk ${url} in 3D"></iframe>`;
}

async function downloadGlb() {
	if (!current) return;
	els.glb.disabled = true;
	els.glb.textContent = 'Building GLB';
	try {
		const res = await fetch(`/api/portal?url=${encodeURIComponent(current.url)}&format=glb`, { signal: AbortSignal.timeout(30_000) });
		if (!res.ok) {
			const body = await res.json().catch(() => null);
			throw new Error(body?.error_description || `export failed (${res.status})`);
		}
		const blob = await res.blob();
		const href = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = href;
		a.download = `portal-${current.world.meta.host}.glb`;
		document.body.append(a);
		a.click();
		a.remove();
		setTimeout(() => URL.revokeObjectURL(href), 4000);
		toast('Downloaded. Open it in any glTF viewer.');
	} catch (err) {
		toast(err?.message || 'Could not export this world.');
	} finally {
		els.glb.disabled = false;
		els.glb.textContent = 'Download GLB';
	}
}

// ── wiring ─────────────────────────────────────────────────────────────────
function resize() {
	active?.setSize(window.innerWidth, window.innerHeight);
}

function urlFromLocation() {
	return new URLSearchParams(location.search).get('url') || '';
}

function boot() {
	wireStick();
	window.addEventListener('resize', resize);
	window.addEventListener('popstate', () => {
		const url = urlFromLocation();
		if (url) openWorld(url, { push: false });
	});

	els.introForm.addEventListener('submit', (e) => {
		e.preventDefault();
		openWorld(els.introInput.value);
	});
	els.errorForm.addEventListener('submit', (e) => {
		e.preventDefault();
		openWorld(els.errorInput.value);
	});
	els.address.addEventListener('submit', (e) => {
		e.preventDefault();
		if (els.addressInput.value.trim()) openWorld(els.addressInput.value);
	});
	for (const root of [els.examples, els.error]) {
		root.addEventListener('click', (e) => {
			const chip = e.target.closest('[data-url]');
			if (chip) openWorld(chip.dataset.url);
		});
	}
	els.copy.addEventListener('click', () => {
		copyText(`https://three.ws/portal?url=${encodeURIComponent(current?.url || '')}`, 'Link copied.');
	});
	els.embed.addEventListener('click', () => {
		copyText(embedSnippet(current?.url || ''), 'Embed snippet copied.');
	});
	els.glb.addEventListener('click', downloadGlb);
	els.newAddress.addEventListener('click', () => {
		els.introInput.value = current?.url || '';
		show(els.intro, true);
		els.introInput.focus();
		els.introInput.select();
	});
	els.door.addEventListener('click', () => active?.activate());

	// An embedded portal hides the chrome that only makes sense on our own page.
	if (new URLSearchParams(location.search).get('embed') === '1') {
		document.body.classList.add('pt-embedded');
		show(els.keys, false);
	}

	const initial = urlFromLocation();
	if (initial) openWorld(initial, { push: false });
	else els.introInput.focus();
}

boot();
