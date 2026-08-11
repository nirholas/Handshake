// The package's front door: createFeatureTour() and the public export surface.
// ============================================================================
// Everything else in this suite tests an internal module directly. This file
// covers what a consumer actually imports: that `@three-ws/tour`'s documented
// exports exist, that the controller createFeatureTour() hands back has the
// shape the README promises, that the reported VERSION matches the published
// package, and that bootstrap()'s deep-link routing behaves without a tour
// having been constructed yet (the director stays lazy until a tour starts).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import * as pkgExports from '../src/index.js';
import { createFeatureTour, VERSION } from '../src/index.js';

const manifest = JSON.parse(
	readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
);

// Every name the README's "Also exported for advanced/standalone use" list
// promises, plus the primary entry point.
const DOCUMENTED_EXPORTS = [
	'createFeatureTour',
	'TourDirector',
	'ExploreMode',
	'resolveTourConfig',
	'buildCurriculum',
	'buildPlaylist',
	'trackMeta',
	'loadCurriculum',
	'createTourState',
	'stopIndexForPath',
	'sectionTitle',
	'normalizePath',
	'DEFAULT_VOICES',
	'DEFAULT_COPY',
	'VERSION',
];

const CURRICULUM = {
	tracks: [{ id: 'full', title: 'Full tour' }],
	sections: [{ id: 'main', title: 'Overview' }],
	stops: [{ path: '/', section: 'main', title: 'Home', narration: 'Hello.', highlight: true }],
};

let dom;

function mountDom(search = '') {
	dom = new JSDOM('<!doctype html><html><body><h1>Home</h1></body></html>', {
		url: `https://example.test/${search}`,
	});
	global.window = dom.window;
	global.document = dom.window.document;
	global.location = dom.window.location;
	global.sessionStorage = dom.window.sessionStorage;
	global.localStorage = dom.window.localStorage;
}

beforeAll(() => mountDom());
beforeEach(() => {
	dom.window.sessionStorage.clear();
	dom.window.localStorage.clear();
});
afterAll(() => {
	dom.window.close();
	delete global.window;
	delete global.document;
	delete global.location;
	delete global.sessionStorage;
	delete global.localStorage;
});

describe('public export surface', () => {
	it('exports every name the README documents', () => {
		for (const name of DOCUMENTED_EXPORTS) {
			expect(pkgExports, `missing export: ${name}`).toHaveProperty(name);
			expect(pkgExports[name], `undefined export: ${name}`).toBeDefined();
		}
	});

	it('reports the published package version', () => {
		expect(VERSION).toBe(manifest.version);
	});
});

describe('createFeatureTour', () => {
	it('returns the controller surface the README documents', () => {
		const tour = createFeatureTour({ curriculum: CURRICULUM });
		for (const method of ['start', 'startExplore', 'resume', 'exit', 'isActive', 'bootstrap']) {
			expect(typeof tour[method], `${method} should be callable`).toBe('function');
		}
		expect(tour.config).toBeTypeOf('object');
		// Both stay null until a tour starts: nothing heavy is built on create.
		expect(tour.director).toBeNull();
		expect(tour.explore).toBeNull();
	});

	it('resolves options through resolveTourConfig', () => {
		const tour = createFeatureTour({
			curriculum: CURRICULUM,
			deepLinkParam: 'walkthrough',
			storagePrefix: 'acme:tour',
			ttsEndpoint: '/api/tts/speak',
		});
		expect(tour.config.deepLinkParam).toBe('walkthrough');
		expect(tour.config.ttsEndpoint).toBe('/api/tts/speak');
		expect(tour.config.keys.state).toBe('acme:tour:state');
		expect(tour.config.guideAvatarId).toBe('realistic-female');
	});

	it('reads isActive() from stored session state', () => {
		const tour = createFeatureTour({ curriculum: CURRICULUM });
		expect(tour.isActive()).toBe(false);
		dom.window.sessionStorage.setItem(tour.config.keys.state, JSON.stringify({ active: true }));
		expect(tour.isActive()).toBe(true);
	});

	it('exit() is safe before anything has started', () => {
		const tour = createFeatureTour({ curriculum: CURRICULUM });
		expect(() => tour.exit()).not.toThrow();
		expect(tour.director).toBeNull();
	});
});

describe('bootstrap deep links', () => {
	it('does nothing on a page with no tour param and no stored tour', () => {
		mountDom();
		const tour = createFeatureTour({ curriculum: CURRICULUM });
		tour.bootstrap();
		expect(tour.director).toBeNull();
		expect(tour.isActive()).toBe(false);
	});

	it('?tour=0 tears an in-progress tour down without constructing a director', () => {
		mountDom('?tour=0');
		const tour = createFeatureTour({ curriculum: CURRICULUM });
		dom.window.sessionStorage.setItem(tour.config.keys.state, JSON.stringify({ active: true }));
		tour.bootstrap();
		expect(tour.director).toBeNull();
	});

	it('never auto-starts inside an embed/iframe', () => {
		mountDom('?tour=start');
		// A real nested browsing context, so window.top !== window.self the way it
		// is in an embed. The URL stays the framing page's (about:srcdoc carries no
		// query), which is what makes this the interesting case: the deep-link
		// param says "start" and the frame guard has to win anyway.
		const frame = dom.window.document.createElement('iframe');
		frame.srcdoc = '<!doctype html><html><body></body></html>';
		dom.window.document.body.appendChild(frame);
		global.window = frame.contentWindow;
		global.document = frame.contentWindow.document;
		expect(global.window.top).not.toBe(global.window.self);

		const tour = createFeatureTour({ curriculum: CURRICULUM });
		tour.bootstrap();
		expect(tour.director).toBeNull();
	});

	it('is a no-op with no window at all (SSR import)', () => {
		const saved = global.window;
		delete global.window;
		const tour = createFeatureTour({ curriculum: CURRICULUM });
		expect(() => tour.bootstrap()).not.toThrow();
		global.window = saved;
	});
});
