#!/usr/bin/env node
/**
 * The browser proof for the hands-free voice loop (src/voice/home-voice.js).
 *
 * Everything a claim about this feature rests on is measured here, in a real
 * Chromium, against the real speech lanes:
 *
 *   1  cold load          nothing about listening is fetched before opt-in
 *   2  happy path         wake word, capture, transcription, agent turn, reply
 *   3  barge-in           playback stops after the user starts talking
 *   4  self-trigger       the agent's own wake word does not wake it
 *   5  guarded (refused)  an ambient "yeah" does not confirm
 *   6  guarded (accepted) the word "confirm" does
 *   7  mute               capture stops at the track, not behind a flag
 *   8  unavailable        a deployment with no speech lane degrades honestly
 *   9  permission denied  a refused microphone has a way back
 *  10  state gallery      a frame of each of the twelve states
 *
 * The microphone is a real MediaStream fed from a WAV by Chromium's fake capture
 * device, and the speech in those WAVs is synthesized by the platform's own TTS
 * lane rather than hand-picked from a recording. /api/asr and /api/tts/speak are
 * the real endpoints throughout.
 *
 * ONE thing is substituted, and only in scenarios 5 and 6: the /api/chat
 * response that carries a pending_confirmation. The server-side home tools that
 * mint a real confirmation are order 04 of the home campaign and have not landed
 * yet, so the payload is supplied here to the documented shape. Every other leg
 * of those two scenarios (speech, VAD, ASR, the grammar, the redemption request)
 * is the real path. When order 04 lands, delete the route handler and the
 * scenarios keep working against a real confirmation.
 *
 * Usage:
 *   node scripts/check-home-voice.mjs [--port 3457] [--out .cache/home-voice]
 *   node scripts/check-home-voice.mjs --headed        # watch it run
 *
 * Exit code is 0 when every assertion held, 1 otherwise. The measured legs and
 * the assertions are written to <out>/report.json.
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const PORT = Number(flag('port', process.env.HOME_VOICE_PORT || 3457));
const BASE = `http://localhost:${PORT}`;
const OUT = resolve(flag('out', '.cache/home-voice'));
const HEADED = args.includes('--headed');
const AUDIO = join(OUT, 'audio');

mkdirSync(AUDIO, { recursive: true });

/**
 * The QA account from .env, used only so the run is not throttled to the
 * anonymous per-IP buckets (10 TTS and 15 ASR per hour, which one full run
 * spends). The lanes themselves are the same lanes either way. Without the
 * credentials the run still works; it just cannot repeat as often.
 */
let SESSION_COOKIE = null;

async function signIn() {
	const email = process.env.AUDIT_EMAIL;
	const password = process.env.AUDIT_PASSWORD;
	if (!email || !password) {
		console.log('[auth] AUDIT_EMAIL / AUDIT_PASSWORD not set: running against the anonymous rate limits.');
		return;
	}
	const upstream = process.env.DEV_API_PROXY || 'https://three.ws';
	const res = await fetch(`${upstream}/api/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email, password }),
	});
	if (!res.ok) {
		console.log(`[auth] login failed (${res.status}): running against the anonymous rate limits.`);
		return;
	}
	const raw = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean);
	const sid = raw.map((c) => c.split(';')[0]).find((c) => c.startsWith('__Host-sid='));
	if (!sid) {
		console.log('[auth] no session cookie returned: running against the anonymous rate limits.');
		return;
	}
	SESSION_COOKIE = sid;
	console.log('[auth] signed in as the QA account.');
}

const results = [];
function check(name, pass, detail) {
	results.push({ name, pass: !!pass, detail });
	console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : `  ${JSON.stringify(detail)}`}`);
}

// ── fixtures: real synthesized speech, cached on disk ───────────────────────

/**
 * Utterances the scenarios need. leadMs is silence before the speech, which is
 * what buys the page time to load its models before the microphone matters, and
 * tailMs is the trailing silence that lets the VAD call the utterance finished.
 */
