// @three-ws/knock: reach a real person, and pay their price to do it.
//
// Every three.ws account can publish a priced door at three.ws/knock/<handle>.
// Paying its price buys exactly one message through to that person: it lands in
// their inbox and their 3D companion walks on screen and says who you are and
// what you paid. The USDC settles directly to them.
//
// This module is transport-honest and wallet-agnostic:
//
//   quote(handle)   what a door costs, and which lane it uses. No payment.
//   knock(opts)     send one. Free doors need nothing but fetch. Priced doors
//                   need an x402-capable fetch you supply, so this package
//                   never touches your keys and never picks your chain for you.
//   receipt(url)    read what became of a knock you sent. No account needed.
//
// Bring any x402 client: pass its paying fetch as `fetchWithPayment` and a
// priced door settles without this package ever seeing a key. A runnable
// example lives in the README.

export const DEFAULT_ORIGIN = 'https://three.ws';

export class KnockError extends Error {
	constructor(message, { code = 'knock_error', status = 0, data = null } = {}) {
		super(message);
		this.name = 'KnockError';
		this.code = code;
		this.status = status;
		this.data = data;
	}
}

function normalizeHandle(raw) {
	const handle = String(raw ?? '').trim().replace(/^@+/, '').toLowerCase();
	if (!/^[a-z0-9._-]{1,40}$/.test(handle)) {
		throw new KnockError(`"${raw}" is not a usable handle`, { code: 'bad_handle' });
	}
	return handle;
}

async function asJson(res) {
	const text = await res.text();
	let data = null;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			data = null;
		}
	}
	if (!res.ok) {
		throw new KnockError(data?.error_description || data?.message || `request failed (${res.status})`, {
			code: data?.error || 'http_error',
			status: res.status,
			data,
		});
	}
	return data;
}

/**
 * What a door costs and how to pay it. Pure read, no payment, no account.
 *
 * @param {string} handle
 * @param {{origin?: string, fetch?: typeof fetch}} [opts]
 * @returns {Promise<{handle:string, display_name:string, free:boolean, price:string,
 *   price_atomics:string, currency:string, networks:string[], max_chars:number,
 *   headline:string|null, greeting:string|null, endpoint:string, protocol:'http'|'x402'}>}
 */
export async function quote(handle, { origin = DEFAULT_ORIGIN, fetch: f = fetch } = {}) {
	const clean = normalizeHandle(handle);
	const res = await f(`${origin}/api/knock/door?handle=${encodeURIComponent(clean)}`, {
		headers: { accept: 'application/json' },
	});
	const data = await asJson(res);
	return data.door;
}

/**
 * Every door that is open and listed, cheapest first.
 * @returns {Promise<Array<{handle:string, display_name:string, price:string, price_atomics:string, headline:string|null, replies:number}>>}
 */
export async function directory({ origin = DEFAULT_ORIGIN, limit = 60, fetch: f = fetch } = {}) {
	const res = await f(`${origin}/api/knock/directory?limit=${limit}`, {
		headers: { accept: 'application/json' },
	});
	return (await asJson(res)).doors;
}

/**
 * Knock on someone's door.
 *
 * A free door needs nothing. A priced door needs `fetchWithPayment`: any
 * fetch-compatible function that answers a 402 by paying and retrying, which
 * is exactly what every x402 client exports. This package deliberately does
 * not sign anything itself, so your keys, your chain and your spending limits
 * stay in the client you already trust.
 *
 * `maxPriceAtomics` is a hard ceiling checked against the door's live price
 * BEFORE any payment is attempted. Set it whenever an agent knocks unattended:
 * a door owner can raise their price between your quote and your call.
 *
 * @param {object} opts
 * @param {string} opts.to             recipient handle
 * @param {string} opts.from           who is knocking, shown and spoken
 * @param {string} opts.message        the message body, never read aloud
 * @param {string} [opts.subject]      one line the companion says out loud
 * @param {string} [opts.url]          an http(s) link about you
 * @param {'agent'|'human'|'unknown'} [opts.senderKind='agent']
 * @param {string} [opts.requestId]    idempotency key; a retry returns the first knock
 * @param {string|number|bigint} [opts.maxPriceAtomics] refuse above this price
 * @param {(url:string, init:object) => Promise<Response>} [opts.fetchWithPayment]
 * @param {string} [opts.origin]
 * @returns {Promise<{ok:true, knock_id:string, delivered_to:string, paid:string,
 *   receipt_url:string, duplicate:boolean, announced?:boolean, importance?:number}>}
 */
