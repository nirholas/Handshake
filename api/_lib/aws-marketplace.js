// AWS Marketplace integration helpers.
//
// Covers the three integration points for a SaaS usage-based listing:
//   1. resolveCustomer  — exchange a registration token for a stable customer ID
//   2. meterUsage       — report metered consumption to AWS for billing
//   3. getEntitlements  — check what a customer is entitled to (contract products)
//   4. verifySnsMessage — validate that an SNS notification is genuinely from AWS

import {
	MarketplaceMeteringClient,
	ResolveCustomerCommand,
	MeterUsageCommand,
} from '@aws-sdk/client-marketplace-metering';
import {
	MarketplaceEntitlementServiceClient,
	GetEntitlementsCommand,
} from '@aws-sdk/client-marketplace-entitlement-service';
import { createVerify, createPublicKey } from 'node:crypto';
import { env } from './env.js';

function credentials() {
	return {
		accessKeyId: env.AWS_MP_ACCESS_KEY_ID,
		secretAccessKey: env.AWS_MP_SECRET_ACCESS_KEY,
	};
}

function meteringClient() {
	return new MarketplaceMeteringClient({
		region: env.AWS_MP_REGION,
		credentials: credentials(),
	});
}

function entitlementClient() {
	return new MarketplaceEntitlementServiceClient({
		region: env.AWS_MP_REGION,
		credentials: credentials(),
	});
}

/**
 * Exchange the registration token (from the POST body of the registration URL)
 * for a stable CustomerIdentifier and ProductCode.
 *
 * Returns { customerIdentifier, productCode, customerAWSAccountId }.
 * Throws on invalid/expired token.
 */
export async function resolveCustomer(registrationToken) {
	const client = meteringClient();
	const result = await client.send(
		new ResolveCustomerCommand({ RegistrationToken: registrationToken }),
	);
	return {
		customerIdentifier: result.CustomerIdentifier,
		productCode: result.ProductCode,
		customerAWSAccountId: result.CustomerAWSAccountId,
	};
}

/**
 * Report metered usage to AWS Marketplace for billing.
 *
 * @param {object} params
 * @param {string} params.customerIdentifier  — from resolveCustomer
 * @param {string} params.dimension           — usage dimension defined in seller portal
 * @param {number} params.quantity            — units consumed
 * @param {Date}   [params.timestamp]         — defaults to now
 * @param {string} [params.usageAllocationId] — idempotency key (UUID recommended)
 */
export async function meterUsage({ customerIdentifier, dimension, quantity, timestamp, usageAllocationId }) {
	const client = meteringClient();
	const result = await client.send(
		new MeterUsageCommand({
			ProductCode: env.AWS_MP_PRODUCT_CODE,
			UsageDimension: dimension,
			UsageQuantity: quantity,
			Timestamp: timestamp ?? new Date(),
			CustomerIdentifier: customerIdentifier,
			...(usageAllocationId ? { UsageAllocations: [{ AllocatedUsageQuantity: quantity, Tags: [{ Key: 'allocationId', Value: usageAllocationId }] }] } : {}),
		}),
	);
	return result.MeteringRecordId;
}

/**
 * Check entitlements for a customer (used for contract-based products).
 * Returns the list of active entitlement objects.
 */
export async function getEntitlements(customerIdentifier) {
	const client = entitlementClient();
	const result = await client.send(
		new GetEntitlementsCommand({
			ProductCode: env.AWS_MP_PRODUCT_CODE,
			Filter: { CUSTOMER_IDENTIFIER: [customerIdentifier] },
		}),
	);
	return result.Entitlements ?? [];
}

// ── SNS signature verification ────────────────────────────────────────────────
// AWS signs every SNS message with a private key and includes the cert URL.
// We download the cert once (cached per URL), build the canonical string, and
// verify the signature so we know the notification genuinely came from AWS.

const certCache = new Map();

async function fetchCert(url) {
	if (certCache.has(url)) return certCache.get(url);

	// Only trust certs hosted on *.amazonaws.com over HTTPS.
	const parsed = new URL(url);
	if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.amazonaws.com')) {
		throw new Error(`Untrusted SNS signing cert URL: ${url}`);
	}

	const res = await fetch(url);
	if (!res.ok) throw new Error(`Failed to fetch SNS cert: ${res.status}`);
	const pem = await res.text();
	certCache.set(url, pem);
	return pem;
}

// Fields included in the signature string differ by message type.
const NOTIFICATION_FIELDS = ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'];
const SUBSCRIPTION_FIELDS = ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];

function buildSignatureString(msg) {
	const fields =
		msg.Type === 'Notification' ? NOTIFICATION_FIELDS : SUBSCRIPTION_FIELDS;
	return fields
		.filter((k) => msg[k] !== undefined)
		.map((k) => `${k}\n${msg[k]}\n`)
		.join('');
}

/**
 * Verify that a parsed SNS message object was genuinely signed by AWS.
 * Throws if verification fails; returns void on success.
 */
export async function verifySnsMessage(msg) {
	const expectedTopicArn = env.AWS_MP_SNS_TOPIC_ARN;
	if (expectedTopicArn && msg.TopicArn !== expectedTopicArn) {
		throw new Error(`SNS TopicArn mismatch: got ${msg.TopicArn}`);
	}

	const pem = await fetchCert(msg.SigningCertURL);
	const pubKey = createPublicKey(pem);
	const verifier = createVerify('SHA1');
	verifier.update(buildSignatureString(msg));
	const valid = verifier.verify(pubKey, msg.Signature, 'base64');
	if (!valid) throw new Error('SNS signature verification failed');
}