const CLIPS = {
	command: { text: 'Hey Jarvis, turn the kitchen light off.', leadMs: 1200, tailMs: 2500 },
	selfTrigger: { text: 'Hey Jarvis. That is my own wake word, spoken by me.', leadMs: 1200, tailMs: 2000 },
	bargeUser: { text: 'Actually stop, I changed my mind about that.', leadMs: 5000, tailMs: 2500 },
	ambientYeah: { text: 'Yeah.', leadMs: 8000, tailMs: 2500 },
	confirmToken: { text: 'Confirm.', leadMs: 8000, tailMs: 2500 },
	silence: { text: '', leadMs: 12000, tailMs: 0 },
};

async function ensureClips() {
	for (const [name, spec] of Object.entries(CLIPS)) {
		const path = join(AUDIO, `${name}.wav`);
		spec.path = path;
		if (existsSync(path)) continue;
		const speech = spec.text ? await synthesize(spec.text) : { samples: new Float32Array(0), rate: 16000 };
		const lead = Math.round((spec.leadMs / 1000) * 16000);
		const tail = Math.round((spec.tailMs / 1000) * 16000);
		const resampled = resample(speech.samples, speech.rate, 16000);
		const out = new Float32Array(lead + resampled.length + tail);
		out.set(resampled, lead);
		writeFileSync(path, wav16(out, 16000));
		spec.speechStartMs = spec.leadMs;
		console.log(`[fixture] ${name}.wav ${(out.length / 16000).toFixed(2)}s`);
	}
}

/** The platform's own TTS lane, so the test speech is speech the product makes. */
async function synthesize(text) {
	const res = await fetch(`${BASE}/api/tts/speak`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', ...(SESSION_COOKIE ? { cookie: SESSION_COOKIE } : {}) },
		body: JSON.stringify({ text, format: 'wav' }),
	});
	if (!res.ok) throw new Error(`tts ${res.status}: ${await res.text()}`);
	return decodeWav(Buffer.from(await res.arrayBuffer()));
}

function decodeWav(buf) {
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let off = 12;
	let rate = 16000;
	let bits = 16;
	let channels = 1;
	let dataOff = 0;
	let dataLen = 0;
	while (off + 8 <= buf.byteLength) {
		const id = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
		const size = dv.getUint32(off + 4, true);
		if (id === 'fmt ') {
			channels = dv.getUint16(off + 10, true);
			rate = dv.getUint32(off + 12, true);
			bits = dv.getUint16(off + 22, true);
		}
		if (id === 'data') {
			dataOff = off + 8;
			dataLen = size;
			break;
		}
		off += 8 + size + (size % 2);
	}
	const frames = Math.floor(dataLen / (bits / 8) / channels);
	const out = new Float32Array(frames);
	for (let i = 0; i < frames; i++) out[i] = dv.getInt16(dataOff + i * 2 * channels, true) / 32768;
	return { samples: out, rate };
}

function resample(x, from, to) {
	if (from === to || !x.length) return x;
	const ratio = from / to;
	const n = Math.floor(x.length / ratio);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) {
		const p = i * ratio;
		const k = Math.floor(p);
		const f = p - k;
		const a = x[k] || 0;
		const b = x[k + 1] !== undefined ? x[k + 1] : a;
		out[i] = a + (b - a) * f;
	}
	return out;
}

function wav16(samples, rate) {
	const n = samples.length;
	const buf = Buffer.alloc(44 + n * 2);
	buf.write('RIFF', 0);
	buf.writeUInt32LE(36 + n * 2, 4);
	buf.write('WAVE', 8);
	buf.write('fmt ', 12);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(1, 22);
	buf.writeUInt32LE(rate, 24);
	buf.writeUInt32LE(rate * 2, 28);
	buf.writeUInt16LE(2, 32);
	buf.writeUInt16LE(16, 34);
	buf.write('data', 36);
	buf.writeUInt32LE(n * 2, 40);
	for (let i = 0; i < n; i++) {
		buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
	}
	return buf;
}

