/**
 * Feature Tour map panel: unit tests.
 *
 * The Tour map (chapters.js) renders the curriculum as a registry-style
 * listing (bold title, a summary of what the guide says with the spoken
 * "Here we have X." lead-in stripped, and the page path) under chapter
 * headers with counts, plus a total-stops badge and a live results line.
 * On desktop the panel tears off its drawer when dragged by the header,
 * floats where dropped, remembers the spot, and docks back on demand.
 * These tests pin that contract.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

let ChapterPanel;
let dom;

const CURRICULUM = {
	sections: [
		{ id: 'main', title: 'Main' },
		{ id: 'build', title: 'Build' },
	],
	tracks: [
		{ id: 'full', title: 'Full tour', description: 'Everything.', estimatedMinutes: 100 },
		{ id: 'quick', title: 'Quick highlights', description: 'The best.', estimatedMinutes: 7 },
	],
	stops: [
		{
			id: 'home',
			path: '/',
			section: 'main',
			title: 'Home',
			narration: 'Here we have Home. Landing page. The front door to every flow.',
			highlight: true,
		},
		{
			id: 'markets',
			path: '/markets',
			section: 'main',
			title: 'Markets',
			narration: 'Here we have Markets. Live pump.fun market intelligence.',
		},
		{
			id: 'avatar-studio',
			path: '/avatar-studio',
			section: 'build',
			title: 'Avatar Studio',
			narration: 'Here we have Avatar Studio. Pose, dress, and animate your rig.',
		},
	],
};

beforeAll(async () => {
	dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
	global.window = dom.window;
	global.document = dom.window.document;
	global.localStorage = dom.window.localStorage;
	global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
	global.cancelAnimationFrame = (id) => clearTimeout(id);
	// jsdom implements neither matchMedia nor scrollIntoView.
	global.matchMedia = (q) => ({
		matches: false, media: q,
		addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
	});
	dom.window.matchMedia = global.matchMedia;
	global.sessionStorage = dom.window.sessionStorage;
	dom.window.Element.prototype.scrollIntoView = () => {};
	({ ChapterPanel } = await import('../src/feature-tour/chapters.js'));
});

let panel;
let jumped;

beforeEach(() => {
	dom.window.localStorage.clear();
	dom.window.sessionStorage.clear();
	jumped = [];
	panel = new ChapterPanel(CURRICULUM, { onJump: (abs) => jumped.push(abs) });
});

afterEach(() => {
	panel?.dispose();
	document.body.innerHTML = '';
});

function drag(head, from, to) {
	head.dispatchEvent(
		new dom.window.MouseEvent('pointerdown', { bubbles: true, clientX: from.x, clientY: from.y, button: 0 }),
	);
	document.dispatchEvent(
		new dom.window.MouseEvent('pointermove', { bubbles: true, clientX: to.x, clientY: to.y }),
	);
	document.dispatchEvent(new dom.window.MouseEvent('pointerup', { bubbles: true }));
}

describe('ChapterPanel listing', () => {
	it('renders registry-style rows: title, lead-in-free summary, and path', () => {
		const rows = document.querySelectorAll('.tws-tour-stop');
		expect(rows.length).toBe(3);
		const home = rows[0];
		expect(home.querySelector('.tws-tour-stop__title').textContent).toBe('Home');
		const desc = home.querySelector('.tws-tour-stop__desc').textContent;
		expect(desc).toBe('Landing page. The front door to every flow.');
		expect(desc).not.toContain('Here we have');
		expect(home.querySelector('.tws-tour-stop__meta').textContent).toBe('/');
		expect(rows[1].querySelector('.tws-tour-stop__meta').textContent).toBe('/markets');
	});

	it('shows the total badge, chapter counts, and a summary line', () => {
		expect(document.querySelector('.tws-tour-menu__badge').textContent).toBe('3');
		const chapters = document.querySelectorAll('.tws-tour-chap');
		expect(chapters.length).toBe(2);
		expect(chapters[0].querySelector('.tws-tour-chap__n').textContent).toBe('2');
		expect(document.querySelector('.tws-tour-menu__countline').textContent).toBe(
			'3 stops · 2 chapters',
		);
	});

	it('search matches narration and paths, not just titles', () => {
		const input = document.querySelector('.tws-tour-menu__input');
		input.value = 'market intelligence'; // narration-only phrase
		input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		const rows = document.querySelectorAll('.tws-tour-stop');
		expect(rows.length).toBe(1);
		expect(rows[0].querySelector('.tws-tour-stop__title').textContent).toBe('Markets');
		expect(document.querySelector('.tws-tour-menu__countline').textContent).toBe(
			'1 of 3 stops match',
		);
	});

	it('clicking a stop jumps to its absolute index', () => {
		panel.show();
		document.querySelectorAll('.tws-tour-stop')[2].click();
		expect(jumped).toEqual([2]);
		expect(panel.open).toBe(false); // docked drawer self-closes on jump
	});
});

describe('ChapterPanel floating mode', () => {
	it('drag tears the drawer off, floats it, and persists the spot', () => {
		panel.show();
		const head = document.querySelector('.tws-tour-menu__head');
		drag(head, { x: 40, y: 20 }, { x: 300, y: 200 });
		const root = document.querySelector('.tws-tour-menu');
		expect(root.classList.contains('is-floating')).toBe(true);
		expect(document.querySelector('[data-act="dock"]').hidden).toBe(false);
		const saved = JSON.parse(dom.window.localStorage.getItem('tws:tour:menu-pos'));
		expect(saved.x).toBeGreaterThan(8);
		expect(saved.y).toBeGreaterThan(8);
	});

	it('reopens floating at the remembered position, and jump keeps it open', () => {
		dom.window.localStorage.setItem('tws:tour:menu-pos', JSON.stringify({ x: 120, y: 90 }));
		panel.show();
		const root = document.querySelector('.tws-tour-menu');
		expect(root.classList.contains('is-floating')).toBe(true);
		const el = document.querySelector('.tws-tour-menu__panel');
		expect(el.style.left).toBe('120px');
		expect(el.style.top).toBe('90px');
		document.querySelectorAll('.tws-tour-stop')[1].click();
		expect(jumped).toEqual([1]);
		expect(panel.open).toBe(true); // floating map stays open as a companion
	});

	it('an open floating map self-restores on the next page, without stealing focus', () => {
		dom.window.localStorage.setItem('tws:tour:menu-pos', JSON.stringify({ x: 120, y: 90 }));
		dom.window.sessionStorage.setItem('tws:tour:menu-open', '1');
		// Simulate the next stop's page: a fresh panel over the same storage.
		const next = new ChapterPanel(CURRICULUM, { onJump: () => {} });
		expect(next.open).toBe(true);
		expect(next.floating).toBe(true);
		next.dispose();
		// Deliberate teardown (tour exit) clears the self-reopen flag.
		expect(dom.window.sessionStorage.getItem('tws:tour:menu-open')).toBe(null);
	});

	it('closing the floating map stops it from self-restoring', () => {
		dom.window.localStorage.setItem('tws:tour:menu-pos', JSON.stringify({ x: 120, y: 90 }));
		panel.show();
		expect(dom.window.sessionStorage.getItem('tws:tour:menu-open')).toBe('1');
		panel.close();
		expect(dom.window.sessionStorage.getItem('tws:tour:menu-open')).toBe(null);
		const next = new ChapterPanel(CURRICULUM, { onJump: () => {} });
		expect(next.open).toBe(false);
		next.dispose();
	});

	it('dock returns to the drawer and forgets the position', () => {
		dom.window.localStorage.setItem('tws:tour:menu-pos', JSON.stringify({ x: 120, y: 90 }));
		panel.show();
		document.querySelector('[data-act="dock"]').click();
		const root = document.querySelector('.tws-tour-menu');
		expect(root.classList.contains('is-floating')).toBe(false);
		expect(dom.window.localStorage.getItem('tws:tour:menu-pos')).toBe(null);
		const el = document.querySelector('.tws-tour-menu__panel');
		expect(el.style.left).toBe('');
	});
});
