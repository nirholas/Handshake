// `knock_send`: get one message through to a person.
//
// This tool deliberately CANNOT spend. A free door is sent immediately, because
// nothing moves. A priced door returns the exact recipient, amount, token and
// chain, plus the endpoint, and stops: paying is an act that belongs to the
// wallet the human controls, not to an MCP server holding a key in an env var.
// The agent shows those facts, the human approves, and the payment happens in
// their own x402 client (@three-ws/knock, or any other).

import { z } from 'zod';
import { apiRequest } from '../lib/api.js';

export const def = {
	name: 'knock_send',
	title: 'Knock on a door',
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
	description:
		'Send exactly one message to a person through their three.ws door. The message lands in their inbox ' +
		'AND their 3D companion walks on screen wherever they are on the site and delivers it out loud, ' +
		'naming you and what you paid. On a FREE door this sends immediately. On a PRICED door this tool ' +
		'does not pay and cannot pay: it returns `payment_required` together with the recipient, the amount, ' +
		'the token, the chain and the endpoint, so a human can approve the spend and pay from their own ' +
		'wallet (npx @three-ws/knock, or any x402 client). Pass `request_id` to make retries safe: the same ' +
		'id never knocks, or charges, twice. Refusals (shut door, daily cap, message too long) happen before ' +
		'any payment, so a rejected knock is never a paid one.',
	inputSchema: {
		to: z.string().min(1).max(40).describe('Recipient username, with or without the @.'),
		from: z.string().min(1).max(64).describe('Who is knocking. Shown to them and spoken out loud.'),
		message: z.string().min(8).max(2000).describe('The message. Shown in full, never read aloud.'),
		subject: z.string().max(120).optional().describe('One line their companion says out loud. Make it the reason you are knocking.'),
		url: z.string().max(400).optional().describe('An http(s) link about you.'),
		request_id: z.string().max(80).optional().describe('Idempotency key. A retry returns the first knock instead of knocking twice.'),
	},
	async handler({ to, from, message, subject, url, request_id: requestId }) {
		const handle = String(to).replace(/^@+/, '');
		const { door } = await apiRequest('/api/knock/door', { query: { handle } });

		if (!door.free) {
			return {
				ok: false,
				error: 'payment_required',
				message: `${door.display_name} charges ${door.price} to be reached. This server does not hold a wallet, so a human has to approve and pay.`,
				confirm: {
					recipient: `${door.display_name} (@${door.handle})`,
					amount: door.price,
					token: door.currency,
					chains: door.networks,
					endpoint: door.endpoint,
					settles_to: 'the recipient directly, not to three.ws',
				},
				how_to_pay: `npx @three-ws/knock send ${door.handle} "<message>" --from "${from}" --payer ./payer.mjs`,
			};
		}

		const body = {
			to: handle,
			from,
			message,
			sender_kind: 'agent',
			...(subject ? { subject } : {}),
			...(url ? { url } : {}),
			...(requestId ? { request_id: requestId } : {}),
		};
		const data = await apiRequest('/api/knock/send', { method: 'POST', body });
		return {
			ok: true,
			knock_id: data.knock_id,
			delivered_to: data.delivered_to,
			duplicate: data.duplicate,
			paid: data.paid,
			receipt_url: data.receipt_url,
			next: 'Poll receipt_url with knock_receipt to see whether they replied.',
		};
	},
};
