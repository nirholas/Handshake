// three.ws Forge — deterministic generative 3D sculpture engine. Zero deps.
//
// A seed string → a one-of-one 3D form, synthesized from the Gielis
// superformula, encoded as a real binary GLB (positions, normals, gradient
// vertex colors, a PBR material). Same seed always yields identical bytes;
// a one-character change yields a completely different sculpture.
//
// Nothing here is random at runtime — all variation is derived from a hash of
// the seed, so the API is pure and cacheable.

// ── Deterministic PRNG (xmur3 seed → mulberry32) ─────────────────────────────
function xmur3(str) {
	let h = 1779033703 ^ str.length;
	for (let i = 0; i < str.length; i++) {
		h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	return () => {
		h = Math.imul(h ^ (h >>> 16), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		return (h ^= h >>> 16) >>> 0;
	};
}
function mulberry32(a) {
	return () => {
		a |= 0; a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function makeRng(seed) {
	const s = xmur3(String(seed));
	return mulberry32(s());
}

// ── Palettes / finishes (seed-selected) ──────────────────────────────────────
// Each finish carries PBR character + a 2-stop gradient (hue base, hsl).
const FINISHES = [
	{ name: 'Chrome', metallic: 1.0, roughness: 0.12, emissive: 0.0, hue: 210, sat: 0.06, glow: false },
	{ name: 'Obsidian', metallic: 0.6, roughness: 0.18, emissive: 0.0, hue: 270, sat: 0.45, glow: false },
	{ name: 'Plasma', metallic: 0.2, roughness: 0.35, emissive: 2.4, hue: 320, sat: 0.95, glow: true },
	{ name: 'Jade', metallic: 0.1, roughness: 0.28, emissive: 0.0, hue: 150, sat: 0.6, glow: false },
	{ name: 'Gold', metallic: 1.0, roughness: 0.22, emissive: 0.0, hue: 45, sat: 0.85, glow: false },
	{ name: 'Aurora', metallic: 0.35, roughness: 0.3, emissive: 1.6, hue: 175, sat: 0.9, glow: true },
	{ name: 'Magma', metallic: 0.3, roughness: 0.45, emissive: 2.2, hue: 18, sat: 1.0, glow: true },
	{ name: 'Frost', metallic: 0.5, roughness: 0.08, emissive: 0.2, hue: 195, sat: 0.4, glow: false },
];

const FORM_NAMES = ['Orb', 'Bloom', 'Star', 'Shard', 'Helix', 'Coral', 'Lotus', 'Spire', 'Nimbus', 'Vortex', 'Prism', 'Seed'];

function hslToRgb(h, s, l) {
	h = ((h % 360) + 360) % 360 / 360;
	const a = s * Math.min(l, 1 - l);
	const f = (n) => {
		const k = (n + h * 12) % 12;
		return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
	};
	return [f(0), f(8), f(4)];
}

// ── Trait derivation ─────────────────────────────────────────────────────────
function deriveTraits(seed) {
	const rng = makeRng(seed);
	const pick = (arr) => arr[Math.floor(rng() * arr.length)];
	const range = (lo, hi) => lo + rng() * (hi - lo);

	// Two superformula profiles (latitude + longitude). Curated ranges keep
	// shapes striking rather than degenerate.
	const m1 = Math.floor(range(2, 17));
	const m2 = Math.floor(range(2, 17));
	const prof = () => ({
		n1: range(0.3, 3.2),
		n2: range(0.4, 5.5),
		n3: range(0.4, 5.5),
	});
	const p1 = prof();
	const p2 = prof();
	const twist = range(-1.4, 1.4);
	const finish = pick(FINISHES);
	const hueShift = Math.floor(range(0, 40)) - 20;

	// Rarity: rare params (high symmetry + glow + extreme exponents) score higher.
	let rarity = 0;
	rarity += Math.max(m1, m2) * 2.2;
	rarity += finish.glow ? 22 : 0;
	rarity += p1.n1 < 0.7 || p2.n1 < 0.7 ? 16 : 0; // spiky
	rarity += Math.abs(twist) > 1.0 ? 12 : 0;
	rarity += rng() * 14;
	rarity = Math.min(100, Math.round(rarity));
	const tier = rarity >= 85 ? 'Mythic' : rarity >= 70 ? 'Legendary' : rarity >= 50 ? 'Epic' : rarity >= 30 ? 'Rare' : 'Common';
	const formName = FORM_NAMES[(m1 + m2) % FORM_NAMES.length];

	return {
		seed: String(seed),
		name: `${finish.name} ${formName}`,
		form: formName,
		finish: finish.name,
		symmetry: { lat: m1, lon: m2 },
		spikiness: Math.round((1 / Math.min(p1.n1, p2.n1)) * 100) / 100,
		twist: Math.round(twist * 100) / 100,
		rarity,
		tier,
		_p: { m1, m2, p1, p2, twist, finish, hueShift },
	};
}

// ── Superformula + mesh synthesis ────────────────────────────────────────────
function superR(angle, m, n1, n2, n3) {
	const t1 = Math.pow(Math.abs(Math.cos((m * angle) / 4)), n2);
	const t2 = Math.pow(Math.abs(Math.sin((m * angle) / 4)), n3);
	let r = Math.pow(t1 + t2, -1 / n1);
	if (!isFinite(r)) r = 0;
	return Math.min(r, 8); // clamp runaway spikes
}

function buildMesh(traits, resolution) {
	const { m1, m2, p1, p2, twist, finish, hueShift } = traits._p;
	const lat = resolution; // phi: -pi/2 .. pi/2
	const lon = resolution * 2; // theta: -pi .. pi
	const cols = lon + 1;
	const rows = lat + 1;
	const vCount = rows * cols;

	const positions = new Float32Array(vCount * 3);
	const normals = new Float32Array(vCount * 3);
	const colors = new Uint8Array(vCount * 4);

	const min = [Infinity, Infinity, Infinity];
	const max = [-Infinity, -Infinity, -Infinity];

	let v = 0;
	for (let i = 0; i < rows; i++) {
		const phi = -Math.PI / 2 + (i / lat) * Math.PI;
		const r2 = superR(phi, m2, p2.n1, p2.n2, p2.n3);
		for (let j = 0; j < cols; j++) {
			const theta = -Math.PI + (j / lon) * 2 * Math.PI;
			// twist couples longitude into latitude for spiral character
			const r1 = superR(theta + twist * phi, m1, p1.n1, p1.n2, p1.n3);
			const cx = r1 * Math.cos(theta) * r2 * Math.cos(phi);
			const cz = r1 * Math.sin(theta) * r2 * Math.cos(phi);
			const cy = r2 * Math.sin(phi);
			const k = v * 3;
			positions[k] = cx; positions[k + 1] = cy; positions[k + 2] = cz;
			if (cx < min[0]) min[0] = cx; if (cy < min[1]) min[1] = cy; if (cz < min[2]) min[2] = cz;
			if (cx > max[0]) max[0] = cx; if (cy > max[1]) max[1] = cy; if (cz > max[2]) max[2] = cz;
			v++;
		}
	}

	// Recenter + normalize to maxDim = 2 for a friendly default scale.
	const center = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
	const span = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1;
	const scale = 2 / span;
	for (let p = 0; p < vCount; p++) {
		positions[p * 3] = (positions[p * 3] - center[0]) * scale;
		positions[p * 3 + 1] = (positions[p * 3 + 1] - center[1]) * scale;
		positions[p * 3 + 2] = (positions[p * 3 + 2] - center[2]) * scale;
	}
	const nmin = [Infinity, Infinity, Infinity];
	const nmax = [-Infinity, -Infinity, -Infinity];
	for (let p = 0; p < vCount; p++) {
		for (let a = 0; a < 3; a++) {
			const val = positions[p * 3 + a];
			if (val < nmin[a]) nmin[a] = val;
			if (val > nmax[a]) nmax[a] = val;
		}
	}

	// Indices (two triangles per grid quad).
	const quadCount = lat * lon;
	const indices = new Uint32Array(quadCount * 6);
	let t = 0;
	for (let i = 0; i < lat; i++) {
		for (let j = 0; j < lon; j++) {
			const a = i * cols + j;
			const b = a + cols;
			indices[t++] = a; indices[t++] = b; indices[t++] = a + 1;
			indices[t++] = a + 1; indices[t++] = b; indices[t++] = b + 1;
		}
	}

	// Accumulate face normals → smooth vertex normals.
	for (let f = 0; f < indices.length; f += 3) {
		const ia = indices[f] * 3, ib = indices[f + 1] * 3, ic = indices[f + 2] * 3;
		const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
		const ux = positions[ib] - ax, uy = positions[ib + 1] - ay, uz = positions[ib + 2] - az;
		const wx = positions[ic] - ax, wy = positions[ic + 1] - ay, wz = positions[ic + 2] - az;
		const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
		normals[ia] += nx; normals[ia + 1] += ny; normals[ia + 2] += nz;
		normals[ib] += nx; normals[ib + 1] += ny; normals[ib + 2] += nz;
		normals[ic] += nx; normals[ic + 1] += ny; normals[ic + 2] += nz;
	}
	for (let p = 0; p < vCount; p++) {
		const k = p * 3;
		const len = Math.hypot(normals[k], normals[k + 1], normals[k + 2]) || 1;
		normals[k] /= len; normals[k + 1] /= len; normals[k + 2] /= len;
	}

	// Gradient vertex colors by normalized height, in the finish's hue family.
	const hSpan = nmax[1] - nmin[1] || 1;
	for (let p = 0; p < vCount; p++) {
		const h = (positions[p * 3 + 1] - nmin[1]) / hSpan; // 0..1 bottom→top
		const hue = finish.hue + hueShift + h * 40;
		const light = 0.32 + h * 0.42;
		const [r, g, bl] = hslToRgb(hue, finish.sat, light);
		const c = p * 4;
		colors[c] = Math.round(r * 255);
		colors[c + 1] = Math.round(g * 255);
		colors[c + 2] = Math.round(bl * 255);
		colors[c + 3] = 255;
	}

	return { positions, normals, colors, indices, vCount, min: nmin, max: nmax };
}

// ── GLB binary encoder (hand-written, zero deps) ─────────────────────────────
function align4(n) { return (n + 3) & ~3; }

function encodeGlb(mesh, traits) {
	const { positions, normals, colors, indices, vCount } = mesh;
	const { finish } = traits._p;

	// BIN layout — every accessor is naturally 4-byte aligned.
	const idxBytes = indices.byteLength;
	const posBytes = positions.byteLength;
	const normBytes = normals.byteLength;
	const colBytes = colors.byteLength;
	const binLen = idxBytes + posBytes + normBytes + colBytes;
	const bin = Buffer.alloc(binLen);
	let off = 0;
	Buffer.from(indices.buffer, indices.byteOffset, idxBytes).copy(bin, off); const idxOff = off; off += idxBytes;
	Buffer.from(positions.buffer, positions.byteOffset, posBytes).copy(bin, off); const posOff = off; off += posBytes;
	Buffer.from(normals.buffer, normals.byteOffset, normBytes).copy(bin, off); const normOff = off; off += normBytes;
	Buffer.from(colors.buffer, colors.byteOffset, colBytes).copy(bin, off); const colOff = off; off += colBytes;

	const baseColor = hslToRgb(finish.hue + traits._p.hueShift, finish.sat * 0.8, 0.6);
	const emissive = finish.glow ? hslToRgb(finish.hue, finish.sat, 0.5).map((c) => c * 0.6) : [0, 0, 0];

	const gltf = {
		asset: { version: '2.0', generator: 'three.ws Forge' },
		scene: 0,
		scenes: [{ nodes: [0] }],
		nodes: [{ mesh: 0, name: traits.name }],
		meshes: [{
			name: traits.name,
			primitives: [{
				attributes: { POSITION: 1, NORMAL: 2, COLOR_0: 3 },
				indices: 0,
				material: 0,
				mode: 4,
			}],
		}],
		materials: [{
			name: finish.name,
			pbrMetallicRoughness: {
				baseColorFactor: [baseColor[0], baseColor[1], baseColor[2], 1],
				metallicFactor: finish.metallic,
				roughnessFactor: finish.roughness,
			},
			emissiveFactor: emissive,
			doubleSided: true,
			...(finish.glow ? { extensions: { KHR_materials_emissive_strength: { emissiveStrength: finish.emissive } } } : {}),
		}],
		...(finish.glow ? { extensionsUsed: ['KHR_materials_emissive_strength'] } : {}),
		bufferViews: [
			{ buffer: 0, byteOffset: idxOff, byteLength: idxBytes, target: 34963 },
			{ buffer: 0, byteOffset: posOff, byteLength: posBytes, target: 34962 },
			{ buffer: 0, byteOffset: normOff, byteLength: normBytes, target: 34962 },
			{ buffer: 0, byteOffset: colOff, byteLength: colBytes, target: 34962 },
		],
		accessors: [
			{ bufferView: 0, componentType: 5125, count: indices.length, type: 'SCALAR' },
			{ bufferView: 1, componentType: 5126, count: vCount, type: 'VEC3', min: mesh.min, max: mesh.max },
			{ bufferView: 2, componentType: 5126, count: vCount, type: 'VEC3' },
			{ bufferView: 3, componentType: 5121, normalized: true, count: vCount, type: 'VEC4' },
		],
		buffers: [{ byteLength: binLen }],
	};

	const jsonBuf = Buffer.from(JSON.stringify(gltf), 'utf8');
	const jsonPad = align4(jsonBuf.length) - jsonBuf.length;
	const binPad = align4(bin.length) - bin.length;
	const total = 12 + 8 + jsonBuf.length + jsonPad + 8 + bin.length + binPad;

	const out = Buffer.alloc(total);
	let o = 0;
	out.writeUInt32LE(0x46546c67, o); o += 4; // magic "glTF"
	out.writeUInt32LE(2, o); o += 4; // version
	out.writeUInt32LE(total, o); o += 4; // total length
	// JSON chunk
	out.writeUInt32LE(jsonBuf.length + jsonPad, o); o += 4;
	out.writeUInt32LE(0x4e4f534a, o); o += 4; // "JSON"
	jsonBuf.copy(out, o); o += jsonBuf.length;
	for (let i = 0; i < jsonPad; i++) out[o++] = 0x20; // space pad
	// BIN chunk
	out.writeUInt32LE(bin.length + binPad, o); o += 4;
	out.writeUInt32LE(0x004e4942, o); o += 4; // "BIN\0"
	bin.copy(out, o); o += bin.length;
	for (let i = 0; i < binPad; i++) out[o++] = 0x00;

	return out;
}

// ── Public API ───────────────────────────────────────────────────────────────
export function forgeTraits(seed) {
	const t = deriveTraits(seed);
	const { _p, ...pub } = t;
	return pub;
}

export function forgeGlb(seed, resolution = 120) {
	// Ceiling keeps the base64 GLB under the Lambda Function URL 6 MB response cap.
	const res = Math.max(24, Math.min(190, Math.floor(resolution) || 120));
	const traits = deriveTraits(seed);
	const mesh = buildMesh(traits, res);
	const glb = encodeGlb(mesh, traits);
	const { _p, ...pub } = traits;
	return {
		glb,
		stats: { vertices: mesh.vCount, triangles: mesh.indices.length / 3, bytes: glb.length, resolution: res },
		traits: pub,
	};
}

// Raw mesh + full traits (incl. private finish params) for the software
// renderer that produces social-card preview images.
export function forgeRaw(seed, resolution = 90) {
	const res = Math.max(24, Math.min(220, Math.floor(resolution) || 90));
	const traits = deriveTraits(seed);
	const mesh = buildMesh(traits, res);
	return { mesh, traits };
}
