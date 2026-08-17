// watsonx Constellation — a live 3D galaxy of trending Solana tokens, positioned
// in semantic space by IBM Granite embeddings on watsonx.ai.
//
// Pipeline (all real, no mock data):
//   1. GET /api/pump/trending          → live pump.fun / Solana trending tokens
//   2. POST /api/watsonx/embed         → IBM Granite embedding vector per token
//   3. PCA (classical MDS, in-browser) → project the vectors down to 3 axes
//   4. three.js                        → render tokens as glowing stars; nearby
//                                        stars are semantically alike
//   5. click a star → POST /api/brain/chat (provider: ibm-granite) streams a
//      live IBM Granite analysis of that token into the side panel.
//
// Tokens render immediately in a deterministic layout from real data; when the
// Granite embeddings arrive the stars animate into their semantic positions. If
// watsonx is not configured the page says so plainly and keeps the rank layout —
// it never fabricates vectors or an analysis.
//
// Attribution is load-bearing here. Both backing endpoints have failover chains
// (the embed endpoint falls through to NVIDIA/Vertex/OpenAI; /api/brain/chat
// falls through to its free-tier routes and announces it with an SSE `fallback`
// event). This page therefore labels what ACTUALLY served the request rather
// than what it hoped for: crediting IBM Granite for another model's output would
// be a fabrication, the same class of defect as inventing the data itself.

