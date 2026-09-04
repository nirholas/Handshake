// Knock persistence: doors, the knock log, and the block list.
//
// Every write is scoped to a user id the caller already authenticated. The two
// public reads (a door by handle, the directory) deliberately return only what
// a stranger is allowed to see: the price, the greeting, and the owner's
// display identity. A payout address is never in a public payload.

import { sql } from '../db.js';
import { DEFAULT_PRICE_ATOMICS, KNOCK_STATUSES, normalizeHandle } from './policy.js';

const DOOR_COLUMNS = sql`
	user_id, open, price_atomics::text as price_atomics, pay_to_solana, pay_to_base,
	escrow_enabled, escrow_window_hours,
	headline, greeting, max_chars, daily_cap, listed, created_at, updated_at
`;

/**
 * The owner's own door. Provisions a closed default row on first read so the
 * settings page always has something real to render and save against.
 */
export async function getDoor(userId) {
	const [row] = await sql`select ${DOOR_COLUMNS} from knock_doors where user_id = ${userId}`;
	if (row) return row;
	const [created] = await sql`
		insert into knock_doors (user_id, price_atomics)
		values (${userId}, ${DEFAULT_PRICE_ATOMICS.toString()})
		on conflict (user_id) do update set updated_at = now()
		returning ${DOOR_COLUMNS}
	`;
	return created;
}

export async function updateDoor(userId, patch) {
	await getDoor(userId);
	const [row] = await sql`
		update knock_doors set
			open          = coalesce(${patch.open ?? null}, open),
			price_atomics = coalesce(${patch.price_atomics ?? null}, price_atomics),
			pay_to_solana = ${patch.pay_to_solana === undefined ? sql`pay_to_solana` : patch.pay_to_solana},
			pay_to_base   = ${patch.pay_to_base === undefined ? sql`pay_to_base` : patch.pay_to_base},
			headline      = ${patch.headline === undefined ? sql`headline` : patch.headline},
			greeting      = ${patch.greeting === undefined ? sql`greeting` : patch.greeting},
			max_chars     = coalesce(${patch.max_chars ?? null}, max_chars),
			daily_cap     = coalesce(${patch.daily_cap ?? null}, daily_cap),
			listed        = coalesce(${patch.listed ?? null}, listed),
			escrow_enabled = coalesce(${patch.escrow_enabled ?? null}, escrow_enabled),
			escrow_window_hours = coalesce(${patch.escrow_window_hours ?? null}, escrow_window_hours),
			updated_at    = now()
		where user_id = ${userId}
		returning ${DOOR_COLUMNS}
	`;
	return row;
}

/**
 * A door as a stranger sees it, looked up by @username.
 * Returns null when the handle matches nobody or that account never opened one,
 * so the public endpoint answers the same 404 either way and a probe cannot use
 * it to enumerate which accounts exist.
 */
export async function publicDoorByHandle(handle) {
	const username = normalizeHandle(handle);
	if (!username) return null;
	const [row] = await sql`
		select u.id as user_id, u.username, u.display_name, u.avatar_url, u.verified_type,
		       d.open, d.price_atomics::text as price_atomics, d.headline, d.greeting,
		       d.max_chars, d.daily_cap, d.listed,
		       d.escrow_enabled, d.escrow_window_hours,
		       -- The owner's Solana address, and ONLY when they turned the
		       -- escrowed lane on. It is half of their on-chain door address,
		       -- which a stranger has to derive before they can escrow
		       -- anything. api/knock/door.js ships the derived address rather
		       -- than this one, so a payout address still never appears in a
		       -- public body; the account it points at is public because the
		       -- owner opted into publishing it.
		       case when d.escrow_enabled then d.pay_to_solana end as escrow_owner,
		       d.pay_to_solana is not null as has_solana_payout,
		       d.pay_to_base is not null as has_base_payout
		from users u
		join knock_doors d on d.user_id = u.id
		where lower(u.username) = ${username} and u.deleted_at is null and d.open
	`;
	return row || null;
}

