// Stage the browser voice-loop runtime into /public/models/voice/runtime/ so the
// wake word and the VAD load every byte from three.ws itself.
//
// Why same-origin matters here and not only as a preference: this is an
// always-on microphone feature. A user who opts in is trusting us with a live
// mic, and a third-party CDN fetch on that path would put a stranger's server in
// the room. Serving the models ourselves means the audio path has exactly one
// origin, which is the claim the consent copy makes.
//
// What is staged (all from node_modules, so the lockfile pins the versions):
//   silero_vad_v5.onnx           @ricky0123/vad-web  (the MIT silero VAD)
//   vad.worklet.bundle.min.js    @ricky0123/vad-web  (its AudioWorklet)
//   ort-wasm-simd-threaded.mjs   onnxruntime-web     (the wasm loader)
//   ort-wasm-simd-threaded.wasm  onnxruntime-web     (the runtime itself)
//
// NOT staged here: the openWakeWord models under /public/models/voice/wake-word.
// Those are Apache-2.0 release artifacts from dscripka/openWakeWord v0.5.1 that
// no npm package ships, so they are committed as bytes rather than fetched at
// build time. A build that reaches out to GitHub is a build that fails when
// GitHub does.
//
// Runs from postinstall and prebuild, exactly like copy-three-decoders.mjs.
// /public/models/voice/runtime/ is gitignored; dist/ gets it from prebuild.

import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repo = resolve(__dirname, '..');
const out = join(repo, 'public/models/voice/runtime');

const files = [
	['node_modules/@ricky0123/vad-web/dist/silero_vad_v5.onnx', 'silero_vad_v5.onnx'],
	['node_modules/@ricky0123/vad-web/dist/vad.worklet.bundle.min.js', 'vad.worklet.bundle.min.js'],
	['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.mjs'],
	['node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.wasm'],
];

const missing = files.filter(([from]) => !existsSync(join(repo, from)));
if (missing.length === files.length) {
	console.warn('[copy-voice-models] no source files found, skipping. Run npm install first.');
	process.exit(0);
}

mkdirSync(out, { recursive: true });

let staged = 0;
for (const [from, name] of files) {
	const src = join(repo, from);
	if (!existsSync(src)) {
		console.warn(`[copy-voice-models] ${from} not found`);
		continue;
	}
	const dest = join(out, name);
	// Skip an identical restage so a repeated prebuild does not rewrite 11 MB.
	if (existsSync(dest) && statSync(dest).size === statSync(src).size) {
		staged++;
		continue;
	}
	copyFileSync(src, dest);
	staged++;
}
console.log(`[copy-voice-models] ${staged}/${files.length} → public/models/voice/runtime`);