import {
	Scene, PerspectiveCamera, WebGLRenderer, Color, Group,
	SphereGeometry, MeshBasicMaterial, Mesh,
	Sprite, SpriteMaterial, CanvasTexture, AdditiveBlending,
	BufferGeometry, BufferAttribute, Points, PointsMaterial,
	Raycaster, Vector2, Vector3, MathUtils,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { tokenText, pca3, normalizeCoordsToRadius, cosineNeighbors } from './embedding.js';
import { applyCinematicDefaults, detectQualityTier } from '../shared/cinematic-render.js';

// ---- DOM ------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const canvas = $('c-scene');
const statusEl = $('c-status');
const statusText = $('c-status-text');
const tooltip = $('c-tooltip');
const tipSym = $('c-tip-sym');
const tipNm = $('c-tip-nm');
const hint = $('c-hint');
const overlay = $('c-overlay');
const overlayMsg = $('c-overlay-msg');
const spinner = $('c-spinner');
const retryBtn = $('c-retry');
const panel = $('c-panel');
const liveRegion = $('c-a11y-live');

const RADIUS = 28; // target galaxy radius for the semantic / rank layouts
// A star is ~1-2 world units across at a camera distance of ~74, so an exact
// ray hit demands near-pixel precision, on a phone it is unhittable, and even
// with a mouse the pick can miss the star the tooltip is naming. Falling back to
// the nearest star within this screen-space radius makes the target the visible
// glow rather than the geometry.
const PICK_RADIUS_PX = 22;
const PICK_RADIUS_COARSE_PX = 34;
const SIGN_IN_HREF = '/login?next=%2Fconstellation';
const REGISTER_HREF = '/register?next=%2Fconstellation';

// WebGL-dependent objects, assigned in boot(). Functions below close over these
// module bindings, so they resolve correctly once boot() has run.
let renderer, scene, camera, controls, nodesGroup, glowTex;
const sphereGeo = new SphereGeometry(1, 20, 20);
const raycaster = new Raycaster();
const pointer = new Vector2();
/** @type {{token:object, mesh:Mesh, glow:Sprite, baseColor:Color, baseScale:number, target:Vector3}[]} */
let nodes = [];
let vectorsByIndex = null; // number[][] aligned with nodes, for neighbor lookups
let signedIn = false; // resolved once at boot; gates the Granite analysis call

// ---- status / overlay helpers ---------------------------------------------
function setStatus(kind, html) {
	console.log("DBG setStatus", kind, String(html).slice(0,60));
	statusEl.classList.remove('live', 'off', 'err');
	if (kind) statusEl.classList.add(kind);
	statusText.innerHTML = html;
}
function hideOverlay() {
	overlay.classList.add('hidden');
	overlay.setAttribute('aria-hidden', 'true');
	retryBtn.hidden = true;
}
function loadingOverlay(html) {
	spinner.style.display = '';
	retryBtn.hidden = true;
	overlayMsg.innerHTML = html;
	overlay.classList.remove('hidden');
	overlay.removeAttribute('aria-hidden');
}
// A dead end the visitor can act on: every recoverable failure offers the retry
// button, so the page never leaves someone staring at an error with no way out.
function fatalOverlay(html, { retryable = false } = {}) {
	spinner.style.display = 'none';
	overlayMsg.innerHTML = html;
	retryBtn.hidden = !retryable;
	overlay.classList.remove('hidden');
	overlay.removeAttribute('aria-hidden');
	if (retryable) retryBtn.focus();
}
function webglAvailable() {
	try {
		const c = document.createElement('canvas');
		return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
	} catch {
		return false;
	}
}
function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- shared textures ------------------------------------------------------
// Soft radial gradient used as an additive glow sprite behind each star.
function makeGlowTexture() {
	const s = 128;
	const cv = document.createElement('canvas');
	cv.width = cv.height = s;
	const ctx = cv.getContext('2d');
	const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
	g.addColorStop(0, 'rgba(255,255,255,1)');
	g.addColorStop(0.25, 'rgba(255,255,255,0.55)');
	g.addColorStop(0.55, 'rgba(255,255,255,0.16)');
	g.addColorStop(1, 'rgba(255,255,255,0)');
	ctx.fillStyle = g;
	ctx.fillRect(0, 0, s, s);
	return new CanvasTexture(cv);
}

// ---- backdrop starfield ---------------------------------------------------
function addStarfield() {
	const COUNT = 1800;
	const pos = new Float32Array(COUNT * 3);
	for (let i = 0; i < COUNT; i++) {
		const r = 150 + Math.random() * 120;
		const theta = Math.acos(2 * Math.random() - 1);
		const phi = Math.random() * Math.PI * 2;
		pos[i * 3] = r * Math.sin(theta) * Math.cos(phi);
		pos[i * 3 + 1] = r * Math.cos(theta);
		pos[i * 3 + 2] = r * Math.sin(theta) * Math.sin(phi);
	}
	const geom = new BufferGeometry();
	geom.setAttribute('position', new BufferAttribute(pos, 3));
	const mat = new PointsMaterial({ size: 0.7, color: 0x6b78b5, transparent: true, opacity: 0.7, depthWrite: false });
	scene.add(new Points(geom, mat));
}

// ---- token nodes ----------------------------------------------------------
// Deterministic point on a Fibonacci sphere — the honest "by rank" layout shown
// before (or instead of) the Granite embedding layout.
function fibonacciPoint(i, n, radius) {
	const golden = Math.PI * (3 - Math.sqrt(5));
	const y = 1 - (i / Math.max(1, n - 1)) * 2;
	const r = Math.sqrt(Math.max(0, 1 - y * y));
	const theta = golden * i;
	return new Vector3(Math.cos(theta) * r * radius, y * radius, Math.sin(theta) * r * radius);
}

function buildNodes(tokens) {
	// Retrying after a failed load rebuilds the galaxy, so the previous pass's
	// per-node materials are disposed rather than left on the GPU. The sphere
	// geometry and glow texture are shared across every node and every rebuild,
	// so they are deliberately kept.
	for (const n of nodes) {
		nodesGroup.remove(n.mesh);
		nodesGroup.remove(n.glow);
		n.mesh.material.dispose();
		n.glow.material.dispose();
	}
	nodes = [];
	hovered = null;
	selectedNode = null;
	focusIndex = -1;
	keyboardFocused = false;
	hideTooltip();
	const N = tokens.length;
	tokens.forEach((token, i) => {
		const rank = Number.isFinite(token.rank) ? token.rank : i + 1;
		const baseScale = MathUtils.lerp(1.7, 0.55, (rank - 1) / Math.max(1, N - 1));
		const hue = MathUtils.lerp(205, 280, (rank - 1) / Math.max(1, N - 1)) / 360;
		const baseColor = new Color().setHSL(hue, 0.7, 0.6);

		const mesh = new Mesh(sphereGeo, new MeshBasicMaterial({ color: baseColor.clone() }));
		mesh.scale.setScalar(baseScale);
		const p = fibonacciPoint(i, N, RADIUS);
		mesh.position.copy(p);
		mesh.userData.index = i;

		const glow = new Sprite(new SpriteMaterial({
			map: glowTex, color: baseColor.clone(), transparent: true,
			blending: AdditiveBlending, depthWrite: false, opacity: 0.5,
		}));
		glow.scale.setScalar(baseScale * 6);
		glow.position.copy(p);

		nodesGroup.add(glow);
		nodesGroup.add(mesh);
		nodes.push({ token, mesh, glow, baseColor, baseScale, target: p.clone() });
	});
}

function applySemanticLayout(vectors) {
	vectorsByIndex = vectors;
	const positions = normalizeCoordsToRadius(pca3(vectors), RADIUS).map((c) => new Vector3(c[0], c[1], c[2]));
	// Recolor by spatial angle so emergent clusters read as distinct hues, and
	// retarget each star to its semantic coordinate (the render loop tweens it).
	nodes.forEach((node, i) => {
		const p = positions[i];
		node.target.copy(p);
		const angle = (Math.atan2(p.z, p.x) + Math.PI) / (Math.PI * 2); // 0..1
		const hue = MathUtils.lerp(190, 285, angle) / 360;
		const col = new Color().setHSL(hue, 0.72, 0.62);
		node.baseColor = col;
		node.mesh.material.color.copy(col);
		node.glow.material.color.copy(col);
	});
}

// Map cosine-neighbor indices to their tokens for the detail panel.
function nearestNeighbors(idx, k = 3) {
	if (!vectorsByIndex) return [];
	return cosineNeighbors(vectorsByIndex, idx, k).map((n) => ({ token: nodes[n.index].token, sim: n.sim }));
}

// ---- data: live tokens ----------------------------------------------------
async function fetchTokens(limit = 64) {
	const res = await fetch(`/api/pump/trending?limit=${limit}`, { headers: { accept: 'application/json' } });
	if (!res.ok) throw new Error(`trending feed returned ${res.status}`);
	const json = await res.json();
	const rows = Array.isArray(json.data) ? json.data : [];
	return rows
		.filter((t) => t && t.symbol && t.name && t.mint)
		.map((t, i) => ({
			mint: t.mint,
			symbol: String(t.symbol).slice(0, 16),
			name: String(t.name).slice(0, 80),
			logo: t.logo || '',
			price_usd: Number(t.price_usd) || 0,
			rank: Number.isFinite(t.rank) ? t.rank : i + 1,
		}));
}

// ---- data: Granite embeddings --------------------------------------------
async function embedTokens(tokens) {
	const texts = tokens.map(tokenText);
	const res = await fetch('/api/watsonx/embed', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ texts }),
	});
	if (!res.ok) {
		let code = `http_${res.status}`;
		try { code = (await res.json()).error || code; } catch { /* non-JSON */ }
		const err = new Error(code);
		err.code = code;
		err.status = res.status;
		throw err;
	}
	return res.json(); // { model, dimensions, vectors }
}