/** The payout addresses, read only on the settle path. Never in a public body. */
export async function payoutFor(userId) {
	const [row] = await sql`
		select d.pay_to_solana, d.pay_to_base, u.wallet_address
		from knock_doors d join users u on u.id = d.user_id
		where d.user_id = ${userId}
	`;
	return row || null;
}

/** Open, listed doors, cheapest first so the browsable page starts reachable. */
export async function listDirectory({ limit = 60 } = {}) {
	return sql`
		select u.username, u.display_name, u.avatar_url, u.verified_type,
		       d.price_atomics::text as price_atomics, d.headline, d.updated_at,
		       (select count(*)::int from knock_messages m
		         where m.recipient_user_id = d.user_id and m.status = 'replied') as replies
		from knock_doors d
		join users u on u.id = d.user_id
		where d.open and d.listed and u.deleted_at is null and u.username is not null
		order by d.price_atomics asc, d.updated_at desc
		limit ${limit}
	`;
}

export async function knocksToday(userId) {
	const [row] = await sql`
		select count(*)::int as count from knock_messages
		where recipient_user_id = ${userId} and created_at >= date_trunc('day', now() at time zone 'utc')
	`;
	return row?.count ?? 0;
}

export async function isBlocked(userId, keys) {
	if (!keys?.length) return false;
	const [row] = await sql`
		select 1 from knock_blocks
		where user_id = ${userId} and lower(subject) = any(${keys})
		limit 1
	`;
	return Boolean(row);
}

/**
 * Record a knock. Returns null when `request_id` has already been used by this
 * recipient, which is how a retried POST after a settled payment stays one
 * knock instead of two.
 */
export async function recordKnock(userId, knock) {
	// escrow_* is a cache of what the chain says (api/_lib/knock/escrow.js), so
	// the inbox can show a countdown without an RPC read per row. Null on both
	// non-escrow lanes, which is how a reader tells the three apart.
	const [row] = await sql`
		insert into knock_messages
			(recipient_user_id, sender_name, sender_url, sender_kind, payer_wallet, network,
			 tx_hash, amount_atomics, asset, subject, message, companion_event_id, request_id,
			 escrow_knock, escrow_expires_at, escrow_state)
		values (${userId}, ${knock.senderName}, ${knock.senderUrl ?? null}, ${knock.senderKind ?? 'unknown'},
		        ${knock.payerWallet ?? null}, ${knock.network ?? null}, ${knock.txHash ?? null},
		        ${String(knock.amountAtomics ?? 0)}, ${knock.asset ?? null}, ${knock.subject ?? null},
		        ${knock.message}, ${knock.companionEventId ?? null}, ${knock.requestId ?? null},
		        ${knock.escrowKnock ?? null},
		        ${knock.escrowExpiresAt ? new Date(knock.escrowExpiresAt * 1000) : null},
		        ${knock.escrowState ?? null})
		on conflict (recipient_user_id, request_id) where request_id is not null do nothing
		returning id, sender_name, sender_url, sender_kind, payer_wallet, network, tx_hash,
		          amount_atomics::text as amount_atomics, asset, subject, message, status,
		          companion_event_id, created_at, escrow_knock, escrow_expires_at, escrow_state
	`;
	return row || null;
}

/**
 * Has this exact on-chain knock already bought a message?
 *
 * One escrowed knock buys exactly one delivery. The unique index on
 * escrow_knock is what actually enforces it; this read is so a replay gets a
 * clean "already delivered" with the original row instead of a constraint
 * violation surfacing as a 500.
 */
export async function findByEscrowKnock(escrowKnock) {
	if (!escrowKnock) return null;
	const [row] = await sql`
		select id, recipient_user_id, sender_name, subject, message, status, created_at,
		       escrow_knock, escrow_expires_at, escrow_state
		  from knock_messages
		 where escrow_knock = ${escrowKnock}
		 limit 1
	`;
	return row || null;
}

/**
 * Write back what the chain now says about an escrowed knock.
 *
 * Called after re-reading the account, so a row that says `pending` in the
 * inbox cannot keep saying it after the money has already gone back.
 */
