// /motion-swap — replace yourself in a video with your 3D avatar.
//
// Flow: upload a video → /api/motion-swap presigns storage and runs the
// video2motion worker (MediaPipe pose + person segmentation) → the job returns
// four artifacts: an AnimationClip JSON of the subject's motion on the
// canonical skeleton, a normalized video, a grayscale person-mask video, and
// per-frame screen anchors. This module composites them live in one WebGL
// scene: the video on a fullscreen quad (with the subject pixelated out under
// the mask), the chosen avatar retargeted onto the motion and pinned to the
// subject's on-screen anchor each frame, and a MediaRecorder export of the
// canvas + original audio to a downloadable .webm.

const STOCK_AVATARS = [
	{ id: 'default', name: 'Standard', url: '/avatars/default.glb' },
	{ id: 'michelle', name: 'Michelle', url: '/avatars/michelle.glb' },
	{ id: 'mannequin', name: 'Mannequin', url: '/avatars/mannequin.glb' },
	{ id: 'realistic-female', name: 'Realistic', url: '/avatars/realistic-female.glb' },
];

const POLL_MS = 3000;
const MAX_UPLOAD_BYTES = 256 * 1024 * 1024;

// Fraction of a standing figure's height at which the hip line sits; used to
// convert the anchor (hip centre) into a feet-on-ground placement.
const HIP_HEIGHT_FRACTION = 0.53;

const $ = (id) => document.getElementById(id);

const state = {
	three: null, // { THREE, renderer, scene, camera, quad, mixer, ... }
	job: null,
	artifacts: null, // { clip_url, meta_url, video_url, mask_url }
	meta: null,
	clipJSON: null,
	avatar: null, // { root, group, height, hipsRestY }
	avatarUrl: STOCK_AVATARS[0].url,
	privacy: true,
	recorder: null,
	recordedChunks: [],
	raf: 0,
};

function setStatus(text, kind = 'info') {
	const el = $('ms-status');
	if (!el) return;
	el.textContent = text;
	el.dataset.kind = kind;
	el.hidden = !text;
}

function showStage(stage) {
	for (const s of ['empty', 'processing', 'ready']) {
		const el = $(`ms-stage-${s}`);
		if (el) el.hidden = s !== stage;
	}
}

// ---------------------------------------------------------------------------
// Upload + job lifecycle
// ---------------------------------------------------------------------------

async function uploadVideo(file) {
	if (file.size > MAX_UPLOAD_BYTES) {
		throw new Error('Video is over 256 MB. Trim it down (90 seconds is the processing cap anyway).');
	}
	const type = file.type || 'video/mp4';
	setStatus('Requesting upload slot…');
	const presign = await fetch('/api/motion-swap', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ action: 'upload', content_type: type, size_bytes: file.size }),
	});
	const slot = await presign.json();
	if (!presign.ok) throw new Error(slot?.message || 'Upload is unavailable right now.');

	setStatus('Uploading video…');
	const put = await fetch(slot.upload_url, {
		method: slot.method || 'PUT',
		headers: slot.headers || { 'content-type': type },
		body: file,
	});
	if (!put.ok) throw new Error(`Upload failed (${put.status}). Try again.`);
	return slot.public_url;
}

async function submitJob(videoUrl) {
	setStatus('Starting capture…');
	const res = await fetch('/api/motion-swap', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ video_url: videoUrl }),
	});
	const data = await res.json();
	if (!res.ok) throw new Error(data?.message || 'Capture could not start.');
	return data;
}

async function pollJob(jobId, etaSeconds) {
	const started = Date.now();
	for (;;) {
		await new Promise((r) => setTimeout(r, POLL_MS));
		const res = await fetch(`/api/motion-swap?job=${encodeURIComponent(jobId)}`);
		const data = await res.json().catch(() => ({}));
		if (res.status >= 400) {
			throw new Error(data?.message || `Capture status unavailable (${res.status}).`);
		}
		if (data.status === 'done' && data.clip_url) return data;
		if (data.status === 'failed') {
			throw new Error(data.error || 'Capture failed. Make sure one person is clearly visible.');
		}
		const elapsed = Math.round((Date.now() - started) / 1000);
		const pct = etaSeconds ? Math.min(95, Math.round((elapsed / etaSeconds) * 100)) : null;
		setStatus(
			pct !== null
				? `Tracking motion… ${pct}% (about ${Math.max(1, etaSeconds - elapsed)}s left)`
				: `Tracking motion… ${elapsed}s`,
		);
	}
}

