// /coin3d — a live, interactive 3D snapshot of any pump.fun / Solana token.
//
// Reads ?mint=<base58> (and optional &network=mainnet|devnet) and renders a
// real-time Three.js scene built entirely from live on-chain + market data:
//
//   • a spinning coin medallion textured with the token's logo,
//   • a galaxy of the top holders as spheres sized by balance and tinted by
//     concentration (the rug-risk picture, spatially),
//   • a graduation ring that fills with the token's bonding-curve progress,
//   • live trade pulses — every real DEX swap fires a particle (green buy /
//     red sell) sized by USD value, with a synchronized scrolling tape and a
//     coin glow that reacts to order flow,
//   • a drifting starfield for depth.
//
// Data sources (all real, no mocks):
//   /api/pump-fun-mcp        getTokenDetails / getBondingCurve / getTokenHolders
//   /api/pump/coin-intel     quality, smart-money, concentration, risk flags
//   /api/pump/price-history  OHLCV → price, 24h change, 24h volume, sparkline
//   /api/pump/dex-trades     real DEX swaps → live tape + 3D pulses
//   /api/oracle/coin         conviction score + tier
//   /api/pump/launches       platform launch records → no-mint landing grid
//
// Every state (landing, loading, error, populated) is designed. This is the
// page the MCP tool `pumpfun_token_3d` deep-links to.
//
// Load order matters: the HUD and medallion paint from the identity frame
// (getTokenDetails + getBondingCurve + token meta), and every slower source
// (the holder scan, market history, intel, oracle, trade tape) fills in behind
// it. Nothing on the page waits on the slowest call.

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
	Points,
	BufferGeometry,
	Float32BufferAttribute,
	PointsMaterial,
	Vector3,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fetchFirstOrNull } from '../shared/failover-fetch.js';
import { applyCinematicDefaults, detectQualityTier, loadEnvironment } from '../shared/cinematic-render.js';
import { resolveURI, IPFS_GATEWAYS } from '../ipfs.js';

const MCP_ENDPOINT = '/api/pump-fun-mcp';
// The one and only coin — featured on the no-mint landing.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

// ── DOM handles ─────────────────────────────────────────────────────────────
const canvas = document.getElementById('scene');
const hud = document.getElementById('hud');
const statusEl = document.getElementById('status');

// ── URL params ──────────────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const mint = (params.get('mint') || '').trim();
const network = params.get('network') === 'devnet' ? 'devnet' : 'mainnet';

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isPlausibleMint = (s) => BASE58_RE.test(String(s || '').trim());

// ── MCP client (JSON-RPC over the public read-only endpoint) ─────────────────
let rpcId = 0;
// Every call is bounded. An RPC provider that accepts the socket and then
// stalls used to hang the whole page on the loading spinner forever, because
// nothing downstream could time it out.
async function mcpCall(name, args = {}, timeoutMs = 15_000) {
	let res;
	try {
		res = await fetch(MCP_ENDPOINT, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			signal: AbortSignal.timeout(timeoutMs),
			body: JSON.stringify({
				jsonrpc: '2.0',
				id: ++rpcId,
				method: 'tools/call',
				params: { name, arguments: args },
			}),
		});
	} catch (err) {
		// The endpoint was never reached. Tagged so the caller can tell an outage
		// ("we could not ask") apart from an answer ("this mint is not a token").
		const e = new Error(
			`${name}: ${err?.name === 'TimeoutError' ? 'timed out' : 'endpoint unreachable'}`,
		);
		e.transport = true;
		throw e;
	}
	if (!res.ok) throw new Error(`${name} → HTTP ${res.status}`);
	const env = await res.json();
	if (env.error) throw new Error(env.error.message || `${name} failed`);
	return env.result?.structuredContent ?? null;
}

// Identity frame: everything the HUD and the medallion need to paint. Curve
// data is best-effort, so an unavailable source degrades the matching visual
// rather than failing the whole scene.
//
// The holder scan is deliberately NOT in here. It is by far the slowest source
// (a full token-account walk, ~10s on a cold cache for a large holder set) and
// waiting on it held the entire page behind the loading spinner for the whole
// duration. It now loads in the background and fills in when it lands.
async function loadSnapshot() {
	const [details, curve, meta] = await Promise.allSettled([
		mcpCall('getTokenDetails', { mint }),
		mcpCall('getBondingCurve', { mint, network }),
		fetchTokenMeta(mint),
	]);
	const d = details.status === 'fulfilled' ? details.value || {} : {};
	const c = curve.status === 'fulfilled' ? curve.value || null : null;
	// GeckoTerminal token info: the reliable name/symbol/logo/market-cap source
	// for graduated coins, whose on-chain metadata authority is renounced so
	// getTokenDetails comes back null (e.g. $THREE itself).
	const gt = meta.status === 'fulfilled' ? meta.value || null : null;

	// Did anything actually answer? A JSON-RPC error is an answer ("no such
	// token"); a transport failure is not ("we could not ask"). The two need
	// different error copy and different recovery actions.
	const answered = [details, curve].some(
		(r) => r.status === 'fulfilled' || !r.reason?.transport,
	);

	const name = d.name || d.metadata?.name || gt?.name || 'Unknown token';
	const symbol = (d.symbol || d.metadata?.symbol || gt?.symbol || '').toUpperCase();
	const image = (await resolveImage(d)) || gt?.image || null;

	return {
		mint,
		network,
		answered,
		name,
		symbol,
		image,
		marketCapUsd: numOrNull(d.marketCapUsd ?? d.usdMarketCap ?? d.market_cap) ?? gt?.marketCapUsd ?? null,
		priceUsd: gt?.priceUsd ?? null,
		volume24: gt?.volume24 ?? null,
		graduationProgress: clamp01(numOrNull(c?.graduationProgress ?? c?.progress)),
		graduated: Boolean(c?.graduated || c?.complete),
		topHolderPercent: null,
		holders: [],
	};
}

// The token exists as far as any of our sources are concerned. Used to tell a
// real coin whose enrichment happened to be thin apart from a mint that simply
// is not a token.
function isKnownToken(s) {
	return (
		s.name !== 'Unknown token' ||
		Boolean(s.image) ||
		s.marketCapUsd !== null ||
		s.priceUsd !== null ||
		s.graduationProgress !== null ||
		s.graduated
	);
}

