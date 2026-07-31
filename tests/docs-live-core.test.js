// Live Docs core — the decisions that must never be wrong.
//
// public/docs-live.js puts a "Run" button on documentation pages. Everything
// that decides WHAT that button is allowed to do lives in docs-live-core.js,
// and this file is the reason that split exists: the guard against a docs
// reader firing a write (or a spend) they did not intend is a pure function,
// so it can be pinned here rather than trusted to a click handler.

import { describe, expect, it } from 'vitest';

import {
	applyPlaceholders,
	assessRequest,
	buildPreviewDoc,
	buildScriptDoc,
	classifyBlock,
	findPlaceholders,
	formatBytes,
	formatDuration,
	formatResponseBody,
	isSecretName,
	parseCurl,
	rewriteAssetOrigin,
	runLabel,
	statusTone,
	tokenizeShell,
} from '../public/docs-live-core.js';

describe('classifyBlock', () => {
	it('offers a preview for an <agent-3d> embed sample', () => {
		const out = classifyBlock({ lang: 'html', code: '<agent-3d src="https://three.ws/a/demo.glb"></agent-3d>' });
		expect(out).toEqual({ kind: 'preview' });
	});

	it('offers a preview for plain visible markup', () => {
		expect(classifyBlock({ lang: 'html', code: '<div class="card">Hello</div>' })).toEqual({ kind: 'preview' });
	});

	it('does NOT offer a preview for a snippet that renders nothing', () => {
		// A meta-tag sample would render an empty box, which reads as a bug.
		expect(classifyBlock({ lang: 'html', code: '<meta name="x" content="y">' })).toBeNull();
	});

	it('offers a request runner for a curl sample', () => {
		const out = classifyBlock({ lang: 'bash', code: 'curl https://three.ws/api/version' });
		expect(out.kind).toBe('request');
		expect(out.request.method).toBe('GET');
	});

	it('leaves a non-curl shell sample alone', () => {
		expect(classifyBlock({ lang: 'bash', code: 'npm install @three-ws/sdk' })).toBeNull();
	});

	it('offers a script runner only when the sample does something observable', () => {
		expect(classifyBlock({ lang: 'js', code: 'const res = await fetch("/api/version");' })).toEqual({ kind: 'script' });
		expect(classifyBlock({ lang: 'js', code: 'const x = 1;' })).toBeNull();
	});

	it('refuses Node-shaped and bundler-shaped scripts', () => {
		expect(classifyBlock({ lang: 'js', code: 'const a = require("fs"); console.log(a);' })).toBeNull();
		expect(classifyBlock({ lang: 'js', code: 'import x from "express"; console.log(x);' })).toBeNull();
		expect(classifyBlock({ lang: 'js', code: 'console.log(process.env.KEY);' })).toBeNull();
	});

	it('ignores empty blocks and unknown languages', () => {
		expect(classifyBlock({ lang: 'html', code: '   ' })).toBeNull();
		expect(classifyBlock({ lang: 'rust', code: 'fn main() {}' })).toBeNull();
		expect(classifyBlock({})).toBeNull();
	});
});

describe('tokenizeShell', () => {
	it('honours single and double quotes', () => {
		expect(tokenizeShell(`curl -H 'a: b c' -H "d: e f" url`)).toEqual(['curl', '-H', 'a: b c', '-H', 'd: e f', 'url']);
	});

	it('joins backslash line continuations', () => {
		expect(tokenizeShell('curl \\\n  -X POST \\\n  https://three.ws/api/x')).toEqual([
			'curl',
			'-X',
			'POST',
			'https://three.ws/api/x',
		]);
	});

	it('drops a copy-pasted shell prompt and comment lines', () => {
		expect(tokenizeShell('# fetch it\n$ curl https://three.ws/api/version')).toEqual(['curl', 'https://three.ws/api/version']);
	});

	it('keeps an empty quoted argument', () => {
		expect(tokenizeShell(`curl -d '' url`)).toEqual(['curl', '-d', '', 'url']);
	});
});