export async function knock({
	to,
	from,
	message,
	subject,
	url,
	senderKind = 'agent',
	requestId,
	maxPriceAtomics,
	fetchWithPayment,
	origin = DEFAULT_ORIGIN,
	fetch: f = fetch,
} = {}) {
	const handle = normalizeHandle(to);
	if (!from?.trim()) throw new KnockError('`from` is required: tell them who is knocking', { code: 'missing_sender' });
	if (!message?.trim()) throw new KnockError('`message` is required', { code: 'missing_message' });

	const door = await quote(handle, { origin, fetch: f });
	if (message.length > door.max_chars) {
		throw new KnockError(`this door accepts up to ${door.max_chars} characters`, { code: 'message_too_long' });
	}
	if (maxPriceAtomics !== undefined && BigInt(door.price_atomics) > BigInt(maxPriceAtomics)) {
		throw new KnockError(
			`${door.display_name} charges ${door.price}, above the ${formatUsdc(maxPriceAtomics)} ceiling you set`,
			{ code: 'over_budget', data: { price_atomics: door.price_atomics } },
		);
	}

	const body = {
		from: from.trim(),
		message: message.trim(),
		sender_kind: senderKind,
		...(subject ? { subject: String(subject).trim() } : {}),
		...(url ? { url: String(url).trim() } : {}),
		...(requestId ? { request_id: String(requestId) } : {}),
	};

	if (door.free) {
		const res = await f(`${origin}/api/knock/send`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'application/json' },
			body: JSON.stringify({ to: handle, ...body }),
		});
		return asJson(res);
	}

	if (typeof fetchWithPayment !== 'function') {
		throw new KnockError(
			`${door.display_name} charges ${door.price} to be reached. Pass \`fetchWithPayment\`: any x402 client's ` +
				'paying fetch (for example wrapFetchWithPayment(fetch, wallet) from x402-fetch). ' +
				`The endpoint is ${door.endpoint}.`,
			{ code: 'payment_required', data: { door } },
		);
	}

	const res = await fetchWithPayment(door.endpoint, {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'application/json' },
		body: JSON.stringify(body),
	});
	return asJson(res);
}

/**
 * What became of a knock you sent. Takes the `receipt_url` the knock returned.
 * Needs no account: the URL carries its own proof.
 *
 * @returns {Promise<{id:string, status:'pending'|'read'|'replied'|'dismissed',
 *   reply:string|null, seen:boolean, amount:string, created_at:string}>}
 */
export async function receipt(receiptUrl, { fetch: f = fetch } = {}) {
	const res = await f(String(receiptUrl), { headers: { accept: 'application/json' } });
	return (await asJson(res)).knock;
}

/** Render USDC atomic units as a price string, the same way the API does. */
export function formatUsdc(atomics) {
	const value = BigInt(atomics ?? 0);
	const whole = value / 1000000n;
	const frac = (value % 1000000n).toString().padStart(6, '0').replace(/0+$/, '');
	const cents = frac.length <= 2 ? frac.padEnd(2, '0') : frac;
	return `$${whole.toString()}.${cents}`;
}

/**
 * The confirmation an unattended agent should show a human before it spends.
 * Returns the recipient, the amount, the token and the chain as plain strings,
 * so a CLI, a chat agent, or a UI can all print the same thing. Nothing here
 * pays: it exists so the decision to pay is always a deliberate one.
 */
export function confirmationFor(door) {
	return {
		recipient: `${door.display_name} (@${door.handle})`,
		amount: door.price,
		token: door.currency || 'USDC',
		chains: door.networks?.length ? door.networks : ['solana'],
		endpoint: door.endpoint,
		note: door.free ? 'This door is free. Nothing will be spent.' : 'The payment settles directly to the recipient.',
	};
}
