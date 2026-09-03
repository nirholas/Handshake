// The satellite service: the TCP session Home Assistant drives, the tokens that
// decide who may watch it, and the hub that joins the two.
//
// Every test here drives real sockets. The "Home Assistant" on the other end is
// a client speaking the real protocol through this repo's own encoder, because
// the failures worth catching are wire failures: an info probe that kills the
// live session, a `played` that never arrives and hangs an announcement, a
// viewer that presents a token for somebody else's house.

import { afterEach, describe, expect, it } from 'vitest';
import { connect } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';

import {
	EVENT,
	EventDecoder,
	encodeEvent,
	audioChunkEvent,
	audioStartEvent,
	audioStopEvent,
	pingEvent,
	readAudioFormat,
} from '../services/home-satellite/src/protocol.js';
import { WyomingSatellite } from '../services/home-satellite/src/satellite.js';
import { createHub, createViewerServer, attachViewer } from '../services/home-satellite/src/bridge.js';
import { ROLE, signToken, verifyToken, newSecret } from '../services/home-satellite/src/token.js';
import { STATE, MIC_MODE, readViewerMessage, readServiceMessage } from '../services/home-satellite/src/session.js';

const cleanups = [];
const cleanup = (fn) => cleanups.push(fn);
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()().catch(() => {});
});

