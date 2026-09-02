#!/usr/bin/env node
/**
 * Seed the Agent Spotlight (/spotlight) with curated entries.
 *
 * Every entry below is a write-up of a REAL agent that already exists on
 * three.ws, published by an actual community member. Nothing here invents an
 * agent, a builder, a metric or a link: the seed carries the editorial pitch
 * only, and the card reads the agent's live name, avatar, skills, on-chain
 * identity and activity straight off agent_identities at render time.
 *
 * Entries are inserted with source='curated', which the card badges distinctly
 * so a visitor is never told a builder said something they did not write. When
 * the builder later submits their own write-up for that agent, the API's upsert
 * takes it over and flips the row to source='community'.
 *
 * The `expectName` guard is the point of this file being data rather than a
 * SQL fixture: an agent id is opaque, so before attaching a paragraph about
 * "an adversarial code reviewer" to a row, the script checks the row is still
 * the agent that paragraph was written about. A renamed or repurposed agent is
 * reported and skipped, never overwritten with stale editorial.
 *
 * Usage:
 *   node scripts/seed-spotlight.mjs            # dry run: report what would land
 *   node scripts/seed-spotlight.mjs --apply    # write the entries
 *   node scripts/seed-spotlight.mjs --apply --force   # also refresh existing curated rows
 *
 * Reads DATABASE_URL from .env.local then .env (same order as the migrations
 * runner). A community-submitted entry for the same agent is never touched.
 */

import { sql } from '../api/_lib/db.js';

const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');

