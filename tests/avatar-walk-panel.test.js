// @vitest-environment jsdom
//
// The Walk tab is mounted by two editors: /avatars/:id/edit and the Avatar
// Studio. Extracting it into one module (creation-consolidation, Avatar Studio
// edit-mode parity) is only safe if both hosts get identical behaviour and the
// module stops assuming either page's chrome. Three things it must own:
//
//   1. Its own CSS. Avatar Studio never declared `.ae-walk-*`, and the module's
//      first version put a backtick-quoted class name inside the CSS template
//      literal, which closed the string early and threw "walk is not defined"
//      the moment the tab was opened. That failure mode is why injectCss is
//      exercised here rather than assumed.
//   2. The host's button class, so the CTA is not an unstyled default button on
//      whichever page did not happen to define `.ae-btn`.
//   3. An honest degraded state. The "Open in Walk page" handoff stashes a
//      draft against a SAVED avatar (api/avatars/draft/[id].js presigns that
//      avatar's private base GLB), which an unsaved Studio draft does not have.
//      Studio passes no `openWalkUrl` in create mode and the panel must replace
//      the button with a reason, never render a control that would 400.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// The preview drives a live three.js scene; the panel's contract with it is
// small enough to state exactly, and stating it here is what keeps a change to
// that contract from silently disabling the tab.
const previewCalls = [];
vi.mock('../src/avatar-edit-walk.js', () => ({
	AvatarWalkPreview: class {
		constructor(opts) {
			this.opts = opts;
			this.active = false;
			this.envName = 'void';
			previewCalls.push(opts);
		}
		onStatus(cb) { this._status = cb; }
		async enter() { this.active = true; }
		exit() { this.active = false; }
		setEnvironment(name) { this.envName = name; }
		async listEnvironments() {
			return [
				{ name: 'void', label: 'Void' },
				{ name: 'beach', label: 'Beach' },
			];
		}
		remeasureProportions() { this.remeasured = true; }
	},
}));

const { createWalkPanel } = await import('../src/avatar-walk-panel.js');

const fakeScene = { root: { name: 'Armature' } };

function mount(overrides = {}) {
	const panel = document.createElement('div');
	document.body.appendChild(panel);
	const ctl = createWalkPanel({
		getScene: () => fakeScene,
		getStageEl: () => document.getElementById('stage'),
		pauseAmbient: () => {},
		resumeAmbient: () => {},
		...overrides,
	});
	ctl.render(panel);
	return { panel, ctl };
}

// document.head is deliberately NOT reset between tests: the module injects its
// stylesheet once per document, which is exactly the behaviour under test.
beforeEach(() => {
	document.body.innerHTML = '<div id="stage"></div>';
	previewCalls.length = 0;
});

describe('walk panel chrome', () => {
	it('injects its own stylesheet once, whole, however many panels mount', () => {
		mount();
		mount();
		expect(document.querySelectorAll('#ae-walk-css')).toHaveLength(1);
		const style = document.getElementById('ae-walk-css');
		// A stray backtick inside the CSS closes the template literal early and
		// truncates the sheet, so assert the last rule actually made it out.
		expect(style.textContent).toContain('.ae-walk-savehint');
		expect(style.textContent).toContain('.ae-walk-lede kbd');
	});

	it('does not reuse .ae-walk-hint, which the preview overlay already owns', () => {
		const { panel } = mount({ openWalkUrl: null, saveHint: 'Save first.' });
		expect(panel.querySelector('.ae-walk-hint')).toBeNull();
		expect(panel.querySelector('.ae-walk-savehint').textContent).toBe('Save first.');
	});
});

describe('the handoff into /walk', () => {
	it('renders the CTA in the host page button class when a URL builder is given', () => {
		const { panel } = mount({ openWalkUrl: async () => '/walk?x=1', buttonClass: 'as-btn' });
		const btn = panel.querySelector('.ae-walk-open');
		expect(btn).not.toBeNull();
		expect(btn.className).toContain('as-btn');
		expect(panel.querySelector('.ae-walk-savehint')).toBeNull();
	});

	it('replaces the CTA with the reason when there is nothing to hand off', () => {
		const { panel } = mount({
			openWalkUrl: null,
			saveHint: 'Save this avatar to open it in the full Walk page.',
		});
		expect(panel.querySelector('.ae-walk-open')).toBeNull();
		expect(panel.querySelector('.ae-walk-savehint').textContent).toContain('Save this avatar');
	});

	it('passes the selected environment to the URL builder and opens the result', async () => {
		const seen = [];
		const opened = [];
		window.open = (url) => { opened.push(url); return null; };
		const { panel } = mount({
			openWalkUrl: async (env) => { seen.push(env); return `/walk?env=${env}`; },
		});
		// The real environment list backfills after the manifest resolves.
		await Promise.resolve();
		await Promise.resolve();
		const select = panel.querySelector('.ae-walk-select');
		select.value = 'beach';
		select.dispatchEvent(new Event('change'));
		panel.querySelector('.ae-walk-open').click();
		await new Promise((r) => setTimeout(r, 0));
		expect(seen).toEqual(['beach']);
		expect(opened).toEqual(['/walk?env=beach']);
		expect(panel.querySelector('.ae-walk-status').textContent).toBe('Opened in a new tab.');
	});

	it('surfaces a failed handoff in the status line instead of throwing', async () => {
		window.open = () => null;
		const { panel } = mount({
			openWalkUrl: async () => { throw new Error('Could not save draft (403)'); },
		});
		panel.querySelector('.ae-walk-open').click();
		await new Promise((r) => setTimeout(r, 0));
		expect(panel.querySelector('.ae-walk-status').textContent).toBe('Could not save draft (403)');
		expect(panel.querySelector('.ae-walk-open').disabled).toBe(false);
	});
});

describe('locomotion lifecycle', () => {
	it('enters the preview on render and reports active', async () => {
		const { ctl } = mount();
		await new Promise((r) => setTimeout(r, 0));
		expect(ctl.active).toBe(true);
	});

	it('re-rendering the same panel does not rebuild it (the env choice survives)', async () => {
		const { panel, ctl } = mount();
		await new Promise((r) => setTimeout(r, 0));
		const select = panel.querySelector('.ae-walk-select');
		select.value = 'beach';
		ctl.render(panel);
		expect(panel.querySelector('.ae-walk-select')).toBe(select);
		expect(panel.querySelector('.ae-walk-select').value).toBe('beach');
		// One preview for one panel, not one per render.
		expect(previewCalls).toHaveLength(1);
	});

	it('exit is idempotent so leaving the tab is always safe', async () => {
		const { ctl } = mount();
		await new Promise((r) => setTimeout(r, 0));
		ctl.exit();
		ctl.exit();
		expect(ctl.active).toBe(false);
	});

	it('waits for the avatar rather than mounting a preview on an empty scene', () => {
		const panel = document.createElement('div');
		const ctl = createWalkPanel({
			getScene: () => null,
			getStageEl: () => null,
			pauseAmbient: () => {},
			resumeAmbient: () => {},
			emptyClass: 'as-empty',
		});
		ctl.render(panel);
		expect(panel.querySelector('.as-empty')).not.toBeNull();
		expect(previewCalls).toHaveLength(0);
	});
});