/** A Home Assistant, near enough: it speaks the real protocol over a real socket. */
async function fakeHomeAssistant(port) {
	const socket = connect(port, '127.0.0.1');
	await once(socket, 'connect');
	const decoder = new EventDecoder();
	const events = [];
	const waiters = [];
	socket.on('data', (chunk) => {
		for (const event of decoder.push(chunk)) {
			events.push(event);
			for (const waiter of waiters.splice(0)) waiter(event);
		}
	});
	const client = {
		socket,
		events,
		send: (event) => socket.write(encodeEvent(event)),
		/** Resolve with the next event of a type, or reject after a timeout. */
		next(type, ms = 5000) {
			const already = events.find((e) => e.type === type && !e._taken);
			if (already) {
				already._taken = true;
				return Promise.resolve(already);
			}
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no ${type} within ${ms}ms`)), ms);
				const onEvent = (event) => {
					if (event.type !== type) {
						waiters.push(onEvent);
						return;
					}
					clearTimeout(timer);
					event._taken = true;
					resolve(event);
				};
				waiters.push(onEvent);
			});
		},
		close: () => new Promise((resolve) => {
			socket.end(resolve);
			socket.destroy();
		}),
	};
	cleanup(client.close);
	return client;
}

async function startSatellite(options = {}) {
	const satellite = new WyomingSatellite({
		name: 'Kitchen display',
		description: 'A face',
		version: '1.0.0',
		paired: true,
		...options,
	});
	const address = await satellite.listen(0, '127.0.0.1');
	cleanup(() => satellite.close());
	return { satellite, port: address.port };
}

describe('the Wyoming session', () => {
	it('answers describe with an info that names this satellite', async () => {
		const { port } = await startSatellite();
		const ha = await fakeHomeAssistant(port);
		ha.send({ type: EVENT.DESCRIBE });
		const info = await ha.next(EVENT.INFO);
		expect(info.data.satellite.name).toBe('Kitchen display');
	});

	it('answers ping with a pong carrying the same text', async () => {
		const { port } = await startSatellite();
		const ha = await fakeHomeAssistant(port);
		ha.send(pingEvent('are you there'));
		const pong = await ha.next(EVENT.PONG);
		expect(pong.data.text).toBe('are you there');
	});

	it('goes to idle when Home Assistant says it is ready', async () => {
		const { satellite, port } = await startSatellite();
		expect(satellite.state).toBe(STATE.DISCONNECTED);
		const ha = await fakeHomeAssistant(port);
		ha.send({ type: EVENT.RUN_SATELLITE });
		await once(satellite, 'ha-connected');
		expect(satellite.state).toBe(STATE.IDLE);
		expect(satellite.connected).toBe(true);
	});

	it('survives the info probe Home Assistant opens alongside the live socket', async () => {
		// The config entry's info coordinator opens its own connection every 30
		// seconds. A satellite that assumes one connection tears down the live
		// session each time, and reconnects forever without completing a run.
		const { satellite, port } = await startSatellite();
		const live = await fakeHomeAssistant(port);
		live.send({ type: EVENT.RUN_SATELLITE });
		await once(satellite, 'ha-connected');

		const probe = await fakeHomeAssistant(port);
		probe.send({ type: EVENT.DESCRIBE });
		await probe.next(EVENT.INFO);
		await probe.close();
		await new Promise((r) => setTimeout(r, 60));

		expect(satellite.connected).toBe(true);
		expect(satellite.state).toBe(STATE.IDLE);
	});

	it('ignores pipeline events arriving on a probe socket', async () => {
		const { satellite, port } = await startSatellite();
		const live = await fakeHomeAssistant(port);
		live.send({ type: EVENT.RUN_SATELLITE });
		await once(satellite, 'ha-connected');

		const probe = await fakeHomeAssistant(port);
		probe.send({ type: EVENT.TRANSCRIPT, data: { text: 'this should be ignored' } });
		await new Promise((r) => setTimeout(r, 80));
		expect(satellite.state).toBe(STATE.IDLE);
	});

	it('walks the pipeline states as Home Assistant reports them', async () => {
		const { satellite, port } = await startSatellite();
		const ha = await fakeHomeAssistant(port);
		ha.send({ type: EVENT.RUN_SATELLITE });
		await once(satellite, 'ha-connected');

		const seen = [];
		satellite.on('state', ({ state }) => seen.push(state));
		const transcripts = [];
		satellite.on('transcript', (t) => transcripts.push(t));

		ha.send({ type: EVENT.DETECTION, data: { name: 'ok_nabu' } });
		ha.send({ type: EVENT.TRANSCRIBE, data: { language: 'en' } });
		ha.send({ type: EVENT.VOICE_STARTED, data: { timestamp: 0 } });
		ha.send({ type: EVENT.VOICE_STOPPED, data: { timestamp: 900 } });
		ha.send({ type: EVENT.TRANSCRIPT, data: { text: 'turn off the kitchen lights' } });
		ha.send({ type: EVENT.SYNTHESIZE, data: { text: 'Turned off the light' } });
		await new Promise((r) => setTimeout(r, 120));

		expect(seen).toContain(STATE.WAKE);
		expect(seen).toContain(STATE.LISTENING);
		expect(seen).toContain(STATE.THINKING);
		expect(transcripts.at(-1)).toEqual({ text: 'turn off the kitchen lights', final: true });
	});

	it('surfaces a pipeline error instead of freezing mid sentence', async () => {
		const { satellite, port } = await startSatellite();
		const ha = await fakeHomeAssistant(port);
		ha.send({ type: EVENT.RUN_SATELLITE });
		await once(satellite, 'ha-connected');

		const failed = once(satellite, 'pipeline-error');
		ha.send({ type: EVENT.ERROR, data: { text: 'Language en-us not supported', code: 'tts-not-supported' } });
		const [error] = await failed;
		expect(error).toEqual({ text: 'Language en-us not supported', code: 'tts-not-supported' });
		expect(satellite.state).toBe(STATE.ERROR);
	});
});

describe('the microphone', () => {
	it('asks for a wake-word run and streams audio into it', async () => {
		const { satellite, port } = await startSatellite();
		const ha = await fakeHomeAssistant(port);
		ha.send({ type: EVENT.RUN_SATELLITE });
		await once(satellite, 'ha-connected');

		expect(satellite.startMic(MIC_MODE.WAKE)).toBe(true);
		const run = await ha.next(EVENT.RUN_PIPELINE);
		expect(run.data).toMatchObject({ start_stage: 'wake', end_stage: 'tts', restart_on_end: true });
		await ha.next(EVENT.AUDIO_START);

		satellite.pushMic(Buffer.alloc(640, 1));
		const chunk = await ha.next(EVENT.AUDIO_CHUNK);
		expect(readAudioFormat(chunk.data)).toEqual({ rate: 16000, width: 2, channels: 1 });
		expect(chunk.payload).toHaveLength(640);

		satellite.stopMic();
		await ha.next(EVENT.AUDIO_STOP);
	});

	it('asks for a speech-to-text run when the mode is push to talk', async () => {
		const { satellite, port } = await startSatellite();
		const ha = await fakeHomeAssistant(port);
		ha.send({ type: EVENT.RUN_SATELLITE });
		await once(satellite, 'ha-connected');

		satellite.startMic(MIC_MODE.COMMAND);
		const run = await ha.next(EVENT.RUN_PIPELINE);
		expect(run.data).toMatchObject({ start_stage: 'asr', end_stage: 'tts', restart_on_end: false });
	});

	it('refuses to open when Home Assistant is not connected', async () => {
		const { satellite } = await startSatellite();
		expect(satellite.startMic()).toBe(false);
	});

	it('drops microphone audio while the agent is speaking', async () => {
		// A display with speakers a metre from its microphone would otherwise hear
		// its own answer and wake itself up, forever.
		const { satellite, port } = await startSatellite();
		const ha = await fakeHomeAssistant(port);
		ha.send({ type: EVENT.RUN_SATELLITE });
		await once(satellite, 'ha-connected');
		satellite.startMic();
		await ha.next(EVENT.AUDIO_START);

		ha.send(audioStartEvent({ rate: 22050, width: 2, channels: 1 }));
		await new Promise((r) => setTimeout(r, 60));
		expect(satellite.pushMic(Buffer.alloc(320))).toBe(false);
	});
});

describe('telling Home Assistant the answer finished playing', () => {
	it('answers immediately when nobody is watching', async () => {
		// The pipeline must never wait on a browser. An announcement blocks until
		// `played`, and a closed tab must not hang somebody's automation.
		const { port } = await startSatellite({ hasViewer: () => false });
		const ha = await fakeHomeAssistant(port);
		ha.send({ type: EVENT.RUN_SATELLITE });
		await ha.next(EVENT.INFO).catch(() => {});

		ha.send(audioStartEvent({ rate: 22050, width: 2, channels: 1 }));
		ha.send(audioChunkEvent({ rate: 22050, width: 2, channels: 1, audio: Buffer.alloc(4410) }));
		ha.send(audioStopEvent(100));
		const played = await ha.next(EVENT.PLAYED, 2000);
		expect(played.type).toBe(EVENT.PLAYED);
	});

	it('waits for a viewer that is attached, then answers when it reports back', async () => {
		const { satellite, port } = await startSatellite({ hasViewer: () => true });
		const ha = await fakeHomeAssistant(port);
		ha.send({ type: EVENT.RUN_SATELLITE });
		await new Promise((r) => setTimeout(r, 50));

		ha.send(audioStartEvent({ rate: 22050, width: 2, channels: 1 }));
		ha.send(audioChunkEvent({ rate: 22050, width: 2, channels: 1, audio: Buffer.alloc(44100) }));
		ha.send(audioStopEvent(1000));
		await new Promise((r) => setTimeout(r, 150));
		expect(ha.events.some((e) => e.type === EVENT.PLAYED)).toBe(false);

		satellite.reportPlayed();
		const played = await ha.next(EVENT.PLAYED, 2000);
		expect(played.type).toBe(EVENT.PLAYED);
	});

	it('sends played only once per answer', async () => {
		const { satellite, port } = await startSatellite({ hasViewer: () => true });
		const ha = await fakeHomeAssistant(port);
		ha.send({ type: EVENT.RUN_SATELLITE });
		await new Promise((r) => setTimeout(r, 50));
		ha.send(audioStartEvent({ rate: 22050, width: 2, channels: 1 }));
		ha.send(audioStopEvent(0));
		await new Promise((r) => setTimeout(r, 60));
		satellite.reportPlayed();
		satellite.reportPlayed();
		await new Promise((r) => setTimeout(r, 80));
		expect(ha.events.filter((e) => e.type === EVENT.PLAYED)).toHaveLength(1);
	});
});

describe('an unpaired satellite', () => {
	it('tells Home Assistant why it is refusing, then hangs up', async () => {
		const { port } = await startSatellite({ paired: false });
		const ha = await fakeHomeAssistant(port);
		const error = await ha.next(EVENT.ERROR);
		expect(error.data.code).toBe('unpaired');
		expect(error.data.text).toMatch(/has not been paired/);
	});
});

describe('viewer tokens', () => {
	const secret = newSecret();

	it('round trips a signed claim', () => {
		const token = signToken({ sid: 'sat-1', role: ROLE.VIEWER }, secret, 60);
		const check = verifyToken(token, secret);
		expect(check.ok).toBe(true);
		expect(check.claims).toMatchObject({ sid: 'sat-1', role: ROLE.VIEWER });
	});

	it('refuses a token signed with a different key', () => {
		const token = signToken({ sid: 'sat-1', role: ROLE.VIEWER }, secret, 60);
		expect(verifyToken(token, newSecret())).toEqual({ ok: false, reason: 'signature' });
	});

	it('refuses a token whose claims were edited', () => {
		const token = signToken({ sid: 'sat-1', role: ROLE.VIEWER }, secret, 60);
		const [version, body, sig] = token.split('.');
		const forged = Buffer.from(JSON.stringify({ sid: 'somebody-elses-house', role: ROLE.VIEWER, exp: 2 ** 40 })).toString('base64url');
		expect(verifyToken([version, forged, sig].join('.'), secret).ok).toBe(false);
	});

	it('refuses an expired token', () => {
		const token = signToken({ sid: 'sat-1', role: ROLE.VIEWER }, secret, 1);
		expect(verifyToken(token, secret, Math.floor(Date.now() / 1000) + 5)).toEqual({ ok: false, reason: 'expired' });
	});

	it('refuses malformed input without throwing', () => {
		for (const bad of ['', 'nope', 'v2.a.b', 'v1.a', null, undefined, 42]) {
			expect(verifyToken(bad, secret).ok).toBe(false);
		}
	});

	it('refuses to mint a token with no room or an unknown role', () => {
		expect(() => signToken({ role: ROLE.VIEWER }, secret, 60)).toThrow(/sid required/);
		expect(() => signToken({ sid: 'x', role: 'admin' }, secret, 60)).toThrow(/unknown role/);
		expect(() => signToken({ sid: 'x', role: ROLE.VIEWER }, secret, 0)).toThrow(/positive/);
	});
});

describe('the viewer server on the local network', () => {
	async function startViewerServer() {
		const { satellite, port: wyomingPort } = await startSatellite();
		const secret = newSecret();
		const server = createViewerServer({
			satellite,
			satelliteId: 'sat-1',
			secret,
			identity: { name: 'Kitchen display', agent: { id: 'a', name: 'Ada', avatarUrl: null }, version: '1.0.0' },
		});
		const address = await server.listen(0, '127.0.0.1');
		cleanup(() => server.close());
		return { satellite, server, secret, wyomingPort, url: `ws://127.0.0.1:${address.port}/viewer` };
	}

	it('greets a viewer with a hello that names the agent', async () => {
		const { secret, url } = await startViewerServer();
		const token = signToken({ sid: 'sat-1', role: ROLE.VIEWER }, secret, 60);
		const ws = new WebSocket(`${url}?token=${token}`);
		cleanup(async () => ws.close());
		const inbox = [];
		ws.on('message', (raw) => inbox.push(raw));
		await once(ws, 'open');
		while (!inbox.length) await new Promise((r) => setTimeout(r, 20));
		const hello = JSON.parse(inbox[0].toString('utf8'));
		expect(hello.t).toBe('hello');
		expect(hello.satellite.agent.name).toBe('Ada');
	});

	it('closes a viewer that presents a token for another satellite', async () => {
		const { secret, url } = await startViewerServer();
		const token = signToken({ sid: 'somebody-elses-house', role: ROLE.VIEWER }, secret, 60);
		const ws = new WebSocket(`${url}?token=${token}`);
		const [code] = await once(ws, 'close');
		expect(code).toBe(4401);
	});

	it('closes a viewer with no token at all', async () => {
		const { url } = await startViewerServer();
		const ws = new WebSocket(url);
		const [code] = await once(ws, 'close');
		expect(code).toBe(4401);
	});

	it('forwards a viewer microphone into the Wyoming session', async () => {
		const { satellite, secret, url, wyomingPort } = await startViewerServer();
		const ha = await fakeHomeAssistant(wyomingPort);
		ha.send({ type: EVENT.RUN_SATELLITE });
		await once(satellite, 'ha-connected');

		const token = signToken({ sid: 'sat-1', role: ROLE.VIEWER }, secret, 60);
		const ws = new WebSocket(`${url}?token=${token}`);
		cleanup(async () => ws.close());
		await once(ws, 'open');
		ws.send(JSON.stringify({ t: 'mic-start', mode: 'command' }));
		await ha.next(EVENT.AUDIO_START);
		ws.send(Buffer.alloc(320, 5));
		const chunk = await ha.next(EVENT.AUDIO_CHUNK);
		expect(chunk.payload).toHaveLength(320);
	});

	it('closes a viewer that sends a message it does not recognize', async () => {
		const { secret, url } = await startViewerServer();
		const token = signToken({ sid: 'sat-1', role: ROLE.VIEWER }, secret, 60);
		const ws = new WebSocket(`${url}?token=${token}`);
		await once(ws, 'open');
		ws.send(JSON.stringify({ t: 'unlock-the-front-door' }));
		const [code] = await once(ws, 'close');
		expect(code).toBe(4400);
	});

	it('stops the microphone when the last viewer leaves', async () => {
		const { satellite, secret, url, wyomingPort } = await startViewerServer();
		const ha = await fakeHomeAssistant(wyomingPort);
		ha.send({ type: EVENT.RUN_SATELLITE });
		await once(satellite, 'ha-connected');

		const token = signToken({ sid: 'sat-1', role: ROLE.VIEWER }, secret, 60);
		const ws = new WebSocket(`${url}?token=${token}`);
		await once(ws, 'open');
		ws.send(JSON.stringify({ t: 'mic-start', mode: 'command' }));
		await ha.next(EVENT.AUDIO_START);
		ws.close();
		await ha.next(EVENT.AUDIO_STOP);
		expect(satellite.micOpen).toBe(false);
	});
});