// Top holders, loaded after the HUD has painted. Best-effort by design: a
// failure leaves the galaxy empty and the concentration stat unknown, both of
// which have designed states.
async function loadHolders() {
	try {
		const h = await mcpCall('getTokenHolders', { mint, limit: 12, network }, 25_000);
		return {
			topHolderPercent: numOrNull(h?.topHolderPercent),
			holders: Array.isArray(h?.holders) ? h.holders : [],
		};
	} catch {
		return { topHolderPercent: null, holders: [] };
	}
}

// Token info from three keyless, CORS-enabled sources, tried in order
// (GeckoTerminal → DexScreener → Jupiter). Resolves the canonical name,
// symbol, logo and market cap for any token — including graduated coins that
// getTokenDetails can't describe. Best-effort: null on any failure so the
// snapshot still renders from MCP data. Mainnet-only (none index devnet).
async function fetchTokenMeta(mintAddr) {
	if (network !== 'mainnet') return null;
	const mint = encodeURIComponent(mintAddr);
	return fetchFirstOrNull([
		{
			name: 'geckoterminal',
			url: `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}`,
			parse: async (r) => {
				const a = (await r.json())?.data?.attributes;
				if (!a) return null;
				const img = a.image_url && !/missing\.png$/i.test(a.image_url) ? a.image_url : null;
				return {
					name: a.name || null,
					symbol: a.symbol || null,
					image: img,
					marketCapUsd: numOrNull(a.market_cap_usd) ?? numOrNull(a.fdv_usd),
					priceUsd: numOrNull(a.price_usd),
					volume24: numOrNull(a.volume_usd?.h24),
				};
			},
		},
		{
			name: 'dexscreener',
			url: `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
			parse: async (r) => {
				const pairs = ((await r.json())?.pairs || []).filter((p) => p.chainId === 'solana');
				if (!pairs.length) return null;
				pairs.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
				const p = pairs[0];
				return {
					name: p.baseToken?.name || null,
					symbol: p.baseToken?.symbol || null,
					image: p.info?.imageUrl || null,
					marketCapUsd: numOrNull(p.marketCap) ?? numOrNull(p.fdv),
					priceUsd: numOrNull(p.priceUsd),
					volume24: numOrNull(p.volume?.h24),
				};
			},
		},
		{
			name: 'jupiter',
			url: `https://lite-api.jup.ag/tokens/v2/search?query=${mint}`,
			parse: async (r) => {
				const t = (await r.json())?.[0];
				if (!t || (t.id || t.address) !== mintAddr) return null;
				return {
					name: t.name || null,
					symbol: t.symbol || null,
					image: t.icon || t.logoURI || null,
					marketCapUsd: numOrNull(t.mcap) ?? numOrNull(t.fdv),
					priceUsd: numOrNull(t.usdPrice),
					volume24: numOrNull(t.stats24h?.buyVolume) != null || numOrNull(t.stats24h?.sellVolume) != null
						? (numOrNull(t.stats24h?.buyVolume) ?? 0) + (numOrNull(t.stats24h?.sellVolume) ?? 0)
						: null,
				};
			},
		},
	], { timeoutMs: 7000, label: 'token-meta' });
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
	// Resolve through the shared gateway list so this page inherits every gateway
	// the rest of the platform rotates through, instead of pinning one host.
	if (url.startsWith('ipfs://')) return resolveURI(url);
	return url;
}

// If a gateway URL fails, the content is usually still pinned elsewhere — retry
// the same CID on a second gateway before degrading. Returns null when the URL
// isn't a known gateway URL (nothing useful to retry).
function altIpfsGateway(url) {
	if (typeof url !== 'string') return null;
	// Find which shared gateway this URL currently uses and hand back the next
	// one in the list, so a retry walks the whole chain rather than bouncing
	// between the same two hosts.
	const idx = IPFS_GATEWAYS.findIndex((gw) => url.startsWith(gw));
	if (idx === -1) return null;
	const cid = url.slice(IPFS_GATEWAYS[idx].length);
	const next = IPFS_GATEWAYS[(idx + 1) % IPFS_GATEWAYS.length];
	return next === IPFS_GATEWAYS[idx] ? null : `${next}${cid}`;
}

function numOrNull(v) {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}
function clamp01(v) {
	if (v === null) return null;
	return Math.max(0, Math.min(1, v > 1 ? v / 100 : v));
}

// ── Status overlay (loading / error) ─────────────────────────────────────────
function setStatus(kind, title, detail, action) {
	if (kind === null) {
		statusEl.hidden = true;
		statusEl.removeAttribute('data-kind');
		statusEl.innerHTML = '';
		return;
	}
	statusEl.hidden = false;
	statusEl.dataset.kind = kind;
	// The overlay owns the page's only heading while it is up (the HUD's <h1>
	// exists only after the overlay is cleared), so this is an <h1>, not an
	// <h2> under a heading that never rendered.
	statusEl.innerHTML = `
		<div class="status-card" role="status" aria-live="polite">
			${kind === 'loading' ? '<div class="spinner" aria-hidden="true"></div>' : ''}
			<h1>${escapeHtml(title)}</h1>
			${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
			${action ? `<a class="status-action" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>` : ''}
		</div>`;
}

function escapeHtml(s) {
	return String(s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

// ── Number formatting ─────────────────────────────────────────────────────────
function compact(n) {
	if (!Number.isFinite(n)) return '—';
	const abs = Math.abs(n);
	if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
	if (abs >= 1e6) return (n / 1e6).toFixed(2) + 'M';
	if (abs >= 1e3) return (n / 1e3).toFixed(1) + 'K';
	if (abs >= 100) return n.toFixed(0);
	// Meme-coin tape entries are routinely worth cents. Rounding those to a
	// whole number printed every real swap as "$0", which reads as a bug.
	if (abs >= 1) return n.toFixed(2);
	if (abs >= 0.01) return n.toFixed(3);
	if (abs > 0) return n.toFixed(4);
	return '0';
}

// SOL leg of a tape row. Same problem as `compact`: a 0.0004 SOL swap must not
// print as "0.000 SOL".
function fmtSol(n) {
	if (!Number.isFinite(n) || n < 0) return '';
	if (n >= 1) return n.toFixed(2);
	if (n >= 0.01) return n.toFixed(3);
	if (n > 0) return n.toPrecision(2).replace(/0+$/, '').replace(/\.$/, '');
	return '0';
}

// Price formatting that survives sub-cent meme-coin prices without lying about
// precision: show enough significant digits to be meaningful.
function fmtPrice(n) {
	if (!Number.isFinite(n) || n <= 0) return '—';
	if (n >= 1) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2 });
	if (n >= 0.01) return '$' + n.toFixed(4);
	if (n >= 1e-6) return '$' + n.toFixed(8).replace(/0+$/, '');
	return '$' + n.toExponential(2);
}