async function handleFile(file) {
	try {
		showStage('processing');
		const videoUrl = await uploadVideo(file);
		const job = await submitJob(videoUrl);
		state.job = job.job_id;
		const done = await pollJob(job.job_id, job.eta_seconds);
		history.replaceState(null, '', `?job=${encodeURIComponent(job.job_id)}`);
		state.artifacts = done;
		setStatus('Loading composite…');
		await loadComposite(done);
		showStage('ready');
		setStatus('');
	} catch (err) {
		showStage('empty');
		setStatus(err?.message || 'Something went wrong. Try another video.', 'error');
	}
}

// A finished capture is shareable/resumable: /motion-swap?job=<id> re-opens
// the composite without re-uploading (artifacts live at stable URLs).
async function resumeFromQuery() {
	const jobId = new URLSearchParams(location.search).get('job');
	if (!jobId) return;
	try {
		showStage('processing');
		const done = await pollJob(jobId, null);
		state.artifacts = done;
		setStatus('Loading composite…');
		await loadComposite(done);
		showStage('ready');
		setStatus('');
	} catch (err) {
		showStage('empty');
		setStatus(err?.message || 'That capture could not be reopened.', 'error');
	}
}

// ---------------------------------------------------------------------------
// three.js composite
// ---------------------------------------------------------------------------

async function bootThree() {
	if (state.three) return state.three;
	const [THREE, { GLTFLoader }] = await Promise.all([
		import('three'),
		import('three/addons/loaders/GLTFLoader.js'),
	]);
	const canvas = $('ms-canvas');
	const renderer = new THREE.WebGLRenderer({
		canvas,
		antialias: true,
		preserveDrawingBuffer: true,
	});
	renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
	renderer.outputColorSpace = THREE.SRGBColorSpace;

	const scene = new THREE.Scene();
	const camera = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0.1, 50);
	camera.position.z = 10;

	scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 2.2));
	const key = new THREE.DirectionalLight(0xffffff, 1.6);
	key.position.set(1.5, 3, 4);
	scene.add(key);

	state.three = { THREE, GLTFLoader, renderer, scene, camera, quad: null, mixer: null, action: null };
	return state.three;
}

function makeBackdrop(t, videoEl, maskEl) {
	const { THREE, scene } = t;
	const videoTex = new THREE.VideoTexture(videoEl);
	videoTex.colorSpace = THREE.SRGBColorSpace;
	const maskTex = new THREE.VideoTexture(maskEl);

	const material = new THREE.ShaderMaterial({
		uniforms: {
			tVideo: { value: videoTex },
			tMask: { value: maskTex },
			uPrivacy: { value: state.privacy ? 1.0 : 0.0 },
			uPixels: { value: 42.0 },
		},
		vertexShader: /* glsl */ `
			varying vec2 vUv;
			void main() {
				vUv = uv;
				gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
			}
		`,
		fragmentShader: /* glsl */ `
			uniform sampler2D tVideo;
			uniform sampler2D tMask;
			uniform float uPrivacy;
			uniform float uPixels;
			varying vec2 vUv;
			void main() {
				vec3 base = texture2D(tVideo, vUv).rgb;
				float m = texture2D(tMask, vUv).r;
				vec2 cell = floor(vUv * uPixels) / uPixels + 0.5 / uPixels;
				vec3 pix = texture2D(tVideo, cell).rgb;
				// Feathered mask edge so the pixelation doesn't halo hard.
				float k = smoothstep(0.35, 0.65, m) * uPrivacy;
				gl_FragColor = vec4(mix(base, pix, k), 1.0);
			}
		`,
		depthWrite: false,
	});

	if (t.quad) {
		t.quad.material.dispose();
		t.quad.material = material;
	} else {
		t.quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
		t.quad.position.z = 0;
		t.quad.renderOrder = -1;
		scene.add(t.quad);
	}
	return t.quad;
}

function layout(t, meta) {
	const { renderer, camera } = t;
	const holder = $('ms-canvas-wrap');
	const aspect = meta.width / meta.height;
	const w = holder.clientWidth || 960;
	const h = Math.round(w / aspect);
	renderer.setSize(w, h, false);
	// World units: backdrop height 1, width = aspect.
	camera.left = -aspect / 2;
	camera.right = aspect / 2;
	camera.top = 0.5;
	camera.bottom = -0.5;
	camera.updateProjectionMatrix();
	t.quad.scale.set(aspect, 1, 1);
}

