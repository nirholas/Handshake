#!/usr/bin/env node
// LLM metering audit: does any lane that spends money report exactly $0?
//
// A cost lane that reports zero is worse than one that reports nothing. That is
// not a hypothetical: `openrouter` sat on the blanket free-provider list while
// the platform key routed paid vendor mirrors, so a real $30 balance drained
// while the spend dashboard showed "served free" the entire way down. Nobody
// noticed until the key stopped working.
//
// This reads usage_events over a window and holds every lane to one rule:
//
//   • A genuinely free lane (groq, nvidia, cerebras, gemini, ovh, pollinations,
//     and OpenRouter's `:free` routes) may report $0. That is the truth.
//   • Any other lane with traffic must report a cost above $0. Exactly $0 is a
//     FAILURE, because a spending lane cannot serve tokens for nothing.
//   • A NULL cost is "we could not price this" (llm-pricing returns null rather
//     than fabricating a zero). That is also a FAILURE here: it means a model
//     reached production without a price, and the fix is one table entry.
//   • An LLM event with no provider recorded at all is a FAILURE: an
//     unattributed lane cannot be audited, which is how /brain spend hid.
//
// Read-only. Exits 1 on any failure, 0 when every lane is honest.
//
// Usage:
//   npm run audit:llm-metering              # last 24h
//   npm run audit:llm-metering -- --hours 168
//   npm run audit:llm-metering -- --json

import { readFileSync } from 'node:fs';

for (const file of ['.env', '.env.local']) {
	try {
		for (const line of readFileSync(file, 'utf8').split('\n')) {
			const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
			if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
		}
	} catch {
		// Absent env file is fine: the vars may already be in the environment.
	}
}

if (!process.env.DATABASE_URL) {
	console.error('audit:llm-metering needs DATABASE_URL (it reads usage_events). Set it in .env.');
	process.exit(2);
}

const { sql } = await import('../api/_lib/db.js');
// The rule itself lives in api/_lib/llm-metering-rule.js so it can be unit
// tested without a database (tests/llm-metering-rule.test.js). This script is
// the reader: it aggregates the ledger and applies that rule.
const { classifyMeteringLane } = await import('../api/_lib/llm-metering-rule.js');

const args = process.argv.slice(2);
const hours = args.includes('--hours') ? Number(args[args.indexOf('--hours') + 1]) : 24;
const asJson = args.includes('--json');
if (!Number.isFinite(hours) || hours <= 0) {
	console.error('--hours must be a positive number');
	process.exit(2);
}

// Every kind that carries LLM token spend. `chat` and `vision` write the same
// provider/model/cost columns as `llm`, so all three are audited together.
const KINDS = ['llm', 'chat', 'vision'];

const rows = await sql`
	SELECT
		kind,
		provider,
		model,
		count(*)::int                                              AS calls,
		coalesce(sum(input_tokens), 0)::bigint                     AS input_tokens,
		coalesce(sum(output_tokens), 0)::bigint                    AS output_tokens,
		coalesce(sum(cost_micro_usd), 0)::bigint                   AS cost_micro_usd,
		count(*) FILTER (WHERE cost_micro_usd IS NULL)::int         AS unpriced_calls
	FROM usage_events
	WHERE kind = ANY(${KINDS})
		AND created_at > NOW() - (${hours} || ' hours')::interval
	GROUP BY kind, provider, model
	ORDER BY cost_micro_usd DESC, calls DESC
`;

const failures = [];
const lanes = rows.map((r) => {
	const calls = Number(r.calls);
	const tokens = Number(r.input_tokens) + Number(r.output_tokens);
	const cost = Number(r.cost_micro_usd);
	const unpriced = Number(r.unpriced_calls);
	const verdict = classifyMeteringLane({
		provider: r.provider,
		model: r.model,
		tokens,
		costMicroUsd: cost,
		unpricedCalls: unpriced,
	});
	const lane = {
		kind: r.kind,
		provider: r.provider,
		model: r.model,
		calls,
		tokens,
		costMicroUsd: cost,
		unpricedCalls: unpriced,
		...verdict,
	};
	if (lane.status === 'fail') failures.push(lane);
	return lane;
});

const usd = (micro) => `$${(micro / 1_000_000).toFixed(4)}`;

if (asJson) {
	console.log(JSON.stringify({ hours, lanes, failures: failures.length }, null, 2));
} else {
	console.log(`LLM metering audit: last ${hours}h, ${lanes.length} lane(s) with traffic\n`);
	if (!lanes.length) {
		console.log('No LLM usage events in the window. Nothing to audit.');
	}
	for (const l of lanes) {
		const mark = l.status === 'fail' ? 'FAIL' : l.status === 'skip' ? 'skip' : l.free ? 'free' : ' ok ';
		console.log(
			`[${mark}] ${l.kind}  ${l.provider || '(none)'}/${l.model || '(none)'}  ` +
				`calls=${l.calls} tokens=${l.tokens} cost=${usd(l.costMicroUsd)}` +
				(l.unpricedCalls ? ` unpriced=${l.unpricedCalls}` : ''),
		);
		if (l.reason) console.log(`         ${l.reason}`);
	}
	const spend = lanes.reduce((a, l) => a + l.costMicroUsd, 0);
	console.log(`\nTotal recorded spend: ${usd(spend)} over ${lanes.reduce((a, l) => a + l.calls, 0)} call(s)`);
	console.log(failures.length ? `\n${failures.length} lane(s) failed the metering rule.` : '\nEvery lane reports an honest cost.');
}

process.exit(failures.length ? 1 : 0);
