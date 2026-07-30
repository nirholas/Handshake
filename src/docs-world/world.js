// Docs World scene: the documentation rendered as a place.
//
// Fourteen nav sections (from /docs/nav.json, the same manifest the classic
// docs sidebar renders) become fourteen glowing pavilions on a ring around a
// central plaza. Each pavilion carries a portal disc in its section colour and
// a floating label. Walking up to one (or tapping it) opens that section's
// page list; picking a page opens the in-world reader (reader.js) over the
// live markdown at /docs/<slug>.md.
//
// Everything here is deliberately cheap: emissive materials instead of
// per-pavilion lights, canvas-texture sprites for text, one hemisphere + one
// directional light, and a vertex-coloured dome for the sky. The whole scene
// draws in well under a millisecond on integrated GPUs so phones keep 60fps.

import {
	AdditiveBlending,
	BackSide,
	BufferAttribute,
	BufferGeometry,
	CanvasTexture,
	CircleGeometry,
	Color,
	CylinderGeometry,
	DirectionalLight,
	Fog,
	Group,
	HemisphereLight,
	Mesh,
	MeshBasicMaterial,
	MeshStandardMaterial,
	PerspectiveCamera,
	Points,
	PointsMaterial,
	RingGeometry,
	Scene,
	SphereGeometry,
	Sprite,
	SpriteMaterial,
	SRGBColorSpace,
	TorusGeometry,
} from 'three';
import { createRenderer } from '../webgl-support.js';

// Matches the classic docs theme (--docs-bg / --docs-accent) so switching
// surfaces reads as one product.
const BG = 0x09090f;
const ACCENT = 0x8b5cf6;

export const WORLD_RADIUS = 38; // player walk bound
export const RING_RADIUS = 24; // pavilion ring
export const PAVILION_TRIGGER = 4.2; // proximity that arms "enter section"

// Stable per-section colour: golden-angle hue walk from the docs purple, so
// any number of sections stays evenly distributed and recognisable.
export function sectionColor(i) {
	const c = new Color();
	c.setHSL(((262 + i * 137.5) % 360) / 360, 0.62, 0.62);
	return c;
}

function makeLabelTexture(title, sub, colorHex) {
	const dpr = Math.min(2, globalThis.devicePixelRatio || 1);
	const w = 512 * dpr;
	const h = 160 * dpr;
	const canvas = document.createElement('canvas');
	canvas.width = w;
	canvas.height = h;
	const ctx = canvas.getContext('2d');
	ctx.scale(dpr, dpr);

	const rw = 512;
	const rh = 160;
	ctx.fillStyle = 'rgba(12, 12, 22, 0.82)';
	ctx.strokeStyle = colorHex;
	ctx.lineWidth = 2.5;
	ctx.beginPath();
	// Safari < 16 has no ctx.roundRect; trace the same shape by hand.
	if (typeof ctx.roundRect === 'function') {
		ctx.roundRect(6, 6, rw - 12, rh - 12, 22);
	} else {
		const x = 6, y = 6, w2 = rw - 12, h2 = rh - 12, r = 22;
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + w2, y, x + w2, y + h2, r);
		ctx.arcTo(x + w2, y + h2, x, y + h2, r);
		ctx.arcTo(x, y + h2, x, y, r);
		ctx.arcTo(x, y, x + w2, y, r);
		ctx.closePath();
	}
	ctx.fill();
	ctx.globalAlpha = 0.85;
	ctx.stroke();
	ctx.globalAlpha = 1;

	ctx.textAlign = 'center';
	ctx.fillStyle = '#f4f1ff';
	ctx.font = '600 44px Inter, system-ui, sans-serif';
	ctx.fillText(title, rw / 2, sub ? 74 : 92, rw - 60);
	if (sub) {
		ctx.fillStyle = 'rgba(228, 223, 255, 0.66)';
		ctx.font = '400 28px Inter, system-ui, sans-serif';
		ctx.fillText(sub, rw / 2, 118, rw - 80);
	}

	const tex = new CanvasTexture(canvas);
	tex.colorSpace = SRGBColorSpace;
	tex.anisotropy = 4;
	return tex;
}

function makeLabelSprite(title, sub, colorHex, scale = 1) {
	const material = new SpriteMaterial({
		map: makeLabelTexture(title, sub, colorHex),
		transparent: true,
		depthWrite: false,
	});
	const sprite = new Sprite(material);
	sprite.scale.set(6.4 * scale, 2 * scale, 1);
	return sprite;
}

