// Client-side image URL resolution (src/ipfs.js) is a trust boundary.
//
// Every value that reaches proxiedImageURL() came from somewhere a stranger
// controls: the `?image=` parameter of a shared /play link, a pump.fun feed row,
// an avatar gallery record, or another player's room join options. The result is
// written straight into an <img src>, a Three.js TextureLoader, and (via
// cssBgImage) a CSS url(). So the resolver has to answer two questions
// correctly, every time: is this a renderable image source at all, and if it is
// cross-origin, does it go through the proxy?
//
// The audit that produced this test found /play?image=javascript:… passing
// through untouched. It could not execute from an <img src>, but it did produce
// an ERR_UNKNOWN_URL_SCHEME console error and a permanently broken tile, on a
// surface whose bar is a clean console. The fix is a scheme allowlist, and this
// is what holds it in place.
//
// Server-side fetching of the resolved URL is covered by api-img-proxy.test.js.

import { describe, it, expect } from 'vitest';
import { isSafeImageURL, proxiedImageURL, proxiedModelURL, resolveURI } from '../src/ipfs.js';

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

describe('isSafeImageURL', () => {
	it('accepts the schemes an image element can actually render', () => {
		for (const url of [
			'https://ipfs.io/ipfs/bafyexample',
			'http://example.com/art.png',
			'ipfs://bafyexample',
			'ar://sometransactionid',
			'blob:https://three.ws/6d9a-4c2f',
			'data:image/png;base64,iVBORw0KGgo=',
			'data:image/svg+xml,%3Csvg%2F%3E',
			'/api/img?url=x',
			'art/token.png',
		]) {
			expect(isSafeImageURL(url), url).toBe(true);
		}
	});

	it('refuses script schemes, HTML documents, and local-resource probes', () => {
		for (const url of [
			'javascript:window.x=1',
			'JaVaScRiPt:window.x=1',
			'   javascript:window.x=1',
			'vbscript:msgbox(1)',
			'data:text/html,<script>window.x=1</script>',
			'data:text/html;base64,PHNjcmlwdD4=',
			'data:application/javascript,alert(1)',
			'file:///etc/passwd',
			'about:blank',
		]) {
			expect(isSafeImageURL(url), url).toBe(false);
		}
	});

	it('refuses a scheme smuggled past a naive parser with a control character', () => {
		// Real browsers strip these before resolving, so "java\tscript:" is a live
		// URL. A regex that only looks for a leading "javascript:" would miss it.
		expect(isSafeImageURL('java\tscript:window.x=1')).toBe(false);
		expect(isSafeImageURL('java\nscript:window.x=1')).toBe(false);
		expect(isSafeImageURL('java\u0000script:window.x=1')).toBe(false);
	});

	it('refuses a scheme-less value carrying CSS/HTML breakout characters', () => {
		// The /play CSS-breakout payload. cssBgImage percent-encodes these before
		// they reach a style attribute, so nothing escapes the declaration, but the
		// value is still not art: passing it through cost a doomed relative-path
		// request and a 404 in the console on a surface whose bar is zero console
		// output. It is rejected at the source instead.
		for (const url of [
			'x");position:fixed;inset:0;z-index:2147483647;background:red;--x:url("y',
			'art.png";background:red',
			"art.png');background:red",
			'art<img>.png',
			'art .png',
			'art\\..png',
			'https://example.com/a");background:red;--x:url("b.png',
		]) {
			expect(isSafeImageURL(url), url).toBe(false);
		}
	});

	it('still accepts the ordinary paths and query strings real art uses', () => {
		// The tightening above must not cost a legitimate source. Query strings,
		// percent-encoding, dashes, dots and nested paths all stay valid.
		for (const url of [
			'/api/img?url=https%3A%2F%2Fipfs.io%2Fipfs%2Fbafy&seed=FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
			'/avatars/default.glb',
			'art/token-01.png',
			'https://cdn.example.com/a/b/c_d-e.f.png?v=2&x=1',
			'blob:https://three.ws/6d9a-4c2f',
		]) {
			expect(isSafeImageURL(url), url).toBe(true);
		}
	});

	it('refuses non-strings and empties rather than throwing on them', () => {
		for (const v of [null, undefined, 42, {}, [], '', '   ']) {
			expect(isSafeImageURL(v)).toBe(false);
		}
	});
});