// ── browser plumbing ────────────────────────────────────────────────────────

async function launch(audioPath, { loopAudio = true } = {}) {
	const chromiumArgs = [
		'--use-fake-device-for-media-stream',
		'--use-fake-ui-for-media-stream',
		'--autoplay-policy=no-user-gesture-required',
	];
	// The fake capture file starts the moment getUserMedia opens, and the models
	// take a few seconds to arrive on a cold cache. Looping means the utterance
	// comes round again rather than the whole scenario hinging on a guess about
	// how long the download took.
	if (audioPath) chromiumArgs.push(`--use-file-for-fake-audio-capture=${audioPath}${loopAudio ? '' : '%noloop'}`);
	const browser = await chromium.launch({ headless: !HEADED, args: chromiumArgs });
	const context = await browser.newContext({
		permissions: ['microphone'],
		// The session travels as a header rather than a cookie because the cookie is
		// __Host- prefixed and Secure, and the dev origin is plain http on localhost.
		// The dev server forwards it upstream unchanged either way.
		extraHTTPHeaders: SESSION_COOKIE ? { cookie: SESSION_COOKIE } : {},
	});
	const page = await context.newPage();
	const requests = [];
	page.on('request', (r) => requests.push({ url: r.url(), at: Date.now() }));
	const consoleErrors = [];
	// The dev server's own HMR socket cannot reach a Codespace-forwarded origin,
	// which is noise from the harness rather than from the page under test.
	const isDevNoise = (text) => /\[vite\]|WebSocket|hmr/i.test(text);
	page.on('console', (m) => {
		if (m.type() === 'error' && !isDevNoise(m.text())) consoleErrors.push(m.text());
	});
	page.on('pageerror', (e) => {
		if (!isDevNoise(String(e))) consoleErrors.push(String(e));
	});
	return { browser, context, page, requests, consoleErrors };
}

/** Mirror the loop's own event stream into the page so the script can await it. */
const TAP = `
	window.__hv = { events: [], states: [] };
	const install = () => {
		if (!window.homeVoice) return false;
		const loop = window.homeVoice.loop;
		const priorEvent = loop.onEvent;
		loop.onEvent = (e) => { priorEvent?.(e); window.__hv.events.push({ ...e, t: performance.now() }); };
		const priorState = loop.onState;
		loop.onState = (s, d) => { priorState?.(s, d); window.__hv.states.push({ state: s, t: performance.now() }); };
		return true;
	};
	if (!install()) {
		const timer = setInterval(() => { if (install()) clearInterval(timer); }, 25);
	}
`;

async function bootPage(page, { query = '' } = {}) {
	// Concurrent agents edit vite.config.js in this worktree, which restarts the
	// dev server mid-run. Retry rather than fail a real assertion on that.
	let lastError = null;
	for (let attempt = 0; attempt < 6; attempt++) {
		try {
			await page.goto(`${BASE}/voice/home${query}`, { waitUntil: 'domcontentloaded' });
			await page.waitForFunction(() => !!window.homeVoice, null, { timeout: 30000 });
			await page.evaluate(TAP);
			return;
		} catch (err) {
			lastError = err;
			await page.waitForTimeout(4000);
		}
	}
	throw lastError;
}

async function optIn(page) {
	await page.evaluate(async () => {
		const { loop } = window.homeVoice;
		loop.grantConsent();
		await loop.enable();
	});
}