// ---- interaction: hover + click + keyboard --------------------------------
let hovered = null;
let selectedNode = null;
let focusIndex = -1;        // keyboard cursor into `nodes`
let keyboardFocused = false; // the tooltip is tracking a keyboard-picked star
const pointerPx = [0, 0];
const _projected = new Vector3();

// The glow scale for a node depends on its state: selected stars stay largest,
// hovered stars enlarge for feedback, everything else sits at its base size.
function glowScaleFor(node) {
	if (node === selectedNode) return node.baseScale * 11;
	if (node === hovered) return node.baseScale * 9;
	return node.baseScale * 6;
}

function updatePointer(e) {
	pointerPx[0] = e.clientX;
	pointerPx[1] = e.clientY;
	pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
	pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
}

// Where a star currently sits on screen, in CSS pixels. Used for proximity
// picking and for anchoring the tooltip to a keyboard-selected star.
function screenXY(node) {
	_projected.copy(node.mesh.position).project(camera);
	return [
		((_projected.x + 1) / 2) * window.innerWidth,
		((1 - _projected.y) / 2) * window.innerHeight,
	];
}
function pickTolerancePx() {
	return window.matchMedia?.('(pointer: coarse)')?.matches ? PICK_RADIUS_COARSE_PX : PICK_RADIUS_PX;
}
function nearestNodeToScreen(px, py, maxPx) {
	let best = null;
	let bestD = maxPx;
	for (const node of nodes) {
		const [x, y] = screenXY(node);
		const d = Math.hypot(x - px, y - py);
		if (d < bestD) { bestD = d; best = node; }
	}
	return best;
}
// Exact ray hit first (it respects depth, so the front star wins where two
// overlap), then the screen-space fallback so the visible glow is the target.
function pickNode() {
	raycaster.setFromCamera(pointer, camera);
	const hits = raycaster.intersectObjects(nodes.map((n) => n.mesh), false);
	if (hits.length) return nodes[hits[0].object.userData.index];
	return nearestNodeToScreen(pointerPx[0], pointerPx[1], pickTolerancePx());
}

