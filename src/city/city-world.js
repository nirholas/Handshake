import * as THREE from 'three';
import { fetchOSMData, buildCity, buildMinimapStatic, CITY_HALF } from './city-map.js';
import { createCityScene, bindResize } from './city-scene.js';
import { CityPlayer } from './city-player.js';
import { CityCamera } from './city-camera.js';
import { openAvatarInspector } from '../shared/avatar-inspector.js';
import { log } from '../shared/log.js';

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

	const { renderer, scene, camera } = createCityScene(canvas);

	progress(22, 'Building sky…');

	// ── Fetch real-world Manhattan OSM data ───────────────────────────────────
	let osmData;
	try {
		osmData = await fetchOSMData((frac, label) => {
			progress(22 + frac * 30, label);
		});
	} catch (err) {
		// Every Overpass instance is down and there is no cached payload. The
		// city still opens (ground, lights, avatar); only the OSM buildings and
		// roads are missing. Handled degradation, so warn (not error).
		log.warn('[city] OSM unavailable on every instance with no cache - loading city without buildings:', err);
		progress(52, 'Live map unavailable - loading city without buildings…');
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

	bindResize(renderer, camera);

	canvas.focus();

	// ── Avatar inspector ──────────────────────────────────────────────────────
	// The city is single-player, so I (or clicking your avatar) inspects you:
	// identity, reputation and wallet when you're piloting a registered agent
	// (?agent=<id>), honest guidance when you're exploring as a guest.
	const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const agentParam = (new URLSearchParams(location.search).get('agent') || '').trim();
	const inspectSelf = () => {
		const R = 6_371_000;
		const cosC = Math.cos(40.7580 * Math.PI / 180);
		const lat = 40.7580 - (player.position.z / R) * (180 / Math.PI);
		const lon = -73.9855 + (player.position.x / (R * cosC)) * (180 / Math.PI);
		openAvatarInspector({
			kind: 'self',
			name: 'You',
			world: 'city',
			agentId: UUID_RE.test(agentParam) ? agentParam : '',
			avatarUrl: avatarInput,
			facts: [
				{ label: 'Location', value: `${lat.toFixed(5)}°N ${Math.abs(lon).toFixed(5)}°W`, href: 'https://www.openstreetmap.org/#map=17/' + lat.toFixed(5) + '/' + lon.toFixed(5) },
				{ label: 'District', value: 'Midtown Manhattan (live OSM data)' },
			],
		}, { trigger: canvas });
	};
	window.addEventListener('keydown', (e) => {
		if (e.key.toLowerCase() !== 'i' || e.repeat) return;
		const ae = document.activeElement;
		if (ae && (/^(INPUT|TEXTAREA|SELECT)$/.test(ae.tagName) || ae.isContentEditable || ae.closest?.('[role="dialog"]'))) return;
		e.preventDefault();
		inspectSelf();
	});
	// A tap (not a look-drag) on your avatar opens the same panel.
	const raycaster = new THREE.Raycaster();
	const ndc = new THREE.Vector2();
	let downAt = null;
	canvas.addEventListener('pointerdown', (e) => { downAt = { x: e.clientX, y: e.clientY }; });
	canvas.addEventListener('pointerup', (e) => {
		if (!downAt) return;
		const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
		downAt = null;
		if (moved >= 6 || e.button === 2) return;
		const rect = canvas.getBoundingClientRect();
		ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
		raycaster.setFromCamera(ndc, camera);
		if (raycaster.intersectObject(player.rig, true).length) inspectSelf();
	});

	progress(100, 'Ready');
	await delay(150);
	loadingEl.classList.add('hidden');
	await delay(420);
	loadingEl.style.display = 'none';
	hudEl.style.display = '';

	// ── Game loop ─────────────────────────────────────────────────────────────
	const clock = new THREE.Timer();

	(function tick() {
		requestAnimationFrame(tick);
		clock.update();
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

main().catch(log.error);
