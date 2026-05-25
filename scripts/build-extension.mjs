// scripts/build-extension.mjs — bundle the Chrome extension for load-unpacked or Web Store.
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const src = join(root, 'extensions', 'walk-avatar');
const out = join(root, 'dist', 'extension');
const isProd = process.argv.includes('--prod');

mkdirSync(out, { recursive: true });
mkdirSync(join(out, 'icons'), { recursive: true });
mkdirSync(join(out, 'styles'), { recursive: true });

// Bundle JS files
await Promise.all([
	build({
		entryPoints: [join(src, 'background.js')],
		outfile: join(out, 'background.js'),
		bundle: true,
		format: 'esm',
		platform: 'browser',
		minify: isProd,
		sourcemap: !isProd,
		target: 'chrome109',
	}),
	build({
		entryPoints: [join(src, 'content.js')],
		outfile: join(out, 'content.js'),
		bundle: true,
		format: 'iife',
		platform: 'browser',
		minify: isProd,
		sourcemap: !isProd,
		target: 'chrome109',
		// Exclude chrome API from bundle — it's injected by the browser
		external: ['chrome'],
	}),
	build({
		entryPoints: [join(src, 'popup.js')],
		outfile: join(out, 'popup.js'),
		bundle: true,
		format: 'iife',
		platform: 'browser',
		minify: isProd,
		sourcemap: !isProd,
		target: 'chrome109',
		external: ['chrome'],
	}),
	build({
		entryPoints: [join(src, 'options.js')],
		outfile: join(out, 'options.js'),
		bundle: true,
		format: 'iife',
		platform: 'browser',
		minify: isProd,
		sourcemap: !isProd,
		target: 'chrome109',
		external: ['chrome'],
	}),
]);

// Copy static files
cpSync(join(src, 'manifest.json'), join(out, 'manifest.json'));
cpSync(join(src, 'popup.html'), join(out, 'popup.html'));
cpSync(join(src, 'options.html'), join(out, 'options.html'));
cpSync(join(src, 'icons'), join(out, 'icons'), { recursive: true });

// Write injected CSS (empty placeholder — content.js injects styles programmatically)
writeFileSync(join(out, 'styles', 'inject.css'), '/* reserved for injected styles */\n');

// Bump version in manifest for prod builds
if (isProd) {
	const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
	const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
	manifest.version = pkg.version || manifest.version;
	writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, '\t') + '\n');

	// Zip for Web Store submission
	const { execSync } = await import('child_process');
	const zipPath = join(root, 'dist', `extension-${manifest.version}.zip`);
	execSync(`cd "${out}" && zip -r "${zipPath}" .`);
	console.log(`\nZipped → dist/extension-${manifest.version}.zip`);
}

console.log(`\nExtension built → dist/extension/ (${isProd ? 'production' : 'dev'})`);
console.log('Load unpacked: chrome://extensions → Load unpacked → dist/extension/');
