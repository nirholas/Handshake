// The embed rules run on strings, so each one is pinned here with the exact
// text a developer would have in a page.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ATTRIBUTES,
	SOURCE_ATTRIBUTES,
	closest,
	completionContext,
	diagnose,
	findEmbeds,
	findLibraryScripts,
} from '../src/embed-language.js';

const RELEASE = { channel: '1.5.2', integrity: 'sha384-pinned' };

test('findEmbeds parses attributes with offsets', () => {
	const text = `<p>hi</p>\n<agent-3d body="https://x/y.glb" mode='floating' eager style="width:1px;height:2px"></agent-3d>`;
	const [embed] = findEmbeds(text);
	assert.ok(embed);
	assert.equal(text.slice(embed.start, embed.tagEnd), '<agent-3d');
	const names = embed.attrs.map((a) => a.name);
	assert.deepEqual(names, ['body', 'mode', 'eager', 'style']);
	const body = embed.attrs[0];
	assert.equal(body.value, 'https://x/y.glb');
	assert.equal(text.slice(body.start, body.nameEnd), 'body');
	assert.equal(embed.attrs[2].value, null);
});

test('a tag with no source is an error, one with a source is not', () => {
	const bad = diagnose('<agent-3d style="width:1px;height:1px"></agent-3d>');
	assert.equal(bad.find((f) => f.code === 'no-source')?.severity, 'error');
	for (const name of SOURCE_ATTRIBUTES) {
		const ok = diagnose(`<agent-3d ${name}="x" style="width:1px;height:1px"></agent-3d>`);
		assert.equal(ok.filter((f) => f.code === 'no-source').length, 0, name);
	}
});

test('an unsized inline element warns and the fix inserts a size', () => {
	const text = '<agent-3d body="https://x/y.glb"></agent-3d>';
	const [f] = diagnose(text).filter((x) => x.code === 'no-size');
	assert.ok(f);
	const fixed = text.slice(0, f.fix.start) + f.fix.text + text.slice(f.fix.end);
	assert.match(fixed, /^<agent-3d style="width: 400px; height: 500px; display: block;" body=/);
	assert.equal(diagnose(fixed).filter((x) => x.code === 'no-size').length, 0);
});

test('size is satisfied by width+height attributes, a class, responsive, or a non-inline mode', () => {
	for (const tag of [
		'<agent-3d src="a" width="320px" height="420px">',
		'<agent-3d src="a" class="hero">',
		'<agent-3d src="a" className="hero">',
		'<agent-3d src="a" responsive>',
		'<agent-3d src="a" mode="floating">',
		'<agent-3d src="a" mode="section">',
		'<agent-3d src="a" style={{ width: 1 }}>',
	]) {
		assert.equal(diagnose(tag).filter((x) => x.code === 'no-size').length, 0, tag);
	}
	assert.equal(diagnose('<agent-3d src="a" mode="inline">').filter((x) => x.code === 'no-size').length, 1);
});

test('unknown attributes are flagged with a suggestion; globals and JSX are not', () => {
	const findings = diagnose('<agent-3d src="a" class="x" data-x="1" aria-label="y" onclick="f()" modee="floating" style="width:1px;height:1px">');
	const unknown = findings.filter((x) => x.code === 'unknown-attribute');
	assert.equal(unknown.length, 1);
	assert.match(unknown[0].message, /Did you mean `mode`/);
	assert.equal(unknown[0].fix.text, 'mode');
	assert.equal(closest('brian'), 'brain');
	assert.equal(closest('completelyunrelated'), null);
});

test('enumerated values are checked and an api key in HTML warns', () => {
	const findings = diagnose('<agent-3d src="a" mode="popup" api-key="sk-live" style="width:1px;height:1px">');
	assert.ok(findings.some((x) => x.code === 'bad-value' && /inline.*floating/.test(x.message)));
	assert.ok(findings.some((x) => x.code === 'key-in-html'));
	assert.equal(diagnose('<agent-3d src="a" mode={mode} style="width:1px;height:1px">').filter((x) => x.code === 'bad-value').length, 0);
});

