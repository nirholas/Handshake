// Shared avatar-picker bottom sheet for /xr and /irl.
// Usage:
//   import { createAvatarPicker } from './avatar-picker.js';
//   const picker = createAvatarPicker({ onSelect: ({ id, url, name }) => { ... } });
//   picker.open(currentAvatarId);

const DEFAULT_AVATAR = {
	id: null,
	url: '/avatars/default.glb',
	name: 'Default',
	thumbnailUrl: null,
};

const CSS = `
.avp-overlay {
	position: fixed; inset: 0; z-index: 200;
	background: rgba(0,0,0,0.72);
	backdrop-filter: blur(6px);
	-webkit-backdrop-filter: blur(6px);
	display: flex; align-items: flex-end;
	opacity: 0; transition: opacity 0.22s ease;
	touch-action: none;
}
.avp-overlay.is-open { opacity: 1; }
.avp-sheet {
	width: 100%; max-height: 72vh;
	background: #0d0e14;
	border-top: 1px solid rgba(255,255,255,0.08);
	border-radius: 20px 20px 0 0;
	display: flex; flex-direction: column;
	transform: translateY(100%);
	transition: transform 0.28s cubic-bezier(0.32,0.72,0,1);
	overflow: hidden;
}
.avp-overlay.is-open .avp-sheet { transform: translateY(0); }
.avp-header {
	display: flex; align-items: center; justify-content: space-between;
	padding: 20px 20px 0;
	flex-shrink: 0;
}
.avp-title {
	font-size: 16px; font-weight: 700; letter-spacing: -0.02em;
	color: #f0f1f5;
}
.avp-close {
	width: 32px; height: 32px;
	background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
	border-radius: 50%; cursor: pointer;
	display: flex; align-items: center; justify-content: center;
	color: #7a7d8c; transition: background 0.15s, color 0.15s;
}
.avp-close:hover { background: rgba(255,255,255,0.1); color: #f0f1f5; }
.avp-close svg { display: block; }
.avp-body {
	flex: 1; overflow-y: auto; padding: 16px 16px calc(env(safe-area-inset-bottom,0px) + 24px);
	-webkit-overflow-scrolling: touch;
}
.avp-grid {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
	gap: 10px;
}
.avp-card {
	background: rgba(255,255,255,0.04);
	border: 1.5px solid rgba(255,255,255,0.08);
	border-radius: 14px; overflow: hidden;
	cursor: pointer; transition: border-color 0.15s, background 0.15s, transform 0.1s;
	-webkit-tap-highlight-color: transparent;
}
.avp-card:hover { background: rgba(255,255,255,0.07); border-color: rgba(255,255,255,0.18); }
.avp-card:active { transform: scale(0.96); }
.avp-card.is-active {
	border-color: #3dc1ff;
	background: rgba(61,193,255,0.08);
	box-shadow: 0 0 0 1px rgba(61,193,255,0.3);
}
.avp-thumb {
	width: 100%; aspect-ratio: 1;
	background: #111318;
	display: flex; align-items: center; justify-content: center;
	overflow: hidden;
}
.avp-thumb img {
	width: 100%; height: 100%; object-fit: cover;
	display: block;
}
.avp-thumb-placeholder {
	width: 38px; height: 38px;
	color: rgba(255,255,255,0.18);
}
.avp-label {
	padding: 6px 8px 8px;
	font-size: 12px; font-weight: 600; line-height: 1.3;
	color: #c8cadb;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.avp-card.is-active .avp-label { color: #3dc1ff; }

/* skeleton */
.avp-skel { background: rgba(255,255,255,0.05); border-radius: 14px; }
.avp-skel-thumb { width: 100%; aspect-ratio: 1; background: rgba(255,255,255,0.05); border-radius: 14px 14px 0 0; animation: avp-pulse 1.5s ease-in-out infinite; }
.avp-skel-label { height: 28px; margin: 6px 8px 8px; background: rgba(255,255,255,0.05); border-radius: 6px; animation: avp-pulse 1.5s ease-in-out 0.15s infinite; }
@keyframes avp-pulse { 0%,100%{opacity:1} 50%{opacity:0.45} }

/* empty / error states */
.avp-state {
	padding: 40px 20px;
	text-align: center;
	color: #7a7d8c;
	font-size: 14px; line-height: 1.55;
}
.avp-state a { color: #3dc1ff; text-decoration: none; }
.avp-state a:hover { text-decoration: underline; }
.avp-state-icon { font-size: 32px; margin-bottom: 10px; }
`;

function injectStyles() {
	if (document.getElementById('avp-styles')) return;
	const el = document.createElement('style');
	el.id = 'avp-styles';
	el.textContent = CSS;
	document.head.appendChild(el);
}

function thumbPlaceholderSvg() {
	return `<svg class="avp-thumb-placeholder" viewBox="0 0 38 38" fill="none" xmlns="http://www.w3.org/2000/svg">
		<circle cx="19" cy="12" r="6" stroke="currentColor" stroke-width="1.6"/>
		<path d="M5 34c0-7.732 6.268-14 14-14s14 6.268 14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
	</svg>`;
}

