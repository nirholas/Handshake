// plan-a-session.mjs: read what an x402 endpoint really costs, then print the
// exact create_payment_session policy sized for the run you are about to make.
//
//   node examples/plan-a-session.mjs
//   node examples/plan-a-session.mjs "https://three.ws/api/x402/model-check?url=…x40"
//   node examples/plan-a-session.mjs https://a.example/one https://b.example/two
//
// Spends nothing. It sends one unpaid request per endpoint, reads the price out
// of the 402 challenge the server answers with, and stops there. No wallet, no
// credentials, no session is created.
//
// Why this exists: the first instinct when wiring an agent to paid tools is to
// authorize a round number and find out the real cost later. That gets the
// budget wrong in both directions, and the expensive direction is the one that
// silently drains. Read the price first, then size the envelope to the run.
//
// The three numbers this produces map one-to-one onto the governor's checks
// (api/_lib/pay/spend-governor.js):
//   budget_usd      total spend ceiling for the whole run
//   max_per_tx_usd  refuses a single call that costs more than you expected
//   allowed_hosts   refuses a payment to anywhere you did not name

const DEFAULT_ENDPOINTS = [
	// $0.001 per call, live, Solana USDC. Returns structural stats for a 3D asset.
	'https://three.ws/api/x402/model-check?url=https://three.ws/models/demo.glb',
];

// How many times the planned agent run will call each endpoint. Change this to
// match your workload; it is the only guess in the whole script.
const CALLS_PER_ENDPOINT = Number(process.env.CALLS_PER_ENDPOINT || 25);

// Headroom on the total, so a price change mid-run does not strand the agent.
const BUDGET_HEADROOM = 1.25;

// Ceilings the API enforces (api/_lib/pay/payment-session.js). Printing a plan
// the server would reject helps nobody, so the plan is clamped and flagged here.
const MIN_BUDGET_USD = 0.001;
const MAX_BUDGET_USD = 1000;
const MAX_ALLOWED_HOSTS = 50;

const USDC_DECIMALS = 6;
const TIMEOUT_MS = 15_000;

function atomicsToUsd(amount) {
	return Number(amount) / 10 ** USDC_DECIMALS;
}

function round(usd, places = 6) {
	return Number(usd.toFixed(places));
}

/** Send one unpaid request and read the price out of the 402 body. */
async function readPrice(url) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	let res;
	try {
		res = await fetch(url, {
			headers: { accept: 'application/json' },
			signal: controller.signal,
		});
	} catch (err) {
		return { url, error: `unreachable: ${err?.message ?? err}` };
	} finally {
		clearTimeout(timer);
	}

	if (res.status !== 402) {
		// Not a paid endpoint, or already free for this caller. Either way it
		// consumes no budget, so it does not belong in the plan.
		return { url, free: true, status: res.status };
	}

	let challenge;
	try {
		challenge = await res.json();
	} catch {
		return { url, error: 'answered 402 with an unreadable body' };
	}

	const accepts = Array.isArray(challenge.accepts) ? challenge.accepts : [];
	if (accepts.length === 0) return { url, error: '402 carried no accepts[]' };

	// The payment session settles on Solana, so price the Solana rail. Falling
	// back to the first accept would quote a rail this session cannot pay.
	const solana = accepts.find((a) => String(a?.network || '').startsWith('solana'));
	if (!solana) {
		return {
			url,
			error: `no Solana rail (offers: ${[...new Set(accepts.map((a) => a?.network))].join(', ')})`,
		};
	}

	const atomics = solana.maxAmountRequired ?? solana.amount;
	if (atomics == null) return { url, error: '402 Solana accept carried no amount' };

	return {
		url,
		host: new URL(url).hostname,
		priceUsd: atomicsToUsd(atomics),
		network: solana.network,
		payTo: solana.payTo ?? null,
		otherRails: accepts.length - 1,
	};
}

const endpoints = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_ENDPOINTS;

console.log(`Reading prices for ${endpoints.length} endpoint(s). No payment is sent.\n`);

const quotes = await Promise.all(endpoints.map(readPrice));

for (const q of quotes) {
	if (q.error) {
		console.log(`  ✗ ${q.url}\n      ${q.error}`);
	} else if (q.free) {
		console.log(`  free ${q.url}\n      answered HTTP ${q.status} with no 402, so it costs nothing`);
	} else {
		const rails = q.otherRails ? `, +${q.otherRails} other rail(s)` : '';
		console.log(`  $${q.priceUsd} ${q.url}\n      ${q.network}${rails}`);
	}
}

const priced = quotes.filter((q) => q.priceUsd != null);
if (priced.length === 0) {
	console.log('\nNothing priced, so there is no budget to plan. Nothing was spent.');
	process.exit(0);
}

const perRun = priced.reduce((sum, q) => sum + q.priceUsd * CALLS_PER_ENDPOINT, 0);
const dearest = priced.reduce((max, q) => Math.max(max, q.priceUsd), 0);
const hosts = [...new Set(priced.map((q) => q.host))];

const rawBudget = perRun * BUDGET_HEADROOM;
const budgetUsd = round(Math.min(Math.max(rawBudget, MIN_BUDGET_USD), MAX_BUDGET_USD));
// One dear call should not be able to eat the run. Double the dearest observed
// price absorbs a repricing without authorizing an unbounded single payment.
const maxPerTxUsd = round(dearest * 2);

console.log(`\n${CALLS_PER_ENDPOINT} call(s) per endpoint costs $${round(perRun)}.`);
console.log(`With ${Math.round((BUDGET_HEADROOM - 1) * 100)}% headroom, the plan is:\n`);

const plan = {
	budget_usd: budgetUsd,
	label: `Planned run, ${priced.length} endpoint(s) x ${CALLS_PER_ENDPOINT} calls`,
	expiry_seconds: 3600,
	max_per_tx_usd: maxPerTxUsd,
	allowed_hosts: hosts.slice(0, MAX_ALLOWED_HOSTS),
	network: 'solana',
};
console.log(JSON.stringify(plan, null, 2));

if (rawBudget < MIN_BUDGET_USD) {
	console.log(`\nNote: the run costs less than the $${MIN_BUDGET_USD} minimum, so the budget was raised to it.`);
}
if (rawBudget > MAX_BUDGET_USD) {
	console.log(`\nNote: the run exceeds the $${MAX_BUDGET_USD} per-session maximum. Split it across sessions.`);
}
if (hosts.length > MAX_ALLOWED_HOSTS) {
	console.log(`\nNote: ${hosts.length} hosts exceeds the ${MAX_ALLOWED_HOSTS}-entry allowlist limit; the list was truncated.`);
}

console.log('\nPass that object to create_payment_session (or POST it to /api/pay/session).');
console.log('The token comes back once. Give the agent the token and nothing else.');
console.log('\nWhat this policy refuses, before any money moves:');
for (const [reason, code] of [
	[`a payment to any host outside ${hosts.join(', ')}`, 'allowlist_blocked'],
	[`a single call priced above $${maxPerTxUsd}`, 'per_tx_exceeded'],
	[`the call that would push total spend past $${budgetUsd}`, 'insufficient_budget'],
	['any call after the session expires or is cancelled', 'session_inactive'],
]) {
	console.log(`  ${reason.padEnd(56)} ${code}`);
}
console.log();