function hideTooltip() {
	tooltip.style.opacity = '0';
	keyboardFocused = false;
}
// Keep the tooltip inside the viewport: it is translated (-50%, -130%) from this
// anchor, so a star near an edge would otherwise push it off screen.
function placeTooltip(x, y) {
	const half = (tooltip.offsetWidth || 0) / 2;
	tooltip.style.left = `${Math.min(Math.max(x, half + 10), window.innerWidth - half - 10)}px`;
	tooltip.style.top = `${Math.max(y, (tooltip.offsetHeight || 28) + 12)}px`;
}
function showTooltip(node, x, y) {
	tipSym.textContent = node.token.symbol;
	tipNm.textContent = node.token.name;
	placeTooltip(x, y);
	tooltip.style.opacity = '1';
}

function setHovered(node) {
	if (node === hovered) return;
	const prev = hovered;
	hovered = node;
	if (prev) prev.glow.scale.setScalar(glowScaleFor(prev));
	if (node) node.glow.scale.setScalar(glowScaleFor(node));
}

function onPointerMove(e) {
	updatePointer(e);
	const node = pickNode();
	console.log("DBG move", e.clientX, e.clientY, node && node.token.symbol);
	if (node !== hovered) {
		setHovered(node);
		keyboardFocused = false;
		renderer.domElement.style.cursor = node ? 'pointer' : 'grab';
		if (node) showTooltip(node, e.clientX, e.clientY);
		else hideTooltip();
	} else if (node && !keyboardFocused) {
		placeTooltip(e.clientX, e.clientY);
	}
}

let downAt = 0; let downXY = [0, 0];
function onPointerDown(e) { downAt = performance.now(); downXY = [e.clientX, e.clientY]; }
function onPointerUp(e) {
	const moved = Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]);
	if (moved >= 6 || performance.now() - downAt >= 450) return; // an orbit drag, not a tap
	updatePointer(e);
	// The star under the release wins; if the ray and the proximity sweep both
	// come up empty, fall back to whatever the tooltip was naming, that is the
	// star the visitor was aiming at, and the scene keeps auto-rotating under the
	// cursor between the hover and the release.
	const node = pickNode() || hovered;
	console.log("DBG up pick=", !!pickNode(), "hovered=", hovered && hovered.token.symbol, "px=", pointerPx.join(","));
	if (node) { keyboardFocused = false; selectNode(node.mesh.userData.index, { fromKeyboard: false }); }
}

