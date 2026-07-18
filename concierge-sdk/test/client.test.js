import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSseEvent, createSseBuffer } from '../src/client.js';
import { drainSentences } from '../src/widget.js';

test('parseSseEvent: JSON in, object out; noise in, null out', () => {
	assert.deepEqual(parseSseEvent('{"type":"chunk","text":"hi"}'), { type: 'chunk', text: 'hi' });
	assert.equal(parseSseEvent('[DONE]'), null);
	assert.equal(parseSseEvent(''), null);
	assert.equal(parseSseEvent('not json'), null);
	assert.equal(parseSseEvent('42'), null);
});

test('createSseBuffer reassembles frames across arbitrary chunk splits', () => {
	const events = [];
	const buf = createSseBuffer((e) => events.push(e));
	const wire = 'data: {"type":"chunk","text":"Hel"}\n\ndata: {"type":"chunk","text":"lo"}\n\ndata: {"type":"done","provider":"groq"}\n\n';
	// Feed one byte at a time — worst-case network fragmentation.
	for (const ch of wire) buf.push(ch);
	assert.equal(events.length, 3);
	assert.equal(events[0].text, 'Hel');
	assert.equal(events[1].text, 'lo');
	assert.equal(events[2].type, 'done');
});

test('createSseBuffer ignores comments and keep-alives', () => {
	const events = [];
	const buf = createSseBuffer((e) => events.push(e));
	buf.push(': keep-alive\n\ndata: {"type":"chunk","text":"x"}\n\n');
	assert.equal(events.length, 1);
	assert.equal(events[0].text, 'x');
});

test('drainSentences emits complete sentences, holds the tail', () => {
	const r1 = drainSentences('Hello there. How are');
	assert.deepEqual(r1.sentences, ['Hello there.']);
	assert.equal(r1.rest, 'How are');

	const r2 = drainSentences(r1.rest + ' you today? Fine!');
	assert.deepEqual(r2.sentences, ['How are you today?', 'Fine!']);
	assert.equal(r2.rest, '');

	const r3 = drainSentences('no terminator yet');
	assert.deepEqual(r3.sentences, []);
	assert.equal(r3.rest, 'no terminator yet');
});

test('drainSentences treats newlines as sentence breaks', () => {
	const r = drainSentences('First line\nSecond');
	assert.deepEqual(r.sentences, ['First line']);
	assert.equal(r.rest, 'Second');
});
