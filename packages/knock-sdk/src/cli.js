#!/usr/bin/env node
// knock: reach a real person from your terminal.
//
//   npx @three-ws/knock quote nirholas
//   npx @three-ws/knock directory
//   npx @three-ws/knock send nirholas "Two questions about the facilitator." \
//        --from "Ada" --subject "Your x402 settle path"
//   npx @three-ws/knock receipt "https://three.ws/api/knock/reply?id=…&token=…"
//
// A free door sends immediately. A priced door prints exactly who is being
// paid, how much, in what token, on what chain, and then STOPS for a yes. That
// confirmation is not a convenience: it is the rule this CLI is built around,
// because an unattended process should never be able to spend on your behalf
// by accident. Pass --yes only when a human already approved the amount.
//
// Paying needs an x402 client, which you supply with --payer <module>. The
// module is imported and must export `fetchWithPayment` (or a default that is
// a function). That keeps your keys in the wallet you already trust and lets
// you pay on whichever chain that client speaks.

import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { confirmationFor, directory, knock, quote, receipt, KnockError } from './index.js';

const HELP = `knock: reach a real person, and pay their price to do it.

Usage
  knock quote <handle>                     what a door costs
  knock directory [--limit 60]             every open door, cheapest first
  knock send <handle> <message> [options]  knock on a door
  knock receipt <receipt-url>              what became of a knock you sent

Options for send
  --from <name>          who is knocking (required)
  --subject <line>       one line their companion says out loud
  --url <link>           an http(s) link about you
  --request-id <id>      idempotency key; a retry never knocks twice
  --max-price <usdc>     refuse if the door costs more than this
  --payer <module>       an x402 client exporting fetchWithPayment
  --yes                  skip the payment confirmation (a human already approved)

Global
  --origin <url>         default https://three.ws
  --json                 machine-readable output
`;

const args = process.argv.slice(2);
const flags = {};
const positional = [];
for (let i = 0; i < args.length; i += 1) {
	const arg = args[i];
	if (arg.startsWith('--')) {
		const key = arg.slice(2);
		const next = args[i + 1];
		if (next === undefined || next.startsWith('--')) flags[key] = true;
		else {
			flags[key] = next;
			i += 1;
		}
	} else positional.push(arg);
}

const json = Boolean(flags.json);
const origin = typeof flags.origin === 'string' ? flags.origin : undefined;
const out = (value) => console.log(json ? JSON.stringify(value, null, 2) : value);

try {
	await main();
} catch (err) {
	if (json) console.error(JSON.stringify({ error: err.code || 'error', message: err.message }, null, 2));
	else console.error(`knock: ${err.message}`);
	process.exitCode = err instanceof KnockError && err.status === 402 ? 2 : 1;
}

async function main() {
	const command = positional[0];
	if (!command || flags.help || command === 'help') return out(HELP);

	if (command === 'quote') {
		const door = await quote(need(positional[1], 'a handle'), { origin });
		return out(json ? door : renderQuote(door));
	}

	if (command === 'directory') {
		const doors = await directory({ origin, limit: Number(flags.limit) || 60 });
		if (json) return out(doors);
		if (!doors.length) return out('No open doors yet.');
		return out(
			doors
				.map((d) => `${d.price.padStart(9)}  @${d.handle}${d.headline ? `  ${d.headline}` : ''}`)
				.join('\n'),
		);
	}

	if (command === 'receipt') {
		const state = await receipt(need(positional[1], 'a receipt URL'));
		if (json) return out(state);
		if (state.status === 'replied') return out(`Replied: ${state.reply}`);
		if (state.status === 'dismissed') return out('Read and dismissed. No reply.');
		return out(state.seen ? 'Read. No reply written yet.' : 'Not opened yet.');
	}

	if (command === 'send') {
		const handle = need(positional[1], 'a handle');
		const message = need(positional[2], 'a message');
		const from = need(typeof flags.from === 'string' ? flags.from : null, '--from <name>');

		const door = await quote(handle, { origin });
		if (!door.free && !flags.yes) await confirmSpend(door);

		const fetchWithPayment = door.free ? undefined : await loadPayer(door);
		const result = await knock({
			to: handle,
			from,
			message,
			subject: typeof flags.subject === 'string' ? flags.subject : undefined,
			url: typeof flags.url === 'string' ? flags.url : undefined,
			requestId: typeof flags['request-id'] === 'string' ? flags['request-id'] : undefined,
			maxPriceAtomics: flags['max-price'] ? usdcToAtomics(flags['max-price']) : undefined,
			senderKind: 'agent',
			fetchWithPayment,
			origin,
		});
		if (json) return out(result);
		return out(
			[
				result.duplicate ? 'Already delivered (same request id).' : `Delivered to ${result.delivered_to}.`,
				`Paid: ${result.paid}`,
				`Receipt: ${result.receipt_url}`,
			].join('\n'),
		);
	}

	throw new KnockError(`unknown command "${command}". Run knock --help.`, { code: 'bad_command' });
}

