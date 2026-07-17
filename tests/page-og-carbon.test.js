import { describe, it, expect } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import handler from '../api/page-og.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const p = (...parts) => resolve(repoRoot, ...parts);

// Drive the real handler with a minimal mock req/res and collect the PNG bytes
// it writes, so these assertions exercise the actual @vercel/og render path
// (the same code that runs in production), not a stubbed approximation.
async function render(query) {
	const chunks = [];
	let statusCode = 200;
	const headers = {};
	const res = {
		setHeader(k, v) {
			headers[k.toLowerCase()] = v;
		},
		end(buf) {
			if (buf) chunks.push(Buffer.from(buf));
		},
		get statusCode() {
			return statusCode;
		},
		set statusCode(v) {
			statusCode = v;
		},
	};
	await handler({ method: 'GET', url: `/api/page-og?${query}` }, res);
	return { body: Buffer.concat(chunks), headers, statusCode };
}

const TITLE = 'IBM Granite Guardian Tutorial';
const DESC = 'Governing autonomous AI agents: allow, review, block.';

describe('page-og — carbon variant', () => {
	it('vendors the three IBM Plex TTFs the carbon card depends on', () => {
		for (const f of [
			'IBMPlexSans-Regular.ttf',
			'IBMPlexSans-SemiBold.ttf',
			'IBMPlexMono-Regular.ttf',
		]) {
			const path = p('api/_lib/fonts', f);
			expect(existsSync(path), `${f} missing`).toBe(true);
			// A real TTF is tens of KB; guard against an empty/LFS-pointer stub.
			expect(statSync(path).size).toBeGreaterThan(10_000);
		}
	});

	it('renders a real PNG for ?v=carbon', async () => {
		const { body, headers, statusCode } = await render(
			`v=carbon&s=learn&t=${encodeURIComponent(TITLE)}&d=${encodeURIComponent(DESC)}&p=%2Fdocs`,
		);
		expect(statusCode).toBe(200);
		expect(headers['content-type']).toBe('image/png');
		// PNG magic number.
		expect(body.subarray(0, 4).toString('hex')).toBe('89504e47');
		expect(body.length).toBeGreaterThan(5_000);
	});

	it('still renders the default dark card when v is absent (no regression)', async () => {
		const { body, headers, statusCode } = await render(
			`s=learn&t=${encodeURIComponent(TITLE)}&d=${encodeURIComponent(DESC)}&p=%2Fdocs`,
		);
		expect(statusCode).toBe(200);
		expect(headers['content-type']).toBe('image/png');
		expect(body.subarray(0, 4).toString('hex')).toBe('89504e47');
	});

	it('carbon output differs from the default card (proves it did not silently fall back)', async () => {
		const q = `s=learn&t=${encodeURIComponent(TITLE)}&d=${encodeURIComponent(DESC)}&p=%2Fdocs`;
		const carbon = await render(`v=carbon&${q}`);
		const dflt = await render(q);
		expect(carbon.body.equals(dflt.body)).toBe(false);
	});
});
