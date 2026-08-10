// Coverage for the "Claim Your 3D Avatar" Solana Blink pair:
//
//   api/actions/avatar.js       the Action itself (GET card, POST transaction)
//   api/actions/avatar-icon.js  the card's icon, a headless-chromium GLB render
//
// Both were reachable in production with no test at all. The cases below pin
// the behaviour a Blink client depends on and the input handling that keeps the
// renderer safe:
//
//   1. The GET card carries the Action spec's `type` and a live icon/href pair.
//   2. `?avatar=` only ever names "default" or a real avatar id. That string is
//      written into the on-chain memo, so an arbitrary one must not reach it.
//   3. A private, deleted, or unknown avatar is a 404, not a card advertising it.
//   4. The version headers ride the OPTIONS preflight, per the Actions spec.
//   5. POST rejects an off-curve (PDA) account before building a transaction no
//      wallet could ever sign, and surfaces an RPC outage as 503.
//   6. The icon's `bg` lands inside the render page's script block. A value
//      containing a closing script tag is refused at the boundary AND neutered
//      by the renderer's own escaper, so the injection is dead twice over.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAvatar = vi.fn();
vi.mock('../api/_lib/avatars.js', () => ({ getAvatar: (...a) => getAvatar(...a) }));

const getLatestBlockhash = vi.fn();
vi.mock('../api/_lib/solana/connection.js', () => ({
	solanaConnection: () => ({ getLatestBlockhash: (...a) => getLatestBlockhash(...a) }),
}));

const renderClip = vi.fn();
vi.mock('../api/_lib/render-clip.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, renderClip: (...a) => renderClip(...a) };
});

const { default: actionHandler } = await import('../api/actions/avatar.js');
const { default: iconHandler } = await import('../api/actions/avatar-icon.js');
const { scriptJson } = await import('../api/_lib/render-clip.js');

// A real mainnet blockhash value. The RPC round-trip is what we stand in for,
// not the encoding, which @solana/web3.js does for real below.
const BLOCKHASH = '9zGE9NVsSGkoUZv8uZbGdFDNKvVjbQTG5Uu6iN4vVQBS';
// $THREE, the platform's own coin, doubles as a known-good on-curve pubkey.
const ON_CURVE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const AVATAR_UUID = '3f1c8a52-9f6b-4a3d-8c21-0d5b7e9a1c44';
const LINE_SEP = String.fromCharCode(0x2028);
const PARA_SEP = String.fromCharCode(0x2029);

function mockReq(method, url, body) {
	const req = { method, url, headers: { host: 'localhost' } };
	if (body !== undefined) {
		req.headers['content-type'] = 'application/json';
		req.body = body;
	}
	return req;
}

function mockRes() {
	return {
		statusCode: 200,
		headers: {},
		body: undefined,
		ended: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(b) { this.body = b; this.ended = true; },
	};
}

const parse = (res) => JSON.parse(String(res.body));

beforeEach(() => {
	getAvatar.mockReset();
	getLatestBlockhash.mockReset();
	renderClip.mockReset();
});

