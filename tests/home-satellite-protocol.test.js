// The Wyoming wire format, checked against what the reference implementation
// actually writes rather than against what a blog post says it writes.
//
// Every case here is a shape that turned up while driving a real Home Assistant
// against this service: a header split from its data block by TCP, an event
// whose data is inline in the header instead of length-prefixed, a transcript
// with characters that make the byte length and the character length differ.

import { describe, expect, it } from 'vitest';

import {
	EVENT,
	STAGE,
	WYOMING_VERSION,
	EventDecoder,
	encodeEvent,
	infoEvent,
	runPipelineEvent,
	audioChunkEvent,
	pongEvent,
	errorEvent,
	readAudioFormat,
	readText,
	readError,
	readDetection,
	MIC_FORMAT,
	SND_FORMAT,
} from '../services/home-satellite/src/protocol.js';

const decodeAll = (buffers) => {
	const decoder = new EventDecoder();
	const out = [];
	for (const buffer of [].concat(buffers)) out.push(...decoder.push(buffer));
	return out;
};

describe('wyoming framing', () => {
	it('writes a header line, then the data block, then the payload', () => {
		const bytes = encodeEvent(audioChunkEvent({ ...MIC_FORMAT, timestamp: 0, audio: Buffer.from([1, 2, 3, 4]) }));
		const newline = bytes.indexOf(0x0a);
		const header = JSON.parse(bytes.subarray(0, newline).toString('utf8'));

		expect(header.type).toBe(EVENT.AUDIO_CHUNK);
		expect(header.version).toBe(WYOMING_VERSION);
		expect(header.payload_length).toBe(4);
		expect(typeof header.data_length).toBe('number');
		// The reference pops `data` out of the header and writes it as a block.
		expect(header.data).toBeUndefined();

		const dataStart = newline + 1;
		const data = JSON.parse(bytes.subarray(dataStart, dataStart + header.data_length).toString('utf8'));
		expect(data.rate).toBe(16000);
		expect([...bytes.subarray(dataStart + header.data_length)]).toEqual([1, 2, 3, 4]);
	});

	it('round trips an event through the decoder', () => {
		const [event] = decodeAll(encodeEvent(pongEvent('hello')));
		expect(event.type).toBe(EVENT.PONG);
		expect(event.data.text).toBe('hello');
		expect(event.payload).toBeNull();
	});

	it('measures data_length in bytes, not characters', () => {
		// A Spanish transcript is shorter in characters than it is in bytes, and
		// a decoder that reads characters walks off the end of the block and takes
		// the next event's header with it.
		const text = '¿Encendiste la luz del salón?';
		const bytes = encodeEvent({ type: EVENT.TRANSCRIPT, data: { text } });
		const header = JSON.parse(bytes.subarray(0, bytes.indexOf(0x0a)).toString('utf8'));
		expect(header.data_length).toBeGreaterThan(JSON.stringify({ text }).length);
		expect(header.data_length).toBe(Buffer.byteLength(JSON.stringify({ text }), 'utf8'));

		const [event] = decodeAll(bytes);
		expect(readText(event.data)).toBe(text);
	});

	it('reassembles an event split across arbitrary TCP reads', () => {
		const bytes = encodeEvent(audioChunkEvent({ ...SND_FORMAT, audio: Buffer.alloc(64, 7) }));
		for (const cut of [1, 5, 30, bytes.length - 40, bytes.length - 1]) {
			const events = decodeAll([bytes.subarray(0, cut), bytes.subarray(cut)]);
			expect(events).toHaveLength(1);
			expect(events[0].payload).toHaveLength(64);
		}
	});

	it('decodes several events arriving in one read', () => {
		const bytes = Buffer.concat([
			encodeEvent({ type: EVENT.DESCRIBE }),
			encodeEvent(pongEvent(null)),
			encodeEvent(audioChunkEvent({ ...MIC_FORMAT, audio: Buffer.alloc(8) })),
		]);
		expect(decodeAll(bytes).map((e) => e.type)).toEqual([EVENT.DESCRIBE, EVENT.PONG, EVENT.AUDIO_CHUNK]);
	});

	it('accepts data inline in the header, and lets the block win', () => {
		// The reference reader merges the length-prefixed block over any inline
		// copy. Something on the other end may still send the inline form.
		const block = Buffer.from(JSON.stringify({ text: 'from the block' }), 'utf8');
		const header = JSON.stringify({
			type: EVENT.TRANSCRIPT,
			data: { text: 'from the header', language: 'en' },
			data_length: block.length,
		});
		const [event] = decodeAll(Buffer.concat([Buffer.from(`${header}\n`), block]));
		expect(event.data.text).toBe('from the block');
		expect(event.data.language).toBe('en');
	});

	it('copies the payload instead of viewing the read buffer', () => {
		// A view would pin the whole read buffer for the life of the chunk, which
		// at fifty chunks a second is how a satellite grows without bound, and it
		// would also change under the caller when the socket reuses the buffer.
		const bytes = encodeEvent(audioChunkEvent({ ...MIC_FORMAT, audio: Buffer.alloc(32, 3) }));
		const [event] = decodeAll(bytes);
		bytes.fill(0);
		expect([...event.payload]).toEqual(Array(32).fill(3));
	});

	it('refuses a header that never ends', () => {
		const decoder = new EventDecoder({ maxHeaderBytes: 64 });
		expect(() => decoder.push(Buffer.alloc(65, 0x41))).toThrow(/header exceeded/);
	});

	it('refuses an absurd declared length', () => {
		const decoder = new EventDecoder({ maxPayloadBytes: 1024 });
		const header = `${JSON.stringify({ type: EVENT.AUDIO_CHUNK, payload_length: 99_999_999 })}\n`;
		expect(() => decoder.push(Buffer.from(header))).toThrow(/exceeds the 1024 byte limit/);
	});

	it('refuses a header that is not JSON, and one with no type', () => {
		expect(() => new EventDecoder().push(Buffer.from('not json\n'))).toThrow(/not valid JSON/);
		expect(() => new EventDecoder().push(Buffer.from('{"nope":1}\n'))).toThrow(/no type/);
	});

	it('refuses to encode an event with no type', () => {
		expect(() => encodeEvent({ data: {} })).toThrow(/non-empty string type/);
	});
});