export async function updateEscrowState(escrowKnock, state) {
	if (!escrowKnock) return null;
	const [row] = await sql`
		update knock_messages
		   set escrow_state = ${state}
		 where escrow_knock = ${escrowKnock}
		 returning id, escrow_knock, escrow_state
	`;
	return row || null;
}

export async function findByRequestId(userId, requestId) {
	if (!requestId) return null;
	const [row] = await sql`
		select id, sender_name, subject, message, status, amount_atomics::text as amount_atomics, created_at
		from knock_messages
		where recipient_user_id = ${userId} and request_id = ${requestId}
	`;
	return row || null;
}

export async function listInbox(userId, { limit = 30, before = null, status = null } = {}) {
	const beforeClause = before ? sql`and created_at < ${before}` : sql``;
	const statusClause = status ? sql`and status = ${status}` : sql``;
	return sql`
		select id, sender_name, sender_url, sender_kind, payer_wallet, network, tx_hash,
		       amount_atomics::text as amount_atomics, asset, subject, message, status,
		       reply_text, read_at, replied_at, created_at,
		       escrow_knock, escrow_expires_at, escrow_state
		from knock_messages
		where recipient_user_id = ${userId}
		${statusClause}
		${beforeClause}
		order by created_at desc
		limit ${limit}
	`;
}

export async function inboxTotals(userId) {
	const [row] = await sql`
		select count(*) filter (where status = 'pending')::int as pending,
		       count(*)::int as total,
		       -- An escrowed knock is not earned until it is answered. Counting
		       -- one that is still pending would show the owner money they
		       -- cannot spend and might never be paid, and counting a refunded
		       -- one would show them money that went back to the sender.
		       coalesce(sum(amount_atomics) filter (
		           where escrow_state is null or escrow_state = 'answered'
		       ), 0)::text as earned_atomics,
		       coalesce(sum(amount_atomics) filter (
		           where escrow_state = 'pending'
		       ), 0)::text as escrowed_atomics,
		       count(*) filter (where escrow_state = 'pending')::int as escrowed_pending
		from knock_messages where recipient_user_id = ${userId}
	`;
	return row || { pending: 0, total: 0, earned_atomics: '0', escrowed_atomics: '0', escrowed_pending: 0 };
}

export async function updateKnock(userId, id, { status = null, reply = null }) {
	const nextStatus = KNOCK_STATUSES.includes(status) ? status : null;
	const [row] = await sql`
		update knock_messages set
			status     = coalesce(${nextStatus}, status),
			reply_text = ${reply === null ? sql`reply_text` : reply},
			read_at    = ${nextStatus && nextStatus !== 'pending' ? sql`coalesce(read_at, now())` : sql`read_at`},
			replied_at = ${nextStatus === 'replied' ? sql`coalesce(replied_at, now())` : sql`replied_at`}
		where id = ${id} and recipient_user_id = ${userId}
		returning id, sender_name, sender_url, subject, message, status, reply_text,
		          amount_atomics::text as amount_atomics, payer_wallet, read_at, replied_at, created_at
	`;
	return row || null;
}

export async function getKnock(userId, id) {
	const [row] = await sql`
		select id, sender_name, sender_url, payer_wallet, subject, message, status,
		       amount_atomics::text as amount_atomics, companion_event_id, created_at
		from knock_messages where id = ${id} and recipient_user_id = ${userId}
	`;
	return row || null;
}

export async function listBlocks(userId) {
	return sql`
		select id, subject, note, created_at from knock_blocks
		where user_id = ${userId} order by created_at desc limit 200
	`;
}

export async function addBlock(userId, subject, note = null) {
	const clean = String(subject || '').trim().slice(0, 120);
	if (!clean) return null;
	const [row] = await sql`
		insert into knock_blocks (user_id, subject, note)
		values (${userId}, ${clean}, ${note})
		on conflict (user_id, lower(subject)) do nothing
		returning id, subject, note, created_at
	`;
	return row || null;
}

export async function removeBlock(userId, id) {
	const [row] = await sql`
		delete from knock_blocks where user_id = ${userId} and id = ${id} returning id
	`;
	return Boolean(row);
}
