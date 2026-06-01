import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { buildCity, buildMinimapStatic, CITY_HALF } from './city-map.js';
import { CityPlayer } from './city-player.js';
import { CityCamera } from './city-camera.js';

// ── DOM refs ─────────────────────────────────────────────────────────────────

const canvas     = document.getElementById('city-canvas');
const loadingEl  = document.getElementById('city-loading');
const subEl      = document.getElementById('city-loading-sub');
const barEl      = document.getElementById('city-boot-bar-fill');
const hudEl      = document.getElementById('city-hud');
const coordsEl   = document.getElementById('city-hud-coords');
const mmCanvas   = document.getElementById('city-minimap-canvas');
const mmCtx      = mmCanvas.getContext('2d');

function progress(pct, label) {
	if (barEl) barEl.style.width = pct + '%';
	if (subEl) subEl.textContent = label;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
	progress(8, 'Setting up renderer…');

	// Renderer
	const renderer = new THREE.WebGLRenderer({
		canvas,
		antialias: true,
		powerPreference: 'high-performance',
	});
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type   = THREE.PCFSoftShadowMap;
	renderer.toneMapping      = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 0.92;
	renderer.outputColorSpace = THREE.SRGBColorSpace;

	// Scene
	const scene = new THREE.Scene();
	scene.fog = new THREE.Fog(0x9aafbf, 110, 500);

	// Camera
	const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 600);
	camera.position.set(0, 12, 20);

	progress(18, 'Adding lights…');

	// Ambient — generous so shadowed areas stay readable
	scene.add(new THREE.AmbientLight(0xc0d4e8, 1.4));

	// Sun — warm afternoon angle, less overpowering than midday
	const sun = new THREE.DirectionalLight(0xffe8c0, 2.0);
	sun.position.set(60, 80, -50); // slightly behind camera = front-lit scene
	sun.castShadow = true;
	sun.shadow.mapSize.set(2048, 2048);
	sun.shadow.camera.near = 1;
	sun.shadow.camera.far  = 500;
	sun.shadow.camera.left   = -160;
	sun.shadow.camera.right  =  160;
	sun.shadow.camera.top    =  160;
	sun.shadow.camera.bottom = -160;
	sun.shadow.bias = -0.0008;
	scene.add(sun);

	// Secondary fill from the opposite side — kills pitch-black shadows
	const fill = new THREE.DirectionalLight(0x90b8e0, 0.7);
	fill.position.set(-60, 50, 60);
	scene.add(fill);

	// Hemisphere (sky/ground colour fill)
	scene.add(new THREE.HemisphereLight(0x90b8d8, 0x4a6040, 0.6));

	progress(28, 'Building sky…');

	// Sky dome
	const sky = new Sky();
	sky.scale.setScalar(5000);
	scene.add(sky);
	const su = sky.material.uniforms;
	su.turbidity.value        = 4.0;
	su.rayleigh.value         = 2.2;
	su.mieCoefficient.value   = 0.006;
	su.mieDirectionalG.value  = 0.9;
	su.sunPosition.value.set(0.4, 0.35, -0.85).normalize();

	progress(40, 'Building city…');

	const { buildingBoxes } = buildCity(scene);

	progress(62, 'Building minimap…');

	const minimap = buildMinimapStatic(buildingBoxes);

	progress(72, 'Loading avatar…');

	// Player — pick avatar from URL param or localStorage
	const avatarInput = new URLSearchParams(location.search).get('avatar')
		|| localStorage.getItem('kx-avatar')
		|| '';

	const player = new CityPlayer(scene);
	await player.load(avatarInput);
	player.position.set(0, 0, 0);

	progress(92, 'Entering world…');

	// Camera controller (attach after player exists)
	const cityCamera = new CityCamera(camera, canvas);

	// Block right-click context menu so RMB can orbit
	canvas.addEventListener('contextmenu', (e) => e.preventDefault());

	// Resize handler
	window.addEventListener('resize', () => {
		renderer.setSize(window.innerWidth, window.innerHeight);
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
	});

	// Focus canvas so keyboard input works immediately
	canvas.focus();

	// ── Reveal ──────────────────────────────────────────────────────────────────
	progress(100, 'Ready');
	await delay(180);
	loadingEl.classList.add('hidden');
	await delay(480);
	loadingEl.style.display = 'none';
	hudEl.style.display = '';

	// ── Game loop ────────────────────────────────────────────────────────────────
	const clock = new THREE.Clock();

	(function tick() {
		requestAnimationFrame(tick);
		const dt = Math.min(clock.getDelta(), 0.05);

		player.update(dt, buildingBoxes, cityCamera.yaw);
		cityCamera.update(player.position, player.height);

		drawMinimap(mmCtx, player.position, minimap);
		updateCoords(player.position);

		renderer.render(scene, camera);
	})();
}

// ── Minimap ───────────────────────────────────────────────────────────────────

function drawMinimap(ctx, playerPos, minimap) {
	const W = 120, H = 120;
	const { canvas: src, scale } = minimap;

	// Player's position in the static minimap image
	const px = (playerPos.x + CITY_HALF) * scale;
	const pz = (playerPos.z + CITY_HALF) * scale;

	ctx.clearRect(0, 0, W, H);

	// Clip to circle
	ctx.save();
	ctx.beginPath();
	ctx.arc(W / 2, H / 2, W / 2, 0, Math.PI * 2);
	ctx.clip();

	// Blit 120×120 region of the static image centred on player
	ctx.drawImage(src, px - W / 2, pz - H / 2, W, H, 0, 0, W, H);

	ctx.restore();

	// Player dot
	ctx.fillStyle = 'rgba(255,255,255,0.95)';
	ctx.beginPath();
	ctx.arc(W / 2, H / 2, 3, 0, Math.PI * 2);
	ctx.fill();

	// Heading tick (points up = north on the map)
	ctx.strokeStyle = 'rgba(255,255,255,0.35)';
	ctx.lineWidth = 1.5;
	ctx.beginPath();
	ctx.moveTo(W / 2, H / 2);
	ctx.lineTo(W / 2, H / 2 - 10);
	ctx.stroke();
}

// ── Coordinate HUD ────────────────────────────────────────────────────────────

function updateCoords(pos) {
	if (!coordsEl) return;
	coordsEl.textContent = `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}`;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

main().catch(console.error);