describe('api/actions/avatar GET (the Blink card)', () => {
	it('returns a spec-shaped action with a live icon and action href', async () => {
		const res = mockRes();
		await actionHandler(mockReq('GET', '/api/actions/avatar'), res);

		expect(res.statusCode).toBe(200);
		const card = parse(res);
		expect(card.type).toBe('action');
		expect(card.icon).toMatch(/\/api\/actions\/avatar-icon\?avatar=default$/);
		expect(card.links.actions[0]).toMatchObject({
			type: 'transaction',
			href: '/api/actions/avatar?avatar=default',
		});
		expect(res.headers['x-action-version']).toBe('2.1.3');
		expect(res.headers['x-blockchain-ids']).toMatch(/^solana:/);
		// No DB round-trip for the default avatar: the card is pure static copy.
		expect(getAvatar).not.toHaveBeenCalled();
	});

	it('titles the card with the avatar the Blink actually points at', async () => {
		getAvatar.mockResolvedValue({ id: AVATAR_UUID, name: 'Nova', visibility: 'public' });
		const res = mockRes();
		await actionHandler(mockReq('GET', `/api/actions/avatar?avatar=${AVATAR_UUID}`), res);

		expect(res.statusCode).toBe(200);
		expect(parse(res).title).toBe('Nova on three.ws');
		expect(getAvatar).toHaveBeenCalledWith({ id: AVATAR_UUID });
	});

	it('rejects an avatar id that could never name a real avatar', async () => {
		const res = mockRes();
		await actionHandler(mockReq('GET', '/api/actions/avatar?avatar=%3Cscript%3E'), res);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error).toBe('bad_request');
		expect(getAvatar).not.toHaveBeenCalled();
	});

	it('404s an avatar the anonymous viewer cannot see', async () => {
		getAvatar.mockResolvedValue(null);
		const res = mockRes();
		await actionHandler(mockReq('GET', `/api/actions/avatar?avatar=${AVATAR_UUID}`), res);

		expect(res.statusCode).toBe(404);
		// Blink clients render ActionError.message, so it must be present too.
		expect(parse(res).message).toMatch(/not available/i);
	});

	it('puts the Action version headers on the OPTIONS preflight', async () => {
		const res = mockRes();
		await actionHandler(mockReq('OPTIONS', '/api/actions/avatar'), res);

		expect(res.statusCode).toBe(204);
		expect(res.headers['x-action-version']).toBe('2.1.3');
		expect(res.headers['x-blockchain-ids']).toMatch(/^solana:/);
	});

	it('405s a method the action does not serve', async () => {
		const res = mockRes();
		await actionHandler(mockReq('PUT', '/api/actions/avatar'), res);

		expect(res.statusCode).toBe(405);
		expect(parse(res).error).toBe('method_not_allowed');
	});
});

describe('api/actions/avatar POST (the claim transaction)', () => {
	it('builds a memo transaction naming the avatar being claimed', async () => {
		getAvatar.mockResolvedValue({ id: AVATAR_UUID, name: 'Nova', visibility: 'public' });
		getLatestBlockhash.mockResolvedValue({ blockhash: BLOCKHASH });
		const res = mockRes();
		await actionHandler(
			mockReq('POST', `/api/actions/avatar?avatar=${AVATAR_UUID}`, { account: ON_CURVE }),
			res,
		);

		expect(res.statusCode).toBe(200);
		const out = parse(res);
		expect(out.type).toBe('transaction');

		const { VersionedTransaction, PublicKey } = await import('@solana/web3.js');
		const tx = VersionedTransaction.deserialize(Buffer.from(out.transaction, 'base64'));
		expect(tx.message.recentBlockhash).toBe(BLOCKHASH);
		expect(tx.message.staticAccountKeys[0].toBase58()).toBe(ON_CURVE);
		expect(tx.message.staticAccountKeys.some((k) => k.toBase58() === MEMO_PROGRAM)).toBe(true);
		expect(PublicKey.isOnCurve(tx.message.staticAccountKeys[0].toBytes())).toBe(true);

		const memo = JSON.parse(
			Buffer.from(tx.message.compiledInstructions[0].data).toString('utf8'),
		);
		expect(memo).toMatchObject({ action: 'avatar-claim', avatar: AVATAR_UUID, site: 'three.ws' });
		// The claim is unsigned: the wallet, never the server, authorizes it.
		expect(tx.signatures.every((s) => s.every((b) => b === 0))).toBe(true);
	});

	it('rejects an off-curve account no wallet could sign for', async () => {
		const { PublicKey } = await import('@solana/web3.js');
		const [pda] = PublicKey.findProgramAddressSync(
			[Buffer.from('three')],
			new PublicKey(MEMO_PROGRAM),
		);
		const res = mockRes();
		await actionHandler(mockReq('POST', '/api/actions/avatar', { account: pda.toBase58() }), res);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toMatch(/invalid account/i);
		expect(getLatestBlockhash).not.toHaveBeenCalled();
	});

	it('rejects a request with no account', async () => {
		const res = mockRes();
		await actionHandler(mockReq('POST', '/api/actions/avatar', {}), res);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toMatch(/account is required/);
		expect(getLatestBlockhash).not.toHaveBeenCalled();
	});

	it('surfaces an unreachable RPC as 503 rather than hanging out the clock', async () => {
		getLatestBlockhash.mockRejectedValue(new Error('429 Too Many Requests'));
		const res = mockRes();
		await actionHandler(mockReq('POST', '/api/actions/avatar', { account: ON_CURVE }), res);

		expect(res.statusCode).toBe(503);
		expect(parse(res).error).toBe('rpc_unavailable');
	});
});

