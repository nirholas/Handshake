// Client controller for "take the wheel" on the agent screen. The owner of an
// agent can drive its live cast browser: real mouse, drag, scroll, keyboard, and
// navigation, dispatched to the caster's Chromium via the control channel.
//
//   acquire  → POST /api/agent-screen-control {action:'acquire'}  (session + CSRF)
//   input    → POST /api/agent-screen-control {action:'input'}    (bearer lease)
//   renew    → keeps an idle lease alive
//   release  → drops the wheel
//
// Coordinates are sent NORMALIZED (0..1) against the rendered canvas, so the
// caster maps them onto its real viewport no matter the display size here.

const CTL_URL = '/api/agent-screen-control';
const CSRF_URL = '/api/csrf-token';

const MOVE_THROTTLE_MS = 55; // cap pointermove event rate on the wire
const FLUSH_MS = 80;         // batch outgoing input this often
const RENEW_MS = 8_000;      // refresh the lease while driving

async function getCsrf() {
	try {
		const r = await fetch(CSRF_URL, { credentials: 'include' });
		if (!r.ok) return null;
		const j = await r.json().catch(() => null);
		return j?.token || j?.csrfToken || null;
	} catch {
		return null;
	}
}

const btnName = (n) => (n === 2 ? 'right' : n === 1 ? 'middle' : 'left');