// Keyboard path to the same flow: arrows walk the stars in trending-rank order,
// Enter/Space opens the analysis panel. Without this the page's only real
// interaction is mouse-only.
function focusStar(index) {
	if (!nodes.length) return;
	focusIndex = ((index % nodes.length) + nodes.length) % nodes.length;
	const node = nodes[focusIndex];
	setHovered(node);
	keyboardFocused = true;
	const [x, y] = screenXY(node);
	showTooltip(node, x, y);
	liveRegion.textContent = `${node.token.symbol}, ${node.token.name}, trending rank ${node.token.rank}. ${focusIndex + 1} of ${nodes.length}. Press Enter for a live analysis.`;
}
function onCanvasKeyDown(e) {
	if (!nodes.length) return;
	const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
	if (step) {
		e.preventDefault();
		focusStar(focusIndex < 0 ? (step > 0 ? 0 : nodes.length - 1) : focusIndex + step);
		return;
	}
	if (e.key === 'Home' || e.key === 'End') {
		e.preventDefault();
		focusStar(e.key === 'Home' ? 0 : nodes.length - 1);
		return;
	}
	if ((e.key === 'Enter' || e.key === ' ') && focusIndex >= 0) {
		e.preventDefault();
		selectNode(focusIndex, { fromKeyboard: true });
	}
}

// ---- detail panel + Granite analysis stream -------------------------------
let analysisAbort = null;
let returnFocusToCanvas = false;

function selectNode(index, { fromKeyboard = false } = {}) {
	const prev = selectedNode;
	selectedNode = nodes[index];
	focusIndex = index;
	if (prev && prev !== selectedNode) prev.glow.scale.setScalar(glowScaleFor(prev));
	selectedNode.glow.scale.setScalar(glowScaleFor(selectedNode));
	const { token } = nodes[index];
	hint.style.opacity = '0';

	$('c-panel-sym').textContent = token.symbol;
	$('c-panel-nm').textContent = token.name;
	const logo = $('c-panel-logo');
	// A token logo is caller-supplied and often dead; a 404 must not leave a
	// broken-image glyph (or the previous token's art) in the header.
	logo.style.display = token.logo ? '' : 'none';
	if (token.logo) logo.src = token.logo; else logo.removeAttribute('src');
	logo.alt = token.logo ? `${token.symbol} token logo` : '';
	$('c-panel-price').textContent = token.price_usd ? formatPrice(token.price_usd) : '—';
	$('c-panel-rank').textContent = `#${token.rank}`;

	const neigh = nearestNeighbors(index, 3);
	$('c-panel-neighbors').textContent = neigh.length ? neigh.map((x) => x.token.symbol).join(', ') : '—';

	const links = $('c-panel-links');
	links.innerHTML = '';
	links.appendChild(extLink(`https://pump.fun/coin/${token.mint}`, 'pump.fun ↗'));
	links.appendChild(extLink(`https://solscan.io/token/${token.mint}`, 'Solscan ↗'));

	panel.classList.add('open');
	panel.setAttribute('aria-hidden', 'false');
	panel.removeAttribute('inert');
	returnFocusToCanvas = fromKeyboard;
	if (fromKeyboard) $('c-close').focus();

	runGraniteAnalysis(token, neigh);
}

function extLink(href, label) {
	const a = document.createElement('a');
	a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = label;
	return a;
}
function formatPrice(p) {
	if (p >= 1) return `$${p.toFixed(3)}`;
	if (p >= 0.0001) return `$${p.toFixed(6)}`;
	return `$${p.toExponential(2)}`;
}
function closePanel() {
	console.log("DBG closePanel", new Error().stack);
	if (!panel.classList.contains('open')) return;
	panel.classList.remove('open');
	panel.setAttribute('aria-hidden', 'true');
	// The panel is only translated off-screen, so without `inert` its close
	// button and links stay in the tab order while the panel is invisible.
	panel.setAttribute('inert', '');
	if (selectedNode) { const n = selectedNode; selectedNode = null; n.glow.scale.setScalar(glowScaleFor(n)); }
	if (analysisAbort) { analysisAbort.abort(); analysisAbort = null; }
	if (returnFocusToCanvas) { returnFocusToCanvas = false; canvas.focus(); }
}

