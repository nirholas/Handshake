// three.ws agent economy demo scene
// Two 3D AI agents (NOVA + ORACLE) exchange a real x402 payment in a stylized
// world. The TV screen between them shows the live Solana market briefing
// delivered after the transaction confirms.

import * as THREE from 'three';

// ─── Constants ─────────────────────────────────────────────────────────────

const NOVA_COLOR = new THREE.Color(0x4e8cff);
const ORACLE_COLOR = new THREE.Color(0x22d17a);
const TV_W = 3.6;
const TV_H = 2.0;
const TV_Z = -5;
const AGENT_Y = 0;
const NOVA_X = -3.8;
const ORACLE_X = 3.8;

// ─── Scene setup ────────────────────────────────────────────────────────────

export function createScene(canvas) {
	const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
	renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
	// `false` keeps three.js from writing inline px width/height onto the canvas.
	// With inline sizes the canvas stops obeying its `width:100%` CSS, so it can
	// never shrink again: the ResizeObserver below watches an element whose size
	// three.js just pinned, so it never fires and the scene stays clipped at its
	// widest observed size on every narrower viewport.
	const viewport = canvas.parentElement || canvas;
	renderer.setSize(viewport.clientWidth, viewport.clientHeight, false);
	renderer.toneMapping = THREE.ACESFilmicToneMapping;
	renderer.toneMappingExposure = 0.95;
	renderer.outputColorSpace = THREE.SRGBColorSpace;

	const scene = new THREE.Scene();
	scene.background = new THREE.Color(0x05070d);
	scene.fog = new THREE.FogExp2(0x05070d, 0.08);

	const camera = new THREE.PerspectiveCamera(48, viewport.clientWidth / viewport.clientHeight, 0.1, 100);
	camera.position.set(0, 2.8, 8);
	camera.lookAt(0, 1.2, 0);

	// NOVA and ORACLE stand 7.6 world units apart, so a portrait viewport frames
	// empty floor between two off-screen agents unless the camera pulls back.
	// Dolly by the horizontal shortfall instead of widening the FOV, which keeps
	// the perspective identical on phone and desktop.
	function frameCamera(aspect) {
		const halfV = Math.tan((camera.fov * Math.PI) / 360);
		const needed = 4.6 / Math.max(halfV * Math.max(aspect, 0.2), 0.001);
		camera.position.set(0, 2.8, Math.max(8, Math.min(needed, 20)));
		camera.lookAt(0, 1.2, 0);
	}

	// ── Lights ──────────────────────────────────────────────────────────────
	const ambient = new THREE.AmbientLight(0xffffff, 0.15);
	scene.add(ambient);

	const rimNova = new THREE.PointLight(NOVA_COLOR, 2.5, 8);
	rimNova.position.set(NOVA_X, 2, 1);
	scene.add(rimNova);

	const rimOracle = new THREE.PointLight(ORACLE_COLOR, 2.5, 8);
	rimOracle.position.set(ORACLE_X, 2, 1);
	scene.add(rimOracle);

	const tvLight = new THREE.RectAreaLight(0xffffff, 1.5, TV_W, TV_H);
	tvLight.position.set(0, 1.4, TV_Z + 0.3);
	tvLight.lookAt(0, 1.4, 0);
	scene.add(tvLight);

	// ── Ground ───────────────────────────────────────────────────────────────
	const gridHelper = new THREE.GridHelper(20, 20, 0x1a1c2e, 0x0f1020);
	gridHelper.position.y = -0.01;
	scene.add(gridHelper);

	const ground = new THREE.Mesh(
		new THREE.PlaneGeometry(40, 40),
		new THREE.MeshStandardMaterial({ color: 0x07080f, roughness: 1, metalness: 0 }),
	);
	ground.rotation.x = -Math.PI / 2;
	ground.position.y = -0.02;
	scene.add(ground);

	// ── Agents ───────────────────────────────────────────────────────────────
	const nova = createAgent(scene, NOVA_X, AGENT_Y, NOVA_COLOR, 'NOVA');
	const oracle = createAgent(scene, ORACLE_X, AGENT_Y, ORACLE_COLOR, 'ORACLE');

	// ── TV Screen ────────────────────────────────────────────────────────────
	const tv = createTV(scene);

	// ── Payment beam (initially invisible) ──────────────────────────────────
	const beam = createBeam(scene);

	// ── Resize observer ──────────────────────────────────────────────────────
	const ro = new ResizeObserver(() => {
		const w = viewport.clientWidth, h = viewport.clientHeight;
		if (!w || !h) return;
		renderer.setSize(w, h, false);
		camera.aspect = w / h;
		frameCamera(camera.aspect);
		camera.updateProjectionMatrix();
	});
	ro.observe(viewport);
	frameCamera(camera.aspect);
	camera.updateProjectionMatrix();

	// ── Render loop ──────────────────────────────────────────────────────────
	// Paused while the tab is hidden: this scene redraws a full canvas texture
	// every frame, and there is no reason to burn a background tab's GPU on a TV
	// nobody is looking at.
	let raf = 0;
	let t = 0;
	function tick() {
		raf = requestAnimationFrame(tick);
		t += 0.016;

		nova.tick(t);
		oracle.tick(t);
		beam.tick(t);
		tv.tick(t);

		renderer.render(scene, camera);
	}
	function start() {
		if (!raf) tick();
	}
	function stop() {
		cancelAnimationFrame(raf);
		raf = 0;
	}
	const onVisibility = () => (document.hidden ? stop() : start());
	document.addEventListener('visibilitychange', onVisibility);
	start();

	return {
		nova,
		oracle,
		tv,
		beam,
		dispose() {
			stop();
			document.removeEventListener('visibilitychange', onVisibility);
			ro.disconnect();
			renderer.dispose();
		},
	};
}

