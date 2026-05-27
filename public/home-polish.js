/* home-polish.js — enhances home.html with:
 *  - right-side chapter rail with active-section tracking
 *  - "Copy" button for the developer code snippet
 *  - cursor-tracked radial glow on bento cards
 *
 * Purely additive. Safe to remove without breaking existing functionality.
 */

(function () {
	if (typeof document === 'undefined') return;

	var ready = function (fn) {
		if (document.readyState !== 'loading') fn();
		else document.addEventListener('DOMContentLoaded', fn);
	};

	ready(function () {
		var main = document.querySelector('main.home-parallax');
		if (!main) return;

		mountChapterRail(main);
		mountDevCopyButton();
		mountBentoGlow();
	});

	/* ── Chapter rail with IntersectionObserver active-state ─────────────── */

	function mountChapterRail(main) {
		var chapters = [
			{ id: 'h-hero-act', label: 'Intro', selector: '.h-hero-act' },
			{ id: 'h-traction', label: 'Traction', selector: '.h-traction' },
			{ id: 'h-pillars', label: 'Pillars', selector: '.h-pillars' },
			{ id: 'h-journey', label: 'How it works', selector: '.h-journey' },
			{ id: 'pick-animate', label: 'Animate', selector: '#pick-animate' },
			{ id: 'deploy-act', label: 'Deploy', selector: '#deploy-act' },
			{ id: 'h-bento-section', label: 'Features', selector: '.h-bento-section' },
			{ id: 'h-dev-section', label: 'Developers', selector: '.h-dev-section' },
			{ id: 'h-cta-section', label: 'Start', selector: '.h-cta-section' },
		];

		var resolved = chapters
			.map(function (c) {
				var el = main.querySelector(c.selector);
				return el ? Object.assign({}, c, { el: el }) : null;
			})
			.filter(Boolean);

		if (resolved.length < 3) return;

		var rail = document.createElement('nav');
		rail.className = 'h-chapter-rail';
		rail.setAttribute('aria-label', 'Page sections');

		var dots = resolved.map(function (c) {
			var dot = document.createElement('a');
			dot.className = 'h-chapter-dot';
			dot.href = '#' + (c.el.id || c.id);
			dot.setAttribute('aria-label', c.label);
			dot.dataset.target = c.id;

			var label = document.createElement('span');
			label.className = 'h-chapter-label';
			label.textContent = c.label;
			dot.appendChild(label);

			dot.addEventListener('click', function (ev) {
				ev.preventDefault();
				c.el.scrollIntoView({ behavior: 'smooth', block: 'start' });
			});

			rail.appendChild(dot);
			return { dot: dot, el: c.el, id: c.id };
		});

		document.body.appendChild(rail);

		// reveal once first section is visible
		window.requestAnimationFrame(function () {
			rail.classList.add('is-visible');
		});

		// Active-state via IntersectionObserver
		var visible = new Map();
		var io = new IntersectionObserver(
			function (entries) {
				entries.forEach(function (entry) {
					if (entry.isIntersecting) visible.set(entry.target, entry.intersectionRatio);
					else visible.delete(entry.target);
				});

				if (visible.size === 0) return;

				var bestEl = null;
				var bestRatio = -1;
				visible.forEach(function (ratio, el) {
					if (ratio > bestRatio) {
						bestRatio = ratio;
						bestEl = el;
					}
				});

				dots.forEach(function (d) {
					if (d.el === bestEl) d.dot.classList.add('is-active');
					else d.dot.classList.remove('is-active');
				});
			},
			{ threshold: [0.25, 0.5, 0.75] },
		);

		dots.forEach(function (d) {
			io.observe(d.el);
		});
	}

	/* ── Copy button on developer code snippet ───────────────────────────── */

	function mountDevCopyButton() {
		var container = document.querySelector('.h-dev-code');
		if (!container) return;
		var pre = container.querySelector('pre');
		if (!pre) return;

		var btn = document.createElement('button');
		btn.type = 'button';
		btn.className = 'h-dev-copy';
		btn.setAttribute('aria-label', 'Copy code to clipboard');
		btn.innerHTML =
			'<svg viewBox="0 0 16 16" aria-hidden="true">' +
			'<path fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" ' +
			'd="M5.5 4.5h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-6a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z M3.5 11V4a1 1 0 0 1 1-1h7" />' +
			'</svg><span>Copy</span>';
		container.appendChild(btn);

		btn.addEventListener('click', function () {
			var text = pre.innerText.trim();
			var done = function () {
				btn.classList.add('is-copied');
				btn.querySelector('span').textContent = 'Copied';
				setTimeout(function () {
					btn.classList.remove('is-copied');
					btn.querySelector('span').textContent = 'Copy';
				}, 1600);
			};

			if (navigator.clipboard && navigator.clipboard.writeText) {
				navigator.clipboard.writeText(text).then(done, function () {
					fallbackCopy(text, done);
				});
			} else {
				fallbackCopy(text, done);
			}
		});
	}

	function fallbackCopy(text, done) {
		var ta = document.createElement('textarea');
		ta.value = text;
		ta.setAttribute('readonly', '');
		ta.style.position = 'fixed';
		ta.style.opacity = '0';
		document.body.appendChild(ta);
		ta.select();
		try {
			document.execCommand('copy');
			done();
		} catch (_) {
			/* ignore */
		}
		document.body.removeChild(ta);
	}

	/* ── Cursor-tracked radial glow on bento cards ───────────────────────── */

	function mountBentoGlow() {
		var cards = document.querySelectorAll('.h-bento-card');
		if (!cards.length) return;

		cards.forEach(function (card) {
			card.addEventListener('pointermove', function (ev) {
				var rect = card.getBoundingClientRect();
				var x = ((ev.clientX - rect.left) / rect.width) * 100;
				var y = ((ev.clientY - rect.top) / rect.height) * 100;
				card.style.setProperty('--bx', x + '%');
				card.style.setProperty('--by', y + '%');
			});
		});
	}
})();
