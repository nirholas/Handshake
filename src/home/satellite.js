/**
 * /smart-home/satellite: the browser half of a Home Assistant voice satellite.
 *
 * Two views out of one module, chosen by the `?id=` in the URL:
 *
 *   no id   the manage view. Mint a pairing code, see what is paired, retire
 *           one. States 1 and 2 of the flow live here.
 *   ?id=…   the live view. The agent's body, its face moving to the pipeline's
 *           own speech, the transcript under it. States 3 to 10 live here.
 *
 * The live view is a display. It is meant to run on a tablet on a kitchen wall
 * for months, so it reconnects on its own, it survives the screen sleeping, and
 * it never renders a state it is only guessing at. When it cannot reach the
 * satellite it says exactly that, and it says the thing that is actually true
 * and actually reassuring: the voice assistant is still working, you have just
 * lost the face.
 *
 * The 3D work is not reimplemented here. TalkScene renders, AvatarMouthTarget
 * binds the mouth, LipsyncDriver drives it off an analyser, and TalkEmotes
 * plays the body language. All four already exist and are used by talk mode;
 * this page feeds them from a different audio source, and that is the whole
 * difference.
 */

import { LipsyncDriver } from '../voice/lipsync-driver.js';
import { AvatarMouthTarget } from '../voice/avatar-morph-target.js';
import { TalkScene } from '../voice/talk-scene.js';
import { SatelliteLink, STATE } from './satellite-link.js';

const root = document.getElementById('hs-root');
const params = new URLSearchParams(location.search);
const satelliteId = params.get('id');

/** One place that decides what each state is called and what the body does. */
const STATE_COPY = Object.freeze({
	[STATE.UNPAIRED]: { label: 'Not paired', emote: 'idle' },
	[STATE.PAIRING]: { label: 'Pairing', emote: 'idle' },
	[STATE.IDLE]: { label: 'Ready', emote: 'idle' },
	[STATE.WAKE]: { label: 'Yes?', emote: 'reaction' },
	[STATE.LISTENING]: { label: 'Listening', emote: 'idle' },
	[STATE.THINKING]: { label: 'Thinking', emote: 'idle' },
	[STATE.SPEAKING]: { label: 'Speaking', emote: 'idle' },
	[STATE.ERROR]: { label: 'Something went wrong', emote: 'reaction' },
	[STATE.DISCONNECTED]: { label: 'Home Assistant is not connected', emote: 'idle' },
	[STATE.OFFLINE]: { label: 'Reconnecting', emote: 'idle' },
});

let csrf = null;
async function csrfToken() {
	if (csrf && csrf.expiresAt > Date.now() + 5000) return csrf.token;
	const res = await fetch('/api/csrf-token', { credentials: 'include' });
	if (!res.ok) throw new Error('Could not get a security token. Sign in again and retry.');
	const body = await res.json();
	csrf = { token: body.data.token, expiresAt: Date.now() + (body.data.expires_in - 30) * 1000 };
	return csrf.token;
}

async function api(payload) {
	const token = await csrfToken();
	csrf = null; // single use
	const res = await fetch('/api/home/satellite', {
		method: 'POST',
		credentials: 'include',
		headers: { 'content-type': 'application/json', 'x-csrf-token': token, accept: 'application/json' },
		body: JSON.stringify(payload),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw Object.assign(new Error(body?.error_description || body?.message || 'That did not work.'), {
			status: res.status,
			code: body?.error,
		});
	}
	return body;
}

const el = (tag, props = {}, children = []) => {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (key === 'class') node.className = value;
		else if (key === 'text') node.textContent = value;
		else if (key === 'html') node.innerHTML = value;
		else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
		else if (value !== null && value !== undefined) node.setAttribute(key, value);
	}
	for (const child of [].concat(children)) if (child) node.append(child);
	return node;
};

const clear = (node) => {
	while (node.firstChild) node.firstChild.remove();
};

function fail(message, { retry = null } = {}) {
	clear(root);
	root.setAttribute('aria-busy', 'false');
	root.append(
		el('section', { class: 'hs-panel hs-error' }, [
			el('h2', { class: 'hs-panel-title', text: 'That did not work' }),
			el('p', { class: 'hs-panel-sub', text: message }),
			retry ? el('button', { class: 'hs-btn', type: 'button', onclick: retry, text: 'Try again' }) : null,
		]),
	);
}