// ─── Agent figure ──────────────────────────────────────────────────────────

function createAgent(scene, x, y, color, name) {
	const group = new THREE.Group();
	group.position.set(x, y, 0);
	scene.add(group);

	// Body — tapered capsule shape
	const bodyMat = new THREE.MeshStandardMaterial({
		color,
		roughness: 0.35,
		metalness: 0.6,
		emissive: color,
		emissiveIntensity: 0.08,
	});
	const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.9, 6, 12), bodyMat);
	body.position.y = 0.9;
	group.add(body);

	// Head
	const headMat = new THREE.MeshStandardMaterial({
		color: 0xd0d8f0,
		roughness: 0.4,
		metalness: 0.3,
		emissive: color,
		emissiveIntensity: 0.04,
	});
	const head = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 16), headMat);
	head.position.y = 1.78;
	group.add(head);

	// Eyes
	const eyeMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1 });
	[-0.08, 0.08].forEach((ex) => {
		const eye = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), eyeMat);
		eye.position.set(ex, 1.81, 0.21);
		group.add(eye);
	});

	// Glow halo ring at feet
	const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, side: THREE.DoubleSide });
	const ring = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.5, 32), ringMat);
	ring.rotation.x = -Math.PI / 2;
	ring.position.y = 0.01;
	group.add(ring);

	// Particle aura (6 floating orbs)
	const orbs = [];
	for (let i = 0; i < 6; i++) {
		const orb = new THREE.Mesh(
			new THREE.SphereGeometry(0.035, 6, 6),
			new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55 }),
		);
		group.add(orb);
		orbs.push({ mesh: orb, phase: (i / 6) * Math.PI * 2, r: 0.52 + (i % 2) * 0.1, hy: 0.9 + (i % 3) * 0.35 });
	}

	let state = 'idle'; // idle | active | paying | done
	let pulseT = 0;
	let bobDir = 1;

	function tick(t) {
		// Gentle idle bob
		const bob = Math.sin(t * 1.4 + (x > 0 ? Math.PI : 0)) * 0.04;
		body.position.y = 0.9 + bob;
		head.position.y = 1.78 + bob;

		// Orb orbit
		orbs.forEach(({ mesh, phase, r, hy }) => {
			const a = t * 1.1 + phase;
			mesh.position.set(Math.cos(a) * r, hy + Math.sin(t * 0.7 + phase) * 0.12, Math.sin(a) * r * 0.5);
		});

		// Ring pulse
		if (state === 'paying') {
			pulseT += 0.04;
			ringMat.opacity = 0.18 + Math.sin(pulseT * 8) * 0.12;
			bodyMat.emissiveIntensity = 0.25 + Math.sin(pulseT * 8) * 0.15;
		} else if (state === 'done') {
			ringMat.opacity = 0.35;
			bodyMat.emissiveIntensity = 0.3;
		} else {
			ringMat.opacity = 0.18;
			bodyMat.emissiveIntensity = 0.08;
		}
	}

	return {
		group,
		setState(s) { state = s; },
		tick,
	};
}