// Reset the "Analysis by …" byline to the lane we are about to ask for. A
// previous star's fallback attribution must not carry over to the next one.
function resetAnalysisByline() {
	$('c-analysis-by').innerHTML = 'Analysis by <strong>IBM Granite</strong>&nbsp;on watsonx.ai';
}

async function runGraniteAnalysis(token, neighbors) {
	const out = $('c-analysis');
	const meta = $('c-analysis-meta');
	resetAnalysisByline();
	meta.textContent = '';
	if (analysisAbort) analysisAbort.abort();
	analysisAbort = new AbortController();

	// Signed-out visitors cannot reach any /api/brain/chat model that runs on the
	// server's billed keys, so say that up front with a way through rather than
	// firing a request that can only come back 401.
	if (!signedIn) {
		out.innerHTML = graniteUnavailableNotice('unauthorized');
		return;
	}

	out.innerHTML = '<span class="cursor"></span>';

	const neighborLine = neighbors.length
		? ` Its closest neighbors in the embedding space that lays out this galaxy are ${neighbors.map((n) => `${n.token.name} (${n.token.symbol})`).join(', ')}.`
		: '';
	const system = 'You are a concise, neutral crypto market analyst. You never give financial advice or price predictions. You explain what a token\'s name and ticker suggest, the typical risks of similar Solana meme/utility tokens, and concrete things a careful trader should verify (liquidity, holder concentration, mint authority, socials).';
	const userMsg = `Briefly analyze the Solana token "${token.name}" (ticker ${token.symbol}), currently trending at rank #${token.rank}.${neighborLine} In ~110 words: what the name/ticker signals about its theme, the main risks, and 3 things to check before touching it. End with one line: "Not financial advice."`;

	let text = '';
	try {
		const res = await fetch('/api/brain/chat', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				provider: 'ibm-granite',
				system,
				messages: [{ role: 'user', content: userMsg }],
				maxTokens: 400,
			}),
			signal: analysisAbort.signal,
		});

		if (!res.ok || !(res.headers.get('content-type') || '').includes('text/event-stream')) {
			let code = `http_${res.status}`;
			try { code = (await res.json()).error || code; } catch { /* ignore */ }
			out.innerHTML = graniteUnavailableNotice(code);
			return;
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		let usage = null;
		let servedLabel = null;   // from the `meta` event
		let servedNetwork = null;
		let fallbackRoute = null; // set when watsonx Granite could not serve the turn
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const blocks = buf.split('\n\n');
			buf = blocks.pop();
			for (const block of blocks) {
				let evt = 'message'; let data = '';
				for (const line of block.split('\n')) {
					if (line.startsWith('event:')) evt = line.slice(6).trim();
					else if (line.startsWith('data:')) data += line.slice(5).trim();
				}
				if (!data) continue;
				if (evt === 'error') { out.innerHTML = `<div class="c-notice">The analysis service returned an error: ${escapeHtml(safeMsg(data))}</div>`; return; }
				if (evt === 'done') { try { usage = JSON.parse(data).usage; } catch { /* ignore */ } continue; }
				if (evt === 'meta') {
					try { const m = JSON.parse(data); servedLabel = m.label; servedNetwork = m.network; } catch { /* ignore */ }
					continue;
				}
				// The server announces every route change before it streams a token.
				// The LAST one named is the route that actually produced this text.
				if (evt === 'fallback') {
					try { fallbackRoute = JSON.parse(data).route; } catch { /* ignore */ }
					continue;
				}
				if (evt === 'first') continue;
				if (data === '[DONE]') continue;
				// default event = streamed text chunk (JSON-encoded string)
				try { text += JSON.parse(data); } catch { text += data; }
				out.textContent = text;
				out.insertAdjacentHTML('beforeend', '<span class="cursor"></span>');
			}
		}
		out.textContent = text || 'No response.';
		const tokenCount = usage?.totalTokens ? ` · ${usage.totalTokens} tokens` : '';
		if (fallbackRoute) {
			// Not Granite. Say so where the reader is looking, not only in the meta line.
			$('c-analysis-by').innerHTML = `Analysis by <strong>${escapeHtml(fallbackRoute)}</strong>`;
			meta.textContent = `IBM Granite on watsonx.ai could not serve this request · answered by ${fallbackRoute}${tokenCount}`;
		} else {
			meta.textContent = `${servedLabel || 'IBM Granite 3.8B'} · ${servedNetwork || 'IBM watsonx.ai'}${tokenCount}`;
		}
	} catch (e) {
		if (e.name === 'AbortError') return;
		out.innerHTML = `<div class="c-notice">Could not reach the analysis service: ${escapeHtml(e.message)}. Pick the star again to retry.</div>`;
	}
}

