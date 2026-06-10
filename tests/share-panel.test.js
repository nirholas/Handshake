import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
	buildEmbedUrl,
	buildIframeSnippet,
	buildWebComponentSnippet,
} from '../src/share-panel-builders.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const p = (...parts) => resolve(repoRoot, ...parts);

const ORIGIN = 'https://three.ws/';
const ID = '9fc7f1ba-2f34-4d79-843b-9b34c27e0d72';

describe('share-panel — buildEmbedUrl', () => {
	it('uses the working /agent/{id}/embed path (not the broken /agent-embed.html?id=...)', () => {
		const url = buildEmbedUrl({ origin: ORIGIN, agentId: ID });
		expect(url).toBe(`${ORIGIN}/agent/${ID}/embed`);
		expect(url).not.toContain('/agent-embed.html');
	});

	it('omits default options from the query string for a clean canonical URL', () => {
		const url = buildEmbedUrl({ origin: ORIGIN, agentId: ID });
		expect(url).not.toContain('?');
	});

	it('adds bg=dark when background is dark', () => {
		const url = buildEmbedUrl({ origin: ORIGIN, agentId: ID, opts: { bg: 'dark' } });
		expect(url).toContain('bg=dark');
	});

	it('adds bg=light when background is light', () => {
		const url = buildEmbedUrl({ origin: ORIGIN, agentId: ID, opts: { bg: 'light' } });
		expect(url).toContain('bg=light');
	});

	it('adds name=0 when name plate is off', () => {
		const url = buildEmbedUrl({ origin: ORIGIN, agentId: ID, opts: { name: false } });
		expect(url).toContain('name=0');
	});

	it('combines bg and name params when both differ from defaults', () => {
		const url = buildEmbedUrl({
			origin: ORIGIN,
			agentId: ID,
			opts: { bg: 'dark', name: false },
		});
		expect(url).toContain('bg=dark');
		expect(url).toContain('name=0');
	});
});

describe('share-panel — buildIframeSnippet', () => {
	it('produces a valid iframe with the embed URL', () => {
		const snippet = buildIframeSnippet({ origin: ORIGIN, agentId: ID });
		expect(snippet).toContain(`<iframe`);
		expect(snippet).toContain(`src="${ORIGIN}/agent/${ID}/embed"`);
		expect(snippet).toContain(`</iframe>`);
	});

	it('defaults to medium size 420x520', () => {
		const snippet = buildIframeSnippet({ origin: ORIGIN, agentId: ID });
		expect(snippet).toContain('width="420"');
		expect(snippet).toContain('height="520"');
	});

	it('uses small size 320x420', () => {
		const snippet = buildIframeSnippet({
			origin: ORIGIN,
			agentId: ID,
			opts: { size: 'small' },
		});
		expect(snippet).toContain('width="320"');
		expect(snippet).toContain('height="420"');
	});

	it('uses large size 520x680', () => {
		const snippet = buildIframeSnippet({
			origin: ORIGIN,
			agentId: ID,
			opts: { size: 'large' },
		});
		expect(snippet).toContain('width="520"');
		expect(snippet).toContain('height="680"');
	});

	it('declares transparent background in style so external sites can composite', () => {
		const snippet = buildIframeSnippet({ origin: ORIGIN, agentId: ID });
		expect(snippet).toContain('background:transparent');
	});

	it('marks loading=lazy and a same-origin-friendly referrer policy', () => {
		const snippet = buildIframeSnippet({ origin: ORIGIN, agentId: ID });
		expect(snippet).toContain('loading="lazy"');
		expect(snippet).toContain('referrerpolicy="strict-origin-when-cross-origin"');
	});

	it('forwards the bg/name options into the iframe src', () => {
		const snippet = buildIframeSnippet({
			origin: ORIGIN,
			agentId: ID,
			opts: { bg: 'dark', name: false },
		});
		expect(snippet).toContain('bg=dark');
		expect(snippet).toContain('name=0');
	});

	it('falls back to medium size for an unknown size value', () => {
		const snippet = buildIframeSnippet({
			origin: ORIGIN,
			agentId: ID,
			opts: { size: 'xxl' },
		});
		expect(snippet).toContain('width="420"');
		expect(snippet).toContain('height="520"');
	});
});

describe('share-panel — buildWebComponentSnippet', () => {
	it('produces an <agent-3d> snippet with the correct id', () => {
		const snippet = buildWebComponentSnippet({ origin: ORIGIN, agentId: ID });
		expect(snippet).toContain(`<agent-3d agent-id="${ID}"`);
		expect(snippet).toContain(`src="${ORIGIN}/dist-lib/agent-3d.js"`);
	});

	it('respects the chosen size in the inline style', () => {
		const snippet = buildWebComponentSnippet({
			origin: ORIGIN,
			agentId: ID,
			opts: { size: 'large' },
		});
		expect(snippet).toContain('width:520px');
		expect(snippet).toContain('height:680px');
	});

	it('omits background/name-plate attrs when defaults are in effect', () => {
		const snippet = buildWebComponentSnippet({ origin: ORIGIN, agentId: ID });
		expect(snippet).not.toContain('background=');
		expect(snippet).not.toContain('name-plate=');
	});

	it('emits background="dark" when the dark BG toggle is on', () => {
		const snippet = buildWebComponentSnippet({
			origin: ORIGIN,
			agentId: ID,
			opts: { bg: 'dark' },
		});
		expect(snippet).toContain('background="dark"');
	});

	it('emits background="light" when the light BG toggle is on', () => {
		const snippet = buildWebComponentSnippet({
			origin: ORIGIN,
			agentId: ID,
			opts: { bg: 'light' },
		});
		expect(snippet).toContain('background="light"');
	});

	it('emits name-plate="off" when the name plate is disabled', () => {
		const snippet = buildWebComponentSnippet({
			origin: ORIGIN,
			agentId: ID,
			opts: { name: false },
		});
		expect(snippet).toContain('name-plate="off"');
	});
});

