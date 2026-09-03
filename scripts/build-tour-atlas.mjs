#!/usr/bin/env node
// build-tour-atlas.mjs: publish data/tour-atlas.json to public/tour/atlas.json,
// which the /tour/atlas page fetches, and verify the atlas still describes the
// tour that actually exists.
//
// data/ is source and is never served, so the page cannot read the manifest
// directly. This mirrors the guards registry (scripts/build-guards.mjs) and the
// page index: the generated copy is committed so a clean checkout renders the
// page with no build step.
//
//   node scripts/build-tour-atlas.mjs           write public/tour/atlas.json
//   node scripts/build-tour-atlas.mjs --check   verify, write nothing, exit 1 on drift
//
// --check is the gate (`npm run audit:tour-atlas`) and it enforces four things:
//
//   1. the published copy matches the source byte for byte,
//   2. every curriculum stop has an atlas entry and vice versa, so a page added
//      to data/pages.json cannot land in the tour without ever being looked at,
//   3. every screenshot the manifest references exists on disk, and
//   4. no stop's spotlight anchor has rotted (anchor.state === 'missing') and no
//      stop's page is unreachable.
//
// Point 4 is the one that pays for the rest. The guided tour resolves its
// anchors with CSS selectors against pages other people redesign; before this
// existed, a redesign silently downgraded the stop to a whole-page dim and
// nothing anywhere noticed. Re-run `npm run tour:atlas` to refresh the capture,
// then fix whatever it reports.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'data/tour-atlas.json');
const OUT = path.join(root, 'public/tour/atlas.json');
const CURRICULUM = path.join(root, 'public/tour/curriculum.json');
const PUBLIC_DIR = path.join(root, 'public');

/** The exact bytes public/tour/atlas.json must contain for a given manifest. */
export function renderPublicAtlas(manifest) {
	return `${JSON.stringify(manifest, null, '\t')}\n`;
}

/**
 * The manifest summary, derived from the stops it describes.
 *
 * This lives here rather than in the capture script because both sides need it:
 * the capture writes it, and --check re-derives it to prove the committed
 * numbers still describe the committed stops. A summary that drifted from its
 * stops is not cosmetic, the page prints it as a headline stat ("264 stops")
 * directly above a grid that renders a different number.
 */
export function summarizeStops(stops) {
	const resolved = stops.filter((s) => s.anchor?.state === 'resolved');
	return {
		total: stops.length,
		anchored: resolved.length,
		missingAnchor: stops.filter((s) => s.anchor?.state === 'missing').length,
		// A curated anchor points at the feature the narration is about. A
		// fallback anchor points at whatever heading the page happens to have, so
		// the count is the size of the "this stop deserves a real anchor" backlog.
		curatedAnchor: resolved.filter((s) => s.anchor.source === 'curriculum').length,
		fallbackAnchor: resolved.filter((s) => s.anchor.source === 'fallback').length,
		navScopedAnchor: resolved.filter((s) => s.anchor.scope === 'nav').length,
		unreachable: stops.filter((s) => s.status >= 400 || s.status === 0).length,
		withConsoleErrors: stops.filter((s) => s.consoleErrors > 0).length,
		captured: stops.filter((s) => Boolean(s.media)).length,
	};
}

/**
 * Every reason the committed atlas would be lying, as plain strings.
 * Pure so tests can drive it with fixtures instead of the real files.
 */