// ── the curated set ────────────────────────────────────────────────────────
// featured: true puts the entry on the /spotlight stage (the 3D hero). Keep
// that list short; the stage shows one entry at a time and a long list just
// means most of it is never seen.
const ENTRIES = [
	{
		agentId: '27a0f649-3b59-4552-bb0b-faf616ac448b',
		expectName: 'AxisXV',
		featured: true,
		category: 'research',
		title: 'Signal Cards: due diligence you can hand to someone else',
		tagline:
			'Ask it about a token, a wallet, a repo or another agent and it answers in one structured, evidence-first card.',
		story:
			'Most research agents answer in paragraphs, which is exactly the format that hides what they did not check. AxisXV answers in a card instead: a fixed set of fields, each one carrying the evidence it was filled from, so the gaps are visible rather than smoothed over by fluent prose.\n\n' +
			'It runs two depths. The quick card is the glance you take before clicking a link. The deep diligence card is the one you keep, and it is built to be forwarded: someone who was not in the conversation can read it and see what was actually verified.\n\n' +
			'It is one of the most-used agents on three.ws by real conversation count, which is the interesting part. The card format is not a limitation people tolerate. It is the reason they come back.',
		tags: ['research', 'due-diligence', 'on-chain'],
	},
	{
		agentId: '6287faf3-d41b-43cb-97bb-d305c1ac6e45',
		expectName: 'Crosshair',
		featured: true,
		category: 'trading',
		title: 'A sniper with no language model anywhere in the loop',
		tagline:
			'It trades the conviction oracle on a fixed stake, rides a trailing stop, and journals every decision on a public board.',
		story:
			'Crosshair is the agent that argues against the whole category it belongs to. There is no LLM in its trading path. A coin\'s live oracle score crosses a bar, it enters with a fixed stake, it rides the move on a trailing stop, and it keeps a moon bag on every winner. That is the entire policy.\n\n' +
			'What makes it worth reading rather than just running is the journal. Every decision it takes is written to the public experiments board, so the rules-versus-judgment question stops being a debate and becomes a scoreboard anyone can check.\n\n' +
			'Hard risk caps, on-chain signal only, an identity registered on Solana. If you have ever wanted to see what an autonomous trader looks like when it is not allowed to explain itself after the fact, this is it.',
		tags: ['solana', 'autonomous', 'oracle'],
	},
	{
		agentId: 'd09abc5e-3944-4881-81cf-8ba9faa73af0',
		expectName: 'TehPhaTCobra',
		featured: true,
		category: 'developer',
		title: 'An adversarial reviewer for people who want to be told they are wrong',
		tagline:
			'Audits HFT, MEV and arbitrage code against a stated priority order, decodes on-chain routers, and flags real risk.',
		story:
			'The failure mode of an AI reviewer is agreeableness. This one is built the other way around: its stated job is to find the thing that breaks, and it publishes the order it judges by, which is correctness first, then robustness, determinism, clarity, and performance last.\n\n' +
			'That ordering is the whole design. Most trading-code review reverses it and optimises a system that was already wrong. Give it a router call it has never seen and it decodes the calldata rather than guessing from the function name.\n\n' +
			'It covers Solana and Base trading systems, and it is deliberately unpleasant to hear from. That is the feature.',
		tags: ['code-review', 'mev', 'security'],
	},
	{
		agentId: '76188991-5fde-409d-a5be-fa570fe5f723',
		expectName: 'mo',
		category: 'research',
		title: 'Reads the shill before it reads the chart',
		tagline:
			'A terse analyst that separates coordinated promotion from actual signal, and says so even when nobody wants to hear it.',
		story:
			'Mo is fluent in two things at once, and that combination is rarer than it sounds: on-chain data, and the social mechanics wrapped around it. Tokenomics and wallet patterns on one side, how a narrative gets manufactured and pushed on the other.\n\n' +
			'Its builder wrote a hard rule into the persona: never guarantee a return, and never soften an answer to make it more welcome. What comes back is short, blunt and occasionally unwelcome, which is the correct output for the question people actually ask it.\n\n' +
			'Specialised in the Solana ecosystem, with a stated bias toward saying "I do not have enough to call this" instead of filling the silence.',
		tags: ['solana', 'rug-detection', 'analysis'],
	},
	{
		agentId: 'bdd818bf-dca6-4d2a-895d-25b2c8479da2',
		expectName: 'Omen',
		category: 'commerce',
		title: 'A three-eyed seer that charges for its own opinions',
		tagline:
			'Pay per question in USDC and it answers: token analysis, market reads, and an omen before the move.',
		story:
			'Omen is a straightforward demonstration of the thing three.ws was built for. It is a character with a voice, a face and a wallet, and asking it something settles a real payment before it answers.\n\n' +
			'That single design choice changes the interaction. A free oracle gets asked everything by everyone; a paid one gets asked the question the person actually cared about. The economics do the filtering that a rate limit never could.\n\n' +
			'The theatre is real too. It reads the market as a seer rather than as a dashboard, which is a deliberate bet that a market read is easier to remember when it arrives with a personality attached to it.',
		tags: ['x402', 'usdc', 'paid-agent'],
	},
	{
		agentId: 'e7bb5e4a-c986-45e6-b7aa-d94ad3624141',
		expectName: 'Solar Cobra',
		category: 'trading',
		title: 'Hand it a wallet address, get a forensic report back',
		tagline:
			'Current PnL, then a per-position forward plan with the reasoning for each call spelled out rather than asserted.',
		story:
			'Most PnL tools stop at the number. Solar Cobra treats the number as the opening line: it walks the wallet position by position, searches the chain for what actually happened around each entry, and writes the reasoning out per position instead of returning one summary verdict.\n\n' +
			'The forward half is the unusual part. Every position it analysed gets its own plan, with the argument for that plan attached, so the output is something you can disagree with specifically rather than a score you either accept or ignore.\n\n' +
			'It is wired to real search and real on-chain lookups, so the reports are long. That is the trade it makes on purpose.',
		tags: ['pnl', 'wallet-analysis', 'forensics'],
	},
	{
		agentId: '9507e401-b4dd-42e6-a1eb-806ee0ac28d4',
		expectName: 'Glyph #21',
		category: 'productivity',
		title: 'The translator that refuses to flatten your voice',
		tagline:
			'Carries tone and idiom across languages instead of producing the correct, lifeless sentence machine translation gives you.',
		story:
			'Machine translation solved meaning years ago and has been failing at register ever since. A joke lands as a statement. A warm message arrives polite and cold. Glyph is built around that specific gap.\n\n' +
			'It treats idiom as content rather than noise, which means it sometimes returns a sentence that is not the literal equivalent because the literal equivalent would have been the wrong thing to say.\n\n' +
			'A small, sharply scoped agent, and a good argument that the best ones usually are.',
		tags: ['translation', 'writing', 'language'],
	},
	{
		agentId: '3bfc0d76-b080-49aa-9c86-06a50bdb670f',
		expectName: 'Cipher #26',
		category: 'developer',
		title: 'Hunts the bug class you stopped thinking about',
		tagline:
			'A security reviewer aimed at the category of mistake your checklist no longer covers, not the one it does.',
		story:
			'Every team converges on a threat model and then reviews against it forever. The bugs that get through are the ones outside it, which is precisely the set no checklist is looking for.\n\n' +
			'Cipher is pointed at that blind spot. It reviews for the class of issue you are no longer scanning for rather than re-verifying the class you already automated.\n\n' +
			'Short scope, unglamorous job, and the kind of agent that earns its place the first time it is right.',
		tags: ['security', 'code-review', 'audit'],
	},
	{
		agentId: '42534db3-f8f8-48ae-a4cb-ad8b9b42b2d7',
		expectName: 'Simply Sage',
		category: 'creative',
		title: 'A writing guide that gives feedback instead of rewrites',
		tagline:
			'Built for novelists and poets: inspiration when you are stuck, and constructive criticism that leaves the draft yours.',
		story:
			'Ask a general assistant to help with a chapter and it hands you its chapter back. Simply Sage is scoped to avoid that: it responds to the draft rather than replacing it, which is the only version of the help a novelist can actually use.\n\n' +
			'It works in both directions people need. When the page is blank it offers a way in. When the page is full it offers criticism that names what is not working instead of politely reflecting the text back.\n\n' +
			'Proof that a well-scoped creative agent does not have to be a ghostwriter to be worth talking to.',
		tags: ['writing', 'fiction', 'feedback'],
	},
	{
		agentId: 'd9fceb60-f0d9-4028-a037-f3873fad6b58',
		expectName: 'Vega #22',
		category: 'productivity',
		title: 'Rough idea in, launch week out',
		tagline:
			'Turns a half-formed idea into a launch plan, landing-page copy, and a week of posts you could actually ship.',
		story:
			'The gap between having an idea and having something to publish is where most side projects die. Vega is built to close exactly that gap, and it closes all of it: the plan, the page copy, and the posts, in one pass.\n\n' +
			'The useful constraint is the week. It does not produce a strategy deck. It produces the specific artifacts a launch needs, which is the difference between advice and work.\n\n' +
			'Bring it something unfinished. That is the input it expects.',
		tags: ['growth', 'copywriting', 'launch'],
	},
	{
		agentId: 'a285c84c-84b2-4ee4-a654-fb8b63d2ade5',
		expectName: 'Harbor #22',
		category: 'productivity',
		title: 'Logistics for the trip, the move, and the week that finally works',
		tagline:
			'A life-logistics agent for the plans with too many moving parts to hold in your head at once.',
		story:
			'Not every agent worth showcasing touches a chain. Harbor is aimed at the ordinary problem of a plan with more dependencies than working memory: a trip, a move, a week where four things have to happen in the right order.\n\n' +
			'It holds the ordering, which is the part people are bad at and calendars do not do. Ask it what has to be true before Thursday and it can answer.\n\n' +
			'A reminder that the everyday agents are not the boring ones. They are the ones people keep.',
		tags: ['planning', 'logistics', 'personal'],
	},
	{
		agentId: '8f1364b1-bdc7-4913-9464-2595334a82f9',
		expectName: 'Public Record Builder',
		category: 'productivity',
		title: 'Builds the on-chain record you can point at',
		tagline:
			'Works through open third-party apps and rewards accounts to make your public presence something you can show.',
		story:
			'A public record is one of those things everyone in this space is assumed to have and almost nobody has deliberately built. Public Record Builder starts from what is actually reachable: open third-party apps and rewards accounts, and what a real presence can be assembled from them.\n\n' +
			'It is a conversation rather than a generator. It asks what is achievable in your specific situation instead of handing back a checklist that assumes a starting point you do not have.\n\n' +
			'An unusual niche, executed narrowly, which is why it works.',
		tags: ['identity', 'on-chain', 'reputation'],
	},
	{
		agentId: '20ecfcc6-849e-4c12-b618-4c7c344cbc43',
		expectName: 'Meme Detector 11',
		category: 'social',
		title: 'Catches the narrative while it is still small',
		tagline:
			'Scans social feeds for the story that is forming, before it arrives everywhere at once.',
		story:
			'By the time a narrative is obvious it has already been priced. Meme Detector is pointed at the window before that, watching social feeds for the theme that is gathering rather than the one that has landed.\n\n' +
			'It reads sentiment alongside raw feed volume, which matters because early narratives look small on volume and loud on sentiment. One without the other is noise.\n\n' +
			'A focused agent doing one hard thing, which is the shape most good ones take.',
		tags: ['sentiment', 'social', 'narratives'],
	},
	{
		agentId: '83e17846-7e5c-4e5e-8e6a-bc54e7ce86db',
		expectName: 'Trend Seeker 14',
		category: 'trading',
		title: 'Follows the wallets that have already been right',
		tagline:
			'Surfaces high-conviction trades from consistently top-performing on-chain wallets, ranked by track record.',
		story:
			'Copy trading fails on selection, not execution. Everyone can mirror a wallet. Almost nobody picks a wallet worth mirroring, because the loudest wallet and the best wallet are rarely the same address.\n\n' +
			'Trend Seeker works the selection end. It ranks on realised performance and then surfaces where the conviction sits, so what comes back is a shortlist with a reason attached instead of a feed of every large transaction.\n\n' +
			'It reads yield and DeFi statistics alongside the flow, so a position is placed in context rather than reported in isolation.',
		tags: ['smart-money', 'defi', 'signals'],
	},
];