function graniteUnavailableNotice(code) {
	if (code === 'unauthorized') {
		return `<div class="c-notice">Live analysis runs on the platform's own model keys, so it needs an account. <a href="${SIGN_IN_HREF}">Sign in</a> or <a href="${REGISTER_HREF}">create a free account</a> and pick this star again. The galaxy, its live prices and its semantic layout all stay open to everyone.</div>`;
	}
	if (code === 'provider_not_configured') {
		return '<div class="c-notice">IBM Granite isn\'t enabled on this deployment yet — set <code>WATSONX_API_KEY</code> to turn on live analysis. See the <a href="/galaxy">IBM Granite demos</a>.</div>';
	}
	if (code === 'rate_limited') {
		return '<div class="c-notice">Rate limit reached, wait a moment and pick the star again.</div>';
	}
	return `<div class="c-notice">Analysis unavailable (${escapeHtml(code)}). Pick the star again to retry.</div>`;
}
function safeMsg(data) { try { return JSON.parse(data).message || data; } catch { return data; } }

// ---- render loop ----------------------------------------------------------
function animate() {
	requestAnimationFrame(animate);
	if (document.visibilityState === 'hidden') return; // pause rendering on a backgrounded tab
	for (const node of nodes) {
		node.mesh.position.lerp(node.target, 0.06);
		node.glow.position.copy(node.mesh.position);
	}
	controls.update();
	// A keyboard-picked star keeps drifting with the auto-rotation, so its label
	// has to follow it instead of being pinned where it was when it was picked.
	if (keyboardFocused && hovered) {
		const [x, y] = screenXY(hovered);
		placeTooltip(x, y);
	}
	renderer.render(scene, camera);
}

// ---- boot: create the WebGL scene; degrade gracefully without WebGL -------
function boot() {
	if (!webglAvailable()) {
		fatalOverlay('<strong>This experience needs WebGL.</strong><br/>Open it in a modern desktop or mobile browser with hardware acceleration enabled.');
		return false;
	}
	try {
		renderer = new WebGLRenderer({ canvas, antialias: true, alpha: false });
	} catch (e) {
		fatalOverlay('<strong>This experience needs WebGL.</strong><br/>Your browser could not create a WebGL context.');
		return false;
	}
	// Shared cinematic bar (ACES tone mapping, sRGB output, tiered pixel ratio
	// cap). No HDRI/IBL here: every material in this scene is MeshBasicMaterial
	// or PointsMaterial (unlit/emissive-style stars + additive glow sprites),
	// so environment reflections would never be visible - only the tone
	// mapping's highlight rolloff matters for this surface.
	applyCinematicDefaults(renderer, { tier: detectQualityTier() });
	renderer.setSize(window.innerWidth, window.innerHeight);

	scene = new Scene();
	scene.background = new Color(0x04040a);

	camera = new PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.1, 2000);
	camera.position.set(0, 6, 74);

	controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.06;
	controls.rotateSpeed = 0.6;
	controls.autoRotate = true;
	controls.autoRotateSpeed = 0.32;
	controls.minDistance = 18;
	controls.maxDistance = 260;

	nodesGroup = new Group();
	scene.add(nodesGroup);
	glowTex = makeGlowTexture();
	addStarfield();

	renderer.domElement.addEventListener('pointermove', onPointerMove);
	renderer.domElement.addEventListener('pointerdown', onPointerDown);
	renderer.domElement.addEventListener('pointerup', onPointerUp);
	renderer.domElement.addEventListener('pointerleave', hideTooltip);
	renderer.domElement.addEventListener('keydown', onCanvasKeyDown);
	renderer.domElement.addEventListener('blur', hideTooltip);
	window.addEventListener('resize', () => {
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize(window.innerWidth, window.innerHeight);
	});
	$('c-close').addEventListener('click', closePanel);
	retryBtn.addEventListener('click', () => {
		loadingOverlay('<strong>Loading the constellation…</strong><br/>Fetching live trending tokens.');
		init();
	});
	window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

	animate();
	return true;
}