async function loadAvatar(t, url) {
	const { THREE, GLTFLoader, scene } = t;
	setStatus('Loading avatar…');
	const [buf, canonMod, retargetMod] = await Promise.all([
		fetch(url).then((r) => {
			if (!r.ok) throw new Error(`Avatar fetch failed (${r.status}).`);
			return r.arrayBuffer();
		}),
		import('./glb-canonicalize.js'),
		import('./animation-retarget.js'),
	]);
	let glb = buf;
	try {
		const canon = canonMod.canonicalizeGLBBones(buf);
		if (canon?.buffer) glb = canon.buffer;
		else if (canon instanceof ArrayBuffer) glb = canon;
	} catch {
		// Not canonicalizable (already canonical or unusual container) — retarget
		// still resolves bone names through the same mapping at clip-bind time.
	}
	const gltf = await new GLTFLoader().parseAsync(glb, '');
	const root = gltf.scene;

	if (state.avatar?.group) scene.remove(state.avatar.group);
	if (t.mixer) {
		t.mixer.stopAllAction();
		t.mixer = null;
		t.action = null;
	}

	const group = new THREE.Group();
	group.add(root);
	scene.add(group);
	root.updateMatrixWorld(true);

	const bbox = new THREE.Box3().setFromObject(root);
	const height = Math.max(0.01, bbox.max.y - bbox.min.y);
	let hipsRestY = bbox.min.y + height * HIP_HEIGHT_FRACTION;
	root.traverse((n) => {
		if (n.name === 'Hips') {
			const p = new THREE.Vector3();
			n.getWorldPosition(p);
			hipsRestY = p.y;
		}
	});

	state.avatar = { root, group, height, hipsRestY, baseMinY: bbox.min.y, retargetMod };

	if (state.clipJSON) bindClip(t);
	setStatus('');
}

function bindClip(t) {
	const { retargetMod } = state.avatar;
	const clip = retargetMod.parseClipJSON(state.clipJSON, 'motion-swap');
	const result = retargetMod.retargetClipToObject(clip, state.avatar.root, { minCoverage: 0.3 });
	const bound = result?.clip;
	if (!bound) {
		throw new Error(
			'That model has no compatible humanoid skeleton. Load a rigged avatar GLB (generate one at /create).',
		);
	}
	t.mixer = new t.THREE.AnimationMixer(state.avatar.root);
	t.action = t.mixer.clipAction(bound);
	t.action.play();
	t.mixer.setTime(0);
}

function anchorAt(timeSec) {
	const meta = state.meta;
	if (!meta?.anchors?.length) return null;
	const idx = Math.max(0, Math.min(meta.anchors.length - 1, Math.floor(timeSec * meta.fps)));
	return meta.anchors[idx];
}

function placeAvatar(t, timeSec) {
	const a = anchorAt(timeSec);
	const av = state.avatar;
	if (!a || !av) return;
	const aspect = state.meta.width / state.meta.height;
	av.group.visible = a.v === 1;
	if (!av.group.visible) return;

	// Anchor: hip centre in normalized image coords (y down) + subject height
	// as a fraction of frame height. Backdrop is height-1 world units.
	const scale = Math.max(0.02, a.h / av.height);
	const hipWorldX = (a.x - 0.5) * aspect;
	const hipWorldY = 0.5 - a.y;
	av.group.scale.setScalar(scale);
	av.group.position.set(hipWorldX, hipWorldY - av.hipsRestY * scale, 1.0);
}