function shortAddr(a) {
	if (!a || a.length < 9) return a || '—';
	return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function timeAgo(tsSec) {
	if (!tsSec) return '';
	const s = Math.max(0, Math.floor(Date.now() / 1000 - tsSec));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

// ── Three.js scene ────────────────────────────────────────────────────────────
let renderer, scene, camera, controls, rafId;
const spin = new Group();
const holderOrbits = [];
let starField = null;
let coinFaceMats = []; // medallion face materials, glow-modulated by order flow
let coinGlow = 0; // decaying 0..1 pulse driven by trades
let coinGlowColor = new Color(0x6ea8ff);

function initScene() {
	renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true });
	// Shared cinematic bar: ACES tone mapping + sRGB output color space +
	// tiered pixel ratio cap (replaces the old sRGB-only line). The medallion
	// is a real textured/metallic MeshStandardMaterial product shot, so it
	// gets a real HDRI for genuine reflections too. No ground-contact shadow:
	// the coin and holder galaxy spin freely in starfield space with no
	// floor/pedestal for a shadow to land on.
	const tier = detectQualityTier();
	applyCinematicDefaults(renderer, { tier });

	scene = new Scene();
	loadEnvironment(renderer, scene, tier === 'mobile' ? null : 'studio');

	camera = new PerspectiveCamera(45, 1, 0.1, 200);
	camera.position.set(0, 1.6, 6.2);

	controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.08;
	controls.minDistance = 3.5;
	controls.maxDistance = 14;
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

	buildStarfield();
	scene.add(spin);
	resize();
	addEventListener('resize', resize);
	animate();
}

// Drifting starfield — pure depth cue, lives outside `spin` so it rotates
// independently of the coin.
function buildStarfield() {
	const count = 700;
	const pos = new Float32Array(count * 3);
	for (let i = 0; i < count; i++) {
		// Random point in a spherical shell well behind the scene.
		const r = 18 + Math.random() * 40;
		const theta = Math.random() * Math.PI * 2;
		const phi = Math.acos(2 * Math.random() - 1);
		pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
		pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
		pos[i * 3 + 2] = r * Math.cos(phi);
	}
	const geo = new BufferGeometry();
	geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
	starField = new Points(
		geo,
		new PointsMaterial({
			color: 0x9fb4ff,
			size: 0.09,
			sizeAttenuation: true,
			transparent: true,
			opacity: 0.55,
			depthWrite: false,
		}),
	);
	scene.add(starField);
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
	if (starField) starField.rotation.y += 0.0004;

	for (const o of holderOrbits) {
		o.angle += o.speed;
		o.mesh.position.x = Math.cos(o.angle) * o.radius;
		o.mesh.position.z = Math.sin(o.angle) * o.radius;
		o.mesh.position.y = o.y + Math.sin(t * o.bob + o.phase) * 0.08;
		if (o.spawn !== undefined) {
			const k = (t - o.spawn) / 0.55;
			if (k >= 1) {
				o.mesh.scale.setScalar(1);
				o.spawn = undefined;
			} else {
				// Ease-out back: a touch of overshoot so the arrival reads as motion.
				const e = Math.max(0, 1 - Math.pow(1 - Math.max(0, k), 3));
				o.mesh.scale.setScalar(Math.max(0.001, e * (1 + Math.sin(e * Math.PI) * 0.12)));
			}
		}
	}

	stepPulses();

	// Coin glow decays toward zero; trades bump it back up (see firePulse).
	if (coinGlow > 0.001) {
		coinGlow *= 0.94;
		for (const m of coinFaceMats) {
			m.emissive.copy(coinGlowColor);
			m.emissiveIntensity = coinGlow * 0.9;
		}
	} else if (coinGlow !== 0) {
		coinGlow = 0;
		for (const m of coinFaceMats) m.emissiveIntensity = 0;
	}

	controls.update();
	renderer.render(scene, camera);
}

