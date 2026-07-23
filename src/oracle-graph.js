// Oracle — 3D conviction force graph.
//
// Renders every scored coin as a sphere in 3D space. Size = conviction score.
// Color = tier (prime=gold, strong=cyan, lean=violet, watch=amber, avoid=red).
// Simple spring physics: Coulomb repulsion + category-category mild attraction +
// velocity damping. Labels are CSS divs anchored by matrix projection. Mounts
// into a canvas + label container the caller passes; cleans up on dispose().

import {
	AmbientLight,
	Color,
	DirectionalLight,
	FogExp2,
	Group,
	InstancedMesh,
	Matrix4,
	MeshStandardMaterial,
	PerspectiveCamera,
	Quaternion,
	Raycaster,
	Scene,
	SphereGeometry,
	Vector2,
	Vector3,
	WebGLRenderer,
	NoToneMapping,
} from 'three';
import {
	EffectComposer,
	RenderPass,
	EffectPass,
	BloomEffect,
	ToneMappingEffect,
	ToneMappingMode,
} from 'postprocessing';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { applyCinematicDefaults, detectQualityTier, loadEnvironment } from './shared/cinematic-render.js';

// Tier → hex color
const TIER_COLOR = {
	prime:  0xeceff5,
	strong: 0xc2c7d4,
	lean:   0x9aa0b0,
	watch:  0x8a92a8,
	avoid:  0x6c7280,
};
const TIER_GLOW = {
	prime:  0.9,
	strong: 0.7,
	lean:   0.55,
	watch:  0.45,
	avoid:  0.3,
};

// Category → cluster position hint (nodes of the same category drift toward this)
const CATEGORY_OFFSET = {
	meme:      new Vector3(-8,  2,  0),
	ai:        new Vector3( 8,  2,  0),
	tech:      new Vector3( 0,  8,  0),
	culture:   new Vector3(-5, -5,  5),
	community: new Vector3( 5, -5,  5),
	political: new Vector3(-8, -3, -3),
	news:      new Vector3( 8, -3, -3),
	animal:    new Vector3( 0,  0,  9),
	celebrity: new Vector3( 0, -8,  0),
	utility:   new Vector3( 4,  5, -7),
	unknown:   new Vector3( 0,  0,  0),
};

const REPULSION_K = 28;
const CLUSTER_K   = 0.04;
const CENTER_K    = 0.015;
const DAMPING     = 0.86;
const WARMUP_FRAMES = 160;

