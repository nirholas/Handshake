// Agent-to-agent x402 trade demo: Three.js scene + SSE consumer.
// Two 3D avatars (Nexus buyer, Oracle seller) face each other on glowing
// platforms. A particle beam fires when SOL moves on-chain; each step of
// the x402 protocol animates in real time.
//
// The 3D stage is optional. Every device that cannot grant a WebGL context
// (no GPU, blocklisted driver, exhausted context budget) still gets the whole
// protocol flow: the scene degrades to a laid-out 2D read of the same events
// instead of a black void, because the payment story is the product here and
// the particles are the garnish.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { getMeshoptDecoder } from './viewer/internal.js';
import { createRenderer, WebGLUnavailableError } from './webgl-support.js';

// ── Constants ──────────────────────────────────────────────────────────────
const BUYER_COL  = new THREE.Color(0x4589ff); // IBM blue
const SELLER_COL = new THREE.Color(0xf1c21b); // IBM gold
const BUYER_POS  = new THREE.Vector3(-3.4, 0, 0);
const SELLER_POS = new THREE.Vector3( 3.4, 0, 0);
const BEAM_N  = 350; // beam particles
const BURST_N = 90;  // confirmation burst particles
const AVATAR_GLB = '/avatars/default.glb';
const RUNNING_LABEL = '⏳ Running…';
const FALLBACK_LABEL = '▶ Run Trade Demo';
const NO_VALUE = 'n/a';

// ── DOM references ──────────────────────────────────────────────────────────
const els = {
  canvas:       document.getElementById('canvas'),
  buyerLabel:   document.getElementById('buyerLabel'),
  sellerLabel:  document.getElementById('sellerLabel'),
  buyerAddr:    document.getElementById('buyerAddr'),
  sellerAddr:   document.getElementById('sellerAddr'),
  buyerBal:     document.getElementById('buyerBal'),
  buyerBubble:  document.getElementById('buyerBubble'),
  sellerBubble: document.getElementById('sellerBubble'),
  centralCard:  document.getElementById('centralCard'),
  stepLog:      document.getElementById('stepLog'),
  startBtn:     document.getElementById('startBtn'),
  topicSelect:  document.getElementById('topicSelect'),
  networkName:  document.getElementById('networkName'),
  notConfigured:document.getElementById('notConfigured'),
  toast:        document.getElementById('toast'),
  cfgClose:     document.getElementById('cfgClose'),
  srStatus:     document.getElementById('srStatus'),
};

