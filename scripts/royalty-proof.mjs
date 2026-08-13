#!/usr/bin/env node
/**
 * Skill-royalty proof lane (Roadmap phase 3).
 *
 * Proves, end to end and against a real Postgres, that a paid skill call
 * accrues the author's share and that the accrual reaches the author's
 * earnings surface. It runs the SHIPPING code, not a re-implementation:
 * computeSkillRoyaltySplit + accrueSkillCallRoyalty write the row, and
 * MonetizationService.getCreatorEconomics reads it back exactly as
 * /api/users/me/earnings does.
 *
 * NO FUNDS MOVE. The script never contacts a facilitator, an RPC node, or a
 * chain. It supplies the settlement fields (payer, network, transaction) that
 * a settled x402 payment would hand the onSettled hook, tagged with a
 * PROOF-LANE marker so a proof row can never be mistaken for a real
 * settlement. What is proved is the accounting path; activating real
 * settlement is the owner-gated step documented in
 * docs/skill-royalties.md.
 *
 * Usage:
 *   ROYALTY_PROOF_DATABASE_URL=postgres://user:pass@host:5432/db \
 *     node scripts/royalty-proof.mjs
 *
 * Against a local Postgres reached through a Neon HTTP proxy (the driver in
 * api/_lib/db.js speaks Neon's HTTP protocol, not raw TCP), also set:
 *   ROYALTY_PROOF_FETCH_ENDPOINT=http://localhost:54331/sql
 *
 * The script REFUSES to run without ROYALTY_PROOF_DATABASE_URL: pointing it at
 * a production DATABASE_URL by accident would write ledger rows into real
 * creator earnings. Everything it seeds is deleted on the way out, including
 * after a failure.
 */

import { neonConfig } from '@neondatabase/serverless';

const proofUrl = process.env.ROYALTY_PROOF_DATABASE_URL;
if (!proofUrl) {
	console.error(
		'ROYALTY_PROOF_DATABASE_URL is not set.\n' +
			'This lane writes and deletes ledger rows, so it requires an explicit\n' +
			'throwaway database rather than falling back to DATABASE_URL.\n' +
			'See docs/skill-royalties.md for the one-command local setup.',
	);
	process.exit(2);
}

// api/_lib/db.js builds its client from env.DATABASE_URL, lazily on first
// query. Point it at the proof database before importing anything that queries.
process.env.DATABASE_URL = proofUrl;
if (process.env.ROYALTY_PROOF_FETCH_ENDPOINT) {
	neonConfig.fetchEndpoint = process.env.ROYALTY_PROOF_FETCH_ENDPOINT;
	neonConfig.useSecureWebSocket = false;
	neonConfig.poolQueryViaFetch = true;
}

const { sql } = await import('../api/_lib/db.js');
const { computeSkillRoyaltySplit, skillRoyaltyPlatformBps, accrueSkillCallRoyalty } = await import(
	'../api/_lib/skill-royalty.js'
);
const { MonetizationService } = await import('../api/_lib/services/MonetizationService.js');
const { NETWORK_SOLANA_MAINNET } = await import('../api/_lib/x402-spec.js');

// Solana leads: the proof settles on the Solana rail, the platform's home chain.
const PROOF_NETWORK = NETWORK_SOLANA_MAINNET;
// Deliberately not a real signature. A proof row must be impossible to mistake
// for a settled payment when someone greps the ledger later.
const PROOF_TX = 'PROOF-LANE-NOT-A-REAL-SETTLEMENT';
const PROOF_PAYER = 'PROOF-LANE-PAYER-WALLET';
const PRICE_USD = 0.25;

