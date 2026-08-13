// scripts/build-extension.mjs — bundle the Chrome extension for load-unpacked or Web Store.
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, 'extensions', 'walk-avatar');
const out = join(root, 'dist', 'extension');
const isProd = process.argv.includes('--prod');

// Start from a clean output dir so stale artifacts (e.g. dev source maps, or a
// removed entrypoint) never leak into the packaged zip.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(join(out, 'icons'), { recursive: true });

// Bundle JS files. background.js is an ESM service worker; everything else is a
// self-contained IIFE. content-narrator.js is a classic content script injected
// via chrome.scripting before content.js: it publishes a window global and is
// NOT imported by content.js, so esbuild must emit the two separately or
// chrome.scripting.executeScript fails on a missing file.
const ENTRYPOINTS = [
	{ file: 'background.js', format: 'esm', external: [] },
	{ file: 'content.js', format: 'iife', external: ['chrome'] },
	{ file: 'content-narrator.js', format: 'iife', external: ['chrome'] },
	{ file: 'popup.js', format: 'iife', external: ['chrome'] },
	{ file: 'options.js', format: 'iife', external: ['chrome'] },
];

await Promise.all(
	ENTRYPOINTS.map((e) => {
		if (!existsSync(join(src, e.file))) {
			throw new Error(`missing required extension entrypoint: ${e.file}`);
		}
		return build({
			entryPoints: [join(src, e.file)],
			outfile: join(out, e.file),
			bundle: true,
			format: e.format,
			platform: 'browser',
			minify: isProd,
			sourcemap: !isProd,
			target: 'chrome109',
			external: e.external,
		});
	}),
);

// Copy static files
cpSync(join(src, 'manifest.json'), join(out, 'manifest.json'));
cpSync(join(src, 'popup.html'), join(out, 'popup.html'));
cpSync(join(src, 'options.html'), join(out, 'options.html'));
cpSync(join(src, 'icons'), join(out, 'icons'), { recursive: true });
// Vendored third-party readability lib is injected as-is (large, pre-minified);
// copy it verbatim rather than re-bundling.
cpSync(join(src, 'vendor'), join(out, 'vendor'), { recursive: true });

// Copy stylesheets referenced by popup.html / options.html (e.g. popup.css).
// HTML pages load these as-is; without them the popup ships unstyled.
for (const file of readdirSync(src)) {
	if (file.endsWith('.css')) cpSync(join(src, file), join(out, file));
}

// Bump version in manifest for prod builds
if (isProd) {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
	manifest.version = pkg.version || manifest.version;
	writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, '\t') + '\n');

	// Zip for Web Store submission
	const { execSync } = await import('child_process');
	const zipPath = join(root, 'dist', `extension-${manifest.version}.zip`);
	// Remove any prior zip first — `zip -r` updates in place and would otherwise
	// retain stale entries (e.g. dev source maps) no longer in the output dir.
	rmSync(zipPath, { force: true });
	execSync(`cd "${out}" && zip -r "${zipPath}" .`);
	console.log(`\nZipped → dist/extension-${manifest.version}.zip`);
}

console.log(`\nExtension built → dist/extension/ (${isProd ? 'production' : 'dev'})`);
console.log('Load unpacked: chrome://extensions → Load unpacked → dist/extension/');