export function mountOracleGraph(canvas, labelContainer) {
	const W = () => canvas.clientWidth || window.innerWidth;
	const H = () => canvas.clientHeight || 520;

	const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
	// Shared cinematic bar for sRGB output + tiered pixel ratio cap. Tone
	// mapping stays NoToneMapping on the renderer itself: this scene already
	// runs ACES filmic through the postprocessing ToneMappingEffect below
	// (composed alongside bloom), so setting it on the renderer too would
	// double-apply the curve.
	const tier = detectQualityTier();
	applyCinematicDefaults(renderer, { tier });
	renderer.toneMapping = NoToneMapping;
	renderer.setSize(W(), H(), false);

	const scene = new Scene();
	scene.background = new Color(0x05060c);
	scene.fog = new FogExp2(0x05060c, 0.012);
	// Conviction spheres use MeshStandardMaterial (real PBR, reacts to light),
	// so a real HDRI gives them genuine specular highlights beyond the flat
	// key/rim/ambient rig below. No ground-contact shadow: the graph floats
	// in open space with no floor/pedestal for a shadow to land on.
	loadEnvironment(renderer, scene, tier === 'mobile' ? null : 'sunset');
	// Fill + key + rim so the metallic spheres read as 3D from every orbit
	// angle. The emissive glow (below) carries the tier color and feeds bloom;
	// these lights give the spheres form so they don't look like flat discs.
	scene.add(new AmbientLight(0x3a3f4d, 1.6));
	const keyLight = new DirectionalLight(0xffffff, 1.7);
	keyLight.position.set(6, 10, 8);
	scene.add(keyLight);
	const rimLight = new DirectionalLight(0x8894ff, 0.7);
	rimLight.position.set(-8, -4, -6);
	scene.add(rimLight);

	const camera = new PerspectiveCamera(50, W() / H(), 0.1, 500);
	camera.position.set(0, 0, 55);

	const bloomEffect = new BloomEffect({
		intensity: 0.9,
		luminanceThreshold: 0.28,
		luminanceSmoothing: 0.08,
		mipmapBlur: true,
	});
	const composer = new EffectComposer(renderer);
	composer.addPass(new RenderPass(scene, camera));
	composer.addPass(new EffectPass(camera, bloomEffect, new ToneMappingEffect({ mode: ToneMappingMode.ACES_FILMIC })));

	const controls = new OrbitControls(camera, canvas);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.autoRotate = true;
	controls.autoRotateSpeed = 0.35;
	controls.minDistance = 15;
	controls.maxDistance = 130;
	controls.enablePan = false;

	// Node data: positions, velocities, metadata for label rendering.
	let nodes = [];         // { pos: Vector3, vel: Vector3, radius, tier, category, symbol, score, mint }
	let imesh = null;       // InstancedMesh shared by all nodes
	let labelEls = [];      // parallel array of div elements
	const _m4 = new Matrix4();
	const _q  = new Quaternion();
	const _s  = new Vector3();

	const geo = new SphereGeometry(1, 12, 8);
	const mat = new MeshStandardMaterial({
		roughness: 0.4,
		metalness: 0.15,
		emissive: 0xffffff,
		emissiveIntensity: 1.0,
	});
	// Drive the emissive channel from each instance's color so every sphere
	// self-illuminates in its tier color and feeds the bloom pass — this is
	// what makes the graph visible against the near-black background instead
	// of a dim, light-starved void. `vColor` carries the per-instance color
	// whenever USE_INSTANCING_COLOR is defined, which it is once setColorAt runs.
	mat.onBeforeCompile = (shader) => {
		shader.fragmentShader = shader.fragmentShader.replace(
			'#include <emissivemap_fragment>',
			'#include <emissivemap_fragment>\n\ttotalEmissiveRadiance *= vColor.rgb;',
		);
	};

	function buildMesh(count) {
		imesh?.parent?.remove(imesh);
		imesh?.dispose();
		imesh = new InstancedMesh(geo, mat, count);
		imesh.instanceMatrix.needsUpdate = true;
		scene.add(imesh);
		return imesh;
	}

	function buildLabels(ns) {
		labelEls.forEach((el) => el.remove());
		labelEls = ns.map((n) => {
			const el = document.createElement('div');
			el.className = 'og-label';
			el.textContent = n.symbol || n.mint?.slice(0, 6) || '?';
			el.style.cssText = `
				position:absolute;pointer-events:none;font:600 11px/1 var(--mono,'Courier New');
				color:#fff;background:rgba(0,0,0,.55);padding:2px 5px;border-radius:4px;
				white-space:nowrap;transform:translate(-50%,-50%);opacity:0;
				transition:opacity .15s;user-select:none;
			`;
			labelContainer.appendChild(el);
			return el;
		});
	}

	function randomSpherePos(r = 18) {
		const u = (Math.random() - 0.5) * 2;
		const t = Math.random() * Math.PI * 2;
		const sq = Math.sqrt(1 - u * u);
		return new Vector3(sq * Math.cos(t) * r, u * r, sq * Math.sin(t) * r);
	}

	function applyCoins(coins) {
		nodes = coins.map((c) => {
			const score = Math.max(5, Math.min(100, Number(c.score) || 30));
			return {
				pos: randomSpherePos(20),
				vel: new Vector3(),
				radius: 0.22 + (score / 100) * 1.6,
				tier: c.tier || 'watch',
				category: c.category || 'unknown',
				symbol: c.symbol || '',
				score,
				mint: c.mint,
			};
		});

		buildMesh(nodes.length);
		buildLabels(nodes);

		// Assign instance colors, scaled by the tier's glow so prime coins burn
		// brighter than avoid coins. The scaled color drives both the diffuse
		// tint and the emissive glow (see the material's onBeforeCompile), so a
		// factor above 1 pushes prime tiers into HDR and blooms harder.
		const col = new Color();
		nodes.forEach((n, i) => {
			const glow = TIER_GLOW[n.tier] ?? 0.5;
			col.setHex(TIER_COLOR[n.tier] ?? 0xffffff).multiplyScalar(0.6 + glow * 0.7);
			imesh.setColorAt(i, col);
		});
		imesh.instanceColor.needsUpdate = true;

		// Warm-up physics so the graph isn't a big ball on first frame.
		for (let f = 0; f < WARMUP_FRAMES; f++) stepPhysics(0.016);
	}

	const _tmp = new Vector3();
	function stepPhysics(dt) {
		const n = nodes.length;
		for (let i = 0; i < n; i++) {
			const ni = nodes[i];
			const ax = new Vector3();

			// Repulsion against all other nodes.
			for (let j = 0; j < n; j++) {
				if (j === i) continue;
				_tmp.copy(ni.pos).sub(nodes[j].pos);
				const dSq = Math.max(0.01, _tmp.lengthSq());
				const f = REPULSION_K / dSq;
				ax.addScaledVector(_tmp.normalize(), f);
			}

			// Mild category clustering.
			const target = CATEGORY_OFFSET[ni.category] || CATEGORY_OFFSET.unknown;
			ax.addScaledVector(_tmp.copy(target).sub(ni.pos), CLUSTER_K);

			// Center-pull.
			ax.addScaledVector(ni.pos.clone().negate(), CENTER_K);

			ni.vel.addScaledVector(ax, dt);
			ni.vel.multiplyScalar(DAMPING);
			ni.pos.addScaledVector(ni.vel, dt * 60);
		}
	}

	const _ndc = new Vector2();
	const _ray = new Raycaster();
	let hovered = -1;

	canvas.addEventListener('pointermove', (e) => {
		if (!imesh) return;
		const rect = canvas.getBoundingClientRect();
		_ndc.set(
			((e.clientX - rect.left) / rect.width) * 2 - 1,
			-((e.clientY - rect.top) / rect.height) * 2 + 1,
		);
		_ray.setFromCamera(_ndc, camera);
		const hits = _ray.intersectObject(imesh);
		hovered = hits.length ? hits[0].instanceId : -1;
	});
	canvas.addEventListener('pointerleave', () => { hovered = -1; });

	// Open coin drawer on click (dispatch the same event oracle.js uses).
	canvas.addEventListener('click', () => {
		if (hovered >= 0 && nodes[hovered]) {
			window.dispatchEvent(new CustomEvent('oracle:open-coin', { detail: { mint: nodes[hovered].mint } }));
		}
	});

	const _pos3 = new Vector3();
	let raf = 0;

	function frame() {
		if (document.visibilityState === 'hidden') { raf = requestAnimationFrame(frame); return; } // pause on a backgrounded tab
		controls.update();
		stepPhysics(0.016);

		if (imesh && nodes.length) {
			nodes.forEach((n, i) => {
				_s.setScalar(n.radius);
				_m4.compose(n.pos, _q, _s);
				imesh.setMatrixAt(i, _m4);
			});
			imesh.instanceMatrix.needsUpdate = true;
		}

		// Project labels.
		nodes.forEach((n, i) => {
			const el = labelEls[i];
			if (!el) return;
			_pos3.copy(n.pos);
			_pos3.project(camera);
			const x = (_pos3.x * 0.5 + 0.5) * W();
			const y = (-_pos3.y * 0.5 + 0.5) * H();
			const vis = i === hovered || n.score >= 78;
			el.style.left = `${x}px`;
			el.style.top  = `${y}px`;
			el.style.opacity = vis ? '1' : '0';
			el.style.zIndex = i === hovered ? '10' : '1';
		});

		composer.render();
		raf = requestAnimationFrame(frame);
	}

	const onResize = () => {
		renderer.setSize(W(), H(), false);
		composer.setSize(W(), H());
		camera.aspect = W() / H();
		camera.updateProjectionMatrix();
	};
	window.addEventListener('resize', onResize);

	// Public API
	return {
		loadCoins(coins) {
			applyCoins(coins);
			frame();
		},
		addCoin(coin) {
			if (nodes.find((n) => n.mint === coin.mint)) return;
			const score = Math.max(5, Math.min(100, Number(coin.score) || 30));
			const n = {
				pos: randomSpherePos(25),
				vel: new Vector3(),
				radius: 0.22 + (score / 100) * 1.6,
				tier: coin.tier || 'watch',
				category: coin.category || 'unknown',
				symbol: coin.symbol || '',
				score,
				mint: coin.mint,
			};
			nodes.push(n);
			applyCoins(nodes.map((x) => ({
				score: x.score, tier: x.tier, category: x.category,
				symbol: x.symbol, mint: x.mint,
			})));
		},
		dispose() {
			cancelAnimationFrame(raf);
			window.removeEventListener('resize', onResize);
			controls.dispose();
			labelEls.forEach((el) => el.remove());
			labelEls = [];
			imesh?.dispose();
			geo.dispose();
			mat.dispose();
			composer.dispose();
			renderer.dispose();
		},
	};
}
