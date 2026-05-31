/**
 * Real-browser coverage for the GLB → USDZ conversion in
 * `src/usdz-pipeline.js`.
 *
 * three.js's USDZExporter reads raw image bytes through OffscreenCanvas /
 * drawImage paths that jsdom cannot honour, so the embedded-texture sample
 * GLB deadlocks the loader under Vitest (the byte-level cases there are
 * skipped with a pointer to this file). Here we drive real Chromium against
 * the Vite dev server and exercise the exporter end-to-end, asserting the
 * USDZ container is a well-formed ZIP with the right mime and a sane size.
 */

import { test, expect } from '@playwright/test';

test.describe('usdz-pipeline — GLB → USDZ in a real browser', () => {
	test('produces a PK-zip USDZ blob from the sample GLB', async ({ page }) => {
		// First import of usdz-pipeline pulls the full three.js + addons graph,
		// then exports a ~1 MB GLB — well past the default per-test budget.
		test.setTimeout(180_000);

		await page.goto('/');

		const result = await page.evaluate(async () => {
			const res = await fetch('/avatars/cz.glb');
			if (!res.ok) throw new Error(`sample GLB fetch failed: ${res.status}`);
			const glbBlob = await res.blob();
			const mod = await import('/src/usdz-pipeline.js');
			const out = await mod.glbBlobToUsdzBlob(glbBlob);
			const head = new Uint8Array(await out.slice(0, 4).arrayBuffer());
			return { type: out.type, size: out.size, magic: Array.from(head) };
		});

		expect(result.type).toBe('model/vnd.usdz+zip');
		expect(result.size).toBeGreaterThan(1000);
		// ZIP local-file-header magic: PK\x03\x04
		expect(result.magic).toEqual([0x50, 0x4b, 0x03, 0x04]);
	});
});
