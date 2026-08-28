// Deterministic, allocation-free hashing for model content.
//
// Every "did this actually change?" question in the diff reduces to comparing
// two hashes, so the hash has to be three things at once: stable across
// re-exports, cheap enough to run over every vertex of a real avatar, and
// available in both Node and the browser (Web Crypto's digest is async and
// SubtleCrypto is https-only, which rules it out for a page that must work off
// a file:// scratch build).
//
// The construction is FNV-1a run in two independent 32-bit lanes with different
// offset bases, concatenated into a 128-bit-wide-looking 16-char hex string. Two
// lanes rather than one because a single 32-bit space collides at roughly 1 in
// 65k over 300 objects (birthday bound), which is far too often for a tool whose
// whole claim is "these two meshes are the same mesh".

const LANE_A_OFFSET = 0x811c9dc5;
const LANE_B_OFFSET = 0x01000193;
const PRIME = 0x01000193;

// Quantization step for float comparison. A re-export through Blender, gltfpack,
// or a Draco round trip perturbs positions in the 1e-6 range; genuine edits move
// vertices by orders of magnitude more. Rounding to 1e-4 of a unit (0.1mm at
// real-world scale) makes "unchanged geometry" survive the pipeline without
// letting a real edit hide.
export const FLOAT_QUANTUM = 1e4;

function mix(h, value) {
	return Math.imul(h ^ (value | 0), PRIME) >>> 0;
}

function toHex(a, b) {
	return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

/** Hash a UTF-16 string. Used for names, enums, and pre-serialized structures. */
export function hashString(str) {
	let a = LANE_A_OFFSET;
	let b = LANE_B_OFFSET;
	const s = String(str);
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		a = mix(a, c);
		b = mix(b, c + i);
	}
	return toHex(a, b);
}

/**
 * Hash a numeric array with float tolerance. Integer arrays (indices, joints)
 * pass through unquantized because rounding them would be lossy in the wrong
 * direction: index 3 and index 4 are not "nearly the same".
 * @param {ArrayLike<number>|null|undefined} arr
 * @param {{ quantize?: boolean, seed?: string }} [opts]
 */
export function hashNumbers(arr, opts = {}) {
	const quantize = opts.quantize !== false;
	let a = LANE_A_OFFSET;
	let b = LANE_B_OFFSET;
	if (opts.seed) {
		const seed = String(opts.seed);
		for (let i = 0; i < seed.length; i++) {
			a = mix(a, seed.charCodeAt(i));
			b = mix(b, seed.charCodeAt(i) + i);
		}
	}
	if (!arr) return toHex(a, b);
	const n = arr.length;
	a = mix(a, n);
	b = mix(b, n);
	for (let i = 0; i < n; i++) {
		const v = arr[i];
		const q = quantize ? Math.round(v * FLOAT_QUANTUM) : v;
		a = mix(a, q);
		b = mix(b, q / 4294967296);
	}
	return toHex(a, b);
}

/** Hash raw bytes. Used for encoded texture payloads, where the bytes are the truth. */
export function hashBytes(bytes) {
	let a = LANE_A_OFFSET;
	let b = LANE_B_OFFSET;
	if (!bytes) return toHex(a, b);
	const n = bytes.length;
	a = mix(a, n);
	b = mix(b, n);
	for (let i = 0; i < n; i++) {
		a = mix(a, bytes[i]);
		b = mix(b, bytes[i] + (i & 0xff));
	}
	return toHex(a, b);
}

/**
 * Hash an arbitrary JSON-safe value with key order normalized, so two objects
 * that differ only in property order hash the same. Numbers go through the same
 * quantization as vertex data, which is what lets a baseColorFactor that came
 * back as 0.7999999523162842 match the 0.8 it was authored as.
 */
export function hashValue(value) {
	return hashString(canonicalize(value));
}

export function canonicalize(value) {
	if (value === null || value === undefined) return 'null';
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) return String(value);
		return String(Math.round(value * FLOAT_QUANTUM) / FLOAT_QUANTUM);
	}
	if (typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}