describe('parseCurl', () => {
	it('parses a plain GET', () => {
		expect(parseCurl('curl -s https://three.ws/api/version')).toEqual({
			method: 'GET',
			url: 'https://three.ws/api/version',
			headers: {},
			body: null,
		});
	});

	it('infers POST from a body and collects headers', () => {
		const out = parseCurl(
			`curl https://three.ws/api/forge \\\n  -H "Content-Type: application/json" \\\n  -d '{"prompt":"a robot"}'`,
		);
		expect(out.method).toBe('POST');
		expect(out.headers['Content-Type']).toBe('application/json');
		expect(out.body).toBe('{"prompt":"a robot"}');
	});

	it('respects an explicit -X', () => {
		expect(parseCurl('curl -X DELETE https://three.ws/api/thing').method).toBe('DELETE');
	});

	it('reads --url and skips flags that carry an irrelevant value', () => {
		const out = parseCurl('curl -o out.json -u me:pw --url https://three.ws/api/version');
		expect(out.url).toBe('https://three.ws/api/version');
	});

	it('refuses anything that is not a single curl command', () => {
		expect(parseCurl('curl https://three.ws/x | jq .')).toBeNull();
		expect(parseCurl('cd app && curl https://three.ws/x')).toBeNull();
		expect(parseCurl('npm run dev')).toBeNull();
		expect(parseCurl('curl -X TELEPORT https://three.ws/x')).toBeNull();
		expect(parseCurl('curl -s')).toBeNull();
	});
});

describe('assessRequest', () => {
	const origin = 'https://three.ws';

	it('runs a same-host GET on one click', () => {
		const out = assessRequest({ method: 'GET', url: 'https://three.ws/api/version' }, { origin });
		expect(out).toMatchObject({ ok: true, confirm: false });
	});

	it('resolves a relative URL against the current origin', () => {
		const out = assessRequest({ method: 'GET', url: '/api/version' }, { origin: 'http://localhost:3000' });
		expect(out.url).toBe('http://localhost:3000/api/version');
		expect(out.ok).toBe(true);
	});

	it('requires a confirmation for every write verb', () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			const out = assessRequest({ method, url: 'https://three.ws/api/forge' }, { origin });
			expect(out, method).toMatchObject({ ok: true, confirm: true });
		}
	});

	it('refuses any host that is not three.ws', () => {
		const out = assessRequest({ method: 'GET', url: 'https://evil.example/api' }, { origin });
		expect(out.ok).toBe(false);
		expect(out.reason).toMatch(/evil\.example/);
	});

	it('refuses every money path, on any verb', () => {
		// This is the guard the whole feature rests on: a docs reader must not be
		// able to reach a spend endpoint from a code sample, confirmed or not.
		const paths = [
			'/api/user/wallet/fund-agent',
			'/api/x402/fact-check',
			'/api/agents/1/autopilot/run',
			'/api/pump/launch',
			'/api/trade/swap',
			'/api/vault/withdraw',
		];
		for (const path of paths) {
			for (const method of ['GET', 'POST']) {
				const out = assessRequest({ method, url: `https://three.ws${path}` }, { origin });
				expect(out.ok, `${method} ${path}`).toBe(false);
			}
		}
	});

	it('refuses a non-http scheme', () => {
		expect(assessRequest({ method: 'GET', url: 'file:///etc/passwd' }, { origin }).ok).toBe(false);
		expect(assessRequest({ method: 'GET', url: 'javascript:alert(1)' }, { origin }).ok).toBe(false);
	});

	it('refuses an unparseable URL', () => {
		expect(assessRequest({ method: 'GET', url: 'http://' }, { origin }).ok).toBe(false);
	});

	it('falls back to three.ws when no origin is supplied', () => {
		expect(assessRequest({ method: 'GET', url: '/api/version' }).url).toBe('https://three.ws/api/version');
	});
});