const checks = [];
function check(name, pass, detail) {
	checks.push({ name, pass, detail });
	console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const tag = `royalty-proof-${process.pid}`;
let authorId = null;

try {
	console.log(`\nSkill-royalty proof lane\n  database: ${redact(proofUrl)}\n  chain: ${PROOF_NETWORK}\n`);

	// ── 1. Seed a real author and a real priced marketplace skill ─────────────
	const [author] = await sql`
		INSERT INTO users (email, display_name)
		VALUES (${`${tag}@proof.invalid`}, ${'Royalty Proof Author'})
		RETURNING id
	`;
	authorId = author.id;

	const [skill] = await sql`
		INSERT INTO marketplace_skills
			(author_id, name, slug, description, category, content, is_public, price_per_call_usd)
		VALUES
			(${authorId}, ${'Royalty Proof Skill'}, ${tag}, ${'Proof-lane skill for royalty accrual.'},
			 ${'general'}, ${'# Royalty Proof Skill'}, ${true}, ${PRICE_USD})
		RETURNING id, slug, price_per_call_usd
	`;
	console.log(`Seeded author ${authorId} and skill ${skill.slug} at $${Number(skill.price_per_call_usd)}/call\n`);

	// ── 2. The split the rail applies at settlement ───────────────────────────
	const platformBps = skillRoyaltyPlatformBps();
	const priceAtomics = BigInt(Math.round(PRICE_USD * 1_000_000));
	const split = computeSkillRoyaltySplit({ priceAtomics, platformBps });
	console.log(
		`Split at ${platformBps} bps: author ${split.authorAtomics} atomics ($${split.authorUsd}), ` +
			`platform ${split.platformAtomics} atomics ($${split.platformUsd})\n`,
	);

	console.log('Checks:');
	check(
		'split conserves value (author + platform === price)',
		split.authorAtomics + split.platformAtomics === priceAtomics,
		`${split.authorAtomics} + ${split.platformAtomics} = ${priceAtomics}`,
	);
	check('author receives the majority share', split.authorAtomics > split.platformAtomics);

	// ── 3. Accrue, exactly as the onSettled hook in /api/x402/skill-call does ──
	const accrual = await accrueSkillCallRoyalty({
		skillId: skill.id,
		authorId,
		payer: PROOF_PAYER,
		network: PROOF_NETWORK,
		txHash: PROOF_TX,
		priceAtomics,
	});
	check('accrueSkillCallRoyalty recorded the accrual', accrual.ok === true, accrual.reason ?? `ledger ${accrual.accrual?.ledgerId}`);

	const [row] = await sql`
		SELECT price_usd, platform_fee_usd, status, source, network, payer, tx_hash, agent_id, settled_at
		FROM royalty_ledger WHERE author_user_id = ${authorId}
	`;
	check('ledger row exists for the author', Boolean(row));
	check('row credits the author share, not the gross price', Number(row?.price_usd) === split.authorUsd, `${row?.price_usd} USD`);
	check('row records the platform cut', Number(row?.platform_fee_usd) === split.platformUsd, `${row?.platform_fee_usd} USD`);
	check("row is tagged to the x402 rail", row?.source === 'x402', String(row?.source));
	check('row lands settled (funds routed at settle time)', row?.status === 'settled' && Boolean(row?.settled_at));
	check('row carries the settlement chain and payer', row?.network === PROOF_NETWORK && row?.payer === PROOF_PAYER);
	check('row has no agent_id (the caller is a paying wallet)', row?.agent_id === null);

	// ── 4. Read it back through the author earnings surface ───────────────────
	// This is the exact call /api/users/me/earnings makes. Before the LEFT JOIN
	// fix in MonetizationService.getCreatorSalesData, this returned zero rows for
	// x402 accruals: agent_id is null, and the inner join on agent_identities
	// dropped every one of them.
	const economics = await new MonetizationService(authorId).getCreatorEconomics();
	const entry = (economics.entries || []).find((e) => e.source === 'x402');
	check('earnings surface returns the accrual', Boolean(entry), `${economics.entries?.length ?? 0} entr(ies)`);
	check('earnings surface names the skill', entry?.skill_name === 'Royalty Proof Skill', String(entry?.skill_name));
	check('earnings surface reports the author amount', Number(entry?.price_usd) === split.authorUsd, `$${entry?.price_usd}`);
	check('earnings surface carries the chain and transaction', entry?.network === PROOF_NETWORK && entry?.tx_hash === PROOF_TX);
	check('settled total includes the accrual', Number(economics.settled_usd) === split.authorUsd, `$${economics.settled_usd}`);
	check('platform fee total is reported', Number(economics.platform_fee_usd) === split.platformUsd, `$${economics.platform_fee_usd}`);

	// ── 5. A free skill must never accrue ─────────────────────────────────────
	const zero = await accrueSkillCallRoyalty({ skillId: skill.id, authorId, priceAtomics: 0n });
	check('a zero-price call accrues nothing', zero.ok === false && zero.reason === 'zero_price');
	const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM royalty_ledger WHERE author_user_id = ${authorId}`;
	check('ledger still holds exactly one row', count === 1, `${count} row(s)`);
} finally {
	if (authorId) {
		// users → marketplace_skills is ON DELETE SET NULL, so drop the skill (and
		// its cascading ledger rows) before the author.
		await sql`DELETE FROM marketplace_skills WHERE slug = ${tag}`;
		await sql`DELETE FROM royalty_ledger WHERE author_user_id = ${authorId}`;
		await sql`DELETE FROM users WHERE id = ${authorId}`;
		console.log('\nProof rows deleted.');
	}
}

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed. No funds moved.\n`);
process.exit(failed.length === 0 ? 0 : 1);

function redact(url) {
	return String(url).replace(/\/\/[^@]*@/, '//***@');
}
