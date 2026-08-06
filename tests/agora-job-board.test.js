// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as THREE from 'three';
import { JobBoard } from '../src/agora/job-board.js';
import { MARKER_BUDGET, ROSTER_BUDGET } from '../src/agora/board-rank.js';

// The board is the layer's only long-lived pool of GPU objects: it rebuilds from
// every /api/agora/board poll, so a marker that is dropped without disposal is
// the leak that shows up as a climbing heap over a long watch. These tests hold
// the pool bounded and prove retired markers release their geometry.

// jsdom ships no 2D canvas backend, and the board bakes its "OPEN WORK" header
// and glow sprite from one. Only the calls those two textures make are needed.
beforeAll(() => {
	HTMLCanvasElement.prototype.getContext = function (kind) {
		if (kind !== '2d') return null;
		return {
			fillStyle: '', font: '', textAlign: '', textBaseline: '', letterSpacing: '',
			fillRect() {}, fillText() {},
			createRadialGradient: () => ({ addColorStop() {} }),
		};
	};
});

function makeBoard() {
	const scene = new THREE.Scene();
	const root = document.createElement('div');
	document.body.appendChild(root);
	const board = new JobBoard({
		scene, root,
		worldToScreen: () => ({ x: 5, y: 5, visible: true }),
		reducedMotion: false,
		boardPosition: new THREE.Vector3(0, 0, -6),
		onSelectTask: vi.fn(),
	});
	return { board, scene, root };
}

const services = (n, offset = 0) => Array.from({ length: n }, (_, i) => ({
	source: 'x402',
	profession: 'fetcher',
	title: `service ${i + offset}`,
	resource: `https://x.test/svc-${i + offset}`,
	reward: { amountAtomic: String(1000 + i), label: '0.002 USDC' },
}));

describe('JobBoard', () => {
	it('renders a bounded marker pool from an unbounded bazaar payload', () => {
		const { board } = makeBoard();
		board.setBoard({ tasks: [], services: services(573), openTaskCount: 0, serviceTotal: 573 });

		expect(board.pickables).toHaveLength(MARKER_BUDGET);
		expect(board._list.querySelectorAll('.agora-econ-board-item')).toHaveLength(ROSTER_BUDGET);
	});

	it('states the overflow instead of silently dropping it', () => {
		const { board, root } = makeBoard();
		board.setBoard({ tasks: [], services: services(573), openTaskCount: 0, serviceTotal: 573 });

		const more = root.querySelector('.agora-econ-board-more');
		expect(more?.textContent).toBe(`+${573 - ROSTER_BUDGET} more open jobs in the bazaar`);
		// The heading still reports the true size of the open economy.
		expect(root.querySelector('.agora-econ-board-count').textContent).toContain('573');
	});

	it('reports the pre-truncation total the API sends, not just what it shipped', () => {
		const { board, root } = makeBoard();
		// The API caps its own payload at maxItems but reports serviceTotal.
		board.setBoard({ tasks: [], services: services(60), openTaskCount: 0, serviceTotal: 573, truncated: true });
		expect(root.querySelector('.agora-econ-board-count').textContent).toContain('573');
		expect(root.querySelector('.agora-econ-board-more').textContent).toContain(`+${573 - ROSTER_BUDGET}`);
	});

	it('disposes every marker it retires across repeated polls', () => {
		const { board, scene } = makeBoard();
		const disposed = [];
		const track = () => {
			for (const m of board._markers.values()) {
				if (m._tracked) continue;
				m._tracked = true;
				vi.spyOn(m.coreGeo, 'dispose').mockImplementation(() => disposed.push('geo'));
				vi.spyOn(m.coreMat, 'dispose').mockImplementation(() => disposed.push('mat'));
				vi.spyOn(m.glowMat, 'dispose').mockImplementation(() => disposed.push('glow'));
			}
		};

		// 40 polls, each a completely different board: every marker from the poll
		// before it must be retired and released.
		for (let poll = 0; poll < 40; poll++) {
			board.setBoard({ tasks: [], services: services(30, poll * 1000), openTaskCount: 0, serviceTotal: 30 });
			track();
			expect(board.pickables.length).toBeLessThanOrEqual(MARKER_BUDGET);
		}

		// The live pool stays at the budget while the scene graph never grows.
		expect(board._markers.size).toBe(MARKER_BUDGET);
		expect(board._meshIndex.size).toBe(MARKER_BUDGET);
		// 39 full turnovers of 24 markers, each releasing geo + mat + glow.
		expect(disposed.length).toBeGreaterThanOrEqual(39 * MARKER_BUDGET * 3);
		expect(board.group.children.length).toBeLessThan(MARKER_BUDGET + 10);
		expect(scene.children).toContain(board.group);
	});

	it('keeps a marker (and its GPU objects) across polls when the task is unchanged', () => {
		const { board } = makeBoard();
		const payload = { tasks: [], services: services(10), openTaskCount: 0, serviceTotal: 10 };
		board.setBoard(payload);
		const firstCore = board.pickables[0];
		board.setBoard(payload);
		expect(board.pickables[0]).toBe(firstCore);
	});

	it('drops the tooltip when the hovered task leaves the board', () => {
		const { board } = makeBoard();
		board.setBoard({ tasks: [], services: services(5), openTaskCount: 0, serviceTotal: 5 });
		const core = board.pickables[0];
		board.hoverByMesh(core);
		expect(board._tip.hidden).toBe(false);

		// That task gets claimed out from under the pointer.
		board.setBoard({ tasks: [], services: services(5, 500), openTaskCount: 0, serviceTotal: 5 });
		expect(board._tip.hidden).toBe(true);
		board.update(0.016);
		expect(board._tip.hidden).toBe(true);
	});

	it('shows the designed empty sign when no work is open', () => {
		const { board, root } = makeBoard();
		board.setBoard({ tasks: [], services: [], openTaskCount: 0, serviceTotal: 0 });

		expect(root.querySelector('.agora-econ-board-empty').hidden).toBe(false);
		expect(root.querySelector('.agora-econ-board-empty-title').textContent).toBe('No open work right now');
		expect(board.pickables).toHaveLength(0);
		expect(root.querySelector('.agora-econ-board-more')).toBeNull();
	});

	it('settles animated values when reduced motion turns on mid-session', () => {
		const { board } = makeBoard();
		board.setBoard({ tasks: [], services: services(3), openTaskCount: 0, serviceTotal: 3 });
		board.update(0.5);
		board.setReducedMotion(true);

		for (const m of board._markers.values()) {
			expect(m.core.position.y).toBe(0);
			expect(m.glowMat.opacity).toBe(0.85);
		}
		// And a further frame must not re-animate them.
		board.update(0.5);
		for (const m of board._markers.values()) expect(m.core.position.y).toBe(0);
	});

	it('dispose() empties the pool and detaches the board from the scene', () => {
		const { board, scene, root } = makeBoard();
		board.setBoard({ tasks: [], services: services(20), openTaskCount: 0, serviceTotal: 20 });
		board.dispose();

		expect(board._markers.size).toBe(0);
		expect(board._meshIndex.size).toBe(0);
		expect(scene.children).not.toContain(board.group);
		expect(root.querySelector('.agora-econ-board-panel')).toBeNull();
	});
});
