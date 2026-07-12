#!/usr/bin/env node
// build-tour.mjs — generate the Feature Tour curriculum from data/pages.json.
// ============================================================================
// The Feature Tour is a 3D avatar that walks across the live site, points at
// real features, and narrates each one. This script is the single source of
// truth for WHAT it visits and WHAT it says: it reads the same plain-language
// page descriptions that already feed the changelog and sitemap, curates them
// into a coherent ~30–60 minute route, and emits public/tour/curriculum.json.
//
//   node scripts/build-tour.mjs            → write public/tour/curriculum.json
//   node scripts/build-tour.mjs --check    → fail if the committed file is stale
//
// Keeping the curriculum generated (not hand-maintained) means a new page that
// lands in data/pages.json is one rebuild away from being in the tour — the
// narration stays truthful because it comes from the page's own description.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PAGES_PATH = resolve(ROOT, 'data/pages.json');
const OUT_PATH = resolve(ROOT, 'public/tour/curriculum.json');

// ── Curation ────────────────────────────────────────────────────────────────
// The tour tells a story: arrive → build a body → explore the network → see the
// money rails → witness the showcases → learn where to go next. Sections render
// in this order; everything else (account, legal, machine, blog) is skipped.
const SECTION_ORDER = ['main', 'build', 'crypto', 'labs', 'agent-tools', 'learn'];

// A spoken bridge the guide says when it first enters each section, so the tour
// reads as chapters rather than a flat list.
const SECTION_INTROS = {
	main: "Welcome — I'm your guide. Over the next while I'll walk you through three.ws and show you, hands-on, what every part of the platform does. Let's start at the front door.",
	build: "Now the fun part — building. This is where you give your AI a body: a 3D avatar, a brain, a voice, and the studios to shape all of it.",
	crypto: "Here's what makes three.ws agents truly autonomous — they can hold a wallet and move real money. Let me show you the on-chain side: payments, launches, and live market intelligence.",
	labs: "These are the showcases — the experiments and living demos that show the platform off at full power. Some of my favourites are in here.",
	'agent-tools': "Once you've built agents, this is where you talk to them, manage them, and check their reputation.",
	learn: "And when you're ready to go deeper on your own, here's where the documentation, guides, and tutorials live. That's the whole tour — let's wrap up.",
};

// Pages to skip even though they live in a kept section: sign-in plumbing,
// near-duplicate marketing shells of a real product page, and utility/index
// pages that aren't a "feature" to demo. The real product page is always
// preferred over its /features/* landing-page twin.
const DENY = new Set([
	'/login', '/register', '/forgot-password', '/sitemap',
	// The tour's own landing page is the entry point, not a stop on the route.
	'/tour',
	// /features/* are marketing landings for product pages already in the tour.
	'/features/ar', '/features/forge', '/features/scan', '/features/play',
	'/features/walk', '/features/studio', '/features/marketplace',
	'/features/agent-exchange', '/features/deploy',
	// Near-duplicate create flows — the tour visits /create-agent + /agent-studio.
	'/create', '/agent/new', '/start',
	// Overlapping agent-economy demos — /demo is the canonical one we visit.
	'/agent-economy', '/agent-trade', '/live', '/agent-exchange',
	// Internal/edge utility pages, not a guided-tour feature.
	'/artifact', '/avatar-artifact', '/validation', '/lookup', '/import/rpm',
	'/threews/claim', '/vanity/verify', '/eth-vanity', '/evm-wallet',
]);

// Whole subtrees the tour points at via their gateway page rather than visiting
// every leaf: the guide stops at /docs and /tutorials and tells you the rest is
// in there — narrating 20+ reference pages one by one would stall the tour.
const DENY_PREFIX = ['/docs/', '/tutorials/', '/dashboard/', '/marketplace/'];

// Hero pages that lead their section (shown first, in this order) because they
// are the clearest, most representative entry into the chapter.
const SECTION_HEROES = {
	main: ['/', '/what-is', '/discover', '/marketplace'],
	build: ['/create-agent', '/forge', '/scan', '/agent-studio', '/pose', '/voice'],
	crypto: ['/pay', '/x402/studio', '/launch', '/oracle', '/vanity-wallet'],
	labs: ['/club', '/three-live', '/constellation', '/brain', '/labs'],
	'agent-tools': ['/chat', '/agents', '/reputation'],
	learn: ['/docs', '/tutorials'],
};

