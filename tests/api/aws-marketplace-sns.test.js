// Unit tests for the security-critical half of the AWS Marketplace integration:
// SNS webhook signature verification (api/_lib/aws-marketplace.js → verifySnsMessage).
//
// An unverified SNS webhook is the soft underbelly of a Marketplace listing — a
// forged Notification could fake a subscribe-success or cancel a paying
// customer. These tests prove the verifier:
//   • accepts a message genuinely signed by the (mocked) AWS key,
//   • rejects a tampered message body,
//   • refuses to fetch a signing cert from a non-amazonaws.com host,
//   • rejects a TopicArn that isn't ours.
//
// The canonical signing string built here mirrors the AWS SNS spec
// (`Key\nValue\n` per field, fixed field set/order per message type), so a green
// test also confirms the implementation reflects that spec, not just itself.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, createSign } from 'node:crypto';

// One RSA keypair for the suite. The "cert" we serve is the SPKI public-key PEM;
// node's createPublicKey (used by verifySnsMessage) extracts the key from it.
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' });

const CERT_URL = 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-test.pem';

// Field sets/order per AWS SNS spec — must match the module under test.
const NOTIFICATION_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'];
const SUBSCRIPTION_FIELDS = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];

function signingString(msg) {
	const fields = msg.Type === 'Notification' ? NOTIFICATION_FIELDS : SUBSCRIPTION_FIELDS;
	return fields
		.filter((k) => msg[k] !== undefined)
		.map((k) => `${k}\n${msg[k]}\n`)
		.join('');
}

/**
 * Build a message and attach a valid AWS-style signature over it.
 *
 * SignatureVersion selects the digest, and SNS supports both: version 1 topics
 * sign with SHA1, version 2 topics with SHA256. A topic can be switched to
 * version 2 at any time, so the verifier has to follow the field rather than
 * assume one.
 */
function signed(msg, signatureVersion = '1') {
	const m = { ...msg, SigningCertURL: msg.SigningCertURL ?? CERT_URL, SignatureVersion: signatureVersion };
	const algorithm = signatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
	const sig = createSign(algorithm).update(signingString(m)).sign(privateKey, 'base64');
	return { ...m, Signature: sig };
}

function validNotification(overrides = {}) {
	return signed({
		Type: 'Notification',
		MessageId: 'id-123',
		Subject: 'AWS Marketplace',
		Message: JSON.stringify({ action: 'subscribe-success', 'customer-identifier': 'CUST1' }),
		Timestamp: '2026-05-30T00:00:00.000Z',
		TopicArn: 'arn:aws:sns:us-east-1:155407237916:marketplace-topic',
		...overrides,
	});
}

let verifySnsMessage;
let assertAwsHttpsUrl;