// The coin medallion: a thin cylinder with the logo on both faces and a
// metallic rim. Falls back to a brand-tinted disc if the logo can't be loaded.
function buildCoin(snapshot) {
	const rim = new MeshStandardMaterial({ color: 0x2b2f44, metalness: 0.9, roughness: 0.35 });
	const faceMat = new MeshStandardMaterial({
		color: 0x1a1d2e,
		metalness: 0.5,
		roughness: 0.6,
		emissive: 0x000000,
		emissiveIntensity: 0,
	});
	const geo = new CylinderGeometry(1.6, 1.6, 0.28, 64);
	// [side, top, bottom] material groups for a CylinderGeometry.
	const coin = new Mesh(geo, [rim, faceMat, faceMat]);
	coin.rotation.x = Math.PI / 2; // face the camera
	spin.add(coin);
	coinFaceMats = [faceMat];

	if (snapshot.image) {
		const loader = new TextureLoader();
		loader.setCrossOrigin('anonymous');

		const applyTexture = (tex) => {
			tex.colorSpace = SRGBColorSpace;
			const lit = new MeshStandardMaterial({
				map: tex,
				metalness: 0.3,
				roughness: 0.55,
				emissive: 0x000000,
				emissiveIntensity: 0,
			});
			coin.material = [rim, lit, lit];
			coinFaceMats = [lit];
		};

		const loadFrom = (src, allowRetry) => {
			loader.load(src, applyTexture, undefined, () => {
				// The primary gateway dropped the logo. The CID is usually pinned on
				// other gateways too, so retry once on an alternate before degrading
				// to the tinted disc.
				const alt = allowRetry ? altIpfsGateway(src) : null;
				if (alt) loadFrom(alt, false);
			});
		};

		loadFrom(snapshot.image, true);
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
		// The scan resolves after the scene is already turning, so each sphere
		// scales up on a short stagger instead of popping into frame.
		mesh.scale.setScalar(0.001);
		holderGalaxy.add(mesh);
		holderOrbits.push({
			mesh,
			radius,
			y,
			angle,
			speed: 0.0008 + (i % 3) * 0.0004,
			bob: 0.6 + (i % 5) * 0.15,
			phase: i,
			spawn: performance.now() / 1000 + i * 0.04,
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

// ── Live trade pulses (3D) ────────────────────────────────────────────────────
// A bounded pool of glowing particles. Each real DEX swap fires one: buys fly
// inward toward the coin, sells fly outward — sized by USD value, colored by
// side. The coin's emissive glow is bumped on every trade so order flow reads
// even before you parse the tape.
const PULSE_POOL = 36;
const pulses = [];
const _tmpVec = new Vector3();

function buildPulsePool() {
	for (let i = 0; i < PULSE_POOL; i++) {
		const mat = new MeshBasicMaterial({
			color: 0x44e08a,
			transparent: true,
			opacity: 0,
			blending: AdditiveBlending,
			depthWrite: false,
		});
		const mesh = new Mesh(new SphereGeometry(0.08, 12, 12), mat);
		mesh.visible = false;
		// Pulses live outside `spin` so they fly along fixed world rays rather
		// than being dragged by the coin's rotation.
		scene.add(mesh);
		pulses.push({ mesh, mat, active: false, start: 0, life: 1, from: new Vector3(), to: new Vector3(), base: 0.08 });
	}
}

function firePulse(trade) {
	const slot = pulses.find((p) => !p.active);
	if (!slot) return; // pool saturated — drop the visual, tape still records it
	const isBuy = trade.is_buy;
	const usd = Number(trade.sol_value_usd) || 0;
	// Size: clamp so a whale doesn't fill the screen and dust is still visible.
	const mag = Math.min(1, Math.log10(1 + usd) / 4); // ~0 at $0, ~1 at $10k+
	const size = MathUtils.lerp(0.05, 0.34, mag);

	// Random direction on a sphere for variety.
	const theta = Math.random() * Math.PI * 2;
	const phi = Math.acos(2 * Math.random() - 1);
	_tmpVec.set(Math.sin(phi) * Math.cos(theta), Math.sin(phi) * Math.sin(theta) * 0.6, Math.cos(phi));
	const near = 1.7;
	const far = 6.5;
	if (isBuy) {
		slot.from.copy(_tmpVec).multiplyScalar(far);
		slot.to.copy(_tmpVec).multiplyScalar(near);
	} else {
		slot.from.copy(_tmpVec).multiplyScalar(near);
		slot.to.copy(_tmpVec).multiplyScalar(far);
	}
	slot.base = size;
	slot.mat.color.set(isBuy ? 0x44e08a : 0xff6b6b);
	slot.active = true;
	slot.start = performance.now() / 1000;
	slot.life = 1.3 + mag * 0.6;
	slot.mesh.scale.setScalar(1);
	slot.mesh.visible = true;

	// Bump the coin glow toward the trade's side, scaled by size.
	coinGlow = Math.min(1, coinGlow + 0.35 + mag * 0.4);
	coinGlowColor.set(isBuy ? 0x44e08a : 0xff6b6b);
}

function stepPulses() {
	const now = performance.now() / 1000;
	for (const p of pulses) {
		if (!p.active) continue;
		const k = (now - p.start) / p.life;
		if (k >= 1) {
			p.active = false;
			p.mesh.visible = false;
			p.mat.opacity = 0;
			continue;
		}
		// Ease toward target; fade in fast, out slow; gentle scale swell.
		const eased = 1 - Math.pow(1 - k, 2);
		p.mesh.position.lerpVectors(p.from, p.to, eased);
		p.mat.opacity = Math.sin(k * Math.PI) * 0.95;
		const s = p.base * (0.7 + Math.sin(k * Math.PI) * 0.6);
		p.mesh.scale.setScalar(s / 0.08);
	}
}

// ── Watchlist (shared ld_watchlist key) ──────────────────────────────────────
const WATCH_KEY = 'ld_watchlist';

function isWatched(mintAddr) {
	try {
		return JSON.parse(localStorage.getItem(WATCH_KEY) || '[]').includes(mintAddr);
	} catch {
		return false;
	}
}

function toggleWatch(mintAddr) {
	try {
		let list = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]');
		if (list.includes(mintAddr)) {
			list = list.filter((m) => m !== mintAddr);
		} else {
			list = [mintAddr, ...list];
		}
		localStorage.setItem(WATCH_KEY, JSON.stringify(list));
		return list.includes(mintAddr);
	} catch {
		return false;
	}
}

// ── Oracle conviction ─────────────────────────────────────────────────────────
const _c3dOracleCache = new Map();

async function fetchOracleConviction(mintAddr, net) {
	const key = `${net}:${mintAddr}`;
	if (_c3dOracleCache.has(key)) return _c3dOracleCache.get(key);
	try {
		const r = await fetch(`/api/oracle/coin?mint=${encodeURIComponent(mintAddr)}&network=${net}`, {
			signal: AbortSignal.timeout(8000),
		});
		if (!r.ok) return null;
		const d = await r.json();
		const cv = d?.conviction ? { score: d.conviction.score, tier: d.conviction.tier } : null;
		_c3dOracleCache.set(key, cv);
		return cv;
	} catch {
		return null;
	}
}

const TIER_COLORS = {
	prime: '#44e08a',
	strong: '#6ea8ff',
	lean: '#f0c040',
	watch: '#ff9944',
	avoid: '#ff5555',
};

function renderOracleSlot(cv, mintAddr) {
	const el = document.getElementById('c3d-oracle');
	if (!el) return;
	if (!cv) {
		el.style.display = 'none';
		return;
	}
	const color = TIER_COLORS[cv.tier] || '#97a0c4';
	el.innerHTML = `<a class="c3d-oracle" href="/oracle/coin/${encodeURIComponent(mintAddr)}" aria-label="Oracle conviction: ${cv.score} ${cv.tier}">
		<span class="c3d-oracle-label">Oracle</span>
		<span class="c3d-oracle-score" style="color:${color}">${cv.score}</span>
		<span class="c3d-oracle-tier" style="color:${color}">${escapeHtml(cv.tier)}</span>
		<span class="c3d-oracle-arrow">→</span>
	</a>`;
}

// ── Coin intelligence (quality, smart money, concentration, risk flags) ───────
const RISK_LABELS = {
	bundle_launch: 'Bundle launch',
	dev_dumped: 'Dev dumped',
	single_whale: 'Single whale',
	low_diversity: 'Low diversity',
	fresh_wallet_swarm: 'Fresh-wallet swarm',
	high_concentration: 'Concentrated',
	rugged: 'Rugged',
};

async function fetchCoinIntel(mintAddr, net) {
	try {
		const r = await fetch(
			`/api/pump/coin-intel?mint=${encodeURIComponent(mintAddr)}&network=${net}`,
			{ signal: AbortSignal.timeout(8000) },
		);
		if (!r.ok) return null; // 404 = coin not observed by the intel engine; fine
		return await r.json();
	} catch {
		return null;
	}
}

// ── Market data (price, 24h change, 24h volume, sparkline) ────────────────────
async function fetchMarket(mintAddr) {
	try {
		const r = await fetch(`/api/pump/price-history?mint=${encodeURIComponent(mintAddr)}&interval=15m`, {
			signal: AbortSignal.timeout(9000),
		});
		if (!r.ok) return null;
		const body = await r.json();
		const candles = Array.isArray(body?.data) ? body.data : [];
		// An answer with no candles is a fact about the coin ("nothing has traded
		// yet"); a failure is a fact about us. They get different copy.
		if (!candles.length) return { empty: true };
		const closes = candles.map((c) => Number(c.c)).filter(Number.isFinite);
		if (!closes.length) return { empty: true };
		const price = closes[closes.length - 1];
		const first = closes[0];
		const change = first > 0 ? (price - first) / first : null;
		const volume = candles.reduce((s, c) => s + (Number(c.v) || 0), 0);
		return { price, change, volume, closes };
	} catch {
		return null;
	}
}

// ── Live trade tape (polls real DEX swaps) ────────────────────────────────────
const tape = {
	seen: new Set(),
	rows: [],
	timer: null,
	netFlow: 0, // running USD net flow over the session
	primed: false,
	misses: 0, // consecutive failed polls
};

async function pollTrades(mintAddr) {
	try {
		const r = await fetch(`/api/pump/dex-trades?mint=${encodeURIComponent(mintAddr)}&limit=40`, {
			signal: AbortSignal.timeout(9000),
		});
		if (!r.ok) throw new Error(`dex-trades ${r.status}`);
		tape.misses = 0;
		const body = await r.json();
		const trades = Array.isArray(body?.trades) ? body.trades : [];
		// Oldest-first so newest ends up at the top of the tape and pulses fire
		// in chronological order.
		const fresh = trades
			.filter((t) => t.signature && !tape.seen.has(t.signature))
			.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));

		const stale = body?.stale === true;
		updateLiveDot(stale, trades.length > 0);

		if (!fresh.length) {
			// Restores the "watching" message if an earlier outage replaced it.
			if (!tape.rows.length) renderTape();
			return;
		}
		for (const t of fresh) tape.seen.add(t.signature);
		// Keep the seen-set from growing without bound over a long session.
		if (tape.seen.size > 4000) tape.seen = new Set([...tape.seen].slice(-2000));

		for (const t of fresh) {
			tape.rows.unshift(t);
			tape.netFlow += (t.is_buy ? 1 : -1) * (Number(t.sol_value_usd) || 0);
			// Fire a 3D pulse only once the scene is primed, so the initial batch
			// doesn't dump 40 particles at once.
			if (tape.primed) firePulse(t);
		}
		tape.rows = tape.rows.slice(0, 40);
		tape.primed = true;
		renderTape();
	} catch {
		// A single blip just skips a tick. A sustained outage gets said out loud,
		// so the tape never sits on "watching for swaps" while nothing is watching.
		tape.misses += 1;
		updateLiveDot(true, tape.rows.length > 0);
		if (tape.misses >= 2 && !tape.rows.length) {
			const list = document.getElementById('c3d-tape-list');
			if (list) {
				list.innerHTML =
					'<div class="c3d-tape-empty">Live trades are unavailable right now. Retrying every few seconds.</div>';
			}
		}
	}
}

function updateLiveDot(stale, hasData) {
	const dot = document.getElementById('c3d-live-dot');
	if (dot) dot.classList.toggle('stale', stale || !hasData);
	const flow = document.getElementById('c3d-tape-flow');
	if (flow && tape.rows.length) {
		const f = tape.netFlow;
		const sign = f >= 0 ? '+' : '−';
		flow.textContent = `net ${sign}$${compact(Math.abs(f))}`;
		flow.style.color = f >= 0 ? '#74e0a8' : '#ff8f8f';
	}
}

function renderTape() {
	const list = document.getElementById('c3d-tape-list');
	if (!list) return;
	if (!tape.rows.length) {
		list.innerHTML = `<div class="c3d-tape-empty">Watching the tape for live swaps…</div>`;
		return;
	}
	list.innerHTML = tape.rows
		.slice(0, 14)
		.map((t, i) => {
			const side = t.is_buy ? 'buy' : 'sell';
			const usd = Number(t.sol_value_usd);
			const usdLabel = Number.isFinite(usd) ? `$${compact(usd)}` : '—';
			const sol = Number(t.sol_amount);
			const solText = fmtSol(sol);
			const solLabel = solText ? `${solText} SOL` : '';
			const href = t.signature ? `https://solscan.io/tx/${encodeURIComponent(t.signature)}` : null;
			const trader = shortAddr(t.trader);
			const ago = timeAgo(t.timestamp);
			// A trade with no readable SOL leg drops that segment rather than
			// rendering an empty one between two separators.
			const mid = [solLabel, trader].filter(Boolean).map(escapeHtml).join(' · ');
			const inner = `
				<span class="t-side" aria-hidden="true"></span>
				<span class="t-mid"><span class="t-usd">${t.is_buy ? '↑' : '↓'} ${usdLabel}</span> · ${mid}</span>
				<span class="t-time">${ago}</span>`;
			// New rows (only the top one on a fresh poll) animate in.
			const cls = `c3d-trade ${side}${i === 0 ? ' enter' : ''}`;
			const label = `${side} ${usdLabel} by ${trader}, ${ago} ago. Opens the transaction on Solscan.`;
			return href
				? `<a class="${cls}" href="${href}" target="_blank" rel="noopener" aria-label="${escapeHtml(label)}">${inner}</a>`
				: `<div class="${cls}">${inner}</div>`;
		})
		.join('');
}

function startTradePolling(mintAddr) {
	pollTrades(mintAddr);
	tape.timer = setInterval(() => pollTrades(mintAddr), 9000);
	// Pause polling when the tab is hidden; resume (and refresh once) on return.
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) {
			clearInterval(tape.timer);
			tape.timer = null;
		} else if (!tape.timer) {
			pollTrades(mintAddr);
			tape.timer = setInterval(() => pollTrades(mintAddr), 9000);
		}
	});
}

