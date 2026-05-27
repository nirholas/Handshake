/**
 * Puppeteer test: stages a dummy avatar in IndexedDB, opens /create-review,
 * clicks the On-Chain Identity tile, and screenshots the modal at desktop
 * and mobile viewports.
 */
import puppeteer from 'puppeteer';

const BASE = process.env.BASE_URL || 'http://localhost:5555';

async function stageGuestAvatar(page) {
	await page.evaluate(() => {
		return new Promise((resolve, reject) => {
			const DB_NAME = 'three-ws-guest';
			const STORE = 'avatars';
			const KEY = 'pending';
			const META_KEY = '3dagent:guest-avatar-meta';

			const req = indexedDB.open(DB_NAME, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
			};
			req.onsuccess = () => {
				const db = req.result;
				// Minimal valid GLB (empty glTF 2.0 binary container)
				const header = new ArrayBuffer(12 + 8 + 17);
				const view = new DataView(header);
				// GLB magic
				view.setUint32(0, 0x46546C67, true);
				view.setUint32(4, 2, true); // version 2
				view.setUint32(8, header.byteLength, true); // total length
				// JSON chunk
				view.setUint32(12, 17, true); // chunk length
				view.setUint32(16, 0x4E4F534A, true); // JSON type
				const json = '{"asset":{"version":"2.0"}}';
				// We need exactly 17 bytes of JSON padded. Let's redo this properly.
				const jsonStr = '{"asset":{"version":"2.0"}}';
				const jsonBytes = new TextEncoder().encode(jsonStr);
				const jsonPadded = jsonBytes.byteLength + ((4 - jsonBytes.byteLength % 4) % 4);
				const totalLen = 12 + 8 + jsonPadded;
				const buf = new ArrayBuffer(totalLen);
				const dv = new DataView(buf);
				dv.setUint32(0, 0x46546C67, true);
				dv.setUint32(4, 2, true);
				dv.setUint32(8, totalLen, true);
				dv.setUint32(12, jsonPadded, true);
				dv.setUint32(16, 0x4E4F534A, true);
				const arr = new Uint8Array(buf);
				arr.set(jsonBytes, 20);
				// Pad with spaces (0x20)
				for (let i = 20 + jsonBytes.byteLength; i < 20 + jsonPadded; i++) arr[i] = 0x20;

				const blob = new Blob([buf], { type: 'model/gltf-binary' });
				const id = 'test-' + Math.random().toString(36).slice(2, 8);
				const record = {
					blob,
					meta: { source: 'three-ws-selfie', name: 'Test Avatar' },
					id,
					name: 'Test Avatar',
					size: blob.size,
					createdAt: Date.now(),
				};

				const tx = db.transaction(STORE, 'readwrite');
				const store = tx.objectStore(STORE);
				store.put(record, KEY);
				tx.oncomplete = () => {
					localStorage.setItem(META_KEY, JSON.stringify({
						id, name: 'Test Avatar', size: blob.size,
						createdAt: Date.now(), source: 'three-ws-selfie',
					}));
					db.close();
					resolve();
				};
				tx.onerror = () => reject(tx.error);
			};
			req.onerror = () => reject(req.error);
		});
	});
}

async function run() {
	const browser = await puppeteer.launch({
		headless: true,
		args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
	});

	try {
		const page = await browser.newPage();

		page.on('pageerror', (err) => console.error('PAGE ERROR:', err.message));

		// Warm Vite's dep optimizer by hitting the homepage first
		await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 20000 });
		// Let Vite finish any dependency re-optimization (triggers 504 + reload)
		await new Promise(r => setTimeout(r, 5000));

		// Stage the avatar
		await stageGuestAvatar(page);
		console.log('Staged dummy avatar in IndexedDB');

		// ── Desktop viewport ──
		await page.setViewport({ width: 1280, height: 900 });
		// Navigate with retry — Vite may force a reload
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await page.goto(BASE + '/create-review', { waitUntil: 'networkidle2', timeout: 15000 });
				break;
			} catch (e) {
				console.log(`Navigation attempt ${attempt + 1} failed, retrying...`);
				await new Promise(r => setTimeout(r, 2000));
			}
		}
		// Wait for page JS to run (3D viewer will fail in headless — that's fine)
		await new Promise(r => setTimeout(r, 3000));

		// Click the identity tile via JS (avoids visibility/scroll issues)
		const found = await page.evaluate(() => {
			const tile = document.querySelector('.feature-tile[data-feature="identity"]');
			if (!tile) return false;
			tile.click();
			return true;
		});
		if (!found) {
			console.error('Could not find identity tile');
			await page.screenshot({ path: '/tmp/identity-debug.png', fullPage: true });
			console.log('Debug screenshot saved to /tmp/identity-debug.png');
			return;
		}
		await new Promise(r => setTimeout(r, 3000));

		await page.screenshot({ path: '/tmp/identity-desktop.png', fullPage: false });
		console.log('Desktop screenshot: /tmp/identity-desktop.png');

		// Check for console errors
		page.on('pageerror', (err) => console.error('PAGE ERROR:', err.message));

		// Close modal
		const closeBtn = await page.$('.fm-close');
		if (closeBtn) await closeBtn.click();
		await new Promise(r => setTimeout(r, 300));

		// ── Mobile viewport ──
		await page.setViewport({ width: 390, height: 844 });
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await page.goto(BASE + '/create-review', { waitUntil: 'networkidle2', timeout: 15000 });
				break;
			} catch (e) {
				console.log(`Mobile nav attempt ${attempt + 1} failed, retrying...`);
				await new Promise(r => setTimeout(r, 2000));
			}
		}
		await new Promise(r => setTimeout(r, 3000));

		await page.evaluate(() => {
			const tile = document.querySelector('.feature-tile[data-feature="identity"]');
			if (tile) tile.click();
		});
		await new Promise(r => setTimeout(r, 3000));
		await page.screenshot({ path: '/tmp/identity-mobile.png', fullPage: false });
		console.log('Mobile screenshot: /tmp/identity-mobile.png');

		// Grab any JS errors from the console
		const logs = [];
		page.on('console', (msg) => {
			if (msg.type() === 'error') logs.push(msg.text());
		});

		console.log('Done. Check /tmp/identity-desktop.png and /tmp/identity-mobile.png');
	} finally {
		await browser.close();
	}
}

run().catch((err) => {
	console.error(err);
	process.exit(1);
});
