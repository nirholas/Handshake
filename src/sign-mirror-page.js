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
import { buildFingerspellingClip, normalizeWord } from './fingerspelling.js';
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

/** Draw a hand skeleton into an SVG element from 21 projected points. */
function drawSkeleton(svg, points, { className = '' } = {}) {
	const ns = 'http://www.w3.org/2000/svg';
	svg.textContent = '';
	const g = document.createElementNS(ns, 'g');
	if (className) g.setAttribute('class', className);
	for (const [a, b] of HAND_CONNECTIONS) {
		const line = document.createElementNS(ns, 'line');
		line.setAttribute('x1', points[a].x.toFixed(1));
		line.setAttribute('y1', points[a].y.toFixed(1));
		line.setAttribute('x2', points[b].x.toFixed(1));
		line.setAttribute('y2', points[b].y.toFixed(1));
		g.append(line);
	}
	points.forEach((p, i) => {
		const dot = document.createElementNS(ns, 'circle');
		dot.setAttribute('cx', p.x.toFixed(1));
		dot.setAttribute('cy', p.y.toFixed(1));
		dot.setAttribute('r', i === 0 || i % 4 === 0 ? '3.6' : '2.4');
		g.append(dot);
	});
	svg.append(g);
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
	const mountStage = async () => {
		stage?.dispose();
		stage = new PoseStage(stageHost, { glbUrl: avatar.url, framing: 'portrait' });
		try {
			const { supported } = await stage.mount();
			stage.start();
			canSign = !!supported;
			if (!supported) setStatus('This avatar has no finger bones. Practice still works: the target diagram and the scoring do not need it.', 'warn');
			return canSign;
		} catch (err) {
			log.warn('[sign-mirror] stage mount failed', err?.message);
			canSign = false;
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

	const renderFingers = (grade) => {
		if (!fingersEl) return;
		fingersEl.textContent = '';
		for (const f of grade.fingers) {
			const row = document.createElement('div');
			row.className = 'sm-finger';
			row.dataset.state = f.score >= 0.8 ? 'good' : f.score >= 0.5 ? 'close' : 'far';
			const name = document.createElement('span');
			name.className = 'sm-finger-name';
			name.textContent = f.finger;
			const bar = document.createElement('span');
			bar.className = 'sm-finger-bar';
			bar.style.setProperty('--sm-fill', `${Math.round(f.score * 100)}%`);
			row.append(name, bar);
			fingersEl.append(row);
		}
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
		if (hintEl) hintEl.textContent = `${letter} passed. Next letter loaded.`;
		const idx = ALL_COURSE_LETTERS.indexOf(letter);
		const next = ALL_COURSE_LETTERS.slice(idx + 1).find((l) => !progress.passed[l]) || ALL_COURSE_LETTERS.find((l) => !progress.passed[l]);
		if (next) window.setTimeout(() => selectLetter(next), 900);
		else setStatus('Every letter passed. You can read and make the whole manual alphabet.', 'good');
	};

	const gradeFrame = (landmarks, now) => {
		const target = MOVING.has(current) ? current : current;
		let grade;
		try {
			grade = gradeHandshape(landmarks, target);
		} catch (err) {
			log.warn('[sign-mirror] grade failed', err?.message);
			return;
		}
		const state = smoother.push(grade, now);
		setScore(state.score, state.holding, state.heldMs);
		renderFingers(grade);
		if (progress.best[current] == null || state.score > progress.best[current]) {
			progress.best[current] = Math.round(state.score);
		}
		if (state.passed) {
			smoother.reset();
			onPassed(current);
			return;
		}
		if (hintEl) {
			// When the hand is a long way off, say what it DOES look like: a
			// learner making a clean B while aiming for D is helped far more by
			// "that is a B" than by "straighten your ring finger".
			if (state.score < 45) {
				const [best] = rankHandshapes(landmarks, LETTERS.filter((l) => !MOVING.has(l)));
				hintEl.textContent = best && best.name !== current && best.score > 70 ? `That is a clean ${best.name}. For ${current}: ${grade.hint}` : grade.hint;
			} else {
				hintEl.textContent = grade.hint;
			}
		}
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
		if (fingersEl) fingersEl.textContent = '';
		if (hintEl) hintEl.textContent = '';
	};

	const startCamera = async () => {
		if (running) return;
		if (!navigator.mediaDevices?.getUserMedia) {
			setStatus('This browser has no camera API. Practice with the target diagram instead.', 'warn');
			return;
		}
		cameraBtn.disabled = true;
		cameraBtn.textContent = 'Starting the camera...';
		try {
			if (!landmarker) {
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
			log.warn('[sign-mirror] camera failed', err?.message);
			const denied = /denied|not allowed/i.test(err?.message || '');
			setStatus(
				denied
					? 'Camera permission was refused. Allow it in your browser address bar, then try again.'
					: `The camera could not start: ${err?.message || 'unknown error'}. The target diagram still works.`,
				'warn',
			);
			stopCamera();
		} finally {
			cameraBtn.disabled = false;
		}
	};

	const loop = () => {
		if (!running) return;
		raf = requestAnimationFrame(loop);
		if (!video.videoWidth || video.currentTime === lastVideoTime) return;
		lastVideoTime = video.currentTime;
		const result = landmarker.detectForVideo(video, performance.now());
		const hand = result?.landmarks?.[0];
		if (!hand?.length) {
			if (hintEl) hintEl.textContent = 'No hand in frame. Hold one hand up, palm toward the camera.';
			overlay?.replaceChildren();
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
		if (hintEl && !running) hintEl.textContent = 'Turn the camera on to be graded, or just copy the diagram.';
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
				btn.setAttribute('aria-label', `Practise the letter ${letter}`);
				if (progress.passed[letter]) btn.dataset.passed = 'true';
				btn.addEventListener('click', () => selectLetter(letter));
				row.append(btn);
			}
			wrap.append(h, p, row);
			railEl.append(wrap);
		}
	};

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

	$('#sm-replay')?.addEventListener('click', () => showOnAvatar(current));

	$('#sm-reset')?.addEventListener('click', () => {
		progress.passed = {};
		progress.best = {};
		writeJSON(PROGRESS_KEY, progress);
		document.querySelectorAll('.sm-letter[data-passed]').forEach((el) => el.removeAttribute('data-passed'));
		renderProgress();
		setStatus('Progress cleared.');
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
		if (tag === 'INPUT' || tag === 'TEXTAREA') return;
		const key = e.key.toUpperCase();
		if (LETTER_NOTES[key]) {
			selectLetter(key);
			e.preventDefault();
		}
	});

	// ── Boot ─────────────────────────────────────────────────────────────────
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
