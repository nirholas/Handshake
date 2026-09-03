// /sign-mirror: learn a handshape by making it, not by watching one.
//
// The avatar forms the target letter. Your camera watches your hand. The two
// are compared against the SAME handshape spec (src/sign-handshapes.js), so the
// thing being taught and the thing being graded can never drift apart. Hold the
// shape and the letter passes; hold it wrong and the page names the finger.
//
// Everything on the camera side stays on the device. MediaPipe's hand
// landmarker runs in this tab, the grading is arithmetic in src/sign-grader.js,
// and no frame, landmark, or score is ever uploaded. There is no network call
// in the practice loop at all.

import { PoseStage } from './avatar-pose.js';
import { buildFingerspellingClip } from './fingerspelling.js';
import { LETTERS, LETTER_NOTES } from './asl-alphabet-data.js';
import { GradeSmoother, gradeHandshape, rankHandshapes } from './sign-grader.js';
import { HAND_CONNECTIONS, handshapeLandmarks, projectHand } from './sign-hand-model.js';
import { loadSignPrefs, resolveRig, saveSignPrefs } from './sign-avatars.js';
import { log } from './shared/log.js';

const PROGRESS_KEY = 'threews:sign-mirror-progress';

// Letters whose handshape is identical to another letter's: in ASL they differ
// by which way the hand points, which a handshape score cannot see. They are
// still taught, with the difference spelled out, but never marked wrong for it.
const SHARED_SHAPE = { G: 'Q', Q: 'G', K: 'P', P: 'K' };

// The manual alphabet in the order it is easiest to learn: closed shapes first,
// then the open hands, then the pairs people confuse, then the moving letters.
const COURSE = [
	{ id: 'closed', title: 'Closed hands', blurb: 'Four letters made with the fingers folded in. The thumb does all the work.', letters: ['A', 'S', 'E', 'O'] },
	{ id: 'open', title: 'Open hands', blurb: 'The flat and spread shapes. Easy to hold, easy to read.', letters: ['B', 'C', 'F', 'L'] },
	{ id: 'points', title: 'Pointing fingers', blurb: 'One or two fingers up. Watch the gap between them.', letters: ['D', 'U', 'V', 'W'] },
	{ id: 'tricky', title: 'The confusable ones', blurb: 'The pairs that trip up every beginner. Take these slowly.', letters: ['M', 'N', 'T', 'R'] },
	{ id: 'rest', title: 'The rest', blurb: 'Everything left, including the two letters that move.', letters: ['G', 'H', 'I', 'K', 'P', 'Q', 'X', 'Y', 'J', 'Z'] },
];

const MOVING = new Set(['J', 'Z']);
const ALL_COURSE_LETTERS = COURSE.flatMap((s) => s.letters);
const $ = (sel, root = document) => root.querySelector(sel);

function readJSON(key, fallback) {
	try {
		return JSON.parse(localStorage.getItem(key)) || fallback;
	} catch {
		return fallback;
	}
}
function writeJSON(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* private mode: progress just does not persist */
	}
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Draw a hand skeleton into an SVG element from 21 projected points.
 *
 * The overlay redraws on every camera frame, so the nodes are built once and
 * then only their coordinates change: rebuilding 21 circles and 21 lines sixty
 * times a second is enough layout churn to be felt on a laptop.
 */
function drawSkeleton(svg, points, { className = '' } = {}) {
	let g = svg.firstElementChild;
	if (!g || g.childElementCount !== HAND_CONNECTIONS.length + points.length) {
		svg.textContent = '';
		g = document.createElementNS(SVG_NS, 'g');
		for (let i = 0; i < HAND_CONNECTIONS.length; i++) g.append(document.createElementNS(SVG_NS, 'line'));
		points.forEach((_, i) => {
			const dot = document.createElementNS(SVG_NS, 'circle');
			dot.setAttribute('r', i === 0 || i % 4 === 0 ? '3.6' : '2.4');
			g.append(dot);
		});
		svg.append(g);
	}
	if (g.getAttribute('class') !== className) g.setAttribute('class', className);
	const nodes = g.children;
	HAND_CONNECTIONS.forEach(([a, b], i) => {
		const line = nodes[i];
		line.setAttribute('x1', points[a].x.toFixed(1));
		line.setAttribute('y1', points[a].y.toFixed(1));
		line.setAttribute('x2', points[b].x.toFixed(1));
		line.setAttribute('y2', points[b].y.toFixed(1));
	});
	points.forEach((p, i) => {
		const dot = nodes[HAND_CONNECTIONS.length + i];
		dot.setAttribute('cx', p.x.toFixed(1));
		dot.setAttribute('cy', p.y.toFixed(1));
	});
}

