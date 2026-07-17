// three.ws first-creation celebration — closes the reward loop at the one moment
// that matters: the first time a visitor forges a 3D model on this device.
//
// The forge machinery mints a "first creation" server-side badge only for
// signed-in users (api/_lib/streaks.js), but the large majority of generations
// are anonymous — so that milestone passed with a silent 3-second "Saved" chip.
// This layer gives every first-time creator, signed in or not, a real moment:
// a confetti burst and a glass card acknowledging what they just made.
//
// Self-mounting + idempotent (loaded by nav.js on every page, like the glossary
// and discovery layers). It listens for the universal `tws:feature-done` signal
// that BOTH the full Forge page (src/forge.js) and the home inline Forge
// (src/home-forge.js) emit on a fresh generation, so it covers every surface
// without touching those files. Fires at most once per device.
//
// Opt out per page with <html data-celebrate="off">. Honours reduced-motion:
// no confetti, the card still appears (a fade, no slide).

(function () {
	'use strict';

	if (window.__twsForgeCelebrate) return;
	window.__twsForgeCelebrate = true;
	if (typeof document === 'undefined') return;
	if (document.documentElement.getAttribute('data-celebrate') === 'off') return;

	var CELEBRATED_KEY = 'tws:first-forge-celebrated';
	var HOME_HISTORY_KEY = 'forge:home:history';
	var AUTO_DISMISS_MS = 7000;

	function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
	function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }

	// True if this device has already forged before — so we never congratulate a
	// returning creator. We check our own once-flag plus the home Forge's saved
	// history list (a veteran who used the inline Forge has entries there).
	function hasForgedBefore() {
		if (lsGet(CELEBRATED_KEY)) return true;
		try {
			var raw = localStorage.getItem(HOME_HISTORY_KEY);
			if (raw) {
				var arr = JSON.parse(raw);
				if (Array.isArray(arr) && arr.length > 0) return true;
			}
		} catch (e) { /* unreadable history — treat as first */ }
		return false;
	}

	var prefersReducedMotion = false;
	try {
		prefersReducedMotion = window.matchMedia &&
			window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	} catch (e) { /* no matchMedia — assume motion ok */ }

	var firedThisSession = false;

	document.addEventListener('tws:feature-done', function (e) {
		var detail = e && e.detail;
		if (!detail || detail.feature !== 'forge') return;
		if (firedThisSession) return;
		if (hasForgedBefore()) return;
		firedThisSession = true;
		lsSet(CELEBRATED_KEY, '1');
		// Let the result render/settle first so the moment lands on the model, not
		// mid-transition.
		setTimeout(celebrate, 450);
	});

	function ensureStyles() {
		if (document.getElementById('twfc-styles')) return;
		var css = [
			'#twfc-confetti{position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9997}',
			'.twfc-card{position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(16px);',
			'z-index:9998;display:flex;align-items:center;gap:14px;max-width:min(440px,calc(100vw - 32px));',
			'padding:14px 16px;border-radius:16px;opacity:0;',
			'background:var(--surface-glass,rgba(20,20,22,0.72));backdrop-filter:blur(18px) saturate(1.4);',
			'-webkit-backdrop-filter:blur(18px) saturate(1.4);',
			'border:1px solid var(--border-strong,rgba(255,255,255,0.14));',
			'box-shadow:0 18px 50px rgba(0,0,0,0.5),0 0 0 1px rgba(255,255,255,0.04) inset,',
			'0 0 32px -6px color-mix(in srgb,var(--accent,#fff) 45%,transparent);',
			'transition:opacity .5s cubic-bezier(.2,.7,.2,1),transform .5s cubic-bezier(.2,.7,.2,1)}',
			'.twfc-card.twfc-in{opacity:1;transform:translateX(-50%) translateY(0)}',
			'.twfc-spark{flex:none;width:40px;height:40px;border-radius:12px;display:grid;place-items:center;',
			'font-size:20px;color:var(--bg-0,#0a0a0a);',
			'background:linear-gradient(135deg,var(--accent,#fff),color-mix(in srgb,var(--accent,#fff) 60%,#8b5cf6));',
			'box-shadow:0 4px 16px -2px color-mix(in srgb,var(--accent,#fff) 55%,transparent)}',
			'.twfc-body{display:flex;flex-direction:column;gap:2px;min-width:0}',
			'.twfc-title{font-family:var(--font-display,"Space Grotesk",system-ui,sans-serif);',
			'font-weight:650;font-size:15px;letter-spacing:-.01em;color:var(--text,#fff);line-height:1.25}',
			'.twfc-sub{font-size:12.5px;color:var(--text-3,rgba(255,255,255,0.62));line-height:1.35}',
			'.twfc-close{flex:none;margin-left:2px;width:26px;height:26px;border-radius:8px;border:0;cursor:pointer;',
			'background:transparent;color:var(--text-3,rgba(255,255,255,0.55));font-size:18px;line-height:1;',
			'display:grid;place-items:center;transition:background .15s,color .15s}',
			'.twfc-close:hover{background:rgba(255,255,255,0.08);color:var(--text,#fff)}',
			'.twfc-close:focus-visible{outline:2px solid var(--accent,#fff);outline-offset:2px}',
			'@media (prefers-reduced-motion: reduce){',
			'.twfc-card{transition:opacity .3s ease;transform:translateX(-50%)}',
			'.twfc-card.twfc-in{transform:translateX(-50%)}}',
		].join('');
		var style = document.createElement('style');
		style.id = 'twfc-styles';
		style.textContent = css;
		document.head.appendChild(style);
	}

	function accentColor() {
		try {
			var c = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
			if (c) return c;
		} catch (e) { /* fall through */ }
		return '#ffffff';
	}

	function celebrate() {
		ensureStyles();
		if (!prefersReducedMotion) burstConfetti();
		showCard();
	}

	function showCard() {
		var card = document.createElement('div');
		card.className = 'twfc-card';
		card.setAttribute('role', 'status');
		card.setAttribute('aria-live', 'polite');

		var spark = document.createElement('div');
		spark.className = 'twfc-spark';
		spark.setAttribute('aria-hidden', 'true');
		spark.textContent = '✦'; // ✦

		var body = document.createElement('div');
		body.className = 'twfc-body';
		var title = document.createElement('strong');
		title.className = 'twfc-title';
		title.textContent = 'Your first 3D creation';
		var sub = document.createElement('span');
		sub.className = 'twfc-sub';
		sub.textContent = 'Saved on this device. Spin it, download it, or forge another.';
		body.appendChild(title);
		body.appendChild(sub);

		var close = document.createElement('button');
		close.className = 'twfc-close';
		close.type = 'button';
		close.setAttribute('aria-label', 'Dismiss');
		close.textContent = '×'; // ×

		card.appendChild(spark);
		card.appendChild(body);
		card.appendChild(close);
		document.body.appendChild(card);

		// Next frame → transition in.
		requestAnimationFrame(function () {
			requestAnimationFrame(function () { card.classList.add('twfc-in'); });
		});

		var dismissed = false;
		var timer = null;
		function dismiss() {
			if (dismissed) return;
			dismissed = true;
			if (timer) clearTimeout(timer);
			document.removeEventListener('keydown', onKey);
			card.classList.remove('twfc-in');
			setTimeout(function () { if (card.parentNode) card.parentNode.removeChild(card); }, 520);
		}
		function onKey(ev) { if (ev.key === 'Escape') dismiss(); }

		close.addEventListener('click', dismiss);
		document.addEventListener('keydown', onKey);
		timer = setTimeout(dismiss, AUTO_DISMISS_MS);
	}

	// Self-contained canvas confetti — no dependency, no network. A single short
	// burst from the lower third, gravity + drag + fade, cleaned up when spent.
	function burstConfetti() {
		var accent = accentColor();
		var colors = [accent, '#8b5cf6', '#22d3ee', '#ffffff'];
		var canvas = document.createElement('canvas');
		canvas.id = 'twfc-confetti';
		canvas.setAttribute('aria-hidden', 'true');
		var dpr = Math.min(window.devicePixelRatio || 1, 2);
		function size() {
			canvas.width = Math.floor(window.innerWidth * dpr);
			canvas.height = Math.floor(window.innerHeight * dpr);
		}
		size();
		document.body.appendChild(canvas);
		var ctx = canvas.getContext('2d');
		if (!ctx) { if (canvas.parentNode) canvas.parentNode.removeChild(canvas); return; }

		var W = function () { return canvas.width; };
		var H = function () { return canvas.height; };
		var cx = W() / 2;
		var originY = H() * 0.72;
		var count = 90;
		var parts = [];
		for (var i = 0; i < count; i++) {
			var angle = -Math.PI / 2 + (Math.random() - 0.5) * 1.9;
			var speed = (7 + Math.random() * 9) * dpr;
			parts.push({
				x: cx + (Math.random() - 0.5) * 120 * dpr,
				y: originY,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed,
				w: (5 + Math.random() * 6) * dpr,
				h: (7 + Math.random() * 8) * dpr,
				rot: Math.random() * Math.PI,
				vr: (Math.random() - 0.5) * 0.4,
				color: colors[(Math.random() * colors.length) | 0],
				life: 0,
				ttl: 90 + Math.random() * 40,
			});
		}
		var gravity = 0.32 * dpr;
		var drag = 0.985;
		var raf = null;
		function frame() {
			ctx.clearRect(0, 0, W(), H());
			var alive = 0;
			for (var j = 0; j < parts.length; j++) {
				var p = parts[j];
				if (p.life >= p.ttl) continue;
				alive++;
				p.life++;
				p.vx *= drag;
				p.vy = p.vy * drag + gravity;
				p.x += p.vx;
				p.y += p.vy;
				p.rot += p.vr;
				var fade = 1 - p.life / p.ttl;
				ctx.save();
				ctx.globalAlpha = Math.max(0, fade);
				ctx.translate(p.x, p.y);
				ctx.rotate(p.rot);
				ctx.fillStyle = p.color;
				ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
				ctx.restore();
			}
			if (alive > 0) {
				raf = requestAnimationFrame(frame);
			} else {
				cancelAnimationFrame(raf);
				if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
			}
		}
		raf = requestAnimationFrame(frame);
	}
})();