// ---- orchestration --------------------------------------------------------
async function init() {
	closePanel();
	let tokens;
	try {
		setStatus('off', 'Fetching live tokens…');
		tokens = await fetchTokens(64);
	} catch (e) {
		setStatus('err', 'Live token feed unreachable.');
		fatalOverlay(
			`<strong>Couldn't load live tokens.</strong><br/>The pump.fun trending feed didn't answer (${escapeHtml(e.message)}).`,
			{ retryable: true },
		);
		return;
	}
	if (!tokens.length) {
		setStatus('off', 'Trending feed returned no tokens.');
		fatalOverlay(
			'<strong>No trending tokens right now.</strong><br/>The live feed answered with an empty set. It refills continuously, try again in a moment.',
			{ retryable: true },
		);
		return;
	}

	buildNodes(tokens);
	hideOverlay();
	setStatus('off', `${tokens.length} live tokens · embedding with IBM&nbsp;Granite…`);

	try {
		const { vectors, model, dimensions } = await embedTokens(tokens);
		const usable = vectors.filter((v) => Array.isArray(v) && v.length).length;
		if (usable < 3) throw Object.assign(new Error('too few vectors'), { code: 'insufficient_vectors' });
		const dim = vectors.find((v) => v?.length)?.length || dimensions || 0;
		const filled = vectors.map((v) => (v?.length ? v : new Array(dim).fill(0)));
		applySemanticLayout(filled);
		// The embed endpoint has its own failover chain, so name the model that
		// actually produced these vectors rather than assuming Granite served.
		const served = String(model || '');
		const d = dimensions || dim;
		setStatus(
			'live',
			/granite/i.test(served)
				? `Embedded by IBM&nbsp;Granite · <code>${escapeHtml(served)}</code> · ${d}d`
				: `Semantic layout live · <code>${escapeHtml(served || 'fallback embedder')}</code> · ${d}d · IBM&nbsp;Granite was unavailable, so the fallback embedder placed these stars`,
		);
	} catch (e) {
		if (e.code === 'embed_unconfigured') {
			setStatus('off', 'Semantic layout off — IBM watsonx isn\'t configured, so stars are placed by trending rank instead of meaning. <a href="/galaxy" style="color:var(--brand-blue-light)">Enable Granite →</a>');
		} else if (e.status === 404) {
			setStatus('off', 'Semantic layout off — the Granite embeddings endpoint isn\'t deployed yet, so stars are placed by trending rank.');
		} else {
			setStatus('err', `Semantic layout off — Granite embeddings unavailable (${escapeHtml(e.code || e.message)}). Stars are placed by trending rank.`);
		}
	}
}

// Resolve the session once. /api/auth/me answers 200 with `{ user: null }` when
// signed out, so this costs one clean request and lets the page say what a star
// click will actually do before the visitor spends one finding out.
async function resolveSession() {
	try {
		const res = await fetch('/api/auth/me', { credentials: 'include', headers: { accept: 'application/json' } });
		const data = res.ok ? await res.json() : null;
		return Boolean(data && data.user);
	} catch {
		return false;
	}
}

if (boot()) {
	init();
	resolveSession().then((ok) => {
		signedIn = ok;
		if (!ok) {
			hint.innerHTML = `drag to orbit · scroll to zoom · click a star (or arrow keys + Enter) for its detail · <a href="${SIGN_IN_HREF}" style="color:var(--brand-blue-light)">sign in</a> for a live Granite analysis`;
		}
	});
}