// ── 3-D thumbnail renderer ─────────────────────────────────────────────────
// Lazily created on first use; destroyed when no longer needed.
let _offscreenCtx = null;
const _thumbCache = new Map(); // glbUrl → data:image/png

async function getOffscreenCtx() {
	if (_offscreenCtx) return _offscreenCtx;
	const [{ WebGLRenderer, Scene, PerspectiveCamera, AmbientLight, DirectionalLight, Box3, Vector3 },
	       { GLTFLoader }, { getMeshoptDecoder },
	       { applyCinematicDefaults, loadEnvironment }] = await Promise.all([
		import('three'),
		import('three/addons/loaders/GLTFLoader.js'),
		import('./viewer/internal.js'),
		import('./shared/cinematic-render.js'),
	]);
	const cvs = document.createElement('canvas');
	cvs.width = 256; cvs.height = 256;
	const renderer = new WebGLRenderer({ canvas: cvs, antialias: true, alpha: true });
	// Cinematic defaults (ACES tone mapping, sRGB output) shared with every other
	// viewer on the platform; product-shot studio HDRI for the picker thumbnails.
	applyCinematicDefaults(renderer, { exposure: 1.1, tier: 'medium' });
	renderer.setPixelRatio(1);
	renderer.setSize(256, 256);
	renderer.setClearColor(0x000000, 0);
	const camera = new PerspectiveCamera(42, 1, 0.01, 100);
	camera.position.set(0, 1.3, 2.2);
	camera.lookAt(0, 1.0, 0);
	const scene = new Scene();
	loadEnvironment(renderer, scene, 'studio');
	scene.add(new AmbientLight(0xffffff, 1.0));
	const sun = new DirectionalLight(0xffffff, 1.4);
	sun.position.set(2, 4, 3);
	scene.add(sun);
	const fill = new DirectionalLight(0xaaccff, 0.5);
	fill.position.set(-2, 2, -1);
	scene.add(fill);
	const loader = new GLTFLoader();
	// three.ws GLBs may carry EXT_meshopt_compression — decoder required before load
	loader.setMeshoptDecoder(await getMeshoptDecoder());
	_offscreenCtx = { renderer, camera, scene, loader, Box3, Vector3 };
	return _offscreenCtx;
}

function disposeMaterial(material) {
	if (!material) return;
	// Disposing a material does NOT free its textures — release them explicitly.
	for (const value of Object.values(material)) {
		if (value && typeof value === 'object' && typeof value.dispose === 'function' && 'isTexture' in value) {
			value.dispose();
		}
	}
	material.dispose();
}

function disposeModel(model) {
	model.traverse(ch => {
		ch.geometry?.dispose();
		if (Array.isArray(ch.material)) ch.material.forEach(disposeMaterial);
		else disposeMaterial(ch.material);
	});
}

// The offscreen renderer/scene is a single shared resource. Many cards enter the
// viewport at once, so serialize the scene-mutation → render → readback section;
// concurrent renders into one scene would composite the wrong models together.
let _renderQueue = Promise.resolve();

async function render3dThumb(glbUrl) {
	if (_thumbCache.has(glbUrl)) return _thumbCache.get(glbUrl);
	const run = _renderQueue.then(async () => {
		if (_thumbCache.has(glbUrl)) return _thumbCache.get(glbUrl);
		const { renderer, camera, scene, loader, Box3, Vector3 } = await getOffscreenCtx();
		const gltf = await loader.loadAsync(glbUrl);
		const model = gltf.scene;
		const box = new Box3().setFromObject(model);
		const size = box.getSize(new Vector3());
		const center = box.getCenter(new Vector3());
		const scale = 1.6 / Math.max(size.x, size.y, size.z);
		model.scale.setScalar(scale);
		model.position.sub(center.multiplyScalar(scale));
		model.position.y += 0.15;
		scene.add(model);
		try {
			renderer.render(scene, camera);
			const dataUrl = renderer.domElement.toDataURL('image/png');
			_thumbCache.set(glbUrl, dataUrl);
			return dataUrl;
		} finally {
			scene.remove(model);
			disposeModel(model);
		}
	}).catch(() => null);
	// Keep the chain alive even when a render rejects, so later cards still run.
	_renderQueue = run.catch(() => {});
	return run;
}

function setupThumb3d(thumbDiv, glbUrl) {
	if (!glbUrl || typeof IntersectionObserver === 'undefined') return;
	const obs = new IntersectionObserver(async entries => {
		for (const entry of entries) {
			if (!entry.isIntersecting) continue;
			obs.disconnect();
			const dataUrl = await render3dThumb(glbUrl);
			if (dataUrl && thumbDiv.querySelector('.avp-thumb-placeholder')) {
				const img = document.createElement('img');
				img.src = dataUrl;
				img.alt = '';
				thumbDiv.innerHTML = '';
				thumbDiv.appendChild(img);
			}
		}
	}, { threshold: 0.1 });
	obs.observe(thumbDiv);
}

