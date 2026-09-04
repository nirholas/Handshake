#!/usr/bin/env node
// announce-rank.mjs - rank every shipped surface that has never been announced.
//
// docs/announcement-coverage.md established the backlog by hand: 400+ shipped
// surfaces, fewer than 50 ever posted about. That audit is prose, so it cannot
// be queried, scored, or advanced. Nothing in it records which feature already
// has media, which has a draft, or which one was cleared to post. Announcing
// autonomously needs state, so this script rebuilds the backlog as data.
//
// It re-derives the inventory from its real sources on every run (data/pages.json,
// packages/*, workers/*, services/*), reads the announced/passing/never status
// out of the coverage audit's tables, scores what is left, and writes the ledger
// to data/announcements.json. A surface that shipped after the audit was written
// is absent from those tables and is therefore treated as never announced, which
// is the correct default and the reason this is re-derived rather than stored.
//
// ── The score ────────────────────────────────────────────────────────────────
// Weights come from data/x-archive/analysis/trythreews-engagement.json, which
// measured 158 of our own posts. They are not taste. Median engagement lift by
// signal, from that report:
//
//   token / $THREE topic      13.3x     mentions a partner account   4.5x
//   has an image               2.3x     text only                    0.875x
//   100-179 chars              3.0x     280-499 chars                4.75x
//   1-99 chars                 0.83x    has a video                  0.71x
//
// So the score rewards a surface that (a) can carry a real screenshot or motion
// loop, (b) touches $THREE or the agent economy, (c) legitimately names a
// partner we can tag, and (d) is genuinely new rather than a variation on
// something already posted. Depth signals (a doc, a README, backing API
// handlers) act as a proxy for "there is enough here to write 280 characters
// about and link proof for".
//
// Liveness is a hard gate, not a weight: announcing a dead surface is worse
// than not announcing it. --probe fetches every candidate and records the
// result; without it the last probe recorded in the ledger is reused.
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   node scripts/announce-rank.mjs                 # rank from the cached probe
//   node scripts/announce-rank.mjs --probe         # re-check every surface live
//   node scripts/announce-rank.mjs --top 25        # show the top N
//   node scripts/announce-rank.mjs --json          # machine-readable
//   node scripts/announce-rank.mjs --write         # update data/announcements.json
//
// Wired as `npm run announce:rank`. It never posts anything.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER = join(root, 'data/announcements.json');
const COVERAGE = join(root, 'docs/announcement-coverage.md');
const SITE = 'https://three.ws';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const arg = (n, d) => {
	const i = argv.indexOf(n);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const doProbe = flag('--probe');
const asJson = flag('--json');
const doWrite = flag('--write');
const topN = Number(arg('--top', 30));

// Descriptions are copied verbatim out of package.json and pages.json, and a
// lot of them carry an em-dash. They are the raw material an announcement gets
// drafted from, so the glyph is normalized here rather than caught later in
// every draft: the house style bans it everywhere, this file included.
const DASHES = new RegExp('\\s*[\\u2014\\u2013]\\s*', 'g');
const clean = (text) => String(text || '').replace(DASHES, ', ').trim();

// --- inventory --------------------------------------------------------------

// Sections of data/pages.json that hold product surfaces. 'learn' and 'blog'
// are content (348 docs pages and 39 posts); announcing each one individually
// would drown the real features. 'legal' is boilerplate.
const PRODUCT_SECTIONS = new Set(['main', 'build', 'labs', 'crypto', 'agent-tools', 'account', 'machine']);

function pageInventory() {
	const { sections } = JSON.parse(readFileSync(join(root, 'data/pages.json'), 'utf8'));
	const out = [];
	for (const section of sections) {
		if (!PRODUCT_SECTIONS.has(section.id)) continue;
		for (const page of section.pages) {
			if (page.indexable === false) continue;
			out.push({
				key: page.path,
				kind: 'page',
				section: section.id,
					title: clean(page.title),
				description: clean(page.description),
				added: page.added || null,
				sitemapPriority: typeof page.priority === 'number' ? page.priority : 0.5,
				showcase: Boolean(page.showcase),
				url: page.path,
			});
		}
	}
	return out;
}

function dirInventory(base, kind, keyPrefix) {
	const dir = join(root, base);
	if (!existsSync(dir)) return [];
	const out = [];
	for (const name of readdirSync(dir, { withFileTypes: true })) {
		if (!name.isDirectory()) continue;
		const pkgPath = join(dir, name.name, 'package.json');
		let title = `${keyPrefix}${name.name}`;
		let description = '';
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
				if (pkg.private === true && kind === 'package') continue;
				title = pkg.name || title;
				description = clean(pkg.description);
			} catch { /* an unparseable package.json still leaves a real directory */ }
		}
		if (!description && existsSync(join(dir, name.name, 'README.md'))) {
			const readme = readFileSync(join(dir, name.name, 'README.md'), 'utf8');
			const line = readme.split('\n').find((l) => l.trim() && !l.startsWith('#'));
			description = clean(line).slice(0, 240);
		}
		out.push({
			key: kind === 'package' ? title : `${base}/${name.name}`,
			kind,
			section: kind,
			title,
			description,
			added: null,
			sitemapPriority: kind === 'package' ? 0.6 : 0.4,
			showcase: false,
			url: null,
			dir: `${base}/${name.name}`,
		});
	}
	return out;
}

