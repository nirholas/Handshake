// three.ws Forge — per-seed share page. Server-rendered so every /?seed=… URL
// carries correct Open Graph + Twitter Card meta (the unfurl image is the
// actual rendered sculpture from /api/og). The page uses <model-viewer> for
// real AR: tap-to-place on iPhone (AR Quick Look, auto-USDZ) and Android
// (Scene Viewer), plus WebXR — no app install. Share via the native share
// sheet (Snapchat / iMessage / WhatsApp) or an X intent.

const TIER_COLORS = { Common: '#9aa3b8', Rare: '#5b8cff', Epic: '#b06bff', Legendary: '#ffb454', Mythic: '#ff5db4' };
const MODEL_RES = 150;

function esc(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function buildPage({ seed, traits, origin }) {
	const enc = encodeURIComponent(seed);
	const pageUrl = `${origin}/?seed=${enc}`;
	const glbUrl = `${origin}/api/forge?res=${MODEL_RES}&seed=${enc}`;
	const ogUrl = `${origin}/api/og?seed=${enc}`;
	const title = `${traits.name} — three.ws Forge`;
	const desc = `A one-of-one ${traits.tier} 3D sculpture forged from "${seed}". Tap to view it in AR, or download the GLB.`;
	const tierColor = TIER_COLORS[traits.tier] || '#9aa3b8';

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="three.ws Forge" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(desc)}" />
<meta property="og:url" content="${esc(pageUrl)}" />
<meta property="og:image" content="${esc(ogUrl)}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(desc)}" />
<meta name="twitter:image" content="${esc(ogUrl)}" />
<link rel="canonical" href="${esc(pageUrl)}" />
<script type="module" src="https://cdn.jsdelivr.net/npm/@google/model-viewer@3.5.0/dist/model-viewer.min.js"></script>
<style>
  :root { --bg:#05060a; --panel:#0c0e16; --panel-2:#10131e; --line:#1d2231; --line-2:#2a3146;
    --text:#eaeef7; --muted:#868da1; --accent:#7c5cff; --accent-2:#19d6a8; --radius:16px;
    --mono:ui-monospace,"SF Mono",Menlo,monospace; --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif; }
  * { box-sizing:border-box; } html,body { margin:0; min-height:100%; }
  body { font-family:var(--sans); color:var(--text); -webkit-font-smoothing:antialiased; background:
    radial-gradient(1200px 600px at 82% -12%, rgba(124,92,255,.18), transparent 60%),
    radial-gradient(900px 520px at -6% 4%, rgba(25,214,168,.10), transparent 55%), var(--bg); }
  .wrap { max-width:1120px; margin:0 auto; padding:34px 20px 64px; }
  .top { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:22px; }
  .brand { font-weight:800; letter-spacing:-.02em; font-size:20px; }
  .brand .g { background:linear-gradient(90deg,var(--accent),var(--accent-2)); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .badge { display:inline-flex; align-items:center; gap:8px; font-size:12px; color:var(--accent-2); border:1px solid var(--line); border-radius:999px; padding:5px 12px; background:var(--panel); }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--accent-2); animation:pulse 2s infinite; }
  @keyframes pulse { 0%{box-shadow:0 0 0 0 rgba(25,214,168,.5);} 70%{box-shadow:0 0 0 8px rgba(25,214,168,0);} 100%{box-shadow:0 0 0 0 rgba(25,214,168,0);} }
  .layout { display:grid; grid-template-columns:1.45fr 1fr; gap:18px; align-items:start; }
  @media (max-width:860px){ .layout { grid-template-columns:1fr; } }
  model-viewer { width:100%; height:560px; background:radial-gradient(120% 120% at 50% 0%, #0d1018 0%, #07090f 70%);
    border:1px solid var(--line); border-radius:var(--radius); --poster-color:transparent; }
  @media (max-width:860px){ model-viewer { height:60vh; } }
  .tier-badge { position:absolute; margin:16px; padding:7px 13px; border-radius:999px; font-size:12px; font-weight:700; letter-spacing:.04em;
    background:rgba(6,8,12,.7); border:1px solid var(--line-2); }
  .stagewrap { position:relative; }
  .panel { display:flex; flex-direction:column; gap:14px; }
  .card { background:linear-gradient(180deg,var(--panel),var(--panel-2)); border:1px solid var(--line); border-radius:var(--radius); padding:20px; }
  .name { font-size:26px; font-weight:800; letter-spacing:-.01em; }
  .seedline { color:var(--muted); font-family:var(--mono); font-size:12px; margin-top:4px; word-break:break-all; }
  .rarity-top { display:flex; justify-content:space-between; font-size:12px; color:var(--muted); margin:16px 0 6px; text-transform:uppercase; letter-spacing:.06em; }
  .rarity-bar { height:8px; border-radius:999px; background:var(--line); overflow:hidden; }
  .rarity-fill { height:100%; border-radius:999px; background:linear-gradient(90deg,var(--accent),var(--accent-2)); }
  .traits { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .trait .k { font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted); margin-bottom:3px; }
  .trait .v { font-size:16px; font-weight:600; }
  button, a.btn { border:0; border-radius:12px; padding:14px 18px; font-size:14px; font-weight:600; cursor:pointer; text-decoration:none; text-align:center; display:inline-block; font-family:var(--sans); transition:filter .15s,transform .1s; }
  .btn-primary { background:linear-gradient(90deg,var(--accent),#6b4cff); color:#fff; }
  .btn-ar { background:linear-gradient(90deg,var(--accent-2),#13b894); color:#04130f; }
  .btn-ghost { background:var(--panel); color:var(--text); border:1px solid var(--line); }
  button:hover, a.btn:hover { filter:brightness(1.08); } button:active { transform:translateY(1px); }
  .actions { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  .actions .full { grid-column:1 / -1; }
  .forge-form { display:flex; gap:10px; margin-top:6px; }
  .forge-form input { flex:1; min-width:0; background:var(--panel); border:1px solid var(--line); color:var(--text); border-radius:12px; padding:13px 15px; font-size:14px; font-family:var(--mono); outline:none; }
  .forge-form input:focus { border-color:var(--accent); box-shadow:0 0 0 3px rgba(124,92,255,.18); }
  .hint { color:var(--muted); font-size:12px; margin-top:10px; line-height:1.5; }
  .toast { position:fixed; bottom:22px; left:50%; transform:translateX(-50%) translateY(20px); background:var(--panel); border:1px solid var(--line-2); color:var(--text); padding:10px 18px; border-radius:10px; font-size:13px; opacity:0; pointer-events:none; transition:opacity .2s,transform .2s; }
  .toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
  footer { margin-top:26px; color:var(--muted); font-size:13px; line-height:1.7; }
  footer code { font-family:var(--mono); background:var(--panel); padding:2px 7px; border-radius:6px; border:1px solid var(--line); color:var(--text); }
  footer a { color:var(--accent); text-decoration:none; } footer a:hover { text-decoration:underline; }
</style>
</head>
<body>
<div class="wrap">
  <div class="top">
    <div class="brand">three.ws <span class="g">Forge</span></div>
    <span class="badge"><span class="dot"></span> Tap “View in AR” on your phone</span>
  </div>

  <div class="layout">
    <div class="stagewrap">
      <span class="tier-badge" style="color:${tierColor}">${esc(traits.tier).toUpperCase()}</span>
      <model-viewer
        src="${esc(glbUrl)}"
        alt="${esc(traits.name)}"
        poster="${esc(ogUrl)}"
        ar ar-modes="webxr scene-viewer quick-look" ar-scale="auto"
        camera-controls auto-rotate auto-rotate-delay="0" rotation-per-second="22deg"
        shadow-intensity="0.9" exposure="1.0" environment-image="neutral"
        interaction-prompt="none">
        <button slot="ar-button" class="btn btn-ar" style="position:absolute;bottom:16px;left:50%;transform:translateX(-50%)">📱 View in your space</button>
      </model-viewer>
    </div>

    <div class="panel">
      <div class="card">
        <div class="name">${esc(traits.name)}</div>
        <div class="seedline">seed: ${esc(seed)}</div>
        <div class="rarity-top"><span>Rarity · ${esc(traits.tier)}</span><span>${traits.rarity}/100</span></div>
        <div class="rarity-bar"><div class="rarity-fill" style="width:${traits.rarity}%"></div></div>
      </div>

      <div class="card"><div class="traits">
        <div class="trait"><div class="k">Form</div><div class="v">${esc(traits.form)}</div></div>
        <div class="trait"><div class="k">Finish</div><div class="v">${esc(traits.finish)}</div></div>
        <div class="trait"><div class="k">Symmetry</div><div class="v">${traits.symmetry.lat} × ${traits.symmetry.lon}</div></div>
        <div class="trait"><div class="k">Spikiness</div><div class="v">${traits.spikiness}</div></div>
      </div></div>

      <div class="card">
        <div class="actions">
          <button class="btn-ghost full" id="ar2">📱 View in your space (AR)</button>
          <button class="btn-primary" id="share">Share</button>
          <a class="btn btn-ghost" id="tweet" target="_blank" rel="noopener">Post to X</a>
          <a class="btn btn-ghost full" href="${esc(glbUrl)}" download="${esc(seed).slice(0, 40)}.glb">Download .glb</a>
        </div>
        <div class="hint">On iPhone this opens in AR Quick Look; on Android, Scene Viewer. No app needed.</div>
      </div>

      <div class="card">
        <form class="forge-form" method="GET" action="/">
          <input type="text" name="seed" placeholder="Forge another seed…" autocomplete="off" spellcheck="false" />
          <button class="btn-primary" type="submit">Forge</button>
        </form>
      </div>
    </div>
  </div>

  <footer>
    <p>Public API · <code>GET /api/forge?seed=…</code> → GLB · <code>GET /api/og?seed=…</code> → preview image · <code>GET /api/forge.json?seed=…</code> → traits.</p>
    <p>Geometry synthesized from the Gielis superformula, spec-valid glTF 2.0. Part of <a href="https://three.ws">three.ws</a>, the platform for 3D AI agents on-chain.</p>
  </footer>
</div>
<div class="toast" id="toast"></div>

<script>
  var pageUrl = ${JSON.stringify(pageUrl)};
  var shareText = ${JSON.stringify(`${traits.name} — a ${traits.tier} 3D sculpture I forged on three.ws. Tap to drop it into your room in AR 👇`)};
  function toast(m){ var t=document.getElementById('toast'); t.textContent=m; t.classList.add('show'); setTimeout(function(){t.classList.remove('show');},1800); }

  var mv = document.querySelector('model-viewer');
  document.getElementById('ar2').addEventListener('click', function(){
    if (mv && mv.canActivateAR) { mv.activateAR(); }
    else { toast('AR works on a phone — open this link on iOS or Android.'); }
  });

  document.getElementById('share').addEventListener('click', async function(){
    if (navigator.share) {
      try { await navigator.share({ title: 'three.ws Forge', text: shareText, url: pageUrl }); } catch (e) {}
    } else {
      try { await navigator.clipboard.writeText(pageUrl); toast('Link copied'); } catch (e) { toast(pageUrl); }
    }
  });

  document.getElementById('tweet').href =
    'https://twitter.com/intent/tweet?text=' + encodeURIComponent(shareText) + '&url=' + encodeURIComponent(pageUrl);
</script>
</body>
</html>`;
}