export function createAvatarPicker({ onSelect } = {}) {
	injectStyles();

	// ── Build DOM ──────────────────────────────────────────────────────────
	const overlay = document.createElement('div');
	overlay.className = 'avp-overlay';
	overlay.setAttribute('role', 'dialog');
	overlay.setAttribute('aria-modal', 'true');
	overlay.setAttribute('aria-label', 'Select avatar');
	overlay.innerHTML = `
		<div class="avp-sheet">
			<div class="avp-header">
				<div class="avp-title">Your Avatars</div>
				<button class="avp-close" aria-label="Close" type="button">
					<svg width="14" height="14" viewBox="0 0 14 14" fill="none">
						<path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
					</svg>
				</button>
			</div>
			<div class="avp-body">
				<div class="avp-grid" id="avp-grid"></div>
			</div>
		</div>`;

	const sheet   = overlay.querySelector('.avp-sheet');
	const closeBtn = overlay.querySelector('.avp-close');
	const grid    = overlay.querySelector('#avp-grid');

	// ── State ──────────────────────────────────────────────────────────────
	let currentId    = null;
	let avatarCache  = null; // null = not yet loaded
	let isOpen       = false;

	// ── Close logic ───────────────────────────────────────────────────────
	function close() {
		if (!isOpen) return;
		isOpen = false;
		overlay.classList.remove('is-open');
		overlay.addEventListener('transitionend', () => {
			if (!isOpen) overlay.remove();
		}, { once: true });
	}

	closeBtn.addEventListener('click', close);
	overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
	document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isOpen) close(); });

	// Prevent sheet clicks from bubbling to the overlay (would trigger close)
	sheet.addEventListener('click', (e) => e.stopPropagation());

	// ── Render ─────────────────────────────────────────────────────────────
	function renderSkeletons(n = 6) {
		grid.innerHTML = Array.from({ length: n }, () => `
			<div class="avp-skel">
				<div class="avp-skel-thumb"></div>
				<div class="avp-skel-label"></div>
			</div>`).join('');
	}

	function renderAvatars(avatars) {
		const all = [DEFAULT_AVATAR, ...avatars];
		grid.innerHTML = '';
		for (const av of all) {
			const card = document.createElement('div');
			card.className = 'avp-card' + (av.id === currentId ? ' is-active' : '');
			card.setAttribute('role', 'button');
			card.setAttribute('tabindex', '0');
			card.setAttribute('aria-label', av.name);
			card.innerHTML = `
				<div class="avp-thumb">
					${av.thumbnailUrl
						? `<img src="${av.thumbnailUrl}" alt="${av.name}" loading="lazy">`
						: thumbPlaceholderSvg()}
				</div>
				<div class="avp-label">${av.name}</div>`;

			if (!av.thumbnailUrl && av.url) {
				setupThumb3d(card.querySelector('.avp-thumb'), av.url);
			}

			card.addEventListener('click', () => {
				grid.querySelectorAll('.avp-card').forEach(c => c.classList.remove('is-active'));
				card.classList.add('is-active');
				currentId = av.id;
				onSelect?.({ id: av.id, url: av.url, name: av.name });
				close();
			});
			card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); card.click(); } });
			grid.appendChild(card);
		}
	}

	function renderUnauthed() {
		grid.innerHTML = `
			<div class="avp-state" style="grid-column:1/-1">
				<div class="avp-state-icon">🔒</div>
				<div>Sign in to use your own avatars.<br><a href="/login?return=${encodeURIComponent(location.pathname + location.search)}">Sign in →</a></div>
			</div>`;
	}

	function renderEmpty() {
		grid.innerHTML = `
			<div class="avp-state" style="grid-column:1/-1">
				<div class="avp-state-icon">🧑‍🎨</div>
				<div>You don't have any avatars yet.<br><a href="/create">Create your first →</a></div>
			</div>`;
	}

	function renderError() {
		grid.innerHTML = `
			<div class="avp-state" style="grid-column:1/-1">
				<div class="avp-state-icon">⚠️</div>
				<div>Couldn't load avatars. Check your connection and try again.</div>
			</div>`;
	}

	// ── Fetch ──────────────────────────────────────────────────────────────
	async function loadAvatars() {
		if (avatarCache) { renderAvatars(avatarCache); return; }
		renderSkeletons();
		try {
			const res = await fetch('/api/avatars?limit=50', { credentials: 'include' });
			if (res.status === 401) { renderUnauthed(); return; }
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const { avatars = [] } = await res.json();
			avatarCache = avatars.map(av => ({
				id: av.id,
				url: av.url || av.model_url || `/api/avatars/${av.id}/glb`,
				name: av.name || 'Untitled',
				thumbnailUrl: av.thumbnail_url || null,
			}));
			if (!avatarCache.length) { renderEmpty(); return; }
			renderAvatars(avatarCache);
		} catch {
			renderError();
		}
	}

	// ── Open ───────────────────────────────────────────────────────────────
	function open(activeId) {
		currentId = activeId ?? null;
		document.body.appendChild(overlay);
		// Force a reflow so the transition fires
		overlay.getBoundingClientRect();
		overlay.classList.add('is-open');
		isOpen = true;
		loadAvatars();
	}

	return { open, close };
}