async function loadComposite(artifacts) {
	const t = await bootThree();
	const videoEl = $('ms-video');
	const maskEl = $('ms-mask');
	videoEl.crossOrigin = 'anonymous';
	maskEl.crossOrigin = 'anonymous';
	videoEl.src = artifacts.video_url;
	maskEl.src = artifacts.mask_url;
	maskEl.muted = true;

	const [meta, clipJSON] = await Promise.all([
		fetch(artifacts.meta_url).then((r) => r.json()),
		fetch(artifacts.clip_url).then((r) => r.json()),
	]);
	state.meta = meta;
	state.clipJSON = clipJSON;

	makeBackdrop(t, videoEl, maskEl);
	layout(t, meta);
	await loadAvatar(t, state.avatarUrl);

	await Promise.all([
		new Promise((r) => (videoEl.readyState >= 2 ? r() : videoEl.addEventListener('loadeddata', r, { once: true }))),
		new Promise((r) => (maskEl.readyState >= 2 ? r() : maskEl.addEventListener('loadeddata', r, { once: true }))),
	]);

	// Keep the mask clock glued to the main video.
	videoEl.addEventListener('play', () => maskEl.play().catch(() => {}));
	videoEl.addEventListener('pause', () => maskEl.pause());
	videoEl.addEventListener('seeked', () => {
		maskEl.currentTime = videoEl.currentTime;
	});

	cancelAnimationFrame(state.raf);
	const tick = () => {
		state.raf = requestAnimationFrame(tick);
		const time = videoEl.currentTime || 0;
		if (Math.abs(maskEl.currentTime - time) > 0.12 && !maskEl.seeking) {
			maskEl.currentTime = time;
		}
		if (t.mixer) t.mixer.setTime(Math.min(time, state.clipDuration ?? time));
		placeAvatar(t, time);
		t.renderer.render(t.scene, t.camera);
	};
	state.clipDuration = clipJSON.duration;
	tick();

	videoEl.play().catch(() => {
		// Autoplay refused — the play button drives it.
	});
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function startExport() {
	const t = state.three;
	const videoEl = $('ms-video');
	if (!t || !videoEl?.src) return;
	const btn = $('ms-export');
	btn.disabled = true;
	btn.textContent = 'Recording…';

	const stream = t.renderer.domElement.captureStream(30);
	// Mix the source audio in when the browser exposes it.
	try {
		const audio = videoEl.captureStream?.() || videoEl.mozCaptureStream?.();
		for (const track of audio?.getAudioTracks?.() || []) stream.addTrack(track);
	} catch {
		// Cross-origin audio unavailable — export video-only.
	}

	const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
		? 'video/webm;codecs=vp9,opus'
		: 'video/webm';
	state.recordedChunks = [];
	state.recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
	state.recorder.ondataavailable = (e) => {
		if (e.data.size) state.recordedChunks.push(e.data);
	};
	state.recorder.onstop = () => {
		const blob = new Blob(state.recordedChunks, { type: 'video/webm' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'motion-swap.webm';
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
		btn.disabled = false;
		btn.textContent = 'Export video';
	};

	videoEl.onended = () => {
		if (state.recorder?.state === 'recording') state.recorder.stop();
		videoEl.onended = null;
	};
	videoEl.currentTime = 0;
	state.recorder.start(250);
	videoEl.play();
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

function wireUI() {
	const drop = $('ms-drop');
	const input = $('ms-file');

	drop.addEventListener('click', () => input.click());
	drop.addEventListener('keydown', (e) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			input.click();
		}
	});
	input.addEventListener('change', () => {
		if (input.files?.[0]) handleFile(input.files[0]);
		input.value = '';
	});
	for (const evt of ['dragover', 'dragenter']) {
		drop.addEventListener(evt, (e) => {
			e.preventDefault();
			drop.classList.add('is-drag');
		});
	}
	for (const evt of ['dragleave', 'drop']) {
		drop.addEventListener(evt, (e) => {
			e.preventDefault();
			drop.classList.remove('is-drag');
		});
	}
	drop.addEventListener('drop', (e) => {
		const file = e.dataTransfer?.files?.[0];
		if (file && file.type.startsWith('video/')) handleFile(file);
		else if (file) setStatus('That is not a video file.', 'error');
	});

	// Avatar picker.
	const picker = $('ms-avatars');
	for (const av of STOCK_AVATARS) {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'ms-avatar-chip';
		b.textContent = av.name;
		b.dataset.url = av.url;
		if (av.url === state.avatarUrl) b.setAttribute('aria-pressed', 'true');
		b.addEventListener('click', async () => {
			picker.querySelectorAll('[aria-pressed]').forEach((x) => x.removeAttribute('aria-pressed'));
			b.setAttribute('aria-pressed', 'true');
			state.avatarUrl = av.url;
			if (state.three && state.artifacts) {
				try {
					await loadAvatar(state.three, av.url);
				} catch (err) {
					setStatus(err?.message || 'Avatar failed to load.', 'error');
				}
			}
		});
		picker.appendChild(b);
	}
	$('ms-avatar-url-go').addEventListener('click', async () => {
		const url = $('ms-avatar-url').value.trim();
		if (!url) return;
		picker.querySelectorAll('[aria-pressed]').forEach((x) => x.removeAttribute('aria-pressed'));
		state.avatarUrl = url;
		if (state.three && state.artifacts) {
			try {
				await loadAvatar(state.three, url);
			} catch (err) {
				setStatus(err?.message || 'Avatar failed to load. Is it a rigged humanoid GLB?', 'error');
			}
		}
	});

	$('ms-privacy').addEventListener('change', (e) => {
		state.privacy = e.target.checked;
		const quad = state.three?.quad;
		if (quad) quad.material.uniforms.uPrivacy.value = state.privacy ? 1.0 : 0.0;
	});

	$('ms-play').addEventListener('click', () => {
		const v = $('ms-video');
		if (v.paused) v.play();
		else v.pause();
	});
	$('ms-restart').addEventListener('click', () => {
		const v = $('ms-video');
		v.currentTime = 0;
		v.play();
	});
	$('ms-export').addEventListener('click', startExport);
	$('ms-new').addEventListener('click', () => {
		$('ms-video').pause();
		showStage('empty');
		setStatus('');
	});

	window.addEventListener('resize', () => {
		if (state.three && state.meta) layout(state.three, state.meta);
	});
}

wireUI();
showStage('empty');
resumeFromQuery();