// ── HTML escaping ────────────────────────────────────────────────────────────
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// Returns null (not '#') for anything that is not an absolute http(s) URL, so a
// malformed explorer URL renders no link at all rather than a dead one.
function safeHref(u) {
  const s = String(u || '').trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

function fmt(addr) {
  return addr ? addr.slice(0, 4) + '…' + addr.slice(-4) : NO_VALUE;
}

// ── 3D stage ────────────────────────────────────────────────────────────────
// Everything WebGL lives in here so a device without a context throws once, at
// construction, and the rest of the page carries on. Returns the handful of
// hooks the protocol flow drives.
function buildStage() {
  const renderer = createRenderer({ canvas: els.canvas, antialias: true }, { fallback: els.canvas });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = false;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05050e);
  scene.fog = new THREE.FogExp2(0x05050e, 0.038);

  const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(0, 2.9, 9.8);

  const controls = new OrbitControls(camera, els.canvas);
  controls.target.set(0, 1.1, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.minDistance = 4;
  controls.maxDistance = 20;
  controls.maxPolarAngle = Math.PI * 0.68;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.35;
  controls.update();

  // ── Lights ───────────────────────────────────────────────────────────────
  scene.add(new THREE.AmbientLight(0x10102a, 4));

  const buyerLight = new THREE.PointLight(BUYER_COL, 10, 9);
  buyerLight.position.set(BUYER_POS.x, 2.5, 1.2);
  scene.add(buyerLight);

  const sellerLight = new THREE.PointLight(SELLER_COL, 10, 9);
  sellerLight.position.set(SELLER_POS.x, 2.5, 1.2);
  scene.add(sellerLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.8);
  keyLight.position.set(2, 6, 3);
  scene.add(keyLight);

  // ── Floor ────────────────────────────────────────────────────────────────
  const grid = new THREE.GridHelper(32, 32, 0x1a1a4e, 0x0c0c24);
  grid.position.y = 0.001;
  scene.add(grid);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(32, 32),
    new THREE.MeshStandardMaterial({ color: 0x050510, roughness: 1, metalness: 0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // ── Platforms ────────────────────────────────────────────────────────────
  function makePlatform(worldPos, col) {
    const g = new THREE.Group();

    const discGeo = new THREE.CylinderGeometry(1.15, 1.35, 0.09, 48);
    const discMat = new THREE.MeshStandardMaterial({
      color: 0x0d0d1c, emissive: col, emissiveIntensity: 0.2,
      roughness: 0.3, metalness: 0.8,
    });
    g.add(new THREE.Mesh(discGeo, discMat));

    const ringGeo = new THREE.TorusGeometry(1.15, 0.028, 8, 64);
    const ringMat = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 1.8 });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.045;
    g.add(ring);

    g.position.copy(worldPos);
    scene.add(g);
    return { group: g, ring };
  }

  const buyerPlatform  = makePlatform(BUYER_POS,  BUYER_COL);
  const sellerPlatform = makePlatform(SELLER_POS, SELLER_COL);

  // ── Background stars ─────────────────────────────────────────────────────
  {
    const N = 1400;
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(2 * Math.random() - 1);
      const r  = 42 + Math.random() * 8;
      pos[i * 3]     = r * Math.sin(ph) * Math.cos(th);
      pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      pos[i * 3 + 2] = r * Math.cos(ph);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.07, transparent: true, opacity: 0.65 })));
  }

  // ── Avatar loading ───────────────────────────────────────────────────────
  const gltfLoader = new GLTFLoader();
  const draco = new DRACOLoader();
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/');
  gltfLoader.setDRACOLoader(draco);
  // default.glb is meshopt-compressed: without this decoder every load threw
  // and the scene silently degraded to the capsule fallback figures.
  const meshoptReady = getMeshoptDecoder().then((d) => gltfLoader.setMeshoptDecoder(d));

  // Label tracking positions (above each avatar's head)
  const labelPos = {
    buyer:  BUYER_POS.clone().add(new THREE.Vector3(0, 2.1, 0)),
    seller: SELLER_POS.clone().add(new THREE.Vector3(0, 2.1, 0)),
  };

  let buyerMesh = null;
  let sellerMesh = null;

  function applyTint(gltfScene, col) {
    gltfScene.traverse((child) => {
      if (!child.isMesh) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      const tinted = mats.map((m) => {
        const n = m.clone();
        n.color.multiplyScalar(0.65).addScaledVector(col, 0.38);
        n.emissive = col.clone().multiplyScalar(0.07);
        n.emissiveIntensity = 1;
        return n;
      });
      child.material = tinted.length === 1 ? tinted[0] : tinted;
    });
  }

  function makeFallbackFigure(col) {
    const g = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: col, emissive: col, emissiveIntensity: 0.12, roughness: 0.6, metalness: 0.3 });
    g.add(new THREE.Mesh(new THREE.CapsuleGeometry(0.31, 1.0, 8, 16), bodyMat));
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.25, 16, 16), bodyMat.clone());
    head.position.y = 1.05;
    g.add(head);
    return g;
  }

  function loadAvatar(worldPos, col, yaw, onLoaded) {
    meshoptReady.then(() => gltfLoader.load(AVATAR_GLB, (gltf) => {
      const s = gltf.scene.clone(true);
      applyTint(s, col);
      s.position.copy(worldPos);
      s.rotation.y = yaw;
      scene.add(s);
      const box = new THREE.Box3().setFromObject(s);
      onLoaded(s, new THREE.Vector3(worldPos.x, box.max.y + 0.18, worldPos.z));
    }, undefined, () => {
      // GLB failed (CORS in dev? missing file?): use the stylised capsule.
      const s = makeFallbackFigure(col);
      s.position.copy(worldPos);
      s.rotation.y = yaw;
      scene.add(s);
      onLoaded(s, new THREE.Vector3(worldPos.x, 2.15, worldPos.z));
    }));
  }

  loadAvatar(BUYER_POS,  BUYER_COL,  0.12, (m, top) => { buyerMesh  = m; labelPos.buyer  = top; });
  loadAvatar(SELLER_POS, SELLER_COL, -0.12, (m, top) => { sellerMesh = m; labelPos.seller = top; });

  // ── Payment beam ─────────────────────────────────────────────────────────
  const beamPhases = new Float32Array(BEAM_N).map(() => Math.random());
  const beamSpeeds = new Float32Array(BEAM_N).map(() => 0.28 + Math.random() * 0.55);
  const beamPos    = new Float32Array(BEAM_N * 3);

  const beamGeo = new THREE.BufferGeometry();
  beamGeo.setAttribute('position', new THREE.BufferAttribute(beamPos, 3));
  const beamMat = new THREE.PointsMaterial({
    color: 0x4589ff, size: 0.065, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  scene.add(new THREE.Points(beamGeo, beamMat));

  let beamActive = false;

  // ── Confirmation burst ───────────────────────────────────────────────────
  const burstPos  = new Float32Array(BURST_N * 3);
  const burstVels = new Float32Array(BURST_N * 3);
  const burstGeo  = new THREE.BufferGeometry();
  burstGeo.setAttribute('position', new THREE.BufferAttribute(burstPos, 3));
  const burstMat = new THREE.PointsMaterial({
    color: 0x42be65, size: 0.1, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  });
  scene.add(new THREE.Points(burstGeo, burstMat));

  let burstLife = 0;

  // ── Camera animation ─────────────────────────────────────────────────────
  const camAnim = {
    active: false, t: 0, dur: 0,
    fromPos: new THREE.Vector3(), toPos: new THREE.Vector3(),
    fromTgt: new THREE.Vector3(), toTgt: new THREE.Vector3(),
  };

  // ── Label & bubble positioning ───────────────────────────────────────────
  function project(v3) {
    const v = v3.clone().project(camera);
    return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (-v.y * 0.5 + 0.5) * innerHeight };
  }

  // Clamped to the viewport: at 320px the projected anchor can sit off-screen,
  // and a label the user cannot read is the same as no label at all.
  function placeEl(el, worldPos, xOffset = 0, yOffset = 0) {
    const p = project(worldPos);
    const halfW = el.offsetWidth / 2 || 0;
    const x = Math.min(Math.max(p.x + xOffset, halfW + 8), innerWidth - halfW - 8);
    const y = Math.min(Math.max(p.y + yOffset, el.offsetHeight + 8), innerHeight - 8);
    el.style.left      = `${x}px`;
    el.style.top       = `${y}px`;
    el.style.transform = 'translate(-50%, -100%)';
  }

  // Below this width the projected anchors clamp into the same pixels as the
  // central card, so the overlays leave the scene and stack into the fixed
  // strip the stylesheet lays out (the same one the no-WebGL fallback uses).
  const FLAT_OVERLAY_W = 560;
  let flatOverlays = null;

  function syncOverlayMode() {
    const flat = innerWidth <= FLAT_OVERLAY_W;
    if (flat === flatOverlays) return flat;
    flatOverlays = flat;
    document.body.classList.toggle('flat-overlays', flat);
    if (flat) {
      // Drop the inline positions the projector wrote, or they would win over
      // the stylesheet's strip layout.
      for (const el of [els.buyerLabel, els.sellerLabel, els.buyerBubble, els.sellerBubble]) {
        el.style.left = '';
        el.style.top = '';
        el.style.transform = '';
      }
    }
    return flat;
  }

  // A bubble sits directly above its own label. Anchoring it to a world-space
  // offset instead made the gap shrink with the projection while the bubble grew
  // with its wrapped text, so at tablet widths the bubble printed over the
  // agent's name; measuring the label is the only way that always clears.
  function placeAbove(el, anchorEl) {
    const a = anchorEl.getBoundingClientRect();
    const halfW = el.offsetWidth / 2 || 0;
    const x = Math.min(Math.max(a.left + a.width / 2, halfW + 8), innerWidth - halfW - 8);
    const y = Math.max(a.top - 8, el.offsetHeight + 8);
    el.style.left      = `${x}px`;
    el.style.top       = `${y}px`;
    el.style.transform = 'translate(-50%, -100%)';
  }

  function updateOverlays() {
    if (syncOverlayMode()) return;
    placeEl(els.buyerLabel,  labelPos.buyer,  0, -8);
    placeEl(els.sellerLabel, labelPos.seller, 0, -8);

    if (!els.buyerBubble.classList.contains('hidden')) placeAbove(els.buyerBubble, els.buyerLabel);
    if (!els.sellerBubble.classList.contains('hidden')) placeAbove(els.sellerBubble, els.sellerLabel);
  }

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  // ── Animation loop ───────────────────────────────────────────────────────
  const clock = new THREE.Timer();

  (function animate() {
    requestAnimationFrame(animate);
    clock.update();
    const dt = Math.min(clock.getDelta(), 0.1);
    const t  = clock.getElapsed();

    // Idle avatar breath
    if (buyerMesh)  buyerMesh.position.y  = Math.sin(t * 0.75) * 0.022;
    if (sellerMesh) sellerMesh.position.y = Math.sin(t * 0.75 + 1.2) * 0.022;

    // Platform ring pulse
    buyerPlatform.ring.material.emissiveIntensity  = 1.4 + Math.sin(t * 2.0) * 0.5;
    sellerPlatform.ring.material.emissiveIntensity = 1.4 + Math.sin(t * 2.0 + 1.0) * 0.5;

    // Beam travel
    if (beamActive) {
      const B = BUYER_POS, S = SELLER_POS;
      const spread = 0.13;
      for (let i = 0; i < BEAM_N; i++) {
        beamPhases[i] = (beamPhases[i] + beamSpeeds[i] * dt) % 1;
        const ph = beamPhases[i];
        beamPos[i * 3]     = B.x + (S.x - B.x) * ph + (Math.random() - 0.5) * spread;
        beamPos[i * 3 + 1] = B.y + 0.9 + (Math.random() - 0.5) * spread;
        beamPos[i * 3 + 2] = (Math.random() - 0.5) * spread;
      }
      beamGeo.attributes.position.needsUpdate = true;
      beamMat.opacity = 0.75 + Math.sin(t * 14) * 0.18;
    } else if (beamMat.opacity > 0) {
      beamMat.opacity = Math.max(0, beamMat.opacity - dt * 2.5);
      if (beamMat.opacity === 0) beamGeo.attributes.position.needsUpdate = true;
    }

    // Burst particles
    if (burstLife > 0) {
      burstLife -= dt * 0.65;
      burstMat.opacity = Math.max(0, burstLife);
      for (let i = 0; i < BURST_N; i++) {
        burstVels[i * 3 + 1] -= 4.8 * dt; // gravity
        burstPos[i * 3]     += burstVels[i * 3]     * dt;
        burstPos[i * 3 + 1] += burstVels[i * 3 + 1] * dt;
        burstPos[i * 3 + 2] += burstVels[i * 3 + 2] * dt;
      }
      burstGeo.attributes.position.needsUpdate = true;
      if (burstLife <= 0) burstMat.opacity = 0;
    }

    // Camera animation
    if (camAnim.active) {
      camAnim.t += dt * 1000;
      const raw  = Math.min(camAnim.t / camAnim.dur, 1);
      const ease = raw < 0.5 ? 2 * raw * raw : 1 - (-2 * raw + 2) ** 2 / 2;
      camera.position.lerpVectors(camAnim.fromPos, camAnim.toPos, ease);
      controls.target.lerpVectors(camAnim.fromTgt, camAnim.toTgt, ease);
      if (raw >= 1) camAnim.active = false;
    }

    controls.update();
    updateOverlays();
    renderer.render(scene, camera);
  })();

  return {
    startBeam() {
      beamActive = true;
      beamMat.opacity = 0.92;
    },
    stopBeam() {
      beamActive = false;
      beamMat.opacity = 0;
    },
    triggerBurst() {
      beamActive = false;
      const s = SELLER_POS;
      for (let i = 0; i < BURST_N; i++) {
        burstPos[i * 3]     = s.x + (Math.random() - 0.5) * 0.3;
        burstPos[i * 3 + 1] = s.y + 0.95 + Math.random() * 0.4;
        burstPos[i * 3 + 2] = s.z + (Math.random() - 0.5) * 0.3;
        const th = Math.random() * Math.PI * 2;
        const spd = 1.2 + Math.random() * 2.2;
        burstVels[i * 3]     = Math.cos(th) * spd;
        burstVels[i * 3 + 1] = (0.5 + Math.random()) * spd;
        burstVels[i * 3 + 2] = Math.sin(th) * spd * 0.5;
      }
      burstGeo.attributes.position.needsUpdate = true;
      burstMat.opacity = 1;
      burstLife = 1.2;
    },
    flyCamera(toPos, toTgt, dur = 1100) {
      camAnim.fromPos.copy(camera.position);
      camAnim.toPos.copy(toPos);
      camAnim.fromTgt.copy(controls.target);
      camAnim.toTgt.copy(toTgt);
      camAnim.t = 0;
      camAnim.dur = dur;
      camAnim.active = true;
    },
    setAutoRotate(on) { controls.autoRotate = on; },
  };
}

