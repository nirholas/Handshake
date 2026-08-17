// Unit tests for the delivery guard on /api/aws-marketplace/subscription.
//
// A valid AWS SNS signature only proves "some AWS account signed this". Anyone
// can create their own SNS topic and have AWS sign a Notification for it, so
// the TopicArn pin is what actually binds this webhook to OUR Marketplace
// listing. While the pin was optional, an unconfigured deployment accepted any
// topic: a forged subscribe-success would mint a free x402 key for an
// attacker-chosen customer, and a forged unsubscribe-success would revoke a
// paying customer's key. The handler now refuses delivery until the ARN is set.
//
// These tests assert the gate itself, not the crypto. Signature verification is
// covered in aws-marketplace-sns.test.js.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

const TOPIC = 'arn:aws:sns:us-east-1:155407237916:marketplace-topic';

function makeReq(msg) {
	const raw = Buffer.from(JSON.stringify(msg));
	return {
		method: 'POST',
		url: '/api/aws-marketplace/subscription',
		headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
		rawBody: raw,
		query: {},
	};
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

function notification(action, customerId = 'THREEsynthetic-awsmp-test') {
	return {
		Type: 'Notification',
		MessageId: 'msg-1',
		Message: JSON.stringify({ action, 'customer-identifier': customerId, 'product-code': 'THREEsyntheticProductCode' }),
		Timestamp: '2026-08-10T00:00:00.000Z',
		TopicArn: TOPIC,
		SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
		Signature: 'AAAA',
	};
}

beforeEach(() => {
	// Every store query in this path either reads or returns the customer row,
	// so a single-row answer keeps the mock honest without a database.
	sqlMock.mockClear().mockResolvedValue([{ id: 'row-1', customer_identifier: 'THREEsynthetic-awsmp-test' }]);
	verifySnsMessageMock.mockClear().mockResolvedValue(undefined);
	revokeMock.mockClear().mockResolvedValue(null);
	process.env.AWS_MP_SNS_TOPIC_ARN = TOPIC;
});

afterEach(() => {
	delete process.env.AWS_MP_SNS_TOPIC_ARN;
});

describe('POST /api/aws-marketplace/subscription topic pin', () => {
	it('refuses delivery with 503 when no topic ARN is pinned', async () => {
		delete process.env.AWS_MP_SNS_TOPIC_ARN;
		const res = makeRes();
		await handler(makeReq(notification('subscribe-success')), res);
		expect(res._get().status).toBe(503);
		expect(res._get().body).toEqual({ error: 'not_configured' });
	});

	it('writes nothing when unpinned, even for a message that would verify', async () => {
		delete process.env.AWS_MP_SNS_TOPIC_ARN;
		await handler(makeReq(notification('unsubscribe-success')), makeRes());
		expect(sqlMock).not.toHaveBeenCalled();
		expect(revokeMock).not.toHaveBeenCalled();
		// The gate must come before verification, so an unpinned deployment does
		// not even fetch a signing certificate for an unknown topic.
		expect(verifySnsMessageMock).not.toHaveBeenCalled();
	});

	it('processes a subscribe-success once the ARN is pinned', async () => {
		const res = makeRes();
		await handler(makeReq(notification('subscribe-success')), res);
		expect(verifySnsMessageMock).toHaveBeenCalledTimes(1);
		expect(res._get().status).toBe(200);
		expect(res._get().body).toEqual({ ok: true, customer: 'row-1' });
		expect(sqlMock).toHaveBeenCalled();
	});

	it('rejects a message the verifier refuses', async () => {
		verifySnsMessageMock.mockRejectedValue(new Error('SNS signature verification failed'));
		const res = makeRes();
		await handler(makeReq(notification('unsubscribe-success')), res);
		expect(res._get().status).toBe(403);
		expect(revokeMock).not.toHaveBeenCalled();
		expect(sqlMock).not.toHaveBeenCalled();
	});

	it('refuses a SubscribeURL that is not an AWS HTTPS endpoint', async () => {
		const res = makeRes();
		await handler(
			makeReq({
				Type: 'SubscriptionConfirmation',
				MessageId: 'msg-2',
				Message: 'You have chosen to subscribe',
				SubscribeURL: 'http://169.254.169.254/latest/meta-data/',
				Token: 'token-abc',
				Timestamp: '2026-08-10T00:00:00.000Z',
				TopicArn: TOPIC,
				SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
				Signature: 'AAAA',
			}),
			res,
		);
		expect(res._get().status).toBe(400);
		expect(res._get().body).toEqual({ error: 'invalid_subscribe_url' });
	});

	it('keeps the customer active when a revoke fails, so the retry can win', async () => {
		revokeMock.mockRejectedValue(new Error('x402 revoke exploded'));
		const res = makeRes();
		await handler(makeReq(notification('unsubscribe-success')), res);
		expect(res._get().status).toBe(500);
		expect(res._get().body).toEqual({ error: 'revoke_failed' });
		// Only the lookup that found the row may have run. Status must NOT flip to
		// cancelled while the key is still live.
		expect(sqlMock).toHaveBeenCalledTimes(1);
	});

	it('answers 200 without revoking when the notification names an unknown customer', async () => {
		sqlMock.mockResolvedValue([]);
		const res = makeRes();
		await handler(makeReq(notification('unsubscribe-success')), res);
		expect(res._get().status).toBe(200);
		expect(res._get().body).toEqual({ ok: true, matched: 0 });
		expect(revokeMock).not.toHaveBeenCalled();
	});
});
