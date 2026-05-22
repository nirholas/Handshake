// Shared utilities for the /demos/agents/* interaction prototypes.
// Mirrors the renderer/avatar bootstrap from 3d-home.html so each demo
// can stay focused on its unique interaction logic.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const PX_PER_UNIT = 120;

export function smoothstep(t) { return t * t * (3 - 2 * t); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

export function createStage(canvas) {
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
	renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.1;

	const scene = new THREE.Scene();
	const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
	camera.position.z = 10;

	scene.add(new THREE.AmbientLight(0xffffff, 0.6));
	const key = new THREE.DirectionalLight(0xfff4dc, 2.0);
	key.position.set(3, 6, 5); scene.add(key);
	const rim = new THREE.DirectionalLight(0x4060ff, 0.6);
	rim.position.set(-4, 3, -2); scene.add(rim);
	const fill = new THREE.DirectionalLight(0xffeedd, 0.4);
	fill.position.set(0, 2, 7); scene.add(fill);

	function resize() {
		const hw = window.innerWidth  / PX_PER_UNIT / 2;
		const hh = window.innerHeight / PX_PER_UNIT / 2;
		camera.left = -hw; camera.right = hw;
		camera.top  =  hh; camera.bottom = -hh;
		camera.updateProjectionMatrix();
		renderer.setSize(window.innerWidth, window.innerHeight, false);
	}
	window.addEventListener('resize', resize);
	resize();

	const _v3 = new THREE.Vector3();
	function domToWorld(sx, sy) {
		_v3.set(
			 (sx / window.innerWidth)  * 2 - 1,
			-(sy / window.innerHeight) * 2 + 1,
			0,
		);
		_v3.unproject(camera);
		return { x: _v3.x, y: _v3.y };
	}

	return { renderer, scene, camera, resize, domToWorld };
}

export async function loadAvatar(url = '/avatars/cz.glb') {
	const gltf = await new Promise((res, rej) =>
		new GLTFLoader().load(url, res, undefined, rej),
	);
	const avatar = gltf.scene;
	let rootBone = null;
	avatar.traverse(n => {
		if (!rootBone && /^(Hips|Root|mixamorig:?Hips)$/i.test(n.name)) rootBone = n;
	});
	const mixer = new THREE.AnimationMixer(avatar);
	const baseRootPos = rootBone ? rootBone.position.clone() : null;
	return { avatar, mixer, rootBone, baseRootPos };
}

export async function loadClips(mixer, clipMap) {
	const entries = Object.entries(clipMap);
	const jsons = await Promise.all(
		entries.map(([_, url]) => fetch(url).then(r => r.json())),
	);
	const out = {};
	for (let i = 0; i < entries.length; i++) {
		out[entries[i][0]] = mixer.clipAction(THREE.AnimationClip.parse(jsons[i]));
	}
	return out;
}

export function startLoop(renderer, scene, camera, mixer, onTick, rootBone, baseRootPos) {
	const clock = new THREE.Clock();
	const _orig = renderer.render.bind(renderer);
	if (rootBone && baseRootPos) {
		renderer.render = (sc, cam) => {
			try { rootBone.position.copy(baseRootPos); } catch (_) {}
			_orig(sc, cam);
		};
	}
	(function tick() {
		requestAnimationFrame(tick);
		try {
			const dt = Math.min(clock.getDelta(), 0.05);
			mixer?.update(dt);
			onTick?.(dt);
			renderer.render(scene, camera);
		} catch (_) {}
	})();
}

// Ballistic droplet burst — same physics as 3d-home.html's fireSplash.
const PALETTES = {
	lime:  ['#f6ffc4', '#d6ff3d', '#92b500'],
	water: ['#e0f7ff', '#7fc4ff', '#1a6ec8'],
	red:   ['#ffd4d4', '#ff6b6b', '#9b1414'],
	gold:  ['#fff4c4', '#ffd23d', '#c89200'],
};
export function fireSplash(sx, sy, opts = {}) {
	const count = opts.count ?? 18;
	const pal = PALETTES[opts.color ?? 'lime'] ?? PALETTES.lime;
	const drops = [];
	for (let i = 0; i < count; i++) {
		const size = 5 + Math.random() * 7;
		const el = document.createElement('div');
		el.style.cssText =
			`position:fixed;left:${sx - size / 2}px;top:${sy - size / 2}px;` +
			`width:${size}px;height:${size}px;border-radius:50%;` +
			`background:radial-gradient(circle at 35% 30%,${pal[0]},${pal[1]} 55%,${pal[2]});` +
			`box-shadow:0 0 6px ${pal[1]}aa;pointer-events:none;z-index:30;` +
			`will-change:transform,opacity;`;
		document.body.appendChild(el);
		const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.15;
		const speed = 220 + Math.random() * 340;
		drops.push({
			el, x: 0, y: 0,
			vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
			life: 0, max: 0.85 + Math.random() * 0.5,
		});
	}
	let last = performance.now();
	(function step(now) {
		const dt = Math.min((now - last) / 1000, 0.04);
		last = now;
		let alive = false;
		for (const d of drops) {
			if (!d.el) continue;
			d.life += dt;
			d.vy   += 1600 * dt;
			d.x    += d.vx * dt;
			d.y    += d.vy * dt;
			const t = d.life / d.max;
			if (t >= 1) { d.el.remove(); d.el = null; continue; }
			d.el.style.opacity   = String(1 - t * t);
			d.el.style.transform = `translate(${d.x.toFixed(1)}px, ${d.y.toFixed(1)}px)`;
			alive = true;
		}
		if (alive) requestAnimationFrame(step);
	})(last);
}

// Compact squish via Web Animations API (no gsap dep).
export function fireSquish(el, opts = {}) {
	const sX = opts.scaleX ?? 1.05;
	const sY = opts.scaleY ?? 0.7;
	el.animate(
		[
			{ transform: 'scaleX(1) scaleY(1)' },
			{ transform: `scaleX(${sX}) scaleY(${sY})`, offset: 0.12 },
			{ transform: 'scaleX(0.99) scaleY(1.02)',  offset: 0.4  },
			{ transform: 'scaleX(1.01) scaleY(0.99)',  offset: 0.65 },
			{ transform: 'scaleX(1) scaleY(1)' },
		],
		{ duration: 900, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
	);
}

// Expanding shockwave ring centered at (sx, sy) for impact feedback.
export function fireShockwave(sx, sy, opts = {}) {
	const color = opts.color ?? '#d6ff3d';
	const size  = opts.size  ?? 14;
	const max   = opts.max   ?? 120;
	const ring = document.createElement('div');
	ring.style.cssText =
		`position:fixed;left:${sx - size / 2}px;top:${sy - size / 2}px;` +
		`width:${size}px;height:${size}px;border-radius:50%;` +
		`border:2px solid ${color};box-shadow:0 0 12px ${color}88;` +
		`pointer-events:none;z-index:25;will-change:transform,opacity;`;
	document.body.appendChild(ring);
	const anim = ring.animate(
		[
			{ transform: 'scale(1)',                   opacity: 0.95 },
			{ transform: `scale(${max / size})`,       opacity: 0    },
		],
		{ duration: 520, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
	);
	anim.onfinish = () => ring.remove();
}

// Common HTML chrome — minimal nav + back link injected once.
export function mountChrome(title) {
	document.body.insertAdjacentHTML('afterbegin', `
		<div class="agents-nav">
			<a href="/demos/agents/" class="agents-back">← agents</a>
			<span class="agents-title">${title}</span>
		</div>
	`);
}
