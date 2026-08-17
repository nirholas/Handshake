import * as THREE from 'three';
import { JobBoard } from './job-board.js';
import { EconomyFx } from './economy-fx.js';
import { Ticker } from './ticker.js';
import { PulseFeed } from './pulse-feed.js';
import { ECON_LAYER_CSS } from './economy-layer.css.js';

// The economy layer — Task 06's single mount point. The Commons scaffold
// (Task 05, src/agora/agora-world.js) builds the scene, camera and the living
// crowd; this lights the economy on top of it:
//   • a job board with glowing, profession-coloured, reward-sized markers,
//   • a live ticker (economy readout + click-to-focus narration),
//   • the completion moment (coin arc + reputation tick + an orbit-able plinth),
//   • all driven from a single deduped, backing-off pulse poll that pauses with
//     the tab.
//
// It is deliberately decoupled from the scaffold's internals. The host passes a
// small context — scene, camera, renderer, a focus callback and an optional
// `crowd` adapter for driving individual citizens (walk / busy / celebrate).
// Every crowd call is optional-chained, so the board, ticker, coin flow and
// plinth all work even before the crowd exposes those hooks; the citizen-coupled
// flourishes simply light up as the adapter is filled in.
//
// Returns a handle: { update(dt), dispose() }. The host calls update(dt) in its
// render loop and dispose() on teardown.

