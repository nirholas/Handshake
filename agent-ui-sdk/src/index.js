import * as THREE from 'three';

import { createRenderer } from './renderer.js';
import { loadAvatar, createAnimator, lockRootMotion } from './avatar.js';
import {
	worldOfElement,
	moveTo,
	lookAtScreenX,
	faceFront,
	walkTo,
	standOn,
	fallOnto,
	runOff,
	interceptNavigation,
	createRandomPicker,
} from './behaviors.js';
import { caretScreenX, startCaretTracking } from './caret.js';
import { dust, impactPulse, proximityShadow } from './fx.js';
import { scan } from './scan.js';

const DEFAULTS = {
	avatar: '/avatars/cz.glb',
	clipsBase: '/animations/clips/',
	clips: ['idle', 'walk'],
	subclips: {},
	container: null,                // resolved to document.body
	canvas: null,                   // explicit canvas; else created
	zIndex: 999,
	pixelsPerUnit: 120,
	parallax: true,
	crossfade: 0.3,
	lights: true,
};

/**
 * Create an avatar overlay bound to the current document.
 *
 * Returns a Promise that resolves to an AgentUI handle once the GLB and clip
 * JSONs have loaded and the avatar is in scene playing 'idle' (or whatever
 * the caller plays first).
 */
export async function createAgentUI(userOptions = {}) {
	const opts = { ...DEFAULTS, ...userOptions };
	if (!opts.container) opts.container = document.body;

	const rendererCtx = createRenderer({
		container: opts.container,
		canvas: opts.canvas,
		zIndex: opts.zIndex,
		pixelsPerUnit: opts.pixelsPerUnit,
		lights: opts.lights,
		parallax: opts.parallax,
	});

	// Build the public handle in stages — methods need a reference to it for
	// passing into the free behavior functions below.
	const agent = {
		// Three.js objects
		THREE,
		renderer: rendererCtx.renderer,
		scene: rendererCtx.scene,
		camera: rendererCtx.camera,
		canvas: rendererCtx.canvas,
		pixelsPerUnit: rendererCtx.pixelsPerUnit,
		avatar: null,
		rootBone: null,
		animator: null,

		// Coordinate helpers
		domToWorld: rendererCtx.domToWorld,
		worldToScreen: rendererCtx.worldToScreen,
		worldOfElement: (el, o) => worldOfElement(el, agent, o),

		// Animation
		play: (name, o) => agent.animator?.play(name, o),
		clip: (name) => agent.animator?.clipDuration(name) ?? 0,
		get currentClip() { return agent.animator?.currentName ?? null; },

		// Movement / posing
		moveTo: (target, o) => moveTo(agent, target, o),
		lookAt: (screenX, o) => lookAtScreenX(agent, screenX, o),
		faceFront: (o) => faceFront(agent, o),

		// DOM-anchored behaviors
		standOn: (el, o) => standOn(agent, el, o),
		walkTo:  (el, o) => walkTo(agent, el, o),
		fallOnto:(el, o) => fallOnto(agent, el, o),
		runOff:  (dir, o) => runOff(agent, dir, o),
		interceptNavigation: (el, o) => interceptNavigation(agent, el, o),

		// FX helpers
		fx: {
			dust: (el, o) => dust(el, o),
			impactPulse: (el, o) => impactPulse(el, o),
			proximityShadow: (el, o) => {
				const handle = proximityShadow(el, agent, o);
				agent._proximityTickers.push(handle.tick);
				return () => {
					const i = agent._proximityTickers.indexOf(handle.tick);
					if (i >= 0) agent._proximityTickers.splice(i, 1);
					handle.dispose();
				};
			},
		},

		// Caret helper — exposed for consumers writing imperative typing UX
		caretScreenX,
		startCaretTracking,

		// Random non-repeating picker (e.g. fail reaction rotations)
		pickFrom: (pool) => createRandomPicker(pool),

		// Declarative DOM scanner
		scan: (root = document) => scan(root, agent),

		// Ready signaling
		ready: false,
		whenReady(fn) {
			if (agent.ready) fn(agent);
			else agent._readyHandlers.push(fn);
		},

		// Lifecycle
		destroy() {
			agent._destroyed = true;
			cancelAnimationFrame(agent._raf);
			agent._unlockRoot?.();
			rendererCtx.destroy();
		},

		// Internal
		_readyHandlers: [],
		_proximityTickers: [],
		_runningOff: false,
		_destroyed: false,
		_unlockRoot: null,
		_raf: 0,
	};

	// Load avatar + clips
	const { object, rootBone, clips } = await loadAvatar({
		avatar: opts.avatar,
		clipsBase: opts.clipsBase,
		clips: opts.clips,
		subclips: opts.subclips,
	});
	agent.avatar = object;
	agent.rootBone = rootBone;
	agent.scene.add(object);

	agent.animator = createAnimator({ object, clips, crossfade: opts.crossfade });
	agent._unlockRoot = lockRootMotion(agent.renderer, rootBone);

	// Default to idle if it's loaded; consumer can override via play().
	if (clips.idle) agent.animator.play('idle', { loop: true });

	// Render loop
	const clock = new THREE.Clock();
	(function tick() {
		if (agent._destroyed) return;
		agent._raf = requestAnimationFrame(tick);
		try {
			const dt = Math.min(clock.getDelta(), 0.05);
			agent.animator.update(dt);
			rendererCtx.updateParallax();
			for (const t of agent._proximityTickers) t();
			agent.renderer.render(agent.scene, agent.camera);
		} catch (_) {}
	})();

	agent.ready = true;
	for (const fn of agent._readyHandlers) fn(agent);
	agent._readyHandlers.length = 0;

	return agent;
}

// Re-exports for advanced consumers building their own compositions.
export {
	createRenderer,
	loadAvatar,
	createAnimator,
	lockRootMotion,
	worldOfElement,
	moveTo,
	lookAtScreenX,
	faceFront,
	walkTo,
	standOn,
	fallOnto,
	runOff,
	interceptNavigation,
	createRandomPicker,
	caretScreenX,
	startCaretTracking,
	dust,
	impactPulse,
	proximityShadow,
	scan,
};
