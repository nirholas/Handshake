/**
 * ui-juice — the shared game-feel library for three.ws.
 * ════════════════════════════════════════════════════════════════════════════
 * One vocabulary of interaction primitives, proven on /swarms, extracted so every
 * front-end surface adopts the same motion instead of reinventing it.
 *
 * Every primitive is:
 *  · token-driven — durations/easings come from public/tokens.css, never raw ms.
 *  · reduced-motion-safe — the global `prefers-reduced-motion` block zeroes the
 *    `--duration-*` tokens, so `reducedMotion()` reads the computed token and each
 *    primitive jumps straight to its correct final state with no animation.
 *  · real-value only — these are transition helpers over real numbers/series; they
 *    never fabricate inputs.
 *
 * See docs/ui-juice.md for the full reference and a runnable example of each export.
 */

// ── motion environment ───────────────────────────────────────────────────────

let _rootStyle = null;
function rootStyle() {
	if (typeof window === 'undefined' || typeof getComputedStyle !== 'function') return null;
	// Re-read each call is cheap and survives theme/token swaps; cache the element ref only.
	_rootStyle = getComputedStyle(document.documentElement);
	return _rootStyle;
}

/**
 * Resolve a `--duration-*` token to milliseconds from the live computed styles.
 * Returns the numeric ms (e.g. 220) or the fallback when the token is absent.
 * Under prefers-reduced-motion the global token override makes every duration 0.
 * @param {string} token e.g. '--duration-base'
 * @param {number} [fallback=220]
 * @returns {number} milliseconds
 */
export function durationMs(token = '--duration-base', fallback = 220) {
	const style = rootStyle();
	if (!style) return fallback;
	const raw = style.getPropertyValue(token).trim();
	if (!raw) return fallback;
	if (raw.endsWith('ms')) return parseFloat(raw) || 0;
	if (raw.endsWith('s')) return (parseFloat(raw) || 0) * 1000;
	const n = parseFloat(raw);
	return Number.isFinite(n) ? n : fallback;
}

/**
 * True when motion should be suppressed. Reads the computed `--duration-base`
 * token (zeroed by the global prefers-reduced-motion block) and also honours a
 * direct matchMedia check, so it's correct even before tokens.css loads.
 * @returns {boolean}
 */
export function reducedMotion() {
	if (durationMs('--duration-base', 220) === 0) return true;
	return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
		&& window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);
const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : 0);

// ── 1. countUp ────────────────────────────────────────────────────────────────

const countTimers = typeof WeakMap === 'function' ? new WeakMap() : null;

/**
 * Animate a number on an element between two REAL values, preserving the caller's
 * formatting (sign, units, %). Cancels any in-flight count-up on the same element.
 * Reduced motion → sets the final formatted value instantly.
 *
 * @param {HTMLElement} el target element (textContent is written)
 * @param {number} from start value
 * @param {number} to end value
 * @param {{format?:(n:number)=>string, duration?:number, ease?:(x:number)=>number, token?:string}} [opts]
 * @example countUp(el, 0, 1280, { format: (n) => `$${Math.round(n)}` })
 */
export function countUp(el, from, to, opts = {}) {
	if (!el) return;
	const format = opts.format || ((n) => String(Math.round(n)));
	const ease = opts.ease || easeOutCubic;
	if (countTimers) {
		const prev = countTimers.get(el);
		if (prev) { cancelAnimationFrame(prev); countTimers.delete(el); }
	}
	el.dataset.juiceVal = to == null ? '' : String(to);
	if (from == null || to == null || from === to || reducedMotion() || typeof requestAnimationFrame !== 'function') {
		el.textContent = format(to);
		return;
	}
	const dur = opts.duration || durationMs(opts.token || '--duration-slow', 420);
	if (dur <= 0) { el.textContent = format(to); return; }
	// Seed the start from the FIRST frame's own timestamp rather than performance.now().
	// requestAnimationFrame is not contractually on the same time origin as
	// performance.now() (polyfills and some embedders pass a Date-based clock), and a
	// `t` behind `start` drives p negative — easeOutCubic then overshoots wildly and the
	// element renders garbage like "-42797%" before settling. Clamping p as well keeps a
	// single frame from ever painting a value outside [from, to].
	let start = null;
	const delta = to - from;
	const step = (t) => {
		if (start === null) start = t;
		const p = Math.max(0, Math.min(1, (t - start) / dur));
		el.textContent = format(from + delta * ease(p));
		if (p < 1) { if (countTimers) countTimers.set(el, requestAnimationFrame(step)); }
		else { el.textContent = format(to); if (countTimers) countTimers.delete(el); }
	};
	if (countTimers) countTimers.set(el, requestAnimationFrame(step));
	else requestAnimationFrame(step);
}

