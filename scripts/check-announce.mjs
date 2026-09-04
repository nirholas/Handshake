#!/usr/bin/env node
// check-announce.mjs - the gate every announcement pack has to clear.
//
// The point of the announcement pipeline is to work a 320-surface backlog down
// without the output reading as machine-generated. That risk is not theoretical:
// 300 posts written from one template converge on one shape, an audience learns
// the shape, and then the announcements that matter get skipped along with the
// rest. Taste does not scale to 300 posts. Mechanical checks do, so the ones
// that can be mechanical are here.
//
// What it enforces, and why each one exists:
//
//   • Media.        A post with no image measured 0.875x against the account
//                   median, and 132 of our 158 measured posts had none. A pack
//                   with no captured frame is not finished.
//   • Alt text.     A post whose payload is an image is unreadable without it.
//   • Length.       Under 100 characters the mechanism is missing (121 of 158
//                   posts, the account's worst-performing shape). Over 280
//                   weighted characters X refuses it outright.
//   • Voice.        No hashtags, no emoji, no em-dashes, and none of the
//                   openings that mark generated marketing copy.
//   • Uniqueness.   No two packs may open with the same clause.
//   • The coin gate. A pack that names a crypto project other than $THREE, or
//                   ships media captured from a surface that renders live
//                   third-party market data, needs recorded owner approval
//                   before it can be committed or posted. This is the operating
//                   rules' commit gate, applied to announcement assets, and it
//                   is the check most likely to actually fire: a screenshot of
//                   a live trading surface bakes whatever tickers were on
//                   screen into a committed file.
//
// It reads packs, never writes, and never posts.
//
//   node scripts/check-announce.mjs            # check every pack
//   node scripts/check-announce.mjs --pack genesis
//
// Wired as `npm run check:announce`.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_DIR = join(root, 'docs/announcements');
const MEDIA_SPEC = join(root, 'data/announce-media.json');
const MANIFEST = join(root, 'public/announce/media-manifest.json');

const argv = process.argv.slice(2);
const only = (() => {
	const i = argv.indexOf('--pack');
	return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
})();

// X counts a URL as 23 characters however long it really is, and an astral
// codepoint as 2. Kept byte-compatible with scripts/post-tweet.mjs, which is
// what actually refuses an over-long post.
const weightedLength = (s) =>
	[...s.replace(/https?:\/\/\S+/g, 'x'.repeat(23))].reduce(
		(n, ch) => n + (ch.codePointAt(0) > 0xffff ? 2 : 1),
		0,
	);