// ─── TV screen with canvas texture ─────────────────────────────────────────

function createTV(scene) {
	const CW = 1280, CH = 720;
	const canvas = document.createElement('canvas');
	canvas.width = CW;
	canvas.height = CH;
	const ctx = canvas.getContext('2d');

	const texture = new THREE.CanvasTexture(canvas);
	texture.colorSpace = THREE.SRGBColorSpace;

	// Frame / bezel
	const frameMat = new THREE.MeshStandardMaterial({ color: 0x0a0c14, roughness: 0.8, metalness: 0.9 });
	const frame = new THREE.Mesh(new THREE.BoxGeometry(TV_W + 0.16, TV_H + 0.12, 0.08), frameMat);
	frame.position.set(0, 1.4, TV_Z);
	scene.add(frame);

	// Screen
	const screenMat = new THREE.MeshBasicMaterial({ map: texture });
	const screen = new THREE.Mesh(new THREE.PlaneGeometry(TV_W, TV_H), screenMat);
	screen.position.set(0, 1.4, TV_Z + 0.05);
	scene.add(screen);

	// Support post
	const post = new THREE.Mesh(
		new THREE.BoxGeometry(0.08, 1.4, 0.08),
		new THREE.MeshStandardMaterial({ color: 0x0d0f1a, roughness: 0.9 }),
	);
	post.position.set(0, 0.05, TV_Z);
	scene.add(post);

	let phase = 'idle'; // idle | browsing | paying | content
	let briefing = null;
	let services = null;
	// The settled transfer, as reported by the SSE `payment` event. The TV used
	// to print a hardcoded "PAID 0.001 SOL" badge, which contradicted both the
	// real amount and the simulated runs that move no funds at all.
	let payment = null;
	let scrollY = 0;
	let animT = 0;

	function draw(t) {
		ctx.clearRect(0, 0, CW, CH);

		// Background
		const bg = ctx.createLinearGradient(0, 0, 0, CH);
		bg.addColorStop(0, '#06080f');
		bg.addColorStop(1, '#0a0d18');
		ctx.fillStyle = bg;
		ctx.fillRect(0, 0, CW, CH);

		if (phase === 'idle') drawIdle(ctx, CW, CH, t);
		else if (phase === 'browsing') drawBazaar(ctx, CW, CH, services, t);
		else if (phase === 'paying') drawPaying(ctx, CW, CH, t);
		else if (phase === 'content') drawContent(ctx, CW, CH, briefing, payment, t);

		texture.needsUpdate = true;
	}

	function tick(t) {
		animT = t;
		draw(t);
	}

	return {
		tick,
		setPhase(p) { phase = p; },
		setServices(s) { services = s; },
		setBriefing(b) { briefing = b; },
		setPayment(p) { payment = p; },
	};
}

// ── TV draw functions ──────────────────────────────────────────────────────