/**
 * Count an element from its last `countUp`/`flashValue`-tracked value to a new one
 * and flash in the direction of change — the swarms `updateTile` pattern, generalized.
 * @param {HTMLElement} el
 * @param {number} to new real value
 * @param {(n:number)=>string} format
 * @param {{flash?:boolean}} [opts]
 */
export function updateValue(el, to, format, opts = {}) {
	if (!el) return;
	const prevRaw = el.dataset.juiceVal;
	const prev = prevRaw == null || prevRaw === '' ? null : Number(prevRaw);
	if (opts.flash !== false && prev != null && to != null && to !== prev) {
		flashValue(el, to > prev ? 'up' : 'down');
	}
	countUp(el, prev, to, { format });
}

// ── 2. flashValue ───────────────────────────────────────────────────────────────

/**
 * Directional tint pulse on an element, then settle. Generalizes the swarms `flash()`.
 * Adds a class the CSS animates; reduced motion → no-op (final state already correct).
 * @param {HTMLElement} el
 * @param {'up'|'down'|'neutral'} [direction='neutral']
 */
export function flashValue(el, direction = 'neutral') {
	if (!el || reducedMotion()) return;
	const cls = direction === 'up' ? 'juice-flash--up' : direction === 'down' ? 'juice-flash--down' : 'juice-flash--neutral';
	el.classList.remove('juice-flash--up', 'juice-flash--down', 'juice-flash--neutral');
	void el.offsetWidth; // restart the animation on back-to-back flashes
	el.classList.add(cls);
	el.addEventListener('animationend', () => el.classList.remove(cls), { once: true });
}

// ── 3. enterRow ─────────────────────────────────────────────────────────────────

/**
 * Slide+fade a freshly-inserted row/item in from the top (live logs/feeds).
 * Reduced motion → no class added, element is already in its final state.
 * @param {HTMLElement} el the just-inserted element
 */
export function enterRow(el) {
	if (!el || reducedMotion()) return;
	el.classList.add('juice-enter');
	el.addEventListener('animationend', () => el.classList.remove('juice-enter'), { once: true });
}

/**
 * Stagger-enter a list of freshly-inserted elements (grid/feed population).
 * Each item's delay is index × step, capped so long lists don't crawl in.
 * Reduced motion → no-op.
 * @param {Iterable<HTMLElement>} els
 * @param {{step?:number, max?:number}} [opts] step ms between items, max total delay
 */
export function enterStagger(els, opts = {}) {
	if (reducedMotion()) return;
	const step = opts.step || 28;
	const max = opts.max || 320;
	let i = 0;
	for (const el of els) {
		if (!el) { i++; continue; }
		const delay = Math.min(i * step, max);
		el.style.setProperty('--juice-enter-delay', `${delay}ms`);
		enterRow(el);
		i++;
	}
}

// ── 4. sparkline ────────────────────────────────────────────────────────────────

/**
 * Build the polyline path + bounds for a real numeric series. Pure; unit-tested.
 * @param {number[]} values
 * @param {number} width
 * @param {number} height
 * @param {number} [pad=2]
 * @returns {{points:string, last:{x:number,y:number}, min:number, max:number, net:number}}
 */
export function sparklinePath(values, width, height, pad = 2) {
	const v = (values || []).filter((n) => Number.isFinite(n));
	const w = width, h = height;
	if (v.length === 0) return { points: '', last: { x: 0, y: h / 2 }, min: 0, max: 0, net: 0 };
	const min = Math.min(...v);
	const max = Math.max(...v);
	const span = max - min || 1;
	const innerW = Math.max(1, w - pad * 2);
	const innerH = Math.max(1, h - pad * 2);
	const stepX = v.length > 1 ? innerW / (v.length - 1) : 0;
	const pts = v.map((n, i) => {
		const x = pad + i * stepX;
		const y = pad + innerH - ((n - min) / span) * innerH;
		return { x, y };
	});
	return {
		points: pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' '),
		last: pts[pts.length - 1],
		min, max,
		net: v[v.length - 1] - v[0],
	};
}