describe('the hub', () => {
	async function startHub() {
		const secret = newSecret();
		const hub = createHub({ secret });
		const address = await hub.listen(0, '127.0.0.1');
		cleanup(() => hub.close());
		return { hub, secret, url: `ws://127.0.0.1:${address.port}/room` };
	}

	// Buffer from construction. The hub greets a joining viewer immediately, and
	// a listener attached after the `open` event can miss a message that arrived
	// in the same tick, which reads as a hang rather than as a race.
	const open = async (url, secret, sid, role) => {
		const ws = new WebSocket(`${url}?token=${signToken({ sid, role }, secret, 60)}`);
		cleanup(async () => ws.close());
		const inbox = [];
		const waiters = [];
		ws.on('message', (raw, isBinary) => {
			const entry = { raw, isBinary };
			const waiter = waiters.shift();
			if (waiter) waiter(entry);
			else inbox.push(entry);
		});
		ws.nextMessage = (ms = 5000) => {
			if (inbox.length) return Promise.resolve(inbox.shift());
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`no message within ${ms}ms`)), ms);
				waiters.push((entry) => {
					clearTimeout(timer);
					resolve(entry);
				});
			});
		};
		ws.drain = () => inbox.splice(0);
		await once(ws, 'open');
		return ws;
	};

	it('refuses a socket with no valid token', async () => {
		const { url } = await startHub();
		const ws = new WebSocket(`${url}?token=nonsense`);
		const [code] = await once(ws, 'close');
		expect(code).toBe(4401);
	});

	it('forwards what the satellite says to every viewer in its room', async () => {
		const { url, secret } = await startHub();
		const satellite = await open(url, secret, 'sat-1', ROLE.SATELLITE);
		const one = await open(url, secret, 'sat-1', ROLE.VIEWER);
		const two = await open(url, secret, 'sat-1', ROLE.VIEWER);
		await new Promise((r) => setTimeout(r, 40));

		one.drain();
		two.drain();
		satellite.send(JSON.stringify({ t: 'state', state: 'speaking' }));
		const [a, b] = await Promise.all([one.nextMessage(), two.nextMessage()]);
		expect(JSON.parse(a.raw.toString()).state).toBe('speaking');
		expect(JSON.parse(b.raw.toString()).state).toBe('speaking');
	});

	it('keeps two rooms apart', async () => {
		const { url, secret } = await startHub();
		const mine = await open(url, secret, 'sat-1', ROLE.SATELLITE);
		const theirs = await open(url, secret, 'sat-2', ROLE.VIEWER);
		await new Promise((r) => setTimeout(r, 40));

		theirs.drain();
		mine.send(JSON.stringify({ t: 'state', state: 'speaking' }));
		await new Promise((r) => setTimeout(r, 200));
		const heard = await theirs.nextMessage(200).catch(() => null);
		expect(heard).toBeNull();
	});

	it('replays the hello a late viewer missed', async () => {
		const { url, secret } = await startHub();
		const satellite = await open(url, secret, 'sat-1', ROLE.SATELLITE);
		satellite.send(JSON.stringify({ t: 'hello', satellite: { name: 'Kitchen display' }, state: 'idle' }));
		await new Promise((r) => setTimeout(r, 60));

		const viewer = await open(url, secret, 'sat-1', ROLE.VIEWER);
		const { raw } = await viewer.nextMessage();
		expect(JSON.parse(raw.toString()).satellite.name).toBe('Kitchen display');
	});

	it('tells a viewer the satellite is offline when no satellite has joined', async () => {
		const { url, secret } = await startHub();
		const viewer = await open(url, secret, 'sat-9', ROLE.VIEWER);
		const { raw } = await viewer.nextMessage();
		const message = JSON.parse(raw.toString());
		expect(message).toMatchObject({ t: 'state', state: STATE.DISCONNECTED });
	});

	it('gives the microphone to one viewer at a time', async () => {
		// One house, one microphone. Two open tabs streaming at once produce a
		// transcript that is a duet.
		const { url, secret } = await startHub();
		const satellite = await open(url, secret, 'sat-1', ROLE.SATELLITE);
		const first = await open(url, secret, 'sat-1', ROLE.VIEWER);
		const second = await open(url, secret, 'sat-1', ROLE.VIEWER);
		await new Promise((r) => setTimeout(r, 40));

		satellite.drain();
		const upstream = [];
		satellite.on('message', (raw, isBinary) => upstream.push(isBinary ? `binary:${raw.length}` : raw.toString()));

		first.send(JSON.stringify({ t: 'mic-start', mode: 'command' }));
		second.send(JSON.stringify({ t: 'mic-start', mode: 'command' }));
		await new Promise((r) => setTimeout(r, 60));
		first.send(Buffer.alloc(16));
		second.send(Buffer.alloc(32));
		await new Promise((r) => setTimeout(r, 120));

		expect(upstream.filter((m) => m.startsWith('binary'))).toEqual(['binary:16']);
		expect(upstream.filter((m) => m.includes('mic-start'))).toHaveLength(1);
	});

	it('tells the satellite to stop listening when the microphone holder leaves', async () => {
		const { url, secret } = await startHub();
		const satellite = await open(url, secret, 'sat-1', ROLE.SATELLITE);
		const viewer = await open(url, secret, 'sat-1', ROLE.VIEWER);
		await new Promise((r) => setTimeout(r, 40));
		viewer.send(JSON.stringify({ t: 'mic-start', mode: 'command' }));
		await satellite.nextMessage();
		viewer.close();
		const { raw } = await satellite.nextMessage();
		expect(JSON.parse(raw.toString()).t).toBe('mic-stop');
	});

	it('tells viewers when the satellite goes away', async () => {
		const { url, secret } = await startHub();
		const satellite = await open(url, secret, 'sat-1', ROLE.SATELLITE);
		const viewer = await open(url, secret, 'sat-1', ROLE.VIEWER);
		viewer.drain();
		satellite.close();
		const { raw } = await viewer.nextMessage();
		expect(JSON.parse(raw.toString())).toMatchObject({ t: 'state', state: STATE.DISCONNECTED });
	});
});