function drawIdle(ctx, W, H, t) {
	ctx.save();
	// Scanline effect
	for (let y = 0; y < H; y += 4) {
		ctx.fillStyle = `rgba(255,255,255,${0.012 + 0.005 * Math.sin(t * 0.4 + y * 0.02)})`;
		ctx.fillRect(0, y, W, 1);
	}
	// Center logo
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillStyle = 'rgba(78,140,255,0.15)';
	ctx.font = 'bold 120px -apple-system,system-ui,sans-serif';
	ctx.fillText('three.ws', W / 2, H / 2 - 40);
	ctx.fillStyle = 'rgba(255,255,255,0.25)';
	ctx.font = '32px -apple-system,system-ui,sans-serif';
	ctx.fillText('agent economy', W / 2, H / 2 + 40);
	// Blinking cursor
	if (Math.floor(t * 2) % 2 === 0) {
		ctx.fillStyle = 'rgba(78,140,255,0.6)';
		ctx.fillRect(W / 2 - 6, H / 2 + 90, 12, 3);
	}
	ctx.restore();
}

function drawBazaar(ctx, W, H, data, t) {
	if (!data) return;
	// Accept either a bare array (legacy) or { services, bazaarAvailable }.
	const list = Array.isArray(data) ? data : (data.services || []);
	const bazaarAvailable = Array.isArray(data) ? true : data.bazaarAvailable !== false;
	if (!list.length) return;
	ctx.save();
	ctx.textAlign = 'left';

	// Header
	ctx.fillStyle = '#4e8cff';
	ctx.font = 'bold 38px -apple-system,system-ui,sans-serif';
	ctx.fillText('x402 Bazaar', 60, 70);
	ctx.fillStyle = bazaarAvailable ? 'rgba(255,255,255,0.3)' : 'rgba(240,160,48,0.65)';
	ctx.font = '26px -apple-system,system-ui,sans-serif';
	ctx.fillText(
		bazaarAvailable
			? 'Available services · Coinbase network'
			: 'Live bazaar unavailable · showing the three.ws service',
		60, 110,
	);

	// Divider
	ctx.strokeStyle = 'rgba(78,140,255,0.3)';
	ctx.lineWidth = 2;
	ctx.beginPath();
	ctx.moveTo(60, 130);
	ctx.lineTo(W - 60, 130);
	ctx.stroke();

	// Service rows
	const rowH = 110;
	list.slice(0, 4).forEach((svc, i) => {
		const y = 160 + i * rowH;
		const highlight = i === 0 && Math.sin(t * 3) > 0;

		// Row bg
		ctx.fillStyle = highlight ? 'rgba(78,140,255,0.12)' : 'rgba(255,255,255,0.04)';
		roundRect(ctx, 50, y - 14, W - 100, rowH - 10, 14);
		ctx.fill();

		if (highlight) {
			ctx.strokeStyle = 'rgba(78,140,255,0.5)';
			ctx.lineWidth = 2;
			roundRect(ctx, 50, y - 14, W - 100, rowH - 10, 14);
			ctx.stroke();
		}

		// Dot
		ctx.fillStyle = i === 0 ? '#4e8cff' : '#22d17a';
		circle(ctx, 90, y + 26, 8);
		ctx.fill();

		// Name
		ctx.fillStyle = '#e8e9f2';
		ctx.font = `bold 30px -apple-system,system-ui,sans-serif`;
		ctx.fillText((svc.name || '').slice(0, 50), 116, y + 14);

		// Price badge
		const priceTxt = svc.price || '—';
		ctx.fillStyle = 'rgba(34,209,122,0.18)';
		const pw = ctx.measureText(priceTxt).width + 28;
		roundRect(ctx, W - 80 - pw, y, pw, 38, 10);
		ctx.fill();
		ctx.fillStyle = '#22d17a';
		ctx.font = 'bold 24px -apple-system,system-ui,monospace';
		ctx.textAlign = 'right';
		ctx.fillText(priceTxt, W - 90, y + 28);
		ctx.textAlign = 'left';

		// Network
		ctx.fillStyle = 'rgba(255,255,255,0.35)';
		ctx.font = '22px -apple-system,system-ui,sans-serif';
		ctx.fillText(svc.network || '', 116, y + 55);
	});

	ctx.restore();
}