/**
 * Inline SVG string for a real numeric series. Net-positive vs net-negative coloring
 * via tokens; optional animated draw (stroke-dashoffset) and a final-point dot.
 * @param {number[]} values
 * @param {{width?:number, height?:number, fill?:boolean, dot?:boolean, animate?:boolean, stroke?:string}} [opts]
 * @returns {string} SVG markup
 */
export function sparkline(values, opts = {}) {
	const width = opts.width || 96;
	const height = opts.height || 28;
	const { points, last, net } = sparklinePath(values, width, height);
	if (!points) return `<svg class="juice-spark" width="${width}" height="${height}" aria-hidden="true"></svg>`;
	const color = opts.stroke || (net >= 0 ? 'var(--success)' : 'var(--danger)');
	const animate = opts.animate && !reducedMotion();
	const fillEl = opts.fill
		? `<polygon class="juice-spark-fill" points="${points} ${last.x.toFixed(2)},${height} 0,${height}" fill="${color}" opacity="0.12" />`
		: '';
	const dotEl = opts.dot !== false
		? `<circle class="juice-spark-dot" cx="${last.x.toFixed(2)}" cy="${last.y.toFixed(2)}" r="2" fill="${color}" />`
		: '';
	return `<svg class="juice-spark${animate ? ' juice-spark--draw' : ''}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none" aria-hidden="true">`
		+ fillEl
		+ `<polyline points="${points}" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />`
		+ dotEl
		+ `</svg>`;
}

// ── 5. ring ─────────────────────────────────────────────────────────────────────

/**
 * Arc-length geometry for a ring gauge filling to a real percentage. Pure; unit-tested.
 * @param {number} pct 0..100 (clamped)
 * @param {number} size px
 * @param {number} stroke ring thickness px
 * @returns {{r:number, circumference:number, offset:number, pct:number, center:number}}
 */
export function ringGeometry(pct, size, stroke) {
	const clamped = Math.max(0, Math.min(100, Number.isFinite(pct) ? pct : 0));
	const center = size / 2;
	const r = center - stroke / 2;
	const circumference = 2 * Math.PI * r;
	const offset = circumference * (1 - clamped / 100);
	return { r, circumference, offset, pct: clamped, center };
}

/**
 * SVG arc gauge filling to a real percentage with a centered label.
 * @param {number} pct 0..100
 * @param {{size?:number, stroke?:number, label?:string, color?:string, track?:string, animate?:boolean}} [opts]
 * @returns {string} SVG markup
 */
export function ring(pct, opts = {}) {
	const size = opts.size || 64;
	const stroke = opts.stroke || 5;
	const { r, circumference, offset, pct: p, center } = ringGeometry(pct, size, stroke);
	const color = opts.color || (p >= 66 ? 'var(--success)' : p >= 33 ? 'var(--warn)' : 'var(--danger)');
	const track = opts.track || 'var(--surface-3)';
	const label = opts.label != null ? opts.label : `${Math.round(p)}%`;
	const animate = opts.animate !== false && !reducedMotion();
	// dashoffset starts full (empty) then transitions to the real offset for a fill sweep
	const startOffset = animate ? circumference : offset;
	return `<svg class="juice-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="${escapeAttr(String(label))}">`
		+ `<circle cx="${center}" cy="${center}" r="${r.toFixed(2)}" fill="none" stroke="${track}" stroke-width="${stroke}" />`
		+ `<circle class="juice-ring-fill" cx="${center}" cy="${center}" r="${r.toFixed(2)}" fill="none" stroke="${color}" stroke-width="${stroke}" stroke-linecap="round"`
		+ ` stroke-dasharray="${circumference.toFixed(2)}" stroke-dashoffset="${startOffset.toFixed(2)}"`
		+ ` data-offset="${offset.toFixed(2)}" transform="rotate(-90 ${center} ${center})" />`
		+ (label !== '' ? `<text class="juice-ring-label" x="${center}" y="${center}" text-anchor="middle" dominant-baseline="central">${escapeHtml(String(label))}</text>` : '')
		+ `</svg>`;
}

/**
 * After inserting `ring(..., {animate:true})` markup, call this on the container to
 * sweep the fill from empty to its real offset. Safe to call when reduced motion.
 * @param {HTMLElement} scope element containing one or more `.juice-ring-fill`
 */
export function playRings(scope) {
	if (!scope) return;
	const fills = scope.querySelectorAll('.juice-ring-fill[data-offset]');
	fills.forEach((fill) => {
		const target = fill.getAttribute('data-offset');
		if (reducedMotion()) { fill.style.strokeDashoffset = target; return; }
		requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.strokeDashoffset = target; }));
	});
}

