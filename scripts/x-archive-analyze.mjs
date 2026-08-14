#!/usr/bin/env node
/**
 * Engagement analysis over the X post archive.
 *
 * Usage:
 *   node scripts/x-archive-analyze.mjs                      # DB if reachable, else the archive files
 *   node scripts/x-archive-analyze.mjs --source files       # force the checked-in archive
 *   node scripts/x-archive-analyze.mjs --source db          # force Postgres (fails loudly if unreachable)
 *   node scripts/x-archive-analyze.mjs --handle trythreews  # one account (default: every account found)
 *   node scripts/x-archive-analyze.mjs --stdout             # print the report instead of writing files
 *
 * Writes docs/x-archive/<handle>-engagement.md (the readable report) and
 * data/x-archive/analysis/<handle>-engagement.json (the same numbers as data).
 */

import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
	ARCHIVE_DIR,
	analyze,
	engagementRate,
	engagements,
	listArchiveFiles,
	mergeScrapes,
	readScrapeFile,
	topicsOf,
} from './x-archive-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DOC_DIR = path.resolve(REPO_ROOT, 'docs', 'x-archive');
const REPORT_DIR = path.resolve(REPO_ROOT, ARCHIVE_DIR, 'analysis');

for (const envFile of ['.env.local', '.env']) {
	try {
		const raw = readFileSync(path.resolve(REPO_ROOT, envFile), 'utf8');
		for (const line of raw.split('\n')) {
			const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
			if (!m || process.env[m[1]]) continue;
			let val = m[2].trim();
			if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
				val = val.slice(1, -1);
			}
			process.env[m[1]] = val;
		}
	} catch {
		// Absent env files are normal outside a configured checkout.
	}
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : null;
};

const SOURCE = value('source') || 'auto';
const ONLY_HANDLE = value('handle');
const TO_STDOUT = flag('stdout');

async function loadFromFiles() {
	const files = await listArchiveFiles(path.resolve(REPO_ROOT, ARCHIVE_DIR));
	if (!files.length) throw new Error(`no scrape files in ${ARCHIVE_DIR}`);
	const byHandle = new Map();
	for (const file of files) {
		const scrape = await readScrapeFile(file);
		if (!byHandle.has(scrape.handle)) byHandle.set(scrape.handle, []);
		byHandle.get(scrape.handle).push(scrape);
	}
	const out = new Map();
	for (const [handle, scrapes] of byHandle) {
		out.set(handle, { posts: mergeScrapes(scrapes).posts, sources: scrapes.map((s) => path.relative(REPO_ROOT, s.sourceFile)) });
	}
	return { origin: 'archive files', accounts: out };
}

async function loadFromDb() {
	const { neon } = await import('@neondatabase/serverless');
	const sql = neon(process.env.DATABASE_URL);
	const rows = await sql`
		select tweet_id, handle, author_handle, url, text, posted_at,
		       is_retweet, is_reply, is_pinned, has_image, has_video, has_card,
		       hashtags, mentions, urls,
		       likes, retweets, replies, views, views_label, views_exact, metrics_source, measured_at
		from x_account_posts
		order by posted_at desc
	`;
	const imports = await sql`select handle, source_file, scraped_at from x_account_imports order by scraped_at`;
	const accounts = new Map();
	for (const r of rows) {
		const post = {
			tweetId: r.tweet_id,
			handle: r.handle,
			authorHandle: r.author_handle,
			isOwn: r.author_handle === r.handle,
			url: r.url,
			text: r.text,
			postedAt: new Date(r.posted_at).toISOString(),
			isRetweet: r.is_retweet,
			isReply: r.is_reply,
			isPinned: r.is_pinned,
			hasImage: r.has_image,
			hasVideo: r.has_video,
			hasCard: r.has_card,
			hashtags: r.hashtags || [],
			mentions: r.mentions || [],
			urls: r.urls || [],
			likes: r.likes,
			retweets: r.retweets,
			replies: r.replies,
			views: r.views,
			viewsLabel: r.views_label,
			viewsExact: r.views_exact,
			metricsSource: r.metrics_source,
			measuredAt: r.measured_at ? new Date(r.measured_at).toISOString() : null,
		};
		if (!accounts.has(r.handle)) {
			accounts.set(r.handle, {
				posts: [],
				sources: imports.filter((i) => i.handle === r.handle).map((i) => i.source_file),
			});
		}
		accounts.get(r.handle).posts.push(post);
	}
	if (!accounts.size) throw new Error('x_account_posts is empty. Run `npm run x:archive:import` first.');
	return { origin: 'database', accounts };
}

