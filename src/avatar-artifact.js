/**
 * /avatar-artifact: the standalone viewer for avatar artifacts.
 *
 * The page is meant to be pasted into another site as a bare iframe, so it
 * carries no wrapper chrome from the app shell and pulls no third-party CDN:
 * three.js ships with the bundle, because an embed host never agreed to a
 * cross-origin script tag.
 *
 * Three modes, one stage. The lighting, ground, fog and drifting motes are
 * shared so a link always lands somewhere composed:
 *
 *   ?agent=<uuid>   the agent's avatar, resolved live from /api/agents/:id
 *   ?model=<url>    any GLB on an allowlisted host (mirrors /api/artifact)
 *   (no params)     the house portrait: a procedural figure that tracks you
 *
 * Failure is designed, never blank: a missing agent, a private avatar, a
 * blocked host and a broken GLB each say what happened and offer the next
 * move. The copy lives on the markup (data-msg-*) so it stays translatable
 * alongside the rest of the page.
 */

import { resolveDevR2Url } from './shared/dev-r2-proxy.js';
import { getMeshoptDecoder } from './viewer/internal.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Hosts a ?model= URL may point at. Same set the server-side artifact endpoint
// enforces (specs/CLAUDE_ARTIFACT.md) plus the public R2 domain this platform
// actually serves avatars from. Anything else is refused with a designed error
// rather than rendered under the three.ws origin.
const ALLOWED_MODEL_HOSTS = [
	/^[^.]+\.r2\.dev$/,
	/^.+\.r2\.cloudflarestorage\.com$/,
	/^.+\.amazonaws\.com$/,
	/^.+\.cloudfront\.net$/,
	/^storage\.googleapis\.com$/,
	/^.+\.blob\.core\.windows\.net$/,
	/^three\.ws$/,
	/^.+\.vercel\.app$/,
];

const params = new URLSearchParams(location.search);
const agentParam = (params.get('agent') || '').trim();
const modelParam = (params.get('model') || '').trim();

const els = {
	loading: document.getElementById('loading'),
	loadingNote: document.getElementById('loading-note'),
	error: document.getElementById('error'),
	title: document.getElementById('artifact-title'),
	source: document.getElementById('artifact-source'),
};

/** Report a designed failure. `mode` selects the copy authored on #error. */
function fail(mode, action) {
	const detail = mode && els.error ? els.error.dataset[mode] : '';
	window.__avatarArtifactFailed(detail || '', action);
}

/**
 * Write live data into a translated node. `data-i18n-owned` is the platform's
 * hand-off marker (see applyCatalog in src/i18n.js): the catalog pass lands
 * after an async fetch and would otherwise revert an agent's name back to the
 * English placeholder.
 */
function setOwnText(el, text) {
	if (!el) return;
	el.dataset.i18nOwned = '1';
	el.textContent = text;
}

function setLoadingNote(text) {
	setOwnText(els.loadingNote, text);
}

// ---------------------------------------------------------------------------
// Artifact resolution: what are we actually rendering?
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{kind:'house'}|{kind:'model',url:string,name:string,href:string,embed:string}|null>}
 * null means a failure state has already been rendered.
 */
