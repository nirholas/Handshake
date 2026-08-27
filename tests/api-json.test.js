import { describe, it, expect } from 'vitest';
import { readJson, isApiJsonError } from '../src/shared/api-json.js';

function res(status, body, ok = status >= 200 && status < 300) {
	return new Response(body, { status, statusText: ok ? 'OK' : 'ERR' });
}

describe('readJson', () => {
	it('returns parsed JSON on 2xx', async () => {
		await expect(readJson(res(200, JSON.stringify({ data: { x: 1 } })))).resolves.toEqual({ data: { x: 1 } });
	});
	it('returns null on an empty 2xx body', async () => {
		await expect(readJson(res(204, null))).resolves.toBeNull();
	});
	it('throws http_<status> with a readable message on a gateway HTML 502', async () => {
		const err = await readJson(res(502, '<html><body>Bad Gateway</body></html>')).catch((e) => e);
		expect(err.status).toBe(502);
		expect(err.code).toBe('http_502');
		expect(err.message).not.toMatch(/Unexpected token/);
		expect(err.message).toMatch(/server had a problem/i);
		expect(isApiJsonError(err)).toBe(true);
	});
	it('surfaces the server error key and description on a JSON 4xx', async () => {
		const err = await readJson(
			res(400, JSON.stringify({ error: 'insufficient_funds', error_description: 'Top up 0.02 SOL first.' })),
		).catch((e) => e);
		expect(err.status).toBe(400);
		expect(err.code).toBe('insufficient_funds');
		expect(err.message).toBe('Top up 0.02 SOL first.');
		expect(err.data.error).toBe('insufficient_funds');
	});
	it('does not treat a non-2xx JSON body without an error key as success', async () => {
		const err = await readJson(res(500, JSON.stringify({ ok: false }))).catch((e) => e);
		expect(err.status).toBe(500);
		expect(err.code).toBe('http_500');
	});
	it('throws bad_json on a 2xx body that is not JSON', async () => {
		const err = await readJson(res(200, 'not json')).catch((e) => e);
		expect(err.code).toBe('bad_json');
		expect(err.status).toBe(200);
	});
});
