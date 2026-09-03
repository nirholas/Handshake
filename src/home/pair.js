/**
 * Connecting a home that only exists on your network.
 *
 * The rest of /smart-home assumes a house three.ws can dial. Most cannot be
 * dialled at all: they live on a LAN behind a router, and no amount of waiting
 * changes that. For those, the house dials us. This module is the whole of that
 * flow on the browser side, and it is the reach multiplier for the entire
 * feature, so every state it can be in is drawn rather than implied.
 *
 * The seven states, each with its own treatment:
 *
 *   1. NOT_INSTALLED  the two ways to install the integration, HACS and manual
 *   2. PAIRING        the code, and a countdown that is honest about the clock
 *   3. LINKED         the house dialled in; from here it is an ordinary home
 *   4. AGENT_OFFLINE  the integration is not running, and it recovers by itself
 *   5. TOO_OLD        the integration is behind the relay protocol
 *   6. CODE_DEAD      the code expired or was already used, with one button back
 *   7. REVOKED        disconnected from either end
 *
 * The countdown is deliberately not a fake progress bar: it counts a real
 * expiry the server minted, and when it reaches zero the code really is dead,
 * so the UI moves to state 6 rather than pretending.
 */

import { HomeApiError, pairingStatus, refreshPairing, startPairing } from './api.js';
import { clear, el, noticeEl } from './connect.js';

/** The states this flow can be in. Nothing falls through to a default. */
export const PAIR_STATE = Object.freeze({
	NOT_INSTALLED: 'not_installed',
	PAIRING: 'pairing',
	LINKED: 'linked',
	AGENT_OFFLINE: 'agent_offline',
	TOO_OLD: 'too_old',
	CODE_DEAD: 'code_dead',
	REVOKED: 'revoked',
	UNAVAILABLE: 'unavailable',
});

const HACS_REPO = 'https://github.com/nirholas/three-ws-home-assistant';
const ADD_PATH = 'Settings, Devices and services, Add integration, three.ws';

/** How often the page asks whether the house has arrived. */
const POLL_MS = 3000;

/**
 * Mount the pairing flow into a container.
 *
 * @param {object} options
 * @param {HTMLElement} options.mount
 * @param {() => void} [options.onCancel] back to the dial-a-URL card
 * @param {(home: object) => void} [options.onLinked] the house arrived
 * @returns {{ destroy: () => void }}
 */
