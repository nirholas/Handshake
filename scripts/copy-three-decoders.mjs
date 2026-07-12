// Copy the Draco + Basis (KTX2) decoder binaries shipped inside the `three`
// npm package into /public/three/ so the browser can fetch them from the same
// origin. Runs from `postinstall` so a fresh `npm ci` always lands the
// matching decoder versions for whichever three.js the lockfile pinned.
//
// The decoder binaries are NOT committed — `.gitignore` excludes
// /public/three/ — but they MUST be present in the deployed dist/ for
// /club to render (it loads a Draco-compressed venue GLB at runtime).

import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');

const src = join(repo, 'node_modules/three/examples/jsm/libs');
const out = join(repo, 'public/three');

if (!existsSync(src)) {
	console.warn(`[copy-three-decoders] ${src} not found — skipping. Run npm install first.`);
	process.exit(0);
}

// Copy draco/ (includes the wasm-fallback js shim and the wasm binary).
// Keep the upstream layout (decoder + decoder/gltf) — DRACOLoader resolves
// the gltf-flavoured decoder relative to setDecoderPath().
//
// Two destinations, both gitignored and regenerated here so the ~3.3 MB of
// binaries lives in the tree exactly once (in node_modules):
//   • /public/three/draco       — the main app (viewer, /club, forge-export)
//   • /public/scene-studio/draco — the Scene Studio subapp, whose loaders
//     (src/scene-studio/*, pages/scene.html) hardcode the /scene-studio/draco/
//     path. Serving them the same upstream binaries keeps the two in lockstep.
const dracoSrc = join(src, 'draco');
const dracoDests = [join(out, 'draco'), join(repo, 'public/scene-studio/draco')];
if (existsSync(dracoSrc)) {
	for (const dracoOut of dracoDests) {
		mkdirSync(dirname(dracoOut), { recursive: true });
		rmSync(dracoOut, { recursive: true, force: true });
		cpSync(dracoSrc, dracoOut, { recursive: true });
		console.log(`[copy-three-decoders] draco/ → ${dracoOut.replace(repo + '/', '')}`);
	}
} else {
	console.warn(`[copy-three-decoders] ${dracoSrc} not found`);
}

// Copy basis/ (basis_transcoder.js + .wasm for KTX2).
const basisSrc = join(src, 'basis');
const basisOut = join(out, 'basis');
if (existsSync(basisSrc)) {
	mkdirSync(dirname(basisOut), { recursive: true });
	rmSync(basisOut, { recursive: true, force: true });
	cpSync(basisSrc, basisOut, { recursive: true });
	console.log(`[copy-three-decoders] basis/ → ${basisOut.replace(repo + '/', '')}`);
} else {
	console.warn(`[copy-three-decoders] ${basisSrc} not found`);
}