// Optional hand-authored anchors: the on-page element the guide should point at.
// When absent, the runtime falls back to a heuristic (main heading → primary
// call-to-action). Selectors are tried in order; the first match wins.
const TARGETS = {
	'/': ['a[href="/create-agent"], a[href="/create"], .hero a.cta, main a.button'],
	'/forge': ['textarea, input[type="text"], .prompt-input, form'],
	'/create-agent': ['form, .wizard, .step, button'],
	'/scan': ['button, .scan-start, video, .camera'],
	'/pose': ['canvas, .timeline, .pose-controls'],
	'/voice': ['button, .record, audio'],
	'/club': ['canvas, .tip-button, [data-tip]'],
	'/pay': ['form, input, button'],
	'/x402/studio': ['.console, nav, form, button'],
	'/launch': ['form, input, button'],
	'/oracle': ['.score, canvas, .conviction, h1'],
	'/vanity-wallet': ['input, button, .grinder'],
	'/three-live': ['canvas'],
	'/constellation': ['canvas'],
	'/brain': ['textarea, input, form'],
	'/chat': ['textarea, input, .composer, form'],
	'/discover': ['.agent-card, .grid, [data-agent], main'],
	'/marketplace': ['.card, .grid, [data-skill], main'],
	'/docs': ['nav, .sidebar, main'],
};

// Spoken connectors so 50+ stops don't all open the same way. Indexed
// deterministically by stop position for reproducible output.
const CONNECTORS = [
	'Here we have', 'Next up,', 'This is', 'Take a look at', 'Now,', "Let's visit",
	'Over here is', "Here's", 'Meet', 'And this —', 'Check out', 'This one is',
];

// ── Onboarding track ────────────────────────────────────────────────────────
// A short, hand-authored second curriculum baked into the same stops list
// (section: "onboarding"), separate from the generic per-page sections above.
// It exists to answer the question a brand-new account actually has — "what
// do I do first?" — by chaining the platform's real flows into one guided
// path: make an avatar → put it in a world → see the world's coin tied to
// live $THREE market data → optionally launch your own coin → land on your
// own profile and see what you just made. Every stop is a real, already-
// shipped page (no bespoke onboarding UI); the "optional" coin-launch stop is
// clearly announced as skippable in its narration — the visitor can press
// Next/skip it or jump straight to the final stop via the chapter map.
const ONBOARDING_STOPS = [
	{
		id: 'onboarding-start',
		path: '/start',
		title: 'Welcome to three.ws',
		narration:
			"Welcome — let's get you set up. In the next few minutes you'll make a 3D avatar, put it in a world, see it tied to real $THREE market data, and land on your own profile with your first creation on it. First stop: your avatar.",
		highlight: true,
		targets: ['.wizard, .step, main h1, main'],
	},
	{
		id: 'onboarding-avatar',
		path: '/create/selfie',
		title: 'Make your avatar',
		narration:
			"This is where you build a body. Take a selfie or describe one, and three.ws generates a rigged, animation-ready 3D avatar you own — this becomes your creator identity across the whole platform.",
		highlight: true,
		targets: ['.camera, video, .capture, button, main'],
	},
	{
		id: 'onboarding-world',
		path: '/diorama',
		title: 'Build a world',
		narration:
			"Nice — you've got an avatar. Now give it somewhere to live. Diorama turns one sentence into a full 3D world and drops your avatar into it. This is your first world, saved to your account.",
		highlight: true,
		targets: ['canvas, .diorama-canvas, main'],
	},
	{
		id: 'onboarding-markets',
		path: '/markets',
		title: 'Real markets, live',
		narration:
			"Your creation isn't sitting in a vacuum — three.ws is wired straight into real on-chain markets. This is live $THREE price and volume, the same rails every coin on the platform launches through.",
		highlight: true,
		targets: ['.market-card, .price, canvas, main'],
	},
	{
		id: 'onboarding-launch',
		path: '/create-agent',
		title: 'Launch a coin (optional)',
		narration:
			"Optional step — skip it if you're not ready. If you want to take your avatar on-chain, this is where you give it a brain and, if you choose, launch its own coin. You can always come back to this later from your profile.",
		highlight: false,
		targets: ['form, .wizard, .step, button, main'],
	},
	{
		id: 'onboarding-profile',
		path: '/profile',
		title: 'Your profile',
		narration:
			"And here's home base — your creator profile. Your avatar and your first world are already listed here, plus any streak or badge you've started earning. Everything you make from now on shows up right here. That's the whole loop — go make something.",
		highlight: true,
		targets: ['.creations, .portfolio, main h1, main'],
	},
];

