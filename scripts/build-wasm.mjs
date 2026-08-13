#!/usr/bin/env node
/**
 * Build the Rust vanity-grinder crate to WASM and normalize the output dir.
 *
 * `npm run build:wasm` runs this. It wraps `wasm-pack build` and then fixes
 * two things wasm-pack gets wrong for our layout, so the checked-in artifacts
 * in src/solana/vanity/wasm/ are fully reproducible from one command:
 *
 * 1. wasm-pack writes a default `*` .gitignore that excludes everything.
 *    The artifacts ARE checked in (the app must build without a Rust
 *    toolchain at install time), so we override it with `!*`.
 * 2. wasm-pack copies the crate's README.md into the out dir verbatim. That
 *    README's relative links only resolve from crates/vanity-grinder/, so we
 *    replace it with a README written for the out dir's actual location.
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, delimiter } from 'node:path';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
const outDir = join(repoRoot, 'src', 'solana', 'vanity', 'wasm');

const result = spawnSync(
	'wasm-pack',
	[
		'build',
		join(repoRoot, 'crates', 'vanity-grinder'),
		'--target',
		'web',
		'--release',
		'--out-dir',
		outDir,
	],
	{
		stdio: 'inherit',
		env: {
			...process.env,
			PATH: `${join(process.env.HOME || '', '.cargo', 'bin')}${delimiter}${process.env.PATH}`,
			// simd128 must be enabled at rustc level too, not just in wasm-opt,
			// or the hot loop compiles without SIMD and grinding throughput drops.
			RUSTFLAGS: '-C target-feature=+simd128',
		},
	},
);
if (result.error) {
	console.error('failed to launch wasm-pack (is it installed? `cargo install wasm-pack`)');
	console.error(String(result.error));
	process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

writeFileSync(
	join(outDir, '.gitignore'),
	[
		'# wasm-pack writes a default `*` gitignore that excludes everything.',
		'# Override it: the generated files in this directory ARE checked in so the',
		'# app builds without requiring a Rust toolchain at install time. Run',
		'# `npm run build:wasm` after editing /crates/vanity-grinder/src/lib.rs to',
		'# refresh these artifacts.',
		'!*',
		'',
	].join('\n'),
);

writeFileSync(
	join(outDir, 'README.md'),
	`# Generated WASM grinder

This directory contains the wasm-bindgen output of [\`/crates/vanity-grinder\`](../../../../crates/vanity-grinder).

**Do not edit by hand.** Edit the Rust source at \`crates/vanity-grinder/src/lib.rs\`,
then regenerate with:

\`\`\`bash
npm run build:wasm
\`\`\`

The artifacts are checked into the repo so the app builds without a Rust
toolchain at install time. CI only needs \`npm install\` + \`npm run build\`.
This README and the \`.gitignore\` are rewritten by
[scripts/build-wasm.mjs](../../../../scripts/build-wasm.mjs) after every
build, because wasm-pack would otherwise clobber them.

## Files

- \`vanity_grinder.js\`: wasm-bindgen glue (default export \`init\`, named exports \`grind\`, \`initSync\`)
- \`vanity_grinder_bg.wasm\`: the compiled WebAssembly module
- \`vanity_grinder.d.ts\`: TypeScript declarations
- \`vanity_grinder_bg.wasm.d.ts\`: low-level wasm imports declarations
- \`package.json\`: generated package metadata (not published)

## API

\`\`\`ts
import init, { grind } from './vanity_grinder.js';
import wasmUrl from './vanity_grinder_bg.wasm?url';

await init({ module_or_path: wasmUrl });

const seed = new Uint8Array(32);
crypto.getRandomValues(seed);
const hit = grind(prefix, suffix, ignoreCase, batchSize, seed);
// hit is either null or { secretKey: Uint8Array(64), publicKey: string }
\`\`\`

The 64-byte \`secretKey\` is Solana's standard layout
(\`[32-byte seed][32-byte public key]\`), compatible with
\`Keypair.fromSecretKey()\` in \`@solana/web3.js\`.
`,
);

console.log('build:wasm done: artifacts, README, and .gitignore refreshed in src/solana/vanity/wasm/');