function drawPaying(ctx, W, H, t) {
	ctx.save();
	ctx.textAlign = 'center';

	// Animated rings
	for (let ring = 0; ring < 4; ring++) {
		const phase = (t * 1.8 + ring * 0.4) % (Math.PI * 2);
		const r = 60 + ring * 55 + Math.sin(phase) * 20;
		ctx.strokeStyle = `rgba(78,140,255,${0.25 - ring * 0.05})`;
		ctx.lineWidth = 3 - ring * 0.5;
		ctx.beginPath();
		ctx.arc(W / 2, H / 2 - 30, r, 0, Math.PI * 2);
		ctx.stroke();
	}

	// Core dot
	const pulse = 0.8 + Math.sin(t * 5) * 0.2;
	ctx.fillStyle = '#4e8cff';
	circle(ctx, W / 2, H / 2 - 30, 22 * pulse);
	ctx.fill();

	ctx.fillStyle = '#ffffff';
	ctx.font = 'bold 48px -apple-system,system-ui,sans-serif';
	ctx.fillText('NOVA → ORACLE', W / 2, H / 2 + 80);

	ctx.fillStyle = 'rgba(34,209,122,0.9)';
	ctx.font = '34px -apple-system,system-ui,monospace';
	ctx.fillText('0.001 SOL · Solana mainnet', W / 2, H / 2 + 130);

	// Moving dots along transfer path
	for (let d = 0; d < 6; d++) {
		const px = ((t * 0.6 + d * 0.16) % 1);
		const dx = -W * 0.3 + px * W * 0.6;
		ctx.fillStyle = `rgba(78,140,255,${1 - Math.abs(px - 0.5) * 1.5})`;
		circle(ctx, W / 2 + dx, H / 2 - 30, 5);
		ctx.fill();
	}

	ctx.restore();
}