async function resolveArtifact() {
	if (agentParam && modelParam) {
		fail('msgBoth');
		return null;
	}

	if (modelParam) {
		let parsed;
		try {
			parsed = new URL(modelParam, location.href);
		} catch {
			fail('msgModelBlocked');
			return null;
		}
		const sameOrigin = parsed.origin === location.origin;
		const allowed =
			sameOrigin ||
			(parsed.protocol === 'https:' && ALLOWED_MODEL_HOSTS.some((re) => re.test(parsed.hostname)));
		if (!allowed) {
			fail('msgModelBlocked');
			return null;
		}
		return {
			kind: 'model',
			url: parsed.href,
			name: '',
			href: '',
			embed: `?model=${encodeURIComponent(parsed.href)}`,
		};
	}

	if (agentParam) {
		if (!UUID_RE.test(agentParam)) {
			fail('msgNotFound', { href: '/agents', label: els.error?.dataset.actionAgents || '' });
			return null;
		}
		setLoadingNote(els.loading?.dataset.noteAgent || '');

		let payload;
		try {
			const res = await fetch(`/api/agents/${agentParam}`, { headers: { accept: 'application/json' } });
			if (res.status === 404) {
				fail('msgNotFound', { href: '/agents', label: els.error?.dataset.actionAgents || '' });
				return null;
			}
			if (!res.ok) {
				fail('msgAgentFetch', { href: '/agents', label: els.error?.dataset.actionAgents || '' });
				return null;
			}
			payload = await res.json();
		} catch {
			fail('msgAgentFetch', { href: '/agents', label: els.error?.dataset.actionAgents || '' });
			return null;
		}

		const agent = payload?.agent || payload;
		const href = `/agent/${agentParam}`;
		const label = els.error?.dataset.actionProfile || '';
		if (!agent?.id) {
			fail('msgNotFound', { href: '/agents', label: els.error?.dataset.actionAgents || '' });
			return null;
		}
		if (!agent.avatar_model_url) {
			fail(agent.avatar_id ? 'msgAvatarPrivate' : 'msgNoAvatar', { href, label });
			return null;
		}
		return {
			kind: 'model',
			url: agent.avatar_model_url,
			name: agent.name || '',
			href,
			linkLabel: label,
			embed: `?agent=${encodeURIComponent(agentParam)}`,
		};
	}

	return { kind: 'house' };
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let THREE;
let GLTFLoader;
let meshoptDecoder;
let fatal = false;

const artifact = await resolveArtifact();
if (artifact) {
	let runtimeReady = false;
	try {
		THREE = await import('three');
		if (artifact.kind === 'model') {
			// Loaded only on the artifact lane: the house portrait is pure geometry
			// and must not pay for a loader it never calls. Meshopt is mandatory
			// here (see the decoder note in src/viewer/internal.js); draco and KTX2
			// are not, because the avatar bake never emits them.
			const [loaderMod, decoder] = await Promise.all([
				import('three/addons/loaders/GLTFLoader.js'),
				getMeshoptDecoder(),
			]);
			GLTFLoader = loaderMod.GLTFLoader;
			meshoptDecoder = decoder;
		}
		runtimeReady = true;
	} catch {
		// The runtime itself never arrived: the generic "couldn't load" copy.
		window.__avatarArtifactFailed();
	}
	if (runtimeReady) boot(artifact);
}

function boot(artifact) {
	const W = window.innerWidth,
		H = window.innerHeight;
	const scene = new THREE.Scene();
	const camera = new THREE.PerspectiveCamera(42, W / H, 0.1, 100);
	camera.position.set(0, 1.6, 4.2);
	camera.lookAt(0, 1.6, 0);

	// Coarse pointer (phones/tablets) -> lighter render: fewer DPR samples
	// and no shadow pass, so the canvas stays smooth on mobile GPUs.
	const isCoarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
	const reduceMotion =
		window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	let renderer;
	try {
		renderer = new THREE.WebGLRenderer({ antialias: !isCoarse, alpha: true });
	} catch {
		// No WebGL context available: show the designed error state.
		fail('msgNoWebgl');
		return;
	}
	renderer.setSize(W, H);
	renderer.setPixelRatio(Math.min(devicePixelRatio, isCoarse ? 1.5 : 2));
	renderer.shadowMap.enabled = !isCoarse;
	document.body.appendChild(renderer.domElement);

	// Lights. Intensities are in physical units (three r155+ dropped the
	// legacy PI scaling), so they read high next to the old CDN build.
	scene.add(new THREE.AmbientLight(0x2a2a5a, 3.8));

	const key = new THREE.DirectionalLight(0x99aaff, 6.9);
	key.position.set(2, 5, 4);
	key.castShadow = true;
	scene.add(key);

	const rim = new THREE.PointLight(0xff4488, 22, 10, 1.4);
	rim.position.set(-3, 2, -1);
	scene.add(rim);

	const fill = new THREE.PointLight(0x4488ff, 12, 8, 1.4);
	fill.position.set(3, 0, 2);
	scene.add(fill);

	// Ground plane (subtle)
	const ground = new THREE.Mesh(
		new THREE.CircleGeometry(3, 48),
		new THREE.MeshStandardMaterial({ color: 0x0a0a20, roughness: 0.9, metalness: 0.1 }),
	);
	ground.rotation.x = -Math.PI / 2;
	ground.receiveShadow = true;
	scene.add(ground);

	// Fog
	scene.fog = new THREE.FogExp2(0x070714, 0.06);

	// Particles
	const pCount = 120;
	const pPos = new Float32Array(pCount * 3);
	const pVel = new Float32Array(pCount);
	for (let i = 0; i < pCount; i++) {
		pPos[i * 3] = (Math.random() - 0.5) * 8;
		pPos[i * 3 + 1] = Math.random() * 5;
		pPos[i * 3 + 2] = (Math.random() - 0.5) * 8;
		pVel[i] = 0.003 + Math.random() * 0.008;
	}
	const pGeo = new THREE.BufferGeometry();
	pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
	const pMat = new THREE.PointsMaterial({
		color: 0x6699ff,
		size: 0.04,
		transparent: true,
		opacity: 0.55,
	});
	const pts = new THREE.Points(pGeo, pMat);
	scene.add(pts);

	// Input tracking (mouse, touch, keyboard). Every modality drives one
	// normalized look-target, so the house portrait's gaze and the artifact
	// turntable share a single code path.
	const mouse = { x: 0, y: 0 };
	let keyTarget = null; // when set, keyboard overrides pointer

	function aim(clientX, clientY) {
		mouse.x = (clientX / window.innerWidth - 0.5) * 2;
		mouse.y = (clientY / window.innerHeight - 0.5) * 2;
	}

	window.addEventListener('mousemove', (e) => {
		keyTarget = null;
		aim(e.clientX, e.clientY);
	});

	// Touch: track a finger drag so the portrait is interactive on phones.
	window.addEventListener(
		'touchmove',
		(e) => {
			const tch = e.touches && e.touches[0];
			if (!tch) return;
			keyTarget = null;
			aim(tch.clientX, tch.clientY);
		},
		{ passive: true },
	);

	const canvasEl = renderer.domElement;
	canvasEl.tabIndex = 0;
	canvasEl.setAttribute('role', 'img');
	canvasEl.setAttribute(
		'aria-label',
		document.body.dataset.canvasLabel ||
			'Interactive 3D avatar that follows your cursor, touch, or arrow keys',
	);

	// Zoom lives on the artifact lane only: the house portrait is framed as a
	// portrait and has nothing to inspect closer.
	let zoom = 1;
	const ZOOM_MIN = 0.55;
	const ZOOM_MAX = 2.4;
	function nudgeZoom(delta) {
		zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, zoom * delta));
	}

	// Keyboard: arrow keys and WASD nudge the gaze, so the viewer is
	// usable without a pointer. Only the arrows suppress their default
	// (scrolling); the letters stay available to the browser.
	const KEY_STEP = 0.25;
	const KEY_MAP = {
		arrowleft: [-1, 0],
		a: [-1, 0],
		arrowright: [1, 0],
		d: [1, 0],
		arrowup: [0, -1],
		w: [0, -1],
		arrowdown: [0, 1],
		s: [0, 1],
	};
	window.addEventListener('keydown', (e) => {
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		const target = e.target;
		// Never steal a keystroke aimed at the embed field or a control.
		if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
		const k = e.key.toLowerCase();
		if (artifact.kind === 'model' && (k === '+' || k === '=' || k === '-' || k === '_')) {
			e.preventDefault();
			nudgeZoom(k === '-' || k === '_' ? 1.12 : 0.89);
			return;
		}
		const v = KEY_MAP[k];
		if (!v) return;
		if (k.startsWith('arrow')) e.preventDefault();
		if (!keyTarget) keyTarget = { x: mouse.x, y: mouse.y };
		keyTarget.x = Math.max(-1, Math.min(1, keyTarget.x + v[0] * KEY_STEP));
		keyTarget.y = Math.max(-1, Math.min(1, keyTarget.y + v[1] * KEY_STEP));
		mouse.x = keyTarget.x;
		mouse.y = keyTarget.y;
	});

	const stage =
		artifact.kind === 'model'
			? buildArtifactStage(scene, camera, renderer, artifact)
			: buildHousePortrait(scene);

	// Animate
	let t = 0;
	let firstFramePainted = false;

	function frame() {
		t += 0.016;
		stage.update(t, mouse, zoom, reduceMotion);

		// Particles drift upward
		if (!reduceMotion) {
			const pos = pGeo.attributes.position;
			for (let i = 0; i < pCount; i++) {
				pos.array[i * 3 + 1] += pVel[i];
				if (pos.array[i * 3 + 1] > 5) pos.array[i * 3 + 1] = 0;
			}
			pos.needsUpdate = true;
			pts.rotation.y += 0.0006;
		}

		renderer.render(scene, camera);

		// Fade out the loading overlay once the first frame is on screen. The
		// artifact lane holds the overlay until its GLB has actually arrived,
		// so an empty stage is never mistaken for a finished render.
		if (!firstFramePainted && stage.ready()) {
			firstFramePainted = true;
			window.__avatarArtifactPainted = true;
			clearTimeout(window.__avatarArtifactWatchdog);
			// A slow runtime can trip the watchdog and still arrive; the
			// error state must not outlive a working scene.
			document.getElementById('error')?.setAttribute('hidden', '');
			const loading = document.getElementById('loading');
			if (loading) {
				loading.classList.add('fade');
				setTimeout(() => loading.setAttribute('hidden', ''), 450);
			}
		}
	}

	renderer.setAnimationLoop(frame);

	if (artifact.kind === 'model') {
		// Wheel zoom is non-passive on purpose: an embedded viewer that scrolled
		// its host page while you inspected a model would be hostile.
		window.addEventListener(
			'wheel',
			(e) => {
				e.preventDefault();
				nudgeZoom(e.deltaY > 0 ? 1.08 : 0.93);
			},
			{ passive: false },
		);
	}

	// A hidden tab has nothing to animate: stop the loop so an embedded
	// viewer never burns a host page's GPU in the background. Same reason the
	// loop never restarts after a fatal load error: the error overlay is opaque,
	// so every frame under it would be pure waste on someone else's page.
	document.addEventListener('visibilitychange', () => {
		renderer.setAnimationLoop(document.hidden || fatal ? null : frame);
	});

	// Keep the canvas matched to the viewport (handles orientation changes
	// and mobile browser-chrome resize, not just desktop window drags).
	function onResize() {
		const w = window.innerWidth,
			h = window.innerHeight;
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		renderer.setSize(w, h);
	}
	window.addEventListener('resize', onResize);
	window.addEventListener('orientationchange', onResize);
}

