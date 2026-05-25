#!/usr/bin/env node
// Strip the VitePWA <script id="vite-plugin-pwa:register-sw"> tag from every
// embed-surface HTML in dist/. Runs as a post-build step (see package.json
// `build` script) so it executes after VitePWA has already injected the
// registration tag.
//
// Why this matters:
//   Embed surfaces (/widget, /embed, /agent-embed, /a-embed, /avatar-embed)
//   are loaded in third-party iframes. Registering a service worker from
//   inside one of those iframes installs an SW scoped to https://three.ws/,
//   which then intercepts every other tab/page on the same origin. That's a
//   privacy + correctness hazard for anyone embedding our widget — they
//   never consented to running our SW, and any cache pollution affects
//   pages they have no control over.
//
// Doing this as a separate script (rather than a Vite plugin) means it runs
// reliably regardless of plugin ordering between VitePWA and our own
// transformIndexHtml hook. Idempotent — running it twice is a no-op.

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const EMBED_ENTRIES = new Set([
	'widget.html',
	'embed.html',
	'avatar-embed.html',
	'agent-embed.html',
	'a-embed.html',
	'agent-token-page.html',
]);

const REGISTER_SW_RE =
	/<script[^>]*id=["']vite-plugin-pwa:register-sw["'][^>]*><\/script>\s*/g;

const distDir = process.argv[2] || 'dist';

if (!existsSync(distDir)) {
	console.error(`[strip-sw] dist directory not found: ${distDir}`);
	process.exit(2);
}

const stripped = [];
const scanned = [];

function walk(dir) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const name of entries) {
		const full = join(dir, name);
		let s;
		try {
			s = statSync(full);
		} catch {
			continue;
		}
		if (s.isDirectory()) {
			walk(full);
			continue;
		}
		if (!EMBED_ENTRIES.has(name)) continue;
		scanned.push(full);
		const html = readFileSync(full, 'utf8');
		if (!REGISTER_SW_RE.test(html)) continue;
		writeFileSync(full, html.replace(REGISTER_SW_RE, ''));
		stripped.push(full);
	}
}

walk(distDir);

if (!scanned.length) {
	console.warn(
		`[strip-sw] no embed HTMLs found in ${distDir}/ — did vite build write them?`,
	);
	process.exit(0);
}

if (stripped.length) {
	console.log(
		`[strip-sw] removed registerSW from ${stripped.length} file(s):`,
		stripped.map((p) => p.replace(distDir + '/', '')).join(', '),
	);
} else {
	console.log(
		`[strip-sw] all ${scanned.length} embed HTML(s) already clean.`,
	);
}