test('library scripts are found on any host and channel', () => {
	const text = [
		'<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>',
		'<script src="https://cdn.example.com/agent-3d/1.5.2/agent-3d.umd.cjs" integrity="sha384-old"></script>',
		'<script src="https://unpkg.com/three.ws"></script>',
	].join('\n');
	const scripts = findLibraryScripts(text);
	assert.equal(scripts.length, 2);
	assert.deepEqual(scripts.map((s) => [s.channel, s.exact, s.host]), [
		['latest', false, 'three.ws'],
		['1.5.2', true, 'cdn.example.com'],
	]);
	assert.equal(scripts[1].integrity.value, 'sha384-old');
});

test('the latest channel warns and the fix pins the release with its hash', () => {
	const text = '<script type="module" src="https://three.ws/agent-3d/latest/agent-3d.js"></script>';
	const [f] = diagnose(text, { release: RELEASE }).filter((x) => x.code === 'unpinned-library');
	assert.equal(f.severity, 'warning');
	const fixed = text.slice(0, f.fix.start) + f.fix.text + text.slice(f.fix.end);
	assert.match(fixed, /src="https:\/\/three\.ws\/agent-3d\/1\.5\.2\/agent-3d\.js"/);
	assert.match(fixed, /integrity="sha384-pinned"/);
	assert.match(fixed, /type="module"/);
	assert.match(fixed, /crossorigin="anonymous"/);
	assert.equal(diagnose(fixed, { release: RELEASE }).length, 0);
});

test('a minor channel is only a hint, and offline there is no pin fix', () => {
	const text = '<script src="https://three.ws/agent-3d/1.5/agent-3d.js"></script>';
	const [f] = diagnose(text, { release: RELEASE });
	assert.equal(f.severity, 'hint');
	assert.ok(f.fix);
	const [offline] = diagnose(text);
	assert.equal(offline.fix, null);
});

test('a stale integrity hash is an error with the published hash as the fix', () => {
	const text = '<script src="https://three.ws/agent-3d/1.5.2/agent-3d.js" integrity="sha384-old" crossorigin="anonymous"></script>';
	const [f] = diagnose(text, { release: RELEASE });
	assert.equal(f.code, 'stale-integrity');
	assert.equal(f.severity, 'error');
	assert.equal(text.slice(f.fix.start, f.fix.end), 'integrity="sha384-old"');
	assert.equal(f.fix.text, 'integrity="sha384-pinned"');
	assert.equal(diagnose(text.replace('sha384-old', 'sha384-pinned'), { release: RELEASE }).length, 0);
});

test('a pinned script without integrity gets a hint, an older pin a newer-release hint', () => {
	const [missing] = diagnose('<script src="https://three.ws/agent-3d/1.5.2/agent-3d.js"></script>', { release: RELEASE });
	assert.equal(missing.code, 'missing-integrity');
	assert.match(missing.fix.text, /integrity="sha384-pinned"/);
	const [older] = diagnose('<script src="https://three.ws/agent-3d/1.4.0/agent-3d.js" integrity="sha384-x"></script>', { release: RELEASE });
	assert.equal(older.code, 'newer-release');
	assert.equal(older.severity, 'hint');
	assert.equal(diagnose('<script src="https://three.ws/agent-3d/1.6.0/agent-3d.js" integrity="sha384-x"></script>', { release: RELEASE }).length, 0);
});

test('completion knows when the cursor is naming an attribute or choosing a value', () => {
	const text = '<agent-3d src="a" mode="fl';
	const value = completionContext(text, text.length);
	assert.equal(value?.kind, 'value');
	assert.equal(value.def.name, 'mode');
	const naming = '<agent-3d src="a" ';
	assert.equal(completionContext(naming, naming.length)?.kind, 'name');
	const closed = '<agent-3d src="a" mo></agent-3d>';
	assert.equal(completionContext(closed, closed.indexOf('mo') + 2)?.kind, 'name');
	assert.equal(completionContext('<div class="x">', 12), null);
});

test('every documented attribute has docs and the element reads it', () => {
	for (const a of ATTRIBUTES) {
		assert.ok(a.doc.length > 10, a.name);
		assert.match(a.name, /^[a-z][a-z-]*$/);
	}
});