// --- announced status, read out of the coverage audit ------------------------

// Every inventory table in the audit has an "Announced" column, but not at the
// same index (pages carry Added, packages carry What it is). Reading the header
// row for the column position keeps this working when a table gains a column.
function coverageStatus() {
	const status = new Map();
	if (!existsSync(COVERAGE)) return status;
	let announcedIdx = -1;
	let postIdx = -1;
	for (const line of readFileSync(COVERAGE, 'utf8').split('\n')) {
		if (!line.startsWith('|')) continue;
		const cells = line.split('|').slice(1, -1).map((c) => c.trim());
		const header = cells.findIndex((c) => /^announced$/i.test(c));
		if (header >= 0) {
			announcedIdx = header;
			postIdx = cells.findIndex((c) => /post/i.test(c));
			continue;
		}
		if (announcedIdx < 0 || !cells[0]) continue;
		const key = cells[0].replace(/^`|`$/g, '').trim();
		const verdict = (cells[announcedIdx] || '').toLowerCase();
		if (!/^(yes|no|passing)$/.test(verdict)) continue;
		const post = postIdx >= 0 ? cells[postIdx] || '' : '';
		const links = [...post.matchAll(/\((https:\/\/x\.com\/[^)]+)\)/g)].map((m) => m[1]);
		status.set(key, { state: verdict === 'yes' ? 'announced' : verdict, posts: links });
	}
	return status;
}

