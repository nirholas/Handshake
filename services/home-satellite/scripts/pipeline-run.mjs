#!/usr/bin/env node
/**
 * End-to-end proof: speak a sentence into a real Home Assistant pipeline
 * through this satellite, and print what came back.
 *
 * It plays the part of the browser. It connects to the satellite's viewer
 * WebSocket exactly as src/home/satellite.js does, streams microphone audio
 * exactly as the browser's capture would, and receives the same events and the
 * same text-to-speech audio the avatar lip-syncs to. Nothing about the path is
 * simulated: Home Assistant runs its own speech recognition, its own intent
 * handling and its own text to speech, and the house really changes.
 *
 * The "microphone audio" is real speech, synthesized by the same piper
 * container Home Assistant uses for its answers, over the same Wyoming protocol
 * this service implements. There is no recorded fixture and no canned
 * transcript: whisper hears audio it has never seen and transcribes it.
 *
 *   node scripts/pipeline-run.mjs \
 *     --viewer ws://127.0.0.1:10701/viewer --token "$(node src/index.js token)" \
 *     --piper 127.0.0.1:10200 \
 *     --say "turn on the kitchen lights" \
 *     --ha http://127.0.0.1:8123 --ha-token <token> --watch light.kitchen_lights
 */

import { connect } from 'node:net';
import { writeFileSync } from 'node:fs';
import { WebSocket } from 'ws';

import { EventDecoder, encodeEvent, EVENT, readAudioFormat } from '../src/protocol.js';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? fallback : args[i + 1];
};

const VIEWER = arg('viewer', 'ws://127.0.0.1:10701/viewer');
const TOKEN = arg('token', process.env.SATELLITE_VIEWER_TOKEN || '');
const PIPER = arg('piper', '127.0.0.1:10200');
const PHRASE = arg('say', 'turn on the kitchen lights');
const HA = arg('ha', '').replace(/\/+$/, '');
const HA_TOKEN = arg('ha-token', process.env.HOME_ASSISTANT_TOKEN || '');
const WATCH = arg('watch', '');
const OUT = arg('out', '');
const MODE = arg('mode', 'command');

const log = (...a) => console.error('[run]', ...a);

/** Ask piper for speech, over the same Wyoming protocol this service speaks. */
function synthesize(hostPort, text) {
	const [host, port] = hostPort.split(':');
	return new Promise((resolve, reject) => {
		const socket = connect(Number(port), host, () => {
			socket.write(encodeEvent({ type: EVENT.SYNTHESIZE, data: { text } }));
		});
		const decoder = new EventDecoder();
		const chunks = [];
		let format = null;
		socket.on('data', (data) => {
			for (const event of decoder.push(data)) {
				if (event.type === EVENT.AUDIO_START) format = readAudioFormat(event.data);
				else if (event.type === EVENT.AUDIO_CHUNK) {
					if (!format) format = readAudioFormat(event.data);
					if (event.payload) chunks.push(event.payload);
				} else if (event.type === EVENT.AUDIO_STOP) {
					socket.end();
					resolve({ format, audio: Buffer.concat(chunks) });
				} else if (event.type === EVENT.ERROR) {
					socket.end();
					reject(new Error(`piper: ${event.data?.text}`));
				}
			}
		});
		socket.on('error', reject);
		socket.setTimeout(30_000, () => {
			socket.destroy();
			reject(new Error('piper did not answer in 30s'));
		});
	});
}

/** Linear resample of interleaved mono s16 to 16 kHz. */
function to16k(audio, rate) {
	if (rate === 16000) return audio;
	const inSamples = audio.length / 2;
	const ratio = rate / 16000;
	const outSamples = Math.floor(inSamples / ratio);
	const out = Buffer.alloc(outSamples * 2);
	for (let i = 0; i < outSamples; i += 1) {
		const pos = i * ratio;
		const idx = Math.floor(pos);
		const frac = pos - idx;
		const a = audio.readInt16LE(Math.min(idx, inSamples - 1) * 2);
		const b = audio.readInt16LE(Math.min(idx + 1, inSamples - 1) * 2);
		out.writeInt16LE(Math.round(a + (b - a) * frac), i * 2);
	}
	return out;
}