function drawContent(ctx, W, H, briefing, payment, t) {
	if (!briefing) return;
	if (briefing.type === 'market_unavailable' || !briefing.headline) {
		drawMarketUnavailable(ctx, W, H, t);
		return;
	}
	ctx.save();

	// Scanlines
	for (let y = 0; y < H; y += 3) {
		ctx.fillStyle = `rgba(34,209,122,${0.018})`;
		ctx.fillRect(0, y, W, 1);
	}

	// Header bar
	const hg = ctx.createLinearGradient(0, 0, W, 0);
	hg.addColorStop(0, 'rgba(34,209,122,0.18)');
	hg.addColorStop(1, 'rgba(34,209,122,0.04)');
	ctx.fillStyle = hg;
	ctx.fillRect(0, 0, W, 100);

	ctx.fillStyle = '#22d17a';
	ctx.font = 'bold 30px -apple-system,system-ui,sans-serif';
	ctx.textAlign = 'left';
	ctx.fillText('ORACLE · LIVE MARKET BRIEFING', 50, 38);

	// Timestamp, and whether this is a fresh read or the last-known-good copy the
	// API serves when the upstream market feed is throttled.
	const stale = briefing.stale === true;
	const stamp = stale ? briefing.as_of || briefing.fetchedAt : briefing.fetchedAt;
	const ts = stamp ? new Date(stamp).toLocaleTimeString() : '';
	ctx.fillStyle = stale ? 'rgba(240,160,48,0.75)' : 'rgba(255,255,255,0.4)';
	ctx.font = '22px -apple-system,system-ui,sans-serif';
	ctx.textAlign = 'right';
	ctx.fillText(ts ? (stale ? `cached ${ts}` : `fetched ${ts}`) : '', W - 50, 38);

	// Settlement badge, driven by the real payment event. A simulated run says so
	// rather than claiming an on-chain payment that never happened.
	const simulated = payment?.simulated === true;
	const amount = payment?.amount_sol ? `${payment.amount_sol} SOL` : '';
	const badge = simulated
		? `SIMULATED · ${amount || 'no funds moved'}`
		: `✓ PAID · ${amount || 'on-chain'}`;
	ctx.font = 'bold 22px -apple-system,system-ui,sans-serif';
	const badgeW = Math.max(180, ctx.measureText(badge).width + 34);
	ctx.fillStyle = simulated ? 'rgba(240,160,48,0.2)' : 'rgba(34,209,122,0.2)';
	roundRect(ctx, W - 50 - badgeW, 54, badgeW, 36, 10);
	ctx.fill();
	ctx.fillStyle = simulated ? '#f0a030' : '#22d17a';
	ctx.textAlign = 'center';
	ctx.fillText(badge, W - 50 - badgeW / 2, 78);

	// Headline
	ctx.textAlign = 'left';
	ctx.fillStyle = '#ffffff';
	ctx.font = 'bold 36px -apple-system,system-ui,sans-serif';
	wrapText(ctx, briefing.headline || '', 50, 150, W - 100, 46);

	// Divider
	ctx.strokeStyle = 'rgba(34,209,122,0.25)';
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(50, 220);
	ctx.lineTo(W - 50, 220);
	ctx.stroke();

	// Token rows
	const pools = briefing.pools || [];
	const colW = (W - 120) / Math.min(pools.length, 5);
	pools.slice(0, 5).forEach((p, i) => {
		const x = 60 + i * colW;
		const y = 255;

		// Card bg
		ctx.fillStyle = p.up ? 'rgba(34,209,122,0.08)' : 'rgba(255,99,99,0.08)';
		roundRect(ctx, x - 4, y - 10, colW - 20, 200, 12);
		ctx.fill();

		// Name
		ctx.fillStyle = 'rgba(255,255,255,0.6)';
		ctx.font = '20px -apple-system,system-ui,sans-serif';
		ctx.textAlign = 'left';
		const nameParts = (p.name || '').split('/');
		ctx.fillText(nameParts[0] || p.name, x, y + 18);
		if (nameParts[1]) {
			ctx.fillStyle = 'rgba(255,255,255,0.3)';
			ctx.fillText('/' + nameParts[1], x + ctx.measureText(nameParts[0]).width + 2, y + 18);
		}

		// Price
		ctx.fillStyle = '#ffffff';
		ctx.font = `bold 28px -apple-system,system-ui,monospace`;
		ctx.fillText('$' + p.price, x, y + 66);

		// Change pill
		const changeColor = p.up ? '#22d17a' : '#ff6363';
		ctx.fillStyle = p.up ? 'rgba(34,209,122,0.2)' : 'rgba(255,99,99,0.2)';
		roundRect(ctx, x, y + 82, 100, 34, 8);
		ctx.fill();
		ctx.fillStyle = changeColor;
		ctx.font = 'bold 22px -apple-system,system-ui,sans-serif';
		ctx.fillText(p.change24h, x + 8, y + 106);

		// Vol
		ctx.fillStyle = 'rgba(255,255,255,0.35)';
		ctx.font = '20px -apple-system,system-ui,sans-serif';
		ctx.fillText('Vol ' + p.vol24h, x, y + 148);
	});

	// Flicker vignette
	ctx.fillStyle = `rgba(0,0,0,${0.08 + Math.sin(t * 0.7) * 0.03})`;
	ctx.fillRect(0, 0, W, H);

	ctx.restore();
}

