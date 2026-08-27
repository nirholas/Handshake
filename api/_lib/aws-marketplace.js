// AWS Marketplace integration helpers.
//
// Covers the integration points for a SaaS listing under the Concurrent
// Agreements requirements AWS made mandatory for new products on 2026-06-01:
//   1. resolveCustomer        : exchange a registration token for the buyer's
//                               LicenseArn + CustomerAWSAccountId
//   2. meterUsage             : report consumption (BatchMeterUsage, keyed on
//                               LicenseArn) for a usage-priced listing
//   3. getEntitlements        : check entitlements for a contract listing
//   4. verifySnsMessage       : validate a legacy SNS lifecycle notification
//   5. parseMarketplaceEvent  : normalize an EventBridge agreement/license event
//   6. verifyEventSecret      : authenticate the EventBridge API destination
//
// Why both notification transports: AWS still documents the SNS subscription
// topic for existing integrations, but new products receive agreement and
// license lifecycle events on the seller account's default EventBridge bus
// instead, and SNS never carries a LicenseArn. The webhook accepts either
// envelope so the listing works whichever one AWS wires up for it.

import {
	MarketplaceMeteringClient,
	ResolveCustomerCommand,
	MeterUsageCommand,
	BatchMeterUsageCommand,
} from '@aws-sdk/client-marketplace-metering';
import {
	MarketplaceEntitlementServiceClient,
	GetEntitlementsCommand,
} from '@aws-sdk/client-marketplace-entitlement-service';
import { createVerify, createPublicKey, timingSafeEqual } from 'node:crypto';
import { env } from './env.js';
import { fetchUpstream } from './upstream-fetch.js';

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
 * for the buyer's identity.
 *
 * For a NEW SaaS integration AWS leaves `CustomerIdentifier` empty and returns
 * `LicenseArn` + `CustomerAWSAccountId` instead, so all four fields are surfaced
 * and the caller keys on whichever it got. Our listing has never been created,
 * which makes it a new integration by definition; the legacy field is carried
 * only so a pre-existing row can still be matched.
 *
 * Returns { customerIdentifier, licenseArn, customerAWSAccountId, productCode }.
 * Throws on an invalid or expired token.
 */
export async function resolveCustomer(registrationToken) {
	const client = meteringClient();
	const result = await client.send(
		new ResolveCustomerCommand({ RegistrationToken: registrationToken }),
	);
	return {
		customerIdentifier: result.CustomerIdentifier || null,
		licenseArn: result.LicenseArn || null,
		customerAWSAccountId: result.CustomerAWSAccountId || null,
		productCode: result.ProductCode,
	};
}

/**
 * Report metered usage to AWS Marketplace for billing.
 *
 * New integrations meter through BatchMeterUsage with `LicenseArn` +
 * `CustomerAWSAccountId` per record; `MeterUsage` with a `CustomerIdentifier` is
 * the legacy shape and is only used when that is genuinely all we hold for the
 * buyer. Returns the metering record id, or null when AWS accepted the batch
 * without issuing one.
 *
 * @param {object} params
 * @param {string} [params.licenseArn]           from resolveCustomer (new integrations)
 * @param {string} [params.customerAWSAccountId] from resolveCustomer (new integrations)
 * @param {string} [params.customerIdentifier]   legacy integrations only
 * @param {string} params.dimension              usage dimension defined in the seller portal
 * @param {number} params.quantity               units consumed
 * @param {Date}   [params.timestamp]            defaults to now
 */
export async function meterUsage({
	licenseArn,
	customerAWSAccountId,
	customerIdentifier,
	dimension,
	quantity,
	timestamp,
}) {
	const client = meteringClient();
	const when = timestamp ?? new Date();

	if (licenseArn || customerAWSAccountId) {
		const result = await client.send(
			new BatchMeterUsageCommand({
				ProductCode: env.AWS_MP_PRODUCT_CODE,
				UsageRecords: [
					{
						Timestamp: when,
						Dimension: dimension,
						Quantity: quantity,
						...(licenseArn ? { LicenseArn: licenseArn } : {}),
						...(customerAWSAccountId ? { CustomerAWSAccountId: customerAWSAccountId } : {}),
					},
				],
			}),
		);
		const [record] = result.Results ?? [];
		if (record && record.Status && record.Status !== 'Success') {
			throw new Error(`BatchMeterUsage rejected the record: ${record.Status}`);
		}
		return record?.MeteringRecordId ?? null;
	}

	if (!customerIdentifier) {
		throw new Error('meterUsage: need LicenseArn/CustomerAWSAccountId (new integrations) or CustomerIdentifier (legacy)');
	}

	const result = await client.send(
		new MeterUsageCommand({
			ProductCode: env.AWS_MP_PRODUCT_CODE,
			UsageDimension: dimension,
			UsageQuantity: quantity,
			Timestamp: when,
			CustomerIdentifier: customerIdentifier,
		}),
	);
	return result.MeteringRecordId ?? null;
}