function makeGroundTexture(sectionCount) {
	const size = 1024;
	const canvas = document.createElement('canvas');
	canvas.width = size;
	canvas.height = size;
	const ctx = canvas.getContext('2d');
	const c = size / 2;

	const base = ctx.createRadialGradient(c, c, 0, c, c, c);
	base.addColorStop(0, '#12121f');
	base.addColorStop(0.45, '#0d0d17');
	base.addColorStop(1, '#09090f');
	ctx.fillStyle = base;
	ctx.fillRect(0, 0, size, size);

	// Spokes from the plaza out to each pavilion, plus plaza + ring roads.
	ctx.strokeStyle = 'rgba(139, 92, 246, 0.16)';
	ctx.lineWidth = 10;
	const ringPx = (RING_RADIUS / WORLD_RADIUS) * c * 0.96;
	for (let i = 0; i < sectionCount; i++) {
		const a = (i / sectionCount) * Math.PI * 2;
		ctx.beginPath();
		ctx.moveTo(c + Math.cos(a) * c * 0.1, c + Math.sin(a) * c * 0.1);
		ctx.lineTo(c + Math.cos(a) * ringPx, c + Math.sin(a) * ringPx);
		ctx.stroke();
	}
	ctx.lineWidth = 6;
	ctx.strokeStyle = 'rgba(139, 92, 246, 0.2)';
	ctx.beginPath();
	ctx.arc(c, c, c * 0.1, 0, Math.PI * 2);
	ctx.stroke();
	ctx.strokeStyle = 'rgba(139, 92, 246, 0.1)';
	ctx.beginPath();
	ctx.arc(c, c, ringPx, 0, Math.PI * 2);
	ctx.stroke();

	const tex = new CanvasTexture(canvas);
	tex.colorSpace = SRGBColorSpace;
	tex.anisotropy = 4;
	return tex;
}

function makeSkyDome() {
	// Vertex-coloured dome: near-black zenith into a purple horizon glow.
	const geo = new SphereGeometry(220, 24, 12);
	const pos = geo.attributes.position;
	const colors = new Float32Array(pos.count * 3);
	const top = new Color(0x08070f);
	const horizon = new Color(0x191330);
	const tmp = new Color();
	for (let i = 0; i < pos.count; i++) {
		const y = pos.getY(i) / 220; // -1..1
		const t = Math.max(0, Math.min(1, (y + 0.15) / 0.7));
		tmp.copy(horizon).lerp(top, t);
		colors[i * 3] = tmp.r;
		colors[i * 3 + 1] = tmp.g;
		colors[i * 3 + 2] = tmp.b;
	}
	geo.setAttribute('color', new BufferAttribute(colors, 3));
	return new Mesh(
		geo,
		new MeshBasicMaterial({ vertexColors: true, side: BackSide, fog: false, depthWrite: false }),
	);
}

function makeStars(count = 420) {
	const positions = new Float32Array(count * 3);
	for (let i = 0; i < count; i++) {
		// Random point on an upper-hemisphere shell so stars never sit below the
		// horizon glow.
		const r = 150 + Math.random() * 50;
		const theta = Math.random() * Math.PI * 2;
		const phi = Math.acos(0.12 + Math.random() * 0.85);
		positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
		positions[i * 3 + 1] = r * Math.cos(phi);
		positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
	}
	const geo = new BufferGeometry();
	geo.setAttribute('position', new BufferAttribute(positions, 3));
	const mat = new PointsMaterial({
		color: 0xbdb0ff,
		size: 0.9,
		sizeAttenuation: true,
		transparent: true,
		opacity: 0.75,
		fog: false,
		depthWrite: false,
	});
	return new Points(geo, mat);
}

/**
 * Build one pavilion: platform, portal ring + shimmer disc, floating label.
 * Returns the group plus the parts the frame loop animates.
 */
function buildPavilion(section, index, count) {
	const angle = (index / count) * Math.PI * 2;
	const color = sectionColor(index);
	const hex = '#' + color.getHexString();

	const group = new Group();
	group.position.set(Math.cos(angle) * RING_RADIUS, 0, Math.sin(angle) * RING_RADIUS);
	// Face the plaza so portals read from spawn.
	group.rotation.y = -angle - Math.PI / 2;

	const platform = new Mesh(
		new CylinderGeometry(2.6, 2.9, 0.28, 28),
		new MeshStandardMaterial({
			color: 0x14141f,
			roughness: 0.85,
			metalness: 0.15,
			emissive: color,
			emissiveIntensity: 0.05,
		}),
	);
	platform.position.y = 0.14;
	group.add(platform);

	const rim = new Mesh(
		new TorusGeometry(2.75, 0.05, 10, 48),
		new MeshBasicMaterial({ color, transparent: true, opacity: 0.7 }),
	);
	rim.rotation.x = Math.PI / 2;
	rim.position.y = 0.29;
	group.add(rim);

	const portal = new Mesh(
		new TorusGeometry(1.45, 0.075, 12, 48),
		new MeshStandardMaterial({
			color: 0x11101c,
			roughness: 0.4,
			metalness: 0.5,
			emissive: color,
			emissiveIntensity: 1.1,
		}),
	);
	portal.position.y = 1.9;
	group.add(portal);

	const shimmer = new Mesh(
		new CircleGeometry(1.36, 40),
		new MeshBasicMaterial({
			color,
			transparent: true,
			opacity: 0.16,
			blending: AdditiveBlending,
			depthWrite: false,
		}),
	);
	shimmer.position.y = 1.9;
	group.add(shimmer);

	const pageCount = section.links.filter((l) => l.path).length;
	const label = makeLabelSprite(
		section.title,
		pageCount === 1 ? '1 page' : pageCount + ' pages',
		hex,
	);
	label.position.y = 3.6;
	group.add(label);

	return { group, portal, shimmer, label, angle, color, hex, section, index };
}

