// Outline to world: the pure half of Portal.
//
// Given a SiteOutline (api/_lib/portal/outline.js) this returns a PortalWorld:
// a small, JSON-safe description of a walkable place. It is deliberately pure
// and dependency-free so the SAME function runs in three places and cannot
// drift between them: the browser renderer (src/portal/render.js), the server
// GLB exporter (api/_lib/portal/world-glb.js), and the published SDK
// (packages/portal). No three.js here, no DOM, no randomness that is not seeded.
//
// The mapping, so a reader can predict what a page will look like before
// loading it:
//
//   site            one plaza at the origin with the title monument, and one
//                   district per section arranged on a phyllotaxis spiral, so
//                   districts never collide and the walk between them is short.
//   section         one building. Height comes from its word count (log scale,
//                   so a 10,000 word essay is taller than a 500 word one but
//                   not twenty times taller). Footprint comes from how many
//                   blocks it holds. Heading level picks the silhouette.
//   link            one door on the building's perimeter, facing out. Internal
//                   links are portals (walk in, the world rebuilds there);
//                   external links are gates (walk in, the page opens).
//   image           one billboard beside the building, showing the real image.
//   code block      one monolith: a tall, dark slab with an emissive edge.
//
// Determinism: every position derives from the section index and a seed hashed
// from the page URL, so the same URL always builds the same city, and a share
// link always leads to the place the sharer saw.

export const WORLD_VERSION = 1;

/** Spacing constants, in metres. The avatar is ~1.8 m for scale. */
export const METRICS = Object.freeze({
	plazaRadius: 11,
	districtStep: 7.6,
	districtBase: 17,
	minBuilding: 4.5,
	maxBuilding: 13,
	minHeight: 3.5,
	maxHeight: 26,
	doorWidth: 1.6,
	doorHeight: 2.6,
	billboard: 3.2,
	groundPad: 26,
});