describe('the info handshake', () => {
	const info = infoEvent({ name: 'Kitchen display', description: 'A face', area: 'Kitchen', version: '1.0.0' });

	it('carries the satellite artifact Home Assistant looks for', () => {
		// Without `satellite`, the integration sets up a plain Wyoming service and
		// never creates a satellite device. This is the field that makes us appear
		// under voice assistants.
		expect(info.data.satellite).toMatchObject({
			name: 'Kitchen display',
			installed: true,
			area: 'Kitchen',
			version: '1.0.0',
		});
	});

	it('attributes the protocol implementation to three.ws', () => {
		expect(info.data.satellite.attribution).toEqual({ name: 'three.ws', url: 'https://three.ws' });
	});

	it('declares no local wake words, because Home Assistant owns that stage', () => {
		expect(info.data.satellite.max_active_wake_words).toBe(0);
		expect(info.data.satellite.active_wake_words).toEqual([]);
		expect(info.data.wake).toEqual([]);
	});

	it('advertises the microphone and speaker formats the pipeline wants', () => {
		expect(info.data.mic[0].mic_format).toEqual({ rate: 16000, width: 2, channels: 1 });
		expect(info.data.snd[0].snd_format).toEqual({ rate: 22050, width: 2, channels: 1 });
	});

	it('omits area when the satellite has none', () => {
		const anonymous = infoEvent({ name: 'x', description: 'y', version: '1.0.0' });
		expect('area' in anonymous.data.satellite).toBe(false);
	});
});

describe('run-pipeline', () => {
	it('builds an always-on wake run', () => {
		const event = runPipelineEvent({ startStage: STAGE.WAKE, endStage: STAGE.TTS, restartOnEnd: true });
		expect(event.data).toEqual({ start_stage: 'wake', end_stage: 'tts', restart_on_end: true });
	});

	it('builds a push-to-talk run', () => {
		const event = runPipelineEvent({ startStage: STAGE.ASR, endStage: STAGE.TTS });
		expect(event.data.restart_on_end).toBe(false);
	});

	it('refuses a stage pair Home Assistant would reject', () => {
		// The far end raises ValueError and logs a traceback with no hint about
		// which side sent it, so this has to fail here.
		expect(() => runPipelineEvent({ startStage: STAGE.TTS, endStage: STAGE.ASR })).toThrow(/cannot end at/);
		expect(() => runPipelineEvent({ startStage: 'nonsense', endStage: STAGE.TTS })).toThrow(/unknown start stage/);
	});
});

describe('readers', () => {
	it('accepts a real audio format and rejects a broken one', () => {
		expect(readAudioFormat({ rate: 22050, width: 2, channels: 1 })).toEqual({ rate: 22050, width: 2, channels: 1 });
		expect(readAudioFormat({ rate: 0, width: 2, channels: 1 })).toBeNull();
		expect(readAudioFormat({ rate: 16000, width: 3, channels: 1 })).toBeNull();
		expect(readAudioFormat({ rate: 16000, width: 2, channels: 9 })).toBeNull();
		expect(readAudioFormat(null)).toBeNull();
	});

	it('reads an error with and without a code', () => {
		expect(readError({ text: 'boom', code: 'stt-provider-missing' })).toEqual({ text: 'boom', code: 'stt-provider-missing' });
		expect(readError({}).code).toBeNull();
		expect(readError({}).text).toMatch(/error/i);
	});

	it('reads a wake word name, and nothing from an empty detection', () => {
		expect(readDetection({ name: 'ok_nabu_v0.1' })).toBe('ok_nabu_v0.1');
		expect(readDetection({ name: '' })).toBeNull();
		expect(readDetection({})).toBeNull();
	});

	it('builds an error event the far end can classify', () => {
		expect(errorEvent('nope', 'unpaired').data).toEqual({ text: 'nope', code: 'unpaired' });
		expect(errorEvent('nope').data).toEqual({ text: 'nope' });
	});
});