// ── Sparkline ─────────────────────────────────────────────────────────────────
function sparklineSvg(closes, up) {
	if (!closes || closes.length < 2) return '<div class="c3d-spark-empty"></div>';
	const w = 320;
	const h = 44;
	const min = Math.min(...closes);
	const max = Math.max(...closes);
	const span = max - min || 1;
	const n = closes.length;
	const pts = closes.map((c, i) => {
		const x = (i / (n - 1)) * w;
		const y = h - 3 - ((c - min) / span) * (h - 6);
		return `${x.toFixed(1)},${y.toFixed(1)}`;
	});
	const stroke = up ? '#44e08a' : '#ff6b6b';
	const areaId = 'c3dSparkFill';
	const area = `0,${h} ${pts.join(' ')} ${w},${h}`;
	return `<svg class="c3d-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="24-hour price trend">
		<defs><linearGradient id="${areaId}" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0%" stop-color="${stroke}" stop-opacity="0.28"/>
			<stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>
		</linearGradient></defs>
		<polygon points="${area}" fill="url(#${areaId})"/>
		<polyline points="${pts.join(' ')}" fill="none" stroke="${stroke}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
	</svg>`;
}

// ── HUD ─────────────────────────────────────────────────────────────────────
// Built once with stable element IDs; live data updaters mutate nodes in place
// so polling never tears down the tape scroll position or rebinds listeners.
function renderHud(s) {
	const watching = s.mint ? isWatched(s.mint) : false;
	hud.hidden = false;
	hud.innerHTML = `
		<div class="hud-head">
			<h1>${escapeHtml(s.name)}</h1>
			${s.symbol ? `<span class="ticker">$${escapeHtml(s.symbol)}</span>` : ''}
			<span id="c3d-cat" class="c3d-cat" hidden></span>
		</div>
		<div class="hud-price">
			<span class="px" id="c3d-price">${s.priceUsd !== null ? fmtPrice(s.priceUsd) : '—'}</span>
			<span class="c3d-change flat" id="c3d-change"></span>
		</div>
		<div class="c3d-spark-wrap" id="c3d-spark"><div class="c3d-spark-empty"></div></div>
		<dl class="hud-stats">
			<div><dt>Market cap</dt><dd id="c3d-mcap">${s.marketCapUsd !== null ? '$' + compact(s.marketCapUsd) : '—'}</dd></div>
			<div><dt>24h volume</dt><dd id="c3d-vol">${s.volume24 !== null ? '$' + compact(s.volume24) : '—'}</dd></div>
			<div><dt>Top-holder share</dt><dd id="c3d-conc"><span class="c3d-dd-sk" role="img" aria-label="Loading top-holder share"></span></dd></div>
			<div><dt>Status</dt><dd id="c3d-status">${escapeHtml(gradLabel(s))}</dd></div>
			<div><dt>Quality</dt><dd id="c3d-quality">—</dd></div>
			<div><dt>Smart money</dt><dd id="c3d-smart">—</dd></div>
		</dl>
		<div class="c3d-risks" id="c3d-risks" hidden></div>
		<div id="c3d-oracle"><div class="c3d-oracle-sk" aria-hidden="true"></div></div>
		<div class="c3d-tape">
			<div class="c3d-tape-head">
				<span class="c3d-tape-title"><span class="c3d-live-dot stale" id="c3d-live-dot" aria-hidden="true"></span>Live trades</span>
				<span class="c3d-tape-flow" id="c3d-tape-flow"></span>
			</div>
			<div class="c3d-tape-list" id="c3d-tape-list"><div class="c3d-tape-empty">Watching the tape for live swaps…</div></div>
		</div>
		<div class="hud-links">
			${s.mint ? `<button id="c3d-watch" class="c3d-watch-btn" type="button" aria-pressed="${watching}">${watching ? '★ Watching' : '☆ Watch'}</button>` : ''}
			<a class="hud-link" href="https://pump.fun/coin/${encodeURIComponent(s.mint)}" target="_blank" rel="noopener">pump.fun ↗</a>
			<a class="hud-link" href="/launches">All launches →</a>
			${s.mint ? `<a class="hud-link" href="/communities/${encodeURIComponent(s.mint)}">3D world →</a>` : ''}
			<a class="hud-link" href="/launch">Launch your own →</a>
		</div>`;

	if (s.mint) {
		document.getElementById('c3d-watch')?.addEventListener('click', function () {
			const now = toggleWatch(s.mint);
			this.textContent = now ? '★ Watching' : '☆ Watch';
			this.setAttribute('aria-pressed', String(now));
		});
	}
}