describe('api/actions/avatar-icon', () => {
	const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

	it('renders the default avatar and serves it as a cacheable PNG', async () => {
		renderClip.mockResolvedValue({ png: PNG, pose: null });
		const res = mockRes();
		await iconHandler(mockReq('GET', '/api/actions/avatar-icon'), res);

		expect(res.statusCode).toBe(200);
		expect(res.headers['content-type']).toBe('image/png');
		expect(res.headers['cache-control']).toMatch(/max-age=86400/);
		expect(res.body).toBe(PNG);
		expect(renderClip).toHaveBeenCalledWith(
			expect.objectContaining({
				glbUrl: expect.stringMatching(/\/avatars\/default\.glb$/),
				width: 512,
				height: 512,
				background: '#0a0a0a',
			}),
		);
	});

	it('refuses a background that would break out of the render page script', async () => {
		const res = mockRes();
		await iconHandler(
			mockReq(
				'GET',
				'/api/actions/avatar-icon?bg=%3C%2Fscript%3E%3Cscript%3Ewindow.__renderDone%3Dtrue%3C%2Fscript%3E',
			),
			res,
		);

		expect(res.statusCode).toBe(400);
		expect(parse(res).error_description).toMatch(/CSS color/);
		expect(renderClip).not.toHaveBeenCalled();
	});

	it('accepts the CSS color forms three.js can actually parse', async () => {
		renderClip.mockResolvedValue({ png: PNG, pose: null });
		for (const bg of ['%23112233', 'midnightblue', 'rgb(20%2C30%2C40)', 'transparent']) {
			const res = mockRes();
			await iconHandler(mockReq('GET', `/api/actions/avatar-icon?bg=${bg}`), res);
			expect(res.statusCode, `bg=${bg}`).toBe(200);
		}
		expect(renderClip).toHaveBeenCalledTimes(4);
	});

	it('rejects a pose id that is a path rather than a preset', async () => {
		const res = mockRes();
		await iconHandler(mockReq('GET', '/api/actions/avatar-icon?pose=..%2Fetc%2Fpasswd'), res);

		expect(res.statusCode).toBe(400);
		expect(renderClip).not.toHaveBeenCalled();
	});

	it('rejects an avatar id that could never name a real avatar', async () => {
		const res = mockRes();
		await iconHandler(mockReq('GET', '/api/actions/avatar-icon?avatar=notauuid'), res);

		expect(res.statusCode).toBe(400);
		expect(getAvatar).not.toHaveBeenCalled();
		expect(renderClip).not.toHaveBeenCalled();
	});

	it('405s a write method instead of booting chromium for it', async () => {
		const res = mockRes();
		await iconHandler(mockReq('POST', '/api/actions/avatar-icon'), res);

		expect(res.statusCode).toBe(405);
		expect(renderClip).not.toHaveBeenCalled();
	});

	it('passes the renderer failure class through instead of flattening it to 502', async () => {
		getAvatar.mockResolvedValue({ id: AVATAR_UUID, model_url: 'https://three.ws/a.glb' });
		renderClip.mockRejectedValue(
			Object.assign(new Error('glb too large'), { status: 413, code: 'file_too_large' }),
		);
		const res = mockRes();
		await iconHandler(mockReq('GET', `/api/actions/avatar-icon?avatar=${AVATAR_UUID}`), res);

		expect(res.statusCode).toBe(413);
		expect(parse(res).error).toBe('file_too_large');
	});
});

describe('render-clip scriptJson', () => {
	it('neuters a value that would close the script tag it is embedded in', () => {
		const payload = '</script><script>fetch("http://169.254.169.254/")</script>';
		const out = scriptJson(payload);
		expect(out).not.toContain('<');
		expect(out).not.toContain('>');
		// Still valid JS producing the original string, so no render breaks.
		expect(JSON.parse(out)).toBe(payload);
	});

	it('escapes the JS line terminators JSON leaves raw', () => {
		const payload = `a${LINE_SEP}b${PARA_SEP}c`;
		const out = scriptJson(payload);
		expect(out).not.toContain(LINE_SEP);
		expect(out).not.toContain(PARA_SEP);
		expect(JSON.parse(out)).toBe(payload);
	});

	it('round-trips the structured values the viewer embeds', () => {
		const orbit = { theta: 10, phi: 75, radius: null };
		expect(JSON.parse(scriptJson(orbit))).toEqual(orbit);
		expect(scriptJson(undefined)).toBe('null');
	});
});