describe('agent-3d web component — attribute surface', () => {
	const elementSrc = readFileSync(p('src/element.js'), 'utf8');

	it('declares `background` and `name-plate` in observedAttributes', () => {
		expect(elementSrc).toMatch(/'background'\s*,/);
		expect(elementSrc).toMatch(/'name-plate'\s*,/);
	});

	it('routes `background` changes to _applyBackground without rebooting', () => {
		expect(elementSrc).toContain("if (name === 'background') this._applyBackground();");
	});

	it('routes `name-plate` changes to _applyNamePlate without rebooting', () => {
		expect(elementSrc).toContain("if (name === 'name-plate') this._applyNamePlate();");
	});

	it('paints the scene background for dark/light modes and clears alpha for transparent', () => {
		expect(elementSrc).toContain('v.renderer?.setClearAlpha?.(0)');
		expect(elementSrc).toContain("v.scene.background.set('#0b0d10')");
		expect(elementSrc).toContain("v.scene.background.set('#f5f5f5')");
	});

	it('hides the name-plate via CSS host selector, not JS visibility juggling', () => {
		expect(elementSrc).toContain(':host([name-plate="off"]) .name-plate { display: none; }');
	});

	it('renders a name-plate element in the shadow DOM during _renderShell', () => {
		expect(elementSrc).toContain("namePlate.className = 'name-plate'");
	});
});

describe('agent-embed.html — consolidated embed page', () => {
	const html = readFileSync(p('pages/agent-embed.html'), 'utf8');

	it('defaults to a transparent background', () => {
		expect(html).toContain("const bg = params.get('bg') || 'transparent'");
		expect(html).toContain('background: transparent');
	});

	it('exposes the v1 postMessage bridge', () => {
		expect(html).toContain("BRIDGE_VERSION = '1'");
		expect(html).toContain("'agent:hello'");
		expect(html).toContain("'agent:ready'");
		expect(html).toContain("'agent:action'");
		expect(html).toContain("'agent:ping'");
		expect(html).toContain("'agent:resize'");
	});

	it('reports a ResizeObserver-driven content height to the host', () => {
		expect(html).toContain('new ResizeObserver(reportSize)');
	});

	it('resolves agentId from both the path and the ?id= query (so the legacy share snippet still works)', () => {
		expect(html).toContain("parts.indexOf('agent')");
		expect(html).toContain("params.get('id')");
	});

	it('does not inject a frame-ancestors meta tag (browsers ignore it; we use response headers instead)', () => {
		expect(html).not.toMatch(/<meta[^>]+content-security-policy/i);
		expect(html).not.toContain('insertCspMeta');
	});

	it('legacy { mode, hosts } embed-policy shape is still normalised', () => {
		expect(html).toContain('normalisePolicy');
	});
});

describe('vercel.json — embed route headers', () => {
	const vercel = JSON.parse(readFileSync(p('vercel.json'), 'utf8'));
	const routes = vercel.routes || [];

	it('rewrites /agent/{id}/embed to /agent-embed.html', () => {
		const r = routes.find((x) => x.src === '/agent/([^/]+)/embed');
		expect(r).toBeTruthy();
		expect(r.dest).toBe('/agent-embed.html');
	});

	it('sets a permissive frame-ancestors CSP header so external sites can iframe', () => {
		const r = routes.find((x) => x.src === '/agent/([^/]+)/embed');
		expect(r?.headers?.['content-security-policy']).toContain('frame-ancestors *');
	});

	it('does NOT set X-Frame-Options (would block cross-origin embedding)', () => {
		const r = routes.find((x) => x.src === '/agent/([^/]+)/embed');
		expect(r?.headers?.['x-frame-options']).toBeUndefined();
	});

	it('declares a permissions-policy that allows microphone/camera/xr from self', () => {
		const r = routes.find((x) => x.src === '/agent/([^/]+)/embed');
		expect(r?.headers?.['permissions-policy']).toContain('microphone');
		expect(r?.headers?.['permissions-policy']).toContain('camera');
	});

	it('applies the same headers to the on-chain /a/{chain}/{id}/embed route', () => {
		const r = routes.find((x) => x.src === '/a/(\\d+)/(\\d+)/embed');
		expect(r?.headers?.['content-security-policy']).toContain('frame-ancestors *');
	});
});

describe('embed page deduplication', () => {
	it('removes the unreachable duplicate at public/agent/embed.html', () => {
		expect(existsSync(p('public/agent/embed.html'))).toBe(false);
	});
});