async function load() {
	if (SOURCE === 'files') return loadFromFiles();
	if (SOURCE === 'db') {
		if (!process.env.DATABASE_URL) throw new Error('--source db needs DATABASE_URL');
		return loadFromDb();
	}
	if (process.env.DATABASE_URL) {
		try {
			return await loadFromDb();
		} catch (err) {
			console.warn(`database unavailable (${err.message}); falling back to the archive files.`);
		}
	}
	return loadFromFiles();
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const num = (n, digits = 0) => (n === null || n === undefined ? 'n/a' : Number(n).toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const pct = (n, digits = 1) => (n === null || n === undefined ? 'n/a' : `${Number(n).toFixed(digits)}%`);
const lift = (n) => (n === null || n === undefined ? 'n/a' : `${n.toFixed(2)}x`);
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function excerpt(post, len = 90) {
	const oneLine = post.text.replace(/\s+/g, ' ').trim();
	return oneLine.length > len ? `${oneLine.slice(0, len - 1)}…` : oneLine;
}

function tagsOf(post) {
	const tags = [];
	if (post.hasVideo) tags.push('video');
	else if (post.hasImage) tags.push('image');
	else if (post.hasCard) tags.push('card');
	else tags.push('text');
	if (post.mentions.length) tags.push(`@${post.mentions.length}`);
	if (post.isReply) tags.push('reply');
	tags.push(...topicsOf(post));
	return tags.join(', ');
}

function postTable(posts, { rate = false } = {}) {
	const head = rate
		? '| Date | Post | Views | Eng. | Rate | Signals |\n|---|---|---:|---:|---:|---|'
		: '| Date | Post | Likes | RT | Replies | Eng. | Signals |\n|---|---|---:|---:|---:|---:|---|';
	const rows = posts.map((p) => {
		const date = p.postedAt.slice(0, 10);
		const link = `[${excerpt(p).replace(/\|/g, '\\|')}](${p.url})`;
		return rate
			? `| ${date} | ${link} | ${p.viewsLabel || num(p.views)} | ${num(engagements(p))} | ${pct(engagementRate(p), 2)} | ${tagsOf(p)} |`
			: `| ${date} | ${link} | ${num(p.likes)} | ${num(p.retweets)} | ${num(p.replies)} | ${num(engagements(p))} | ${tagsOf(p)} |`;
	});
	return `${head}\n${rows.join('\n')}`;
}

// Turn the measured lifts into plain sentences. Everything here is derived from
// the numbers above it, so the read-off cannot drift from the data.
function readOff(report) {
	const lines = [];
	const strong = report.formats
		.filter((f) => f.significant && f.with.lift !== null && f.without.lift !== null)
		.map((f) => ({ ...f, delta: f.with.lift - f.without.lift }))
		.sort((a, b) => b.delta - a.delta);

	for (const f of strong.slice(0, 3)) {
		if (f.delta <= 0.15) continue;
		lines.push(
			`**${f.label}** carries: ${f.with.count} posts at a median ${num(f.with.medianEngagements)} engagements (${lift(f.with.lift)} the corpus median) against ${num(f.without.medianEngagements)} for the ${f.without.count} without it.`,
		);
	}
	for (const f of strong.slice(-2).reverse()) {
		if (f.delta >= -0.15) continue;
		lines.push(
			`**${f.label}** costs: ${f.with.count} posts at a median ${num(f.with.medianEngagements)} (${lift(f.with.lift)}) against ${num(f.without.medianEngagements)} without.`,
		);
	}

	const topics = report.topics.filter((t) => t.count >= 5);
	if (topics.length) {
		const best = topics[0];
		const worst = topics[topics.length - 1];
		lines.push(
			`Best-performing subject: **${best.label}** (${best.count} posts, median ${num(best.medianEngagements)}, ${lift(best.lift)}). Weakest: **${worst.label}** (${worst.count} posts, median ${num(worst.medianEngagements)}, ${lift(worst.lift)}).`,
		);
	}

	const lengths = report.lengths.filter((l) => l.count >= 5).sort((a, b) => (b.lift || 0) - (a.lift || 0));
	if (lengths.length) {
		lines.push(`Best length band: **${lengths[0].label}** (${lengths[0].count} posts, ${lift(lengths[0].lift)}). Worst: **${lengths[lengths.length - 1].label}** (${lift(lengths[lengths.length - 1].lift)}).`);
	}

	const hours = report.timing.byHourUtc.filter((h) => h.count >= 5).sort((a, b) => (b.lift || 0) - (a.lift || 0));
	if (hours.length) {
		lines.push(`Strongest posting hour: **${String(hours[0].hour).padStart(2, '0')}:00 UTC** (${hours[0].count} posts, ${lift(hours[0].lift)}). Weakest: **${String(hours[hours.length - 1].hour).padStart(2, '0')}:00 UTC** (${lift(hours[hours.length - 1].lift)}).`);
	}

	if (report.distribution.topDecileShare !== null) {
		lines.push(
			`Concentration: the top 10% of posts earn **${pct(report.distribution.topDecileShare * 100)}** of all engagement. Median post: ${num(report.distribution.medianEngagements)} engagements; p90: ${num(report.distribution.p90)}; best: ${num(report.distribution.max)}.`,
		);
	}

	return lines.map((l) => `- ${l}`).join('\n');
}

function renderMarkdown(report, meta) {
	const g = report.generatedFrom;
	const d = report.distribution;

	return `# @${report.handle}: what actually lands on X

Generated by \`npm run x:archive:analyze\` from the post archive in [data/x-archive/](../../data/x-archive/). Do not hand-edit: rerun the script after the next scrape.

- **Source:** ${meta.origin} (${meta.sources.join(', ') || 'n/a'})
- **Generated:** ${meta.generatedAt}
- **Corpus:** ${num(g.analyzed)} posts written by @${report.handle}, ${g.firstPostAt?.slice(0, 10)} to ${g.lastPostAt?.slice(0, 10)}.
- **Excluded:** ${num(g.retweetsExcluded)} reposts and quotes of other accounts (they carry the original author's engagement, not ours) and ${num(g.suspectExcluded)} of our own posts whose scraped like count is not believable (see the data-quality note below).
- **Engagements** here means likes + reposts + replies. Views measure delivery, engagements measure whether anyone cared.
- **View counts are rounded by X itself** past 999 ("6.3K"), so every rate below carries about two significant figures. Exact counts under 1,000 are exact.

### Data quality

${num(g.suspectExcluded)} of ${num(g.ownPosts)} own posts came back with 0 likes despite real reach or replies, which the timeline scraper does when the like counter has not rendered yet. They are archived but left out of every measurement here rather than dragging the medians down. Highest-reach examples:

${(g.suspectSample || []).map((s) => `- [${s.postedAt.slice(0, 10)}](${s.url}) - ${num(s.views)} views, ${num(s.replies)} replies, 0 likes recorded`).join('\n') || '- none'}

Fix: \`npm run x:archive:refresh\` pulls exact counts for every archived post straight from the X API (needs \`X_API_BEARER\`) and writes them back as a new archive snapshot. Rerun this analysis afterwards and the exclusions disappear.

## Headline

| Metric | Value |
|---|---:|
| Posts analyzed | ${num(g.analyzed)} |
| Total likes | ${num(report.totals.likes)} |
| Total reposts | ${num(report.totals.retweets)} |
| Total replies | ${num(report.totals.replies)} |
| Total views (approx) | ${num(report.totals.views)} |
| Median engagements per post | ${num(d.medianEngagements)} |
| Mean engagements per post | ${num(d.meanEngagements, 1)} |
| p75 / p90 / p99 | ${num(d.p75)} / ${num(d.p90)} / ${num(d.p99)} |
| Best post | ${num(d.max)} |
| Median engagement rate | ${pct(d.medianRatePct, 2)} of views (${num(d.ratedPosts)} posts with a view count) |
| Share of engagement from the top 10% of posts | ${d.topDecileShare === null ? "n/a" : pct(d.topDecileShare * 100)} |

## The read-off

${readOff(report)}

## Top 15 posts by engagement

${postTable(report.top.byEngagements)}

## Highest engagement rate (500+ views)

Rate normalizes for reach, so this is the list of posts that converted the attention they got rather than the posts that simply got shown to more people.

${postTable(report.top.byRate, { rate: true })}

## Most replies (conversation starters)

${postTable(report.top.byReplies)}

## What correlates with engagement

Lift is the group's median engagements divided by the corpus median. Rows are only shown where both sides have enough posts to compare.

| Signal | With | Median (with) | Lift | Without | Median (without) | Lift |
|---|---:|---:|---:|---:|---:|---:|
${report.formats
	.filter((f) => f.significant)
	.sort((a, b) => (b.with.lift || 0) - (a.with.lift || 0))
	.map((f) => `| ${f.label} | ${num(f.with.count)} | ${num(f.with.medianEngagements)} | ${lift(f.with.lift)} | ${num(f.without.count)} | ${num(f.without.medianEngagements)} | ${lift(f.without.lift)} |`)
	.join('\n')}

### By length

| Length | Posts | Median | Mean | Best | Lift |
|---|---:|---:|---:|---:|---:|
${report.lengths.map((l) => `| ${l.label} | ${num(l.count)} | ${num(l.medianEngagements)} | ${num(l.meanEngagements, 1)} | ${num(l.bestEngagements)} | ${lift(l.lift)} |`).join('\n')}

### By subject

A post can carry more than one subject, so the counts sum past the corpus size.

| Subject | Posts | Median | Mean | Best | Lift |
|---|---:|---:|---:|---:|---:|
${report.topics.map((t) => `| ${t.label} | ${num(t.count)} | ${num(t.medianEngagements)} | ${num(t.meanEngagements, 1)} | ${num(t.bestEngagements)} | ${lift(t.lift)} |`).join('\n')}

## Timing (UTC)

| Hour | Posts | Median | Lift |
|---:|---:|---:|---:|
${report.timing.byHourUtc.map((h) => `| ${String(h.hour).padStart(2, '0')}:00 | ${num(h.count)} | ${num(h.medianEngagements)} | ${lift(h.lift)} |`).join('\n')}

| Weekday | Posts | Median | Lift |
|---|---:|---:|---:|
${report.timing.byWeekdayUtc.map((w) => `| ${WEEKDAYS[w.weekday]} | ${num(w.count)} | ${num(w.medianEngagements)} | ${lift(w.lift)} |`).join('\n')}

## Cadence by month

| Month | Posts | Median | Mean | Best |
|---|---:|---:|---:|---:|
${report.cadence.map((c) => `| ${c.month} | ${num(c.count)} | ${num(c.medianEngagements)} | ${num(c.meanEngagements, 1)} | ${num(c.bestEngagements)} |`).join('\n')}

## Accounts we mention (2+ posts)

| Account | Posts mentioning | Mean engagements |
|---|---:|---:|
${report.mentions.map((m) => `| ${m.handle} | ${num(m.posts)} | ${num(m.meanEngagements, 1)} |`).join('\n')}

## Accounts we repost or quote

Excluded from every measurement above, kept because who the account amplifies is its own marketing record.

| Account | Posts amplified |
|---|---:|
${report.amplified.byAuthor.map((a) => `| @${a.author} | ${num(a.count)} |`).join('\n')}

## Lowest 10 posts

The floor is as instructive as the ceiling: these are the shapes to stop repeating.

${postTable(report.top.worst)}
`;
}

async function main() {
	const { origin, accounts } = await load();
	const generatedAt = new Date().toISOString();

	for (const [handle, { posts, sources }] of accounts) {
		if (ONLY_HANDLE && handle !== ONLY_HANDLE.replace(/^@/, '')) continue;
		const report = analyze(posts, { handle });
		const markdown = renderMarkdown(report, { origin, sources, generatedAt });

		if (TO_STDOUT) {
			console.log(markdown);
			continue;
		}

		await mkdir(DOC_DIR, { recursive: true });
		await mkdir(REPORT_DIR, { recursive: true });
		const mdPath = path.join(DOC_DIR, `${handle}-engagement.md`);
		const jsonPath = path.join(REPORT_DIR, `${handle}-engagement.json`);
		await writeFile(mdPath, markdown);
		await writeFile(jsonPath, `${JSON.stringify({ generatedAt, origin, sources, report }, null, 2)}\n`);
		console.log(`@${handle}: ${report.generatedFrom.analyzed} posts analyzed from ${origin}`);
		console.log(`  ${path.relative(REPO_ROOT, mdPath)}`);
		console.log(`  ${path.relative(REPO_ROOT, jsonPath)}`);
	}
}

main().catch((err) => {
	console.error(err.message || err);
	process.exitCode = 1;
});
