import { tween, tweenProp, smoothstep, easeInQuad, easeOutCubic } from './tween.js';

// Anchor helpers — convert a DOM element into a world-space target that the
// avatar should stand at. Default anchor is the visual top of the element
// because the avatar's pivot is at the feet.
export function worldOfElement(el, agent, { anchor = 'top-center', offsetX = 0, offsetY = 0 } = {}) {
	const r = el.getBoundingClientRect();
	let sx = r.left + r.width / 2;
	let sy = r.top;
	switch (anchor) {
		case 'top-left':       sx = r.left;             sy = r.top;                       break;
		case 'top-right':      sx = r.right;            sy = r.top;                       break;
		case 'top-center':     sx = r.left + r.width/2; sy = r.top;                       break;
		case 'center':         sx = r.left + r.width/2; sy = r.top + r.height/2;          break;
		case 'bottom-center':  sx = r.left + r.width/2; sy = r.bottom;                    break;
		case 'left-of':        sx = r.left;             sy = r.top + r.height/2;          break;
		case 'right-of':       sx = r.right;            sy = r.top + r.height/2;          break;
	}
	return agent.domToWorld(sx + offsetX, sy + offsetY);
}

/**
 * Slide the avatar from its current world position to `target`.
 * Returns a Promise resolving when the move completes.
 */
export function moveTo(agent, target, { duration = 520, ease = smoothstep } = {}) {
	if (!agent.avatar) return Promise.resolve();
	const av = agent.avatar;
	const fromX = av.position.x, fromY = av.position.y;
	return tween({
		duration,
		ease,
		onUpdate: (e) => {
			av.position.x = fromX + (target.x - fromX) * e;
			av.position.y = fromY + (target.y - fromY) * e;
		},
	});
}

/**
 * Smoothly turn the avatar's yaw toward a screen X position. Used to make
 * the avatar's body follow a caret or a button being moused.
 */
export function lookAtScreenX(agent, targetScreenX, { duration = 180, maxYaw = 0.45, sensitivity = 450 } = {}) {
	if (!agent.avatar) return Promise.resolve();
	const projected = agent.worldToScreen(agent.avatar.position.x, agent.avatar.position.y);
	const dxPx = targetScreenX - projected.x;
	const yaw = Math.max(-maxYaw, Math.min(maxYaw, dxPx / sensitivity));
	return tweenProp(agent.avatar.rotation, 'y', yaw, { duration });
}

export function faceFront(agent, { duration = 250 } = {}) {
	if (!agent.avatar) return Promise.resolve();
	return tweenProp(agent.avatar.rotation, 'y', 0, { duration });
}

/**
 * Walk-cycle to `element`: switches to the walk clip, slides over, then leaves
 * the animator on the walk clip — caller decides what to play next.
 */
export async function walkTo(agent, element, { walkClip = 'walk', duration = 540, anchor = 'top-center', offsetX = 0, offsetY = 0 } = {}) {
	if (!agent.avatar) return;
	agent.play(walkClip, { loop: true });
	const target = worldOfElement(element, agent, { anchor, offsetX, offsetY });
	await moveTo(agent, target, { duration });
}

/**
 * Park the avatar above `element` without traversal — used on initial mount
 * to position the avatar at rest on a card / button / heading.
 */
export function standOn(agent, element, { idleClip = 'idle', anchor = 'top-center', offsetX = 0, offsetY = 0 } = {}) {
	if (!agent.avatar) return;
	const target = worldOfElement(element, agent, { anchor, offsetX, offsetY });
	agent.avatar.position.set(target.x, target.y, 0);
	agent.play(idleClip, { loop: true });
}

/**
 * Drop the avatar from above the viewport onto `element`. Calls `onLand` once
 * the impact frame is reached so the caller can fire dust/pulse FX.
 */
export function fallOnto(agent, element, {
	fallClip = 'falling',
	duration = 1.4,
	startOffsetVh = 0.6,
	anchor = 'top-center',
	landingOffsetPx = 90,
	tumble = 0.25,
	onLand,
} = {}) {
	if (!agent.avatar) return Promise.resolve();
	const getStart = () => {
		const r = element.getBoundingClientRect();
		return agent.domToWorld(r.left + r.width / 2, -window.innerHeight * startOffsetVh);
	};
	const getTarget = () => {
		const r = element.getBoundingClientRect();
		const sx = r.left + r.width / 2;
		const sy = (anchor === 'top-center') ? (r.top + landingOffsetPx) : (r.top + r.height / 2);
		return agent.domToWorld(sx, sy);
	};
	const start = getStart();
	const target = getTarget();
	agent.avatar.position.set(start.x, start.y, 0);
	agent.avatar.rotation.set(0, 0, 0);
	agent.play(fallClip, { loop: true });

	return new Promise((resolve) => {
		tween({
			duration: duration * 1000,
			ease: (t) => t, // we apply per-axis easing inside
			onUpdate: (_, t) => {
				const ey = easeInQuad(t); // gravity vertical
				const ex = smoothstep(t); // smooth horizontal
				agent.avatar.position.x = start.x + (target.x - start.x) * ex;
				agent.avatar.position.y = start.y + (target.y - start.y) * ey;
				agent.avatar.rotation.y = (1 - t) * tumble * Math.sin(t * 8);
			},
			onComplete: () => {
				onLand?.();
				resolve();
			},
		});
	});
}

/**
 * Walk the avatar off-screen in `direction`. Resolves once she clears the
 * viewport so caller can navigate away or unmount.
 */
export function runOff(agent, direction = 'right', {
	walkClip = 'walk',
	rotationDuration = 300,
	minDuration = 900,
	pxPerMs = 0.45, // walk speed for distance-based timing
} = {}) {
	if (!agent.avatar) return Promise.resolve();
	const dir = direction === 'left' ? -1 : 1;
	agent.play(walkClip, { loop: true });
	tweenProp(agent.avatar.rotation, 'y', dir * Math.PI * 0.5, { duration: rotationDuration });
	const targetWorldX = (window.innerWidth / agent.pixelsPerUnit) * 0.7 * dir;
	const curX = agent.avatar.position.x;
	const distancePx = Math.abs(targetWorldX - curX) * agent.pixelsPerUnit;
	const duration = Math.max(minDuration, distancePx / pxPerMs);
	return tweenProp(agent.avatar.position, 'x', targetWorldX, { duration, ease: easeOutCubic });
}

/**
 * Intercept a link/button click: prevent default, run the avatar off-screen,
 * then navigate to `linkEl.href` (or call `onAfter`).
 */
export function interceptNavigation(agent, linkEl, {
	direction = 'right',
	delay = 1100,
	onAfter,
} = {}) {
	const handler = (e) => {
		if (agent._runningOff) return;
		e.preventDefault();
		agent._runningOff = true;
		runOff(agent, direction);
		setTimeout(() => {
			if (onAfter) onAfter();
			else if (linkEl.href) window.location.href = linkEl.href;
		}, delay);
	};
	linkEl.addEventListener('click', handler);
	return () => linkEl.removeEventListener('click', handler);
}

/**
 * Pick a clip from `pool` while avoiding the most recent pick. Useful for
 * fail / react rotations so the same animation doesn't fire twice in a row.
 */
export function createRandomPicker(pool) {
	let last = null;
	return () => {
		if (pool.length === 0) return null;
		if (pool.length === 1) return pool[0];
		let pick;
		do { pick = pool[Math.floor(Math.random() * pool.length)]; }
		while (pick === last);
		last = pick;
		return pick;
	};
}
