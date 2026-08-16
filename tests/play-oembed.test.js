// Contract for the /play Coin Communities oEmbed provider (api/play-oembed.js).
//
// An oEmbed provider hands a third-party consumer (WordPress, Ghost, Discord,
// Notion, every iframely/embed.ly editor) an iframe it will render under OUR
// provider name. Three things therefore have to hold, and each one has already
// been wrong here:
//
//   1. The embed target is the canonical app origin, NEVER the request's Host
//      header. The handler used to echo `x-forwarded-host` straight into
//      `html` and `provider_url`, so one crafted request handed any consumer
//      an iframe pointing at an attacker's site, badged "three.ws".
//   2. The provider answers only for URLs in its own scheme. A foreign url is
//      a 404 per oembed.com, not a generic three.ws card.
//   3. The documented status codes are real: 400 without url, 501 for a format
//      the provider cannot produce, 405 for a non-GET.
//
// Driven end to end against the real default export; the handler needs no
// database, chain read, or network, so there is nothing to stub.

import { describe, it, expect } from 'vitest';

import handler from '../api/play-oembed.js';
import { env } from '../api/_lib/env.js';

const MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

async function invoke(url, { method = 'GET', headers = {} } = {}) {
	const chunks = [];
	const outHeaders = {};
	let statusCode = 200;
	const res = {
		setHeader(k, v) { outHeaders[k.toLowerCase()] = v; },
		getHeader(k) { return outHeaders[k.toLowerCase()]; },
		end(buf) { if (buf) chunks.push(Buffer.from(buf)); },
		get statusCode() { return statusCode; },
		set statusCode(v) { statusCode = v; },
		get headersSent() { return false; },
		get writableEnded() { return false; },
	};
	await handler({ method, url, headers: { host: 'three.ws', ...headers } }, res);
	const body = Buffer.concat(chunks).toString('utf8');
	return { body, headers: outHeaders, statusCode, json: () => JSON.parse(body) };
}

function oembedUrl(target, extra = '') {
	return `/api/play-oembed?url=${encodeURIComponent(target)}${extra}`;
}

describe('play oEmbed provider', () => {
	it('embeds a coin world from the canonical share link', async () => {
		const r = await invoke(oembedUrl(`${env.APP_ORIGIN}/play?coin=${MINT}`));
		expect(r.statusCode).toBe(200);
		expect(r.headers['content-type']).toContain('json+oembed');
		const p = r.json();
		expect(p.version).toBe('1.0');
		expect(p.type).toBe('rich');
		expect(p.provider_url).toBe(env.APP_ORIGIN);
		expect(p.html).toContain(`${env.APP_ORIGIN}/play?coin=${MINT}&amp;embed=1`);
		expect(p.thumbnail_url).toBe(`${env.APP_ORIGIN}/api/play-og?coin=${MINT}`);
		expect(p.thumbnail_width).toBe(1200);
		expect(p.thumbnail_height).toBe(630);
	});

	it('accepts the /play/<mint> path form', async () => {
		const p = (await invoke(oembedUrl(`${env.APP_ORIGIN}/play/${MINT}`))).json();
		expect(p.html).toContain(`coin=${MINT}`);
	});

	it('serves the coin-agnostic world when no mint is in the link', async () => {
		const p = (await invoke(oembedUrl(`${env.APP_ORIGIN}/play`))).json();
		expect(p.html).toContain(`${env.APP_ORIGIN}/play?embed=1`);
		expect(p.title).toBe('three.ws · Coin Communities');
	});

	it('ignores a mint that is not a Solana address', async () => {
		const p = (await invoke(oembedUrl(`${env.APP_ORIGIN}/play?coin=not-a-mint`))).json();
		expect(p.html).not.toContain('not-a-mint');
		expect(p.html).toContain(`${env.APP_ORIGIN}/play?embed=1`);
	});

	it('never frames a forged Host into the payload it hands a consumer', async () => {
		const forged = { 'x-forwarded-host': 'evil.example.com', host: 'evil.example.com' };
		const r = await invoke(oembedUrl(`${env.APP_ORIGIN}/play?coin=${MINT}`), { headers: forged });
		const p = r.json();
		expect(p.provider_url).toBe(env.APP_ORIGIN);
		expect(p.html).not.toContain('evil.example.com');
		expect(p.thumbnail_url).not.toContain('evil.example.com');
		expect(p.html).toContain(`${env.APP_ORIGIN}/play`);
	});

	it('404s a url that is not one of ours', async () => {
		const r = await invoke(oembedUrl('https://evil.example.com/play?coin=' + MINT));
		expect(r.statusCode).toBe(404);
		expect(r.json().error).toBe('not_found');
	});

	it('404s our own origin outside the /play surface', async () => {
		const r = await invoke(oembedUrl(`${env.APP_ORIGIN}/account`));
		expect(r.statusCode).toBe(404);
	});

	it('serves xml when the consumer asks for it', async () => {
		const r = await invoke(oembedUrl(`${env.APP_ORIGIN}/play?coin=${MINT}`, '&format=xml'));
		expect(r.statusCode).toBe(200);
		expect(r.headers['content-type']).toContain('text/xml');
		expect(r.body.startsWith('<?xml version="1.0"')).toBe(true);
		expect(r.body).toContain('<provider_url>https://three.ws</provider_url>');
		// The iframe markup must arrive escaped, not as live child elements.
		expect(r.body).toContain('&lt;iframe');
		expect(r.body).not.toContain('<iframe');
	});

	it('clamps consumer-supplied dimensions', async () => {
		const p = (await invoke(oembedUrl(`${env.APP_ORIGIN}/play`, '&maxwidth=99999&maxheight=1'))).json();
		expect(p.width).toBe(1920);
		expect(p.height).toBe(160);
	});

	it('rejects a format it cannot produce with 501', async () => {
		const r = await invoke(oembedUrl(`${env.APP_ORIGIN}/play`, '&format=yaml'));
		expect(r.statusCode).toBe(501);
		expect(r.json().error).toBe('unsupported_format');
	});

	it('requires the url parameter', async () => {
		const r = await invoke('/api/play-oembed');
		expect(r.statusCode).toBe(400);
		expect(r.json().error).toBe('invalid_request');
	});

	it('rejects a non-GET method', async () => {
		const r = await invoke(oembedUrl(`${env.APP_ORIGIN}/play`), { method: 'POST' });
		expect(r.statusCode).toBe(405);
		expect(r.json().error).toBe('method_not_allowed');
	});
});