let stage = null;
try {
  stage = buildStage();
} catch (err) {
  // A device that cannot do WebGL still gets the full protocol read: the labels,
  // bubbles, step log and receipt cards lay out in 2D under `no-3d`.
  if (!(err instanceof WebGLUnavailableError)) throw err;
  document.body.classList.add('no-3d');
}

const vec3 = (x, y, z) => new THREE.Vector3(x, y, z);

// ── Config overlay focus management ─────────────────────────────────────────
// The overlay is a modal dialog over a 3D canvas (OrbitControls). Keyboard users
// need: focus moved into it on open, Tab trapped inside it, Escape to dismiss, and
// focus returned to the trigger on close, otherwise Tab silently escapes to the
// canvas and the overlay reads as a dead end.
let cfgLastFocus = null;

function cfgFocusable() {
  return [...els.notConfigured.querySelectorAll('a[href], button:not([disabled])')].filter(
    (el) => el.offsetParent !== null,
  );
}

function openConfigOverlay() {
  cfgLastFocus = document.activeElement;
  els.notConfigured.classList.remove('hidden');
  // Move focus to the dismiss control so keyboard users land inside the dialog.
  requestAnimationFrame(() => els.cfgClose?.focus());
}

// The overlay opens by itself on an unconfigured deployment, so the element that
// "had focus" at that moment is <body>. Restoring to it drops focus out of the
// document entirely and Tab restarts from the top, so a candidate only counts
// when it is genuinely focusable.
const FOCUSABLE = 'a[href], button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