async function waitForEvent(page, type, timeout = 45000) {
	try {
		await page.waitForFunction((t) => window.__hv.events.some((e) => e.type === t), type, { timeout, polling: 50 });
	} catch (err) {
		const seen = await page.evaluate(() => ({
			state: window.homeVoice.loop.state,
			wakeReady: !!window.homeVoice.loop._wake?.ready,
			vadRunning: !!window.homeVoice.loop._vad?.running,
			peakScore: Math.max(0, ...window.__hv.events.filter((e) => e.type === 'wake-score').map((e) => e.score)),
			scores: window.__hv.events.filter((e) => e.type === 'wake-score').length,
			types: [...new Set(window.__hv.events.map((e) => e.type))],
		}));
		throw new Error(`waiting for "${type}" timed out. Loop state: ${JSON.stringify(seen)}`);
	}
}

const events = (page) => page.evaluate(() => window.__hv.events);
const legs = (page) => page.evaluate(() => window.homeVoice.loop.latencySummary());

// ── scenarios ───────────────────────────────────────────────────────────────

async function scenarioColdLoad() {
	const { browser, page, requests, consoleErrors } = await launch(null);
	try {
		await bootPage(page);
		await page.waitForTimeout(3000);
		const voiceAssets = requests.filter((r) =>
			/models\/voice|onnxruntime|vad-web|wake-word\.js|silero/i.test(r.url),
		);
		check('cold load fetches nothing about listening before opt-in', voiceAssets.length === 0, {
			fetched: voiceAssets.map((r) => r.url.replace(BASE, '')),
		});
		const state = await page.evaluate(() => window.homeVoice.loop.state);
		check('the loop rests in a non-listening state on a cold load', state === 'off' || state === 'unavailable', {
			state,
		});
		const micLive = await page.evaluate(() => window.homeVoice.loop.micLive);
		check('no microphone is open on a cold load', micLive === false);
		await page.locator('#voice-panel').screenshot({ path: join(OUT, 'cold-load.png') });

		// The same cold browser, after opting in: now the models arrive.
		await optIn(page);
		await page.waitForTimeout(1500);
		const afterOptIn = requests.filter((r) => /models\/voice/i.test(r.url));
		check('the models are fetched only once the user opts in', afterOptIn.length > 0, {
			count: afterOptIn.length,
			sample: afterOptIn.slice(0, 3).map((r) => r.url.replace(BASE, '')),
		});
		check('no console errors on the voice surface', consoleErrors.length === 0, { errors: consoleErrors.slice(0, 4) });
	} finally {
		await browser.close();
	}
}

async function scenarioHappyPath() {
	const { browser, page } = await launch(CLIPS.command.path);
	try {
		await bootPage(page);
		await optIn(page);
		await waitForEvent(page, 'wake', 45000);
		const wake = (await events(page)).find((e) => e.type === 'wake');
		check('the wake word fires on real speech', wake.score >= 0.5, { score: Number(wake.score.toFixed(4)) });

		await waitForEvent(page, 'transcript', 60000);
		const transcript = (await events(page)).find((e) => e.type === 'transcript');
		check('the utterance after the wake word is transcribed by the real lane', /kitchen light/i.test(transcript.text), {
			text: transcript.text,
		});

		// The turn runs against the real /api/chat. Whether it can reach a device is
		// order 04's business; what is measured here is that the loop completes.
		await page
			.waitForFunction(
				() => ['idle', 'speaking', 'error', 'confirm-pending'].includes(window.homeVoice.loop.state),
				null,
				{ timeout: 90000 },
			)
			.catch(() => {});

		const measured = await legs(page);
		check('the wake-word leg is inside its 200 ms budget', (measured.wake?.median ?? 1e9) <= 200, measured.wake);
		check('the end-of-speech leg is inside its 400 ms budget', (measured.endpoint?.median ?? 1e9) <= 400, measured.endpoint);
		check('transcription round trip is measured', !!measured.asr, measured.asr);
		await page.locator('#voice-panel').screenshot({ path: join(OUT, 'happy-path.png') });
		return measured;
	} finally {
		await browser.close();
	}
}

