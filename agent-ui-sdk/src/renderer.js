import * as THREE from 'three';

// Build the fullscreen overlay renderer + orthographic scene that the
// avatar runs in. Returns a small handle of the live objects plus the
// DOM↔world coordinate helpers (which are bound to *this* camera, so the
// caller never accidentally projects against a stale frustum).
export function createRenderer({
	container = document.body,
	canvas,
	zIndex = 999,
	pixelsPerUnit = 120,
	lights = true,
	parallax = true,
} = {}) {
	let ownsCanvas = false;
	if (!canvas) {
		canvas = document.createElement('canvas');
		canvas.style.cssText =
			'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;' +
			`z-index:${zIndex};`;
		container.appendChild(canvas);
		ownsCanvas = true;
	}

	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
	renderer.outputColorSpace = THREE.SRGBColorSpace;
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 1.1;

	const scene = new THREE.Scene();
	const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
	camera.position.z = 10;

	if (lights) {
		scene.add(new THREE.AmbientLight(0xffffff, 0.6));
		const key  = new THREE.DirectionalLight(0xfff4dc, 2.0); key.position.set(3, 6, 5);   scene.add(key);
		const rim  = new THREE.DirectionalLight(0x4060ff, 0.6); rim.position.set(-4, 3, -2); scene.add(rim);
		const fill = new THREE.DirectionalLight(0xffeedd, 0.4); fill.position.set(0, 2, 7);  scene.add(fill);
	}

	function updateFrustum() {
		const hw = window.innerWidth  / pixelsPerUnit / 2;
		const hh = window.innerHeight / pixelsPerUnit / 2;
		camera.left = -hw; camera.right = hw;
		camera.top  =  hh; camera.bottom = -hh;
		camera.updateProjectionMatrix();
	}

	const _v3 = new THREE.Vector3();
	function domToWorld(screenX, screenY) {
		_v3.set(
			 (screenX / window.innerWidth)  * 2 - 1,
			-(screenY / window.innerHeight) * 2 + 1,
			0,
		);
		_v3.unproject(camera);
		return { x: _v3.x, y: _v3.y };
	}

	// Project an arbitrary world point back to screen pixels — used by FX
	// (proximity shadow, dust origin) that need to draw HTML on top of the
	// avatar's actual screen position rather than its DOM anchor.
	const _proj = new THREE.Vector3();
	function worldToScreen(x, y) {
		_proj.set(x, y, 0).project(camera);
		return {
			x: (_proj.x + 1) * 0.5 * window.innerWidth,
			y: (1 - _proj.y) * 0.5 * window.innerHeight,
		};
	}

	function resize() {
		renderer.setSize(window.innerWidth, window.innerHeight, false);
		updateFrustum();
	}
	window.addEventListener('resize', resize);
	resize();

	// Camera parallax — pan slightly with the mouse instead of changing FOV,
	// which keeps domToWorld() correct since it always reads from `camera`.
	let mouseNx = 0, mouseNy = 0;
	let mouseMoveHandler = null;
	if (parallax) {
		mouseMoveHandler = (e) => {
			mouseNx = (e.clientX / window.innerWidth)  * 2 - 1;
			mouseNy = (e.clientY / window.innerHeight) * 2 - 1;
		};
		window.addEventListener('mousemove', mouseMoveHandler);
	}

	function updateParallax() {
		if (!parallax) return;
		const tx = mouseNx * 0.12;
		const ty = -mouseNy * 0.08;
		camera.position.x += (tx - camera.position.x) * 0.04;
		camera.position.y += (ty - camera.position.y) * 0.04;
	}

	function destroy() {
		window.removeEventListener('resize', resize);
		if (mouseMoveHandler) window.removeEventListener('mousemove', mouseMoveHandler);
		renderer.dispose();
		renderer.forceContextLoss?.();
		if (ownsCanvas) canvas.remove();
	}

	return {
		canvas,
		renderer,
		scene,
		camera,
		pixelsPerUnit,
		domToWorld,
		worldToScreen,
		updateParallax,
		destroy,
	};
}
