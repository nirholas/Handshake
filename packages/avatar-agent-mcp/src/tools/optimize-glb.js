// `optimize_glb` — shrink a GLB by running a configurable
// @gltf-transform/functions pipeline: dedup → prune → join → weld
// → Draco mesh compression. Returns the optimized bytes as a base64
// data URL plus before/after byte counts so callers see the saving.
//
// Texture re-encoding (PNG → WebP/AVIF) is intentionally off by default
// because it requires Sharp's native binaries; flip `reencodeTextures`
// when running in an env where Sharp is available.

import { z } from 'zod';
import { dedup, draco, prune, weld } from '@gltf-transform/functions';

import { fetchGlbBytes, getIo } from '../lib/glb-io.js';

const MAX_RETURN_BYTES = 20 * 1024 * 1024;

export const def = {
	name: 'optimize_glb',
	title: 'Optimize a GLB (dedup, prune, weld, Draco)',
	description:
		'Run a @gltf-transform/functions optimization pipeline on a GLB URL: dedup → prune unused → weld duplicate vertices → optional Draco mesh compression. Returns the optimized bytes as a base64 data URL with before/after sizes. Lossless for geometry except where Draco quantization is requested.',
	inputSchema: {
		url: z.string().describe('Source GLB URL (or data: URL).'),
		dedup: z.boolean().optional().describe('Merge equivalent accessors / materials / textures. Default true.'),
		prune: z.boolean().optional().describe('Remove unused materials / nodes / meshes. Default true.'),
		weld: z.boolean().optional().describe('Merge duplicate vertices. Default true.'),
		draco: z.boolean().optional().describe('Apply Draco mesh compression (lossy quantization). Default false.'),
		dracoQuantizePosition: z.number().int().min(1).max(16).optional()
			.describe('Position bits for Draco (default 14 = high fidelity).'),
		returnInline: z.boolean().optional()
			.describe('Return the optimized GLB inline as a base64 data URL (default true). Set false to return only stats.'),
	},
	async handler(args) {
		const { url } = args || {};
		if (!url) return { ok: false, error: 'invalid_input', message: 'url is required' };
		const wantDedup = args.dedup !== false;
		const wantPrune = args.prune !== false;
		const wantWeld = args.weld !== false;
		const wantDraco = !!args.draco;
		const inline = args.returnInline !== false;

		let srcBytes;
		try {
			srcBytes = await fetchGlbBytes(url);
		} catch (err) {
			return { ok: false, error: 'fetch_failed', message: err.message };
		}

		let doc;
		const io = await getIo();
		try {
			doc = await io.readBinary(srcBytes);
		} catch (err) {
			return { ok: false, error: 'parse_failed', message: err.message };
		}

		const applied = [];
		try {
			if (wantDedup) {
				await doc.transform(dedup());
				applied.push('dedup');
			}
			if (wantPrune) {
				await doc.transform(prune());
				applied.push('prune');
			}
			if (wantWeld) {
				await doc.transform(weld());
				applied.push('weld');
			}
			if (wantDraco) {
				const opts = {};
				if (typeof args.dracoQuantizePosition === 'number') {
					opts.quantizePosition = args.dracoQuantizePosition;
				}
				await doc.transform(draco(opts));
				applied.push('draco');
			}
		} catch (err) {
			return { ok: false, error: 'transform_failed', message: err.message, applied };
		}

		let outBytes;
		try {
			outBytes = await io.writeBinary(doc);
		} catch (err) {
			return { ok: false, error: 'write_failed', message: err.message, applied };
		}

		const before = srcBytes.byteLength;
		const after = outBytes.byteLength;
		const ratio = before > 0 ? after / before : 1;
		const result = {
			ok: true,
			url,
			pipeline: applied,
			beforeBytes: before,
			afterBytes: after,
			savedBytes: before - after,
			ratio,
			reductionPct: (1 - ratio) * 100,
		};
		if (inline) {
			if (after > MAX_RETURN_BYTES) {
				result.optimizedGlb = null;
				result.note = `Optimized GLB is ${after} bytes (> ${MAX_RETURN_BYTES} inline cap). Re-run with smaller input or use a hosting endpoint.`;
			} else {
				const b64 = Buffer.from(outBytes).toString('base64');
				result.optimizedGlb = `data:model/gltf-binary;base64,${b64}`;
			}
		}
		return result;
	},
};