function gradLabel(s) {
	if (s.graduated) return 'Graduated → Raydium';
	if (s.graduationProgress !== null) return `${Math.round(s.graduationProgress * 100)}% to graduation`;
	return 'Bonding curve';
}

function applyMarket(m) {
	const sparkSlot = document.getElementById('c3d-spark');
	if (!m || m.empty) {
		// Replace the skeleton rather than pulsing forever. The next 60s refresh
		// still overwrites this with a real sparkline once one exists.
		if (sparkSlot?.querySelector('.c3d-spark-empty')) {
			sparkSlot.innerHTML = `<p class="c3d-spark-none">${
				m ? 'No price history yet.' : 'Price history unavailable.'
			}</p>`;
		}
		return;
	}
	const priceEl = document.getElementById('c3d-price');
	if (priceEl) priceEl.textContent = fmtPrice(m.price);
	const volEl = document.getElementById('c3d-vol');
	if (volEl && m.volume) volEl.textContent = '$' + compact(m.volume);
	const changeEl = document.getElementById('c3d-change');
	if (changeEl && m.change !== null) {
		const pct = m.change * 100;
		const dir = pct > 0.05 ? 'up' : pct < -0.05 ? 'down' : 'flat';
		changeEl.className = `c3d-change ${dir}`;
		changeEl.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% · 24h`;
	}
	const spark = document.getElementById('c3d-spark');
	if (spark) spark.innerHTML = sparklineSvg(m.closes, (m.change ?? 0) >= 0);
}

// Set once the on-chain holder scan has produced a top-holder share, so the
// intel engine's estimate never overwrites it.
let concOwned = false;

// Fold the (late) holder scan into a HUD that has already painted: fill the
// concentration stat and grow the galaxy in, rather than popping 12 spheres
// into an established scene.
function applyHolders(s, result, sceneOk) {
	s.topHolderPercent = result.topHolderPercent;
	s.holders = result.holders;

	const conc = document.getElementById('c3d-conc');
	if (conc) {
		if (result.topHolderPercent !== null) {
			conc.textContent = `${result.topHolderPercent.toFixed(1)}%`;
			concOwned = true;
		} else if (conc.querySelector('.c3d-dd-sk')) {
			// The scan came back empty. Say so instead of pulsing forever.
			conc.textContent = 'Unknown';
		}
	}
	if (sceneOk) buildHolderGalaxy(s);
}

function applyIntel(intel) {
	if (!intel || intel.error) return;
	const cat = document.getElementById('c3d-cat');
	if (cat && intel.category && intel.category !== 'unknown') {
		cat.textContent = intel.category;
		cat.hidden = false;
	}
	const quality = document.getElementById('c3d-quality');
	if (quality && intel.quality_score != null) quality.textContent = `${Math.round(intel.quality_score)}/100`;
	const smart = document.getElementById('c3d-smart');
	if (smart && intel.smart_money_count != null) {
		smart.textContent = intel.smart_money_count > 0 ? `${intel.smart_money_count} wallet${intel.smart_money_count === 1 ? '' : 's'}` : 'None';
	}
	// Prefer the intel engine's concentration when the holder scan didn't supply
	// one. `concOwned` is the authority flag: the holder scan can land after the
	// intel call, and the on-chain number must win whichever order they arrive in.
	const conc = document.getElementById('c3d-conc');
	if (conc && !concOwned && intel.concentration_top1 != null) {
		conc.textContent = `${(intel.concentration_top1 * (intel.concentration_top1 <= 1 ? 100 : 1)).toFixed(1)}%`;
	}
	// Risk flags → chips (danger flags only; a clean coin shows a green "Clean").
	const risks = document.getElementById('c3d-risks');
	const flags = Array.isArray(intel.risk_flags) ? intel.risk_flags : [];
	if (risks) {
		if (flags.length) {
			risks.innerHTML = flags
				.slice(0, 5)
				.map((f) => `<span class="c3d-risk">${escapeHtml(RISK_LABELS[f] || f.replace(/_/g, ' '))}</span>`)
				.join('');
			risks.hidden = false;
		} else if (intel.quality_score != null && intel.quality_score >= 70) {
			risks.innerHTML = `<span class="c3d-risk ok">✓ No risk flags</span>`;
			risks.hidden = false;
		}
	}
}

// ── No-mint landing ───────────────────────────────────────────────────────────
function navigateToMint(value) {
	const v = String(value || '').trim();
	const m = v.match(BASE58_RE) ? v : (v.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/) || [])[0];
	return m && isPlausibleMint(m) ? m : null;
}

function renderLanding() {
	statusEl.hidden = false;
	statusEl.dataset.kind = 'empty';
	statusEl.innerHTML = `
		<div class="c3d-landing">
			<h1>See any token in 3D</h1>
			<p class="lede">Paste a pump.fun or Solana mint to render it as a live scene: a logo medallion, holder galaxy, graduation ring, and real-time trade pulses, all from on-chain data.</p>
			<form class="c3d-search" id="c3d-form" autocomplete="off">
				<input id="c3d-mint-input" type="text" inputmode="text" spellcheck="false"
					placeholder="Paste a token mint address…" aria-label="Token mint address" />
				<button type="submit" id="c3d-go">View in 3D</button>
			</form>
			<p class="c3d-search-err" id="c3d-err" role="alert"></p>
			<a class="c3d-three" href="?mint=${THREE_MINT}">◎ View $THREE in 3D →</a>
			<p class="c3d-recent-label">Recent launches on three.ws</p>
			<div class="c3d-recent" id="c3d-recent">
				${Array.from({ length: 4 }).map(() => '<div class="c3d-recent-sk"></div>').join('')}
			</div>
			<div class="c3d-landing-foot">
				<a class="hud-link" href="/launches">Browse all launches →</a>
				<a class="hud-link" href="/launch">Launch your own →</a>
			</div>
		</div>`;

	const form = document.getElementById('c3d-form');
	const input = document.getElementById('c3d-mint-input');
	const err = document.getElementById('c3d-err');
	form?.addEventListener('submit', (e) => {
		e.preventDefault();
		const m = navigateToMint(input.value);
		if (!m) {
			err.textContent = 'That doesn’t look like a valid Solana mint address.';
			input.focus();
			return;
		}
		location.search = `?mint=${m}`;
	});
	input?.addEventListener('input', () => {
		err.textContent = '';
	});
	input?.focus();

	loadRecentLaunches();
}

// The pretty path `/api/pump/launches` depends on a vercel rewrite that isn't
// live on every deploy; the underlying `[action]` form (encoded so it survives
// proxies) always is. Try the canonical path first, fall back to the action
// form, so the grid never silently empties on a partial deploy.
async function fetchLaunches(limit) {
	for (const url of [
		`/api/pump/launches?limit=${limit}`,
		`/api/pump/%5Baction%5D?action=launches&limit=${limit}`,
	]) {
		try {
			const r = await fetch(url, {
				headers: { accept: 'application/json' },
				signal: AbortSignal.timeout(8000),
			});
			if (r.ok) return await r.json();
		} catch {
			// try the next form
		}
	}
	return null;
}

async function loadRecentLaunches() {
	const grid = document.getElementById('c3d-recent');
	if (!grid) return;
	try {
		const body = await fetchLaunches(8);
		if (!body) throw new Error('launches');
		const launches = (body?.data?.launches || []).filter((l) => l.mint).slice(0, 8);
		if (!launches.length) {
			grid.innerHTML = `<p class="c3d-tape-empty" style="grid-column:1/-1">No launches yet. <a class="hud-link" href="/launch">Be the first →</a></p>`;
			return;
		}
		grid.innerHTML = launches.map(launchCard).join('');
	} catch {
		grid.innerHTML = `<p class="c3d-tape-empty" style="grid-column:1/-1"><a class="hud-link" href="/launches">Browse launches →</a></p>`;
	}
}

// Coin logos live in IPFS/R2 metadata JSON that isn't CORS-readable from the
// browser, so we render the launching agent's avatar (a CORS-safe <img>) when
// present, falling back to the symbol initials. No per-card fetch — the grid
// paints instantly from the launches payload.
function launchCard(l) {
	const sym = (l.symbol || l.name || '?').toUpperCase();
	const initials = escapeHtml(sym.slice(0, 2));
	const avatar = l.agent?.avatar_thumbnail_url || null;
	const imgHtml = avatar
		? `<img class="c3d-recent-img" src="${escapeHtml(avatar)}" alt="" loading="lazy" data-fallback="element" data-fallback-class="c3d-recent-img ph" data-fallback-text="${escapeHtml(initials)}" />`
		: `<div class="c3d-recent-img ph">${initials}</div>`;
	const label = escapeHtml(l.symbol ? `$${l.symbol.toUpperCase()}` : sym);
	return `<a class="c3d-recent-card" href="?mint=${encodeURIComponent(l.mint)}" aria-label="View ${label} in 3D">
		${imgHtml}
		<span class="c3d-recent-sym">${label}</span>
	</a>`;
}

// ── Boot ────────────────────────────────────────────────────────────────────
let marketTimer = null;

// The static <title> carries a data-i18n key, and the runtime i18n catalog pass
// lands asynchronously (and again on every locale switch). Without claiming
// ownership the way the shared runtime expects, that pass reverts the per-token
// title back to the generic page title.
function setPageTitle(text) {
	const el = document.querySelector('title');
	if (el) el.setAttribute('data-i18n-owned', '1');
	document.title = text;
}

async function main() {
	if (!mint) {
		renderLanding();
		return;
	}
	if (!isPlausibleMint(mint)) {
		setStatus('error', 'Invalid mint address', `"${mint}" is not a valid Solana mint.`, {
			href: '/coin3d',
			label: 'Try another token',
		});
		return;
	}

	setStatus('loading', 'Loading token…', 'Fetching live on-chain data.');
	let snapshot;
	try {
		snapshot = await loadSnapshot();
	} catch (err) {
		setStatus('error', "Couldn't load this token", err.message, {
			href: '/launches',
			label: 'Browse coins',
		});
		return;
	}

	if (!isKnownToken(snapshot)) {
		if (!snapshot.answered) {
			setStatus(
				'error',
				"Can't reach the data sources",
				'Every live source for this token failed to respond. Check your connection, then try again.',
				{ href: `/coin3d?mint=${encodeURIComponent(mint)}`, label: 'Retry' },
			);
			return;
		}
		setStatus('error', 'Token not found', `No on-chain data for ${mint}.`, {
			href: '/launches',
			label: 'Browse coins',
		});
		return;
	}

	// The data HUD is valuable on its own, so render it (and clear the loading
	// overlay) before the scene. If WebGL is unavailable — old device, disabled
	// in the browser, a lost context — we degrade to the HUD + live tape instead
	// of hanging on the loading spinner forever.
	renderHud(snapshot);
	setStatus(null);
	setPageTitle(`${snapshot.name}${snapshot.symbol ? ` ($${snapshot.symbol})` : ''} · 3D · three.ws`);

	let sceneOk = true;
	try {
		initScene();
		buildPulsePool();
		buildCoin(snapshot);
		buildGraduationRing(snapshot);
	} catch (err) {
		sceneOk = false;
		console.warn('[coin3d] 3D scene unavailable, falling back to data view:', err?.message || err);
		showSceneFallback();
	}

	// Async enrichment. None of these block the scene render.
	loadHolders().then((h) => applyHolders(snapshot, h, sceneOk));
	fetchOracleConviction(mint, network).then((cv) => renderOracleSlot(cv, mint));
	fetchMarket(mint).then(applyMarket);
	fetchCoinIntel(mint, network).then(applyIntel);
	startTradePolling(mint);
	// Refresh market figures periodically so price/volume stay live.
	marketTimer = setInterval(() => fetchMarket(mint).then(applyMarket), 60_000);

	// Expose the live scene for embedders and host pages (e.g. to react to the
	// loaded snapshot or drive the camera from the outside).
	window.__coin3d = { renderer, scene, camera, controls, snapshot, sceneOk };
	dispatchEvent(new CustomEvent('coin3d:ready', { detail: { snapshot, sceneOk } }));
}

// When WebGL can't render, hide the dead canvas and explain it — but the HUD,
// live tape, sparkline, and links all keep working as a data view.
function showSceneFallback() {
	if (canvas) canvas.style.display = 'none';
	const hint = document.querySelector('.hint');
	if (hint) hint.textContent = '3D unavailable. Showing live data.';
	document.body.style.background =
		'radial-gradient(120% 120% at 50% 0%, #15182c 0%, #060606 70%)';
}

addEventListener('beforeunload', () => {
	if (rafId) cancelAnimationFrame(rafId);
	if (tape.timer) clearInterval(tape.timer);
	if (marketTimer) clearInterval(marketTimer);
	renderer?.dispose?.();
});

main();