const ONBOARDING_SECTION_INTRO =
	"Welcome — I'm your guide. Let's get you from a blank account to your first real creation in about five minutes.";

function loadPages() {
	const raw = JSON.parse(readFileSync(PAGES_PATH, 'utf8'));
	const bySection = new Map();
	for (const section of raw.sections || []) {
		const kept = (section.pages || []).filter(
			(p) =>
				p.auth !== 'required' &&
				!DENY.has(p.path) &&
				!DENY_PREFIX.some((prefix) => p.path.startsWith(prefix)),
		);
		if (kept.length) bySection.set(section.id, { meta: section, pages: kept });
	}
	return bySection;
}

// Order a section's pages: heroes first (in their declared order), then the
// rest by recency (newest features are usually the most interesting to show).
function orderSection(id, pages) {
	const heroes = SECTION_HEROES[id] || [];
	const heroRank = new Map(heroes.map((path, i) => [path, i]));
	return [...pages].sort((a, b) => {
		const ra = heroRank.has(a.path) ? heroRank.get(a.path) : Infinity;
		const rb = heroRank.has(b.path) ? heroRank.get(b.path) : Infinity;
		if (ra !== rb) return ra - rb;
		// Both non-hero → newest first, stable on title.
		const da = a.added || '';
		const db = b.added || '';
		if (da !== db) return da < db ? 1 : -1;
		return (a.title || '').localeCompare(b.title || '');
	});
}

// Turn a page's title + description into a spoken paragraph. Descriptions are
// already written in plain, holder-readable language, so we mostly clean and
// frame them rather than rewrite.
function narrate(page, index) {
	const connector = CONNECTORS[index % CONNECTORS.length];
	const title = collapse(page.title);
	let desc = collapse(page.description || '');
	// Strip a leading "<Title> — " / "<Title>:" the description sometimes repeats,
	// so the guide doesn't say the name twice.
	const dup = new RegExp(`^${escapeRe(title)}\\s*[—:-]\\s*`, 'i');
	desc = desc.replace(dup, '');
	desc = ensureSentence(desc);
	return `${connector} ${ensureSentence(title).replace(/\.$/, '')}. ${desc}`.trim();
}

function collapse(s) {
	return String(s || '').replace(/\s+/g, ' ').trim();
}
function ensureSentence(s) {
	s = collapse(s);
	if (!s) return s;
	return /[.!?]$/.test(s) ? s : s + '.';
}
function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Words-per-minute for synthesized speech, plus per-stop overhead for the
// walk-in, the point gesture, and a beat to read the bubble.
const WPM = 150;
const STOP_OVERHEAD_S = 9;

// How many leading stops of each chapter belong to the "Quick highlights" track
// — heroes sort first (see orderSection), so the first few stops of a section
// are its clearest, most representative features. The Quick tour plays only
// these (plus every chapter's spoken intro), turning a ~30-minute full walk into
// a ~5-minute sampler that still touches every chapter.
const QUICK_PER_SECTION = 3;

function minutesFor(words, count) {
	return Math.round(words / WPM + (count * STOP_OVERHEAD_S) / 60);
}