describe('findPlaceholders', () => {
	it('finds every slot shape a doc sample uses', () => {
		const names = findPlaceholders({
			url: 'https://three.ws/api/agents/<agent-id>/profile',
			headers: { Authorization: 'Bearer $THREEWS_API_KEY' },
			body: '{"owner":"YOUR_WALLET"}',
		}).map((p) => p.name);
		expect(names).toContain('THREEWS_API_KEY');
		expect(names).toContain('agent-id');
		expect(names).toContain('YOUR_WALLET');
	});

	it('marks credential-shaped names as secret', () => {
		const found = findPlaceholders({ url: 'https://three.ws/x?k=$API_KEY&id=<agent-id>' });
		expect(found.find((p) => p.name === 'API_KEY').secret).toBe(true);
		expect(found.find((p) => p.name === 'agent-id').secret).toBe(false);
	});

	it('does not mistake HTML tags in a header value for slots', () => {
		const found = findPlaceholders({ headers: { Accept: 'text/<html>' } });
		expect(found).toEqual([]);
	});

	it('returns each name once', () => {
		const found = findPlaceholders({ url: 'https://three.ws/$ID/x/$ID', body: '$ID' });
		expect(found.filter((p) => p.name === 'ID')).toHaveLength(1);
	});
});

describe('isSecretName', () => {
	it('recognises credential-shaped names', () => {
		for (const n of ['API_KEY', 'THREEWS_TOKEN', 'my_secret', 'PRIVATE_KEY', 'AUTH']) {
			expect(isSecretName(n), n).toBe(true);
		}
		expect(isSecretName('agent-id')).toBe(false);
	});
});

describe('applyPlaceholders', () => {
	it('substitutes every sigil form', () => {
		const out = applyPlaceholders(
			{
				method: 'POST',
				url: 'https://three.ws/api/agents/<agent-id>',
				headers: { Authorization: 'Bearer ${API_KEY}' },
				body: '{"k":"$API_KEY"}',
			},
			{ 'agent-id': '42', API_KEY: 'sk-live' },
		);
		expect(out.url).toBe('https://three.ws/api/agents/42');
		expect(out.headers.Authorization).toBe('Bearer sk-live');
		expect(out.body).toBe('{"k":"sk-live"}');
	});

	it('leaves an unfilled slot visible rather than substituting nothing', () => {
		const out = applyPlaceholders({ url: 'https://three.ws/api/agents/<agent-id>' }, { 'agent-id': '' });
		expect(out.url).toBe('https://three.ws/api/agents/<agent-id>');
	});

	it('substitutes a bare YOUR_* name but never a bare ordinary one', () => {
		expect(applyPlaceholders({ url: 'https://three.ws/YOUR_ID' }, { YOUR_ID: '7' }).url).toBe('https://three.ws/7');
		// `ID` appears inside the path segment "IDENTITY"; replacing it would corrupt the URL.
		expect(applyPlaceholders({ url: 'https://three.ws/IDENTITY' }, { ID: '7' }).url).toBe('https://three.ws/IDENTITY');
	});

	it('does not mutate the input request', () => {
		const input = { method: 'GET', url: 'https://three.ws/$A', headers: {}, body: null };
		applyPlaceholders(input, { A: 'x' });
		expect(input.url).toBe('https://three.ws/$A');
	});
});

describe('rewriteAssetOrigin', () => {
	it('points production asset URLs at a dev origin so the preview tests the local build', () => {
		const out = rewriteAssetOrigin('<script src="https://three.ws/agent-3d/latest/agent-3d.js"></script>', 'http://localhost:3000');
		expect(out).toContain('http://localhost:3000/agent-3d/latest/agent-3d.js');
	});

	it('is a no-op on three.ws itself', () => {
		const html = '<script src="https://three.ws/agent-3d/latest/agent-3d.js"></script>';
		expect(rewriteAssetOrigin(html, 'https://three.ws')).toBe(html);
		expect(rewriteAssetOrigin(html, 'https://www.three.ws')).toBe(html);
	});

	it('leaves other hosts untouched', () => {
		const html = '<img src="https://cdn.example/x.png">';
		expect(rewriteAssetOrigin(html, 'http://localhost:3000')).toBe(html);
	});
});