export function atlasProblems(manifest, curriculum, mediaExists) {
	const problems = [];

	if (!manifest || !Array.isArray(manifest.stops) || !manifest.stops.length) {
		return ['data/tour-atlas.json has no stops. Run `npm run tour:atlas` to capture the tour.'];
	}

	const atlasIds = new Set(manifest.stops.map((s) => s.id));
	const tourIds = new Set(curriculum.stops.map((s) => s.id));

	for (const stop of curriculum.stops) {
		if (!atlasIds.has(stop.id)) {
			problems.push(
				`tour stop "${stop.id}" (${stop.path}) has no atlas entry. Run: npm run tour:atlas -- --only ${stop.id}`,
			);
		}
	}
	for (const stop of manifest.stops) {
		if (!tourIds.has(stop.id)) {
			problems.push(`atlas entry "${stop.id}" is not in the curriculum any more. Re-run: npm run tour:atlas`);
		}
	}

	// A stop's index is its position in the curriculum, and the page prints it as
	// the stop number on every card and in the lightbox ("stop 12 of 263"). A
	// partial capture used to merge freshly numbered stops with stops numbered
	// against an older curriculum, which shipped duplicate and skipped numbers.
	const order = new Map(curriculum.stops.map((s, i) => [s.id, i]));
	const misnumbered = manifest.stops.filter((s) => order.has(s.id) && s.index !== order.get(s.id));
	if (misnumbered.length) {
		problems.push(
			`${misnumbered.length} atlas stop(s) carry a stale index, so /tour/atlas renders duplicate stop ` +
				`numbers and an out-of-order grid (first: "${misnumbered[0].id}" is numbered ` +
				`${misnumbered[0].index} but sits at ${order.get(misnumbered[0].id)}). Re-run: npm run tour:atlas`,
		);
	}

	// The headline stats on /tour/atlas come straight from summary, so a summary
	// that no longer describes the stops is a visible lie on the page.
	const expected = summarizeStops(manifest.stops);
	const drifted = Object.keys(expected).filter((k) => manifest.summary?.[k] !== expected[k]);
	if (drifted.length) {
		problems.push(
			`the atlas summary no longer matches its stops (${drifted
				.map((k) => `${k}: ${manifest.summary?.[k]} should be ${expected[k]}`)
				.join(', ')}). Re-run: npm run tour:atlas`,
		);
	}

	for (const stop of manifest.stops) {
		if (stop.status === 0 || stop.status >= 400) {
			problems.push(
				`tour stop "${stop.id}" points at ${stop.path}, which answered ${stop.status || 'nothing'}. ` +
					`Fix the page or drop the stop from scripts/build-tour.mjs.`,
			);
			continue;
		}
		if (stop.anchor?.state === 'missing') {
			problems.push(
				`tour stop "${stop.id}" (${stop.path}) has no working spotlight anchor, so the guide dims the ` +
					`whole page instead of pointing at anything. Give it a selector in scripts/build-tour.mjs (TARGETS).`,
			);
		}
		for (const key of ['hero', 'thumb', 'mobile']) {
			const media = stop.media?.[key];
			if (media && !mediaExists(media.url)) {
				problems.push(`tour stop "${stop.id}" references ${media.url}, which is not on disk.`);
			}
		}
	}

	return problems;
}

function main() {
	const check = process.argv.includes('--check');

	if (!existsSync(SRC)) {
		console.error(
			'data/tour-atlas.json is missing. Capture the tour first: npm run tour:atlas',
		);
		process.exit(1);
	}
	const manifest = JSON.parse(readFileSync(SRC, 'utf8'));
	const curriculum = JSON.parse(readFileSync(CURRICULUM, 'utf8'));
	const body = renderPublicAtlas(manifest);

	if (!check) {
		mkdirSync(path.dirname(OUT), { recursive: true });
		writeFileSync(OUT, body);
		const s = manifest.summary;
		console.log(
			`build-tour-atlas: wrote public/tour/atlas.json (${s.total} stops, ${s.captured} screenshots, ` +
				`${s.curatedAnchor} curated anchors).`,
		);
		return;
	}

	const problems = [];
	if (!existsSync(OUT)) {
		problems.push('public/tour/atlas.json is missing. Run: npm run build:tour-atlas');
	} else if (readFileSync(OUT, 'utf8') !== body) {
		problems.push(
			'public/tour/atlas.json is stale: it does not match data/tour-atlas.json. Run: npm run build:tour-atlas',
		);
	}
	problems.push(
		...atlasProblems(manifest, curriculum, (url) => existsSync(path.join(PUBLIC_DIR, url.replace(/^\//, '')))),
	);

	if (problems.length) {
		console.error(`audit:tour-atlas found ${problems.length} problem(s):\n`);
		for (const p of problems) console.error(`  - ${p}`);
		process.exit(1);
	}

	const s = manifest.summary;
	console.log(
		`audit:tour-atlas: ${s.total} stops, all anchored and photographed ` +
			`(${s.curatedAnchor} curated, ${s.fallbackAnchor} generic).`,
	);
}

// Only run when invoked directly, so tests can import the pure helpers above.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
