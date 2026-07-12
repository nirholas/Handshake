// index.js — public surface for the Feature Tour. Creates a single director,
// exposes a small control object (the nav button and the /tour page drive the
// tour through it), and a bootstrap() that honors the ?tour= deep-link and
// re-hydrates an in-progress tour on every page load. Side-effect free on
// import: nothing mounts until bootstrap()/start() runs.

import { TourDirector } from './director.js';
import { ExploreMode } from './explore.js';
import { readState, loadCurriculum } from './curriculum.js';

export function createFeatureTour() {
	let director = null;
	let explore = null;
	const ensure = () => (director ||= new TourDirector());

	// Opt-in interactive mode: the visitor drives the guide with arrow keys /
	// joystick to glowing GTA-style checkpoints. Additive — the default guided
	// tour is unchanged; this only runs when explicitly started. `movement`
	// picks the starting locomotion: 'stroll' (default) or 'platformer'
	// (gravity + jumping on the page's real DOM); M switches live either way.
	async function startExplore(movement = 'stroll') {
		if (explore?.isActive()) return;
		const curriculum = await loadCurriculum();
		explore = new ExploreMode(curriculum, movement);
		return explore.start();
	}

	const control = {
		get director() {
			return director;
		},
		get explore() {
			return explore;
		},
		isActive() {
			return explore?.isActive() === true || readState().active === true;
		},
		start(track) {
			return ensure().start(track);
		},
		startExplore,
		resume() {
			return ensure().resume();
		},
		exit() {
			explore?.exit();
			director?.exit();
		},
		// Replicates the companion's auto-mount/deep-link behaviour. Safe to call
		// once on load. `?tour=start|1` begins or resumes; an already-active tour
		// rehydrates silently.
		bootstrap() {
			if (typeof window === 'undefined') return;
			if (window.top !== window.self) return; // never inside an embed/iframe
			const params = new URLSearchParams(location.search);
			const param = params.get('tour');
			if (param === 'start') {
				const mode = params.get('mode');
				if (mode === 'explore' || mode === 'platformer') startExplore(mode === 'platformer' ? 'platformer' : 'stroll');
				else {
					const requestedTrack = params.get('track');
					const track =
						requestedTrack === 'quick' || requestedTrack === 'onboarding' ? requestedTrack : 'full';
					ensure().start(track);
				}
			} else if (param === '0') {
				control.exit();
			} else if (param === '1' || readState().active) {
				ensure().resume();
			}
		},
	};

	return control;
}
