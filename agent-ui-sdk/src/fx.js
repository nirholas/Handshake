// Lightweight HTML/CSS-driven FX layered over the avatar canvas. Kept here so
// the demos don't need to reimplement these helpers each time.

/**
 * Spray ballistic dust particles from the impact point on `element`. Neutral
 * grey palette — reads as kicked-up dust rather than confetti.
 */
export function dust(element, {
	count = 16,
	gravity = 1400,
	minSpeed = 180,
	maxSpeed = 460,
	minSize = 4,
	maxSize = 10,
	maxLifeMs = 1100,
	yWithin = 0.78, // 0..1 fraction down the element box for the origin
	zIndex = 30,
	color = 'radial-gradient(circle at 35% 30%,#cfd2dd,#7a7d8e 60%,#3c3e4c)',
} = {}) {
	const r = element.getBoundingClientRect();
	const ox = r.left + r.width / 2;
	const oy = r.top + r.height * yWithin;

	const drops = [];
	for (let i = 0; i < count; i++) {
		const size = minSize + Math.random() * (maxSize - minSize);
		const el = document.createElement('div');
		el.style.cssText =
			`position:fixed;left:${ox - size/2}px;top:${oy - size/2}px;` +
			`width:${size}px;height:${size}px;border-radius:50%;` +
			`background:${color};` +
			'box-shadow:0 0 5px rgba(255,255,255,0.18);' +
			`pointer-events:none;z-index:${zIndex};will-change:transform,opacity;`;
		document.body.appendChild(el);
		const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.3;
		const speed = minSpeed + Math.random() * (maxSpeed - minSpeed);
		drops.push({
			el, x: 0, y: 0,
			vx: Math.cos(angle) * speed,
			vy: Math.sin(angle) * speed,
			life: 0,
			max: (maxLifeMs / 1000) * (0.6 + Math.random() * 0.6),
		});
	}

	let last = performance.now();
	(function step(now) {
		const dt = Math.min((now - last) / 1000, 0.04); last = now;
		let alive = false;
		for (const d of drops) {
			if (!d.el) continue;
			d.life += dt;
			d.vy += gravity * dt;
			d.x += d.vx * dt; d.y += d.vy * dt;
			const t = d.life / d.max;
			if (t >= 1) { d.el.remove(); d.el = null; continue; }
			d.el.style.opacity = String(1 - t * t);
			d.el.style.transform = `translate(${d.x.toFixed(1)}px,${d.y.toFixed(1)}px)`;
			alive = true;
		}
		if (alive) requestAnimationFrame(step);
	})(last);
}

/**
 * Brief vertical translate + elastic settle on `element`. Sells the weight of
 * a landing on top of it.
 */
export function impactPulse(element, { dropPx = 4, elasticMs = 500 } = {}) {
	let raf = 0;
	const t0 = performance.now();
	const down = 80;
	(function down1(now) {
		const t = Math.min((now - t0) / down, 1);
		element.style.transform = `translateY(${(dropPx * t).toFixed(2)}px)`;
		if (t < 1) raf = requestAnimationFrame(down1);
		else {
			const t1 = performance.now();
			(function up(now2) {
				const t2 = Math.min((now2 - t1) / elasticMs, 1);
				// Damped sin elastic
				const e = (1 - t2) * Math.sin(t2 * Math.PI * 3.5) * 0.45 + (1 - t2) * (1 - t2);
				element.style.transform = `translateY(${(dropPx * e).toFixed(2)}px)`;
				if (t2 < 1) raf = requestAnimationFrame(up);
				else element.style.transform = '';
			})(performance.now());
		}
	})(t0);
	return () => cancelAnimationFrame(raf);
}

/**
 * Continuously paint a CSS text-shadow on `targetEl` whose intensity scales
 * with the avatar's vertical proximity to the target. Caller must invoke the
 * returned tick() in their render loop and the returned dispose() on cleanup.
 *
 * Sets a CSS custom property `--agent-shadow` on `targetEl`. The element's
 * stylesheet should consume it via e.g. `text-shadow: var(--agent-shadow, none)`.
 */
export function proximityShadow(targetEl, agent, {
	maxDistancePx = 280,
	maxAlpha = 0.6,
	cssVar = '--agent-shadow',
} = {}) {
	function tick() {
		if (!agent.avatar) return;
		const r = targetEl.getBoundingClientRect();
		const proj = agent.worldToScreen(agent.avatar.position.x, agent.avatar.position.y);
		const dy = Math.max(0, r.top - proj.y);
		const prox = 1 - Math.min(dy / maxDistancePx, 1);
		if (prox <= 0.01) {
			targetEl.style.setProperty(cssVar, 'none');
			return;
		}
		const blur    = (12 * (1 - prox) + 3).toFixed(2);
		const offsetY = (3 + 8 * prox).toFixed(2);
		const alpha   = (maxAlpha * prox).toFixed(3);
		targetEl.style.setProperty(cssVar, `0 ${offsetY}px ${blur}px rgba(0,0,0,${alpha})`);
	}
	function dispose() {
		targetEl.style.removeProperty(cssVar);
	}
	return { tick, dispose };
}