function closeConfigOverlay() {
  if (els.notConfigured.classList.contains('hidden')) return;
  els.notConfigured.classList.add('hidden');
  // Return focus somewhere sensible so the user keeps their place: the original
  // trigger if it's still focusable, else the walkthrough re-open button in the
  // card, else the topic select (the run button is disabled when unconfigured
  // and can't take focus).
  const candidates = [
    cfgLastFocus,
    els.centralCard.querySelector('[data-action="show-walkthrough"]'),
    els.startBtn,
    els.topicSelect,
  ].filter((el) => el && document.contains(el) && !el.disabled && el.matches?.(FOCUSABLE));
  candidates[0]?.focus?.();
}

els.notConfigured.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    closeConfigOverlay();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusable = cfgFocusable();
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
});

els.cfgClose.addEventListener('click', closeConfigOverlay);

// Dismissing the overlay used to strand the walkthrough with no way back. The
// idle card carries a control that re-opens it, and every failure card carries
// the one control that can clear it.
els.centralCard.addEventListener('click', (e) => {
  if (e.target.closest('[data-action="show-walkthrough"]')) { openConfigOverlay(); return; }
  if (e.target.closest('[data-action="retry-preflight"]')) { checkConfig(); return; }
  if (e.target.closest('[data-action="run-again"]')) startDemo();
});

