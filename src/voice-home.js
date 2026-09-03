/**
 * /voice/home: the hands-free voice loop, mounted on its own surface.
 *
 * The panel here is the same HomeVoicePanel that /home/:id mounts over the live
 * 3D house. Keeping one component and two hosts is what stops the voice path and
 * the scene path from drifting into two different confirmation flows, which is
 * the exact failure that ends with a door opening on a "yeah".
 *
 * The state gallery below is not a mockup. It builds twelve real panels over
 * twelve real loops and drives each into one state through the same code path
 * the live loop uses, so what is rendered is what a user gets. No microphone is
 * opened for any of them, and no model is downloaded.
 */

import { HomeVoiceLoop, STATES, STATE_ORDER, normalizePendingConfirmation } from './voice/home-voice.js';
import { HomeVoicePanel } from './voice/home-voice-ui.js';
import { disclosurePanel } from './home/disclosure-panel.js';
import { log } from './shared/log.js';

const params = new URLSearchParams(location.search);

const loop = new HomeVoiceLoop({
	// /home/:id passes the real connection. On this surface the home is optional:
	// the loop is fully exercisable without one, and every leg except the device
	// action is measured either way.
	homeId: params.get('home'),
	surface: params.get('surface') === 'screenless' ? 'screenless' : 'display',
	onEvent: (event) => {
		if (event.type === 'latency') log.info('[voice-home]', event.leg, event.ms + 'ms');
	},
});

// The disclosure goes in before anything else runs, so it is on screen whether
// or not speech recognition turns out to be available in this browser: the
// promise about a microphone is exactly as relevant to somebody who is deciding
// whether to try as to somebody who already has.
const disclosureMount = document.getElementById('voice-disclosure');
if (disclosureMount) disclosureMount.append(disclosurePanel('home.voice'));

const mount = document.getElementById('voice-panel');
const panel = new HomeVoicePanel({ mount, loop });

// Probe before anything claims to listen. A deployment without a speech lane
// lands in the unavailable state and says so, rather than lighting an indicator.
void loop.probeAsr();

// Exposed so a browser check and the /home scene can read the measured legs
// without scraping the DOM.
window.homeVoice = { loop, panel };

// ── the state gallery ───────────────────────────────────────────────────────

const SAMPLE_CONFIRMATION = normalizePendingConfirmation({
	home: { id: 'preview', label: 'Preview' },
	confirmation: {
		id: 'preview',
		summary: 'This will unlock the Front Door.',
		risk: 'opens the house',
		domain: 'lock',
		service: 'unlock',
		entity_ids: ['lock.front_door'],
		entities: [{ entity_id: 'lock.front_door', name: 'Front Door', state: 'locked' }],
		expires_in_seconds: 90,
	},
});

const DETAILS = {
	[STATES.PERMISSION_DENIED]: {
		recovery: 'Chrome: click the icon at the left of the address bar, set Microphone to Allow, then reload this page.',
	},
	[STATES.CONFIRM_PENDING]: { confirmation: SAMPLE_CONFIRMATION },
	[STATES.UNAVAILABLE]: {
		reason:
			'Speech recognition is not available in this deployment, so the microphone stays off. ' +
			'Type to the agent instead: everything voice can do, text can do.',
	},
	[STATES.ERROR]: {
		message: 'Speech recognition failed: 503 upstream unavailable. Say it again, or type it.',
		retryable: true,
	},
	[STATES.IDLE]: { wakeWord: 'hey_jarvis' },
	[STATES.CAPTURING]: { wakeWord: 'hey_jarvis', score: 0.99 },
	[STATES.SPEAKING]: { text: 'The kitchen light is off.' },
	[STATES.MUTED]: { tracks: ['ended'] },
};

const gallery = document.getElementById('state-gallery');
for (const state of STATE_ORDER) {
	const wrap = document.createElement('section');
	wrap.className = 'vh-state';
	const heading = document.createElement('h3');
	heading.textContent = state;
	const host = document.createElement('div');
	wrap.append(heading, host);
	gallery.appendChild(wrap);

	const previewLoop = new HomeVoiceLoop({ surface: 'display' });
	const previewPanel = new HomeVoicePanel({ mount: host, loop: previewLoop });
	if (state === STATES.CONFIRM_PENDING) previewLoop.pendingConfirmation = SAMPLE_CONFIRMATION;
	previewLoop._setState(state, DETAILS[state] || {});
	// Keep a reference so the panels are not collected while their timers run.
	wrap._panel = previewPanel;
}