export function renderPairing({ mount, onCancel, onLinked } = {}) {
	let timer = null;
	let tick = null;
	let destroyed = false;
	let current = null;

	const stop = () => {
		if (timer) clearTimeout(timer);
		if (tick) clearInterval(tick);
		timer = null;
		tick = null;
	};

	const destroy = () => {
		destroyed = true;
		stop();
	};

	function show(state, data = {}) {
		if (destroyed) return;
		stop();
		clear(mount);
		mount.append(panelFor(state, data));
	}

	function panelFor(state, data) {
		switch (state) {
			case PAIR_STATE.NOT_INSTALLED:
				return installPanel(data);
			case PAIR_STATE.PAIRING:
				return pairingPanel(data);
			case PAIR_STATE.LINKED:
				return linkedPanel(data);
			case PAIR_STATE.AGENT_OFFLINE:
				return offlinePanel(data);
			case PAIR_STATE.TOO_OLD:
				return tooOldPanel(data);
			case PAIR_STATE.CODE_DEAD:
				return codeDeadPanel(data);
			case PAIR_STATE.REVOKED:
				return revokedPanel(data);
			default:
				return unavailablePanel(data);
		}
	}

	// ── State 1: the integration is not installed yet ──────────────────────────

	function installPanel({ notice } = {}) {
		const panel = el('section', 'hm-panel');
		panel.append(
			el('p', 'hm-eyebrow', 'For a home that is only on your network'),
			el('h2', 'hm-panel-title', 'Your house connects to three.ws, not the other way round'),
			el(
				'p',
				'hm-panel-sub',
				'Install one small integration inside Home Assistant. It opens a single outgoing connection to three.ws and keeps it. Nothing listens on your network, no port is forwarded, and three.ws never receives a Home Assistant token.',
			),
		);
		if (notice) panel.append(noticeEl(notice));

		panel.append(el('h3', 'hm-label', 'Through HACS, the usual way'));
		const hacs = el('ol', 'hm-ol');
		for (const line of [
			'In Home Assistant, open HACS.',
			'Custom repositories, add this address, category Integration.',
			'Install three.ws, then restart Home Assistant.',
			`Then ${ADD_PATH}.`,
		]) hacs.append(el('li', '', line));
		panel.append(hacs, repoLine());

		const details = el('details', 'hm-details');
		details.append(el('summary', 'hm-link', 'Or install it by hand'));
		const manual = el('ol', 'hm-ol');
		for (const line of [
			'Download the latest release from the repository above.',
			'Copy custom_components/three_ws into your Home Assistant config folder.',
			'Restart Home Assistant.',
			`Then ${ADD_PATH}.`,
		]) manual.append(el('li', '', line));
		details.append(manual);
		panel.append(details);

		const actions = el('div', 'hm-actions');
		const go = el('button', 'hm-btn hm-btn-primary', 'I have it installed, show me a code');
		go.type = 'button';
		go.addEventListener('click', () => begin());
		actions.append(go);
		if (onCancel) {
			const back = el('button', 'hm-btn hm-btn-ghost', 'My home has a web address instead');
			back.type = 'button';
			back.addEventListener('click', () => {
				destroy();
				onCancel();
			});
			actions.append(back);
		}
		panel.append(actions);
		return panel;
	}

	function repoLine() {
		const wrap = el('p', 'hm-hint');
		const link = el('a', 'hm-link hm-mono', HACS_REPO);
		link.href = HACS_REPO;
		link.rel = 'noopener';
		link.target = '_blank';
		wrap.append(link);
		return wrap;
	}

	// ── State 2: the code, and a real countdown ────────────────────────────────

	function pairingPanel({ home, code, expiresAt }) {
		const panel = el('section', 'hm-panel');
		panel.append(
			el('p', 'hm-eyebrow', 'Step 2 of 2'),
			el('h2', 'hm-panel-title', 'Type this code into Home Assistant'),
			el('p', 'hm-panel-sub', `In Home Assistant: ${ADD_PATH}. Paste the code there.`),
		);

		const codeBox = el('div', 'hm-paircode');
		codeBox.setAttribute('role', 'group');
		codeBox.setAttribute('aria-label', 'Your pairing code');
		const value = el('output', 'hm-paircode-value', code);
		value.setAttribute('aria-live', 'polite');
		codeBox.append(value);

		const copy = el('button', 'hm-btn hm-btn-ghost hm-paircode-copy', 'Copy');
		copy.type = 'button';
		copy.addEventListener('click', async () => {
			try {
				await navigator.clipboard.writeText(code);
				copy.textContent = 'Copied';
				setTimeout(() => {
					copy.textContent = 'Copy';
				}, 1600);
			} catch {
				// A browser that refuses the clipboard is not an error state: the
				// code is on screen and can be typed, which is the normal path.
				copy.textContent = 'Select it above';
			}
		});
		codeBox.append(copy);
		panel.append(codeBox);

		const countdown = el('p', 'hm-hint');
		countdown.setAttribute('aria-live', 'polite');
		panel.append(countdown);

		const waiting = el('p', 'hm-live', 'Waiting for your home to connect');
		panel.append(waiting);

		const actions = el('div', 'hm-actions');
		const cancel = el('button', 'hm-btn hm-btn-ghost', 'Back');
		cancel.type = 'button';
		cancel.addEventListener('click', () => show(PAIR_STATE.NOT_INSTALLED));
		actions.append(cancel);
		panel.append(actions);

		const deadline = new Date(expiresAt).getTime();
		const paint = () => {
			const left = Math.max(0, deadline - Date.now());
			if (left === 0) {
				stop();
				show(PAIR_STATE.CODE_DEAD, { home, reason: 'expired' });
				return;
			}
			const seconds = Math.round(left / 1000);
			countdown.textContent = `This code works once and expires in ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}.`;
		};
		paint();
		tick = setInterval(paint, 1000);
		poll(home);
		return panel;
	}

	// ── State 3: linked ────────────────────────────────────────────────────────

	function linkedPanel({ home }) {
		const panel = el('section', 'hm-panel');
		panel.append(
			el('h2', 'hm-panel-title', `${home.label} is connected`),
			el(
				'p',
				'hm-panel-sub',
				'From here it behaves exactly like any other connected home: the same rooms, the same scenes, and the same rule that unlocking, opening and disarming always ask a person first.',
			),
			noticeEl({
				tone: 'ok',
				title: 'three.ws holds no key to this house.',
				body: 'The integration signs in to Home Assistant on your own machine. There is no Home Assistant token stored against your three.ws account for this home, so there is nothing here for a breach to take.',
			}),
		);
		const actions = el('div', 'hm-actions');
		const go = el('a', 'hm-btn hm-btn-primary', 'Open this home');
		go.href = `/smart-home/${encodeURIComponent(home.id)}`;
		actions.append(go);
		panel.append(actions);
		if (onLinked) onLinked(home);
		return panel;
	}

	// ── State 4: the integration is not running ───────────────────────────────

	function offlinePanel({ home }) {
		const panel = el('section', 'hm-panel');
		panel.append(
			el('h2', 'hm-panel-title', `${home.label} is not answering`),
			noticeEl({
				tone: 'warn',
				title: 'The three.ws integration in this home is offline.',
				body: 'That normally means Home Assistant is restarting or the machine it runs on is off. Nothing is broken and there is nothing to re-pair: it dials back in on its own within a minute of coming back.',
			}),
		);
		const live = el('p', 'hm-live', 'Watching for it to come back');
		panel.append(live);
		const actions = el('div', 'hm-actions');
		const again = el('button', 'hm-btn hm-btn-ghost', 'Check now');
		again.type = 'button';
		again.addEventListener('click', () => poll(home, { immediate: true }));
		actions.append(again);
		panel.append(actions);
		poll(home);
		return panel;
	}

	// ── State 5: the integration is too old ───────────────────────────────────

	function tooOldPanel({ home, detail }) {
		const panel = el('section', 'hm-panel');
		panel.append(
			el('h2', 'hm-panel-title', 'This home needs a newer three.ws integration'),
			noticeEl({
				tone: 'warn',
				title: 'The integration installed in this home is older than the relay it is talking to.',
				body: detail || 'Open HACS in Home Assistant, update three.ws, and restart. Nothing else has to be redone: the pairing survives an update.',
			}),
		);
		panel.append(repoLine());
		const actions = el('div', 'hm-actions');
		const again = el('button', 'hm-btn hm-btn-primary', 'I have updated it');
		again.type = 'button';
		again.addEventListener('click', () => poll(home, { immediate: true }));
		actions.append(again);
		panel.append(actions);
		return panel;
	}

	// ── State 6: the code is dead ─────────────────────────────────────────────

	function codeDeadPanel({ home, reason }) {
		const panel = el('section', 'hm-panel');
		const wasUsed = reason === 'used';
		panel.append(
			el('h2', 'hm-panel-title', wasUsed ? 'That code has already been used' : 'That code expired'),
			noticeEl({
				tone: 'warn',
				title: wasUsed ? 'A pairing code works exactly once.' : 'A pairing code lasts ten minutes.',
				body: 'That is deliberate: a short code that lived forever would be a permanent way into your house. Get a new one and it goes straight back to the same home, not a second one.',
			}),
		);
		const actions = el('div', 'hm-actions');
		const again = el('button', 'hm-btn hm-btn-primary', 'Get a new code');
		again.type = 'button';
		again.addEventListener('click', () => begin({ homeId: home?.id }));
		actions.append(again);
		panel.append(actions);
		return panel;
	}

	// ── State 7: revoked ──────────────────────────────────────────────────────

	function revokedPanel({ home }) {
		const panel = el('section', 'hm-panel');
		panel.append(
			el('h2', 'hm-panel-title', 'This home was disconnected'),
			noticeEl({
				tone: 'info',
				title: 'The link is gone from both ends.',
				body: 'three.ws dropped the connection its side, and the integration in your house can no longer dial in. To connect again, remove the three.ws integration in Home Assistant and pair a new code here.',
			}),
		);
		const actions = el('div', 'hm-actions');
		const again = el('button', 'hm-btn hm-btn-primary', 'Connect a home again');
		again.type = 'button';
		again.addEventListener('click', () => show(PAIR_STATE.NOT_INSTALLED));
		actions.append(again);
		panel.append(actions);
		return panel;
	}

	/** This deployment has no relay at all, which is a real answer, not a crash. */
	function unavailablePanel({ detail } = {}) {
		const panel = el('section', 'hm-panel');
		panel.append(
			el('h2', 'hm-panel-title', 'This is not available here yet'),
			noticeEl({
				tone: 'info',
				title: 'This three.ws does not run a home relay.',
				body: detail || 'A home with a remote https address still connects normally. Use the other option on this page.',
			}),
		);
		if (onCancel) {
			const actions = el('div', 'hm-actions');
			const back = el('button', 'hm-btn hm-btn-primary', 'Use a web address instead');
			back.type = 'button';
			back.addEventListener('click', () => {
				destroy();
				onCancel();
			});
			actions.append(back);
			panel.append(actions);
		}
		return panel;
	}

	// ── The two network paths ─────────────────────────────────────────────────

	async function begin({ homeId } = {}) {
		clear(mount);
		mount.append(el('p', 'hm-live', 'Minting a pairing code'));
		try {
			const result = homeId ? await refreshPairing(homeId) : await startPairing({ label: '' });
			const home = result.home || { id: homeId || result.homeId };
			show(PAIR_STATE.PAIRING, { home, code: result.code, expiresAt: result.expiresAt });
		} catch (err) {
			if (err instanceof HomeApiError && (err.code === 'not_connected' || err.status === 503)) {
				return show(PAIR_STATE.UNAVAILABLE, { detail: err.message });
			}
			show(PAIR_STATE.NOT_INSTALLED, { notice: { tone: 'error', title: 'We could not start pairing.', body: err?.message || 'Try again in a moment.' } });
		}
	}

	/**
	 * Ask whether the house has arrived. Polling rather than a socket on purpose:
	 * this runs for a couple of minutes at most, once, and a second live channel
	 * for it would be more moving parts than the whole flow is worth.
	 */
	async function poll(home, { immediate = false } = {}) {
		if (destroyed || !home?.id) return;
		if (timer) clearTimeout(timer);
		const run = async () => {
			if (destroyed) return;
			try {
				const status = await pairingStatus(home.id);
				const row = status.home || home;
				if (row.status === 'revoked' || row.revoked_at) return show(PAIR_STATE.REVOKED, { home: row });
				if (status.relay?.online) {
					if (current !== PAIR_STATE.LINKED) {
						current = PAIR_STATE.LINKED;
						return show(PAIR_STATE.LINKED, { home: row });
					}
					return;
				}
				if (status.pairing && !status.pairing.expired) {
					// Still waiting on the code. The countdown panel is already up.
					timer = setTimeout(run, POLL_MS);
					return;
				}
				if (current === PAIR_STATE.LINKED || row.status === 'connected' || row.last_ok_at) {
					// It was linked and is not answering now: state 4, not state 6.
					if (current !== PAIR_STATE.AGENT_OFFLINE) {
						current = PAIR_STATE.AGENT_OFFLINE;
						return show(PAIR_STATE.AGENT_OFFLINE, { home: row });
					}
					timer = setTimeout(run, POLL_MS * 3);
					return;
				}
				return show(PAIR_STATE.CODE_DEAD, { home: row, reason: 'expired' });
			} catch (err) {
				if (err instanceof HomeApiError && err.status === 404) return show(PAIR_STATE.REVOKED, { home });
				timer = setTimeout(run, POLL_MS * 2);
			}
		};
		timer = setTimeout(run, immediate ? 0 : POLL_MS);
	}

	// A home already in flight resumes where it was; otherwise start at step 1.
	show(PAIR_STATE.NOT_INSTALLED);
	return { destroy, showState: show };
}