// ── Bubble helpers ──────────────────────────────────────────────────────────
function showBubble(side, text, { pending = false } = {}) {
  const el = side === 'buyer' ? els.buyerBubble : els.sellerBubble;
  el.textContent = text;
  el.classList.toggle('pending', pending);
  el.classList.remove('hidden');
}
function hideBubble(side) {
  const el = side === 'buyer' ? els.buyerBubble : els.sellerBubble;
  el.classList.add('hidden');
  el.classList.remove('pending');
}

// ── Central card ────────────────────────────────────────────────────────────
function showCard(html) {
  els.centralCard.innerHTML = html;
  els.centralCard.classList.remove('hidden');
}
function hideCard() { els.centralCard.classList.add('hidden'); }

// Pre-run state, drawn from the live pre-flight response: what the trade will
// cost, who gets paid, on which network, and what the button will do.
function showReadyCard(cfg) {
  showCard(`
    <div class="c-badge c-badge-idle">x402 · oracle-market-analysis</div>
    <div class="c-label">Ready to trade</div>
    <div class="c-price blue">${escHtml(cfg.priceSol ?? '?')} SOL</div>
    <div class="c-row">Buyer   <span>${escHtml(fmt(cfg.buyer?.address))}</span></div>
    <div class="c-row">Seller  <span>${escHtml(fmt(cfg.seller?.address))}</span></div>
    <div class="c-row">Network <span>${escHtml(cfg.network || NO_VALUE)}</span></div>
    <div class="c-content">Pick a topic and run the demo. Nexus pays Oracle on Solana, then Oracle delivers the analysis it was paid for.</div>
  `);
}

// Pre-flight in flight. The wallets, price and network come off Solana, which
// takes as long as the RPC takes, so the card shows the shape of the answer
// rather than leaving the stage empty and the run button in an unknown state.
function showCheckingCard() {
  showCard(`
    <div class="c-badge c-badge-idle">x402 · oracle-market-analysis</div>
    <div class="c-label">Checking the demo wallets</div>
    <div class="c-skel c-skel-price"></div>
    <div class="c-skel c-skel-row"></div>
    <div class="c-skel c-skel-row short"></div>
    <div class="c-content">Reading the buyer and seller balances from Solana before the trade can start.</div>
  `);
}