async function boot() {
	const stageHost = $('#sm-stage');
	if (!stageHost) return;

	const prefs = loadSignPrefs();
	const progress = readJSON(PROGRESS_KEY, { passed: {}, best: {} });
	// The rig, the signing hand and any custom avatar come from the same stored
	// block /sign-language and /asl-alphabet write.
	let avatar = resolveRig(prefs);
	let dominant = prefs.dominant === 'Left' ? 'Left' : 'Right';

	let stage = null;
	let canSign = false;
	let current = ALL_COURSE_LETTERS[0];
	let playToken = 0;

	const statusEl = $('#sm-status');
	const setStatus = (msg, tone = '') => {
		if (!statusEl) return;
		statusEl.textContent = msg || '';
		statusEl.dataset.tone = tone;
	};

	// ── The avatar half ──────────────────────────────────────────────────────
	const replayBtn = $('#sm-replay');
	const setReplayable = (on) => {
		if (!replayBtn) return;
		replayBtn.disabled = !on;
		replayBtn.title = on ? '' : 'This avatar cannot fingerspell, so there is nothing to replay. The target diagram still shows the shape.';
	};

	const mountStage = async () => {
		stage?.dispose();
		stage = new PoseStage(stageHost, { glbUrl: avatar.url, framing: 'portrait' });
		try {
			const { supported } = await stage.mount();
			stage.start();
			canSign = !!supported;
			if (!supported) setStatus('This avatar has no finger bones. Practice still works: the target diagram and the scoring do not need it.', 'warn');
			setReplayable(canSign);
			return canSign;
		} catch (err) {
			log.warn('[sign-mirror] stage mount failed', err?.message);
			canSign = false;
			setReplayable(false);
			setStatus('The 3D preview could not start. The target diagram and scoring still work.', 'warn');
			return false;
		}
	};

	const showOnAvatar = (letter) => {
		if (!stage?.anim || !canSign) return;
		const token = ++playToken;
		let clip;
		try {
			clip = buildFingerspellingClip(letter, { holdSeconds: 1.6, transitionSeconds: 0.3, dominant, settle: false });
		} catch (err) {
			log.warn('[sign-mirror] clip failed', err?.message);
			return;
		}
		const name = `sm-${token}`;
		stage.anim.injectClip(name, clip, { loop: false });
		stage.anim.playOnce(name, { settleTo: null });
	};

	// ── The target diagram ───────────────────────────────────────────────────
	const targetSvg = $('#sm-target');
	const drawTarget = (letter) => {
		if (!targetSvg) return;
		const box = targetSvg.viewBox.baseVal;
		const pts = projectHand(handshapeLandmarks(letter, dominant), {
			width: box.width,
			height: box.height,
			padding: 20,
			flip: dominant === 'Left',
		});
		drawSkeleton(targetSvg, pts, { className: 'sm-skel sm-skel-target' });
	};

	// ── The camera half ──────────────────────────────────────────────────────
	const video = $('#sm-video');
	const overlay = $('#sm-overlay');
	const scoreEl = $('#sm-score');
	const scoreBar = $('#sm-score-bar');
	const hintEl = $('#sm-hint');
	const fingersEl = $('#sm-fingers');
	const cameraBtn = $('#sm-camera');
	const cameraNote = $('#sm-camera-note');

	let landmarker = null;
	let stream = null;
	let raf = 0;
	let running = false;
	let lastVideoTime = -1;
	const smoother = new GradeSmoother({ passScore: 78, holdMs: 800 });

	const IDLE_HINT = 'Turn the camera on to be graded, or just copy the diagram.';

	// The still letters: J and Z are excluded because they are defined by a path
	// the hand traces, which a single-frame ranking cannot recognise.
	const RANKABLE = LETTERS.filter((l) => !MOVING.has(l));
	const RANK_INTERVAL_MS = 350;
	let lastRankAt = 0;
	let lookedLike = '';

	// The hint is a live region, and it is written on every graded frame. Writing
	// the same sentence again would make a screen reader read it again, so only a
	// genuine change reaches the DOM.
	const setHint = (text) => {
		if (hintEl && hintEl.textContent !== text) hintEl.textContent = text;
	};

	const setScore = (value, holding, heldMs) => {
		const pct = Math.max(0, Math.min(100, value));
		if (scoreEl) scoreEl.textContent = `${Math.round(pct)}`;
		if (scoreBar) {
			scoreBar.style.setProperty('--sm-fill', `${pct}%`);
			scoreBar.dataset.state = pct >= 78 ? 'good' : pct >= 55 ? 'close' : 'far';
			scoreBar.setAttribute('aria-valuenow', String(Math.round(pct)));
		}
		if (holding && heldMs > 0) {
			const held = Math.min(1, heldMs / smoother.holdMs);
			scoreBar?.style.setProperty('--sm-hold', `${(held * 100).toFixed(0)}%`);
		} else {
			scoreBar?.style.setProperty('--sm-hold', '0%');
		}
	};

	// One row per finger, built on the first graded frame and then updated in
	// place. Same reason as the skeleton: this runs at camera frame rate.
	const fingerRows = new Map();
	const renderFingers = (grade) => {
		if (!fingersEl) return;
		for (const f of grade.fingers) {
			let row = fingerRows.get(f.finger);
			if (!row) {
				const el = document.createElement('div');
				el.className = 'sm-finger';
				const name = document.createElement('span');
				name.className = 'sm-finger-name';
				name.textContent = f.finger;
				const bar = document.createElement('span');
				bar.className = 'sm-finger-bar';
				// A real progressbar rather than a bare div: a screen reader can
				// read the number on demand, without every frame announcing itself.
				bar.setAttribute('role', 'progressbar');
				bar.setAttribute('aria-label', `${f.finger} finger`);
				bar.setAttribute('aria-valuemin', '0');
				bar.setAttribute('aria-valuemax', '100');
				el.append(name, bar);
				fingersEl.append(el);
				row = { el, bar, pct: -1 };
				fingerRows.set(f.finger, row);
			}
			const state = f.score >= 0.8 ? 'good' : f.score >= 0.5 ? 'close' : 'far';
			if (row.el.dataset.state !== state) row.el.dataset.state = state;
			const pct = Math.round(f.score * 100);
			if (pct !== row.pct) {
				row.pct = pct;
				row.bar.style.setProperty('--sm-fill', `${pct}%`);
				row.bar.setAttribute('aria-valuenow', String(pct));
			}
		}
	};

	const clearFingers = () => {
		fingerRows.clear();
		if (fingersEl) fingersEl.textContent = '';
	};

	// The best score per letter survives the session, but the grader beats it
	// many times a second: batch the write instead of touching storage per frame.
	let bestTimer = 0;
	const flushProgress = () => {
		if (!bestTimer) return;
		window.clearTimeout(bestTimer);
		bestTimer = 0;
		writeJSON(PROGRESS_KEY, progress);
		renderLetterBest();
	};
	const saveBestSoon = () => {
		if (bestTimer) return;
		bestTimer = window.setTimeout(() => {
			bestTimer = 0;
			writeJSON(PROGRESS_KEY, progress);
			renderLetterBest();
		}, 2000);
	};

	const markPassed = (letter) => {
		progress.passed[letter] = true;
		writeJSON(PROGRESS_KEY, progress);
		document.querySelector(`.sm-letter[data-char="${letter}"]`)?.setAttribute('data-passed', 'true');
		renderProgress();
	};

	const onPassed = (letter) => {
		markPassed(letter);
		setStatus(`${letter} is right. Well held.`, 'good');
		const idx = ALL_COURSE_LETTERS.indexOf(letter);
		const next = ALL_COURSE_LETTERS.slice(idx + 1).find((l) => !progress.passed[l]) || ALL_COURSE_LETTERS.find((l) => !progress.passed[l]);
		setHint(next ? `${letter} passed. ${next} is next.` : `${letter} passed. That is every letter in the alphabet.`);
		if (next) window.setTimeout(() => selectLetter(next), 900);
		else setStatus('Every letter passed. You can read and make the whole manual alphabet.', 'good');
	};

	const gradeFrame = (landmarks, now) => {
		let grade;
		try {
			// J and Z move, and only their handshape can be scored; the letter card
			// says so outright, so every letter grades against its own shape.
			grade = gradeHandshape(landmarks, current);
		} catch (err) {
			log.warn('[sign-mirror] grade failed', err?.message);
			return;
		}
		const state = smoother.push(grade, now);
		setScore(state.score, state.holding, state.heldMs);
		renderFingers(grade);
		if (progress.best[current] == null || Math.round(state.score) > progress.best[current]) {
			progress.best[current] = Math.round(state.score);
			saveBestSoon();
		}
		if (state.passed) {
			smoother.reset();
			flushProgress();
			onPassed(current);
			return;
		}
		// When the hand is a long way off, say what it DOES look like: a learner
		// making a clean B while aiming for D is helped far more by "that is a B"
		// than by "straighten your ring finger". Ranking every letter costs a full
		// grade per candidate, so it runs a few times a second, not per frame.
		if (state.score < 45 && now - lastRankAt > RANK_INTERVAL_MS) {
			lastRankAt = now;
			const [best] = rankHandshapes(landmarks, RANKABLE);
			lookedLike = best && best.name !== current && best.score > 70 ? best.name : '';
		} else if (state.score >= 45) {
			lookedLike = '';
		}
		setHint(lookedLike ? `That is a clean ${lookedLike}. For ${current}: ${grade.hint}` : grade.hint);
	};

	const stopCamera = () => {
		running = false;
		cancelAnimationFrame(raf);
		stream?.getTracks().forEach((t) => t.stop());
		stream = null;
		lastVideoTime = -1;
		smoother.reset();
		if (video) video.srcObject = null;
		document.body.dataset.smCamera = 'off';
		if (cameraBtn) {
			cameraBtn.textContent = 'Turn the camera on';
			cameraBtn.setAttribute('aria-pressed', 'false');
		}
		overlay?.replaceChildren();
		setScore(0, false, 0);
		clearFingers();
		lookedLike = '';
		lastRankAt = 0;
		if (cameraNote) cameraNote.hidden = true;
		// Back to the state the page opened in: the box says what to do next
		// rather than sitting there empty.
		setHint(IDLE_HINT);
		flushProgress();
	};

	/**
	 * What to tell the learner when the camera does not come up. The raw error is
	 * a bundler URL or a DOM exception name, neither of which anyone can act on,
	 * so each cause gets the sentence that says what to actually do next.
	 *
	 * @param {unknown} err   whatever was thrown
	 * @param {'tracker'|'camera'} where  which half of the start failed
	 * @returns {string}
	 */
	const cameraFailureMessage = (err, where) => {
		const name = err?.name || '';
		const text = err?.message || '';
		if (where === 'tracker') {
			return 'The hand tracker could not be downloaded. Check the connection and try again; the target diagram and the letter notes work without it.';
		}
		if (name === 'NotAllowedError' || /denied|not allowed|permission/i.test(text)) {
			return 'Camera permission was refused. Allow it in your browser address bar, then try again.';
		}
		if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || /not found|no device/i.test(text)) {
			return 'No camera was found on this device. Copy the target diagram by eye instead: the letter notes still teach the shape.';
		}
		if (name === 'NotReadableError' || name === 'TrackStartError' || /in use|could not start video/i.test(text)) {
			return 'The camera is busy in another app or tab. Close the other one and try again.';
		}
		if (name === 'SecurityError' || !window.isSecureContext) {
			return 'Browsers only hand out the camera over HTTPS. Open this page on https://three.ws and try again.';
		}
		if (name === 'OverconstrainedError') {
			return 'This camera cannot deliver the format the tracker needs. Try another camera, or copy the target diagram by eye.';
		}
		return 'The camera could not start. Try again, or copy the target diagram by eye: the letter notes still teach the shape.';
	};

	const startCamera = async () => {
		if (running) return;
		if (!navigator.mediaDevices?.getUserMedia) {
			setStatus(
				window.isSecureContext
					? 'This browser has no camera API. Practice with the target diagram instead.'
					: 'Browsers only hand out the camera over HTTPS. Open this page on https://three.ws to be graded live.',
				'warn',
			);
			return;
		}
		let failedAt = 'camera';
		cameraBtn.disabled = true;
		cameraBtn.setAttribute('aria-busy', 'true');
		cameraBtn.textContent = 'Starting the camera...';
		document.body.dataset.smCamera = landmarker ? 'starting' : 'loading';
		try {
			if (!landmarker) {
				failedAt = 'tracker';
				setStatus('Loading the hand tracker (about 8 MB, once per browser).');
				const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
				const { modelUrl, visionWasmBase } = await import('./shared/mediapipe-assets.js');
				const fileset = await FilesetResolver.forVisionTasks(await visionWasmBase());
				landmarker = await HandLandmarker.createFromOptions(fileset, {
					baseOptions: {
						modelAssetPath: modelUrl('hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'),
						delegate: 'GPU',
					},
					runningMode: 'VIDEO',
					numHands: 1,
				});
			}
			failedAt = 'camera';
			document.body.dataset.smCamera = 'starting';
			stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480, facingMode: 'user' }, audio: false });
			video.srcObject = stream;
			await video.play();
			running = true;
			document.body.dataset.smCamera = 'on';
			cameraBtn.textContent = 'Turn the camera off';
			cameraBtn.setAttribute('aria-pressed', 'true');
			setStatus('Camera on. Nothing leaves this tab.', 'good');
			if (cameraNote) cameraNote.hidden = false;
			loop();
		} catch (err) {
			log.warn(`[sign-mirror] ${failedAt} failed`, err?.message);
			// A tracker that half-loaded is not reusable: drop it so the next
			// attempt downloads it again rather than throwing on a dead handle.
			if (failedAt === 'tracker') landmarker = null;
			stopCamera();
			setStatus(cameraFailureMessage(err, failedAt), 'warn');
		} finally {
			cameraBtn.disabled = false;
			cameraBtn.removeAttribute('aria-busy');
		}
	};

	const loop = () => {
		if (!running) return;
		raf = requestAnimationFrame(loop);
		if (!video.videoWidth || video.currentTime === lastVideoTime) return;
		lastVideoTime = video.currentTime;
		let result;
		try {
			result = landmarker.detectForVideo(video, performance.now());
		} catch (err) {
			// A tracker that throws mid-stream (a lost GPU context, a released
			// WASM heap) would otherwise kill the frame loop silently and leave
			// the page claiming the camera is on. Stop, and say why.
			log.warn('[sign-mirror] tracker failed', err?.message);
			landmarker = null;
			stopCamera();
			setStatus('The hand tracker stopped. Turn the camera on again to restart it.', 'warn');
			return;
		}
		const hand = result?.landmarks?.[0];
		if (!hand?.length) {
			setHint('No hand in frame. Hold one hand up, palm toward the camera.');
			if (overlay?.firstElementChild) overlay.replaceChildren();
			setScore(0, false, 0);
			return;
		}
		// The preview is mirrored so it reads like a mirror; the overlay has to
		// be mirrored with it or the skeleton lands on the wrong side.
		const box = overlay.viewBox.baseVal;
		drawSkeleton(
			overlay,
			hand.map((p) => ({ x: (1 - p.x) * box.width, y: p.y * box.height })),
			{ className: 'sm-skel sm-skel-live' },
		);
		gradeFrame(hand, performance.now());
	};

	// ── Letter selection ─────────────────────────────────────────────────────
	const bigEl = $('#sm-big');
	const noteEl = $('#sm-note');
	const lookEl = $('#sm-look');
	const sharedEl = $('#sm-shared');
	const movingEl = $('#sm-moving');

	function selectLetter(letter) {
		if (!LETTER_NOTES[letter]) return;
		current = letter;
		smoother.reset();
		setScore(0, false, 0);
		if (bigEl) bigEl.textContent = letter;
		if (noteEl) noteEl.textContent = LETTER_NOTES[letter].hand;
		if (lookEl) {
			lookEl.textContent = LETTER_NOTES[letter].look || '';
			lookEl.hidden = !LETTER_NOTES[letter].look;
		}
		if (sharedEl) {
			const twin = SHARED_SHAPE[letter];
			sharedEl.hidden = !twin;
			if (twin) sharedEl.textContent = `${letter} and ${twin} are the same handshape. What separates them is which way the hand points, so the score below cannot tell them apart: check the direction against the avatar.`;
		}
		if (movingEl) {
			movingEl.hidden = !MOVING.has(letter);
			if (MOVING.has(letter)) movingEl.textContent = `${letter} moves. The score checks the handshape only; watch the avatar for the path it traces.`;
		}
		document.querySelectorAll('.sm-letter').forEach((el) => {
			el.setAttribute('aria-pressed', String(el.dataset.char === letter));
		});
		drawTarget(letter);
		showOnAvatar(letter);
		lookedLike = '';
		lastRankAt = 0;
		if (!running) {
			setHint(IDLE_HINT);
			clearFingers();
		}
		const url = new URL(location.href);
		url.searchParams.set('letter', letter);
		history.replaceState(null, '', url);
	}

	// ── Course rail ──────────────────────────────────────────────────────────
	const railEl = $('#sm-rail');
	const buildRail = () => {
		if (!railEl) return;
		railEl.textContent = '';
		for (const section of COURSE) {
			const wrap = document.createElement('section');
			wrap.className = 'sm-group';
			const h = document.createElement('h3');
			h.textContent = section.title;
			const p = document.createElement('p');
			p.textContent = section.blurb;
			const row = document.createElement('div');
			row.className = 'sm-letters';
			for (const letter of section.letters) {
				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'sm-letter';
				btn.dataset.char = letter;
				btn.textContent = letter;
				btn.setAttribute('aria-pressed', String(letter === current));
				if (progress.passed[letter]) btn.dataset.passed = 'true';
				btn.addEventListener('click', () => selectLetter(letter));
				row.append(btn);
			}
			wrap.append(h, p, row);
			railEl.append(wrap);
		}
		renderLetterBest();
	};

	// The best score a letter has reached is worth seeing: it turns 26 identical
	// squares into a map of where the practice actually is. The sliver under the
	// letter is the score, and the label says it out loud for a screen reader.
	function renderLetterBest() {
		for (const btn of document.querySelectorAll('.sm-letter')) {
			const letter = btn.dataset.char;
			const best = progress.best[letter];
			const held = progress.passed[letter];
			btn.style.setProperty('--sm-best', `${Math.max(0, Math.min(100, best ?? 0))}%`);
			btn.dataset.tried = best == null ? 'false' : 'true';
			const label = held
				? `Practise the letter ${letter}, already held correctly`
				: best == null
					? `Practise the letter ${letter}, not attempted yet`
					: `Practise the letter ${letter}, best score ${best} of 100`;
			btn.setAttribute('aria-label', label);
			btn.title = label;
		}
	}

	const progressEl = $('#sm-progress');
	const progressBar = $('#sm-progress-bar');
	function renderProgress() {
		const done = ALL_COURSE_LETTERS.filter((l) => progress.passed[l]).length;
		const pct = Math.round((done / ALL_COURSE_LETTERS.length) * 100);
		if (progressEl) progressEl.textContent = `${done} of ${ALL_COURSE_LETTERS.length} letters held correctly`;
		if (progressBar) {
			progressBar.style.setProperty('--sm-fill', `${pct}%`);
			progressBar.setAttribute('aria-valuenow', String(done));
		}
	}

	// ── Controls ─────────────────────────────────────────────────────────────
	cameraBtn?.addEventListener('click', () => (running ? stopCamera() : startCamera()));

	replayBtn?.addEventListener('click', () => showOnAvatar(current));

	$('#sm-reset')?.addEventListener('click', () => {
		progress.passed = {};
		progress.best = {};
		writeJSON(PROGRESS_KEY, progress);
		document.querySelectorAll('.sm-letter[data-passed]').forEach((el) => el.removeAttribute('data-passed'));
		renderLetterBest();
		renderProgress();
		setStatus('Progress cleared. Every letter is back to unpractised.');
	});

	const handBtns = document.querySelectorAll('[data-hand]');
	handBtns.forEach((btn) => {
		btn.setAttribute('aria-pressed', String(btn.dataset.hand === dominant));
		btn.addEventListener('click', () => {
			dominant = btn.dataset.hand === 'Left' ? 'Left' : 'Right';
			handBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.hand === dominant)));
			saveSignPrefs({ dominant });
			drawTarget(current);
			showOnAvatar(current);
		});
	});

	document.addEventListener('keydown', (e) => {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const tag = e.target?.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
		const key = e.key.toUpperCase();
		if (LETTER_NOTES[key]) {
			selectLetter(key);
			e.preventDefault();
		}
	});

	// ── Boot ─────────────────────────────────────────────────────────────────
	setReplayable(false);
	buildRail();
	renderProgress();
	await mountStage();
	const wanted = new URLSearchParams(location.search).get('letter')?.toUpperCase();
	const first = LETTER_NOTES[wanted] ? wanted : ALL_COURSE_LETTERS.find((l) => !progress.passed[l]) || ALL_COURSE_LETTERS[0];
	// The stage crossfades into its idle after mounting; a letter played before
	// that lands is overwritten by it, so wait for the idle to take hold.
	for (let i = 0; i < 60 && stage?.anim && !stage.anim.currentName; i++) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	selectLetter(first);
	setStatus('');

	window.addEventListener('pagehide', stopCamera);
	document.addEventListener('visibilitychange', () => {
		if (document.hidden && running) stopCamera();
	});
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