// ── 6. flipReorder ──────────────────────────────────────────────────────────────

/**
 * FLIP-animate a container's children to their new positions after a re-sort or
 * re-render, so lists reorder smoothly instead of snapping. Call `capture()` BEFORE
 * the DOM mutation and `play()` AFTER. Reduced motion → play() is a no-op.
 *
 * @param {HTMLElement} container
 * @param {(el:HTMLElement)=>string} keyFn stable identity per child (e.g. el => el.dataset.id)
 * @returns {{capture:()=>void, play:()=>void}}
 * @example
 *   const flip = flipReorder(list, el => el.dataset.id);
 *   flip.capture(); list.append(...resorted); flip.play();
 */
export function flipReorder(container, keyFn) {
	let firstRects = null;
	const measure = () => {
		const map = new Map();
		if (!container) return map;
		Array.from(container.children).forEach((child) => {
			const key = keyFn(child);
			if (key != null) map.set(String(key), child.getBoundingClientRect());
		});
		return map;
	};
	return {
		capture() { firstRects = measure(); },
		play() {
			if (!container || !firstRects || reducedMotion()) { firstRects = null; return; }
			Array.from(container.children).forEach((child) => {
				const key = keyFn(child);
				const first = key != null && firstRects.get(String(key));
				if (!first) return;
				const last = child.getBoundingClientRect();
				const dx = first.left - last.left;
				const dy = first.top - last.top;
				if (!dx && !dy) return;
				child.style.transform = `translate(${dx}px, ${dy}px)`;
				child.style.transition = 'none';
				requestAnimationFrame(() => {
					child.style.transition = 'transform var(--duration-base) var(--ease-emphasized)';
					child.style.transform = '';
				});
				child.addEventListener('transitionend', () => { child.style.transition = ''; child.style.transform = ''; }, { once: true });
			});
			firstRects = null;
		},
	};
}

/**
 * Diff two ordered key lists into the set of keys whose index changed — the pure
 * core of a FLIP reorder decision. Unit-tested.
 * @param {string[]} before
 * @param {string[]} after
 * @returns {string[]} keys that moved
 */
export function reorderedKeys(before, after) {
	const beforeIdx = new Map(before.map((k, i) => [String(k), i]));
	const moved = [];
	after.forEach((k, i) => {
		const key = String(k);
		if (beforeIdx.has(key) && beforeIdx.get(key) !== i) moved.push(key);
	});
	return moved;
}

// ── 7. liveDot ──────────────────────────────────────────────────────────────────

/**
 * Markup for a small live-state indicator mirroring the swarms `.sw-live` vocabulary
 * for SSE-backed surfaces. States: 'live' | 'connecting' | 'idle' | 'error'.
 * @param {'live'|'connecting'|'idle'|'error'} [state='idle']
 * @param {{label?:string}} [opts]
 * @returns {string} markup
 */
export function liveDot(state = 'idle', opts = {}) {
	const label = opts.label != null ? opts.label : state;
	return `<span class="juice-live" data-state="${escapeAttr(state)}">`
		+ `<span class="juice-live-dot" aria-hidden="true"></span>`
		+ `<span class="juice-live-txt">${escapeHtml(String(label))}</span>`
		+ `</span>`;
}

/**
 * Update an existing `.juice-live` element's state + label in place.
 * @param {HTMLElement} el a `.juice-live` element (or container of one)
 * @param {'live'|'connecting'|'idle'|'error'} state
 * @param {string} [label]
 */
export function setLiveDot(el, state, label) {
	if (!el) return;
	const live = el.classList && el.classList.contains('juice-live') ? el : el.querySelector && el.querySelector('.juice-live');
	if (!live) return;
	live.dataset.state = state;
	const txt = live.querySelector('.juice-live-txt');
	if (txt && label != null) txt.textContent = label;
}

// ── 8. rippleOnce ───────────────────────────────────────────────────────────────

/**
 * A single restrained accent ripple along an element's edge for "something happened"
 * beats (a real success, a fired event). No confetti. Reduced motion → no-op.
 * @param {HTMLElement} el
 */
export function rippleOnce(el) {
	if (!el || reducedMotion()) return;
	el.classList.remove('juice-ripple');
	void el.offsetWidth; // restart on back-to-back beats
	el.classList.add('juice-ripple');
	el.addEventListener('animationend', () => el.classList.remove('juice-ripple'), { once: true });
}

// ── internals ───────────────────────────────────────────────────────────────────

function escapeHtml(s) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeAttr(s) {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