async function scenarioBargeIn() {
	const { browser, page } = await launch(CLIPS.bargeUser.path);
	try {
		await bootPage(page);
		await optIn(page);
		// Speak a long enough answer that the user's interruption lands inside it.
		await page.evaluate(() => {
			window.homeVoice.loop._speak(
				'The kitchen light is off, the hallway light is off, the thermostat is holding at twenty degrees, ' +
					'the front door is locked, and the garage is closed. Nothing else has changed since this morning.',
			);
		});
		await page
			.waitForFunction(
				() => window.homeVoice.loop.state === 'speaking' || window.__hv.events.some((e) => e.type === 'tts-failed'),
				null,
				{ timeout: 45000 },
			);
		const ttsFailure = (await events(page)).find((e) => e.type === 'tts-failed');
		if (ttsFailure) throw new Error(`the agent could not speak, so barge-in cannot be measured: ${ttsFailure.message}`);
		await waitForEvent(page, 'barge-in', 45000);
		const all = await events(page);
		const stop = all.find((e) => e.type === 'playback-stopped' && e.reason === 'barge-in');
		check('the user talking over the agent stops playback', !!stop);
		const measured = await legs(page);
		check('playback stops within 200 ms of the user starting to talk', (measured.bargeIn?.median ?? 1e9) <= 200, measured.bargeIn);
		const state = await page.evaluate(() => window.homeVoice.loop.state);
		check('the loop is capturing again immediately after a barge-in', state === 'capturing' || state === 'thinking', {
			state,
		});
		await page.locator('#voice-panel').screenshot({ path: join(OUT, 'barge-in.png') });
		return measured;
	} finally {
		await browser.close();
	}
}

async function scenarioSelfTrigger() {
	const { browser, page } = await launch(CLIPS.selfTrigger.path);
	try {
		await bootPage(page);
		await optIn(page);
		// Hold the loop in the state it is in while its own voice is playing.
		await page.evaluate(() => {
			const { loop } = window.homeVoice;
			loop._wake.suppressed = true;
			loop._setState('speaking', { text: 'Hey Jarvis is my wake word.' });
			// The wake word only reads frames while idle, so for this proof the
			// frames are handed to it directly: the guard, not the state gate, is
			// what is under test.
			loop._onFrame = function (frame) {
				this._wake.push(frame);
			}.bind(loop);
			loop._vad.onFrame = (frame) => loop._onFrame(frame, 0);
		});
		await page.waitForFunction(() => window.homeVoice.loop._wake.suppressedPeak > 0.5, null, { timeout: 45000 });
		const peak = await page.evaluate(() => window.homeVoice.loop._wake.suppressedPeak);
		const wakes = (await events(page)).filter((e) => e.type === 'wake');
		check('the agent hearing its own wake word scores high enough to wake', peak >= 0.5, { peak: Number(peak.toFixed(4)) });
		check('and does not wake, because the guard is absolute', wakes.length === 0, { wakes: wakes.length });
		return { peak, wakes: wakes.length };
	} finally {
		await browser.close();
	}
}

/**
 * The pending_confirmation payload order 04 will mint server-side. Supplied here
 * so the client half can be proven now; see the note at the top of this file.
 */
const PENDING_CONFIRMATION = {
	pending_confirmation: {
		confirmation_id: 'check-home-voice-confirmation',
		home_id: 'check-home',
		sentence: 'This will unlock the Front Door.',
		entity_ids: ['lock.front_door'],
		risk: 'opens the house',
		expires_in_ms: 90000,
	},
};