describe('the browser message set', () => {
	it('accepts what a viewer is allowed to say', () => {
		expect(readViewerMessage({ t: 'mic-start' })).toEqual({ t: 'mic-start', mode: 'wake' });
		expect(readViewerMessage({ t: 'mic-start', mode: 'command' })).toEqual({ t: 'mic-start', mode: 'command' });
		expect(readViewerMessage({ t: 'mic-stop' })).toEqual({ t: 'mic-stop' });
		expect(readViewerMessage({ t: 'played' })).toEqual({ t: 'played' });
	});

	it('rejects anything else, because the far end can actuate a house', () => {
		for (const bad of [null, 'mic-start', [], { t: 'call-service' }, { t: 'mic-start', mode: 'unlock' }]) {
			const parsed = readViewerMessage(bad);
			if (parsed) expect(parsed.mode).toBe('wake');
			else expect(parsed).toBeNull();
		}
		expect(readViewerMessage({ t: 'call-service' })).toBeNull();
	});

	it('rejects a service message that would paint a lie', () => {
		expect(readServiceMessage({ t: 'state', state: 'nonsense' })).toBeNull();
		expect(readServiceMessage({ t: 'audio-start', rate: 0, width: 2, channels: 1 })).toBeNull();
		expect(readServiceMessage({ t: 'transcript' })).toBeNull();
		expect(readServiceMessage({ t: 'audio-start', rate: 22050, width: 2, channels: 1 }))
			.toEqual({ t: 'audio-start', rate: 22050, width: 2, channels: 1 });
	});
});

describe('attaching a viewer directly', () => {
	it('mirrors satellite events onto the socket and stops on detach', async () => {
		const { satellite } = await startSatellite();
		const sent = [];
		const socket = {
			readyState: 1,
			send: (data) => sent.push(data),
			on: () => {},
			off: () => {},
		};
		const bound = attachViewer(satellite, socket, { identity: { name: 'x', agent: null, version: '1.0.0' } });
		satellite.emit('state', { state: STATE.SPEAKING, detail: 'Speaking' });
		bound.detach();
		satellite.emit('state', { state: STATE.IDLE, detail: 'Ready' });

		const types = sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
		expect(types[0].t).toBe('hello');
		expect(types.some((m) => m.state === STATE.SPEAKING)).toBe(true);
		expect(types.some((m) => m.state === STATE.IDLE)).toBe(false);
	});
});
