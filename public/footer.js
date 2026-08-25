// Loads the canonical site footer into any page that contains
// <div id="footer-container"></div>. Mirrors /nav.js: ensures footer.css
// is on the page, fetches /footer.html, injects it, and wires the newsletter
// form. The decorative 3D footer bot is deferred until the footer is within a
// screenful of the viewport (see whenNearViewport below) so its renderer never
// competes with the page the visitor actually came for.
(function () {
	// Resolves once the stylesheet has loaded so the footer markup is never
	// injected unstyled (flash-of-unstyled-content on hard refresh). A
	// JS-inserted <link> loads asynchronously without blocking paint, so the
	// injected innerHTML must wait on its load event.
	function ensureStylesheet(href) {
		let link = document.querySelector(`link[href="${href}"]`);
		if (link) {
			if (link.sheet) return Promise.resolve();
			return new Promise((resolve) => {
				link.addEventListener('load', resolve, { once: true });
				link.addEventListener('error', resolve, { once: true });
			});
		}
		return new Promise((resolve) => {
			link = document.createElement('link');
			link.rel = 'stylesheet';
			link.href = href;
			link.addEventListener('load', resolve, { once: true });
			link.addEventListener('error', resolve, { once: true });
			document.head.appendChild(link);
		});
	}

	// Resolves once the script has loaded so callers can order dependent scripts
	// behind it. A tag that is already in the document resolves immediately:
	// parser-inserted classic scripts have executed by the time footer.js runs
	// (they block parsing, and footer.js initializes at DOMContentLoaded or
	// later), and the only dynamic inserter of these URLs is this file itself.
	function ensureScript({ src, type, attr }) {
		if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
		return new Promise((resolve) => {
			const s = document.createElement('script');
			s.src = src;
			if (type) s.type = type;
			if (attr) s.setAttribute(attr, '');
			s.addEventListener('load', resolve, { once: true });
			s.addEventListener('error', resolve, { once: true });
			document.head.appendChild(s);
		});
	}

	// Runs `fn` the first time `el` comes within a screenful of the viewport, and
	// at most once. The footer bot is a decoration at the very bottom of every
	// page: booting it at DOMContentLoaded put a whole second 3D engine on the
	// critical path for something nobody had scrolled to yet (measured on
	// production 2026-08-15: 19.7 s of main-thread bootup for /footer-bot.js on
	// /forge, and 253 KiB plus 0.8 s for the model-viewer branch on /docs).
	// Anything without IntersectionObserver loads it on the first scroll instead,
	// so the bot still appears on the way down rather than never.
	function whenNearViewport(el, fn) {
		let done = false;
		const run = () => {
			if (done) return;
			done = true;
			fn();
		};
		if (typeof IntersectionObserver !== 'function') {
			window.addEventListener('scroll', run, { once: true, passive: true });
			return;
		}
		const io = new IntersectionObserver(
			(entries) => {
				if (!entries.some((e) => e.isIntersecting)) return;
				io.disconnect();
				run();
			},
			// Start the load a screenful early so the bot is rendered by the time
			// the footer is actually on screen, not after a visible pop-in.
			{ rootMargin: '600px 0px' }
		);
		io.observe(el);
	}

	function bootFooterBot(container) {
		if (document.querySelector('meta[name="has-three-bundle"]')) {
			// This page already has a Vite-bundled Three.js, so load the canvas
			// renderer that shares that instance, avoiding a duplicate load.
			ensureScript({ src: '/footer-bot.js', type: 'module' });
			return;
		}
		// Plain HTML page (login, register, etc.): fall back to model-viewer.
		// robotexpressive.glb ships EXT_meshopt_compression, which stock
		// model-viewer cannot decode: without the meshopt shim it throws
		// "THREE.GLTFLoader: setMeshoptDecoder must be called before
		// loading compressed files" the moment the footer scrolls into
		// view. The shim must EXECUTE before model-viewer defines the
		// element (it intercepts customElements.define), so chain the
		// model-viewer load and the element injection behind it.
		ensureScript({ src: '/model-viewer-meshopt.js' }).then(() => {
			ensureScript({
				src: 'https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js',
				type: 'module',
			});
			// model-viewer needs a <model-viewer> element; swap the canvas for one.
			// No `camera-controls`: it is a boolean attribute, so writing "false"
			// turned controls ON and let a drag anywhere over the footer mascot
			// orbit it instead of scrolling the page.
			const avatar = container.querySelector('.h-footer-avatar');
			if (avatar) {
				avatar.innerHTML = `<model-viewer
					src="/animations/robotexpressive.glb"
					auto-rotate auto-rotate-delay="0" rotation-per-second="20deg"
					interaction-prompt="none"
					shadow-intensity="0" exposure="0.7" environment-image="neutral"
					camera-orbit="0deg 80deg 9m" field-of-view="35deg" loading="lazy"
				></model-viewer>`;
			}
		});
	}

	function init() {
		const container = document.getElementById('footer-container');
		if (!container) return;

		Promise.all([fetch('/footer.html').then((r) => r.text()), ensureStylesheet('/footer.css')])
			.then(([html]) => {
				container.innerHTML = html;

				const canvas = container.querySelector('#footer-bot-canvas');
				if (canvas) {
					whenNearViewport(canvas.parentElement || canvas, () => bootFooterBot(container));
				}

				ensureScript({ src: '/footer-newsletter.js', attr: 'defer' });
				// If footer-newsletter.js was already loaded earlier, re-run its
				// wiring against the just-injected form by dispatching a custom
				// event the script listens for, or re-import as a fallback.
				if (window.__threewsFooterNewsletterReady) {
					window.__threewsFooterNewsletterReady();
				}
			})
			.catch(() => {});
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
