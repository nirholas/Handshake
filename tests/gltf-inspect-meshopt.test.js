import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectModel } from '../src/gltf-inspect.js';

const avatar = (name) => resolve(process.cwd(), 'public/avatars', name);

// Most three.ws avatars are meshopt-compressed by the GLB optimization pipeline.
// ALL_EXTENSIONS registers EXT_meshopt_compression but glTF-Transform cannot
// DECODE it without the wasm decoder wired in as a dependency, so inspectModel
// threw `Please install extension dependency, "meshopt.decoder"` on every
// compressed model. The paid /api/x402/model-check route turned that throw into
// a 422 and the autonomous loop burned a $0.001 payment on it every 5 minutes
// (262 failures in 48h across michelle / xbot / cz / realistic-male /
// dancing-twerk, plus the cross-chain cost pipeline that pays the same route).
//
// A compressed avatar must inspect exactly like an uncompressed one: real
// geometry counts, not zeros and not a throw.
const MESHOPT_AVATARS = ['michelle.glb', 'cz.glb', 'realistic-male.glb', 'dancing-twerk.glb'];

function isMeshopt(bytes) {
	// The extension name lives in the GLB's JSON chunk near the head of the file.
	const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 65_536));
	return head.toString('utf8').includes('EXT_meshopt_compression');
}

describe('inspectModel with EXT_meshopt_compression', () => {
	for (const name of MESHOPT_AVATARS) {
		it.runIf(existsSync(avatar(name)))(`inspects a meshopt-compressed avatar: ${name}`, async () => {
			const bytes = new Uint8Array(readFileSync(avatar(name)));
			expect(isMeshopt(bytes)).toBe(true);

			const info = await inspectModel(bytes, { fileSize: bytes.byteLength });
			expect(info.extensionsUsed).toContain('EXT_meshopt_compression');
			// Decoding actually happened: compressed accessors resolve to real
			// vertex/triangle counts. A registered-but-undecoded extension throws
			// before this point, and a silently skipped one reports zeros.
			expect(info.counts.meshes).toBeGreaterThan(0);
			expect(info.counts.totalVertices).toBeGreaterThan(0);
			expect(info.counts.totalTriangles).toBeGreaterThan(0);
			// These are rigged humanoids, so the canonicalization verdict the loop
			// stores (rig_type / canonical_ready) must see the skin.
			expect(info.counts.skins).toBeGreaterThan(0);
			expect(info.counts.totalJoints).toBeGreaterThan(0);
		});
	}
});
