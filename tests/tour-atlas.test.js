/**
 * Tour Atlas: unit tests.
 *
 * The atlas (scripts/capture-tour-atlas.mjs, /tour/atlas) is a report about the
 * guided tour, so its value rests entirely on it resolving spotlight anchors the
 * same way the live tour does. Three things are pinned here:
 *
 *   1. TourDirector._resolveTarget() prefers the page's main content over the
 *      site chrome. This is the bug the atlas found on its first run: an
 *      unscoped querySelector handed a broad curriculum selector to the nav,
 *      which renders before <main> on every page, so `/` spotlit the nav's
 *      "Create an agent" link instead of the hero CTA.
 *   2. start(track, stopId) begins at a named stop, which is the contract every
 *      atlas card links against (/<path>?tour=start&stop=<id>).
 *   3. atlasProblems() fails on exactly the states that make the atlas a lie:
 *      a missing entry, a stale entry, a dead page, a rotted anchor, absent media.
 */

import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { atlasProblems, renderPublicAtlas } from '../scripts/build-tour-atlas.mjs';
import {
	TOUR_FALLBACK_SELECTORS,
	TOUR_CONTENT_ROOT_SELECTOR,
} from '../src/feature-tour/curriculum.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let TourDirector;
let dom;

beforeAll(async () => {
	dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
	global.window = dom.window;
	global.document = dom.window.document;
	global.location = dom.window.location;
	global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
	global.Node = dom.window.Node;
	global.localStorage = dom.window.localStorage;
	global.sessionStorage = dom.window.sessionStorage;
	global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
	global.cancelAnimationFrame = (id) => clearTimeout(id);
	global.matchMedia = (q) => ({
		matches: false,
		media: q,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
	});
	dom.window.matchMedia = global.matchMedia;
	({ TourDirector } = await import('../src/feature-tour/director.js'));
});

afterEach(() => {
	document.body.innerHTML = '';
});

// jsdom reports every element as zero-size, and the director's isVisible() gate
// rejects anything under 4x4. Give every element a real box so the selector
// logic (the thing under test) is what decides, not jsdom's layout stub.
function makeEverythingVisible() {
	dom.window.Element.prototype.getBoundingClientRect = function () {
		return { width: 200, height: 40, top: 10, left: 10, right: 210, bottom: 50, x: 10, y: 10 };
	};
	// jsdom also computes no styles (opacity comes back ''), which reads as 0.
	global.getComputedStyle = () => ({ visibility: 'visible', display: 'block', opacity: '1' });
}

describe('TourDirector._resolveTarget content scoping', () => {
	beforeAll(() => makeEverythingVisible());

	it('prefers a match inside main over an identical one in the site nav', () => {
		document.body.innerHTML = `
			<header><nav><a href="/create-agent" id="nav-link">Create an agent</a></nav></header>
			<main><a href="/create-agent" id="hero-cta" class="cta">Build your agent</a></main>`;
		const director = new TourDirector();
		const el = director._resolveTarget({ targets: ['a[href="/create-agent"], .hero a.cta'] });
		expect(el?.id).toBe('hero-cta');
	});

	it('still resolves a chrome-only feature when nothing in main matches', () => {
		document.body.innerHTML = `
			<header><nav><button id="wallet-btn" type="submit">Connect wallet</button></nav></header>
			<main><p>No button in here.</p></main>`;
		const director = new TourDirector();
		const el = director._resolveTarget({ targets: ['button[type="submit"]'] });
		expect(el?.id).toBe('wallet-btn');
	});

	it('falls back to the shared generic chain when a stop has no curated targets', () => {
		document.body.innerHTML = '<main><h1 id="page-h1">Embodied</h1></main>';
		const director = new TourDirector();
		const el = director._resolveTarget({});
		expect(el?.id).toBe('page-h1');
		// The chain the atlas replays offline is the same object the director uses.
		expect(TOUR_FALLBACK_SELECTORS).toContain('main h1, .hero h1, h1');
		expect(TOUR_CONTENT_ROOT_SELECTOR).toContain('main');
	});

	it('returns null rather than ringing something invisible', () => {
		document.body.innerHTML = '<main><p>Nothing anchorable.</p></main>';
		const director = new TourDirector();
		expect(director._resolveTarget({ targets: ['.does-not-exist'] })).toBeNull();
	});

	it('skips an unparseable selector instead of throwing', () => {
		document.body.innerHTML = '<main><h1 id="page-h1">Title</h1></main>';
		const director = new TourDirector();
		expect(director._resolveTarget({ targets: ['a[href=='] })?.id).toBe('page-h1');
	});
});