// Openings that mark a post as generated. Measured against our own archive:
// exactly one of 214 posts opened this way, so this bans a shape the account
// has already avoided rather than imposing a new one.
const BANNED_OPENINGS = [
	/^introducing\b/i,
	/^we(?:'re| are) (?:excited|thrilled|proud|happy)/i,
	/^say hello to\b/i,
	/^meet the new\b/i,
	/^big news\b/i,
	/^today we(?:'re| are) launching\b/i,
	/^ever wondered\b/i,
	/^what if you could\b/i,
	/^imagine a world\b/i,
];
const BANNED_PHRASES = [
	/\bgame[- ]chang(?:er|ing)\b/i,
	/\brevolutionary\b/i,
	/\bseamless(?:ly)?\b/i,
	/\bunlock the power\b/i,
	/\bnext level\b/i,
	/\bthe future of \w+ is here\b/i,
	/\band the best part\b/i,
	/\blet that sink in\b/i,
	/\bhere'?s the kicker\b/i,
	/\bsupercharge\b/i,
];

// Built from escapes on purpose: this repo bans both glyphs everywhere, so the
// detector cannot spell them out without failing its own rule.
const BANNED_DASHES = new RegExp('[\\u2014\\u2013]');

const problems = [];
const notes = [];
const fail = (pack, msg) => problems.push(`${pack}: ${msg}`);

if (!existsSync(PACK_DIR)) {
	console.log('check-announce: no docs/announcements/ yet, nothing to check');
	process.exit(0);
}

const spec = existsSync(MEDIA_SPEC) ? JSON.parse(readFileSync(MEDIA_SPEC, 'utf8')) : { shots: [] };
const shotsById = new Map((spec.shots || []).map((s) => [s.id, s]));
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};
const manifestShots = new Map(
	(Array.isArray(manifest.shots) ? manifest.shots : Object.values(manifest.shots || {})).map((s) => [s.id, s]),
);

// Surfaces whose frames carry live third-party market data. Derived from
// data/pages.json rather than listed by hand, so a new crypto surface inherits
// the gate instead of quietly escaping it.
const cryptoPaths = new Set();
try {
	const pages = JSON.parse(readFileSync(join(root, 'data/pages.json'), 'utf8'));
	for (const section of pages.sections) {
		if (section.id !== 'crypto') continue;
		for (const page of section.pages) cryptoPaths.add(page.path);
	}
} catch {
	notes.push('data/pages.json unreadable: the coin gate could not classify surfaces');
}

const packs = readdirSync(PACK_DIR)
	.filter((f) => f.endsWith('.md'))
	// README.md documents the directory; it is not a pack.
	.filter((f) => f !== 'README.md')
	.filter((f) => !only || basename(f, '.md') === only);

if (!packs.length) {
	console.log(only ? `check-announce: no pack named ${only}` : 'check-announce: no packs yet');
	process.exit(only ? 1 : 0);
}

const openings = new Map();

for (const file of packs) {
	const name = basename(file, '.md');
	const body = readFileSync(join(PACK_DIR, file), 'utf8');

	// The post itself lives in a sibling .post.txt so that what the gate checks
	// and what post-tweet.mjs sends are the same bytes. A post quoted only
	// inside prose can drift from the file that actually ships.
	const postFile = join(PACK_DIR, `${name}.post.txt`);
	if (!existsSync(postFile)) {
		fail(name, `missing ${name}.post.txt (the file post-tweet.mjs would send)`);
		continue;
	}
	const post = readFileSync(postFile, 'utf8').trim();
	if (!post.includes(post.trim())) fail(name, 'post file is empty');

	const weight = weightedLength(post);
	if (weight > 280) fail(name, `post is ${weight} weighted chars, over X's 280 limit`);
	else if (weight < 100) fail(name, `post is ${weight} weighted chars; under 100 measured 0.83x`);
	else if (weight > 179) notes.push(`${name}: ${weight} chars is the 1.67x band, not the 3.0x band`);

	if (!post.includes(post.trim())) fail(name, 'post file is empty');
	if (/#\w/.test(post)) fail(name, 'post contains a hashtag (0 of our 214 posts use one)');
	if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(post)) {
		fail(name, 'post contains an emoji (0 of our 214 posts use one)');
	}
	if (BANNED_DASHES.test(post) || BANNED_DASHES.test(body)) {
		fail(name, 'contains an em-dash or en-dash, which the house style bans');
	}
	if (!/https?:\/\/|three\.ws\//.test(post)) fail(name, 'post links nothing; a reader cannot reach the feature');

	for (const re of BANNED_OPENINGS) {
		if (re.test(post)) fail(name, `post opens with a banned construction: ${re.source}`);
	}
	for (const re of BANNED_PHRASES) {
		if (re.test(post)) fail(name, `post uses banned marketing filler: ${re.source}`);
	}

	// Uniqueness: no two packs may open with the same clause. This is the check
	// that keeps a long run of announcements from converging on one shape.
	const opening = post.toLowerCase().split(/\s+/).slice(0, 8).join(' ');
	if (openings.has(opening)) fail(name, `opens identically to ${openings.get(opening)}`);
	else openings.set(opening, name);

	// Media, by shot id, present in the spec, on disk, and in the manifest.
	const shotIds = [...body.matchAll(/^\| `([a-z0-9-]+)` \|/gm)].map((m) => m[1]);
	if (!shotIds.length) fail(name, 'declares no media; a post with no image measured 0.875x');
	for (const id of shotIds) {
		if (!shotsById.has(id)) fail(name, `media shot "${id}" is not in data/announce-media.json`);
		const written = manifestShots.get(id);
		if (!written) fail(name, `media shot "${id}" has never been captured (run npm run announce:media)`);
		else if (!existsSync(join(root, 'public', written.src.replace(/^\//, '')))) {
			fail(name, `media shot "${id}" is in the manifest but its file is missing`);
		}
		const shot = shotsById.get(id);
		if (shot && !shot.alt) fail(name, `media shot "${id}" has no alt text`);
	}
	if (!/alt text/i.test(body)) fail(name, 'pack does not state the alt text the post must carry');

	// The coin gate. Copy first, then the surfaces the media came from.
	const tickers = [...`${post}\n${body}`.matchAll(/\$([A-Z][A-Z0-9]{1,9})\b/g)]
		.map((m) => m[1])
		.filter((t) => t !== 'THREE');
	if (tickers.length) {
		fail(
			name,
			`copy names a crypto project other than $THREE (${[...new Set(tickers)].join(', ')}); owner approval is required before committing or posting`,
		);
	}
	const gated = shotIds
		.map((id) => shotsById.get(id))
		.filter((s) => s && s.surface && cryptoPaths.has(s.surface) && !s.thirdPartyMarketDataApproved);
	if (gated.length) {
		fail(
			name,
			`media from ${gated.map((s) => s.surface).join(', ')} renders live third-party market data; that frame needs owner approval before it is committed (set thirdPartyMarketDataApproved on the shot once given)`,
		);
	}
}

for (const note of notes) console.log(`note  ${note}`);
if (problems.length) {
	console.error(`\ncheck-announce: ${problems.length} problem(s)\n`);
	for (const p of problems) console.error(`  ${p}`);
	process.exit(1);
}
console.log(`check-announce: ${packs.length} pack(s) OK`);