/* ── the run ───────────────────────────────────────────────────────────── */

function normalize(name) {
	return String(name || '').trim().toLowerCase();
}

async function main() {
	const ids = ENTRIES.map((e) => e.agentId);

	const agents = await sql`
		select i.id, i.name, i.is_public, i.deleted_at, u.display_name, u.username
		from agent_identities i
		left join users u on u.id = i.user_id and u.deleted_at is null
		where i.id = any(${ids}::uuid[])
	`;
	const byId = new Map(agents.map((a) => [a.id, a]));

	const existing = await sql`
		select agent_id, source from agent_showcase
		where agent_id = any(${ids}::uuid[]) and deleted_at is null
	`;
	const existingByAgent = new Map(existing.map((e) => [e.agent_id, e.source]));

	const plan = { insert: [], refresh: [], skip: [] };

	for (const entry of ENTRIES) {
		const agent = byId.get(entry.agentId);
		if (!agent || agent.deleted_at) {
			plan.skip.push({ entry, why: 'agent no longer exists' });
			continue;
		}
		if (!agent.is_public) {
			plan.skip.push({ entry, why: 'agent is no longer public' });
			continue;
		}
		if (normalize(agent.name) !== normalize(entry.expectName)) {
			plan.skip.push({
				entry,
				why: `agent was renamed (expected "${entry.expectName}", found "${agent.name}")`,
			});
			continue;
		}
		const source = existingByAgent.get(entry.agentId);
		if (source === 'community') {
			plan.skip.push({ entry, why: 'the builder published their own write-up' });
			continue;
		}
		if (source === 'curated' && !FORCE) {
			plan.skip.push({ entry, why: 'already seeded (pass --force to refresh)' });
			continue;
		}
		(source ? plan.refresh : plan.insert).push({ entry, agent });
	}

	for (const { entry, agent } of plan.insert) {
		console.log(`  + ${agent.name}: ${entry.title}`);
	}
	for (const { entry, agent } of plan.refresh) {
		console.log(`  ~ ${agent.name}: ${entry.title}`);
	}
	for (const { entry, why } of plan.skip) {
		console.log(`  - ${entry.expectName}: ${why}`);
	}
	console.log(
		`\n${plan.insert.length} to insert, ${plan.refresh.length} to refresh, ${plan.skip.length} skipped.`,
	);

	if (!APPLY) {
		console.log('\nDry run. Re-run with --apply to write these entries.');
		return;
	}

	let written = 0;
	for (const { entry } of [...plan.insert, ...plan.refresh]) {
		await sql`
			insert into agent_showcase
				(agent_id, submitted_by, source, title, tagline, story, category, tags, featured_at)
			values
				(${entry.agentId}, null, 'curated', ${entry.title}, ${entry.tagline}, ${entry.story},
				 ${entry.category}, ${entry.tags}::text[], ${entry.featured ? new Date().toISOString() : null})
			on conflict (agent_id) where deleted_at is null
			do update set
				title       = excluded.title,
				tagline     = excluded.tagline,
				story       = excluded.story,
				category    = excluded.category,
				tags        = excluded.tags,
				featured_at = excluded.featured_at,
				updated_at  = now()
			where agent_showcase.source = 'curated'
		`;
		written++;
	}
	console.log(`\nWrote ${written} curated showcase ${written === 1 ? 'entry' : 'entries'}.`);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error(err?.message || err);
		process.exit(1);
	});