function wav(pcm, rate) {
	const header = Buffer.alloc(44);
	header.write('RIFF', 0);
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write('WAVE', 8);
	header.write('fmt ', 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(1, 22);
	header.writeUInt32LE(rate, 24);
	header.writeUInt32LE(rate * 2, 28);
	header.writeUInt16LE(2, 32);
	header.writeUInt16LE(16, 34);
	header.write('data', 36);
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

async function haState(entity) {
	if (!HA || !HA_TOKEN || !entity) return null;
	const res = await fetch(`${HA}/api/states/${entity}`, { headers: { authorization: `Bearer ${HA_TOKEN}` } });
	if (!res.ok) return null;
	return (await res.json()).state;
}

const main = async () => {
	if (!TOKEN) throw new Error('a viewer token is required: --token, or SATELLITE_VIEWER_TOKEN');

	log(`asking piper for "${PHRASE}"`);
	const speech = await synthesize(PIPER, PHRASE);
	const micPcm = to16k(speech.audio, speech.format?.rate || 22050);
	log(`got ${(micPcm.length / 32000).toFixed(2)}s of speech at 16 kHz`);

	const before = await haState(WATCH);
	if (WATCH) log(`${WATCH} before: ${before}`);

	const events = [];
	const ttsChunks = [];
	let ttsFormat = null;
	let transcript = null;
	let answer = null;

	const socket = new WebSocket(`${VIEWER}?token=${encodeURIComponent(TOKEN)}`);
	socket.binaryType = 'arraybuffer';

	const finished = new Promise((resolve, reject) => {
		const done = () => resolve();
		socket.on('open', async () => {
			log('viewer socket open');
			socket.send(JSON.stringify({ t: 'mic-start', mode: MODE }));
			// Stream in real-time-sized chunks. A pipeline with voice activity
			// detection needs the audio to arrive at roughly the rate a microphone
			// would produce it; firing the whole utterance in one write makes the
			// far end decide the speaker stopped before they started.
			const CHUNK = 1024 * 2; // 1024 samples, 64ms
			for (let offset = 0; offset < micPcm.length; offset += CHUNK) {
				socket.send(micPcm.subarray(offset, offset + CHUNK));
				await new Promise((r) => setTimeout(r, 55));
			}
			// A tail of silence: Home Assistant's voice activity detection needs to
			// hear the end of the sentence, and speech that stops at the last
			// syllable reads as speech that is still going.
			const silence = Buffer.alloc(CHUNK);
			for (let i = 0; i < 12; i += 1) {
				socket.send(silence);
				await new Promise((r) => setTimeout(r, 55));
			}
			socket.send(JSON.stringify({ t: 'mic-stop' }));
			log('finished streaming');
		});
		socket.on('message', (raw, isBinary) => {
			if (isBinary) {
				ttsChunks.push(Buffer.from(raw));
				return;
			}
			const message = JSON.parse(raw.toString('utf8'));
			events.push(message);
			if (message.t === 'state') log(`state: ${message.state}${message.detail ? ` (${message.detail})` : ''}`);
			if (message.t === 'transcript' && message.final) {
				transcript = message.text;
				log(`transcript: ${JSON.stringify(message.text)}`);
			}
			if (message.t === 'speech') {
				answer = message.text;
				log(`answer: ${JSON.stringify(message.text)}`);
			}
			if (message.t === 'audio-start') {
				ttsFormat = { rate: message.rate, width: message.width, channels: message.channels };
				log(`speaking at ${message.rate} Hz`);
			}
			if (message.t === 'audio-stop') {
				socket.send(JSON.stringify({ t: 'played' }));
				setTimeout(done, 400);
			}
			if (message.t === 'error') log(`pipeline error: ${message.code} ${message.text}`);
		});
		socket.on('error', reject);
		socket.on('close', (code, reason) => {
			if (code !== 1000 && code !== 1005) reject(new Error(`viewer socket closed ${code} ${reason}`));
			else done();
		});
		setTimeout(() => reject(new Error('no answer within 90s')), 90_000);
	});

	await finished;
	socket.close();

	const after = await haState(WATCH);
	const ttsAudio = Buffer.concat(ttsChunks);
	if (OUT && ttsAudio.length) {
		writeFileSync(OUT, wav(ttsAudio, ttsFormat?.rate || 22050));
		log(`wrote ${OUT} (${(ttsAudio.length / ((ttsFormat?.rate || 22050) * 2)).toFixed(2)}s)`);
	}

	console.log(JSON.stringify({
		said: PHRASE,
		transcript,
		answer,
		tts_bytes: ttsAudio.length,
		tts_format: ttsFormat,
		states: events.filter((e) => e.t === 'state').map((e) => e.state),
		watched: WATCH ? { entity: WATCH, before, after } : null,
	}, null, '\t'));
	process.exit(0);
};

main().catch((err) => {
	console.error(`[run] failed: ${err.message}`);
	process.exit(1);
});