describe('proxiedImageURL', () => {
	it('adds ?w= only when a width is asked for, and rounds it', () => {
		const plain = new URL(proxiedImageURL('https://cdn.example/art.png', MINT), 'http://l');
		expect(plain.searchParams.has('w')).toBe(false);
		const sized = new URL(proxiedImageURL('https://cdn.example/art.png', MINT, { width: 512 }), 'http://l');
		expect(sized.searchParams.get('w')).toBe('512');
		expect(sized.searchParams.get('url')).toBe('https://cdn.example/art.png');
		expect(sized.searchParams.get('seed')).toBe(MINT);
		const rounded = new URL(proxiedImageURL('https://cdn.example/art.png', '', { width: 191.6 }), 'http://l');
		expect(rounded.searchParams.get('w')).toBe('192');
	});

	it('ignores a width on a source that never reaches the proxy', () => {
		expect(proxiedImageURL('data:image/png;base64,AAAA', '', { width: 512 })).toBe('data:image/png;base64,AAAA');
		expect(proxiedImageURL('javascript:alert(1)', '', { width: 512 })).toBe('');
	});

	it('routes cross-origin art through the same-origin proxy, carrying the seed', () => {
		const out = proxiedImageURL('https://ipfs.io/ipfs/bafyexample', MINT);
		expect(out.startsWith('/api/img?')).toBe(true);
		const q = new URLSearchParams(out.slice(out.indexOf('?') + 1));
		expect(q.get('url')).toBe('https://ipfs.io/ipfs/bafyexample');
		expect(q.get('seed')).toBe(MINT);
	});

	it('resolves ipfs:// and ar:// to a working gateway before proxying', () => {
		const q = (u) => new URLSearchParams(proxiedImageURL(u).split('?')[1]).get('url');
		expect(q('ipfs://bafyexample')).toBe(resolveURI('ipfs://bafyexample'));
		expect(q('ar://sometransactionid')).toBe('https://arweave.net/sometransactionid');
	});

	it('leaves sources the browser can already load alone', () => {
		// No scheme, or a scheme that is already same-document: the proxy would add
		// a round trip and buy nothing.
		expect(proxiedImageURL('/api/img?url=x')).toBe('/api/img?url=x');
		expect(proxiedImageURL('data:image/png;base64,iVBORw0KGgo=')).toBe('data:image/png;base64,iVBORw0KGgo=');
		expect(proxiedImageURL('blob:https://three.ws/6d9a')).toBe('blob:https://three.ws/6d9a');
	});

	it('drops a hostile scheme instead of handing it to an image sink', () => {
		for (const url of [
			'javascript:window.x=1',
			'vbscript:msgbox(1)',
			'data:text/html,<script>window.x=1</script>',
			'file:///etc/passwd',
		]) {
			expect(proxiedImageURL(url, MINT), url).toBe('');
		}
	});

	it('gives protocol-relative art a scheme so it is proxied, not fetched raw', () => {
		const out = proxiedImageURL('//cdn.example.com/art.png', MINT);
		expect(out.startsWith('/api/img?')).toBe(true);
		expect(new URLSearchParams(out.split('?')[1]).get('url')).toBe('https://cdn.example.com/art.png');
		// A site-absolute path is NOT protocol-relative and must stay untouched.
		expect(proxiedImageURL('/art.png')).toBe('/art.png');
	});

	it('drops an absurdly long source rather than issuing the request', () => {
		// A shared link can carry kilobytes of `?image=`. Real art URLs are short,
		// and the proxy would refuse it upstream anyway, so it never leaves here.
		expect(proxiedImageURL('https://example.com/' + 'a'.repeat(9000) + '.png', MINT)).toBe('');
		expect(proxiedImageURL('https://example.com/' + 'a'.repeat(100) + '.png', MINT)).not.toBe('');
	});

	it('answers with an empty string, never undefined, for missing input', () => {
		// Callers branch on `if (coin.image)`, so a falsy answer is the contract.
		for (const v of [null, undefined, '', 0, {}]) {
			expect(proxiedImageURL(v)).toBe('');
		}
	});
});

describe('proxiedModelURL', () => {
	// Models have the same trust boundary as art and one extra failure mode: the
	// asset bucket's CORS policy allowlists the production origin by name, so a
	// GLB read straight from it dies inside model-viewer on every other origin
	// (partner embeds, notebooks, previews, a local audit run) as an
	// unrecoverable "Failed to fetch". /api/glb reads the same public object
	// server-side and answers with open CORS.
	const GLB = 'https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/forge/anon/model.glb';

	it('routes a cross-origin model through the same-origin GLB proxy', () => {
		const out = proxiedModelURL(GLB);
		expect(out.startsWith('/api/glb?')).toBe(true);
		expect(new URLSearchParams(out.split('?')[1]).get('src')).toBe(GLB);
	});

	it('resolves ipfs:// and ar:// to a gateway before proxying', () => {
		const src = (u) => new URLSearchParams(proxiedModelURL(u).split('?')[1]).get('src');
		expect(src('ipfs://bafyexample')).toBe(resolveURI('ipfs://bafyexample'));
		expect(src('ar://sometransactionid')).toBe('https://arweave.net/sometransactionid');
	});

	it('leaves sources the browser can already load alone', () => {
		expect(proxiedModelURL('/forge/local.glb')).toBe('/forge/local.glb');
		expect(proxiedModelURL('models/scene.glb')).toBe('models/scene.glb');
		expect(proxiedModelURL('blob:https://three.ws/6d9a')).toBe('blob:https://three.ws/6d9a');
	});

	it('drops a hostile scheme instead of handing it to a model sink', () => {
		for (const url of [
			'javascript:window.x=1',
			'vbscript:msgbox(1)',
			'data:text/html,<script>window.x=1</script>',
			'file:///etc/passwd',
			'',
		]) {
			expect(proxiedModelURL(url), url).toBe('');
		}
		expect(proxiedModelURL(null)).toBe('');
	});

	it('refuses a source too long to be a real model URL', () => {
		expect(proxiedModelURL('https://cdn.example/' + 'a'.repeat(3000) + '.glb')).toBe('');
	});

	it('gives a protocol-relative model the scheme the page is on', () => {
		const out = proxiedModelURL('//cdn.example/model.glb');
		expect(new URLSearchParams(out.split('?')[1]).get('src')).toBe('https://cdn.example/model.glb');
	});
});
