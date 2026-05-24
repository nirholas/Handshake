#!/usr/bin/env node
/**
 * Smoke-test the HuggingFace avatar-reconstruction provider against the live
 * tencent/Hunyuan3D-2 Space. Reads HF_TOKEN from .env / .env.local and submits
 * a single multi-view request with a public test image.
 *
 * Pass / fail criteria:
 *   - submit() returns { extJobId } whose status() echoes resultGlbUrl
 *   - resultGlbUrl is a fetchable .glb (HEAD returns 200)
 *
 * Usage:
 *   node scripts/smoke-hf-reconstruct.mjs
 *
 * The Space's queue + processing typically completes in 30-120s. Job dies
 * silently if it exceeds 280s.
 */

import { existsSync, readFileSync } from 'node:fs';

// Lightweight .env loader (matches set-r2-cors.mjs)
for (const path of ['.env', '.env.local']) {
	if (!existsSync(path)) continue;
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
		if (!m) continue;
		const [, key, raw] = m;
		if (process.env[key]) continue;
		let val = raw;
		if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
			val = val.slice(1, -1);
		}
		process.env[key] = val;
	}
}

if (!process.env.HF_TOKEN) {
	console.error('HF_TOKEN missing — put it in .env or .env.local');
	process.exit(1);
}

const { createRegenProvider } = await import('../api/_providers/huggingface.js');
const provider = createRegenProvider();

// Public CC-licensed portrait via Unsplash (head-and-shoulders, neutral background).
// If unreachable, the Space's preprocessor will fail and we'll see that error.
const TEST_IMAGE = 'https://images.unsplash.com/photo-1599566150163-29194dcaad36?w=512&q=80';

console.log('→ submitting reconstruct job to tencent/Hunyuan3D-2 (HF Space)');
console.log('  image:', TEST_IMAGE);
console.log('  this typically takes 30-120s; live progress is not surfaced.');

const t0 = Date.now();
let result;
try {
	result = await provider.submit({
		mode: 'reconstruct',
		params: { images: [TEST_IMAGE] },
		sourceUrl: TEST_IMAGE,
	});
} catch (err) {
	console.error('submit() failed:', err?.message || err);
	console.error('  code:', err?.code, 'status:', err?.status);
	process.exit(2);
}
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`✓ submit returned in ${elapsed}s`);

const status = await provider.status(result.extJobId);
console.log('  status:', status.status);
console.log('  resultGlbUrl:', status.resultGlbUrl);

// Verify the GLB URL is fetchable.
const head = await fetch(status.resultGlbUrl, {
	method: 'HEAD',
	headers: process.env.HF_TOKEN ? { authorization: `Bearer ${process.env.HF_TOKEN}` } : {},
});
if (!head.ok) {
	console.error(`! GLB URL not fetchable: ${head.status}`);
	process.exit(3);
}
const size = head.headers.get('content-length');
console.log(`✓ GLB is fetchable, size: ${size ? Math.round(Number(size) / 1024) + ' KB' : 'unknown'}`);
console.log('PASS — HF provider round-trips successfully.');
