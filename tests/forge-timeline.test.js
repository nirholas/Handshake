// @vitest-environment jsdom
//
// The /forge generation timeline (src/forge-timeline.js). The property under
// test is the one the module exists to guarantee: every stage state is caused by
// a real /api/forge signal, and a lane that never performs a step never shows a
// row for it. A regression here would put the page back to inventing progress.

import { describe, it, expect, beforeEach } from 'vitest';
import { createForgeTimeline } from '../src/forge-timeline.js';

function mount() {
	document.body.innerHTML = `
		<div id="preview"></div>
		<ol id="stages"></ol>
		<div id="warming" class="is-hidden">
			<p class="gen-warming-title"></p>
			<p class="gen-warming-body"></p>
			<p class="gen-warming-count"></p>
		</div>`;
	return createForgeTimeline({
		list: document.getElementById('stages'),
		preview: document.getElementById('preview'),
		warming: document.getElementById('warming'),
		engineLabel: (id) => ({ nvidia: 'NVIDIA', trellis_selfhost: 'TRELLIS' })[id] || id,
	});
}

const stageIds = () =>
	[...document.querySelectorAll('#stages .step')].map((el) => el.dataset.stage);
const stateOf = (id) => document.querySelector(`#stages .step[data-stage="${id}"]`)?.dataset.state;
const labelOf = (id) =>
	document.querySelector(`#stages .step[data-stage="${id}"] .step-label`)?.textContent;

describe('forge timeline stages', () => {
	let timeline;
	beforeEach(() => {
		timeline = mount();
	});

	it('shows the director and reference stages for a text lane that paints one', () => {
		timeline.begin({ mode: 'text', backend: 'trellis_selfhost', usesReference: true });
		expect(stageIds()).toEqual(['direct', 'reference', 'mesh', 'finish']);
		// Before any response: the director is the only thing genuinely running.
		expect(stateOf('direct')).toBe('active');
		expect(stateOf('reference')).toBe('pending');
		expect(stateOf('mesh')).toBe('pending');
	});

	it('drops both stages for a lane that reports no reference view', () => {
		timeline.begin({ mode: 'text', backend: 'nvidia', usesReference: false });
		expect(stageIds()).toEqual(['input', 'mesh', 'finish']);
		timeline.applySubmit({ status: 'queued', backend: 'nvidia' });
		expect(stateOf('input')).toBe('done');
		expect(labelOf('mesh')).toContain('NVIDIA');
	});

	it('completes the director stage from directed_prompt, not from elapsed time', () => {
		timeline.begin({ mode: 'text', backend: 'trellis_selfhost', usesReference: true });
		timeline.tick(120); // two minutes of waiting changes nothing on its own
		expect(stateOf('direct')).toBe('active');
		const out = timeline.applySubmit({
			status: 'queued',
			backend: 'trellis_selfhost',
			directed_prompt: 'a chrome toaster, brushed steel body, warm diner light',
			preview_image_url: 'https://cdn.example/ref.png',
		});
		expect(out.directedPrompt).toBe('a chrome toaster, brushed steel body, warm diner light');
		expect(stateOf('direct')).toBe('done');
		expect(labelOf('direct')).toBe('Prompt art-directed');
		expect(stateOf('reference')).toBe('done');
	});

	it('says the prompt was used verbatim when no rewrite comes back', () => {
		timeline.begin({ mode: 'text', backend: 'trellis_selfhost', usesReference: true });
		timeline.applySubmit({ status: 'queued', preview_image_url: 'https://cdn.example/ref.png' });
		expect(labelOf('direct')).toBe('Prompt used as you wrote it');
	});

	it('reveals a reference view that only arrives on a later poll', () => {
		timeline.begin({ mode: 'text', backend: 'trellis_selfhost', usesReference: true });
		// A coalesced job answers with a job id and nothing else.
		timeline.applySubmit({ status: 'queued', coalesced: true, backend: 'trellis_selfhost' });
		expect(stateOf('reference')).toBe('active');
		expect(document.querySelector('#stages .step-thumb')).toBeNull();
		timeline.applyPoll({ status: 'running', preview_image_url: 'https://cdn.example/late.png' });
		expect(stateOf('reference')).toBe('done');
		expect(document.querySelector('#stages .step-thumb')?.getAttribute('href')).toBe(
			'https://cdn.example/late.png',
		);
	});

	it('names the lane a poll-time failover moved the job to', () => {
		timeline.begin({ mode: 'text', backend: 'trellis_selfhost', usesReference: true });
		timeline.applySubmit({ status: 'queued', backend: 'trellis_selfhost' });
		timeline.applyPoll({ status: 'running', backend: 'nvidia', failover_from: 'trellis_selfhost' });
		expect(labelOf('mesh')).toContain('NVIDIA');
		expect(
			document.querySelector('#stages .step[data-stage="mesh"] .step-detail').textContent,
		).toContain('TRELLIS');
	});

	it('starts an image run from the uploaded views, with no director stage', () => {
		timeline.begin({ mode: 'image', backend: 'trellis_selfhost', viewCount: 3 });
		expect(stageIds()).toEqual(['input', 'mesh', 'finish']);
		expect(labelOf('input')).toBe('Conditioning on 3 reference views');
		expect(stateOf('input')).toBe('done');
	});
});