// Any failure that leaves the user with nothing to look at. The action is the
// point: a red toast fades after eight seconds and then the page reads as a
// half-finished trade with no explanation.
function showErrorCard({ badge, label, message, action }) {
  showCard(`
    <div class="c-badge c-badge-402">${escHtml(badge)}</div>
    <div class="c-label">${escHtml(label)}</div>
    <div class="c-content">${escHtml(message)}</div>
    <button class="cfg-close" type="button" data-action="${escHtml(action.id)}">${escHtml(action.label)}</button>
  `);
}

// Pre-run state when no wallets are configured: says why the button is off and
// keeps the walkthrough one click away.
function showUnconfiguredCard() {
  showCard(`
    <div class="c-badge c-badge-402">Live demo offline</div>
    <div class="c-label">x402 · oracle-market-analysis</div>
    <div class="c-content">This deployment has no funded agent wallets, so nothing can be paid on-chain right now. The walkthrough explains each step of the trade and how to enable it.</div>
    <button class="cfg-close" type="button" data-action="show-walkthrough">Show the walkthrough</button>
  `);
}

// ── Step log ─────────────────────────────────────────────────────────────────
const STEP_NAMES = ['init', 'request', 'challenged', 'paying', 'confirmed', 'delivering', 'delivered'];
// The server codes that deserve their own headline on the failure card; anything
// else falls back to the generic one.
const ERROR_BADGES = {
  insufficient_funds: 'Buyer wallet is short',
  daily_budget_exhausted: 'Daily spend limit reached',
  analysis_unavailable: 'No analysis model available',
  analysis_failed: 'Analysis failed after payment',
  send_failed: 'Payment failed',
};
const chips = {};

function buildStepLog() {
  els.stepLog.innerHTML = '';
  STEP_NAMES.forEach((s) => {
    const c = document.createElement('div');
    c.className = 'step-chip';
    c.setAttribute('role', 'listitem');
    c.textContent = s;
    els.stepLog.appendChild(c);
    chips[s] = c;
  });
}

function announce(msg) {
  if (els.srStatus) els.srStatus.textContent = msg;
}

function setChip(name, state) {
  const c = chips[name];
  if (!c) return;
  c.classList.remove('active', 'done', 'error');
  if (state) c.classList.add(state);
  if (state === 'active') {
    c.setAttribute('aria-current', 'step');
    announce(`Step: ${name}`);
  } else {
    c.removeAttribute('aria-current');
  }
}

// ── Toast ────────────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 8000);
}

// ── SSE event handling ────────────────────────────────────────────────────────
// The idle label is captured from the DOM rather than hardcoded, so a run does
// not silently reset a translated button back to English.
let idleLabel = null;

function setRunning(on) {
  if (on && idleLabel === null) idleLabel = els.startBtn.textContent.trim() || FALLBACK_LABEL;
  els.startBtn.disabled     = on;
  els.topicSelect.disabled  = on;
  els.startBtn.textContent  = on ? RUNNING_LABEL : (idleLabel || FALLBACK_LABEL);
  if (!on) stage?.setAutoRotate(true);
}

// Every way a run can end badly funnels through here, so a stream that simply
// drops leaves the same honest wreckage as a server-sent `error`: the step that
// was in flight is marked failed instead of pulsing forever, the stale bubble
// goes, and the centre of the screen says what happened and how to retry.
function failRun(message, { badge = 'Trade stopped', label = 'x402 · oracle-market-analysis' } = {}) {
  clearPendingTimers();
  STEP_NAMES.forEach((s) => { if (chips[s]?.classList.contains('active')) setChip(s, 'error'); });
  hideBubble('buyer');
  hideBubble('seller');
  stage?.stopBeam();
  showToast(message);
  announce(`Demo stopped: ${message}`);
  setRunning(false);
  showErrorCard({ badge, label, message, action: { id: 'run-again', label: 'Run it again' } });
}

// Deferred touches (a chip settling to `done`, a bubble appearing a beat later)
// belong to the step that scheduled them. When the next event lands the step is
// over, so its pending timers are dropped: a slow proxy that delivers two events
// back to back used to let a stale timer re-show the previous step's bubble on
// top of the finished trade.
const pendingTimers = new Set();

function after(ms, fn) {
  const id = setTimeout(() => {
    pendingTimers.delete(id);
    fn();
  }, ms);
  pendingTimers.add(id);
}

function clearPendingTimers() {
  for (const id of pendingTimers) clearTimeout(id);
  pendingTimers.clear();
}