/* ========================================================== manage view === */

async function renderManage() {
	root.setAttribute('aria-busy', 'true');
	let data;
	let agents = [];
	try {
		const [satRes, agentRes] = await Promise.all([
			fetch('/api/home/satellite', { credentials: 'include', headers: { accept: 'application/json' } }),
			fetch('/api/agents', { credentials: 'include', headers: { accept: 'application/json' } }),
		]);
		if (satRes.status === 401) return renderSignedOut();
		if (!satRes.ok) throw new Error('Could not load your satellites.');
		data = await satRes.json();
		if (agentRes.ok) {
			const payload = await agentRes.json();
			agents = payload.data?.agents || payload.agents || payload.data || [];
		}
	} catch (err) {
		return fail(err.message, { retry: renderManage });
	}

	root.setAttribute('aria-busy', 'false');
	clear(root);
	root.append(renderPairPanel(agents, data));
	root.append(renderPendingPanel(data.pending_codes || []));
	root.append(renderSatellitePanel(data.satellites || []));
}

function renderSignedOut() {
	root.setAttribute('aria-busy', 'false');
	clear(root);
	root.append(
		el('section', { class: 'hs-panel' }, [
			el('h2', { class: 'hs-panel-title', text: 'Sign in to pair a satellite' }),
			el('p', {
				class: 'hs-panel-sub',
				text: 'A satellite is bound to one of your agents, so pairing needs an account. Trying it out does not: the service runs on your own network and shows the agent locally without three.ws in the loop.',
			}),
			el('a', { class: 'hs-btn hs-btn-primary', href: '/login?next=/smart-home/satellite', text: 'Sign in' }),
		]),
	);
}

function renderPairPanel(agents, data) {
	const panel = el('section', { class: 'hs-panel' }, [
		el('h2', { class: 'hs-panel-title', text: 'Pair a new satellite' }),
		el('p', {
			class: 'hs-panel-sub',
			text: 'Pick the agent that should appear on it. You will get a code that is good once, for fifteen minutes.',
		}),
	]);

	if (!agents.length) {
		panel.append(
			el('div', { class: 'hs-empty' }, [
				el('div', { class: 'hs-empty-mark', text: '🎭' }),
				el('p', { text: 'You do not have an agent yet, and a satellite needs a face to show.' }),
				el('a', { class: 'hs-btn hs-btn-primary', href: '/create', text: 'Create an agent' }),
			]),
		);
		return panel;
	}

	const select = el('select', { class: 'hs-select', id: 'hs-agent', 'aria-label': 'Agent' });
	for (const agent of agents) {
		select.append(el('option', { value: agent.id, text: agent.name || 'Untitled agent' }));
	}
	const nameInput = el('input', {
		class: 'hs-input',
		id: 'hs-name',
		type: 'text',
		maxlength: '120',
		placeholder: 'Kitchen display',
		'aria-label': 'What Home Assistant should call it',
	});
	const button = el('button', { class: 'hs-btn hs-btn-primary', type: 'submit', text: 'Get a pairing code' });
	const out = el('div', { id: 'hs-code-out' });

	const form = el('form', {
		class: 'hs-row',
		onsubmit: async (event) => {
			event.preventDefault();
			button.disabled = true;
			button.textContent = 'Minting…';
			try {
				const result = await api({
					action: 'pair',
					agent_id: select.value,
					name: nameInput.value.trim() || null,
				});
				renderCode(out, result);
			} catch (err) {
				clear(out);
				out.append(el('p', { class: 'hs-note', text: err.message }));
			} finally {
				button.disabled = false;
				button.textContent = 'Get a pairing code';
			}
		},
	}, [
		el('div', { class: 'hs-grow' }, [el('label', { class: 'hs-label', for: 'hs-agent', text: 'Agent' }), select]),
		el('div', { class: 'hs-grow' }, [el('label', { class: 'hs-label', for: 'hs-name', text: 'Name' }), nameInput]),
		el('div', {}, [el('span', { class: 'hs-label', text: ' ' }), button]),
	]);

	panel.append(form, out);
	if (data && data.hub_configured === false) {
		panel.append(
			el('p', {
				class: 'hs-note',
				text: 'This three.ws instance has no satellite hub configured, so a satellite pairs and runs, but this page can only watch it from a browser on the same network as the house. The pipeline itself is unaffected either way.',
			}),
		);
	}
	return panel;
}