/**
 * Build the whole scene.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{title:string, links:Array}>} sections nav.json sections
 * @param {{ reducedMotion?: boolean }} [opts]
 */
export function createDocsWorld(canvas, sections, { reducedMotion = false } = {}) {
	const renderer = createRenderer(
		{ canvas, antialias: true, powerPreference: 'high-performance' },
		{ fallback: canvas.parentElement },
	);
	renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));

	const scene = new Scene();
	scene.background = new Color(BG);
	scene.fog = new Fog(BG, 46, 150);

	const camera = new PerspectiveCamera(58, 1, 0.1, 400);
	camera.position.set(0, 3, 9);

	scene.add(new HemisphereLight(0x8578c8, 0x0a0a14, 1.05));
	const sun = new DirectionalLight(0xcabfff, 1.35);
	sun.position.set(14, 26, 10);
	scene.add(sun);

	scene.add(makeSkyDome());
	const stars = makeStars();
	scene.add(stars);

	const ground = new Mesh(
		new CircleGeometry(WORLD_RADIUS + 4, 72),
		new MeshStandardMaterial({
			map: makeGroundTexture(sections.length),
			roughness: 0.94,
			metalness: 0.05,
		}),
	);
	ground.rotation.x = -Math.PI / 2;
	scene.add(ground);

	const boundary = new Mesh(
		new RingGeometry(WORLD_RADIUS + 1.2, WORLD_RADIUS + 1.5, 96),
		new MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.28 }),
	);
	boundary.rotation.x = -Math.PI / 2;
	boundary.position.y = 0.02;
	scene.add(boundary);

	// Central beacon: a slim monolith marking spawn, labelled with the surface
	// name so a shared screenshot explains itself.
	const beacon = new Group();
	const pillar = new Mesh(
		new CylinderGeometry(0.16, 0.28, 3.4, 10),
		new MeshStandardMaterial({
			color: 0x191828,
			roughness: 0.35,
			metalness: 0.6,
			emissive: ACCENT,
			emissiveIntensity: 0.7,
		}),
	);
	pillar.position.y = 1.7;
	beacon.add(pillar);
	const beaconLabel = makeLabelSprite('three.ws Docs World', 'walk to a pavilion to read', '#8b5cf6', 0.8);
	// Clear of the ring labels (which sit at y 3.6) so the two never stack.
	beaconLabel.position.y = 5.4;
	beacon.add(beaconLabel);
	scene.add(beacon);

	const pavilions = sections.map((s, i) => {
		const p = buildPavilion(s, i, sections.length);
		scene.add(p.group);
		return p;
	});

	function resize() {
		const w = canvas.clientWidth || canvas.parentElement?.clientWidth || innerWidth;
		const h = canvas.clientHeight || canvas.parentElement?.clientHeight || innerHeight;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
	}
	resize();

	let t = 0;
	function tick(dt) {
		// The beacon is a welcome sign, not a permanent overlay: once the visitor
		// walks out toward the ring it would sit on top of the pavilion labels
		// behind it, so fade it with distance. Deliberately ahead of the
		// reduced-motion guard below, since this is a response to the visitor's
		// own movement (not ambient decoration) and skipping it would strand the
		// sign at full opacity exactly for the people least able to look past it.
		const camDist = Math.hypot(camera.position.x, camera.position.z);
		beaconLabel.material.opacity = Math.max(0, Math.min(1, (16 - camDist) / 8));
		beaconLabel.visible = beaconLabel.material.opacity > 0.01;

		if (reducedMotion) return;
		t += dt;
		for (const p of pavilions) {
			p.shimmer.rotation.z += dt * 0.35;
			p.label.position.y = 3.6 + Math.sin(t * 0.9 + p.index) * 0.07;
			p.portal.material.emissiveIntensity = 1.1 + Math.sin(t * 1.6 + p.index * 2) * 0.25;
		}
		stars.rotation.y += dt * 0.004;
	}

	return { renderer, scene, camera, pavilions, resize, tick };
}