/**
 * Check entitlements for a buyer (contract-based products).
 *
 * Filters on CUSTOMER_AWS_ACCOUNT_ID, which is the filter new integrations must
 * use; CUSTOMER_IDENTIFIER remains only for a legacy row that has nothing else.
 * Returns the list of entitlement objects.
 */
export async function getEntitlements({ customerAWSAccountId, customerIdentifier }) {
	const filter = customerAWSAccountId
		? { CUSTOMER_AWS_ACCOUNT_ID: [customerAWSAccountId] }
		: { CUSTOMER_IDENTIFIER: [customerIdentifier] };
	if (!customerAWSAccountId && !customerIdentifier) {
		throw new Error('getEntitlements: need CustomerAWSAccountId or CustomerIdentifier');
	}
	const client = entitlementClient();
	const result = await client.send(
		new GetEntitlementsCommand({
			ProductCode: env.AWS_MP_PRODUCT_CODE,
			Filter: filter,
		}),
	);
	return result.Entitlements ?? [];
}

/**
 * True when the AWS Marketplace integration has the credentials + product code
 * it needs to call AWS. Read directly from process.env so it never throws the
 * way the `req()`-backed env getters do when unconfigured — that's what lets the
 * whole path ship INERT (like the fee module) instead of erroring.
 */
export function awsMarketplaceConfigured() {
	return Boolean(
		process.env.AWS_MP_ACCESS_KEY_ID &&
			process.env.AWS_MP_SECRET_ACCESS_KEY &&
			process.env.AWS_MP_PRODUCT_CODE,
	);
}

/**
 * Resolve whether a customer is currently ENTITLED, via a real GetEntitlements
 * call — filtering out expired entitlements. Inert (entitled:null) when AWS is
 * not configured, so a deployment without AWS creds degrades open and never
 * fakes an entitlement AWS didn't grant. Throttling / network errors surface as
 * a typed, retryable error the caller turns into an actionable boundary state.
 *
 * @returns {Promise<{ configured: boolean, entitled: boolean|null, entitlements: object[] }>}
 */
export async function customerEntitlement({ customerAWSAccountId, customerIdentifier }) {
	if (!awsMarketplaceConfigured()) return { configured: false, entitled: null, entitlements: [] };
	if (!customerAWSAccountId && !customerIdentifier) {
		return { configured: true, entitled: null, entitlements: [] };
	}
	try {
		const entitlements = await getEntitlements({ customerAWSAccountId, customerIdentifier });
		const now = Date.now();
		const active = entitlements.filter(
			(e) => !e.ExpirationDate || new Date(e.ExpirationDate).getTime() > now,
		);
		return { configured: true, entitled: active.length > 0, entitlements: active };
	} catch (err) {
		const e = new Error(`aws_entitlement_check_failed: ${err?.name || ''} ${err?.message || ''}`.trim());
		e.code = 'aws_entitlement_unavailable';
		e.retryable = err?.name === 'ThrottlingException' || err?.name === 'InternalServiceErrorException';
		throw e;
	}
}

// ── SNS signature verification ────────────────────────────────────────────────
// AWS signs every SNS message with a private key and includes the cert URL.
// We download the cert once (cached per URL), build the canonical string, and
// verify the signature so we know the notification genuinely came from AWS.

const certCache = new Map();

/**
 * Assert that a URL taken from an SNS payload is an AWS-hosted HTTPS endpoint
 * before anything dereferences it. Both places that follow such a URL (the
 * signing certificate and the SubscribeURL handshake) go through this, so a
 * payload can never steer an outbound request at a host of its choosing.
 * Also turns a missing/garbage URL into this same refusal instead of a
 * TypeError from the URL constructor.
 *
 * @param {unknown} value  the URL as it appeared in the payload
 * @param {string} label   what the URL is, for the thrown message
 * @returns {URL} the parsed, trusted URL
 */
export function assertAwsHttpsUrl(value, label) {
	let parsed;
	try {
		parsed = new URL(String(value));
	} catch {
		throw new Error(`Untrusted ${label}: ${value}`);
	}
	if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.amazonaws.com')) {
		throw new Error(`Untrusted ${label}: ${value}`);
	}
	return parsed;
}

