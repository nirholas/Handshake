// Dragon section — adapted from pretext-playground (github.com/0xNyk/pretext-playground)
// Scoped to a container element, no external dependencies.
(function initDragonSection() {
  const container = document.getElementById('dragon-canvas-wrap');
  if (!container) return;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);

  let W = 0, H = 0, animId = null, initialized = false, paused = false;

  // ── Config ───────────────────────────────────────────────────
  const cfg = {
    dragonSegments: 55, dragonSpeed: 0.16, dragonScale: 1.0,
    showWings: true, showSpines: true,
    pushForce: 6, springStrength: 0.015, damping: 0.93,
    burnGravity: 0.8, fireRadius: 115, fireForce: 22,
    screenShake: true, showEmbers: true, showParticles: true,
    showRunes: true, showCursor: true, textOpacity: 1.0,
  };

  // ── Resize ───────────────────────────────────────────────────
  function resize() {
    W = container.clientWidth || 800;
    H = container.clientHeight || 500;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (initialized) { layoutAllText(); buildTunnel(); }
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // ── Mouse ────────────────────────────────────────────────────
  const mouse = { x: -1, y: -1 };
  let autoPilotT = 0;

  function effectiveMouse() {
    if (mouse.x >= 0) return mouse;
    return {
      x: W * 0.5 + Math.sin(autoPilotT * 0.7) * W * 0.28,
      y: H * 0.5 + Math.sin(autoPilotT * 0.5 + 1.2) * H * 0.22,
    };
  }

  function toLocal(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const sx = W / r.width, sy = H / r.height;
    return { x: (clientX - r.left) * sx, y: (clientY - r.top) * sy };
  }

  canvas.addEventListener('mousemove', (e) => { const c = toLocal(e.clientX, e.clientY); mouse.x = c.x; mouse.y = c.y; });
  canvas.addEventListener('mouseleave', () => { mouse.x = -1; mouse.y = -1; });
  canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    const c = toLocal(e.touches[0].clientX, e.touches[0].clientY);
    mouse.x = c.x; mouse.y = c.y;
  }, { passive: false });
  canvas.addEventListener('touchend', () => { mouse.x = -1; mouse.y = -1; isBreathingFire = false; });

  // ── Fire ─────────────────────────────────────────────────────
  let isBreathingFire = false, fireAccum = 0, totalFireTime = 0;
  canvas.addEventListener('mousedown', (e) => { if (e.button === 0) isBreathingFire = true; });
  canvas.addEventListener('mouseup', () => { isBreathingFire = false; });
  canvas.addEventListener('touchstart', () => { isBreathingFire = true; }, { passive: true });

  // ── Screen shake ─────────────────────────────────────────────
  let shakeIntensity = 0, shakeX = 0, shakeY = 0;
  function triggerShake(intensity) {
    if (!cfg.screenShake) return;
    shakeIntensity = Math.max(shakeIntensity, Math.min(intensity, 8));
  }
  function updateShake() {
    if (shakeIntensity > 0.1) {
      shakeX = (Math.random() - 0.5) * shakeIntensity;
      shakeY = (Math.random() - 0.5) * shakeIntensity;
      shakeIntensity *= 0.85;
    } else { shakeX = 0; shakeY = 0; shakeIntensity = 0; }
  }

  // ── Letters (struct-of-arrays) ────────────────────────────────
  const MAX_L = 2000;
  let lN = 0;
  const lHx = new Float32Array(MAX_L), lHy = new Float32Array(MAX_L);
  const lX  = new Float32Array(MAX_L), lY  = new Float32Array(MAX_L);
  const lVx = new Float32Array(MAX_L), lVy = new Float32Array(MAX_L);
  const lAng = new Float32Array(MAX_L), lAv = new Float32Array(MAX_L);
  const lCw  = new Float32Array(MAX_L), lAlpha = new Float32Array(MAX_L);
  const lFsz = new Float32Array(MAX_L), lBurn = new Float32Array(MAX_L);
  const lSm  = new Float32Array(MAX_L), lGrav = new Float32Array(MAX_L);
  const lChr = [], lFnt = [], lCol = [];

  // ── Embers ───────────────────────────────────────────────────
  const MAX_EM = 60;
  let emN = 0;
  const emX = new Float32Array(MAX_EM), emY = new Float32Array(MAX_EM);
  const emVx = new Float32Array(MAX_EM), emVy = new Float32Array(MAX_EM);
  const emLf = new Float32Array(MAX_EM), emSz = new Float32Array(MAX_EM);
  const emChr = new Array(MAX_EM), emCol = new Array(MAX_EM);
  const EMBER_C = ['·', '•', '∘', '˚'];
  const EMBER_K = ['#ff6600', '#ffaa00', '#ff4400'];

  function spawnEmber(x, y) {
    if (!cfg.showEmbers || emN >= MAX_EM) return;
    const i = emN++, a = Math.random() * Math.PI * 2;
    emX[i] = x; emY[i] = y;
    emVx[i] = Math.cos(a) * (1 + Math.random() * 3);
    emVy[i] = Math.sin(a) * (1 + Math.random() * 3) - 2;
    emLf[i] = 0.3 + Math.random() * 0.6;
    emSz[i] = 4 + Math.random() * 7;
    emChr[i] = EMBER_C[Math.random() * 4 | 0];
    emCol[i] = EMBER_K[Math.random() * 3 | 0];
  }

  // ── Particles ─────────────────────────────────────────────────
  const MAX_P = 150;
  let pN = 0;
  const pX = new Float32Array(MAX_P), pY = new Float32Array(MAX_P);
  const pVx = new Float32Array(MAX_P), pVy = new Float32Array(MAX_P);
  const pLf = new Float32Array(MAX_P), pMx = new Float32Array(MAX_P);
  const pSz = new Float32Array(MAX_P);
  const pChr = new Array(MAX_P);
  const FIRE_C = '*✦✧⁕❋✺◌•∘˚⋆·'.split('');

  // ── Text layout ───────────────────────────────────────────────
  function getEntries() {
    const MO = '"JetBrains Mono","Courier New",monospace';
    const DI = '"Inter Tight","Inter",sans-serif';
    const cl = (a, v, b) => Math.max(a, Math.min(b, v));
    const mob = W < 680;

    if (mob) return [
      { text: 'three.ws', font: `700 ${cl(60, W * 0.17, 110)}px ${DI}`, color: '#1c1c1c', alpha: 0.9,
        x: W * 0.5, y: H * 0.41, mw: W * 0.92, lh: cl(68, W * 0.19, 120), cx: true },
      { text: "The web wasn't built for presence.", font: `600 ${cl(20, W * 0.055, 30)}px ${DI}`, color: '#e8e8e8', alpha: 0.9,
        x: W * 0.05, y: H * 0.07, mw: W * 0.9, lh: cl(26, W * 0.065, 38) },
      { text: 'A living digital being that inhabits your space and works while you sleep.', font: `400 13px ${DI}`, color: '#a8a8a8', alpha: 0.7,
        x: W * 0.05, y: H * 0.27, mw: W * 0.9, lh: 18 },
      { text: '<agent-3d voice="true"></agent-3d>', font: `400 12px ${MO}`, color: '#6dbe74', alpha: 0.6,
        x: W * 0.05, y: H * 0.55, mw: W * 0.9, lh: 17 },
      { text: 'The flat web had its moment. The living web starts now.', font: `400 12px ${DI}`, color: '#5a5a5a', alpha: 0.45,
        x: W * 0.5, y: H * 0.85, mw: W * 0.8, lh: 17, cx: true },
    ];

    return [
      // Watermark
      { text: 'three.ws', font: `700 ${cl(80, W * 0.13, 160)}px ${DI}`, color: '#161616', alpha: 0.9,
        x: W * 0.5, y: H * 0.45, mw: W * 0.9, lh: cl(88, W * 0.145, 175), cx: true },
      // Headline left
      { text: "The web wasn't built for presence.", font: `600 ${cl(28, W * 0.034, 48)}px ${DI}`, color: '#e8e8e8', alpha: 0.95,
        x: W * 0.05, y: H * 0.07, mw: W * 0.41, lh: cl(34, W * 0.042, 56) },
      // Sub left
      { text: 'A living digital being that inhabits your space, knows your visitors, and works while you sleep.', font: `400 15px ${DI}`, color: '#a8a8a8', alpha: 0.72,
        x: W * 0.05, y: H * 0.29, mw: W * 0.37, lh: 22 },
      // Code left
      { text: '<agent-3d src="agent.glb" voice="true"></agent-3d>', font: `400 13px ${MO}`, color: '#6dbe74', alpha: 0.58,
        x: W * 0.05, y: H * 0.63, mw: W * 0.41, lh: 19 },
      // Headline right
      { text: 'Voice. Memory. Payments. Identity.', font: `600 ${cl(18, W * 0.022, 26)}px ${DI}`, color: '#e8e8e8', alpha: 0.88,
        x: W * 0.58, y: H * 0.08, mw: W * 0.36, lh: cl(22, W * 0.028, 32) },
      // Body right
      { text: 'Two hundred animations. Real-time voice. On-chain identity. Cross-device memory. Spatial multiplayer. One embed tag.', font: `400 13.5px ${DI}`, color: '#a8a8a8', alpha: 0.62,
        x: W * 0.58, y: H * 0.23, mw: W * 0.35, lh: 20 },
      // Features right
      { text: '✦ 3D from a selfie\n✦ x402 micropayments\n✦ ERC-8004 on-chain ID\n✦ A2A + MCP protocols\n✦ Spatial multiplayer', font: `400 12px ${MO}`, color: '#ff9955', alpha: 0.52,
        x: W * 0.58, y: H * 0.57, mw: W * 0.33, lh: 17, pre: true },
      // Bottom centre
      { text: 'The flat web had its moment. The living web starts now.', font: `400 15px ${DI}`, color: '#5a5a5a', alpha: 0.48,
        x: W * 0.5, y: H * 0.87, mw: W * 0.7, lh: 22, cx: true },
    ];
  }

  function layoutAllText() {
    lN = 0; lChr.length = 0; lFnt.length = 0; lCol.length = 0;
    for (const e of getEntries()) {
      ctx.font = e.font;
      const raws = e.pre ? e.text.split('\n') : [e.text];
      const lines = [];
      for (const raw of raws) {
        if (!raw) { lines.push(''); continue; }
        let line = '';
        for (const word of raw.split(' ')) {
          const test = line ? line + ' ' + word : word;
          if (ctx.measureText(test).width > e.mw && line) { lines.push(line); line = word; }
          else line = test;
        }
        if (line) lines.push(line);
      }
      for (let li = 0; li < lines.length; li++) {
        const txt = lines[li]; if (!txt) continue;
        const lw = ctx.measureText(txt).width;
        const lx = e.cx ? e.x - lw / 2 : e.x;
        const ly = e.y + li * e.lh;
        let xc = lx;
        for (const ch of txt) {
          if (lN >= MAX_L) break;
          const cw = ctx.measureText(ch).width;
          const i = lN++;
          lHx[i] = xc + cw / 2; lHy[i] = ly;
          lX[i] = lHx[i]; lY[i] = lHy[i];
          lVx[i] = 0; lVy[i] = 0; lAng[i] = 0; lAv[i] = 0;
          lCw[i] = cw; lAlpha[i] = e.alpha;
          lFsz[i] = parseFloat(e.font);
          lBurn[i] = 0; lSm[i] = 1; lGrav[i] = 0;
          lChr[i] = ch; lFnt[i] = e.font; lCol[i] = e.color;
          xc += cw;
        }
      }
    }
  }

  // ── Dragon chain ──────────────────────────────────────────────
  const SEG_SP = 10;
  let chainN = cfg.dragonSegments;
  let chX = new Float32Array(80), chY = new Float32Array(80);
  let chPx = new Float32Array(80), chPy = new Float32Array(80);
  const D_CHARS = '◆◆◇▼█▓▓▒╬╬╬╬╬╬╬╬╬╬╫╫╫╪╪╪╧╧╤╤╥╥║║││┃┃╎╎╏╏::····..'.split('');

  function rebuildDragon() {
    chainN = cfg.dragonSegments;
    for (let i = 0; i < chainN; i++) {
      chX[i] = W / 2; chY[i] = H / 2 + i * SEG_SP;
      chPx[i] = chX[i]; chPy[i] = chY[i];
    }
  }

  function segScale(i) {
    if (i < 3) return (2.5 - i * 0.15) * cfg.dragonScale;
    const t = (i - 3) / (chainN - 3);
    return (2.0 * (1 - t * t) + 0.2) * cfg.dragonScale;
  }

  function updateChain(mx, my) {
    for (let i = 0; i < chainN; i++) { chPx[i] = chX[i]; chPy[i] = chY[i]; }
    chX[0] += (mx - chX[0]) * cfg.dragonSpeed;
    chY[0] += (my - chY[0]) * cfg.dragonSpeed;
    for (let i = 1; i < chainN; i++) {
      const dx = chX[i] - chX[i - 1], dy = chY[i] - chY[i - 1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > SEG_SP) { const r = SEG_SP / d; chX[i] = chX[i - 1] + dx * r; chY[i] = chY[i - 1] + dy * r; }
    }
  }

  // ── Physics ───────────────────────────────────────────────────
  function interactLetters(dt) {
    const segs = Math.min(Math.round(chainN * 0.4), chainN);
    const { damping: damp, springStrength: sp, pushForce: push, burnGravity: bGrav } = cfg;
    for (let li = 0; li < lN; li++) {
      let vx = lVx[li], vy = lVy[li], av = lAv[li];
      const x = lX[li], y = lY[li], cw = lCw[li];
      for (let si = 0; si < segs; si++) {
        const sc = segScale(si), rad = 14 * sc * 0.45;
        const dx = x - chX[si], dy = y - chY[si];
        const dSq = dx * dx + dy * dy, minD = rad + cw * 0.4 + 4;
        if (dSq < minD * minD && dSq > 0.01) {
          const d = Math.sqrt(dSq), f = push * ((minD - d) / minD) * sc;
          const nx = dx / d, ny = dy / d;
          vx += nx * f + (chX[si] - chPx[si]) * 0.4;
          vy += ny * f + (chY[si] - chPy[si]) * 0.4;
          av += (nx * 0.3 - ny * 0.2) * f * 0.12;
        }
      }
      for (let si = 5; si < chainN; si += 5) {
        const dx = x - chX[si], dy = y - chY[si];
        const dSq = dx * dx + dy * dy;
        if (dSq < 1600 && dSq > 100) {
          const w = (1 - Math.sqrt(dSq) / 40) * 0.12;
          vx += (chX[si] - chPx[si]) * w;
          vy += (chY[si] - chPy[si]) * w;
        }
      }
      if (lBurn[li] > 0) {
        lBurn[li] -= dt; lSm[li] = 1 + lBurn[li] * 0.4; lGrav[li] = bGrav;
        if (Math.random() < dt * 2) spawnEmber(x, y);
        if (lBurn[li] <= 0) { lBurn[li] = 0; lSm[li] = 1; lGrav[li] = 0; }
      }
      const hdx = lHx[li] - x, hdy = lHy[li] - y;
      const hd = Math.sqrt(hdx * hdx + hdy * hdy);
      if (hd > 0.5) { const sf = sp * (1 + hd * 0.001); vx += hdx * sf; vy += hdy * sf; av -= lAng[li] * 0.05; }
      else lAng[li] *= 0.9;
      vy += lGrav[li];
      lVx[li] = vx * damp; lVy[li] = vy * damp;
      lAv[li] = av * 0.91;
      lX[li] = x + lVx[li]; lY[li] = y + lVy[li];
      lAng[li] += lAv[li];
    }
  }

  function fireBlastAt(bx, by, dx, dy) {
    let hits = 0;
    const rSq = cfg.fireRadius * cfg.fireRadius, ff = cfg.fireForce, fr = cfg.fireRadius;
    for (let li = 0; li < lN; li++) {
      const ldx = lX[li] - bx, ldy = lY[li] - by;
      const dSq = ldx * ldx + ldy * ldy;
      if (dSq < rSq && dSq > 0.01) {
        const d = Math.sqrt(dSq), f = ff * ((1 - d / fr) ** 2);
        lVx[li] += (ldx / d * 0.4 + dx * 0.6) * f;
        lVy[li] += (ldy / d * 0.4 + dy * 0.6) * f - f * 0.2;
        lAv[li] += (Math.random() - 0.5) * f * 0.3;
        lBurn[li] = Math.max(lBurn[li], 0.5 + Math.random() * 1.2);
        hits++;
      }
    }
    if (hits > 3) { triggerShake(Math.min(hits * 0.4, 6)); for (let i = 0; i < Math.min(hits, 4); i++) spawnEmber(bx, by); }
  }

  // ── Draw letters ──────────────────────────────────────────────
  function drawLetters() {
    let prevFont = '';
    for (let i = 0; i < lN; i++) {
      const burning = lBurn[i] > 0;
      let alpha = lAlpha[i] * cfg.textOpacity;
      let color = lCol[i];
      if (burning) {
        const h = Math.min(1, lBurn[i]);
        color = `rgb(255,${80 + h * 175 | 0},${h * 60 | 0})`;
        alpha = Math.min(1, alpha + 0.5);
      }
      const font = lFnt[i];
      if (font !== prevFont) { ctx.font = font; prevFont = font; }
      ctx.save();
      ctx.translate(lX[i], lY[i]);
      if (lAng[i] !== 0) ctx.rotate(lAng[i]);
      if (lSm[i] !== 1) ctx.scale(lSm[i], lSm[i]);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(lChr[i], 0, 0);
      if (burning && lBurn[i] > 0.3) {
        ctx.globalAlpha = lBurn[i] * 0.2;
        ctx.fillStyle = '#ffaa00';
        ctx.fillText(lChr[i], 0, 0);
      }
      ctx.restore();
    }
  }

  // ── Fire emission ─────────────────────────────────────────────
  function emitFire(dt) {
    if (!isBreathingFire) { totalFireTime = 0; return; }
    fireAccum += dt; totalFireTime += dt;
    const hx = chX[0], hy = chY[0];
    const ni = Math.min(3, chainN - 1);
    const fdx = hx - chX[ni], fdy = hy - chY[ni];
    const len = Math.sqrt(fdx * fdx + fdy * fdy) || 1;
    const dx = fdx / len, dy = fdy / len, angle = Math.atan2(fdy, fdx);
    if (cfg.showParticles) {
      while (fireAccum > 0.025) {
        fireAccum -= 0.025;
        if (pN >= MAX_P) break;
        for (let j = 0; j < 2; j++) {
          if (pN >= MAX_P) break;
          const i = pN++;
          const sp = (Math.random() - 0.5), spd = 5 + Math.random() * 7;
          pX[i] = hx + dx * 15; pY[i] = hy + dy * 15;
          pVx[i] = Math.cos(angle + sp) * spd; pVy[i] = Math.sin(angle + sp) * spd - Math.random();
          pLf[i] = 1; pMx[i] = 0.3 + Math.random() * 0.4;
          pSz[i] = 6 + Math.random() * 12;
          pChr[i] = FIRE_C[Math.random() * FIRE_C.length | 0];
        }
      }
    } else fireAccum = 0;
    fireBlastAt(hx + dx * 50, hy + dy * 50, dx, dy);
    triggerShake(Math.min(1 + totalFireTime * 0.2, 3));
  }

  function updateParticlesEmbers(dt) {
    for (let i = pN - 1; i >= 0; i--) {
      pX[i] += pVx[i]; pY[i] += pVy[i]; pVy[i] -= 0.25; pVx[i] *= 0.97;
      pLf[i] -= dt / pMx[i];
      if (pLf[i] <= 0) { pN--; pX[i]=pX[pN]; pY[i]=pY[pN]; pVx[i]=pVx[pN]; pVy[i]=pVy[pN]; pLf[i]=pLf[pN]; pMx[i]=pMx[pN]; pSz[i]=pSz[pN]; pChr[i]=pChr[pN]; }
    }
    for (let i = emN - 1; i >= 0; i--) {
      emX[i] += emVx[i]; emY[i] += emVy[i]; emVy[i] += 0.15; emVx[i] *= 0.97;
      emLf[i] -= dt;
      if (emLf[i] <= 0) { emN--; emX[i]=emX[emN]; emY[i]=emY[emN]; emVx[i]=emVx[emN]; emVy[i]=emVy[emN]; emLf[i]=emLf[emN]; emSz[i]=emSz[emN]; emChr[i]=emChr[emN]; emCol[i]=emCol[emN]; }
    }
  }

  function drawParticles() {
    const MO = '"JetBrains Mono","Courier New",monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    if (cfg.showEmbers) {
      for (let i = 0; i < emN; i++) {
        ctx.globalAlpha = Math.min(1, emLf[i] * 2);
        ctx.font = `${emSz[i]}px ${MO}`; ctx.fillStyle = emCol[i];
        ctx.fillText(emChr[i], emX[i], emY[i]);
      }
    }
    if (cfg.showParticles) {
      for (let i = 0; i < pN; i++) {
        const t = 1 - pLf[i];
        let r, g, b;
        if (t < 0.15)      { r = 255; g = 255; b = 255 * (1 - t * 6.67) | 0; }
        else if (t < 0.4)  { r = 255; g = 255 * (1 - (t - 0.15) * 3.2) | 0; b = 0; }
        else               { const f = (t - 0.4) * 1.67; r = 255 * (1 - f * 0.6) | 0; g = 80 * (1 - f) | 0; b = 0; }
        ctx.globalAlpha = pLf[i] * 0.85;
        ctx.font = `${pSz[i] * (0.4 + pLf[i] * 0.6)}px ${MO}`;
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillText(pChr[i], pX[i], pY[i]);
      }
    }
    ctx.globalAlpha = 1;
  }

  // ── Tunnel ────────────────────────────────────────────────────
  const TUNNEL_TXT = [
    'three.ws — the 3D agent layer',
    '代理 · エージェント · وكيل · 에이전트',
    'voice · memory · payments · identity',
    'ERC-8004 · A2A · MCP · x402',
    'presence over flatness',
    'the living web starts now',
  ];
  const TR = 12, TD = 1200;
  const tZ = new Float32Array(TR), tSide = new Uint8Array(TR), tTxt = new Uint8Array(TR);

  function buildTunnel() {
    for (let i = 0; i < TR; i++) { tZ[i] = (i / TR) * TD; tSide[i] = i % 4; tTxt[i] = i % TUNNEL_TXT.length; }
  }

  function drawTunnel() {
    const cx = W * 0.5, cy = H * 0.5;
    const MO = '"JetBrains Mono","Courier New",monospace';
    ctx.font = `13px ${MO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#ff8844';
    for (let i = 0; i < TR; i++) {
      tZ[i] -= 0.67;
      if (tZ[i] < 10) { tZ[i] += TD; tSide[i] = (tSide[i] + 1) % 4; tTxt[i] = Math.random() * TUNNEL_TXT.length | 0; }
      const sc = 400 / (400 + tZ[i]);
      const al = Math.max(0, Math.min(0.06, 0.08 * sc - 0.01));
      if (al < 0.003) continue;
      const sp = 350 * sc;
      const s = tSide[i];
      let x = cx, y = cy;
      if (s === 0) y = cy - sp;
      else if (s === 1) x = cx + sp;
      else if (s === 2) y = cy + sp;
      else x = cx - sp;
      ctx.globalAlpha = al;
      ctx.fillText(TUNNEL_TXT[tTxt[i]], x, y);
    }
    ctx.globalAlpha = 1;
  }

  // ── Runes ─────────────────────────────────────────────────────
  const RN = 8, RUNE_C = '龍火竜鱗焔ᚱᚦᛏ'.split('');
  const ruX = new Float32Array(RN), ruY = new Float32Array(RN);
  const ruSp = new Float32Array(RN), ruPh = new Float32Array(RN);
  const ruSz = new Float32Array(RN), ruOp = new Float32Array(RN);
  const ruC = [];
  for (let i = 0; i < RN; i++) {
    ruX[i] = Math.random(); ruY[i] = Math.random();
    ruSp[i] = 0.1 + Math.random() * 0.4; ruPh[i] = Math.random() * Math.PI * 2;
    ruSz[i] = 14 + Math.random() * 14; ruOp[i] = 0.02 + Math.random() * 0.04;
    ruC[i] = RUNE_C[Math.random() * RUNE_C.length | 0];
  }

  function drawRunes(time) {
    if (!cfg.showRunes) return;
    const MO = '"JetBrains Mono","Courier New",monospace';
    ctx.fillStyle = '#ff6600'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let i = 0; i < RN; i++) {
      ruY[i] -= ruSp[i] / H;
      if (ruY[i] < -30 / H) { ruY[i] = 1 + 30 / H; ruX[i] = Math.random(); }
      ctx.globalAlpha = ruOp[i] * (0.5 + Math.sin(time * 0.4 + ruPh[i]) * 0.5);
      ctx.font = `${ruSz[i]}px ${MO}`;
      ctx.fillText(ruC[i], ruX[i] * W + Math.sin(time * 0.7 + ruPh[i]) * 12, ruY[i] * H);
    }
    ctx.globalAlpha = 1;
  }

  // ── Draw dragon ───────────────────────────────────────────────
  function drawDragon(time, mx, my) {
    const MO = '"JetBrains Mono","Courier New",monospace';
    for (let i = chainN - 1; i >= 0; i--) {
      const sc = segScale(i), ci = Math.min(i, D_CHARS.length - 1), sz = 14 * sc;
      const t = i / chainN, p = Math.sin(time * 3 + i * 0.3) * 0.12;
      let color;
      if (i < 3) color = `rgb(255,${180 + p * 60 | 0},${40 + p * 30 | 0})`;
      else {
        const w = Math.sin(time * 2 - i * 0.15) * 0.15;
        color = `rgba(${(255 * (1 - t * 0.5) + p * 20) | 0},${(140 * (1 - t * 0.8) + w * 60) | 0},${(30 * (1 - t) + w * 20) | 0},${1 - t * 0.45})`;
      }
      const angle = i === 0
        ? Math.atan2(my - chY[0], mx - chX[0])
        : Math.atan2(chY[i - 1] - chY[i], chX[i - 1] - chX[i]);

      if (i < 4) {
        ctx.globalAlpha = 0.06 * (isBreathingFire ? 2 : 1);
        ctx.fillStyle = '#ff6600';
        ctx.beginPath(); ctx.arc(chX[i], chY[i], sz * 1.1, 0, Math.PI * 2); ctx.fill();
      }
      if (cfg.showSpines && i >= 4 && i <= 30 && i % 3 === 0) {
        const sa = angle + Math.PI / 2;
        ctx.globalAlpha = 0.35;
        ctx.font = `${sz * (0.6 + Math.sin(time * 3 + i) * 0.15)}px ${MO}`;
        ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('▴', chX[i] + Math.cos(sa) * sz * 0.35, chY[i] + Math.sin(sa) * sz * 0.35);
      }
      if (cfg.showWings && i >= 7 && i <= 16 && i % 2 === 0) {
        const wp = Math.sin(time * 3.5 + i * 0.4) * 0.5;
        const ws = sz * (1.8 - Math.abs(i - 11.5) * 0.12), wd = sz * 1.4;
        const w1 = angle + Math.PI / 2 + wp, w2 = angle - Math.PI / 2 - wp;
        ctx.globalAlpha = 0.4; ctx.font = `${ws}px ${MO}`;
        ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('≺', chX[i] + Math.cos(w1) * wd, chY[i] + Math.sin(w1) * wd);
        ctx.fillText('≻', chX[i] + Math.cos(w2) * wd, chY[i] + Math.sin(w2) * wd);
      }
      ctx.save(); ctx.translate(chX[i], chY[i]); ctx.rotate(angle);
      ctx.globalAlpha = 1; ctx.font = `bold ${sz}px ${MO}`; ctx.fillStyle = color;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(D_CHARS[ci], 0, Math.sin(time * 5 + i * 0.35) * 1.5);
      if (isBreathingFire && i < 3) {
        ctx.globalAlpha = 0.3; ctx.fillStyle = '#ffcc00';
        ctx.fillText(D_CHARS[ci], 0, Math.sin(time * 5 + i * 0.35) * 1.5);
      }
      ctx.restore();
    }
    // Eyes
    const ha = Math.atan2(my - chY[0], mx - chX[0]);
    const ex = chX[0] + Math.cos(ha + 0.5) * 10, ey = chY[0] + Math.sin(ha + 0.5) * 10;
    ctx.globalAlpha = isBreathingFire ? 0.2 : 0.1; ctx.fillStyle = '#ff8800';
    ctx.beginPath(); ctx.arc(ex, ey, isBreathingFire ? 18 : 12, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1; ctx.fillStyle = isBreathingFire ? '#fff' : '#ffcc00';
    ctx.font = `16px ${MO}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(time % 5 > 4.7 ? '—' : isBreathingFire ? '◉' : '⊙', ex, ey);
  }

  // ── Cursor overlay ────────────────────────────────────────────
  function drawCursor(time, mx, my) {
    if (!cfg.showCursor || mouse.x < 0) return;
    ctx.save(); ctx.translate(mx, my); ctx.rotate(time * 0.4);
    ctx.globalAlpha = 0.25; ctx.strokeStyle = '#ff8844'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, 16, 0, Math.PI * 0.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, 16, Math.PI, Math.PI * 1.5); ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = isBreathingFire ? 0.8 : 0.5;
    ctx.fillStyle = isBreathingFire ? '#ffaa33' : '#ff8844';
    ctx.beginPath(); ctx.arc(mx, my, isBreathingFire ? 3 : 2, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 0.15; ctx.strokeStyle = '#ff8844'; ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(mx - 24, my); ctx.lineTo(mx - 8, my);
    ctx.moveTo(mx + 8, my);  ctx.lineTo(mx + 24, my);
    ctx.moveTo(mx, my - 24); ctx.lineTo(mx, my - 8);
    ctx.moveTo(mx, my + 8);  ctx.lineTo(mx, my + 24);
    ctx.stroke(); ctx.globalAlpha = 1;
  }

  // ── Main loop ─────────────────────────────────────────────────
  let lastT = performance.now(), time = 0;
  const hint = container.querySelector('.dragon-hint');

  // Pause when scrolled fully out of view to save CPU
  let inView = true;
  const io = new IntersectionObserver((entries) => {
    inView = entries[0].isIntersecting;
    if (inView && !animId) { lastT = performance.now(); animId = requestAnimationFrame(frame); }
  }, { threshold: 0, rootMargin: '200px' });
  io.observe(container);

  function frame(now) {
    if (!inView) { animId = null; return; }
    const dt = Math.min((now - lastT) / 1000, 0.05);
    lastT = now; time += dt; autoPilotT += dt;

    const em = effectiveMouse();
    const mx = em.x, my = em.y;

    updateShake();
    ctx.save(); ctx.translate(shakeX, shakeY);
    ctx.fillStyle = '#050505'; ctx.fillRect(-10, -10, W + 20, H + 20);
    drawTunnel();
    drawRunes(time);
    updateChain(mx, my);
    interactLetters(dt);
    emitFire(dt);
    updateParticlesEmbers(dt);
    drawLetters();
    drawDragon(time, mx, my);
    drawParticles();
    drawCursor(time, mx, my);
    ctx.restore();

    if (hint && time > 5 && !hint.classList.contains('fade')) hint.classList.add('fade');

    animId = requestAnimationFrame(frame);
  }

  // Init
  resize();
  layoutAllText();
  buildTunnel();
  rebuildDragon();
  initialized = true;
  document.fonts.ready.then(() => layoutAllText());
  animId = requestAnimationFrame(frame);
})();
