// /play/agent-wallet — your avatar pays for a real x402 endpoint with the
// three.ws agent wallet, visualized in 3D.
//
// The scene: your /play avatar (localStorage `cc-avatar`, same contract as the
// coin-communities world) stands on a plaza with a paid-endpoint kiosk and a
// big stage board. Press Pay and the avatar walks to the kiosk while the
// agent wallet — reached through the local bridge in
// scripts/agent-wallet-x402-bridge.mjs — partially signs an SPL USDC transfer
// and the endpoint settles it on Solana mainnet. Every stage the bridge
// streams (402 → sign → submit → settled) animates the board, the kiosk, and
// the side panel in lockstep. No mocks: the $0.01 leaves the wallet for real.

import {
	Scene, PerspectiveCamera, WebGLRenderer, Group, Timer, Color, FogExp2,
	HemisphereLight, DirectionalLight, Mesh, MeshStandardMaterial, MeshBasicMaterial,
	CircleGeometry, BoxGeometry, PlaneGeometry, RingGeometry, CylinderGeometry,
	CanvasTexture, SRGBColorSpace, DoubleSide, GridHelper, Vector3, MathUtils,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import {
	buildAvatar, resolveAvatarUrl, loadManifest, getEmoteDefs, playEmoteClip,
	newAnim, CLIP_IDLE, CLIP_WALK,
} from './game/avatar-rig.js';
import { CC_AVATAR_KEY } from './game/play-handoff.js';
import { applyCinematicDefaults, loadEnvironment, detectQualityTier } from './shared/cinematic-render.js';

// ── config ──────────────────────────────────────────────────────────────────

const params = new URLSearchParams(location.search);
// The local bridge (scripts/agent-wallet-x402-bridge.mjs) holds a signing key in
// a developer's terminal, so it only runs on localhost. In production we use the
// hosted bridge (api/agent-wallet-bridge) which signs with the platform-held
// payer wallet — gated behind sign-in + spending caps — so real visitors can pay
// too. Prefer an explicit ?bridge= override, then a local dev bridge, else hosted.
function localBridgeUrl() {
	const explicit = params.get('bridge');
	if (explicit) return explicit.replace(/\/$/, '');
	let isDev = false;
	try { isDev = import.meta?.env?.DEV === true; } catch (_) {}
	const host = typeof location !== 'undefined' ? location.hostname : '';
	const isLocalHost = host === 'localhost' || host === '127.0.0.1';
	return isDev || isLocalHost ? 'http://127.0.0.1:4402' : '';
}
const LOCAL_BRIDGE = localBridgeUrl();
const HOSTED = !LOCAL_BRIDGE;
const BRIDGE_BASE = LOCAL_BRIDGE || '/api/agent-wallet-bridge';
const statusUrl = () => (HOSTED ? `${BRIDGE_BASE}?status=1` : `${BRIDGE_BASE}/status`);
const quoteUrl = (qs) => (HOSTED ? `${BRIDGE_BASE}?quote=1&${qs}` : `${BRIDGE_BASE}/quote?${qs}`);
const payUrl = () => (HOSTED ? `${BRIDGE_BASE}?pay=1` : `${BRIDGE_BASE}/pay`);
// The paid endpoint the avatar buys from. three.ws prod by default so the
// payment settles against the live facilitator even from local dev.
const ENDPOINT = params.get('endpoint') || 'https://three.ws/api/x402/crypto-intel';
const TOPICS = [
	{ id: 'bitcoin', label: 'BTC' },
	{ id: 'ethereum', label: 'ETH' },
	{ id: 'solana', label: 'SOL' },
];

const COL = {
	bg0: '#0a0a0c', bg1: '#15151a',
	text: '#f5f5f6', dim: '#8c8c92', faint: '#5a5a60',
	acc: '#9945ff', accLt: '#b88aff',
	good: '#5fd08a', bad: '#e06c75',
	line: 'rgba(255,255,255,0.07)',
};

const STAGES = [
	{ id: 'walk', label: 'Avatar walks to the endpoint' },
	{ id: 'challenge', label: '402 challenge received' },
	{ id: 'signing', label: 'Agent wallet signs' },
	{ id: 'submitting', label: 'Submit + settle on Solana' },
	{ id: 'done', label: 'Confirmed on-chain' },
];
const BOARD_STEPS = [
	{ id: 'walk', label: 'Walk' },
	{ id: 'challenge', label: '402' },
	{ id: 'signing', label: 'Sign' },
	{ id: 'submitting', label: 'Settle' },
	{ id: 'done', label: 'Paid' },
];

function fmtUsdc(micros) {
	const n = Number(micros);
	return '$' + (isFinite(n) && n > 0 ? (n / 1e6).toFixed(2) : '0.00');
}
function shortAddr(a) {
	const s = String(a || '');
	return s.length > 11 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s || '—';
}
function shortTx(tx) {
	const s = String(tx || '');
	return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}

// ── 3D scene ────────────────────────────────────────────────────────────────

const stageEl = document.getElementById('stage3d');
const scene = new Scene();
scene.background = new Color(COL.bg0);
scene.fog = new FogExp2(0x0a0a0c, 0.055);

const camera = new PerspectiveCamera(46, 1, 0.1, 80);
camera.position.set(-1.6, 2.5, 6.4);

const renderer = new WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
// Cinematic defaults (ACES tone mapping, sRGB output, VSM soft shadows,
// pixel-ratio cap) shared with every other viewer on the platform.
const qualityTier = detectQualityTier();
applyCinematicDefaults(renderer, { exposure: 1.15, tier: qualityTier });
loadEnvironment(renderer, scene, qualityTier === 'mobile' ? null : 'studio');
stageEl.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0.6, 1.0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 2.5;
controls.maxDistance = 14;
controls.maxPolarAngle = Math.PI * 0.495;
let hintFaded = false;
controls.addEventListener('start', () => {
	if (!hintFaded) { hintFaded = true; document.getElementById('sceneHint').classList.add('fade'); }
});

scene.add(new HemisphereLight(0x9aa6c0, 0x101014, 1.1));
const sun = new DirectionalLight(0xfff2e0, 2.2);
sun.position.set(5, 8, 4);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = -8; sun.shadow.camera.right = 8;
sun.shadow.camera.top = 8; sun.shadow.camera.bottom = -8;
scene.add(sun);

const ground = new Mesh(
	new CircleGeometry(16, 56),
	new MeshStandardMaterial({ color: 0x121215, roughness: 0.95, metalness: 0 }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const grid = new GridHelper(32, 64, 0x26262c, 0x1b1b20);
grid.position.y = 0.002;
scene.add(grid);

// ── kiosk: the paid endpoint, physically in the world ───────────────────────

const KIOSK_POS = new Vector3(2.4, 0, 0);
const kiosk = new Group();
kiosk.position.copy(KIOSK_POS);
kiosk.rotation.y = -Math.PI / 2.6; // face the avatar spawn
scene.add(kiosk);

const kioskMat = new MeshStandardMaterial({ color: 0x17171b, roughness: 0.35, metalness: 0.7 });
const pedestal = new Mesh(new BoxGeometry(0.85, 1.05, 0.4), kioskMat);
pedestal.position.y = 0.525;
pedestal.castShadow = true;
kiosk.add(pedestal);

const kioskCanvas = document.createElement('canvas');
kioskCanvas.width = 512; kioskCanvas.height = 320;
const kioskCtx = kioskCanvas.getContext('2d');
const kioskTex = new CanvasTexture(kioskCanvas);
kioskTex.colorSpace = SRGBColorSpace;
const kioskScreen = new Mesh(
	new PlaneGeometry(1.0, 0.625),
	new MeshBasicMaterial({ map: kioskTex, toneMapped: false }),
);
kioskScreen.position.set(0, 1.38, 0.06);
kioskScreen.rotation.x = -0.16;
kiosk.add(kioskScreen);
const kioskBezel = new Mesh(new BoxGeometry(1.08, 0.71, 0.05), kioskMat);
kioskBezel.position.set(0, 1.38, 0.02);
kioskBezel.rotation.x = -0.16;
kioskBezel.castShadow = true;
kiosk.add(kioskBezel);

// pay ring on the floor — pulses Solana purple while a payment runs
const payRing = new Mesh(
	new RingGeometry(0.62, 0.72, 48),
	new MeshBasicMaterial({ color: COL.acc, transparent: true, opacity: 0.25, side: DoubleSide }),
);
payRing.rotation.x = -Math.PI / 2;
payRing.position.set(KIOSK_POS.x - 0.9, 0.01, KIOSK_POS.z + 0.55);
scene.add(payRing);

// antenna mast — kiosks broadcast that they're paid x402 services
const mast = new Mesh(new CylinderGeometry(0.02, 0.02, 0.5, 8), kioskMat);
mast.position.set(0.34, 1.95, 0);
kiosk.add(mast);
const beacon = new Mesh(new CylinderGeometry(0.05, 0.05, 0.07, 10), new MeshBasicMaterial({ color: COL.acc }));
beacon.position.set(0.34, 2.22, 0);
kiosk.add(beacon);

// ── stage board: the big screen narrating the payment ───────────────────────

const BOARD_W = 6, BOARD_CW = 1280, BOARD_CH = 640;
const board = new Group();
board.position.set(2.2, 0, -3.4);
board.rotation.y = -0.12;
scene.add(board);
const boardH = (BOARD_W * BOARD_CH) / BOARD_CW;
const postMat = new MeshStandardMaterial({ color: 0x141417, roughness: 0.5, metalness: 0.6 });
for (const sx of [-BOARD_W / 2 + 0.5, BOARD_W / 2 - 0.5]) {
	const post = new Mesh(new CylinderGeometry(0.09, 0.12, 2.2 + boardH, 12), postMat);
	post.position.set(sx, (2.2 + boardH) / 2, -0.08);
	post.castShadow = true;
	board.add(post);
}
const boardBezel = new Mesh(new BoxGeometry(BOARD_W + 0.3, boardH + 0.3, 0.22), new MeshStandardMaterial({ color: 0x050506, roughness: 0.4, metalness: 0.7 }));
boardBezel.position.set(0, 2.2 + boardH / 2, -0.1);
boardBezel.castShadow = true;
board.add(boardBezel);
const boardCanvas = document.createElement('canvas');
boardCanvas.width = BOARD_CW; boardCanvas.height = BOARD_CH;
const boardCtx = boardCanvas.getContext('2d');
const boardTex = new CanvasTexture(boardCanvas);
boardTex.colorSpace = SRGBColorSpace;
boardTex.anisotropy = 4;
const boardPanel = new Mesh(
	new PlaneGeometry(BOARD_W, boardH),
	new MeshBasicMaterial({ map: boardTex, toneMapped: false }),
);
boardPanel.position.set(0, 2.2 + boardH / 2, 0.02);
board.add(boardPanel);

// ── avatar ──────────────────────────────────────────────────────────────────

const SPAWN = new Vector3(-2.7, 0, 1.4);
const PAY_SPOT = new Vector3(KIOSK_POS.x - 0.9, 0, KIOSK_POS.z + 0.55);
const rig = new Group();
rig.position.copy(SPAWN);
scene.add(rig);
const anim = newAnim();
let avatarReady = false;
(async () => {
	loadManifest();
	const saved = localStorage.getItem(CC_AVATAR_KEY) || params.get('avatar') || '';
	const url = await resolveAvatarUrl(params.get('avatar') || saved);
	await buildAvatar(rig, url, anim);
	rig.lookAt(KIOSK_POS.x, 0, KIOSK_POS.z);
	avatarReady = true;
})();

// walking state machine: idle | toKiosk | toSpawn
let motion = 'idle';
let walkResolve = null;
const WALK_SPEED = 1.35;
function walkTo(target) {
	return new Promise((res) => {
		walkResolve = res;
		motion = target === PAY_SPOT ? 'toKiosk' : 'toSpawn';
		anim.crossfadeTo(CLIP_WALK, 0.22);
	});
}
function tickWalk(dt) {
	if (motion === 'idle') return;
	const target = motion === 'toKiosk' ? PAY_SPOT : SPAWN;
	const dx = target.x - rig.position.x;
	const dz = target.z - rig.position.z;
	const dist = Math.hypot(dx, dz);
	if (dist < 0.06) {
		motion = 'idle';
		anim.crossfadeTo(CLIP_IDLE, 0.25);
		rig.lookAt(KIOSK_POS.x, 0, KIOSK_POS.z);
		const r = walkResolve; walkResolve = null;
		if (r) r();
		return;
	}
	const step = Math.min(dist, WALK_SPEED * dt);
	rig.position.x += (dx / dist) * step;
	rig.position.z += (dz / dist) * step;
	const targetYaw = Math.atan2(dx, dz);
	rig.rotation.y += MathUtils.degToRad(MathUtils.radToDeg(targetYaw - rig.rotation.y + Math.PI) % 360 - 180) * Math.min(1, dt * 10);
}

// ── canvas painting ─────────────────────────────────────────────────────────

// live state shared by board + kiosk + panel
const live = {
	bridge: 'connecting',     // connecting | online | offline
	wallet: null,             // { address, mode }
	balanceUsd: null,
	quote: null,              // parsed /quote payload
	stage: null,              // active stage id while paying
	stageText: '',
	receipt: null,            // { amount, payer, payTo, tx, result }
	error: null,              // { stage, message }
	paying: false,
	sessionTotal: 0,
};
let t = 0;

function roundRect(ctx, x, y, w, h, r) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

function drawKiosk() {
	const c = kioskCtx, W = kioskCanvas.width, H = kioskCanvas.height;
	const g = c.createLinearGradient(0, 0, 0, H);
	g.addColorStop(0, COL.bg1); g.addColorStop(1, COL.bg0);
	c.fillStyle = g; c.fillRect(0, 0, W, H);
	c.strokeStyle = COL.line; c.strokeRect(1, 1, W - 2, H - 2);
	c.textAlign = 'left'; c.fillStyle = COL.faint;
	c.font = '700 22px Inter, system-ui, sans-serif';
	c.fillText('x402 PAID ENDPOINT', 28, 48);
	c.fillStyle = COL.text; c.font = '800 36px Inter, system-ui, sans-serif';
	c.fillText(live.quote?.resource?.serviceName || 'crypto-intel', 28, 100);
	c.fillStyle = COL.dim; c.font = '600 24px Inter, system-ui, sans-serif';
	c.fillText('POST /api/x402/crypto-intel', 28, 140);
	const price = live.quote ? fmtUsdc(live.quote.amount) : '…';
	c.fillStyle = COL.good; c.font = '800 52px Inter, system-ui, sans-serif';
	c.fillText(`${price} USDC`, 28, 220);
	c.fillStyle = COL.faint; c.font = '600 22px Inter, system-ui, sans-serif';
	const pulse = 0.5 + 0.5 * Math.sin(t * 3);
	if (live.paying) {
		c.fillStyle = `rgba(153,69,255,${0.5 + pulse * 0.5})`;
		c.fillText('● PAYMENT IN PROGRESS', 28, 280);
	} else if (live.receipt) {
		c.fillStyle = COL.good;
		c.fillText('✓ PAID — THANK YOU', 28, 280);
	} else {
		c.fillText('AWAITING PAYMENT · SOLANA MAINNET', 28, 280);
	}
	kioskTex.needsUpdate = true;
}

function drawBoard() {
	const c = boardCtx, W = BOARD_CW, H = BOARD_CH, padX = 48;
	const g = c.createLinearGradient(0, 0, 0, H);
	g.addColorStop(0, COL.bg1); g.addColorStop(1, COL.bg0);
	c.fillStyle = g; c.fillRect(0, 0, W, H);

	// header
	c.textAlign = 'left';
	c.fillStyle = COL.acc; c.font = '800 34px Inter, system-ui, sans-serif';
	c.fillText('THREE.WS AGENT WALLET', padX, 62);
	c.fillStyle = COL.dim; c.font = '600 19px Inter, system-ui, sans-serif';
	c.fillText('x402 MICROPAYMENTS · USDC ON SOLANA MAINNET', padX, 92);
	// wallet chip (top-right)
	c.textAlign = 'right';
	c.fillStyle = COL.text; c.font = '700 22px ui-monospace, Menlo, monospace';
	c.fillText(shortAddr(live.wallet?.address), W - padX, 58);
	c.fillStyle = COL.faint; c.font = '600 17px Inter, system-ui, sans-serif';
	c.fillText(
		live.bridge === 'online' ? `balance $${live.balanceUsd ?? '—'} · ${live.wallet?.mode || ''} wallet`
			: live.bridge === 'offline' ? 'bridge offline' : 'connecting…',
		W - padX, 86,
	);
	c.textAlign = 'left';
	c.strokeStyle = COL.line; c.beginPath(); c.moveTo(padX, 116); c.lineTo(W - padX, 116); c.stroke();

	// hero zone
	const heroY = 178;
	if (live.bridge === 'offline') {
		c.fillStyle = COL.bad; c.font = '800 38px Inter, system-ui, sans-serif';
		c.fillText('Bridge offline', padX, heroY);
		c.fillStyle = COL.dim; c.font = '600 24px Inter, system-ui, sans-serif';
		c.fillText('Run `npm run demo:agent-wallet-bridge` in the repo, then retry.', padX, heroY + 42);
	} else if (live.error) {
		c.fillStyle = COL.bad; c.font = '800 38px Inter, system-ui, sans-serif';
		c.fillText('✕ Payment failed — no funds moved', padX, heroY);
		c.fillStyle = COL.dim; c.font = '600 23px Inter, system-ui, sans-serif';
		c.fillText(String(live.error.message || '').slice(0, 88), padX, heroY + 42);
	} else if (live.paying) {
		c.fillStyle = COL.text; c.font = '800 40px Inter, system-ui, sans-serif';
		c.fillText(`Paying ${live.quote ? fmtUsdc(live.quote.amount) : ''} USDC for live crypto intel`, padX, heroY);
		c.fillStyle = COL.accLt; c.font = '600 25px Inter, system-ui, sans-serif';
		c.fillText(live.stageText || 'Working…', padX, heroY + 44);
	} else if (live.receipt) {
		c.fillStyle = COL.good; c.font = '800 40px Inter, system-ui, sans-serif';
		c.fillText(`✓ ${fmtUsdc(live.receipt.amount)} USDC settled on Solana`, padX, heroY);
		c.fillStyle = COL.dim; c.font = '600 23px ui-monospace, Menlo, monospace';
		const txLine = live.receipt.tx ? `tx ${shortTx(live.receipt.tx)}` : 'settlement confirmed';
		c.fillText(`${shortAddr(live.receipt.payer)} → ${shortAddr(live.receipt.payTo)} · ${txLine}`, padX, heroY + 42);
	} else {
		c.fillStyle = COL.text; c.font = '800 40px Inter, system-ui, sans-serif';
		c.fillText('Your avatar. Your agent wallet. A real paid API.', padX, heroY);
		c.fillStyle = COL.dim; c.font = '600 25px Inter, system-ui, sans-serif';
		c.fillText('Press “Send avatar to pay” — the agent wallet signs, Solana settles.', padX, heroY + 44);
	}

	// stepper
	const sy = 300;
	const activeIdx = live.stage ? BOARD_STEPS.findIndex((s) => s.id === live.stage) : -1;
	const colW = (W - padX * 2) / BOARD_STEPS.length;
	const pulse = 0.5 + 0.5 * Math.sin(t * 4);
	BOARD_STEPS.forEach((s, i) => {
		const x = padX + colW * i;
		const done = (activeIdx >= 0 && i < activeIdx) || (live.receipt && !live.paying);
		const isActive = i === activeIdx && live.paying;
		const errHere = live.error && i === activeIdx;
		roundRect(c, x, sy, colW - 26, 6, 3);
		c.fillStyle = errHere ? COL.bad
			: done ? COL.acc
			: isActive ? `rgba(153,69,255,${0.35 + pulse * 0.6})`
			: 'rgba(255,255,255,0.1)';
		c.fill();
		c.fillStyle = errHere ? COL.bad : done ? COL.text : isActive ? COL.accLt : COL.faint;
		c.font = '700 19px Inter, system-ui, sans-serif';
		c.fillText(s.label.toUpperCase(), x, sy + 38);
	});

	// result zone — the thing the avatar actually bought
	c.strokeStyle = COL.line; c.beginPath(); c.moveTo(padX, 392); c.lineTo(W - padX, 392); c.stroke();
	c.fillStyle = COL.faint; c.font = '700 18px Inter, system-ui, sans-serif';
	c.fillText('PURCHASED INTEL', padX, 432);
	if (live.sessionTotal > 0) {
		c.textAlign = 'right';
		c.fillStyle = COL.dim;
		c.fillText(`$${live.sessionTotal.toFixed(2)} paid this session`, W - padX, 432);
		c.textAlign = 'left';
	}
	const r = live.receipt?.result;
	if (r && r.headline) {
		const sigCol = r.signal === 'bullish' ? COL.good : r.signal === 'bearish' ? COL.bad : '#f5a623';
		c.fillStyle = sigCol; c.font = '800 26px Inter, system-ui, sans-serif';
		c.fillText((r.signal || '').toUpperCase(), padX, 482);
		c.fillStyle = COL.text; c.font = '700 30px Inter, system-ui, sans-serif';
		c.fillText(String(r.headline).slice(0, 70), padX, 524);
		c.fillStyle = COL.dim; c.font = '600 22px Inter, system-ui, sans-serif';
		c.fillText(String(r.rationale || '').slice(0, 95), padX, 560);
	} else {
		c.fillStyle = COL.faint; c.font = '600 24px Inter, system-ui, sans-serif';
		c.fillText('Nothing purchased yet — the API response lands here after settlement.', padX, 488);
	}
	boardTex.needsUpdate = true;
}

// ── render loop ─────────────────────────────────────────────────────────────

const clock = new Timer();
let redrawAcc = 0;
function resize() {
	const w = stageEl.clientWidth, h = stageEl.clientHeight;
	renderer.setSize(w, h, false);
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stageEl);
resize();

renderer.setAnimationLoop(() => {
	clock.update();
	const dt = Math.min(clock.getDelta(), 0.1);
	t += dt;
	if (avatarReady) { tickWalk(dt); anim.update(dt); }
	payRing.material.opacity = live.paying ? 0.35 + 0.3 * Math.sin(t * 5) : 0.18;
	beacon.material.color.set(live.paying ? COL.accLt : live.bridge === 'offline' ? '#5a5a60' : COL.acc);
	redrawAcc += dt;
	if (redrawAcc > 0.1) { redrawAcc = 0; drawBoard(); drawKiosk(); }
	controls.update();
	renderer.render(scene, camera);
});

// ── side panel wiring ───────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);
const payBtn = $('payBtn');
const stagesEl = $('stages');
let activeTopic = TOPICS[0].id;

for (const topic of TOPICS) {
	const b = document.createElement('button');
	b.type = 'button';
	b.className = 't-chip' + (topic.id === activeTopic ? ' active' : '');
	b.textContent = topic.label;
	b.setAttribute('aria-pressed', String(topic.id === activeTopic));
	b.addEventListener('click', () => {
		activeTopic = topic.id;
		for (const el of document.querySelectorAll('.t-chip')) {
			const on = el === b;
			el.classList.toggle('active', on);
			el.setAttribute('aria-pressed', String(on));
		}
	});
	$('topics').appendChild(b);
}

function renderStages() {
	stagesEl.innerHTML = '';
	const activeIdx = live.stage ? STAGES.findIndex((s) => s.id === live.stage) : -1;
	STAGES.forEach((s, i) => {
		const row = document.createElement('div');
		const done = (activeIdx >= 0 && i < activeIdx) || (live.receipt && !live.paying && !live.error);
		const isActive = i === activeIdx && live.paying;
		const errHere = live.error && live.error.stage === s.id;
		row.className = 'stage' + (errHere ? ' error' : done ? ' done' : isActive ? ' active' : '');
		row.innerHTML = `<span class="si"></span><span>${s.label}</span><span class="sd"></span>`;
		if (s.id === 'signing' && live.wallet?.address) row.querySelector('.sd').textContent = shortAddr(live.wallet.address);
		if (s.id === 'done' && live.receipt?.tx) row.querySelector('.sd').textContent = shortTx(live.receipt.tx);
		stagesEl.appendChild(row);
	});
}
renderStages();

function renderError() {
	const el = $('flowError');
	if (!live.error) { el.classList.remove('show'); return; }
	if (live.error.needsAuth) {
		el.innerHTML = `<div class="b-head">Sign in to pay</div>${escapeHtml(live.error.message)} <a href="/login" style="color:var(--acc);text-decoration:underline">Sign in →</a>`;
	} else {
		el.innerHTML = `<div class="b-head">Payment failed — no funds moved</div>${escapeHtml(live.error.message)}`;
	}
	el.classList.add('show');
}
function escapeHtml(s) {
	return String(s || '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function renderReceipt() {
	const el = $('receipt');
	const r = live.receipt;
	if (!r) { el.classList.remove('show'); return; }
	const res = r.result || {};
	const sigClass = res.signal === 'bullish' ? 'signal-bullish' : res.signal === 'bearish' ? 'signal-bearish' : 'signal-neutral';
	el.innerHTML = `
		<div class="r-head">
			<span class="r-badge">✓ Settled on Solana</span>
			<span class="r-amt">${fmtUsdc(r.amount)} USDC</span>
		</div>
		<div class="rf"><span class="k">From (agent wallet)</span><span class="v">${shortAddr(r.payer)}</span></div>
		<div class="rf"><span class="k">To (endpoint)</span><span class="v">${shortAddr(r.payTo)}</span></div>
		${r.tx ? `<div class="rf"><span class="k">Transaction</span><span class="v"><a href="https://solscan.io/tx/${encodeURIComponent(r.tx)}" target="_blank" rel="noopener">${shortTx(r.tx)} ↗</a></span></div>` : ''}
		${res.headline ? `<div class="r-payload"><span class="r-signal ${sigClass}">${escapeHtml((res.signal || '').toUpperCase())}</span>${escapeHtml(res.headline)}${res.rationale ? `<div style="color:var(--muted);font-size:12.5px;margin-top:4px">${escapeHtml(res.rationale)}</div>` : ''}</div>` : ''}
	`;
	el.classList.add('show');
}

function updatePayButton() {
	const lbl = payBtn.querySelector('.lbl');
	if (live.paying) {
		payBtn.disabled = true;
		payBtn.classList.add('busy');
		lbl.textContent = live.stageText || 'Paying…';
		return;
	}
	payBtn.classList.remove('busy');
	if (live.bridge !== 'online') {
		payBtn.disabled = true;
		lbl.textContent = live.bridge === 'offline' ? 'Bridge offline' : 'Connecting to bridge…';
		return;
	}
	payBtn.disabled = false;
	lbl.textContent = `Send avatar to pay — ${live.quote ? fmtUsdc(live.quote.amount) : '$0.01'} USDC`;
}

// ── bridge client ───────────────────────────────────────────────────────────

async function refreshStatus() {
	try {
		const r = await fetch(statusUrl(), { signal: AbortSignal.timeout(8000) });
		if (!r.ok) throw new Error('HTTP ' + r.status);
		const data = await r.json();
		live.bridge = 'online';
		live.wallet = data.wallet;
		live.balanceUsd = data.balance?.totalValue ?? null;
		$('wAddr').textContent = shortAddr(data.wallet.address);
		$('wAddr').title = data.wallet.address;
		$('wMode').textContent = `${data.wallet.mode} wallet`;
		$('wBal').innerHTML = `$${escapeHtml(Number(data.balance?.totalValue || 0).toFixed(2))}<small>USD</small>`;
		$('bridgeOffline').classList.remove('show');
		const lowBal = Number(data.balance?.totalValue || 0) <= 0;
		$('lowBalance').classList.toggle('show', lowBal && !live.receipt);
	} catch {
		live.bridge = 'offline';
		$('bridgeOffline').classList.add('show');
		$('lowBalance').classList.remove('show');
		$('wBal').innerHTML = '—<small>USD</small>';
	}
	updatePayButton();
	renderStages();
}

async function loadQuote() {
	try {
		const qs = new URLSearchParams({ endpoint: ENDPOINT, method: 'POST', body: JSON.stringify({ topic: activeTopic }) });
		const r = await fetch(quoteUrl(qs.toString()), { signal: AbortSignal.timeout(8000) });
		if (!r.ok) throw new Error('HTTP ' + r.status);
		const q = await r.json();
		if (!q.ok) throw new Error(q.error || 'quote failed');
		live.quote = q;
		$('epName').textContent = q.resource?.serviceName || 'three.ws Crypto Intel';
		$('epPrice').textContent = `${fmtUsdc(q.amount)} USDC`;
		$('epDesc').textContent = q.resource?.description
			? String(q.resource.description).split('. ').slice(0, 2).join('. ') + '.'
			: 'Pay-per-call market signal, settled in USDC on Solana mainnet.';
		const tags = $('epTags');
		tags.innerHTML = '';
		for (const tag of [`pay to ${shortAddr(q.payTo)}`, 'Solana mainnet', 'SPL USDC', ...(q.resource?.tags || []).slice(0, 2)]) {
			const el = document.createElement('span');
			el.className = 'ep-tag';
			el.textContent = tag;
			tags.appendChild(el);
		}
	} catch {
		// quote requires the bridge; the bridge-offline banner already explains
		$('epName').textContent = 'three.ws Crypto Intel';
		$('epPrice').textContent = '$0.01 USDC';
		$('epDesc').textContent = 'Live market signal (bullish / bearish / neutral) — pay per call, settled in USDC on Solana mainnet.';
	}
	updatePayButton();
}

async function pay() {
	if (live.paying || live.bridge !== 'online') return;
	live.paying = true;
	live.error = null;
	live.receipt = null;
	live.stage = 'walk';
	live.stageText = 'Avatar walking to the endpoint…';
	renderError(); renderReceipt(); renderStages(); updatePayButton();

	// the walk is part of the show — arrive, then start the real payment
	await walkTo(PAY_SPOT);

	try {
		const res = await fetch(payUrl(), {
			method: 'POST',
			headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
			body: JSON.stringify({ endpoint: ENDPOINT, method: 'POST', body: { topic: activeTopic } }),
		});
		if (res.status === 401) {
			// Hosted bridge: real spend needs a signed-in session.
			live.error = { stage: 'challenge', message: 'Sign in to let your agent wallet make a real payment.', needsAuth: true };
			throw new Error('auth required');
		}
		if (res.status === 429) {
			live.error = { stage: 'challenge', message: 'Too many payment attempts — try again in a moment.' };
			throw new Error('rate limited');
		}
		if (!res.ok || !res.body) throw new Error(`bridge /pay failed: HTTP ${res.status}`);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const lines = buf.split('\n');
			buf = lines.pop() || '';
			for (const line of lines) {
				if (!line.startsWith('data:')) continue;
				let evt;
				try { evt = JSON.parse(line.slice(5)); } catch { continue; }
				handleStageEvent(evt);
			}
		}
		if (live.paying && !live.receipt && !live.error) {
			throw new Error('payment stream ended without a settlement');
		}
	} catch (err) {
		// Keep a more specific error (e.g. needs-auth / rate-limited) if one was set.
		if (!live.error) live.error = { stage: live.stage || 'challenge', message: err.message };
	} finally {
		live.paying = false;
	}
	renderError(); renderReceipt(); renderStages(); updatePayButton();
	refreshStatus();

	// celebrate a settle, then amble home either way
	if (live.receipt && avatarReady) {
		const emote = getEmoteDefs()[0];
		if (emote) await playEmoteClip(anim, emote.name, 'idle');
		await new Promise((r) => setTimeout(r, 1800));
	}
	await walkTo(SPAWN);
}

function handleStageEvent(evt) {
	switch (evt.stage) {
		case 'challenge':
			live.stage = 'challenge';
			live.stageText = `402 challenge: ${fmtUsdc(evt.amount)} USDC to ${shortAddr(evt.payTo)}`;
			break;
		case 'signing':
			live.stage = 'signing';
			live.stageText = `Agent wallet ${shortAddr(evt.signer)} signing the USDC transfer…`;
			break;
		case 'signed':
			live.stage = 'submitting';
			live.stageText = 'Transaction signed — submitting X-PAYMENT…';
			break;
		case 'submitting':
			live.stage = 'submitting';
			live.stageText = 'Endpoint verifying + settling via facilitator…';
			break;
		case 'done': {
			live.stage = 'done';
			live.stageText = 'Settled on Solana mainnet';
			live.receipt = {
				amount: evt.amount,
				payer: evt.payer,
				payTo: evt.payTo,
				tx: evt.settlement?.transaction || null,
				result: evt.result || null,
			};
			live.sessionTotal += Number(evt.amount) / 1e6 || 0;
			break;
		}
		case 'error':
			live.error = { stage: evt.failedStage === 'done' ? 'submitting' : evt.failedStage || 'challenge', message: evt.message };
			break;
	}
	renderStages();
	updatePayButton();
}

payBtn.addEventListener('click', pay);
$('retryBridge').addEventListener('click', () => { refreshStatus().then(loadQuote); });
$('copyAddr').addEventListener('click', async () => {
	const full = $('wAddr').title;
	if (!full) return;
	try {
		await navigator.clipboard.writeText(full);
		$('copyAddr').textContent = 'copied';
		setTimeout(() => { $('copyAddr').textContent = 'copy'; }, 1200);
	} catch { /* clipboard unavailable */ }
});

// In local-bridge mode, surface the dev hint inside the unavailable banner so a
// developer knows to start the bridge; in hosted prod mode it stays hidden.
if (!HOSTED) { const hint = $('bridgeDevHint'); if (hint) hint.style.display = 'block'; }

refreshStatus().then(loadQuote);
setInterval(refreshStatus, 30_000);
