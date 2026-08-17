// AWS Marketplace customer records.
//
// One place that knows how a marketplace buyer is identified, because AWS
// changed the answer and the answer is now different depending on which side of
// the integration the buyer arrives from:
//
//   • ResolveCustomer (the registration URL, when the buyer clicks "Set up your
//     account") returns LicenseArn + CustomerAWSAccountId + ProductCode. For a
//     new SaaS integration CustomerIdentifier arrives empty, so LicenseArn is
//     the identity.
//   • EventBridge agreement events (Purchase Agreement Created/Ended) carry an
//     agreement id and the acceptor's AWS account id, but no license ARN.
//   • EventBridge license events (License Updated/Deprovisioned) carry the
//     license ARN and the product code.
//
// Those three can arrive in any order, so every write here merges rather than
// assuming it is the first to see the buyer. Under Concurrent Agreements one AWS
// account can hold several live agreements for the same product, which is why
// nothing keys on (aws account, product code) alone.
//
// The handle we hand to the browser is the row's own UUID, never the license ARN
// A license ARN in a redirect URL is a grant identifier sitting in history,
// referrers, and logs for no benefit.

import { sql } from './db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CUSTOMER_COLUMNS = sql`
	id, customer_identifier, license_arn, agreement_id, product_code,
	customer_aws_account_id, offer_id, user_id, subscription_status,
	is_free_trial, x402_subscription_id, subscribed_at, cancelled_at
