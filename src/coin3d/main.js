// /coin3d — a live 3D snapshot of any pump.fun / Solana token.
//
// Reads ?mint=<base58> (and optional &network=mainnet|devnet), pulls real
// data from the public pump.fun MCP endpoint (/api/pump-fun-mcp), and renders
// an interactive Three.js scene:
//
//   • a spinning coin medallion textured with the token's logo,
//   • a galaxy of the top holders as spheres sized by balance and tinted by
//     concentration (the rug-risk picture, spatially),
//   • a graduation ring that fills with the token's bonding-curve progress.
//
// All data is live and on-chain (no mocks). Every state — loading, error,
// empty, populated — is designed. This is the page that the MCP tool
// `pumpfun_token_3d` deep-links to.

import {
	Scene,
	PerspectiveCamera,
	WebGLRenderer,
	Group,
	Color,
	CylinderGeometry,
	SphereGeometry,
	TorusGeometry,
	RingGeometry,
	MeshStandardMaterial,
	MeshBasicMaterial,
	Mesh,
	HemisphereLight,
	DirectionalLight,
	AmbientLight,
	TextureLoader,
	SRGBColorSpace,
	DoubleSide,
	AdditiveBlending,
	MathUtils,
	PointLight,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const MCP_ENDPOINT = '/api/pump-fun-mcp';

// ── DOM handles ─────────────────────────────────────────────────────────────
const canvas = document.getElementById('scene');
const hud = document.getElementById('hud');
const statusEl = document.getElementById('status');

// ── URL params ──────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const mint = (params.get('mint') || '').trim();
const network = params.get('network') === 'devnet' ? 'devnet' : 'mainnet';

// ── MCP client (JSON-RPC over the public read-only endpoint) ─────────────────
let rpcId = 0;
async function mcpCall(name, args = {}) {
	const res = await fetch(MCP_ENDPOINT, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			id: ++rpcId,
			method: 'tools/call',
			params: { name, arguments: args },
		}),
	});
	if (!res.ok) throw new Error(`${name} → HTTP ${res.status}`);
	const env = await res.json();
	if (env.error) throw new Error(env.error.message || `${name} failed`);
	return env.result?.structuredContent ?? null;
}

// Pull the three data sources in parallel. Holder + curve data are
// best-effort: if a source is unavailable we keep the snapshot but degrade the
// matching visual, rather than failing the whole scene.
async function loadSnapshot() {
	const [details, curve, holders] = await Promise.allSettled([
		mcpCall('getTokenDetails', { mint }),
		mcpCall('getBondingCurve', { mint, network }),
		mcpCall('getTokenHolders', { mint, limit: 12, network }),
	]);
	const d = details.status === 'fulfilled' ? details.value || {} : {};
	const c = curve.status === 'fulfilled' ? curve.value || null : null;
	const h = holders.status === 'fulfilled' ? holders.value || null : null;

	const name = d.name || d.metadata?.name || 'Unknown token';
	const symbol = (d.symbol || d.metadata?.symbol || '').toUpperCase();
	const image = await resolveImage(d);

	return {
		mint,
		name,
		symbol,
		image,
		marketCapUsd: numOrNull(d.marketCapUsd ?? d.usdMarketCap ?? d.market_cap),
		graduationProgress: clamp01(numOrNull(c?.graduationProgress ?? c?.progress)),
		graduated: Boolean(c?.graduated || c?.complete),
		topHolderPercent: numOrNull(h?.topHolderPercent),
		holders: Array.isArray(h?.holders) ? h.holders : [],
	};
}

// The token logo lives in the off-chain metadata JSON pointed to by the
// on-chain `uri`, not in getTokenDetails directly. Resolve it (best-effort):
// a direct image field wins; otherwise fetch the uri JSON and read .image.
async function resolveImage(d) {
	const direct = d.image || d.imageUrl || d.metadata?.image;
	if (direct) return ipfsToHttp(direct);
	const uri = d.uri || d.metadata?.uri;
	if (!uri) return null;
	try {
		const res = await fetch(ipfsToHttp(uri), { signal: AbortSignal.timeout(6000) });
		if (!res.ok) return null;
		const meta = await res.json();
		return meta?.image ? ipfsToHttp(meta.image) : null;
	} catch {
		return null;
	}
}

function ipfsToHttp(url) {
	if (typeof url !== 'string') return null;
	if (url.startsWith('ipfs://')) return `https://ipfs.io/ipfs/${url.slice(7)}`;
	return url;
}

function numOrNull(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}
function clamp01(v) {
	if (v === null) return null;
	return Math.max(0, Math.min(1, v > 1 ? v / 100 : v));
}