// The market feed is a live third party. When it does not answer, the API says
// so explicitly instead of inventing prices, and the TV has to render that
// answer as a designed screen rather than an empty briefing frame.
function drawMarketUnavailable(ctx, W, H, t) {
	ctx.save();
	for (let y = 0; y < H; y += 3) {
		ctx.fillStyle = 'rgba(240,160,48,0.014)';
		ctx.fillRect(0, y, W, 1);
	}
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	ctx.fillStyle = 'rgba(240,160,48,0.85)';
	ctx.font = 'bold 44px -apple-system,system-ui,sans-serif';
	ctx.fillText('Market feed unavailable', W / 2, H / 2 - 46);
	ctx.fillStyle = 'rgba(255,255,255,0.45)';
	ctx.font = '28px -apple-system,system-ui,sans-serif';
	ctx.fillText('ORACLE could not reach live Solana market data.', W / 2, H / 2 + 10);
	ctx.fillText('Run the demo again in a moment.', W / 2, H / 2 + 54);
	ctx.fillStyle = `rgba(240,160,48,${0.35 + 0.25 * Math.sin(t * 2)})`;
	ctx.fillRect(W / 2 - 40, H / 2 + 104, 80, 3);
	ctx.restore();
}

// ─── Payment beam (animated arc between agents) ─────────────────────────────

function createBeam(scene) {
	const points = [];
	const N = 40;
	for (let i = 0; i <= N; i++) {
		const s = i / N;
		const x = NOVA_X + (ORACLE_X - NOVA_X) * s;
		const y = 1.6 + Math.sin(s * Math.PI) * 1.2;
		const z = 0;
		points.push(new THREE.Vector3(x, y, z));
	}
	const curve = new THREE.CatmullRomCurve3(points);
	const geo = new THREE.TubeGeometry(curve, 60, 0.015, 6, false);
	const mat = new THREE.MeshBasicMaterial({
		color: 0x4e8cff,
		transparent: true,
		opacity: 0,
	});
	const mesh = new THREE.Mesh(geo, mat);
	scene.add(mesh);

	// Travelling orbs along beam
	const orbMat = new THREE.MeshBasicMaterial({ color: 0x4e8cff, transparent: true, opacity: 0 });
	const orbs = Array.from({ length: 5 }, (_, i) => {
		const o = new THREE.Mesh(new THREE.SphereGeometry(0.04, 6, 6), orbMat.clone());
		scene.add(o);
		return { mesh: o, phase: i / 5 };
	});

	let active = false;
	let startT = 0;
	let currentT = 0;

	function tick(t) {
		currentT = t;
		if (!active) return;
		const elapsed = (t - startT) % 2;
		const fade = elapsed < 0.3 ? elapsed / 0.3 : elapsed > 1.7 ? (2 - elapsed) / 0.3 : 1;
		mat.opacity = 0.5 * fade;
		orbs.forEach(({ mesh: om, phase }) => {
			const s = (phase + elapsed * 0.6) % 1;
			const p = curve.getPoint(s);
			om.position.copy(p);
			om.material.opacity = fade * (1 - Math.abs(s - 0.5) * 1.4);
		});
	}

	return {
		tick,
		activate() { active = true; startT = currentT; mat.opacity = 0.5; orbs.forEach(o => o.mesh.material.opacity = 0.7); },
		deactivate() { active = false; mat.opacity = 0; orbs.forEach(o => o.mesh.material.opacity = 0); },
	};
}

// ─── Canvas utilities ───────────────────────────────────────────────────────

function roundRect(ctx, x, y, w, h, r) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + w - r, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + r);
	ctx.lineTo(x + w, y + h - r);
	ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
	ctx.lineTo(x + r, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - r);
	ctx.lineTo(x, y + r);
	ctx.quadraticCurveTo(x, y, x + r, y);
	ctx.closePath();
}

function circle(ctx, x, y, r) {
	ctx.beginPath();
	ctx.arc(x, y, r, 0, Math.PI * 2);
}

function wrapText(ctx, text, x, y, maxW, lineH) {
	const words = text.split(' ');
	let line = '';
	for (const word of words) {
		const test = line ? line + ' ' + word : word;
		if (ctx.measureText(test).width > maxW && line) {
			ctx.fillText(line, x, y);
			line = word;
			y += lineH;
		} else {
			line = test;
		}
	}
	ctx.fillText(line, x, y);
}