function build() {
	const bySection = loadPages();
	const stops = [];
	const sections = [];
	let totalWords = 0;
	let quickWords = 0;
	let quickCount = 0;

	for (const id of SECTION_ORDER) {
		const entry = bySection.get(id);
		if (!entry) continue;
		const ordered = orderSection(id, entry.pages);
		sections.push({ id, title: entry.meta.title, intro: SECTION_INTROS[id] || '' });
		ordered.forEach((page, i) => {
			const isFirstOfSection = i === 0;
			const highlight = i < QUICK_PER_SECTION;
			const narration = narrate(page, stops.length);
			const introWords =
				isFirstOfSection && SECTION_INTROS[id]
					? SECTION_INTROS[id].split(/\s+/).length
					: 0;
			const stopWords = narration.split(/\s+/).length + introWords;
			totalWords += stopWords;
			if (highlight) {
				quickWords += stopWords;
				quickCount += 1;
			}
			stops.push({
				id: slug(page.path),
				path: page.path,
				section: id,
				title: collapse(page.title),
				narration,
				highlight,
				...(isFirstOfSection && SECTION_INTROS[id]
					? { sectionIntro: SECTION_INTROS[id] }
					: {}),
				...(TARGETS[page.path] ? { targets: TARGETS[page.path] } : {}),
			});
		});
	}

	const estimatedMinutes = minutesFor(totalWords, stops.length);
	const quickMinutes = Math.max(1, minutesFor(quickWords, quickCount));

	// Onboarding track — appended after the general sections so its stops
	// sort last in curriculum order, but it is its own section/track and is
	// excluded from 'full'/'quick' by buildPlaylist() (src/feature-tour/
	// curriculum.js) via `section === 'onboarding'`.
	sections.push({ id: 'onboarding', title: 'Getting started', intro: ONBOARDING_SECTION_INTRO });
	let onboardingWords = 0;
	ONBOARDING_STOPS.forEach((stop, i) => {
		const introWords = i === 0 ? ONBOARDING_SECTION_INTRO.split(/\s+/).length : 0;
		onboardingWords += stop.narration.split(/\s+/).length + introWords;
		stops.push({
			...stop,
			section: 'onboarding',
			...(i === 0 ? { sectionIntro: ONBOARDING_SECTION_INTRO } : {}),
		});
	});
	const onboardingMinutes = Math.max(1, minutesFor(onboardingWords, ONBOARDING_STOPS.length));

	return {
		version: 2,
		generatedAt: new Date().toISOString(),
		generatedBy: 'scripts/build-tour.mjs from data/pages.json',
		title: 'The three.ws Guided Tour',
		tagline: 'A 3D guide walks you through every feature, live, on the real site.',
		estimatedMinutes,
		stopCount: stops.length,
		tracks: [
			{
				id: 'full',
				title: 'Full tour',
				description: 'Every feature, chapter by chapter.',
				stopCount: stops.length - ONBOARDING_STOPS.length,
				estimatedMinutes,
			},
			{
				id: 'quick',
				title: 'Quick highlights',
				description: 'The best of every chapter, in a few minutes.',
				stopCount: quickCount,
				estimatedMinutes: quickMinutes,
			},
			{
				id: 'onboarding',
				title: 'Getting started',
				description: 'Avatar → world → markets → your profile, in about five minutes.',
				stopCount: ONBOARDING_STOPS.length,
				estimatedMinutes: onboardingMinutes,
			},
		],
		sections,
		stops,
	};
}

function slug(path) {
	return (
		path
			.replace(/^\/+/, '')
			.replace(/\/+$/, '')
			.replace(/[^a-z0-9]+/gi, '-')
			.toLowerCase() || 'home'
	);
}

function stable(obj) {
	// Stable stringify ignoring generatedAt so --check doesn't flap on timestamp.
	const clone = JSON.parse(JSON.stringify(obj));
	delete clone.generatedAt;
	return JSON.stringify(clone);
}

function main() {
	const check = process.argv.includes('--check');
	const next = build();

	if (check) {
		if (!existsSync(OUT_PATH)) {
			console.error('tour curriculum missing — run: node scripts/build-tour.mjs');
			process.exit(1);
		}
		const current = JSON.parse(readFileSync(OUT_PATH, 'utf8'));
		if (stable(current) !== stable(next)) {
			console.error('tour curriculum is stale — run: node scripts/build-tour.mjs');
			process.exit(1);
		}
		console.log(`tour curriculum OK — ${next.stopCount} stops, ~${next.estimatedMinutes} min`);
		return;
	}

	mkdirSync(dirname(OUT_PATH), { recursive: true });
	writeFileSync(OUT_PATH, JSON.stringify(next, null, '\t') + '\n');
	console.log(
		`Wrote ${OUT_PATH} — ${next.stopCount} stops across ${next.sections.length} chapters, ~${next.estimatedMinutes} min.`,
	);
}

main();