function handleEvent(ev) {
  clearPendingTimers();
  switch (ev.type) {
    case 'init': {
      setChip('init', 'done');
      if (ev.buyer?.address) {
        els.buyerAddr.textContent = fmt(ev.buyer.address);
        if (ev.buyer.sol != null) {
          const usd = ev.buyer.usd != null ? ` ($${ev.buyer.usd})` : '';
          els.buyerBal.textContent = ev.buyer.sol.toFixed(4) + ' SOL' + usd;
          els.buyerBal.style.color = 'var(--green)';
        }
      }
      if (ev.seller?.address) els.sellerAddr.textContent = fmt(ev.seller.address);
      if (ev.network) els.networkName.textContent = ev.network;
      stage?.setAutoRotate(false);
      stage?.flyCamera(vec3(0, 2.6, 8.8), vec3(0, 1.1, 0), 1200);
      break;
    }

    case 'request': {
      setChip('request', 'active');
      showBubble('buyer', `"${ev.message || 'I need a market analysis…'}"`);
      after(900, () => setChip('request', 'done'));
      break;
    }

    case 'challenged': {
      setChip('request', 'done');
      setChip('challenged', 'active');
      hideBubble('buyer');
      const m = ev.manifest || {};
      const price = m.price || {};
      const usdStr = price.usd != null ? ` ≈ $${price.usd}` : '';
      showBubble('seller', `402: ${price.sol} SOL required`);
      showCard(`
        <div class="c-badge c-badge-402">402 Payment Required</div>
        <div class="c-label">x402 Protocol · oracle-market-analysis</div>
        <div class="c-price blue">${escHtml(price.sol ?? '?')} SOL${escHtml(usdStr)}</div>
        <div class="c-row">Recipient <span>${escHtml(fmt(m.recipient))}</span></div>
        <div class="c-row">Network   <span>${escHtml(m.network || NO_VALUE)}</span></div>
        <div class="c-row">Memo      <span>${escHtml(m.memo || NO_VALUE)}</span></div>
        <div class="c-row">Currency  <span>${escHtml(m.currency || 'SOL')}</span></div>
      `);
      after(700, () => setChip('challenged', 'done'));
      break;
    }

    case 'paying': {
      setChip('challenged', 'done');
      setChip('paying', 'active');
      hideBubble('seller');
      // The centre stays clear so the payment beam is the thing you watch; the
      // bubble carries the pending bar, because a real transfer can take tens of
      // seconds and static text is indistinguishable from a stalled page.
      hideCard();
      showBubble('buyer', `Sending ${ev.sol} SOL on-chain…`, { pending: true });
      stage?.startBeam();
      // Fly camera to watch the beam from a low angle
      stage?.flyCamera(vec3(0, 1.6, 7.2), vec3(0, 0.9, 0), 950);
      break;
    }

    case 'confirmed': {
      setChip('paying', 'done');
      setChip('confirmed', 'active');
      stage?.triggerBurst();
      hideBubble('buyer');
      after(350, () => showBubble('seller', 'Payment confirmed ✓'));
      if (ev.newBuyerSol != null) {
        els.buyerBal.textContent = ev.newBuyerSol.toFixed(4) + ' SOL';
        els.buyerBal.style.color = 'var(--muted)';
      }
      const sigShort = ev.signature ? ev.signature.slice(0, 8) + '…' + ev.signature.slice(-6) : '';
      const usdStr = ev.usd != null ? ` ≈ $${ev.usd}` : '';
      const explorer = safeHref(ev.explorer);
      showCard(`
        <div class="c-badge c-badge-ok">✓ Transaction Confirmed</div>
        <div class="c-label">On-Chain · ${escHtml(ev.sol)} SOL${escHtml(usdStr)}</div>
        <div class="c-price green">${escHtml(ev.sol)} SOL</div>
        <div class="c-row">Signature <span>${escHtml(sigShort)}</span></div>
        <div class="c-row">Network   <span>${escHtml(ev.network || 'solana')}</span></div>
        ${explorer ? `<a class="c-link" href="${escHtml(explorer)}" target="_blank" rel="noopener">View on Solscan →</a>` : ''}
      `);
      after(800, () => setChip('confirmed', 'done'));
      break;
    }

    case 'delivering': {
      setChip('confirmed', 'done');
      setChip('delivering', 'active');
      // Hide the receipt now, not on a timer: a fast stream landed the
      // `delivered` card first and then this timeout wiped it off the screen.
      hideBubble('seller');
      hideCard();
      after(200, () => showBubble('seller', `Analyzing with ${ev.model}…`, { pending: true }));
      // Fly back to a wide view
      stage?.flyCamera(vec3(0, 3.0, 9.5), vec3(0, 1.2, 0), 1100);
      break;
    }

    case 'delivered': {
      setChip('delivering', 'done');
      setChip('delivered', 'done');
      hideBubble('seller');
      stage?.setAutoRotate(true);
      const explorer = safeHref(ev.explorer);
      showCard(`
        <div class="c-badge c-badge-ok">✓ Skill Delivered</div>
        <div class="c-label">${escHtml(ev.provider || 'AI')} · ${escHtml(ev.topic || '')}</div>
        <div class="c-content">${escHtml(ev.content || '')}</div>
        <div class="c-powered">
          Powered by ${escHtml(ev.model || ev.provider || '')}
          ${explorer ? `&nbsp;·&nbsp;<a class="c-link" style="display:inline" href="${escHtml(explorer)}" target="_blank" rel="noopener">tx →</a>` : ''}
        </div>
      `);
      announce('Trade complete. The analysis is on screen.');
      setRunning(false);
      break;
    }

    case 'error': {
      const msg = ev.message || 'Something went wrong';
      // A deployment with no wallets can never run: say so where the answer is,
      // rather than leaving a toast the user has to interpret. A "run it again"
      // button would be a lie here, so this branch keeps the walkthrough card.
      if (ev.code === 'not_configured') {
        STEP_NAMES.forEach((s) => { if (chips[s]?.classList.contains('active')) setChip(s, 'error'); });
        hideBubble('buyer');
        hideBubble('seller');
        stage?.stopBeam();
        showToast(msg);
        announce(`Demo stopped: ${msg}`);
        setRunning(false);
        els.startBtn.disabled = true;
        showUnconfiguredCard();
        openConfigOverlay();
        break;
      }
      failRun(msg, { badge: ERROR_BADGES[ev.code] || 'Trade stopped' });
      break;
    }
  }
}