// ---------------------------------------------------------------------------
// The artifact lane: a real GLB on a turntable
// ---------------------------------------------------------------------------

function buildArtifactStage(scene, camera, renderer, artifact) {
	// PBR glTF materials are authored for a filmic response; the house portrait
	// is hand-lit and keeps the linear default.
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.05;

	const pivot = new THREE.Group();
	scene.add(pivot);

	let mixer = null;
	let loaded = false;
	let focusY = 1.0;
	let baseDist = 3.2;
	let yaw = 0;
	let pitch = 0;

	if (artifact.name) {
		setOwnText(els.title, artifact.name);
		document.title = `${artifact.name} · Avatar Artifact · three.ws`;
	}
	if (artifact.href && els.source) {
		els.source.href = artifact.href;
		if (artifact.linkLabel) setOwnText(els.source, artifact.linkLabel);
		els.source.removeAttribute('hidden');
	}
	window.__avatarArtifactSetEmbed?.(artifact.embed);
	setLoadingNote(els.loading?.dataset.noteModel || '');

	const loader = new GLTFLoader();
	// three.ws avatars ship with EXT_meshopt_compression; without this decoder
	// every one of them fails to parse.
	loader.setMeshoptDecoder(meshoptDecoder);

	function stop() {
		fatal = true;
		renderer.setAnimationLoop(null);
	}

	// A multi-megabyte GLB on a slow connection legitimately outlives the boot
	// watchdog, so the download re-arms it on every progress tick. A transfer
	// that goes quiet for the full window still lands in the error state.
	window.__avatarArtifactHeartbeat?.();

	loader.load(
		resolveDevR2Url(artifact.url),
		(gltf) => {
			const root = gltf.scene || gltf.scenes?.[0];
			if (!root) {
				stop();
				fail('msgModelFailed');
				return;
			}
			root.traverse((node) => {
				if (!node.isMesh) return;
				node.castShadow = true;
				node.receiveShadow = true;
			});

			// Normalize to a portrait-sized subject so one stage frames every
			// artifact, from a 20 cm prop to a 6 m mech.
			const box = new THREE.Box3().setFromObject(root);
			const size = box.getSize(new THREE.Vector3());
			const center = box.getCenter(new THREE.Vector3());
			const height = Math.max(size.y, 1e-3);
			const scale = 1.8 / height;
			root.scale.setScalar(scale);
			root.position.set(-center.x * scale, -(center.y - size.y / 2) * scale, -center.z * scale);
			pivot.add(root);

			const radius = Math.max(size.x, size.z, size.y) * scale;
			focusY = 0.95;
			baseDist = Math.max(2.6, radius * 1.55);

			if (gltf.animations?.length) {
				mixer = new THREE.AnimationMixer(root);
				const clip =
					gltf.animations.find((c) => /idle|breath|stand/i.test(c.name || '')) ||
					gltf.animations[0];
				mixer.clipAction(clip).play();
			}
			loaded = true;
		},
		(progress) => {
			window.__avatarArtifactHeartbeat?.();
			if (!progress?.lengthComputable || !els.loading?.dataset.noteProgress) return;
			const pct = Math.min(99, Math.round((progress.loaded / progress.total) * 100));
			setLoadingNote(els.loading.dataset.noteProgress.replace('{pct}', String(pct)));
		},
		() => {
			stop();
			fail(
				'msgModelFailed',
				artifact.href ? { href: artifact.href, label: artifact.linkLabel || '' } : null,
			);
		},
	);

	const clock = new THREE.Clock();

	return {
		ready: () => loaded,
		update(t, mouse, zoom, reduceMotion) {
			if (mixer) mixer.update(clock.getDelta());

			// Turntable: the shared look-target orbits the camera instead of
			// turning a head, because an arbitrary GLB has no head to turn.
			const targetYaw = mouse.x * Math.PI * 0.55;
			const targetPitch = Math.max(-0.35, Math.min(0.85, -mouse.y * 0.55));
			yaw += (targetYaw - yaw) * 0.06;
			pitch += (targetPitch - pitch) * 0.06;

			const drift = reduceMotion ? 0 : Math.sin(t * 0.25) * 0.08;
			const r = baseDist * zoom;
			const cp = Math.cos(pitch);
			camera.position.set(
				Math.sin(yaw + drift) * r * cp,
				focusY + Math.sin(pitch) * r,
				Math.cos(yaw + drift) * r * cp,
			);
			camera.lookAt(0, focusY, 0);
		},
	};
}