function need(value, what) {
	if (!value) throw new KnockError(`missing ${what}`, { code: 'missing_argument' });
	return value;
}

function usdcToAtomics(input) {
	const raw = String(input).replace(/^\$/, '');
	if (!/^\d+(\.\d{1,6})?$/.test(raw)) throw new KnockError('--max-price must be a USDC amount like 0.05', { code: 'bad_price' });
	const [whole, frac = ''] = raw.split('.');
	return (BigInt(whole) * 1000000n + BigInt(frac.padEnd(6, '0'))).toString();
}

function renderQuote(door) {
	return [
		`${door.display_name} (@${door.handle})`,
		door.headline ? door.headline : null,
		door.greeting ? `\n${door.greeting}\n` : null,
		`Price:    ${door.free ? 'free' : `${door.price} ${door.currency}`}`,
		door.free ? null : `Chains:   ${door.networks.join(', ')}`,
		`Limit:    ${door.max_chars} characters`,
		`Endpoint: ${door.endpoint}`,
	]
		.filter(Boolean)
		.join('\n');
}

// The spend gate. Prints the recipient, the amount, the token and the chain,
// then waits for an explicit yes on a TTY. With no TTY there is nobody to ask,
// so it refuses rather than assuming consent.
async function confirmSpend(door) {
	const c = confirmationFor(door);
	console.error(
		[
			'',
			'  You are about to pay to reach a person.',
			'',
			`    Recipient  ${c.recipient}`,
			`    Amount     ${c.amount} ${c.token}`,
			`    Chain      ${c.chains.join(' or ')}`,
			`    Endpoint   ${c.endpoint}`,
			'',
			`  ${c.note}`,
			'',
		].join('\n'),
	);
	if (!process.stdin.isTTY) {
		throw new KnockError('refusing to pay without a confirmation. Re-run with --yes if a human approved this amount.', {
			code: 'confirmation_required',
		});
	}
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	const answer = (await rl.question('  Pay and knock? [y/N] ')).trim().toLowerCase();
	rl.close();
	if (answer !== 'y' && answer !== 'yes') {
		throw new KnockError('cancelled, nothing was paid', { code: 'cancelled' });
	}
}

async function loadPayer(door) {
	const spec = flags.payer;
	if (typeof spec !== 'string') {
		throw new KnockError(
			`${door.display_name} charges ${door.price}. Pass --payer <module>, where the module exports ` +
				'`fetchWithPayment` from the x402 client and wallet you already use.',
			{ code: 'payment_required', status: 402 },
		);
	}
	const specifier = spec.startsWith('.') || spec.startsWith('/') ? pathToFileURL(spec).href : spec;
	const mod = await import(specifier);
	const payer = mod.fetchWithPayment ?? (typeof mod.default === 'function' ? mod.default : null);
	if (typeof payer !== 'function') {
		throw new KnockError(`${spec} does not export a fetchWithPayment function`, { code: 'bad_payer' });
	}
	return payer;
}
