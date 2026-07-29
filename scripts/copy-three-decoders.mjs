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

// Recursive rm races with the directory walk on overlay/network filesystems
// (codespaces, deploy worktrees with hardlinked node_modules) and throws
// ENOTEMPTY. Node retries those internally, but only when maxRetries is set —
// it defaults to 0. Without this a deploy build dies in prebuild.
function rmDir(dir) {
	rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

if (!existsSync(src)) {
	console.warn(`[copy-three-decoders] ${src} not found — skipping. Run npm install first.`);
	process.exit(0);
}

// Copy draco/ (includes the wasm-fallback js shim and the wasm binary).
// Keep the upstream layout (decoder + decoder/gltf) — DRACOLoader resolves
// the gltf-flavoured decoder relative to setDecoderPath().
//
// ONE destination. /public/three/draco serves every consumer: the main app
// (viewer, /club, forge-export) and the Scene Studio subapp, whose loaders
// (src/scene-studio/loader.js, src/scene-studio/vendor/js/Loader.js,
// pages/scene.html) point their setDecoderPath() at /three/draco/ too. Scene
// Studio used to get a byte-identical second copy at /public/scene-studio/draco
// — same source, same script, 3.3 MB of duplicate binaries in every deployed
// image for no benefit. Same-origin absolute paths make the shared copy work
// everywhere, so the duplicate is gone; the stale directory is removed below so
// an existing checkout doesn't keep serving an orphan.
const dracoSrc = join(src, 'draco');
const dracoOut = join(out, 'draco');
if (existsSync(dracoSrc)) {
	mkdirSync(dirname(dracoOut), { recursive: true });
	rmDir(dracoOut);
	cpSync(dracoSrc, dracoOut, { recursive: true });
	console.log(`[copy-three-decoders] draco/ → ${dracoOut.replace(repo + '/', '')}`);
} else {
	console.warn(`[copy-three-decoders] ${dracoSrc} not found`);
}

// Retired duplicate — drop it from checkouts that still carry it.
const legacyDraco = join(repo, 'public/scene-studio/draco');
if (existsSync(legacyDraco)) {
	rmDir(legacyDraco);
	console.log('[copy-three-decoders] removed stale public/scene-studio/draco (now served from /three/draco)');
}

// Copy basis/ (basis_transcoder.js + .wasm for KTX2).
const basisSrc = join(src, 'basis');
const basisOut = join(out, 'basis');
if (existsSync(basisSrc)) {
	mkdirSync(dirname(basisOut), { recursive: true });
	rmDir(basisOut);
	cpSync(basisSrc, basisOut, { recursive: true });
	console.log(`[copy-three-decoders] basis/ → ${basisOut.replace(repo + '/', '')}`);
} else {
	console.warn(`[copy-three-decoders] ${basisSrc} not found`);
}
