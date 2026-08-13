// Core-path test for the walk-avatar Chrome extension build
// (scripts/build-extension.mjs). Runs the real build and verifies the packaged
// output is loadable: every file the manifest references exists, the content
// scripts bundled as classic IIFEs, and the injection chain background.js
// executes (vendor/readability.js, content-narrator.js, content.js) is present.
import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist', 'extension');

describe('walk-avatar extension build', () => {
	beforeAll(() => {
		execFileSync('node', [join(root, 'scripts', 'build-extension.mjs')], {
			cwd: root,
			stdio: 'pipe',
		});
	});

	it('emits every entrypoint and static file', () => {
		for (const file of [
			'manifest.json',
			'background.js',
			'content.js',
			'content-narrator.js',
			'popup.html',
			'popup.js',
			'popup.css',
			'options.html',
			'options.js',
			'vendor/readability.js',
		]) {
			expect(existsSync(join(out, file)), `${file} missing from dist/extension`).toBe(true);
		}
	});

	it('manifest is valid MV3 and every referenced file exists', () => {
		const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
		expect(manifest.manifest_version).toBe(3);
		expect(manifest.background.service_worker).toBe('background.js');

		const referenced = [
			manifest.background.service_worker,
			manifest.action.default_popup,
			manifest.options_page,
			...Object.values(manifest.icons),
			...Object.values(manifest.action.default_icon),
		];
		for (const file of referenced) {
			expect(existsSync(join(out, file)), `manifest references missing file: ${file}`).toBe(true);
		}
		expect(manifest.permissions).toEqual(
			expect.arrayContaining(['storage', 'activeTab', 'scripting', 'tabs']),
		);
	});

	it('content scripts are classic bundles, not ES modules', () => {
		// chrome.scripting.executeScript({files}) injects classic scripts; a
		// stray top-level import/export would throw at injection time.
		for (const file of ['content.js', 'content-narrator.js', 'popup.js', 'options.js']) {
			const code = readFileSync(join(out, file), 'utf8');
			expect(/^\s*(import|export)\s/m.test(code), `${file} contains module syntax`).toBe(false);
		}
	});

	it('background.js keeps the injection chain the files actually shipped', () => {
		const bg = readFileSync(join(out, 'background.js'), 'utf8');
		const chain = bg.match(/files:\s*\[([^\]]+)\]/);
		expect(chain, 'background.js lost its chrome.scripting files list').toBeTruthy();
		for (const injected of chain[1].match(/'([^']+)'|"([^"]+)"/g) || []) {
			const file = injected.slice(1, -1);
			expect(existsSync(join(out, file)), `injected file not in bundle: ${file}`).toBe(true);
		}
	});
});