/** FNV-1a over a string: a stable 32-bit seed with no dependency. */
export function hashSeed(text) {
	let h = 0x811c9dc5;
	const s = String(text || '');
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

/** mulberry32: tiny, fast, well-distributed seeded PRNG. */
export function seededRandom(seed) {
	let a = seed >>> 0;
	return function next() {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Clamp helper. Inline maths stays readable when the bounds are named. */
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const round = (n) => Math.round(n * 1000) / 1000;

/**
 * Hue for a host, so a site looks like itself everywhere without stored art.
 * Mirrors the crew-colour idea already used elsewhere in the platform.
 */
export function paletteFor(outline) {
	const themed = hexToHsl(outline.themeColor);
	const hue = themed ? themed.h : hashSeed(outline.host) % 360;
	const sat = themed ? clamp(themed.s, 45, 85) : 62;
	return {
		primary: hslToHex(hue, sat, 56),
		secondary: hslToHex((hue + 28) % 360, sat, 44),
		accent: hslToHex((hue + 186) % 360, Math.min(92, sat + 18), 62),
		ground: hslToHex(hue, 18, 16),
		sky: hslToHex(hue, 30, 9),
		fog: hslToHex(hue, 26, 12),
		monolith: hslToHex((hue + 210) % 360, 24, 22),
	};
}

export function hexToHsl(hex) {
	const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
	if (!m) return null;
	const int = parseInt(m[1], 16);
	const r = ((int >> 16) & 255) / 255;
	const g = ((int >> 8) & 255) / 255;
	const b = (int & 255) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	if (max === min) return { h: 0, s: 0, l: l * 100 };
	const d = max - min;
	const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
	let h;
	if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
	else if (max === g) h = ((b - r) / d + 2) / 6;
	else h = ((r - g) / d + 4) / 6;
	return { h: h * 360, s: s * 100, l: l * 100 };
}

export function hslToHex(h, s, l) {
	const sat = clamp(s, 0, 100) / 100;
	const lum = clamp(l, 0, 100) / 100;
	const c = (1 - Math.abs(2 * lum - 1)) * sat;
	const hp = (((h % 360) + 360) % 360) / 60;
	const x = c * (1 - Math.abs((hp % 2) - 1));
	const [r1, g1, b1] =
		hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
	const m = lum - c / 2;
	const to = (v) => Math.round(clamp((v + m) * 255, 0, 255)).toString(16).padStart(2, '0');
	return `#${to(r1)}${to(g1)}${to(b1)}`;
}

/** Where district `i` of `n` sits: a phyllotaxis spiral, so nothing collides. */
export function districtPosition(index) {
	const golden = Math.PI * (3 - Math.sqrt(5));
	const angle = index * golden;
	const radius = METRICS.districtBase + METRICS.districtStep * Math.sqrt(index);
	return { x: round(Math.cos(angle) * radius), z: round(Math.sin(angle) * radius), angle };
}

/**
 * Build the world.
 * @param {object} outline SiteOutline
 * @param {{ seed?: number }} [opts]
 * @returns {object} PortalWorld
 */
export function buildWorld(outline, opts = {}) {
	if (!outline || !Array.isArray(outline.sections)) {
		throw new TypeError('buildWorld: an outline with sections is required');
	}
	const seed = Number.isFinite(opts.seed) ? opts.seed >>> 0 : hashSeed(outline.canonical || outline.url);
	const rand = seededRandom(seed);
	const palette = paletteFor(outline);

	const buildings = [];
	const doors = [];
	const props = [];
	const districts = [];

	outline.sections.forEach((section, i) => {
		const pos = districtPosition(i);
		const facing = Math.atan2(-pos.z, -pos.x); // every building faces the plaza
		const weight = Math.log10(Math.max(10, section.words)) - 1; // 0 at 10 words, 1 at 100, 2 at 1000
		const height = round(clamp(METRICS.minHeight + weight * 7 + section.paragraphs * 0.35, METRICS.minHeight, METRICS.maxHeight));
		const width = round(clamp(METRICS.minBuilding + section.paragraphs * 0.5 + rand() * 1.5, METRICS.minBuilding, METRICS.maxBuilding));
		const depth = round(clamp(width * (0.72 + rand() * 0.4), METRICS.minBuilding * 0.8, METRICS.maxBuilding));
		const kind = section.level === 1 ? 'tower' : section.level === 2 ? 'hall' : 'kiosk';
		const building = {
			id: `b-${section.id}`,
			sectionId: section.id,
			kind,
			label: section.heading,
			summary: section.summary,
			words: section.words,
			x: pos.x,
			z: pos.z,
			w: width,
			d: depth,
			h: kind === 'kiosk' ? round(Math.min(height, 6)) : height,
			rot: round(facing),
			color: i === 0 ? palette.primary : palette.secondary,
			floors: Math.max(1, Math.round(height / 3.2)),
		};
		buildings.push(building);
		districts.push({ id: `d-${section.id}`, sectionId: section.id, x: pos.x, z: pos.z, radius: round(Math.max(width, depth) * 0.9 + 3) });

		// Doors along the face that looks at the plaza, then wrapping the sides.
		section.links.forEach((link, li) => {
			const slot = doorSlot(building, li, section.links.length);
			doors.push({
				id: `door-${section.id}-${li}`,
				buildingId: building.id,
				href: link.href,
				label: link.text,
				internal: !!link.internal,
				x: round(slot.x),
				z: round(slot.z),
				yaw: round(slot.yaw),
				w: METRICS.doorWidth,
				h: METRICS.doorHeight,
				color: link.internal ? palette.accent : palette.primary,
			});
		});

		// Billboards fan out behind the building, angled back toward the plaza.
		section.images.forEach((img, ii) => {
			const spread = (ii - (section.images.length - 1) / 2) * 4.4;
			const back = Math.max(width, depth) * 0.5 + 3.2;
			const bx = pos.x + Math.cos(facing + Math.PI) * back + Math.cos(facing + Math.PI / 2) * spread;
			const bz = pos.z + Math.sin(facing + Math.PI) * back + Math.sin(facing + Math.PI / 2) * spread;
			props.push({
				id: `img-${section.id}-${ii}`,
				kind: 'billboard',
				x: round(bx),
				z: round(bz),
				yaw: round(facing),
				w: METRICS.billboard,
				h: round(METRICS.billboard * 0.62),
				src: img.src,
				label: img.alt,
				color: palette.accent,
			});
		});

		// One monolith per code block, capped, standing in a short row.
		const monoliths = Math.min(section.codeBlocks, 4);
		for (let ci = 0; ci < monoliths; ci++) {
			const spread = (ci - (monoliths - 1) / 2) * 2.4;
			const side = Math.max(width, depth) * 0.5 + 2.4;
			props.push({
				id: `code-${section.id}-${ci}`,
				kind: 'monolith',
				x: round(pos.x + Math.cos(facing + Math.PI / 2) * side + Math.cos(facing) * spread),
				z: round(pos.z + Math.sin(facing + Math.PI / 2) * side + Math.sin(facing) * spread),
				yaw: round(facing),
				w: 0.9,
				h: round(2.6 + rand() * 1.8),
				color: palette.monolith,
				label: 'code',
			});
		}
	});

	const groundRadius = round(
		Math.max(
			METRICS.plazaRadius + METRICS.groundPad,
			...buildings.map((b) => Math.hypot(b.x, b.z) + Math.max(b.w, b.d) + 12),
		),
	);

	return {
		version: WORLD_VERSION,
		meta: {
			url: outline.url,
			canonical: outline.canonical,
			host: outline.host,
			title: outline.title,
			description: outline.description,
			siteName: outline.siteName,
			lang: outline.lang,
			seed,
			words: outline.words,
			sections: outline.sections.length,
			links: outline.linkCounts,
		},
		palette,
		ground: { radius: groundRadius, color: palette.ground, sky: palette.sky, fog: palette.fog },
		plaza: { radius: METRICS.plazaRadius, monument: { label: outline.title, sub: outline.description || outline.host, h: 5.4 } },
		spawn: { x: 0, z: METRICS.plazaRadius * 0.55, yaw: Math.PI },
		districts,
		buildings,
		doors,
		props,
	};
}

/**
 * Place door `index` of `count` on a building's perimeter, starting at the
 * plaza-facing wall and wrapping around, always flush to the wall and never
 * inside it.
 */
export function doorSlot(building, index, count) {
	const perFace = 2;
	const face = Math.floor(index / perFace) % 4;
	const withinFace = index % perFace;
	const spread = count <= 1 ? 0 : (withinFace - (Math.min(perFace, count) - 1) / 2) * (building.w * 0.42);
	const yaw = building.rot + (face * Math.PI) / 2;
	const half = (face % 2 === 0 ? building.d : building.w) / 2;
	const along = face % 2 === 0 ? building.w : building.d;
	const offset = count <= 1 ? 0 : clamp(spread, -along * 0.35, along * 0.35);
	return {
		x: building.x + Math.cos(yaw) * half + Math.cos(yaw + Math.PI / 2) * offset,
		z: building.z + Math.sin(yaw) * half + Math.sin(yaw + Math.PI / 2) * offset,
		yaw,
	};
}

/** Every solid the player collides with, as circles. Renderer and SDK share it. */
export function collidersFor(world) {
	const out = world.buildings.map((b) => ({ x: b.x, z: b.z, r: Math.max(b.w, b.d) * 0.5 + 0.35 }));
	for (const p of world.props) {
		if (p.kind === 'monolith') out.push({ x: p.x, z: p.z, r: p.w * 0.7 });
	}
	out.push({ x: 0, z: 0, r: 2.2 });
	return out;
}