// ── Start demo ───────────────────────────────────────────────────────────────
let currentEs = null;

function startDemo() {
  if (currentEs) { currentEs.close(); currentEs = null; }
  const topic = els.topicSelect.value;
  clearPendingTimers();
  setRunning(true);
  hideCard();
  hideBubble('buyer');
  hideBubble('seller');
  stage?.stopBeam();
  buildStepLog();
  announce(`Starting the x402 trade demo for ${topic}.`);

  const es = new EventSource(`/api/agent-trade/demo?topic=${encodeURIComponent(topic)}`);
  currentEs = es;

  es.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data);
      handleEvent(ev);
      if (ev.type === 'delivered' || ev.type === 'error') {
        es.close();
        currentEs = null;
      }
    } catch { /* malformed event: ignore */ }
  };

  es.onerror = () => {
    // Only a genuinely broken stream reaches here: a completed run closes the
    // EventSource in onmessage above.
    if (currentEs !== es) return;
    es.close();
    currentEs = null;
    failRun('The live stream dropped before the trade finished. Check your connection, then run it again.', {
      badge: 'Stream dropped',
    });
  };
}

els.startBtn.addEventListener('click', startDemo);

// ── Config pre-flight ─────────────────────────────────────────────────────────
async function checkConfig() {
  // Nothing is known yet, so nothing is offered yet: the button stays out of
  // reach until the answer lands, and the skeleton says the answer is coming.
  els.startBtn.disabled = true;
  showCheckingCard();
  try {
    const r = await fetch('/api/agent-trade/demo?check=1');
    if (!r.ok) throw new Error(`pre-flight ${r.status}`);
    const d = await r.json();
    if (!d.configured) {
      openConfigOverlay();
      els.startBtn.disabled = true;
      showUnconfiguredCard();
      return;
    }
    if (d.buyer?.address)  els.buyerAddr.textContent  = fmt(d.buyer.address);
    if (d.seller?.address) els.sellerAddr.textContent = fmt(d.seller.address);
    if (d.network) els.networkName.textContent = d.network;
    els.startBtn.disabled = false;
    showReadyCard(d);
  } catch {
    // The pre-flight is unreachable. Leave the button live (the run itself
    // reports the real failure) and put the retry where the user is looking,
    // because the toast is gone eight seconds later.
    els.startBtn.disabled = false;
    showToast('Could not reach the demo API for a status check. Running the demo will report what failed.');
    showErrorCard({
      badge: 'Status check failed',
      label: 'x402 · oracle-market-analysis',
      message: 'The demo API did not answer the wallet status check, so the balances above are unknown. Retry the check, or run the demo anyway and it will report what failed.',
      action: { id: 'retry-preflight', label: 'Retry the status check' },
    });
  }
}

checkConfig();
buildStepLog();
