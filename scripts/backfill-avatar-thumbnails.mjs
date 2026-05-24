#!/usr/bin/env node
/**
 * Backfill PNG thumbnails for public avatars that don't have one yet.
 *
 * Renders each avatar's GLB in a headless Chromium via model-viewer,
 * captures a 1024×1024 PNG, and POSTs it to /api/avatars/thumbnail
 * (which uploads to R2 and updates the avatars row).
 *
 * Usage:
 *   ADMIN_BEARER=<token> ORIGIN=https://three.ws \
 *     node scripts/backfill-avatar-thumbnails.mjs
 *
 * The bearer token must have avatars:write scope and belong to a user with
 * is_admin=true (so it can update other users' avatars). Pass --limit=N to
 * cap how many avatars are processed in a single run; default 25.
 *
 * Each avatar takes ~4-6s to render. Run nightly or after large imports.
 */

import { chromium } from 'playwright';

const ORIGIN = process.env.ORIGIN || 'https://three.ws';
const ADMIN_BEARER = process.env.ADMIN_BEARER;
const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1]) || 25;
const VIEWPORT = 1024;

if (!ADMIN_BEARER) {
	console.error('ADMIN_BEARER env var required (must have avatars:write scope on an admin account).');
	process.exit(1);
}

const VIEWER_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<style>
	html,body { margin:0; padding:0; background: transparent; width:${VIEWPORT}px; height:${VIEWPORT}px; }
	model-viewer { width:100%; height:100%; --poster-color: transparent; background: transparent; }
</style>
<script type="module" src="https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js"></script>
</head>
<body>
	<model-viewer id="mv" interaction-prompt="none" exposure="1.05" shadow-intensity="0.7" tone-mapping="aces"></model-viewer>
</body></html>`;

async function fetchAvatarsNeedingThumbs() {
	const url = `${ORIGIN}/api/avatars/public?limit=200`;
	const r = await fetch(url);
	if (!r.ok) throw new Error(`fetch ${url}: HTTP ${r.status}`);
	const j = await r.json();
	return (j.avatars || []).filter((a) => !a.thumbnail_url && a.model_url);
}

async function captureAvatar(page, glbUrl) {
	await page.evaluate(async (src) => {
		const mv = document.getElementById('mv');
		mv.setAttribute('src', src);
		await new Promise((res, rej) => {
			const t = setTimeout(() => rej(new Error('model-viewer load timeout')), 20000);
			mv.addEventListener('load', () => { clearTimeout(t); res(); }, { once: true });
			mv.addEventListener('error', (e) => { clearTimeout(t); rej(new Error('load error')); }, { once: true });
		});
		// Frame and one extra render tick to let the camera settle.
		mv.cameraOrbit = '0deg 75deg auto';
		mv.fieldOfView = '30deg';
		await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
	}, glbUrl);

	const dataUrl = await page.evaluate(async () => {
		const mv = document.getElementById('mv');
		const blob = await mv.toBlob({ idealAspect: true, mimeType: 'image/png' });
		return await new Promise((res) => {
			const fr = new FileReader();
			fr.onloadend = () => res(fr.result);
			fr.readAsDataURL(blob);
		});
	});
	return dataUrl;
}

async function uploadThumbnail(avatarId, pngDataUrl) {
	const r = await fetch(`${ORIGIN}/api/avatars/thumbnail`, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${ADMIN_BEARER}`,
		},
		body: JSON.stringify({ avatar_id: avatarId, png_base64: pngDataUrl }),
	});
	if (!r.ok) {
		const text = await r.text().catch(() => '');
		throw new Error(`upload ${avatarId}: HTTP ${r.status} ${text.slice(0, 200)}`);
	}
	return r.json();
}

async function main() {
	console.log(`[backfill] origin=${ORIGIN} limit=${LIMIT}`);
	const todo = (await fetchAvatarsNeedingThumbs()).slice(0, LIMIT);
	console.log(`[backfill] ${todo.length} avatar(s) need thumbnails`);
	if (!todo.length) return;

	const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
	const ctx = await browser.newContext({
		viewport: { width: VIEWPORT, height: VIEWPORT },
		deviceScaleFactor: 1,
	});
	const page = await ctx.newPage();
	await page.setContent(VIEWER_HTML, { waitUntil: 'load' });
	// Wait for model-viewer custom element to be defined.
	await page.waitForFunction(() => !!customElements.get('model-viewer'));

	let okCount = 0;
	let failCount = 0;
	for (const a of todo) {
		const tag = `${a.id} (${a.name || a.slug || '?'})`;
		try {
			console.log(`[backfill] rendering ${tag}…`);
			const dataUrl = await captureAvatar(page, a.model_url);
			const result = await uploadThumbnail(a.id, dataUrl);
			console.log(`[backfill] ✓ ${tag} → ${result?.data?.thumbnail_url} (${result?.data?.bytes} bytes)`);
			okCount++;
		} catch (err) {
			console.error(`[backfill] ✗ ${tag}: ${err.message}`);
			failCount++;
		}
	}

	await browser.close();
	console.log(`[backfill] done — ${okCount} ok, ${failCount} failed`);
}

main().catch((err) => {
	console.error('[backfill] fatal:', err);
	process.exit(1);
});