function renderCode(out, result) {
	clear(out);
	const expires = new Date(result.expires_at);
	out.append(
		el('div', { style: 'margin-top:1.1rem' }, [
			el('p', { class: 'hs-label', text: `Pairing code for ${result.agent?.name || 'your agent'}` }),
			el('p', { style: 'margin:0 0 0.9rem' }, [el('code', { class: 'hs-code', text: result.code })]),
			el('p', { class: 'hs-panel-sub', text: `Single use. Expires ${expires.toLocaleTimeString()}. Run this next to Home Assistant:` }),
			el('code', { class: 'hs-cmd', text: result.command }),
			el('p', {
				class: 'hs-note',
				text: 'Then in Home Assistant: Settings, Devices and services, Add integration, Wyoming Protocol, and give it the host running that container with port 10700.',
			}),
		]),
	);
}

function renderPendingPanel(codes) {
	if (!codes.length) return el('span');
	return el('section', { class: 'hs-panel' }, [
		el('h2', { class: 'hs-panel-title', text: 'Codes waiting to be used' }),
		el('ul', { class: 'hs-list' }, codes.map((code) =>
			el('li', { class: 'hs-item' }, [
				el('div', { class: 'hs-grow' }, [
					el('div', { class: 'hs-item-name', text: code.name || code.agent?.name || 'Unnamed' }),
					el('div', { class: 'hs-item-meta', text: `for ${code.agent?.name || 'an agent'} · expires ${new Date(code.expires_at).toLocaleTimeString()}` }),
				]),
				el('button', {
					class: 'hs-btn hs-btn-quiet',
					type: 'button',
					text: 'Withdraw',
					onclick: async (event) => {
						event.target.disabled = true;
						try {
							await api({ action: 'revoke', code_id: code.id });
							await renderManage();
						} catch (err) {
							event.target.disabled = false;
							event.target.textContent = err.message;
						}
					},
				}),
			]),
		)),
	]);
}

function renderSatellitePanel(satellites) {
	const panel = el('section', { class: 'hs-panel' }, [
		el('h2', { class: 'hs-panel-title', text: 'Your satellites' }),
	]);

	if (!satellites.length) {
		panel.append(
			el('div', { class: 'hs-empty' }, [
				el('div', { class: 'hs-empty-mark', text: '🛰️' }),
				el('p', { text: 'Nothing paired yet. Get a code above, run the container next to Home Assistant, and add it as a Wyoming Protocol integration.' }),
				el('a', { class: 'hs-btn hs-btn-quiet', href: '/docs/home-satellite', text: 'Read the setup guide' }),
			]),
		);
		return panel;
	}

	panel.append(el('ul', { class: 'hs-list' }, satellites.map((sat) => {
		const seen = sat.last_seen_at ? new Date(sat.last_seen_at) : null;
		const live = seen && Date.now() - seen.getTime() < 5 * 60 * 1000;
		return el('li', { class: 'hs-item' }, [
			el('span', { class: 'hs-dot', 'data-live': live ? '1' : '0', title: live ? 'Checked in recently' : 'Not seen recently' }),
			el('div', { class: 'hs-grow' }, [
				el('div', { class: 'hs-item-name', text: sat.name }),
				el('div', {
					class: 'hs-item-meta',
					text: `${sat.agent?.name || 'agent'}${sat.area ? ` · ${sat.area}` : ''}${seen ? ` · last seen ${seen.toLocaleString()}` : ' · never checked in'}`,
				}),
			]),
			el('a', { class: 'hs-btn', href: `/smart-home/satellite?id=${encodeURIComponent(sat.id)}`, text: 'Open' }),
			el('button', {
				class: 'hs-btn hs-btn-quiet',
				type: 'button',
				text: 'Retire',
				onclick: async (event) => {
					event.target.disabled = true;
					try {
						await api({ action: 'revoke', satellite_id: sat.id });
						await renderManage();
					} catch (err) {
						event.target.disabled = false;
						event.target.textContent = err.message;
					}
				},
			}),
		]);
	})));
	return panel;
}

