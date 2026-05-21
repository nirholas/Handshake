/* home-saas.js — wires the unicorn-SaaS prologue stack on /home.
 *
 * Owns:
 *  • announcement bar dismiss (localStorage)
 *  • live metrics counter (fetches /api/home-stats; hides if unavailable)
 *  • audience tabs (Creators / Developers / DAOs / Enterprises)
 *  • code-snippet copy-to-clipboard
 *  • reveal-on-scroll via IntersectionObserver
 *
 * No build step. Loaded with `defer`. Idempotent across re-imports.
 */

(() => {
	if (window.__threeWsHomeSaasInited) return;
	window.__threeWsHomeSaasInited = true;

	const ready = (fn) => {
		if (document.readyState !== 'loading') fn();
		else document.addEventListener('DOMContentLoaded', fn, { once: true });
	};

	ready(() => {
		initBar();
		initReveal();
		initMetrics();
		initTabs();
		initCopy();
	});

	// ── 1. Announcement bar dismiss ────────────────────────────────────────
	function initBar() {
		const bar = document.querySelector('[data-saas-bar]');
		if (!bar) return;
		const KEY = 'three-ws-saas-bar-dismissed-v1';
		try {
			if (localStorage.getItem(KEY)) {
				bar.hidden = true;
				return;
			}
		} catch (_) {
			/* localStorage unavailable in private mode — show bar */
		}
		const close = bar.querySelector('[data-saas-bar-close]');
		if (close) {
			close.addEventListener('click', () => {
				bar.hidden = true;
				try {
					localStorage.setItem(KEY, '1');
				} catch (_) {
					/* ignore */
				}
			});
		}
	}

	// ── 2. Reveal-on-scroll ───────────────────────────────────────────────
	function initReveal() {
		const targets = document.querySelectorAll('.h-saas-reveal');
		if (!targets.length) return;
		if (!('IntersectionObserver' in window)) {
			targets.forEach((el) => el.classList.add('is-in'));
			return;
		}
		const io = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (entry.isIntersecting) {
						entry.target.classList.add('is-in');
						io.unobserve(entry.target);
					}
				}
			},
			{ rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
		);
		targets.forEach((el) => io.observe(el));
	}

	// ── 3. Live metrics (real /api/home-stats) ───────────────────────────
	async function initMetrics() {
		const root = document.querySelector('[data-saas-metrics]');
		if (!root) return;

		let stats;
		try {
			const res = await fetch('/api/home-stats', {
				credentials: 'omit',
				headers: { accept: 'application/json' },
			});
			if (!res.ok) throw new Error('http_' + res.status);
			stats = await res.json();
		} catch (err) {
			console.debug('[home-saas] metrics unavailable', err?.message || err);
			root.hidden = true;
			return;
		}

		if (!stats || stats.available === false) {
			root.hidden = true;
			return;
		}

		const fields = root.querySelectorAll('[data-saas-metric]');
		let anyShown = false;
		fields.forEach((el) => {
			const key = el.dataset.saasMetric;
			const val = stats[key];
			if (typeof val !== 'number' || val < 0) {
				const item = el.closest('.h-saas-metric');
				if (item) item.hidden = true;
				return;
			}
			anyShown = true;
			animateCount(el, val);
		});

		if (!anyShown) root.hidden = true;
	}

	function animateCount(el, target) {
		const duration = 1100;
		const start = performance.now();
		const from = 0;
		const ease = (t) => 1 - Math.pow(1 - t, 3);
		function tick(now) {
			const t = Math.min(1, (now - start) / duration);
			const v = Math.floor(from + (target - from) * ease(t));
			el.textContent = format(v);
			if (t < 1) requestAnimationFrame(tick);
			else el.textContent = format(target);
		}
		requestAnimationFrame(tick);
	}

	function format(n) {
		if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
		if (n >= 10_000) return (n / 1_000).toFixed(0) + 'k';
		if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
		return n.toLocaleString();
	}

	// ── 4. Audience tabs ─────────────────────────────────────────────────
	function initTabs() {
		const wrap = document.querySelector('[data-saas-tabs]');
		if (!wrap) return;
		const tabs = Array.from(wrap.querySelectorAll('[role="tab"]'));
		const panel = document.querySelector('[data-saas-tabpanel]');
		if (!tabs.length || !panel) return;

		const select = (idx) => {
			tabs.forEach((t, i) => {
				const on = i === idx;
				t.setAttribute('aria-selected', on ? 'true' : 'false');
				t.tabIndex = on ? 0 : -1;
			});
			const active = tabs[idx];
			panel.innerHTML = active.dataset.saasPanel || '';
		};

		tabs.forEach((tab, i) => {
			tab.addEventListener('click', () => select(i));
			tab.addEventListener('keydown', (e) => {
				if (e.key === 'ArrowRight') {
					e.preventDefault();
					select((i + 1) % tabs.length);
					tabs[(i + 1) % tabs.length].focus();
				} else if (e.key === 'ArrowLeft') {
					e.preventDefault();
					const prev = (i - 1 + tabs.length) % tabs.length;
					select(prev);
					tabs[prev].focus();
				}
			});
		});

		const initial = tabs.findIndex((t) => t.getAttribute('aria-selected') === 'true');
		select(initial < 0 ? 0 : initial);
	}

	// ── 5. Copy code snippet ─────────────────────────────────────────────
	function initCopy() {
		const btns = document.querySelectorAll('[data-saas-copy]');
		btns.forEach((btn) => {
			btn.addEventListener('click', async () => {
				const targetSel = btn.dataset.saasCopy;
				const target = targetSel ? document.querySelector(targetSel) : null;
				if (!target) return;
				const text = target.innerText.trim();
				try {
					await navigator.clipboard.writeText(text);
					btn.dataset.copied = 'true';
					const orig = btn.textContent;
					btn.textContent = 'Copied';
					setTimeout(() => {
						btn.removeAttribute('data-copied');
						btn.textContent = orig;
					}, 1600);
				} catch (err) {
					console.warn('[home-saas] clipboard failed', err);
					btn.textContent = 'Press ⌘C';
					setTimeout(() => {
						btn.textContent = 'Copy';
					}, 1600);
				}
			});
		});
	}
})();