describe('buildPreviewDoc', () => {
	it('wraps a fragment into a complete document', () => {
		const doc = buildPreviewDoc('<agent-3d src="/a.glb"></agent-3d>', { origin: 'https://three.ws' });
		expect(doc.startsWith('<!doctype html>')).toBe(true);
		expect(doc).toContain('<agent-3d src="/a.glb"></agent-3d>');
	});

	it('does not double-wrap a snippet that is already a document', () => {
		const doc = buildPreviewDoc('<!doctype html><html><body>hi</body></html>', { origin: 'https://three.ws' });
		expect(doc.match(/<!doctype/gi)).toHaveLength(1);
	});

	it('carries the reader theme into the frame', () => {
		expect(buildPreviewDoc('<div>x</div>', { theme: 'light' })).toContain('data-theme="light"');
		expect(buildPreviewDoc('<div>x</div>', { theme: 'dark' })).toContain('data-theme="dark"');
	});
});

describe('buildScriptDoc', () => {
	it('embeds the snippet and captures console output', () => {
		const doc = buildScriptDoc('console.log("hi")');
		expect(doc).toContain('console.log("hi")');
		expect(doc).toContain('postMessage');
	});

	it('neutralises a closing script tag inside the snippet', () => {
		// Without this the injected module would terminate early and the rest of
		// the sample would be parsed as HTML.
		const doc = buildScriptDoc('const s = "</script>";');
		expect(doc).not.toContain('const s = "</script>"');
		expect(doc).toContain('<\\/script');
	});
});

describe('formatting', () => {
	it('formats bytes at each magnitude', () => {
		expect(formatBytes(840)).toBe('840 B');
		expect(formatBytes(1200)).toBe('1.2 kB');
		expect(formatBytes(3_400_000)).toBe('3.40 MB');
		expect(formatBytes(-1)).toBe('—');
		expect(formatBytes('nope')).toBe('—');
	});

	it('formats durations across the second boundary', () => {
		expect(formatDuration(142)).toBe('142 ms');
		expect(formatDuration(1420)).toBe('1.42 s');
		expect(formatDuration(null)).toBe('—');
	});

	it('bands HTTP statuses, with 402 called out on its own', () => {
		expect(statusTone(200)).toBe('ok');
		expect(statusTone(301)).toBe('redirect');
		expect(statusTone(402)).toBe('paid');
		expect(statusTone(404)).toBe('warn');
		expect(statusTone(500)).toBe('err');
		expect(statusTone(undefined)).toBe('err');
	});

	it('re-indents JSON and reports the language', () => {
		const out = formatResponseBody('{"a":1}', { contentType: 'application/json' });
		expect(out.text).toBe('{\n  "a": 1\n}');
		expect(out.language).toBe('json');
		expect(out.truncated).toBe(false);
	});

	it('detects JSON even when the content type lies', () => {
		expect(formatResponseBody('[1,2]', { contentType: 'text/plain' }).language).toBe('json');
	});

	it('passes malformed JSON through as text instead of throwing', () => {
		const out = formatResponseBody('{oops', { contentType: 'application/json' });
		expect(out.language).toBe('text');
		expect(out.text).toBe('{oops');
	});

	it('truncates a body a docs panel should not try to render', () => {
		const out = formatResponseBody('x'.repeat(500), { limit: 100 });
		expect(out.truncated).toBe(true);
		expect(out.text).toContain('truncated');
	});
});

describe('runLabel', () => {
	it('names the action the button actually performs', () => {
		expect(runLabel('preview')).toBe('Run preview');
		expect(runLabel('script')).toBe('Run script');
		expect(runLabel('request', { method: 'GET' })).toBe('Send request');
		expect(runLabel('request', { method: 'POST' })).toBe('Send POST');
	});
});
