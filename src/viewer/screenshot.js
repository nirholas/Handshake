import { log } from '../shared/log.js';
const WATERMARK_URL = '/three.svg';
let watermarkImage = null;

// Fetched on first screenshot, not on import. Eagerly warming it cost every
// page that merely loads the viewer a request for an asset most visitors never
// use, and turned any transient network blip into a console error on pages
// where nothing had gone wrong. In-flight requests are shared so rapid captures
// issue one fetch, and a failure resolves to null rather than throwing: the
// watermark is decoration, and _capture already falls back to the bare canvas.
let watermarkPending = null;

function getWatermark() {
	if (watermarkImage) return Promise.resolve(watermarkImage);
	if (watermarkPending) return watermarkPending;

	watermarkPending = (async () => {
		let url;
		try {
			const res = await fetch(WATERMARK_URL);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const svgText = await res.text();
			url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
			const img = new Image();
			img.src = url;
			await new Promise((resolve, reject) => {
				img.onload = resolve;
				img.onerror = () => reject(new Error('watermark decode failed'));
			});
			watermarkImage = img;
			return watermarkImage;
		} catch (e) {
			// Not an error for the user: the screenshot still saves unwatermarked.
			log.warn('Watermark unavailable; saving screenshot without it:', e.message);
			return null;
		} finally {
			// The decoded image keeps its own copy of the pixels, so the object URL
			// has done its job either way.
			if (url) URL.revokeObjectURL(url);
			watermarkPending = null;
		}
	})();

	return watermarkPending;
}

function _capture(viewer) {
	return new Promise(async (resolve) => {
		viewer.renderer.render(viewer.scene, viewer.activeCamera);
		const canvas = viewer.renderer.domElement;

		const watermark = await getWatermark();

		if (!watermark) {
			canvas.toBlob(resolve, 'image/png');
			return;
		}

		const tempCanvas = document.createElement('canvas');
		const ctx = tempCanvas.getContext('2d');
		tempCanvas.width = canvas.width;
		tempCanvas.height = canvas.height;

		ctx.drawImage(canvas, 0, 0);

		const margin = canvas.width * 0.04;
		const h = canvas.width * 0.05;
		const w = (h / watermark.height) * watermark.width;
		ctx.globalAlpha = 0.7;
		ctx.drawImage(watermark, margin, canvas.height - h - margin, w, h);
		ctx.globalAlpha = 1.0;

		tempCanvas.toBlob(resolve, 'image/png');
	});
}

export async function captureScreenshot(viewer) {
	flashScreenshotFeedback(viewer);
	return await _capture(viewer);
}

export async function takeScreenshot(viewer) {
	const blob = await captureScreenshot(viewer);
	if (!blob) return;

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.download = `3d-screenshot-${timestamp}.png`;
	link.href = url;
	link.click();
	URL.revokeObjectURL(url);
}

export function flashScreenshotFeedback(viewer) {
	const overlay = document.createElement('div');
	overlay.className = 'screenshot-flash';
	viewer.el.appendChild(overlay);
	overlay.addEventListener('animationend', () => overlay.remove());
}
