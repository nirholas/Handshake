// The card presenter: a message delivered without a GPU.
//
// The avatar presenter is the point of this SDK, but it needs WebGL, a rig, and
// a corner to stand in. None of those are guaranteed: a locked-down browser, a
// machine with the GPU blocklisted, an iframe, a page that already owns the
// corner, or simply an integrator who wants the delivery discipline without the
// 3D. This presenter is the floor under all of that. It is dependency-free,
// self-styling, theme-aware, keyboard-operable, and announced to screen
// readers, and it is what the runtime falls back to so a message is never lost
// to a missing capability.

const STYLE_ID = 'three-herald-card-style';
const ROOT_ID = 'three-herald-cards';

const TONE_ACCENT = {
	neutral: '#7aa2ff',
	alert: '#ffb454',
	celebrate: '#5ddc8f',
	error: '#ff6b6b',
};

function ensureStyles(doc) {
	if (doc.getElementById(STYLE_ID)) return;
	const style = doc.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
#${ROOT_ID}{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;align-items:flex-end;pointer-events:none;max-width:min(360px,calc(100vw - 32px))}
.three-herald-card{pointer-events:auto;box-sizing:border-box;width:100%;display:flex;gap:12px;padding:14px 14px 12px;border-radius:14px;background:var(--three-herald-bg,rgba(18,20,28,.96));color:var(--three-herald-ink,#f2f4f8);border:1px solid var(--three-herald-stroke,rgba(255,255,255,.12));box-shadow:0 18px 44px rgba(0,0,0,.42);font:500 13.5px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;opacity:0;transform:translateY(10px) scale(.98);transition:opacity .28s ease,transform .28s cubic-bezier(.34,1.56,.64,1);position:relative;overflow:hidden}
.three-herald-card.is-in{opacity:1;transform:translateY(0) scale(1)}
.three-herald-card.is-out{opacity:0;transform:translateY(6px) scale(.99)}
.three-herald-card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--three-herald-accent,#7aa2ff)}
.three-herald-face{flex:0 0 auto;width:38px;height:38px;border-radius:11px;overflow:hidden;background:linear-gradient(150deg,var(--three-herald-accent,#7aa2ff),rgba(255,255,255,.06));display:grid;place-items:center;font-size:18px;line-height:1}
.three-herald-face img{width:100%;height:100%;object-fit:cover;display:block}
.three-herald-body{min-width:0;flex:1 1 auto}
.three-herald-from{font-size:11.5px;font-weight:700;letter-spacing:.02em;text-transform:uppercase;color:var(--three-herald-accent,#7aa2ff);margin-bottom:2px}
.three-herald-text{overflow-wrap:anywhere}
.three-herald-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.three-herald-action{appearance:none;font:600 12px/1 system-ui,-apple-system,'Segoe UI',sans-serif;padding:7px 11px;border-radius:999px;border:1px solid var(--three-herald-stroke,rgba(255,255,255,.16));background:rgba(255,255,255,.06);color:inherit;cursor:pointer;text-decoration:none;transition:background .15s ease,border-color .15s ease,transform .12s ease}
.three-herald-action:hover{background:rgba(122,162,255,.22);border-color:var(--three-herald-accent,#7aa2ff)}
.three-herald-action:active{transform:translateY(1px)}
.three-herald-action:focus-visible{outline:2px solid var(--three-herald-accent,#7aa2ff);outline-offset:2px}
.three-herald-close{position:absolute;top:6px;right:8px;width:22px;height:22px;border:none;border-radius:50%;background:transparent;color:inherit;opacity:.45;cursor:pointer;font-size:15px;line-height:1;display:grid;place-items:center;padding:0}
.three-herald-close:hover{opacity:1;background:rgba(255,255,255,.08)}
.three-herald-close:focus-visible{opacity:1;outline:2px solid var(--three-herald-accent,#7aa2ff);outline-offset:1px}
.three-herald-life{position:absolute;left:0;bottom:0;height:2px;width:100%;transform-origin:left center;background:var(--three-herald-accent,#7aa2ff);opacity:.5}
@media (prefers-color-scheme:light){.three-herald-card{--three-herald-bg:rgba(255,255,255,.98);--three-herald-ink:#12141c;--three-herald-stroke:rgba(0,0,0,.12);box-shadow:0 18px 44px rgba(20,24,40,.18)}.three-herald-action{background:rgba(0,0,0,.04)}}
@media (max-width:520px){#${ROOT_ID}{left:12px;right:12px;bottom:12px;max-width:none}}
@media (prefers-reduced-motion:reduce){.three-herald-card{transition:opacity .01s linear}.three-herald-life{display:none}}
`;
	doc.head.appendChild(style);
}

function ensureRoot(doc) {
	let root = doc.getElementById(ROOT_ID);
	if (root) return root;
	root = doc.createElement('div');
	root.id = ROOT_ID;
	// The stack is a live region so a delivery is announced by a screen reader
	// the moment it lands, exactly like it is spoken to everyone else.
	root.setAttribute('role', 'status');
	root.setAttribute('aria-live', 'polite');
	root.setAttribute('aria-atomic', 'false');
	doc.body.appendChild(root);
	return root;
}

/**
 * Build the DOM-card presenter.
 * @param {{document?: Document, face?: string|null}} [opts] `face` is an image
 *   URL or a single emoji shown as the sender's face.
 */
export function createCardPresenter({ document: doc = globalThis.document, face = '📣' } = {}) {
	let current = null;

	async function ready() {
		return !!(doc && doc.body);
	}

	/**
	 * @param {import('../rules.js').Message} message
	 * @param {{dwellMs:number, actions?:Array<{label:string,href?:string,onClick?:Function}>}} opts
	 * @returns {Promise<boolean>} resolves when the card has left the screen
	 */
	function present(message, { dwellMs = 6000, actions = [] } = {}) {
		if (!doc?.body) return Promise.resolve(false);
		ensureStyles(doc);
		const root = ensureRoot(doc);
		dismissCurrent();

		const card = doc.createElement('div');
		card.className = 'three-herald-card';
		card.style.setProperty(
			'--three-herald-accent',
			TONE_ACCENT[message.tone] || TONE_ACCENT.neutral,
		);

		const faceEl = doc.createElement('div');
		faceEl.className = 'three-herald-face';
		faceEl.setAttribute('aria-hidden', 'true');
		const faceValue = message.face || face;
		if (faceValue && /^(https?:|\/|data:)/.test(String(faceValue))) {
			const img = doc.createElement('img');
			img.src = String(faceValue);
			img.alt = '';
			faceEl.appendChild(img);
		} else if (faceValue) {
			faceEl.textContent = String(faceValue);
		}
		card.appendChild(faceEl);

		const body = doc.createElement('div');
		body.className = 'three-herald-body';
		if (message.from) {
			const from = doc.createElement('div');
			from.className = 'three-herald-from';
			from.textContent = message.from;
			body.appendChild(from);
		}
		const text = doc.createElement('div');
		text.className = 'three-herald-text';
		text.textContent = message.text;
		body.appendChild(text);

		const usable = (actions || []).filter((a) => a && a.label).slice(0, 3);
		if (usable.length) {
			const row = doc.createElement('div');
			row.className = 'three-herald-actions';
			for (const action of usable) {
				const el = doc.createElement(action.href ? 'a' : 'button');
				el.className = 'three-herald-action';
				el.textContent = action.label;
				if (action.href) el.href = action.href;
				else el.type = 'button';
				if (action.title) {
					el.title = action.title;
					el.setAttribute('aria-label', action.title);
				}
				el.addEventListener('click', () => {
					try {
						action.onClick?.();
					} finally {
						if (!action.href) finish();
					}
				});
				row.appendChild(el);
			}
			body.appendChild(row);
		}
		card.appendChild(body);

		const close = doc.createElement('button');
		close.type = 'button';
		close.className = 'three-herald-close';
		close.setAttribute('aria-label', 'Dismiss');
		close.textContent = '×';
		close.addEventListener('click', () => finish());
		card.appendChild(close);

		const life = doc.createElement('div');
		life.className = 'three-herald-life';
		card.appendChild(life);

		root.appendChild(card);
		// Force layout so the entry transition runs from the pre-state.
		void card.offsetWidth;
		card.classList.add('is-in');
		life.animate?.(
			[{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
			{ duration: dwellMs, easing: 'linear', fill: 'forwards' },
		);

		let settle;
		const done = new Promise((resolve) => {
			settle = resolve;
		});
		const timer = setTimeout(() => finish(), dwellMs);
		const onKey = (e) => {
			if (e.key === 'Escape') finish();
		};
		doc.addEventListener('keydown', onKey);

		function finish() {
			if (!current || current.card !== card) return;
			clearTimeout(timer);
			doc.removeEventListener('keydown', onKey);
			card.classList.add('is-out');
			current = null;
			setTimeout(() => card.remove(), 300);
			settle(true);
		}

		current = { card, finish };
		return done;
	}

	function dismissCurrent() {
		current?.finish?.();
	}

	function stop() {
		dismissCurrent();
		doc?.getElementById(ROOT_ID)?.remove();
	}

	return { name: 'card', ready, present, dismiss: dismissCurrent, stop };
}