`;

/** True when the row is in a state that should still grant access. */
export function isActiveStatus(status) {
	return status === 'active' || status === 'trial' || status === 'pending';
}

/**
 * Look up a customer by the opaque handle the welcome page carries.
 *
 * Accepts the row UUID (what register.js issues today) or a legacy
 * CustomerIdentifier, so a buyer who subscribed before the re-key can still
 * complete setup from a bookmarked link.
 */
export async function findCustomerByHandle(handle) {
	if (!handle || typeof handle !== 'string') return null;
	const [row] = UUID_RE.test(handle)
		? await sql`select ${CUSTOMER_COLUMNS} from aws_marketplace_customers where id = ${handle} limit 1`
		: await sql`select ${CUSTOMER_COLUMNS} from aws_marketplace_customers where customer_identifier = ${handle} limit 1`;
	return row ?? null;
}

/** Look up a customer by row id. */
export async function findCustomerById(id) {
	if (!id) return null;
	const [row] = await sql`select ${CUSTOMER_COLUMNS} from aws_marketplace_customers where id = ${id} limit 1`;
	return row ?? null;
}

/** Look up a customer by the AWS-granted license ARN. */
export async function findCustomerByLicenseArn(licenseArn) {
	if (!licenseArn) return null;
	const [row] = await sql`select ${CUSTOMER_COLUMNS} from aws_marketplace_customers where license_arn = ${licenseArn} limit 1`;
	return row ?? null;
}

/**
 * Record the buyer resolved from a registration token.
 *
 * Merge order: the license ARN if we have seen it, then a legacy customer
 * identifier, then a pending row already opened by a Purchase Agreement Created
 * event for the same AWS account and product. Only when none of those match do
 * we insert.
 *
 * @param {object} resolved
 * @param {string|null} resolved.licenseArn
 * @param {string|null} resolved.customerAWSAccountId
 * @param {string|null} resolved.customerIdentifier
 * @param {string} resolved.productCode
 * @param {boolean} [resolved.isFreeTrial]
 * @returns {Promise<object>} the stored customer row
 */
export async function upsertResolvedCustomer({
	licenseArn = null,
	customerAWSAccountId = null,
	customerIdentifier = null,
	productCode,
	isFreeTrial = false,
}) {
	if (!licenseArn && !customerIdentifier) {
		throw new Error('upsertResolvedCustomer: ResolveCustomer returned neither LicenseArn nor CustomerIdentifier');
	}
	const status = isFreeTrial ? 'trial' : 'active';

	const existing =
		(await findCustomerByLicenseArn(licenseArn)) ??
		(customerIdentifier ? await findCustomerByLegacyIdentifier(customerIdentifier) : null) ??
		(await findAdoptablePendingRow({ customerAWSAccountId, productCode }));

	if (existing) {
		const [row] = await sql`
			update aws_marketplace_customers
			set license_arn             = coalesce(${licenseArn}, license_arn),
			    customer_identifier     = coalesce(${customerIdentifier}, customer_identifier),
			    customer_aws_account_id = coalesce(${customerAWSAccountId}, customer_aws_account_id),
			    product_code            = coalesce(${productCode}, product_code),
			    is_free_trial           = ${isFreeTrial},
			    -- A cancelled buyer who re-subscribes comes back through this same
			    -- path, so a terminal status has to reopen. An already-live status
			    -- is left alone: the lifecycle events own it from here.
			    subscription_status     = case
			        when subscription_status in ('cancelled', 'expired', 'pending') then ${status}
			        else subscription_status
			    end,
			    subscribed_at           = coalesce(subscribed_at, now()),
			    cancelled_at            = null,
			    updated_at              = now()
			where id = ${existing.id}
			returning ${CUSTOMER_COLUMNS}
		`;
		return row;
	}

	const [row] = await sql`
		insert into aws_marketplace_customers
			(customer_identifier, license_arn, product_code, customer_aws_account_id,
			 subscription_status, is_free_trial, subscribed_at)
		values
			(${customerIdentifier}, ${licenseArn}, ${productCode}, ${customerAWSAccountId},
			 ${status}, ${isFreeTrial}, now())
		on conflict (license_arn) where license_arn is not null do update set
			customer_identifier     = coalesce(excluded.customer_identifier, aws_marketplace_customers.customer_identifier),
			customer_aws_account_id = coalesce(excluded.customer_aws_account_id, aws_marketplace_customers.customer_aws_account_id),
			is_free_trial           = excluded.is_free_trial,
			subscription_status     = case
			    when aws_marketplace_customers.subscription_status in ('cancelled', 'expired', 'pending')
			    then excluded.subscription_status
			    else aws_marketplace_customers.subscription_status
			end,
			subscribed_at           = coalesce(aws_marketplace_customers.subscribed_at, now()),
			cancelled_at            = null,
			updated_at              = now()
		returning ${CUSTOMER_COLUMNS}
	`;
	return row;
}

async function findCustomerByLegacyIdentifier(customerIdentifier) {
	const [row] = await sql`
		select ${CUSTOMER_COLUMNS} from aws_marketplace_customers
		where customer_identifier = ${customerIdentifier} limit 1
	`;
	return row ?? null;
}

/**
 * A Purchase Agreement Created event can land before the buyer ever clicks
 * "Set up your account", leaving a row that knows the agreement but not the
 * license. When registration then resolves a license for that same AWS account
 * and product, adopt that row instead of opening a second one.
 *
 * Only an unlicensed, unclaimed row qualifies, and only when exactly one
 * matches. With concurrent agreements a buyer can legitimately have several,
 * and guessing between them would attach the wrong agreement.
 */
async function findAdoptablePendingRow({ customerAWSAccountId, productCode }) {
	if (!customerAWSAccountId) return null;
	const rows = await sql`
		select ${CUSTOMER_COLUMNS} from aws_marketplace_customers
		where customer_aws_account_id = ${customerAWSAccountId}
		  and product_code = ${productCode}
		  and license_arn is null
		  and user_id is null
		  and subscription_status not in ('cancelled', 'expired')
		limit 2
	`;
	return rows.length === 1 ? rows[0] : null;
}

/**
 * Record a Purchase Agreement Created event.
 *
 * Stamps the agreement id onto the buyer's row so a later Purchase Agreement
 * Ended can be resolved unambiguously. Opens a pending row when the buyer has
 * not registered yet; registration adopts it.
 */
export async function recordAgreementCreated({ agreementId, acceptorAccountId, offerId, productCode }) {
	if (!agreementId) return null;

	const [byAgreement] = await sql`
		select ${CUSTOMER_COLUMNS} from aws_marketplace_customers
		where agreement_id = ${agreementId} limit 1
	`;
	if (byAgreement) {
		const [row] = await sql`
			update aws_marketplace_customers
			set offer_id            = coalesce(${offerId ?? null}, offer_id),
			    subscription_status = case
			        when subscription_status in ('cancelled', 'expired') then 'active'
			        else subscription_status
			    end,
			    cancelled_at        = null,
			    subscribed_at       = coalesce(subscribed_at, now()),
			    updated_at          = now()
			where id = ${byAgreement.id}
			returning ${CUSTOMER_COLUMNS}
		`;
		return row;
	}

	// The buyer may already have registered (license known, agreement not yet
	// stamped). Claim the single unstamped row for this AWS account, if there is
	// exactly one; otherwise open a fresh pending row for this agreement.
	const candidates = acceptorAccountId
		? await sql`
			select ${CUSTOMER_COLUMNS} from aws_marketplace_customers
			where customer_aws_account_id = ${acceptorAccountId}
			  and product_code = ${productCode}
			  and agreement_id is null
			  and subscription_status not in ('cancelled', 'expired')
			limit 2
		`
		: [];

	if (candidates.length === 1) {
		const [row] = await sql`
			update aws_marketplace_customers
			set agreement_id  = ${agreementId},
			    offer_id      = coalesce(${offerId ?? null}, offer_id),
			    subscribed_at = coalesce(subscribed_at, now()),
			    updated_at    = now()
			where id = ${candidates[0].id}
			returning ${CUSTOMER_COLUMNS}
		`;
		return row;
	}

	const [row] = await sql`
		insert into aws_marketplace_customers
			(agreement_id, product_code, customer_aws_account_id, offer_id,
			 subscription_status, subscribed_at)
		values
			(${agreementId}, ${productCode}, ${acceptorAccountId ?? null}, ${offerId ?? null},
			 'pending', now())
		returning ${CUSTOMER_COLUMNS}
	`;
	return row;
}

/**
 * Attach the license ARN AWS issues for an agreement (License Updated event).
 * This is how an agreement-first row learns its license without waiting for the
 * buyer to open the registration URL.
 */
export async function attachLicenseToAgreement({ agreementId, licenseArn, acceptorAccountId, productCode, offerId }) {
	if (!licenseArn) return null;

	const known = await findCustomerByLicenseArn(licenseArn);
	if (known) {
		const [row] = await sql`
			update aws_marketplace_customers
			set agreement_id        = coalesce(${agreementId ?? null}, agreement_id),
			    offer_id            = coalesce(${offerId ?? null}, offer_id),
			    subscription_status = case
			        when subscription_status in ('cancelled', 'expired') then 'active'
			        else subscription_status
			    end,
			    cancelled_at        = null,
			    updated_at          = now()
			where id = ${known.id}
			returning ${CUSTOMER_COLUMNS}
		`;
		return row;
	}

	if (agreementId) {
		const [linked] = await sql`
			update aws_marketplace_customers
			set license_arn         = ${licenseArn},
			    offer_id            = coalesce(${offerId ?? null}, offer_id),
			    subscription_status = case
			        when subscription_status = 'pending' then 'active'
			        else subscription_status
			    end,
			    updated_at          = now()
			where agreement_id = ${agreementId}
			  and license_arn is null
			returning ${CUSTOMER_COLUMNS}
		`;
		if (linked) return linked;
	}

	const [row] = await sql`
		insert into aws_marketplace_customers
			(license_arn, agreement_id, product_code, customer_aws_account_id, offer_id,
			 subscription_status, subscribed_at)
		values
			(${licenseArn}, ${agreementId ?? null}, ${productCode}, ${acceptorAccountId ?? null},
			 ${offerId ?? null}, 'active', now())
		on conflict (license_arn) where license_arn is not null do update set
			agreement_id = coalesce(excluded.agreement_id, aws_marketplace_customers.agreement_id),
			updated_at   = now()
		returning ${CUSTOMER_COLUMNS}
	`;
	return row;
}

/**
 * Resolve the row(s) an ending/deprovisioning event refers to.
 *
 * Returns an array so the caller can refuse to act on an ambiguous match rather
 * than revoking a paying buyer's other, still-live agreement. Resolution order
 * is most specific first: license ARN, then agreement id, then the single live
 * row for that AWS account.
 */
export async function resolveLifecycleTargets({ licenseArn, agreementId, acceptorAccountId, productCode }) {
	if (licenseArn) {
		const row = await findCustomerByLicenseArn(licenseArn);
		return row ? [row] : [];
	}
	if (agreementId) {
		const rows = await sql`
			select ${CUSTOMER_COLUMNS} from aws_marketplace_customers
			where agreement_id = ${agreementId}
		`;
		if (rows.length) return rows;
	}
	if (acceptorAccountId) {
		return await sql`
			select ${CUSTOMER_COLUMNS} from aws_marketplace_customers
			where customer_aws_account_id = ${acceptorAccountId}
			  and product_code = ${productCode}
			  and subscription_status not in ('cancelled', 'expired')
			limit 2
		`;
	}
	return [];
}

/** Flip a row to a terminal status. Stamps cancelled_at only on a terminal one. */
export async function markCustomerStatus(id, status) {
	const cancelled = status === 'cancelled' || status === 'expired';
	const [row] = await sql`
		update aws_marketplace_customers
		set subscription_status = ${status},
		    cancelled_at        = case when ${cancelled}::boolean then now() else cancelled_at end,
		    updated_at          = now()
		where id = ${id}
		returning ${CUSTOMER_COLUMNS}
	`;
	return row ?? null;
}

/** Attach a three.ws user to a marketplace row. Returns the updated row, or null on a lost race. */
export async function claimCustomerForUser(id, userId) {
	const [row] = await sql`
		update aws_marketplace_customers
		set user_id    = ${userId},
		    updated_at = now()
		where id = ${id}
		  and (user_id is null or user_id = ${userId})
		returning ${CUSTOMER_COLUMNS}
	`;
	return row ?? null;
}

export const __test = { UUID_RE };