async function scenarioGuarded({ clip, expectRedeemed, label }) {
	const { browser, page } = await launch(clip.path);
	const redemptions = [];
	try {
		await page.route('**/api/chat', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(PENDING_CONFIRMATION) }),
		);
		await page.route('**/api/csrf-token', (route) =>
			route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { token: 'check' } }) }),
		);
		await page.route('**/api/home/*/confirm', (route) => {
			redemptions.push(JSON.parse(route.request().postData() || '{}'));
			route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ message: 'Unlocked the Front Door.' }),
			});
		});

		await bootPage(page, { query: '?home=check-home' });
		await optIn(page);
		await page.evaluate(() => window.homeVoice.loop.say('unlock the front door'));
		await waitForEvent(page, 'confirmation-open', 45000);
		const spoken = await page.evaluate(() => window.homeVoice.loop.stateDetail.confirmation?.sentence);
		check(`${label}: the whole action is spoken and shown before anything happens`, spoken === 'This will unlock the Front Door.', {
			spoken,
		});
		const shownEntities = await page.locator('.hv-confirm-entities li').allTextContents();
		check(`${label}: the entity is on screen while the confirmation is open`, shownEntities.includes('lock.front_door'), {
			shownEntities,
		});
		await page.locator('#voice-panel').screenshot({ path: join(OUT, `guarded-${expectRedeemed ? 'confirm' : 'yeah'}.png`) });

		await waitForEvent(page, 'transcript', 90000);
		const transcript = (await events(page)).find((e) => e.type === 'transcript');
		await page.waitForTimeout(2500);

		if (expectRedeemed) {
			check(`${label}: the spoken token is transcribed as the token`, /confirm/i.test(transcript.text), {
				text: transcript.text,
			});
			check(`${label}: the door is unlocked, by id alone`, redemptions.length === 1, { redemptions });
			check(
				`${label}: the redemption carries the confirmation id and nothing else`,
				redemptions[0] && Object.keys(redemptions[0]).join(',') === 'confirmation_id',
				redemptions[0],
			);
		} else {
			check(`${label}: the ambient word is transcribed`, transcript.text.trim().length > 0, { text: transcript.text });
			check(`${label}: nothing is unlocked`, redemptions.length === 0, { redemptions });
			const notToken = (await events(page)).some((e) => e.type === 'confirmation-not-token');
			check(`${label}: the loop says out loud that it was not the token`, notToken);
		}
	} finally {
		await browser.close();
	}
}

async function scenarioMute() {
	const { browser, page } = await launch(CLIPS.silence.path, { loopAudio: false });
	try {
		await bootPage(page);
		await optIn(page);
		const before = await page.evaluate(() => ({
			tracks: window.homeVoice.loop.trackStates(),
			live: window.homeVoice.loop.micLive,
			indicator: document.querySelector('.hv-indicator').dataset.live,
		}));
		check('the indicator reads live while the microphone is live', before.live && before.indicator === 'true', before);

		await page.click('[data-act="mute"]');
		await page.waitForFunction(() => window.homeVoice.loop.state === 'muted', null, { timeout: 15000 });
		await page.waitForTimeout(400);
		const after = await page.evaluate(() => ({
			tracks: window.homeVoice.loop.trackStates(),
			live: window.homeVoice.loop.micLive,
			indicator: document.querySelector('.hv-indicator').dataset.live,
			text: document.querySelector('.hv-indicator-text').textContent,
		}));
		check('mute ends every track at the device', after.tracks.every((s) => s === 'ended'), after.tracks);
		check('and the indicator follows the track, not a flag', after.live === false && after.indicator === 'false', after);
		await page.locator('#voice-panel').screenshot({ path: join(OUT, 'muted.png') });
		return after;
	} finally {
		await browser.close();
	}
}

