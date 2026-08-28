// The guard that keeps every outbound third-party call bounded. Its own logic
// is worth testing: a checker that silently stops catching things is worse than
// no checker, because the gate keeps passing while the protection erodes.
import { describe, it, expect } from 'vitest';
import { scanFile } from '../scripts/check-fetch-timeouts.mjs';

const scan = (src) => scanFile('x.js', src);

describe('check-fetch-timeouts', () => {
	it('flags an external fetch with no deadline', () => {
		const out = scan(`const r = await fetch('https://api.example.com/v1/thing', { method: 'POST' });`);
		expect(out).toHaveLength(1);
		expect(out[0].line).toBe(1);
	});

	it('accepts a signal passed as the LAST key of a long options object', () => {
		// The window this replaced was fixed-size, so a call whose options ran
		// past it was reported as unbounded precisely when it was hardest to read.
		const body = Array.from({ length: 24 }, (_, i) => `\t\t\tfield${i}: ${i},`).join('\n');
		const out = scan([
			`const res = await fetch(URL_CONST, {`,
			`\tmethod: 'POST',`,
			`\tbody: JSON.stringify({`,
			body,
			`\t}),`,
			`\tsignal: controller.signal,`,
			`});`,
			`const URL_CONST = 'https://api.example.com/x';`,
		].join('\n'));
		expect(out).toEqual([]);
	});

	it('accepts AbortSignal.timeout and the shared wrappers', () => {
		expect(scan(`await fetch('https://a.example/x', { signal: AbortSignal.timeout(5000) });`)).toEqual([]);
		expect(scan(`await fetchUpstream('https://a.example/x', {}, { timeoutMs: 5000 });`)).toEqual([]);
		expect(scan(`await pumpFetchJson('https://frontend-api-v3.pump.fun/coins/x');`)).toEqual([]);
	});

	it('resolves an external URL held in a const', () => {
		const src = [
			`const BASE = 'https://api.example.com';`,
			`const r = await fetch(\`\${BASE}/thing\`, { method: 'GET' });`,
		].join('\n');
		expect(scan(src)).toHaveLength(1);
	});

	it('ignores same-origin and relative calls, which are a different concern', () => {
		expect(scan(`await fetch('/api/thing');`)).toEqual([]);
		expect(scan(`await fetch('https://three.ws/api/thing');`)).toEqual([]);
		expect(scan(`const B = 'http://localhost:3000';\nawait fetch(\`\${B}/x\`);`)).toEqual([]);
	});

	it('ignores stubs, definitions and commented-out code', () => {
		expect(scan(`globalThis.fetch = vi.fn(async () => new Response());`)).toEqual([]);
		expect(scan(`// await fetch('https://api.example.com/x');`)).toEqual([]);
		expect(scan(`\t * await fetch('https://api.example.com/x');`)).toEqual([]);
	});

	it('reports the file and line so the message is actionable', () => {
		const out = scan(`const a = 1;\nconst b = 2;\nawait fetch('https://api.example.com/x');`);
		expect(out[0]).toMatchObject({ file: 'x.js', line: 3 });
		expect(out[0].code).toContain('api.example.com');
	});
});
