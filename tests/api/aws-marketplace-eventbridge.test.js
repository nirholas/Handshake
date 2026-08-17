// EventBridge lifecycle transport for /api/aws-marketplace/subscription.
//
// AWS made Concurrent Agreements mandatory for new SaaS products on 2026-06-01.
// Two consequences this file guards:
//
//   1. Lifecycle notifications for a new listing arrive as EventBridge events
//      (source `aws.agreement-marketplace`), relayed through an API destination,
//      not as signed SNS envelopes. The webhook has to recognize and act on
//      them, and it has to refuse them when the relay secret is unset or wrong.
//      an unauthenticated caller who can post here can revoke a paying buyer.
//   2. Those events never carry a CustomerIdentifier. They carry a license ARN
//      and an agreement id, and under concurrent agreements a single AWS account
//      can hold several live agreements for the same product, so an event that
//      only names the account must not be allowed to guess which one to revoke.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sqlMock = vi.fn(async () => []);
vi.mock('../../api/_lib/db.js', () => ({
	sql: Object.assign(
		(...args) => sqlMock(...args),
		{ transaction: (...args) => sqlMock(...args) },
	),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const verifySnsMessageMock = vi.fn(async () => {});
vi.mock('../../api/_lib/aws-marketplace.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, verifySnsMessage: (...a) => verifySnsMessageMock(...a) };
});

const revokeMock = vi.fn(async () => null);
vi.mock('../../api/_lib/aws-marketplace-bridge.js', () => ({
	revokeSubscriptionForCustomer: (...a) => revokeMock(...a),
}));

const { default: handler } = await import('../../api/aws-marketplace/subscription.js');
const {
	parseMarketplaceEvent,
	isEventBridgeEnvelope,
	EVENT_SECRET_HEADER,
} = await import('../../api/_lib/aws-marketplace.js');

const SECRET = 'THREEsynthetic-eventbridge-secret';
const LICENSE = 'arn:aws:license-manager:us-east-1:155407237916:l-synthetic0000';
const AGREEMENT = 'agmt-synthetic0000000000000';

function event(detailType, detail) {
	return {
		version: '0',
		id: '12345678-1234-1234-1234-123456789012',
		'detail-type': detailType,
		source: 'aws.agreement-marketplace',
		account: '155407237916',
		time: '2026-08-17T00:00:00Z',
		region: 'us-east-1',
		resources: [`arn:aws:aws-marketplace::aws:agreement:${AGREEMENT}`],
		detail: { requestId: 'req-1', catalog: 'AWSMarketplace', ...detail },
	};
}

function makeReq(body, headers = {}) {
	return {
		method: 'POST',
		url: '/api/aws-marketplace/subscription',
		headers: { 'content-type': 'application/json', 'user-agent': 'vitest', ...headers },
		rawBody: Buffer.from(JSON.stringify(body)),
		query: {},
	};
}

function signedReq(body) {
	return makeReq(body, { [EVENT_SECRET_HEADER]: SECRET });
}

function makeRes() {
	const headers = {};
	let body = '';
	const res = {
		statusCode: 200,
		headersSent: false,
		writableEnded: false,
		setHeader: (k, v) => { headers[k.toLowerCase()] = v; },
		getHeader: (k) => headers[k.toLowerCase()],
		end: (chunk) => { body = chunk ?? ''; res.writableEnded = true; },
		_get: () => ({ status: res.statusCode, headers, body: body ? JSON.parse(body) : null }),
	};
	return res;
}

beforeEach(() => {
	sqlMock.mockClear().mockResolvedValue([{ id: 'row-1', license_arn: LICENSE }]);
	revokeMock.mockClear().mockResolvedValue(null);
	verifySnsMessageMock.mockClear().mockResolvedValue(undefined);
	process.env.AWS_MP_EVENT_SECRET = SECRET;
	process.env.AWS_MP_PRODUCT_CODE = 'THREEsyntheticProductCode';
});

describe('parseMarketplaceEvent', () => {
	it('maps every lifecycle detail-type onto the action the listing takes', () => {
		const cases = [
			['Purchase Agreement Created - Proposer', 'agreement-created'],
			['Purchase Agreement Created - Manufacturer', 'agreement-created'],
			['Purchase Agreement Amended - Manufacturer', 'agreement-created'],
			['Purchase Agreement Ended - Manufacturer', 'agreement-ended'],
			['License Updated - Manufacturer', 'license-updated'],
			['License Deprovisioned - Manufacturer', 'license-deprovisioned'],
			['Spend Threshold Reached', 'ignored'],
		];
		for (const [detailType, kind] of cases) {
			expect(parseMarketplaceEvent(event(detailType, {})).kind).toBe(kind);
		}
	});

	it('reads the license, agreement, acceptor, and offer out of a License Updated event', () => {
		const parsed = parseMarketplaceEvent(
			event('License Updated - Manufacturer', {
				agreement: { id: AGREEMENT },
				product: { code: 'THREEsyntheticProductCode', id: 'prod-synthetic' },
				license: { arn: LICENSE },
				acceptor: { accountId: '111122223333' },
				offer: { id: 'offer-synthetic' },
			}),
		);
		expect(parsed).toMatchObject({
			kind: 'license-updated',
			licenseArn: LICENSE,
			agreementId: AGREEMENT,
			acceptorAccountId: '111122223333',
			offerId: 'offer-synthetic',
			productCode: 'THREEsyntheticProductCode',
		});
	});

	it('ignores an event from any other source', () => {
		expect(parseMarketplaceEvent({ source: 'aws.marketplacecatalog', 'detail-type': 'Offer Released' })).toBeNull();
	});

	it('tells an EventBridge envelope apart from an SNS one', () => {
		expect(isEventBridgeEnvelope(event('Purchase Agreement Ended - Manufacturer', {}))).toBe(true);
		expect(isEventBridgeEnvelope({ Type: 'Notification', TopicArn: 'arn:aws:sns:…', Message: '{}' })).toBe(false);
	});
});

describe('POST /api/aws-marketplace/subscription EventBridge relay', () => {
	it('refuses delivery with 503 when no relay secret is configured', async () => {
		delete process.env.AWS_MP_EVENT_SECRET;
		const res = makeRes();
		await handler(signedReq(event('Purchase Agreement Ended - Manufacturer', { license: { arn: LICENSE } })), res);
		expect(res._get().status).toBe(503);
		expect(res._get().body).toEqual({ error: 'not_configured' });
		expect(revokeMock).not.toHaveBeenCalled();
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects a relayed event carrying the wrong secret', async () => {
		const res = makeRes();
		await handler(
			makeReq(event('License Deprovisioned - Manufacturer', { license: { arn: LICENSE } }), {
				[EVENT_SECRET_HEADER]: 'not-the-secret',
			}),
			res,
		);
		expect(res._get().status).toBe(403);
		expect(revokeMock).not.toHaveBeenCalled();
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('rejects a relayed event carrying no secret at all', async () => {
		const res = makeRes();
		await handler(makeReq(event('License Deprovisioned - Manufacturer', { license: { arn: LICENSE } })), res);
		expect(res._get().status).toBe(403);
		expect(revokeMock).not.toHaveBeenCalled();
	});

	it('revokes the buyer named by a License Deprovisioned event', async () => {
		const res = makeRes();
		await handler(
			signedReq(
				event('License Deprovisioned - Manufacturer', {
					agreement: { id: AGREEMENT },
					license: { arn: LICENSE },
					acceptor: { accountId: '111122223333' },
				}),
			),
			res,
		);
		expect(res._get().status).toBe(200);
		expect(res._get().body).toEqual({ ok: true, revoked: 'row-1' });
		expect(revokeMock).toHaveBeenCalledWith('row-1');
	});

	it('refuses to guess when an end event matches more than one live agreement', async () => {
		// No license ARN and no stamped agreement: resolution falls back to the
		// acceptor's AWS account, which under concurrent agreements can hold
		// several. Revoking either would cut off access the buyer still pays for.
		sqlMock.mockResolvedValue([{ id: 'row-1' }, { id: 'row-2' }]);
		const res = makeRes();
		await handler(
			signedReq(
				event('Purchase Agreement Ended - Manufacturer', {
					acceptor: { accountId: '111122223333' },
				}),
			),
			res,
		);
		expect(res._get().status).toBe(200);
		expect(res._get().body).toEqual({ ok: true, unresolved: true, matched: 2 });
		expect(revokeMock).not.toHaveBeenCalled();
	});

	it('answers 200 without revoking when no buyer matches the end event', async () => {
		sqlMock.mockResolvedValue([]);
		const res = makeRes();
		await handler(
			signedReq(event('Purchase Agreement Ended - Manufacturer', { license: { arn: LICENSE } })),
			res,
		);
		expect(res._get().status).toBe(200);
		expect(res._get().body).toEqual({ ok: true, matched: 0 });
		expect(revokeMock).not.toHaveBeenCalled();
	});

	it('records a new agreement without touching the x402 key', async () => {
		const res = makeRes();
		await handler(
			signedReq(
				event('Purchase Agreement Created - Proposer', {
					agreement: { id: AGREEMENT, status: 'ACTIVE' },
					acceptor: { accountId: '111122223333' },
					offer: { id: 'offer-synthetic' },
				}),
			),
			res,
		);
		expect(res._get().status).toBe(200);
		expect(res._get().body).toEqual({ ok: true, customer: 'row-1' });
		expect(revokeMock).not.toHaveBeenCalled();
	});

	it('acknowledges a marketplace event it takes no action on', async () => {
		const res = makeRes();
		await handler(signedReq(event('Spend Threshold Vet Succeeded', {})), res);
		expect(res._get().status).toBe(200);
		expect(res._get().body).toEqual({ ok: true, ignored: 'Spend Threshold Vet Succeeded' });
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('never falls through to the SNS verifier for an EventBridge body', async () => {
		await handler(
			signedReq(event('License Deprovisioned - Manufacturer', { license: { arn: LICENSE } })),
			makeRes(),
		);
		expect(verifySnsMessageMock).not.toHaveBeenCalled();
	});
});