export function mountEconomyLayer(ctx) {
	const { scene, camera, renderer } = ctx;
	const reducedMotion = !!ctx.reducedMotion;
	const canvas = renderer.domElement;
	const boardPosition = ctx.boardPosition ? ctx.boardPosition.clone() : new THREE.Vector3(0, 0, -7);

	injectStyles();

	// Overlay root for all HTML chrome (tooltips, ticker, floating labels).
	const root = document.createElement('div');
	root.className = 'agora-econ-root';
	document.body.appendChild(root);

	// ── world → screen projection (canvas-rect aware, cached per resize) ───────
	let rect = canvas.getBoundingClientRect();
	const refreshRect = () => { rect = canvas.getBoundingClientRect(); };
	window.addEventListener('resize', refreshRect);
	window.addEventListener('scroll', refreshRect, true);
	const _proj = new THREE.Vector3();
	function worldToScreen(v) {
		_proj.copy(v).project(camera);
		const visible = _proj.z < 1 && _proj.x >= -1.15 && _proj.x <= 1.15 && _proj.y >= -1.15 && _proj.y <= 1.15;
		return {
			x: rect.left + (_proj.x * 0.5 + 0.5) * rect.width,
			y: rect.top + (-_proj.y * 0.5 + 0.5) * rect.height,
			visible,
		};
	}

	const focusOn = (v) => ctx.focusOn?.(v);
	const crowd = ctx.crowd || {};

	// ── modules ────────────────────────────────────────────────────────────────
	const jobBoard = new JobBoard({
		scene, root, worldToScreen, reducedMotion, boardPosition,
		onSelectTask: (task) => {
			// Selecting a task glides the camera to the board so the marker is framed…
			focusOn(boardPosition.clone().setY(3.5));
			// …then routes to the right live view (all self-mounted, decoupled). A
			// Competitive task opens the Arena race, a Collaborative one the Guild fill
			// (Task 09); everything else opens its lifecycle + deliverable verifier
			// (Task 07's trust surface). Each listens for its own event.
			const type = String(task?.taskType || '').toLowerCase();
			const evt = type === 'competitive' ? 'agora:open-arena' : type === 'collaborative' ? 'agora:open-guild' : 'agora:open-job';
			window.dispatchEvent(new CustomEvent(evt, { detail: { task } }));
		},
	});

	const economyFx = new EconomyFx({
		scene, root, worldToScreen, reducedMotion, focusOn, boardPosition,
	});

	const ticker = new Ticker({
		root, reducedMotion,
		onFocusActivity: (activity) => focusActivity(activity),
	});

	// Resolve the citizen behind an activity by display name (pulse.recent carries
	// the actor's name, not its id) and glide to it; open the passport if the host
	// wired that. Completion activities with a deliverable focus the plinth.
	function focusActivity(activity) {
		if (!activity) return;
		const name = activity.actor;
		const hit = name && crowd.findByName ? crowd.findByName(name) : null;
		if (activity.citizenId && crowd.getPosition) {
			const p = crowd.getPosition(activity.citizenId);
			if (p) { focusOn(p.clone().setY(1.6)); ctx.openPassport?.(activity.citizenId); return; }
		}
		if (hit?.position) {
			focusOn(hit.position.clone().setY(1.6));
			ctx.openPassport?.(hit.id);
		} else if (activity.kind === 'completed_task' && activity.deliverableUrl) {
			focusOn(economyFx.plinthSpot.clone().setY(1.4));
		} else {
			focusOn(boardPosition.clone().setY(3.5));
		}
	}

	// ── live activity routing ────────────────────────────────────────────────
	function handleActivity(a) {
		if (!a || !a.kind) return;
		const hit = a.actor && crowd.findByName ? crowd.findByName(a.actor) : null;

		if (a.kind === 'claimed_task' && hit) {
			// Walk the claimant to the board, then to a work spot beside it; mark Busy.
			crowd.setStatus?.(hit.id, 'Busy');
			const boardSpot = boardPosition.clone();
			boardSpot.z += 2.2; // stand in front of the board
			const workSpot = boardPosition.clone();
			workSpot.x += (Math.random() - 0.5) * 6;
			workSpot.z += 4 + Math.random() * 3;
			crowd.walkTo?.(hit.id, boardSpot, () => crowd.walkTo?.(hit.id, workSpot));
		} else if (a.kind === 'completed_task') {
			const workerPos = positionFor(a, hit);
			economyFx.onCompletion({
				workerPos,
				rewardLabel: a.rewardLabel,
				narrative: a.narrative,
				deliverableUrl: a.deliverableUrl,
			});
			if (a.rewardLabel && a.taskPda) markPaid(a.taskPda);
			if (hit) {
				crowd.celebrate?.(hit.id);
				crowd.setStatus?.(hit.id, 'Active');
			}
		} else if (a.kind === 'earned') {
			// The payout is its own activity, and it is the one carrying the amount.
			// A completion that already named its reward (an Arena purse) has flowed
			// the coins itself, so skip the paired event rather than paying twice.
			if (a.taskPda && alreadyPaid(a.taskPda)) return;
			if (a.taskPda) markPaid(a.taskPda);
			economyFx.onPayout({ workerPos: positionFor(a, hit), rewardLabel: a.rewardLabel });
		}
	}

	// Where the earner is standing right now, by id when the pulse gives one and
	// by display name otherwise. Null means "not in the crowd" and the FX layer
	// lands the value on the plinth instead.
	function positionFor(a, hit) {
		if (hit?.position) return hit.position;
		if (a.citizenId && crowd.getPosition) return crowd.getPosition(a.citizenId) || null;
		return null;
	}

	// A small, bounded memory of task payouts already animated, so the
	// completion/earned pair can't double-flow the same reward.
	const paidTasks = new Set();
	const paidOrder = [];
	function markPaid(taskPda) {
		if (paidTasks.has(taskPda)) return;
		paidTasks.add(taskPda);
		paidOrder.push(taskPda);
		if (paidOrder.length > 200) paidTasks.delete(paidOrder.shift());
	}
	function alreadyPaid(taskPda) { return paidTasks.has(taskPda); }

	// ── connection state pip ───────────────────────────────────────────────────
	// The pip means "nothing has arrived in a while", not "a request failed".
	// Counting consecutive errors latched it on a single aborted poll: a board
	// request timing out while the square places 200 citizens was enough to print
	// "reconnecting…" across a ticker showing fresh, correct numbers, and it stayed
	// up until the next success. Staleness is the honest signal, and it clears
	// itself the moment data lands.
	const STALE_AFTER_MS = 30000;
	let lastFresh = Date.now();
	function markFresh() {
		lastFresh = Date.now();
		root.classList.remove('agora-econ-offline');
	}
	function checkStale() {
		if (Date.now() - lastFresh >= STALE_AFTER_MS) root.classList.add('agora-econ-offline');
	}
	const staleTimer = setInterval(checkStale, 5000);

	// ── feed wiring ────────────────────────────────────────────────────────────
	const feed = new PulseFeed();
	const offs = [
		feed.on('board', (b) => { markFresh(); jobBoard.setBoard(b); }),
		feed.on('pulse', (p) => { markFresh(); ticker.setPulse(p); }),
		feed.on('activity', handleActivity),
	];
	feed.start();

	// ── 3D marker hover/click (single picker, only on pointer move) ────────────
	const raycaster = new THREE.Raycaster();
	const ndc = new THREE.Vector2();
	function onPointerMove(e) {
		ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(ndc, camera);
		const hits = raycaster.intersectObjects(jobBoard.pickables, false);
		jobBoard.hoverByMesh(hits[0]?.object || null);
		// Only assert the marker "pointer" cursor when we actually hit a marker; the
		// base cursor (spectator "grab", citizen "pointer") is owned by the scaffold's
		// own pointermove handler (agora-world.js), which runs first each event. If we
		// cleared it here on a miss we'd stomp that affordance, since this listener is
		// registered later and wins the assignment.
		if (hits[0]) canvas.style.cursor = 'pointer';
	}
	function onClick(e) {
		ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
		raycaster.setFromCamera(ndc, camera);
		const hits = raycaster.intersectObjects(jobBoard.pickables, false);
		if (hits[0]) {
			const key = jobBoard.keyForMesh(hits[0].object);
			const task = jobBoard.taskForKey(key);
			if (task) { jobBoard.ctx.onSelectTask?.(task, key); }
		}
	}
	canvas.addEventListener('pointermove', onPointerMove);
	canvas.addEventListener('click', onClick);

	return {
		update(dt) {
			jobBoard.update(dt);
			economyFx.update(dt);
		},
		// The OS-level reduced-motion toggle can flip mid-session; the scaffold
		// (agora-world.js) pushes the new value to the crowd and to here so the
		// board's bob, the coin flight, the plinth spin and the ticker's enter
		// animation all stop without a reload.
		setReducedMotion(on) {
			jobBoard.setReducedMotion(on);
			economyFx.setReducedMotion(on);
			ticker.setReducedMotion(on);
		},
		dispose() {
			clearInterval(staleTimer);
			for (const off of offs) off?.();
			feed.stop();
			canvas.removeEventListener('pointermove', onPointerMove);
			canvas.removeEventListener('click', onClick);
			window.removeEventListener('resize', refreshRect);
			window.removeEventListener('scroll', refreshRect, true);
			jobBoard.dispose();
			economyFx.dispose();
			ticker.dispose();
			root.remove();
		},
	};
}

let _stylesInjected = false;
function injectStyles() {
	if (_stylesInjected || document.getElementById('agora-econ-styles')) return;
	const style = document.createElement('style');
	style.id = 'agora-econ-styles';
	style.textContent = ECON_LAYER_CSS;
	document.head.appendChild(style);
	_stylesInjected = true;
}