// ---------------------------------------------------------------------------
// The house portrait: the artifact the page is itself
// ---------------------------------------------------------------------------

function buildHousePortrait(scene) {
	// Materials
	const skinMat = new THREE.MeshStandardMaterial({
		color: 0x7ba3d4,
		roughness: 0.25,
		metalness: 0.05,
	});
	const darkMat = new THREE.MeshStandardMaterial({
		color: 0x0d1a2e,
		roughness: 0.2,
		metalness: 0.6,
	});
	const irisMat = new THREE.MeshStandardMaterial({
		color: 0x55aaff,
		roughness: 0.05,
		metalness: 0.3,
		emissive: 0x1144cc,
		emissiveIntensity: 0.6,
	});
	const suitMat = new THREE.MeshStandardMaterial({
		color: 0x1a2540,
		roughness: 0.6,
		metalness: 0.3,
	});
	const glareMat = new THREE.MeshStandardMaterial({
		color: 0xffffff,
		roughness: 0,
		metalness: 0,
		transparent: true,
		opacity: 0.55,
	});

	// Avatar
	const avatar = new THREE.Group();
	scene.add(avatar);

	// Torso
	const torsoMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.32, 1.0, 20), suitMat);
	torsoMesh.position.y = 0.82;
	torsoMesh.castShadow = true;
	avatar.add(torsoMesh);

	// Neck
	const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.19, 0.28, 16), skinMat);
	neck.position.y = 1.47;
	avatar.add(neck);

	// Head group (rotates for gaze tracking)
	const headGroup = new THREE.Group();
	headGroup.position.y = 1.94;
	avatar.add(headGroup);

	const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.52, 40, 40), skinMat);
	headMesh.scale.set(1, 1.08, 0.96);
	headMesh.castShadow = true;
	headGroup.add(headMesh);

	// Eyes
	function makeEye(x) {
		const group = new THREE.Group();
		group.position.set(x, 0.06, 0.44);

		// White
		const white = new THREE.Mesh(
			new THREE.SphereGeometry(0.105, 20, 20),
			new THREE.MeshStandardMaterial({ color: 0xddeeff, roughness: 0.3, metalness: 0 }),
		);
		group.add(white);

		// Iris
		const iris = new THREE.Mesh(new THREE.SphereGeometry(0.065, 16, 16), irisMat);
		iris.position.z = 0.055;
		group.add(iris);

		// Pupil
		const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.036, 12, 12), darkMat);
		pupil.position.z = 0.088;
		group.add(pupil);

		// Glare
		const glare = new THREE.Mesh(new THREE.SphereGeometry(0.014, 8, 8), glareMat);
		glare.position.set(0.022, 0.025, 0.1);
		group.add(glare);

		return group;
	}

	headGroup.add(makeEye(-0.185), makeEye(0.185));

	// Eyelids: a blink is a Y scale on these caps.
	function makeLid(x) {
		const lid = new THREE.Mesh(
			new THREE.SphereGeometry(0.112, 20, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
			new THREE.MeshStandardMaterial({
				color: 0x6a95c0,
				roughness: 0.3,
				side: THREE.FrontSide,
			}),
		);
		lid.position.set(x, 0.06, 0.43);
		lid.rotation.x = Math.PI;
		lid.scale.y = 0.01; // open; blinking animates this to 1
		return lid;
	}
	const leftLid = makeLid(-0.185);
	const rightLid = makeLid(0.185);
	headGroup.add(leftLid, rightLid);

	// Eyebrows
	function makeBrow(x) {
		const geo = new THREE.BoxGeometry(0.16, 0.03, 0.04);
		const brow = new THREE.Mesh(
			geo,
			new THREE.MeshStandardMaterial({ color: 0x3a6090, roughness: 0.5 }),
		);
		brow.position.set(x, 0.215, 0.455);
		brow.rotation.z = x > 0 ? -0.12 : 0.12;
		return brow;
	}
	headGroup.add(makeBrow(-0.185), makeBrow(0.185));

	// Nose
	const noseMesh = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), skinMat);
	noseMesh.scale.set(0.7, 0.65, 0.8);
	noseMesh.position.set(0, -0.07, 0.5);
	headGroup.add(noseMesh);

	// Mouth
	const mouthGeo = new THREE.TorusGeometry(0.1, 0.025, 8, 20, Math.PI);
	const mouth = new THREE.Mesh(
		mouthGeo,
		new THREE.MeshStandardMaterial({ color: 0x3a5a80, roughness: 0.5 }),
	);
	mouth.position.set(0, -0.2, 0.46);
	mouth.rotation.z = Math.PI;
	headGroup.add(mouth);

	// Shoulders / arms
	function makeArm(x) {
		const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.09, 0.75, 14), suitMat);
		arm.position.set(x, 0.85, 0);
		arm.rotation.z = x > 0 ? -0.35 : 0.35;
		arm.castShadow = true;
		return arm;
	}
	avatar.add(makeArm(-0.52), makeArm(0.52));

	// Shoulder pads
	function makePad(x) {
		const pad = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 16), suitMat);
		pad.scale.set(1, 0.7, 1);
		pad.position.set(x, 1.3, 0);
		return pad;
	}
	avatar.add(makePad(-0.52), makePad(0.52));

	// Chest detail (glowing panel)
	const panelMat = new THREE.MeshStandardMaterial({
		color: 0x1155cc,
		emissive: 0x0033aa,
		emissiveIntensity: 1.2,
		roughness: 0.2,
	});
	const panel = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.04), panelMat);
	panel.position.set(0, 0.88, 0.37);
	avatar.add(panel);

	let blinkTimer = 0;
	let blinkInterval = 3 + Math.random() * 3;
	let blinking = false;
	let blinkT = 0;
	const targetHeadRot = { x: 0, y: 0 };
	const currentHeadRot = { x: 0, y: 0 };

	return {
		// Geometry, not a download: on screen the moment the first frame renders.
		ready: () => true,
		update(t, mouse, _zoom, reduceMotion) {
			// Breathing
			const breathe = reduceMotion ? 0 : Math.sin(t * 1.15) * 0.025;
			torsoMesh.scale.y = 1 + breathe;
			torsoMesh.position.y = 0.82 + breathe * 0.3;

			// Chest glow pulse
			panelMat.emissiveIntensity = reduceMotion ? 1.0 : 1.0 + Math.sin(t * 2.3) * 0.3;

			// Head follows the look-target (smoothed)
			targetHeadRot.y = mouse.x * 0.35;
			targetHeadRot.x = -mouse.y * 0.2;
			currentHeadRot.x += (targetHeadRot.x - currentHeadRot.x) * 0.06;
			currentHeadRot.y += (targetHeadRot.y - currentHeadRot.y) * 0.06;
			headGroup.rotation.x = currentHeadRot.x;
			headGroup.rotation.y = currentHeadRot.y;

			// Idle body sway
			avatar.rotation.y = reduceMotion ? 0 : Math.sin(t * 0.35) * 0.06;

			// Blink
			if (reduceMotion) return;
			blinkTimer += 0.016;
			if (!blinking && blinkTimer > blinkInterval) {
				blinking = true;
				blinkT = 0;
				blinkInterval = 2.5 + Math.random() * 4;
				blinkTimer = 0;
			}
			if (!blinking) return;
			blinkT += 0.016;
			const half = 0.09;
			const progress =
				blinkT < half ? blinkT / half : blinkT < half * 2 ? 1 - (blinkT - half) / half : -1;
			if (progress < 0) {
				leftLid.scale.y = 0.01;
				rightLid.scale.y = 0.01;
				blinking = false;
			} else {
				leftLid.scale.y = progress;
				rightLid.scale.y = progress;
			}
		},
	};
}
