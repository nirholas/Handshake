import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { fetchOSMData, buildCity, buildMinimapStatic, CITY_HALF } from './city-map.js';
import { CityPlayer } from './city-player.js';
import { CityCamera } from './city-camera.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────

const canvas    = document.getElementById('city-canvas');
const loadingEl = document.getElementById('city-loading');
const subEl     = document.getElementById('city-loading-sub');
const barEl     = document.getElementById('city-boot-bar-fill');
const hudEl     = document.getElementById('city-hud');
const coordsEl  = document.getElementById('city-hud-coords');
const mmCanvas  = document.getElementById('city-minimap-canvas');
const mmCtx     = mmCanvas.getContext('2d');

function progress(pct, label) {
	if (barEl) barEl.style.width = pct + '%';
	if (subEl) subEl.textContent = label;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

async function main() {
	progress(5, 'Setting up renderer…');

	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.setSize(window.innerWidth, window.innerHeight);
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type    = THREE.PCFSoftShadowMap;
	renderer.toneMapping       = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 0.88;
	renderer.outputColorSpace  = THREE.SRGBColorSpace;

	const scene = new THREE.Scene();
	scene.fog = new THREE.Fog(0x9aafbf, 200, 900);

	const camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 1200);
	camera.position.set(0, 14, 24);

	progress(12, 'Adding lights…');

	scene.add(new THREE.AmbientLight(0xc0d4e8, 1.5));

	const sun = new THREE.DirectionalLight(0xffe8c0, 2.2);
	sun.position.set(80, 100, -60);
	sun.castShadow = true;
	sun.shadow.mapSize.set(4096, 4096);
	sun.shadow.camera.near   = 1;
	sun.shadow.camera.far    = 1200;
	sun.shadow.camera.left   = -300;
	sun.shadow.camera.right  =  300;
	sun.shadow.camera.top    =  300;
	sun.shadow.camera.bottom = -300;
	sun.shadow.bias = -0.0006;
	scene.add(sun);

	const fill = new THREE.DirectionalLight(0x90b8e0, 0.75);
	fill.position.set(-80, 60, 80);
	scene.add(fill);

	scene.add(new THREE.HemisphereLight(0x92bada, 0x4a5e40, 0.65));

	progress(22, 'Building sky…');

	const sky = new Sky();
	sky.scale.setScalar(8000);
	scene.add(sky);
	const su = sky.material.uniforms;
	su.turbidity.value       = 3.5;
	su.rayleigh.value        = 2.5;
	su.mieCoefficient.value  = 0.005;
	su.mieDirectionalG.value = 0.92;
	su.sunPosition.value.set(0.45, 0.38, -0.80).normalize();

	// ── Fetch real-world Manhattan OSM data ───────────────────────────────────
	let osmData;
	try {
		osmData = await fetchOSMData((frac, label) => {
			progress(22 + frac * 30, label);
		});
	} catch (err) {
		console.error('OSM fetch failed — loading empty world:', err);
		osmData = { elements: [] };
	}

	progress(55, 'Building city geometry…');
	const { buildingBoxes } = buildCity(scene, osmData);

	progress(75, 'Building minimap…');
	const minimap = buildMinimapStatic(buildingBoxes);

	progress(82, 'Loading avatar…');

	const avatarInput = new URLSearchParams(location.search).get('avatar')
		|| localStorage.getItem('kx-avatar')
		|| '';

	const player = new CityPlayer(scene);
	await player.load(avatarInput);
	player.position.set(0, 0, 10);

	progress(96, 'Entering city…');

	const cityCamera = new CityCamera(camera, canvas);
	canvas.addEventListener('contextmenu', e => e.preventDefault());

	window.addEventListener('resize', () => {
		renderer.setSize(window.innerWidth, window.innerHeight);
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
	});

	canvas.focus();

	progress(100, 'Ready');
	await delay(150);
	loadingEl.classList.add('hidden');
	await delay(420);
	loadingEl.style.display = 'none';
	hudEl.style.display = '';

	// ── Game loop ─────────────────────────────────────────────────────────────
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
	const px = (playerPos.x + CITY_HALF) * scale;
	const pz = (playerPos.z + CITY_HALF) * scale;

	ctx.clearRect(0, 0, W, H);
	ctx.save();
	ctx.beginPath();
	ctx.arc(W / 2, H / 2, W / 2, 0, Math.PI * 2);
	ctx.clip();
	ctx.drawImage(src, px - W / 2, pz - H / 2, W, H, 0, 0, W, H);
	ctx.restore();

	ctx.fillStyle = 'rgba(255,255,255,0.95)';
	ctx.beginPath();
	ctx.arc(W / 2, H / 2, 3, 0, Math.PI * 2);
	ctx.fill();

	ctx.strokeStyle = 'rgba(255,255,255,0.35)';
	ctx.lineWidth = 1.5;
	ctx.beginPath();
	ctx.moveTo(W / 2, H / 2);
	ctx.lineTo(W / 2, H / 2 - 10);
	ctx.stroke();
}

// ── Coordinate HUD ─────────────────────────────────────────────────────────────
// Convert local XZ back to approximate real-world lat/lon for display

function updateCoords(pos) {
	if (!coordsEl) return;
	const R = 6_371_000;
	const cosC = Math.cos(40.7580 * Math.PI / 180);
	const lat = 40.7580 - (pos.z / R) * (180 / Math.PI);
	const lon = -73.9855 + (pos.x / (R * cosC)) * (180 / Math.PI);
	coordsEl.textContent = `${lat.toFixed(5)}°N  ${Math.abs(lon).toFixed(5)}°W`;
}

// ── Utility ───────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(console.error);