beforeEach(async () => {
	delete process.env.AWS_MP_SNS_TOPIC_ARN; // default: no ARN pin unless a test sets it
	// Serve our public PEM as the signing cert for the trusted URL; fail any other.
	vi.stubGlobal(
		'fetch',
		vi.fn(async (url) => {
			if (String(url) === CERT_URL) return { ok: true, text: async () => PUBLIC_PEM };
			return { ok: false, status: 404, text: async () => 'not found' };
		}),
	);
	// Import fresh each test so the module-level cert cache / env reads are clean.
	vi.resetModules();
	({ verifySnsMessage, assertAwsHttpsUrl } = await import('../../api/_lib/aws-marketplace.js'));
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('verifySnsMessage', () => {
	it('accepts a genuinely signed Notification', async () => {
		await expect(verifySnsMessage(validNotification())).resolves.toBeUndefined();
	});

	it('accepts a genuinely signed SubscriptionConfirmation (different field set)', async () => {
		const msg = signed({
			Type: 'SubscriptionConfirmation',
			MessageId: 'id-sub',
			Message: 'You have chosen to subscribe',
			SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
			Timestamp: '2026-05-30T00:00:00.000Z',
			Token: 'token-abc',
			TopicArn: 'arn:aws:sns:us-east-1:155407237916:marketplace-topic',
		});
		await expect(verifySnsMessage(msg)).resolves.toBeUndefined();
	});

	it('rejects a tampered message body', async () => {
		const msg = validNotification();
		msg.Message = JSON.stringify({ action: 'subscribe-success', 'customer-identifier': 'ATTACKER' });
		await expect(verifySnsMessage(msg)).rejects.toThrow(/signature verification failed/i);
	});

	it('refuses a signing cert URL not on *.amazonaws.com', async () => {
		const msg = validNotification({ SigningCertURL: 'https://evil.example.com/cert.pem' });
		await expect(verifySnsMessage(msg)).rejects.toThrow(/untrusted sns signing cert url/i);
		// And it must never even fetch the hostile URL.
		expect(fetch).not.toHaveBeenCalledWith('https://evil.example.com/cert.pem');
	});

	it('refuses a non-HTTPS cert URL', async () => {
		const msg = validNotification({ SigningCertURL: 'http://sns.us-east-1.amazonaws.com/cert.pem' });
		await expect(verifySnsMessage(msg)).rejects.toThrow(/untrusted sns signing cert url/i);
	});

	it('rejects a message from a different TopicArn when the ARN is pinned', async () => {
		process.env.AWS_MP_SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:155407237916:marketplace-topic';
		const msg = validNotification({ TopicArn: 'arn:aws:sns:us-east-1:000000000000:other-topic' });
		await expect(verifySnsMessage(msg)).rejects.toThrow(/topicarn mismatch/i);
	});

	it('accepts the matching TopicArn when pinned', async () => {
		process.env.AWS_MP_SNS_TOPIC_ARN = 'arn:aws:sns:us-east-1:155407237916:marketplace-topic';
		await expect(verifySnsMessage(validNotification())).resolves.toBeUndefined();
	});

	// A SignatureVersion 2 topic signs with SHA256. Verifying it with SHA1 fails
	// every genuine message, and the failure reads exactly like a forgery, so the
	// operator hunts an attack that is not there while real lifecycle events are
	// dropped with a 403.
	it('accepts a SignatureVersion 2 message, which AWS signs with SHA256', async () => {
		const msg = signed(
			{
				Type: 'Notification',
				MessageId: 'id-v2',
				Subject: 'AWS Marketplace',
				Message: JSON.stringify({ action: 'subscribe-success', 'customer-identifier': 'CUST1' }),
				Timestamp: '2026-08-17T00:00:00.000Z',
				TopicArn: 'arn:aws:sns:us-east-1:155407237916:marketplace-topic',
			},
			'2',
		);
		await expect(verifySnsMessage(msg)).resolves.toBeUndefined();
	});

	it('still rejects a tampered SignatureVersion 2 message', async () => {
		const msg = signed(
			{
				Type: 'Notification',
				MessageId: 'id-v2-tampered',
				Subject: 'AWS Marketplace',
				Message: JSON.stringify({ action: 'subscribe-success', 'customer-identifier': 'CUST1' }),
				Timestamp: '2026-08-17T00:00:00.000Z',
				TopicArn: 'arn:aws:sns:us-east-1:155407237916:marketplace-topic',
			},
			'2',
		);
		msg.Message = JSON.stringify({ action: 'unsubscribe-success', 'customer-identifier': 'CUST1' });
		await expect(verifySnsMessage(msg)).rejects.toThrow(/signature verification failed/i);
	});
});

// The same guard now protects both URLs this integration dereferences from an
// SNS payload: the signing certificate and the SubscribeURL handshake.
describe('assertAwsHttpsUrl', () => {
	it('accepts an AWS HTTPS endpoint and returns the parsed URL', () => {
		const url = assertAwsHttpsUrl(CERT_URL, 'SNS signing cert URL');
		expect(url.hostname).toBe('sns.us-east-1.amazonaws.com');
	});

	it('refuses a host that merely ends in a lookalike domain', () => {
		expect(() => assertAwsHttpsUrl('https://sns.us-east-1.amazonaws.com.evil.test/c.pem', 'SNS signing cert URL'))
			.toThrow(/untrusted/i);
	});

	it('refuses a non-HTTPS scheme', () => {
		expect(() => assertAwsHttpsUrl('http://sns.us-east-1.amazonaws.com/c.pem', 'SNS signing cert URL'))
			.toThrow(/untrusted/i);
	});

	it('refuses link-local metadata addresses', () => {
		expect(() => assertAwsHttpsUrl('http://169.254.169.254/latest/meta-data/', 'SNS SubscribeURL'))
			.toThrow(/untrusted/i);
	});

	it('turns a missing URL into the same refusal, not a TypeError', () => {
		expect(() => assertAwsHttpsUrl(undefined, 'SNS SubscribeURL')).toThrow(/untrusted/i);
	});
});
