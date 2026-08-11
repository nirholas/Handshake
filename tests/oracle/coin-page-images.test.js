// /oracle/coin/<mint> renders token art through the same-origin image proxy.
//
// Token art lives on public IPFS gateways, and roughly half of pump.fun art is
// a metadata JSON document sharing one `image_uri` column with the real image.
// Hot-linked, both fail in the browser: the gateway answers without CORS headers
// or with `application/json`, Chrome blocks it (ERR_BLOCKED_BY_ORB), and the
// coin page shows a broken hero icon plus one per related coin. /api/img exists
// to absorb exactly that (multi-gateway retry, one-hop metadata resolution,
// on-brand placeholder), so no image on this page may address a gateway
// directly. These pin the two render sites that regressed.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(resolve(ROOT, p), 'utf8');

const serverPage = read('api/oracle-share.js');
const clientPage = read('public/oracle-coin.js');

// Every <img src="${…}"> interpolation in a file, as its raw expression.
function imgSrcExpressions(source) {
	return [...source.matchAll(/<img[^>]*\ssrc="\$\{([^}]+)\}"/g)].map((m) => m[1]);
}

describe('server-rendered coin hero', () => {
	it('renders at least one image', () => {
		expect(imgSrcExpressions(serverPage).length).toBeGreaterThan(0);
	});

	it('routes every image through the proxy helper', () => {
		for (const expr of imgSrcExpressions(serverPage)) {
			expect(expr).toContain('proxiedImg(');
		}
	});

	it('builds proxy URLs against /api/img', () => {
		expect(serverPage).toContain('`/api/img?${q.toString()}`');
	});

	it('leaves a same-origin or relative source untouched', () => {
		// The helper only rewrites remote schemes; a local path must pass through
		// so an on-platform asset is never bounced through the proxy.
		expect(serverPage).toMatch(/if \(!raw \|\| !\/\^\(https\?\|ipfs\|ar\):\/i\.test\(raw\)\) return raw;/);
	});
});

describe('client-hydrated coin page', () => {
	it('renders at least one image', () => {
		expect(imgSrcExpressions(clientPage).length).toBeGreaterThan(0);
	});

	it('routes every image through the proxy helper', () => {
		for (const expr of imgSrcExpressions(clientPage)) {
			expect(expr).toContain('imgProxy(');
		}
	});

	it('builds proxy URLs against /api/img', () => {
		expect(clientPage).toContain('`/api/img?${q.toString()}`');
	});
});

describe('no gateway is addressed directly', () => {
	for (const [name, source] of [
		['api/oracle-share.js', serverPage],
		['public/oracle-coin.js', clientPage],
	]) {
		it(`${name} never hard-codes a public IPFS gateway host`, () => {
			expect(source).not.toMatch(/https:\/\/(ipfs\.io|dweb\.link|gateway\.pinata\.cloud|w3s\.link)\//);
		});
	}
});