async function fetchCert(url) {
	if (certCache.has(url)) return certCache.get(url);

	// Only trust certs hosted on *.amazonaws.com over HTTPS.
	assertAwsHttpsUrl(url, 'SNS signing cert URL');

	// The PEM is cached per URL above, so this is paid once per cert rotation.
	const res = await fetchUpstream(url, {}, { name: 'aws-sns-cert', timeoutMs: 8_000, attempts: 3, okWhen: () => true });
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
 *
 * SignatureVersion selects the digest: version 1 topics sign with SHA1, and
 * version 2 topics (which AWS now recommends, and which a topic can be switched
 * to at any time) sign with SHA256. Hardcoding SHA1 rejects every message from
 * a version 2 topic with a signature failure that reads like an attack.
 */
export async function verifySnsMessage(msg) {
	const expectedTopicArn = env.AWS_MP_SNS_TOPIC_ARN;
	if (expectedTopicArn && msg.TopicArn !== expectedTopicArn) {
		throw new Error(`SNS TopicArn mismatch: got ${msg.TopicArn}`);
	}

	const digest = String(msg.SignatureVersion) === '2' ? 'SHA256' : 'SHA1';
	const pem = await fetchCert(msg.SigningCertURL);
	const pubKey = createPublicKey(pem);
	const verifier = createVerify(digest);
	verifier.update(buildSignatureString(msg));
	const valid = verifier.verify(pubKey, msg.Signature, 'base64');
	if (!valid) throw new Error('SNS signature verification failed');
}

// ── EventBridge agreement + license events ───────────────────────────────────
// New SaaS products receive lifecycle notifications as EventBridge events on the
// seller account's default bus, not on an SNS topic. EventBridge cannot call an
// external HTTPS endpoint directly, so a rule relays them through an API
// destination, whose connection attaches a shared secret header. That header is
// the only thing standing between this endpoint and an anonymous caller who
// wants to revoke a buyer's access, so an unset secret refuses delivery outright
// rather than trusting the payload.

export const AGREEMENT_EVENT_SOURCE = 'aws.agreement-marketplace';

/** Header the EventBridge API destination connection attaches. */
export const EVENT_SECRET_HEADER = 'x-three-ws-marketplace-secret';

/**
 * Constant-time comparison of the request's shared secret against the configured
 * one. Returns a reason string on failure, or null when the request is trusted.
 */
export function verifyEventSecret(req) {
	const expected = env.AWS_MP_EVENT_SECRET;
	if (!expected) return 'not_configured';
	const presented = req.headers?.[EVENT_SECRET_HEADER];
	if (typeof presented !== 'string' || presented.length === 0) return 'missing_secret';
	const a = Buffer.from(presented, 'utf8');
	const b = Buffer.from(expected, 'utf8');
	if (a.length !== b.length) return 'bad_secret';
	return timingSafeEqual(a, b) ? null : 'bad_secret';
}

/** True when the parsed body looks like an EventBridge envelope rather than SNS. */
export function isEventBridgeEnvelope(body) {
	return Boolean(body && typeof body === 'object' && typeof body['detail-type'] === 'string' && body.source);
}

/**
 * Normalize an AWS Marketplace EventBridge event into the fields the webhook
 * acts on. Returns null for an event from another source.
 *
 * `kind` is one of:
 *   agreement-created      a new/renewed/amended agreement; grant access
 *   agreement-ended        expired, cancelled, or terminated; revoke access
 *   license-updated        the buyer's license was provisioned or changed
 *   license-deprovisioned  the buyer's license ended; revoke access
 *   ignored                a marketplace event this listing takes no action on
 *
 * Manufacturer and proposer variants of the agreement events are identical for
 * our purposes (we are both), so the role suffix is stripped.
 */
export function parseMarketplaceEvent(event) {
	if (!event || event.source !== AGREEMENT_EVENT_SOURCE) return null;

	const detailType = String(event['detail-type'] || '');
	const base = detailType.replace(/\s+-\s+(Manufacturer|Proposer|Acceptor)$/, '').trim();
	const detail = event.detail || {};

	const common = {
		detailType,
		agreementId: detail.agreement?.id ?? null,
		agreementStatus: detail.agreement?.status ?? null,
		acceptorAccountId: detail.acceptor?.accountId ?? detail.agreement?.acceptorId ?? null,
		offerId: detail.offer?.id ?? detail.agreement?.offerId ?? null,
		productCode: detail.product?.code ?? null,
		licenseArn: detail.license?.arn ?? null,
	};

	switch (base) {
		case 'Purchase Agreement Created':
		case 'Purchase Agreement Amended':
			return { kind: 'agreement-created', ...common };
		case 'Purchase Agreement Ended':
			return { kind: 'agreement-ended', ...common };
		case 'License Updated':
			return { kind: 'license-updated', ...common };
		case 'License Deprovisioned':
			return { kind: 'license-deprovisioned', ...common };
		default:
			return { kind: 'ignored', ...common };
	}
}