describe('forge timeline cold start', () => {
	let timeline;
	beforeEach(() => {
		timeline = mount();
	});

	const warming = () => document.getElementById('warming');

	it('stays hidden when the API reports a warm lane', () => {
		timeline.begin({ mode: 'text', backend: 'trellis_selfhost', usesReference: true });
		timeline.applySubmit({ status: 'queued', cold_start: false, eta_seconds: 60 });
		expect(warming().classList.contains('is-hidden')).toBe(true);
	});

	it('counts down the real gap between the cold ETA and the warm estimate', () => {
		timeline.begin({ mode: 'text', backend: 'trellis_selfhost', usesReference: true });
		timeline.applySubmit(
			{ status: 'queued', backend: 'trellis_selfhost', cold_start: true, eta_seconds: 110 },
			{ warmEtaSeconds: 60 },
		);
		expect(warming().classList.contains('is-hidden')).toBe(false);
		timeline.tick(20);
		// 110 - 60 = a 50s boot budget; 30s of it is left after 20s elapsed.
		expect(warming().querySelector('.gen-warming-count').textContent).toContain('~30s');
		timeline.tick(80);
		expect(warming().dataset.phase).toBe('over');
	});

	it('ends the warming state on the first running poll, never on the clock', () => {
		timeline.begin({ mode: 'text', backend: 'trellis_selfhost', usesReference: true });
		timeline.applySubmit(
			{ status: 'queued', cold_start: true, eta_seconds: 110 },
			{ warmEtaSeconds: 60 },
		);
		timeline.tick(999);
		expect(warming().classList.contains('is-hidden')).toBe(false);
		expect(timeline.isCold()).toBe(true);
		timeline.applyPoll({ status: 'running' });
		expect(warming().classList.contains('is-hidden')).toBe(true);
		expect(timeline.isCold()).toBe(false);
	});

	it('drops the warming card when the job ends', () => {
		timeline.begin({ mode: 'text', backend: 'trellis_selfhost', usesReference: true });
		timeline.applySubmit(
			{ status: 'queued', cold_start: true, eta_seconds: 110 },
			{ warmEtaSeconds: 60 },
		);
		timeline.fail();
		expect(warming().classList.contains('is-hidden')).toBe(true);
	});
});

describe('forge timeline completion', () => {
	it('only marks the last stage done once the model is on screen', () => {
		const timeline = mount();
		timeline.begin({ mode: 'text', backend: 'nvidia', usesReference: false });
		timeline.applySubmit({ status: 'queued', backend: 'nvidia' });
		timeline.applyPoll({ status: 'running' });
		expect(stateOf('finish')).toBe('pending');
		timeline.finalizing();
		expect(stateOf('finish')).toBe('active');
		expect(stateOf('mesh')).toBe('done');
		timeline.complete();
		expect(stateOf('finish')).toBe('done');
		expect(labelOf('finish')).toBe('Model ready');
	});
});