describe('TourDirector.start(track, stopId)', () => {
	const curriculum = {
		version: 2,
		stops: [
			{ id: 'home', path: '/', section: 'main', title: 'Home', narration: 'a' },
			{ id: 'forge', path: '/forge', section: 'build', title: 'Forge', narration: 'b', highlight: true },
			{ id: 'onb-1', path: '/create', section: 'onboarding', title: 'Start', narration: 'c' },
		],
		tracks: [{ id: 'full' }, { id: 'quick' }, { id: 'onboarding' }],
		sections: [],
	};

	function stubbedDirector() {
		const director = new TourDirector();
		director.curriculum = curriculum;
		director._ensureCurriculum = async () => curriculum;
		director._showLoading = () => {};
		director._mount = async () => {};
		director._runCurrent = () => {};
		director._reportOnboardingProgress = () => {};
		director.navigatedTo = null;
		director._navigate = (path) => {
			director.navigatedTo = path;
		};
		return director;
	}

	it('starts at the named stop and navigates to its page', async () => {
		const director = stubbedDirector();
		await director.start('full', 'forge');
		expect(director.index).toBe(1);
		expect(director.navigatedTo).toBe('/forge');
	});

	it('switches to the track that contains a stop outside the requested one', async () => {
		const director = stubbedDirector();
		await director.start('full', 'onb-1');
		expect(director.track).toBe('onboarding');
		expect(director.index).toBe(2);
	});

	it('ignores an unknown stop id instead of dead-ending the tour', async () => {
		const director = stubbedDirector();
		await director.start('full', 'no-such-stop');
		expect(director.index).toBe(0);
		expect(director.navigatedTo).toBeNull(); // already on '/'
	});
});

describe('atlasProblems()', () => {
	const curriculum = {
		stops: [
			{ id: 'home', path: '/' },
			{ id: 'forge', path: '/forge' },
		],
	};
	const healthy = {
		stops: [
			{
				id: 'home',
				path: '/',
				status: 200,
				anchor: { state: 'resolved', source: 'curriculum' },
				media: { hero: { url: '/media/tour/home.webp' }, thumb: { url: '/media/tour/home.thumb.webp' } },
			},
			{
				id: 'forge',
				path: '/forge',
				status: 200,
				anchor: { state: 'resolved', source: 'fallback' },
				media: { hero: { url: '/media/tour/forge.webp' }, thumb: { url: '/media/tour/forge.thumb.webp' } },
			},
		],
	};
	const allMediaPresent = () => true;

	it('passes a manifest that covers the curriculum with live anchors', () => {
		expect(atlasProblems(healthy, curriculum, allMediaPresent)).toEqual([]);
	});

	it('flags a curriculum stop with no atlas entry', () => {
		const partial = { stops: [healthy.stops[0]] };
		const problems = atlasProblems(partial, curriculum, allMediaPresent);
		expect(problems.join('\n')).toContain('"forge"');
	});

	it('flags an atlas entry for a stop that left the curriculum', () => {
		const extra = {
			stops: [
				...healthy.stops,
				{ id: 'retired', path: '/retired', status: 200, anchor: { state: 'resolved' } },
			],
		};
		expect(atlasProblems(extra, curriculum, allMediaPresent).join('\n')).toContain('"retired"');
	});

	it('flags a rotted spotlight anchor, which is the whole point of the guard', () => {
		const rotted = JSON.parse(JSON.stringify(healthy));
		rotted.stops[1].anchor = { state: 'missing', source: null };
		const problems = atlasProblems(rotted, curriculum, allMediaPresent);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('no working spotlight anchor');
	});

	it('flags a stop whose page stopped responding, and does not also blame its anchor', () => {
		const dead = JSON.parse(JSON.stringify(healthy));
		dead.stops[1].status = 404;
		dead.stops[1].anchor = { state: 'missing' };
		const problems = atlasProblems(dead, curriculum, allMediaPresent);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('answered 404');
	});

	it('flags a screenshot the manifest promises but disk does not have', () => {
		const problems = atlasProblems(healthy, curriculum, (url) => !url.endsWith('forge.webp'));
		expect(problems.join('\n')).toContain('/media/tour/forge.webp');
	});

	it('treats an empty manifest as a single actionable problem', () => {
		expect(atlasProblems({ stops: [] }, curriculum, allMediaPresent)).toHaveLength(1);
	});
});

describe('the committed atlas', () => {
	it('is published to public/tour/atlas.json byte for byte', () => {
		const src = JSON.parse(readFileSync(resolve(ROOT, 'data/tour-atlas.json'), 'utf8'));
		const published = readFileSync(resolve(ROOT, 'public/tour/atlas.json'), 'utf8');
		expect(published).toBe(renderPublicAtlas(src));
	});

	it('covers every stop the curriculum ships', () => {
		const atlas = JSON.parse(readFileSync(resolve(ROOT, 'data/tour-atlas.json'), 'utf8'));
		const curriculum = JSON.parse(readFileSync(resolve(ROOT, 'public/tour/curriculum.json'), 'utf8'));
		expect(atlas.stops.map((s) => s.id).sort()).toEqual(curriculum.stops.map((s) => s.id).sort());
	});
});