// The audit closes with a hand-picked shortlist of the surfaces most worth
// posting. Reading it back gives the score a novelty signal that a description
// string cannot supply: "nothing else on the timeline is like this".
function curatedShortlist() {
	const picks = new Map();
	if (!existsSync(COVERAGE)) return picks;
	const body = readFileSync(COVERAGE, 'utf8');
	const start = body.indexOf('## Strongest unannounced candidates');
	if (start < 0) return picks;
	for (const line of body.slice(start).split('\n')) {
		if (!line.startsWith('| `')) continue;
		const cells = line.split('|').slice(1, -1).map((c) => c.trim());
		const why = cells[1] || '';
		for (const m of cells[0].matchAll(/`([^`]+)`/g)) picks.set(m[1], why);
	}
	return picks;
}

// --- scoring ----------------------------------------------------------------

const TOKEN_RE = /\$THREE|\btoken\b|\bcoin\b|\bx402\b|\bwallet\b|\bUSDC\b|on-chain|onchain|\bmint\b|\btrading\b|\bpump\.fun\b/i;
const PARTNERS = [
	[/\bMCP\b|Model Context Protocol/i, '@AnthropicAI'],
	[/\bSolana\b/i, '@solana'],
	[/watsonx|\bGranite\b|\bIBM\b/i, '@IBM'],
	[/pump\.fun/i, '@pumpfun'],
	[/\bNVIDIA\b|\bTRELLIS\b|\bNemotron\b/i, '@nvidia'],
	[/\bOpenAI\b|ChatGPT/i, '@OpenAI'],
	[/Hugging Face/i, '@huggingface'],
];
// Surfaces whose product IS a moving picture. The engagement report says an
// image carries 2.3x and text-only drags, so the ability to produce a real
// frame is worth more than any prose signal here.
const VISUAL_RE = /\b3D\b|avatar|animation|motion|mocap|render|scene|world|walk|camera|\bAR\b|garment|wardrobe|gallery|studio|viewer|visuali[sz]|map|chart|live|watch/i;

function scoreSurface(rec, curated) {
	const text = `${rec.title} ${rec.description}`;
	const signals = {};

	// Reach: what we already decided this surface is worth in the sitemap.
	signals.reach = Math.round(rec.sitemapPriority * 20);

	// Visual: can this produce a frame worth 2.3x, or a motion loop?
	signals.visual = rec.showcase ? 25 : VISUAL_RE.test(text) ? 14 : 0;

	// Token topic carried the highest measured lift of any topic we posted.
	signals.token = TOKEN_RE.test(text) ? 18 : 0;

	// A partner we can legitimately tag. Only counts when the surface really
	// runs on them; a tag we cannot justify is a lie, not a lift.
	const partner = PARTNERS.find(([re]) => re.test(text));
	signals.partner = partner ? 12 : 0;
	rec.partner = partner ? partner[1] : null;

	// Novelty: on the audit's hand-picked shortlist.
	const why = curated.get(rec.key);
	signals.novelty = why ? 20 : 0;
	rec.curatedWhy = why || null;

	// Depth: enough substance to write 280 characters and link proof.
	let depth = 0;
	const slug = rec.key.replace(/^[/@]/, '').replace(/[/@]/g, '-');
	if (existsSync(join(root, `docs/${slug}.md`))) depth += 8;
	if (rec.dir && existsSync(join(root, rec.dir, 'README.md'))) depth += 6;
	if (rec.description.length > 120) depth += 5;
	signals.depth = depth;

	rec.signals = signals;
	rec.score = Object.values(signals).reduce((a, b) => a + b, 0);
	return rec;
}

// --- liveness ---------------------------------------------------------------

async function probe(rec) {
	if (!rec.url) return { ok: true, reason: 'not a route' };
	try {
		const res = await fetch(`${SITE}${rec.url}`, { redirect: 'follow', signal: AbortSignal.timeout(25000) });
		const body = await res.text();
		return { ok: res.status === 200 && body.length > 4000, status: res.status, bytes: body.length };
	} catch (err) {
		return { ok: false, status: 0, error: String(err.message || err) };
	}
}

// --- main -------------------------------------------------------------------

const previous = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : { entries: [] };
const priorByKey = new Map((previous.entries || []).map((e) => [e.key, e]));

const status = coverageStatus();
const curated = curatedShortlist();
const inventory = [
	...pageInventory(),
	...dirInventory('packages', 'package', '@three-ws/'),
	...dirInventory('workers', 'worker', 'workers/'),
	...dirInventory('services', 'service', 'services/'),
];

for (const rec of inventory) {
	const known = status.get(rec.key) || status.get(rec.title) || null;
	rec.coverage = known ? known.state : 'no';
	rec.posts = known ? known.posts : [];
	// A pack advances through: backlog -> media -> drafted -> approved -> posted.
	// Only this script writes 'backlog'; the later states are set by the pack
	// tooling and by the owner, so they survive a rerun.
	const prior = priorByKey.get(rec.key);
	rec.stage = prior && prior.stage && prior.stage !== 'backlog' ? prior.stage : 'backlog';
	if (prior && prior.media) rec.media = prior.media;
	if (prior && prior.pack) rec.pack = prior.pack;
	rec.live = prior && prior.live ? prior.live : null;
	scoreSurface(rec, curated);
}

if (doProbe) {
	const candidates = inventory.filter((r) => r.coverage === 'no' && r.url);
	const queue = [...candidates];
	const workers = Array.from({ length: 8 }, async () => {
		while (queue.length) {
			const rec = queue.shift();
			rec.live = { ...(await probe(rec)), checkedAt: new Date().toISOString().slice(0, 10) };
		}
	});
	await Promise.all(workers);
	const dead = candidates.filter((r) => r.live && !r.live.ok);
	if (!asJson) console.error(`probed ${candidates.length} routes, ${dead.length} not announceable`);
}

const ranked = inventory
	.filter((r) => r.coverage === 'no')
	.filter((r) => !r.live || r.live.ok)
	.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));

if (doWrite) {
	const ledger = {
		$comment:
			'Announcement ledger. Regenerate with `npm run announce:rank -- --write`. Inventory and score are re-derived from data/pages.json, packages/, workers/, services/ and docs/announcement-coverage.md on every run; stage, media and pack are carried forward because the pack tooling and the owner own those.',
		generatedAt: new Date().toISOString(),
		weightsFrom: 'data/x-archive/analysis/trythreews-engagement.json',
		totals: {
			surfaces: inventory.length,
			announced: inventory.filter((r) => r.coverage === 'announced').length,
			passing: inventory.filter((r) => r.coverage === 'passing').length,
			never: inventory.filter((r) => r.coverage === 'no').length,
		},
		entries: inventory.sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)),
	};
	writeFileSync(LEDGER, `${JSON.stringify(ledger, null, '\t')}\n`);
	if (!asJson) console.error(`wrote ${LEDGER}`);
}

if (asJson) {
	console.log(JSON.stringify({ ranked: ranked.slice(0, topN) }, null, 2));
} else {
	const never = inventory.filter((r) => r.coverage === 'no').length;
	console.log(`${inventory.length} shipped surfaces, ${never} never announced. Top ${Math.min(topN, ranked.length)}:\n`);
	console.log(`${'#'.padStart(3)}  ${'score'.padStart(5)}  ${'surface'.padEnd(34)} ${'kind'.padEnd(8)} signals`);
	ranked.slice(0, topN).forEach((r, i) => {
		const sig = Object.entries(r.signals)
			.filter(([, v]) => v > 0)
			.map(([k, v]) => `${k}:${v}`)
			.join(' ');
		console.log(`${String(i + 1).padStart(3)}  ${String(r.score).padStart(5)}  ${r.key.padEnd(34)} ${r.kind.padEnd(8)} ${sig}`);
	});
}
