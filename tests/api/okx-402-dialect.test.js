/**
 * The 402 dialect our OKX.AI services speak.
 *
 * OKX implements x402 **v2**, whose buyer header is `PAYMENT-SIGNATURE`; the
 * platform's shared default error string names v1's `X-PAYMENT`, because the
 * Solana/Base rails that predate this one really do read that header. Shipping
 * the v1 default on the OKX surface told a reviewer of an x402-v2 listing, in
 * the one string every unpaid caller reads, that we implement the version we do
 * not, on the exact surface whose 2026-07-04 rejection was "not integrated with
 * the OKX Agent Payments Protocol standard".
 *
 * This pins the override on every OKX challenge (the listed forge rows and the
 * back-burner Identity Studio) and pins that it survives build402Body, which is
 * what actually renders the body and the PAYMENT-REQUIRED header.
 */
import { describe, it, expect } from 'vitest';

process.env.PUBLIC_APP_ORIGIN ||= 'https://three.ws';

const { X402_HEADER_ERROR } = await import('../../api/_lib/x402-xlayer-okx.js');
const { forgeSurface, FORGE_SERVICE_IDS } = await import('../../api/_okx3d/forge.js');
const { IDENTITY_CHALLENGE } = await import('../../api/_okx3d/discovery.js');
const { build402Body } = await import('../../api/_lib/x402-spec.js');

describe('OKX 402 dialect', () => {
	it('names the x402 v2 buyer header, and still accepts the v1 name', () => {
		expect(X402_HEADER_ERROR).toMatch(/^PAYMENT-SIGNATURE header is required/);
		expect(X402_HEADER_ERROR).toContain('X-PAYMENT');
	});

	it('every listed forge row advertises it', () => {
		for (const id of FORGE_SERVICE_IDS) {
			expect(forgeSurface(id).challenge.error, id).toBe(X402_HEADER_ERROR);
		}
	});

	it('the Identity Studio advertises it too', () => {
		expect(IDENTITY_CHALLENGE.error).toBe(X402_HEADER_ERROR);
	});

	it('survives into the rendered 402 body', async () => {
		const body = await build402Body({
			resourceUrl: 'https://three.ws/api/okx/3d/forge-draft',
			accepts: [],
			...forgeSurface('forge-draft').challenge,
		});
		expect(body.x402Version).toBe(2);
		expect(body.error).toBe(X402_HEADER_ERROR);
	});
});
