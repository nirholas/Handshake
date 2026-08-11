// @three-ws/tour — a 3D guide that walks your live site and narrates it.
// =====================================================================
// A small avatar walks across the real page, spotlights each feature, points at
// it with a beam, and speaks a line about it — a guided product tour that runs
// on your actual DOM, not a slideshow. It survives full-page navigation (state
// in sessionStorage), offers Quick/Full tracks, a searchable chapter map, free
// roam, and adjustable voice/speed. `three` and `@three-ws/walk` are peer
// dependencies — bring your own copies.
//
// Quick start (auto-mount + deep-link, app-style):
//
//   import { createFeatureTour } from '@three-ws/tour';
//   const tour = createFeatureTour({
//     curriculum: '/tour/curriculum.json',   // or an inline object
//     ttsEndpoint: '/api/tts/speak',         // optional — captions pace without it
//   });
//   window.__featureTour = tour;             // let your nav button call it
//   tour.bootstrap();                        // honour ?tour=… and rehydrate
//
// Or drive it yourself:
//
//   const tour = createFeatureTour();
//   tour.start('quick');   // begin the Quick-highlights track
//   tour.resume();         // pick up an in-progress tour after a navigation
//   tour.exit();           // tear everything down

import { TourDirector } from './director.js';
import { ExploreMode } from './explore.js';
import { resolveTourConfig } from './config.js';
import { createTourState, loadCurriculum } from './curriculum.js';

// Kept in lockstep with package.json's version by test/index.test.mjs — the
// CDN bundle reports this string, so a stale constant misidentifies the build.
export const VERSION = '0.5.1';

/**
 * Create a tour controller. Returns a small object the host drives:
 * `start(track)`, `resume()`, `exit()`, `isActive()`, `bootstrap()`, plus the
 * live `director` once one exists.
 *
 * @param {object} [options] see resolveTourConfig for the full option list.
 */
export function createFeatureTour(options = {}) {
	const config = resolveTourConfig(options);
	const state = createTourState(config);
	let director = null;
	let explore = null;
	const ensure = () => (director ||= new TourDirector(config));
	// 'platformer' is explore with the platformer movement model.
	const exploreConfigured = () => config.mode === 'explore' || config.mode === 'platformer';

	// In explore/platformer mode, start() drives the checkpoint experience
	// instead of the guided auto-tour — so the same nav button, ?tour deep link,
	// and autostart all route to whichever mode the host configured.
	async function startExplore() {
		if (explore?.isActive()) return;
		const curriculum =
			config.curriculum && typeof config.curriculum === 'object'
				? config.curriculum
				: await loadCurriculum(config);
		explore = new ExploreMode(config, curriculum);
		return explore.start();
	}

	const control = {
		get director() {
			return director;
		},
		get explore() {
			return explore;
		},
		get config() {
			return config;
		},
		isActive() {
			return explore?.isActive() === true || state.readState().active === true;
		},
		start(track) {
			if (exploreConfigured()) return startExplore();
			return ensure().start(track);
		},
		startExplore,
		resume() {
			if (exploreConfigured()) return startExplore();
			return ensure().resume();
		},
		exit() {
			explore?.exit();
			director?.exit();
		},
		// Auto-mount / deep-link behaviour. Safe to call once on load. With the
		// default deepLinkParam 'tour': `?tour=start` begins (optionally
		// `&track=quick`), `?tour=0` exits, `?tour=1` (or an already-active tour)
		// resumes. Never runs inside an embed/iframe.
		bootstrap() {
			if (typeof window === 'undefined') return;
			if (window.top !== window.self) return; // never inside an embed/iframe
			const params = new URLSearchParams(location.search);
			const param = params.get(config.deepLinkParam);
			if (param === 'start') {
				if (exploreConfigured()) startExplore();
				else ensure().start(params.get('track') === 'quick' ? 'quick' : 'full');
			} else if (param === '0') {
				control.exit();
			} else if (param === '1' || (!exploreConfigured() && state.readState().active)) {
				control.resume();
			}
		},
	};

	return control;
}

// Engine internals, exported for advanced/standalone use.
export { TourDirector } from './director.js';
export { ExploreMode } from './explore.js';
export { resolveTourConfig, DEFAULT_VOICES, DEFAULT_COPY } from './config.js';
export {
	loadCurriculum,
	createTourState,
	buildPlaylist,
	trackMeta,
	stopIndexForPath,
	sectionTitle,
	normalizePath,
} from './curriculum.js';

// Curriculum authoring helper — turn a pages document into a tour curriculum.
export { buildCurriculum } from './build-curriculum.js';
