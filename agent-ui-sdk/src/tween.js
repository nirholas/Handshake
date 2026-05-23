// Tiny tween utilities used in place of gsap. Each fn returns a Promise that
// resolves when the tween ends and exposes .cancel() on the same promise so
// in-flight tweens can be interrupted.

export const smoothstep = (t) => t * t * (3 - 2 * t);
export const easeInQuad  = (t) => t * t;
export const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

export function tween({ duration = 400, ease = smoothstep, onUpdate, onComplete }) {
	let raf = 0;
	let cancelled = false;
	const t0 = performance.now();
	const p = new Promise((resolve) => {
		(function step(now) {
			if (cancelled) return;
			const t = Math.min((now - t0) / duration, 1);
			onUpdate(ease(t), t);
			if (t < 1) raf = requestAnimationFrame(step);
			else { onComplete?.(); resolve(); }
		})(performance.now());
	});
	p.cancel = () => { cancelled = true; cancelAnimationFrame(raf); };
	return p;
}

// Tween a numeric property on `obj` toward `to` over `duration` ms.
export function tweenProp(obj, prop, to, options = {}) {
	const from = obj[prop];
	const delta = to - from;
	return tween({
		...options,
		onUpdate: (e) => { obj[prop] = from + delta * e; },
	});
}