// ── Status overlay (loading / error / empty) ─────────────────────────────────
function setStatus(kind, title, detail, action) {
	if (kind === null) {
		statusEl.hidden = true;
		statusEl.innerHTML = '';
		return;
	}
	statusEl.hidden = false;
	statusEl.dataset.kind = kind;
	statusEl.innerHTML = `
		<div class="status-card">
			${kind === 'loading' ? '<div class="spinner" aria-hidden="true"></div>' : ''}
			<h2>${escapeHtml(title)}</h2>
			${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
			${action ? `<a class="status-action" href="${action.href}">${escapeHtml(action.label)}</a>` : ''}
		</div>`;
}

function escapeHtml(s) {
	return String(s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

// ── Three.js scene ────────────────────────────────────────────────────────────
let renderer, scene, camera, controls, rafId;
const spin = new Group();
const holderOrbits = [];

function initScene() {
	renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
	renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
	renderer.outputColorSpace = SRGBColorSpace;

	scene = new Scene();

	camera = new PerspectiveCamera(45, 1, 0.1, 100);
	camera.position.set(0, 1.6, 6.2);

	controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.minDistance = 3.5;
	controls.maxDistance = 12;
	controls.autoRotate = true;
	controls.autoRotateSpeed = 0.6;

	scene.add(new HemisphereLight(0xbfd4ff, 0x0a0a16, 0.9));
	scene.add(new AmbientLight(0xffffff, 0.25));
	const key = new DirectionalLight(0xffffff, 1.6);
	key.position.set(4, 6, 5);
	scene.add(key);
	const rim = new PointLight(0x6ea8ff, 0.8, 30);
	rim.position.set(-5, 2, -4);
	scene.add(rim);

	scene.add(spin);
	resize();
	addEventListener('resize', resize);
	animate();
}

function resize() {
	const w = canvas.clientWidth || innerWidth;
	const h = canvas.clientHeight || innerHeight;
	renderer.setSize(w, h, false);
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
}

function animate() {
	rafId = requestAnimationFrame(animate);
	const t = performance.now() / 1000;
	spin.rotation.y += 0.004;
	for (const o of holderOrbits) {
		o.angle += o.speed;
		o.mesh.position.x = Math.cos(o.angle) * o.radius;
		o.mesh.position.z = Math.sin(o.angle) * o.radius;
		o.mesh.position.y = o.y + Math.sin(t * o.bob + o.phase) * 0.08;
	}
	controls.update();
	renderer.render(scene, camera);
}

// The coin medallion: a thin cylinder with the logo on both faces and a
// metallic rim. Falls back to a brand-tinted disc if the logo can't be loaded.
function buildCoin(snapshot) {
	const rim = new MeshStandardMaterial({ color: 0x2b2f44, metalness: 0.9, roughness: 0.35 });
	const faceMat = new MeshStandardMaterial({ color: 0x1a1d2e, metalness: 0.5, roughness: 0.6 });
	const geo = new CylinderGeometry(1.6, 1.6, 0.28, 64);
	// [side, top, bottom] material groups for a CylinderGeometry.
	const coin = new Mesh(geo, [rim, faceMat, faceMat]);
	coin.rotation.x = Math.PI / 2; // face the camera
	spin.add(coin);

	if (snapshot.image) {
		const loader = new TextureLoader();
		loader.setCrossOrigin('anonymous');
		loader.load(
			snapshot.image,
			(tex) => {
				tex.colorSpace = SRGBColorSpace;
				const lit = new MeshStandardMaterial({ map: tex, metalness: 0.3, roughness: 0.55 });
				coin.material = [rim, lit, lit];
			},
			undefined,
			() => {
				// Texture failed — keep the tinted disc; not an error worth blocking on.
			},
		);
	}
}

// Holder galaxy: each top holder is a sphere orbiting the coin. Size scales
// with balance share; color runs cool→hot as concentration rises.
function buildHolderGalaxy(snapshot) {
	const holderGalaxy = new Group();
	spin.add(holderGalaxy);

	const holders = snapshot.holders.slice(0, 12);
	if (!holders.length) return;

	const amounts = holders
		.map((h) => Number(h.uiAmount ?? h.amount ?? h.percent ?? 0))
		.filter((n) => n > 0);
	const max = amounts.length ? Math.max(...amounts) : 1;

	holders.forEach((h, i) => {
		const amt = Number(h.uiAmount ?? h.amount ?? h.percent ?? 0);
		const share = max > 0 ? amt / max : 0;
		const radius = 2.6 + (i % 3) * 0.55;
		const size = MathUtils.lerp(0.12, 0.42, share);
		const color = new Color().setHSL(MathUtils.lerp(0.58, 0.0, share), 0.75, 0.55);
		const mesh = new Mesh(
			new SphereGeometry(size, 24, 24),
			new MeshStandardMaterial({
				color,
				emissive: color,
				emissiveIntensity: 0.35,
				roughness: 0.4,
			}),
		);
		const angle = (i / holders.length) * Math.PI * 2;
		const y = MathUtils.lerp(-0.6, 0.6, (i % 4) / 3);
		mesh.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius);
		holderGalaxy.add(mesh);
		holderOrbits.push({
			mesh,
			radius,
			y,
			angle,
			speed: 0.0008 + (i % 3) * 0.0004,
			bob: 0.6 + (i % 5) * 0.15,
			phase: i,
		});
	});
}

// Graduation ring: a faint full torus with a bright arc filled to progress.
function buildGraduationRing(snapshot) {
	const base = new Mesh(
		new TorusGeometry(2.05, 0.03, 12, 96),
		new MeshBasicMaterial({ color: 0x2a2f4a }),
	);
	base.rotation.x = Math.PI / 2;
	spin.add(base);

	const p = snapshot.graduated ? 1 : snapshot.graduationProgress;
	if (p === null) return;
	const sweep = Math.max(0.02, p) * Math.PI * 2;
	const arc = new Mesh(
		new RingGeometry(2.0, 2.12, 96, 1, 0, sweep),
		new MeshBasicMaterial({
			color: snapshot.graduated ? 0x44e08a : 0x6ea8ff,
			side: DoubleSide,
			transparent: true,
			opacity: 0.95,
			blending: AdditiveBlending,
		}),
	);
	arc.rotation.x = Math.PI / 2;
	spin.add(arc);
}

// ── HUD ───────────────────────────────────────────────────────────────────────
function renderHud(s) {
	const cap = s.marketCapUsd !== null ? `$${compact(s.marketCapUsd)}` : '—';
	const grad = s.graduated
		? 'Graduated → Raydium'
		: s.graduationProgress !== null
			? `${Math.round(s.graduationProgress * 100)}% to graduation`
			: 'Bonding curve';
	const conc = s.topHolderPercent !== null ? `${s.topHolderPercent.toFixed(1)}%` : '—';
	hud.hidden = false;
	hud.innerHTML = `
		<div class="hud-head">
			<h1>${escapeHtml(s.name)}</h1>
			${s.symbol ? `<span class="ticker">$${escapeHtml(s.symbol)}</span>` : ''}
		</div>
		<dl class="hud-stats">
			<div><dt>Market cap</dt><dd>${cap}</dd></div>
			<div><dt>Top-holder share</dt><dd>${conc}</dd></div>
			<div><dt>Status</dt><dd>${escapeHtml(grad)}</dd></div>
			<div><dt>Top holders shown</dt><dd>${s.holders.length || 0}</dd></div>
		</dl>
		<a class="hud-link" href="https://pump.fun/coin/${encodeURIComponent(s.mint)}" target="_blank" rel="noopener">View on pump.fun ↗</a>`;
}

function compact(n) {
	if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
	if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
	if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
	return n.toFixed(0);
}

// ── Boot ────────────────────────────────────────────────────────────────────
async function main() {
	if (!mint) {
		setStatus('empty', 'No token specified', 'Add ?mint=<address> to view a token in 3D.', {
			href: '/demo/coin',
			label: 'Browse coins',
		});
		return;
	}

	setStatus('loading', 'Loading token…', 'Fetching live on-chain data.');
	let snapshot;
	try {
		snapshot = await loadSnapshot();
	} catch (err) {
		setStatus('error', "Couldn't load this token", err.message, {
			href: '/demo/coin',
			label: 'Browse coins',
		});
		return;
	}

	if (snapshot.name === 'Unknown token' && !snapshot.image && !snapshot.holders.length) {
		setStatus('error', 'Token not found', `No on-chain data for ${mint}.`, {
			href: '/demo/coin',
			label: 'Browse coins',
		});
		return;
	}

	initScene();
	buildCoin(snapshot);
	buildGraduationRing(snapshot);
	buildHolderGalaxy(snapshot);
	renderHud(snapshot);
	setStatus(null);
	document.title = `${snapshot.name}${snapshot.symbol ? ` ($${snapshot.symbol})` : ''} · 3D — three.ws`;

	// Expose the live scene for embedders and host pages (e.g. to react to the
	// loaded snapshot or drive the camera from the outside).
	window.__coin3d = { renderer, scene, camera, controls, snapshot };
	dispatchEvent(new CustomEvent('coin3d:ready', { detail: { snapshot } }));
}

addEventListener('beforeunload', () => {
	if (rafId) cancelAnimationFrame(rafId);
	renderer?.dispose?.();
});

main();