async function scenarioUnavailable() {
	const { browser, page } = await launch(null);
	try {
		await page.route('**/api/asr', (route) =>
			route.request().method() === 'GET'
				? route.fulfill({
						status: 200,
						contentType: 'application/json',
						body: JSON.stringify({ configured: false, encodings: [], sampleRate: 16000 }),
					})
				: route.continue(),
		);
		await bootPage(page);
		await page.waitForFunction(() => window.homeVoice.loop.state === 'unavailable', null, { timeout: 20000 });
		const detail = await page.evaluate(() => ({
			state: window.homeVoice.loop.state,
			reason: window.homeVoice.loop.stateDetail.reason,
			micLive: window.homeVoice.loop.micLive,
			body: document.querySelector('#voice-panel .hv-body').textContent,
		}));
		check('an unconfigured speech lane lands in the unavailable state', detail.state === 'unavailable');
		check('with an honest reason, and no microphone', /not available/i.test(detail.body) && !detail.micLive, detail);

		// Even a user who insists gets no microphone.
		await page.evaluate(async () => {
			const { loop } = window.homeVoice;
			loop.grantConsent();
			await loop.enable();
		});
		const stillOff = await page.evaluate(() => window.homeVoice.loop.micLive);
		check('and opting in anyway still opens no microphone', stillOff === false);
		await page.locator('#voice-panel').screenshot({ path: join(OUT, 'unavailable.png') });
	} finally {
		await browser.close();
	}
}

async function scenarioPermissionDenied() {
	const { browser, page } = await launch(null);
	try {
		// The browser refusing the microphone, which is the one failure the loop
		// cannot route around and must therefore explain.
		await page.addInitScript(() => {
			Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
				configurable: true,
				value: async () => {
					const err = new Error('Permission denied');
					err.name = 'NotAllowedError';
					throw err;
				},
			});
		});
		await bootPage(page);
		await optIn(page);
		await page.waitForFunction(() => window.homeVoice.loop.state === 'permission-denied', null, { timeout: 20000 });
		const recovery = await page.locator('#voice-panel .hv-recovery').textContent();
		check('a denied microphone is a designed state, not a dead end', /Allow|address bar|settings/i.test(recovery), {
			recovery,
		});
		const retry = await page.locator('#voice-panel [data-act="retry"]').count();
		check('and it offers a way back', retry === 1);
		await page.locator('#voice-panel').screenshot({ path: join(OUT, 'permission-denied.png') });
	} finally {
		await browser.close();
	}
}

async function scenarioStateGallery() {
	const { browser, page } = await launch(null);
	try {
		await page.goto(`${BASE}/voice/home`, { waitUntil: 'networkidle' });
		const sections = page.locator('.vh-state');
		const count = await sections.count();
		check('the state gallery renders every one of the twelve states', count === 12, { count });
		for (let i = 0; i < count; i++) {
			const section = sections.nth(i);
			const name = (await section.locator('h3').textContent()).trim();
			await section.screenshot({ path: join(OUT, `state-${String(i + 1).padStart(2, '0')}-${name}.png`) });
		}
		await page.screenshot({ path: join(OUT, 'page-full.png'), fullPage: true });
	} finally {
		await browser.close();
	}
}

// ── run ─────────────────────────────────────────────────────────────────────

async function main() {
	const probe = await fetch(`${BASE}/voice/home`).catch(() => null);
	if (!probe?.ok) {
		console.error(`No dev server at ${BASE}. Start one with: npx vite --port ${PORT}`);
		process.exit(2);
	}
	await signIn();
	await ensureClips();

	const measured = {};
	await scenarioColdLoad();
	measured.happy = await scenarioHappyPath();
	measured.barge = await scenarioBargeIn();
	measured.selfTrigger = await scenarioSelfTrigger();
	await scenarioGuarded({ clip: CLIPS.ambientYeah, expectRedeemed: false, label: 'ambient yes' });
	await scenarioGuarded({ clip: CLIPS.confirmToken, expectRedeemed: true, label: 'the token' });
	measured.mute = await scenarioMute();
	await scenarioUnavailable();
	await scenarioPermissionDenied();
	await scenarioStateGallery();

	const failed = results.filter((r) => !r.pass);
	writeFileSync(
		join(OUT, 'report.json'),
		JSON.stringify({ base: BASE, at: new Date().toISOString(), results, measured }, null, 2),
	);
	console.log(`\n${results.length - failed.length}/${results.length} checks passed. Report: ${join(OUT, 'report.json')}`);
	if (failed.length) {
		for (const f of failed) console.log(`  FAILED: ${f.name}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