/* ============================================================ live view === */

async function renderLive(id) {
	root.setAttribute('aria-busy', 'true');
	let attach;
	try {
		attach = await api({ action: 'attach', satellite_id: id });
	} catch (err) {
		if (err.status === 401) return renderSignedOut();
		return fail(err.message, { retry: () => renderLive(id) });
	}

	root.setAttribute('aria-busy', 'false');
	clear(root);
	document.body.classList.add('hs-body-live');

	const badge = el('span', { class: 'hs-badge', 'data-state': STATE.OFFLINE, text: 'Connecting' });
	const stage = el('div', { class: 'hs-stage-canvas' });
	const asleep = el('div', { class: 'hs-asleep', hidden: 'hidden' }, [
		el('p', { style: 'font-size:1.1rem;font-weight:600', text: 'Screen resting' }),
		el('p', { text: 'The voice assistant is still running. Touch the screen to bring the agent back.' }),
	]);
	const said = el('p', { class: 'hs-said', 'aria-live': 'polite' });
	const answered = el('p', { class: 'hs-answered', 'aria-live': 'polite' });
	const meterFill = el('div', { class: 'hs-meter-fill' });
	// Two ways in, because a satellite has two honest modes. "Listen" is what it
	// does on a wall all day: stream continuously and let Home Assistant's own
	// wake word decide. "Talk now" skips the wake stage for somebody standing in
	// front of the screen who would rather press a button than say a phrase.
	const micButton = el('button', { class: 'hs-btn', type: 'button', text: 'Listen for the wake word' });
	const talkButton = el('button', { class: 'hs-btn hs-btn-primary', type: 'button', text: 'Talk now' });
	const status = el('span', { class: 'hs-live-status', text: 'Connecting to the satellite' });

	root.append(el('div', { class: 'hs-live' }, [
		el('header', { class: 'hs-live-top' }, [
			el('a', { class: 'hs-btn hs-btn-quiet', href: '/smart-home/satellite', text: '← Satellites' }),
			el('div', { class: 'hs-grow' }, [
				el('div', { class: 'hs-live-name', text: attach.satellite?.name || 'Satellite' }),
				status,
			]),
		]),
		el('div', { class: 'hs-stage' }, [stage, badge, asleep]),
		el('div', { class: 'hs-caption' }, [
			said,
			answered,
			el('div', { class: 'hs-live-actions' }, [
				talkButton,
				micButton,
				el('div', { class: 'hs-meter', role: 'presentation' }, [meterFill]),
				el('span', { class: 'hs-item-meta', text: 'Home Assistant owns the wake word, the transcription and the answer. This screen is the face.' }),
			]),
		]),
	]));

	/* --- the body ------------------------------------------------------- */
	const mouth = new AvatarMouthTarget();
	const scene = new TalkScene();
	let emotes = null;
	const glbUrl = attach.agent?.avatarUrl;
	if (glbUrl) {
		try {
			await scene.mount({ container: stage, glbUrl, cameraPreset: 'half' });
			scene.attachMouthTarget(mouth);
			emotes = scene.getEmoteController();
			scene.playEmote('idle');
		} catch {
			stage.append(el('div', { class: 'hs-empty' }, [
				el('div', { class: 'hs-empty-mark', text: '🎭' }),
				el('p', { text: 'The agent’s model could not be loaded, so there is no face on this screen. Everything else still works.' }),
			]));
		}
	} else {
		stage.append(el('div', { class: 'hs-empty' }, [
			el('div', { class: 'hs-empty-mark', text: '🎭' }),
			el('p', { text: 'This agent has no avatar yet, so there is nothing to show. Give it one and this screen fills in.' }),
			el('a', { class: 'hs-btn hs-btn-quiet', href: '/create', text: 'Give it a body' }),
		]));
	}

	/* --- the link ------------------------------------------------------- */
	const link = new SatelliteLink({
		resolve: async () => {
			// Every connect mints a fresh short-lived token rather than replaying
			// the one this page loaded with; a display left open overnight would
			// otherwise be locked out by morning.
			const fresh = await api({ action: 'attach', satellite_id: id });
			const url = fresh.hub_url || attach.hub_url;
			const token = fresh.hub_token || fresh.lan_token;
			if (!url || !token) {
				throw new Error('This three.ws instance has no satellite hub configured, so this page cannot reach the satellite. It is still running: open it from a browser on the same network as the house.');
			}
			return { url, token };
		},
	});

	let driver = null;
	link.addEventListener('speaking', (event) => {
		driver?.dispose?.();
		driver?.stop?.();
		const analyser = event.detail?.analyser;
		if (!analyser) return;
		driver = new LipsyncDriver({ analyser, target: mouth });
		driver.start();
	});
	link.addEventListener('spoken', () => {
		driver?.stop();
		mouth.setMouthShape?.({ open: 0, wide: 0, round: 0 });
	});

	link.addEventListener('hello', () => {
		status.textContent = `Connected · ${link.satellite?.wyoming ? `Wyoming ${link.satellite.wyoming}` : 'Wyoming'}`;
	});
	link.addEventListener('transcript', (event) => {
		said.textContent = event.detail.text;
	});
	link.addEventListener('speech', (event) => {
		answered.textContent = event.detail.text;
	});
	link.addEventListener('wake', () => {
		said.textContent = '';
		answered.textContent = '';
	});
	link.addEventListener('pipeline-error', (event) => {
		answered.textContent = event.detail.text || 'The pipeline reported an error.';
	});
	link.addEventListener('unauthorized', () => {
		status.textContent = 'This session expired. Reload the page to watch again.';
	});
	link.addEventListener('mic', (event) => {
		const { open, mode } = event.detail;
		micButton.textContent = open && mode === 'wake' ? 'Stop listening' : 'Listen for the wake word';
		talkButton.textContent = open && mode === 'command' ? 'Done' : 'Talk now';
		micButton.disabled = open && mode === 'command';
		talkButton.disabled = open && mode === 'wake';
	});
	link.addEventListener('state', (event) => {
		const { state, detail } = event.detail;
		const copy = STATE_COPY[state] || STATE_COPY[STATE.IDLE];
		badge.dataset.state = state;
		badge.textContent = detail || copy.label;
		badge.classList.toggle('hs-pulse', state === STATE.LISTENING || state === STATE.WAKE);
		if (state === STATE.DISCONNECTED) {
			status.textContent = 'Home Assistant is not connected to this satellite right now.';
		} else if (state === STATE.OFFLINE) {
			status.textContent = 'Lost the satellite. Your voice assistant is unaffected; this screen is reconnecting.';
		}
		if (emotes && copy.emote && copy.emote !== 'idle') scene.playEmoteOnce?.(copy.emote);
	});

	const toggleMic = async (button, mode) => {
		button.disabled = true;
		try {
			if (link.micOpen) link.stopMic();
			else await link.startMic(mode);
		} catch (err) {
			answered.textContent = err.message;
		} finally {
			button.disabled = false;
		}
	};
	micButton.addEventListener('click', () => toggleMic(micButton, 'wake'));
	talkButton.addEventListener('click', () => toggleMic(talkButton, 'command'));

	// The microphone meter. rAF rather than an interval so it stops dead when
	// the tab is hidden instead of spinning on a sleeping display.
	const tick = () => {
		meterFill.style.width = `${Math.round(link.micLevel() * 100)}%`;
		rafId = requestAnimationFrame(tick);
	};
	let rafId = requestAnimationFrame(tick);

	// The screen going to sleep is a normal state on a wall display, not a
	// failure. The socket stays open, the pipeline keeps running, and the only
	// thing that stops is the renderer.
	document.addEventListener('visibilitychange', () => {
		const hidden = document.visibilityState === 'hidden';
		asleep.hidden = !hidden;
		scene.setFpsCap?.(hidden ? 1 : 0);
	});

	window.addEventListener('pagehide', () => {
		cancelAnimationFrame(rafId);
		link.close();
		scene.unmount?.();
	});

	await link.connect();
}

/* ===================================================================== */

if (satelliteId) renderLive(satelliteId);
else renderManage();