// Mount the control affordance onto the screen stage. `canvas` is the element the
// frames render into; its bounding rect is the coordinate space. `isLive()` gates
// engagement so a driver can't grab a wheel that isn't casting yet. Returns a
// small handle with destroy() for teardown.
export function mountScreenControl({ stage, canvas, agentId, isLive, onStatus }) {
	if (!stage || !canvas || !agentId) return { destroy() {} };

	// ── DOM: a toolbar with Take control / Release + a URL bar (shown when driving)
	const bar = document.createElement('div');
	bar.className = 'asc-ctl-bar';
	bar.innerHTML = `
		<button type="button" class="asc-ctl-toggle" aria-pressed="false">
			<span class="asc-ctl-ico" aria-hidden="true">&#127918;</span>
			<span class="asc-ctl-label">Take control</span>
		</button>
		<div class="asc-ctl-drive" hidden>
			<button type="button" class="asc-ctl-nav asc-ctl-back" title="Back" aria-label="Back">&#8592;</button>
			<button type="button" class="asc-ctl-nav asc-ctl-reload" title="Reload" aria-label="Reload">&#8635;</button>
			<form class="asc-ctl-urlform">
				<input class="asc-ctl-url" type="text" inputmode="url" spellcheck="false"
					placeholder="Type a URL and press Enter" aria-label="Navigate the agent's browser" />
			</form>
			<span class="asc-ctl-hint" role="status"></span>
		</div>`;
	stage.appendChild(bar);

	// Transparent capture layer over the canvas. Only present while driving.
	const overlay = document.createElement('div');
	overlay.className = 'asc-ctl-overlay';
	overlay.tabIndex = 0;
	overlay.hidden = true;
	stage.appendChild(overlay);

	const toggle = bar.querySelector('.asc-ctl-toggle');
	const toggleLabel = bar.querySelector('.asc-ctl-label');
	const drive = bar.querySelector('.asc-ctl-drive');
	const urlForm = bar.querySelector('.asc-ctl-urlform');
	const urlInput = bar.querySelector('.asc-ctl-url');
	const hint = bar.querySelector('.asc-ctl-hint');
	const backBtn = bar.querySelector('.asc-ctl-back');
	const reloadBtn = bar.querySelector('.asc-ctl-reload');

	let leaseToken = null;
	let driving = false;
	let queue = [];
	let textBuf = '';
	let lastMoveAt = 0;
	let flushTimer = null;
	let renewTimer = null;

	const setHint = (msg) => { hint.textContent = msg || ''; };

	function norm(e) {
		const rect = canvas.getBoundingClientRect();
		if (!rect.width || !rect.height) return { x: 0, y: 0 };
		const x = (e.clientX - rect.left) / rect.width;
		const y = (e.clientY - rect.top) / rect.height;
		return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
	}

	// Text is coalesced into one 'text' event per flush so a fast typist sends one
	// call, not one per character. Any non-text event flushes the pending text
	// first so ordering (type "abc" then Enter) is preserved.
	function flushTextBuf() {
		if (textBuf) { queue.push({ t: 'text', text: textBuf }); textBuf = ''; }
	}
	function enqueue(ev) { flushTextBuf(); queue.push(ev); }

	async function flush() {
		if (!driving || !leaseToken) return;
		flushTextBuf();
		if (!queue.length) return;
		const batch = queue.splice(0, 40);
		try {
			const r = await fetch(CTL_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${leaseToken}` },
				body: JSON.stringify({ agentId, action: 'input', events: batch }),
			});
			if (r.status === 401) { setHint('Lease expired'); await stop(false); }
		} catch { /* transient; next flush retries the rest of the queue */ }
	}

	async function acquire() {
		const csrf = await getCsrf();
		if (!csrf) { onStatus?.('error', 'Sign in to drive this agent'); return false; }
		try {
			const r = await fetch(CTL_URL, {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
				body: JSON.stringify({ agentId, action: 'acquire' }),
			});
			if (!r.ok) {
				const j = await r.json().catch(() => ({}));
				const msg = j?.error === 'in_use' ? 'Another session is already driving'
					: r.status === 403 ? 'You do not own this agent'
					: r.status === 401 ? 'Sign in to drive this agent'
					: 'Could not take control';
				onStatus?.('error', msg);
				return false;
			}
			const j = await r.json();
			leaseToken = j.leaseToken;
			return !!leaseToken;
		} catch {
			onStatus?.('error', 'Could not reach the control channel');
			return false;
		}
	}

	async function renew() {
		if (!driving || !leaseToken) return;
		try {
			await fetch(CTL_URL, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${leaseToken}` },
				body: JSON.stringify({ agentId, action: 'renew' }),
			});
		} catch { /* the flush loop will surface a dead lease */ }
	}

	async function start() {
		if (driving) return;
		if (isLive && !isLive()) { onStatus?.('error', 'The agent must be live to drive'); return; }
		toggle.disabled = true;
		const ok = await acquire();
		toggle.disabled = false;
		if (!ok) return;
		driving = true;
		overlay.hidden = false;
		drive.hidden = false;
		toggle.setAttribute('aria-pressed', 'true');
		toggle.classList.add('driving');
		toggleLabel.textContent = 'Release control';
		setHint('You have the wheel');
		onStatus?.('driving', 'You are driving');
		attachInput();
		overlay.focus();
		flushTimer = setInterval(flush, FLUSH_MS);
		renewTimer = setInterval(renew, RENEW_MS);
	}

	async function stop(release = true) {
		if (!driving) return;
		driving = false;
		clearInterval(flushTimer); flushTimer = null;
		clearInterval(renewTimer); renewTimer = null;
		detachInput();
		queue = []; textBuf = '';
		overlay.hidden = true;
		drive.hidden = true;
		toggle.setAttribute('aria-pressed', 'false');
		toggle.classList.remove('driving');
		toggleLabel.textContent = 'Take control';
		setHint('');
		onStatus?.('idle', '');
		if (release && leaseToken) {
			try {
				await fetch(CTL_URL, {
					method: 'POST',
					headers: { 'content-type': 'application/json', authorization: `Bearer ${leaseToken}` },
					body: JSON.stringify({ agentId, action: 'release' }),
				});
			} catch { /* the lease TTL reclaims it regardless */ }
		}
		leaseToken = null;
	}

	// ── input capture (only wired while driving) ────────────────────────────────
	const onPointerMove = (e) => {
		const now = Date.now();
		if (now - lastMoveAt < MOVE_THROTTLE_MS) return;
		lastMoveAt = now;
		const { x, y } = norm(e);
		queue.push({ t: 'move', x, y }); // moves don't need to flush pending text
	};
	const onPointerDown = (e) => {
		e.preventDefault();
		overlay.focus();
		overlay.setPointerCapture?.(e.pointerId);
		enqueue({ t: 'down', ...norm(e), button: btnName(e.button) });
	};
	const onPointerUp = (e) => {
		e.preventDefault();
		overlay.releasePointerCapture?.(e.pointerId);
		enqueue({ t: 'up', ...norm(e), button: btnName(e.button) });
	};
	const onWheel = (e) => {
		e.preventDefault();
		enqueue({ t: 'scroll', ...norm(e), dy: e.deltaY });
	};
	const onContextMenu = (e) => { e.preventDefault(); };
	const SPECIAL = new Set([
		'Enter', 'Backspace', 'Tab', 'Delete', 'Escape',
		'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
		'Home', 'End', 'PageUp', 'PageDown',
	]);
	const onKeyDown = (e) => {
		if (!driving) return;
		if (e.target === urlInput) return;      // let the URL bar type normally
		if (e.metaKey || e.ctrlKey || e.altKey) return; // no chords in v1
		if (SPECIAL.has(e.key)) {
			e.preventDefault();
			enqueue({ t: 'key', key: e.key });
		} else if (e.key.length === 1) {
			e.preventDefault();
			textBuf += e.key;                    // coalesced, flushed as one text event
		}
	};

	function attachInput() {
		overlay.addEventListener('pointermove', onPointerMove);
		overlay.addEventListener('pointerdown', onPointerDown);
		overlay.addEventListener('pointerup', onPointerUp);
		overlay.addEventListener('wheel', onWheel, { passive: false });
		overlay.addEventListener('contextmenu', onContextMenu);
		document.addEventListener('keydown', onKeyDown, true);
	}
	function detachInput() {
		overlay.removeEventListener('pointermove', onPointerMove);
		overlay.removeEventListener('pointerdown', onPointerDown);
		overlay.removeEventListener('pointerup', onPointerUp);
		overlay.removeEventListener('wheel', onWheel);
		overlay.removeEventListener('contextmenu', onContextMenu);
		document.removeEventListener('keydown', onKeyDown, true);
	}

	// ── toolbar wiring ──────────────────────────────────────────────────────────
	toggle.addEventListener('click', () => { driving ? stop(true) : start(); });
	backBtn.addEventListener('click', () => { if (driving) { enqueue({ t: 'back' }); flush(); } });
	reloadBtn.addEventListener('click', () => { if (driving) { enqueue({ t: 'reload' }); flush(); } });
	urlForm.addEventListener('submit', (e) => {
		e.preventDefault();
		if (!driving) return;
		let url = (urlInput.value || '').trim();
		if (!url) return;
		if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
		enqueue({ t: 'nav', url });
		flush();
		urlInput.blur();
		overlay.focus();
	});

	// Release the wheel if the tab is closed/hidden so a lease never dangles.
	const onHide = () => { if (driving && document.visibilityState === 'hidden') stop(true); };
	document.addEventListener('visibilitychange', onHide);
	window.addEventListener('pagehide', () => { if (driving) stop(true); });

	return {
		destroy() {
			stop(true);
			document.removeEventListener('visibilitychange', onHide);
			bar.remove();
			overlay.remove();
		},
	};
}
