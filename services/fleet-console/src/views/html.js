/**
 * Shared HTML shell: escaping, the design tokens, and the page chrome.
 *
 * Everything is inlined. The console ships no external stylesheet, font or
 * script, so it renders identically behind a strict CSP and stays readable if
 * the network drops halfway through a page load.
 */

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ENTITIES[char]);

export const attr = (value) => esc(value);

/** Human-readable relative time, past tense. */
export function ago(iso) {
	const then = Date.parse(iso || '');
	if (!Number.isFinite(then)) return 'never';
	const seconds = Math.max(1, Math.round((Date.now() - then) / 1000));
	const units = [
		[60, 'second'],
		[60, 'minute'],
		[24, 'hour'],
		[30, 'day'],
		[12, 'month'],
		[Number.POSITIVE_INFINITY, 'year']
	];
	let value = seconds;
	for (const [size, name] of units) {
		if (value < size) return `${Math.round(value)} ${name}${Math.round(value) === 1 ? '' : 's'} ago`;
		value /= size;
	}
	return 'a long time ago';
}

export const STYLES = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#f6f7f9; --surface:#fff; --surface-2:#eef1f6; --border:#dfe4ee;
  --text:#141824; --muted:#5b6478; --accent:#2358d8; --accent-soft:#e4ebfb;
  --good:#0f8a5f; --good-soft:#dff3e9; --warn:#96620a; --warn-soft:#fbeed3; --bad:#c0392f; --bad-soft:#fae1de;
  --ring:#2358d8; --shadow:0 1px 2px rgba(20,24,36,.06),0 8px 24px rgba(20,24,36,.06);
  --radius:14px; --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0a0c11; --surface:#12151d; --surface-2:#171c26; --border:#242a39;
    --text:#e7eaf2; --muted:#8d96ab; --accent:#7aa7ff; --accent-soft:#16233d;
    --good:#48d09a; --good-soft:#0f2b22; --warn:#f2bb4b; --warn-soft:#2d2410; --bad:#ff7d72; --bad-soft:#33191a;
    --ring:#7aa7ff; --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35);
  }
}
:root[data-theme="light"]{
  --bg:#f6f7f9; --surface:#fff; --surface-2:#eef1f6; --border:#dfe4ee;
  --text:#141824; --muted:#5b6478; --accent:#2358d8; --accent-soft:#e4ebfb;
  --good:#0f8a5f; --good-soft:#dff3e9; --warn:#96620a; --warn-soft:#fbeed3; --bad:#c0392f; --bad-soft:#fae1de;
  --ring:#2358d8; --shadow:0 1px 2px rgba(20,24,36,.06),0 8px 24px rgba(20,24,36,.06);
}
:root[data-theme="dark"]{
  --bg:#0a0c11; --surface:#12151d; --surface-2:#171c26; --border:#242a39;
  --text:#e7eaf2; --muted:#8d96ab; --accent:#7aa7ff; --accent-soft:#16233d;
  --good:#48d09a; --good-soft:#0f2b22; --warn:#f2bb4b; --warn-soft:#2d2410; --bad:#ff7d72; --bad-soft:#33191a;
  --ring:#7aa7ff; --shadow:0 1px 2px rgba(0,0,0,.4),0 10px 30px rgba(0,0,0,.35);
}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--text);
  font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Inter,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--accent); text-decoration:none}
a:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--ring); outline-offset:2px; border-radius:6px}
.wrap{max-width:1180px; margin:0 auto; padding:0 20px 72px}
.skip{position:absolute;left:-9999px}
.skip:focus{left:12px;top:12px;z-index:20;background:var(--surface);padding:10px 14px;border:1px solid var(--border);border-radius:8px}

header.top{position:sticky; top:0; z-index:10; background:color-mix(in srgb,var(--bg) 88%,transparent); backdrop-filter:blur(10px); border-bottom:1px solid var(--border)}
.top .wrap{padding:14px 20px; display:flex; align-items:center; gap:16px}
.brand{display:flex; align-items:center; gap:10px; font-weight:650; letter-spacing:-.01em; color:var(--text)}
.brand:hover{text-decoration:none}
.brand .dot{width:10px;height:10px;border-radius:50%;background:var(--good);box-shadow:0 0 0 4px var(--good-soft)}
.brand small{display:block;font-weight:450;color:var(--muted);font-size:12px;letter-spacing:0}
.top nav{margin-left:auto; display:flex; align-items:center; gap:6px; flex-wrap:wrap}
.btn{
  appearance:none; border:1px solid var(--border); background:var(--surface); color:var(--text);
  border-radius:9px; padding:7px 12px; font-size:13px; font-weight:520; cursor:pointer;
  transition:background .15s ease,border-color .15s ease,transform .1s ease;
}
.btn:hover{background:var(--surface-2); border-color:var(--muted)}
.btn:active{transform:translateY(1px)}
.btn[aria-pressed="true"]{background:var(--accent-soft); border-color:var(--accent); color:var(--accent)}

.hero{padding:34px 0 20px}
h1{margin:0 0 8px; font-size:30px; line-height:1.15; letter-spacing:-.02em}
.lede{margin:0; color:var(--muted); max-width:72ch}

.stats{display:grid; grid-template-columns:repeat(auto-fit,minmax(158px,1fr)); gap:12px; margin:24px 0 8px}
.stat{background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:14px 16px; box-shadow:var(--shadow)}
.stat .k{font-size:11px; text-transform:uppercase; letter-spacing:.07em; color:var(--muted); font-weight:600}
.stat .v{font-size:26px; font-weight:640; letter-spacing:-.02em; margin-top:4px; font-variant-numeric:tabular-nums}
.stat .s{font-size:12px; color:var(--muted); margin-top:2px}
.stat.good .v{color:var(--good)} .stat.warn .v{color:var(--warn)} .stat.bad .v{color:var(--bad)}

.toolbar{display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin:26px 0 16px; position:sticky; top:63px; z-index:9; padding:10px 0; background:linear-gradient(var(--bg) 70%,transparent)}
.search{flex:1 1 260px; min-width:200px; position:relative}
.search input{
  width:100%; padding:9px 12px 9px 34px; border-radius:10px; border:1px solid var(--border);
  background:var(--surface); color:var(--text); font-size:14px;
}
.search svg{position:absolute; left:11px; top:50%; transform:translateY(-50%); color:var(--muted)}
select.btn{padding-right:8px}

.grid{display:grid; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); gap:14px}
.card{
  background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:16px;
  display:flex; gap:14px; box-shadow:var(--shadow);
  transition:transform .14s ease,border-color .14s ease,box-shadow .14s ease;
}
.card:hover{transform:translateY(-2px); border-color:var(--accent)}
.card:focus-within{border-color:var(--accent)}
.card .body{min-width:0; flex:1}
.card h3{margin:0 0 4px; font-size:15px; letter-spacing:-.01em}
.card h3 a{color:var(--text)}
.card h3 a:hover{color:var(--accent)}
.card p{margin:0 0 10px; color:var(--muted); font-size:13px; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden}
.meta{display:flex; gap:10px; flex-wrap:wrap; font-size:12px; color:var(--muted); font-variant-numeric:tabular-nums}
.chips{display:flex; gap:6px; flex-wrap:wrap; margin-top:10px}
.chip{font-size:11px; font-weight:600; padding:3px 8px; border-radius:999px; border:1px solid transparent; white-space:nowrap}
.chip.good{background:var(--good-soft); color:var(--good); border-color:color-mix(in srgb,var(--good) 30%,transparent)}
.chip.warn{background:var(--warn-soft); color:var(--warn); border-color:color-mix(in srgb,var(--warn) 30%,transparent)}
.chip.bad{background:var(--bad-soft); color:var(--bad); border-color:color-mix(in srgb,var(--bad) 30%,transparent)}
.chip.mute{background:var(--surface-2); color:var(--muted); border-color:var(--border)}

.ring{flex:0 0 auto; width:58px; height:58px; position:relative}
.ring svg{transform:rotate(-90deg)}
.ring .num{position:absolute; inset:0; display:grid; place-items:center; font-weight:660; font-size:15px; font-variant-numeric:tabular-nums}
.ring .grade{position:absolute; left:50%; bottom:-9px; transform:translateX(-50%); font-size:10px; font-weight:700; letter-spacing:.06em; padding:1px 6px; border-radius:999px; background:var(--surface-2); border:1px solid var(--border)}

.empty{text-align:center; padding:64px 20px; border:1px dashed var(--border); border-radius:var(--radius); color:var(--muted)}
.empty h2{color:var(--text); margin:0 0 8px; font-size:19px}
.empty .btn{margin-top:14px}

.bar{height:8px; border-radius:999px; background:var(--surface-2); overflow:hidden; border:1px solid var(--border)}
.bar span{display:block; height:100%; background:var(--accent); transition:width .4s ease}

table{width:100%; border-collapse:collapse; font-size:13px}
th,td{text-align:left; padding:9px 10px; border-bottom:1px solid var(--border); vertical-align:top}
th{font-size:11px; text-transform:uppercase; letter-spacing:.06em; color:var(--muted)}
td.mono,.mono{font-family:var(--mono); font-size:12px; word-break:break-all}
.scroll{overflow-x:auto; -webkit-overflow-scrolling:touch}

.panel{background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); margin:18px 0; overflow:hidden}
.panel > h2{margin:0; padding:14px 16px; font-size:14px; border-bottom:1px solid var(--border); letter-spacing:-.01em}
.panel .pad{padding:16px}
.check{display:flex; gap:12px; padding:13px 16px; border-bottom:1px solid var(--border)}
.check:last-child{border-bottom:0}
.check .mark{flex:0 0 auto; width:20px; height:20px; border-radius:6px; display:grid; place-items:center; font-size:12px; font-weight:700; margin-top:1px}
.check .mark.pass{background:var(--good-soft); color:var(--good)}
.check .mark.warn{background:var(--warn-soft); color:var(--warn)}
.check .mark.fail{background:var(--bad-soft); color:var(--bad)}
.check .mark.skip{background:var(--surface-2); color:var(--muted)}
.check strong{display:block; font-size:13.5px; font-weight:600}
.check .ev{color:var(--muted); font-size:12.5px; margin-top:3px; word-break:break-word}
.check .fix{margin-top:6px; font-size:12.5px; padding:7px 10px; border-radius:8px; background:var(--accent-soft); color:var(--text); border-left:3px solid var(--accent)}

footer.foot{border-top:1px solid var(--border); margin-top:44px; padding:22px 0; color:var(--muted); font-size:12.5px}
.note{background:var(--warn-soft); border:1px solid color-mix(in srgb,var(--warn) 35%,transparent); color:var(--text); padding:11px 14px; border-radius:10px; font-size:13px; margin:16px 0}
.hidden{display:none !important}
@media (max-width:640px){
  h1{font-size:24px}
  .top .wrap{gap:10px}
  .brand small{display:none}
  .toolbar{position:static; background:none}
  .grid{grid-template-columns:1fr}
}
@media (prefers-reduced-motion:reduce){*{transition:none !important; animation:none !important}}
`;

/** Score ring, drawn as inline SVG so it needs no chart library. */
export function ring(score, grade) {
	const value = typeof score === 'number' ? Math.max(0, Math.min(100, score)) : 0;
	const radius = 24;
	const circumference = 2 * Math.PI * radius;
	const filled = (value / 100) * circumference;
	const tone = grade?.tone === 'good' ? 'var(--good)' : grade?.tone === 'warn' ? 'var(--warn)' : 'var(--bad)';
	const label = typeof score === 'number' ? `Health score ${value} out of 100, grade ${grade?.grade || '?'}` : 'Not scored';
	return `<div class="ring" role="img" aria-label="${attr(label)}">
  <svg width="58" height="58" viewBox="0 0 58 58" aria-hidden="true">
    <circle cx="29" cy="29" r="${radius}" fill="none" stroke="var(--surface-2)" stroke-width="5"/>
    <circle cx="29" cy="29" r="${radius}" fill="none" stroke="${tone}" stroke-width="5" stroke-linecap="round"
      stroke-dasharray="${filled.toFixed(2)} ${(circumference - filled).toFixed(2)}"/>
  </svg>
  <span class="num" aria-hidden="true">${typeof score === 'number' ? value : '?'}</span>
  <span class="grade" aria-hidden="true">${esc(grade?.grade || '?')}</span>
</div>`;
}

/** Sparkline of past scores, inline SVG. */
export function sparkline(points, { width = 220, height = 44 } = {}) {
	if (!points.length) return '<p class="mono" style="color:var(--muted)">No history yet. The next scan starts the trend line.</p>';
	if (points.length === 1) return `<p class="mono" style="color:var(--muted)">One data point so far: ${points[0].score}.</p>`;
	const values = points.map((point) => point.score);
	const min = Math.min(...values, 0);
	const max = Math.max(...values, 100);
	const span = max - min || 1;
	const step = width / (points.length - 1);
	const coords = points.map((point, index) => [index * step, height - ((point.score - min) / span) * (height - 6) - 3]);
	const line = coords.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
	const area = `${line} L${width},${height} L0,${height} Z`;
	const last = values[values.length - 1];
	const first = values[0];
	const tone = last >= first ? 'var(--good)' : 'var(--bad)';
	return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"
   aria-label="Score history: ${values.join(', ')}. Now ${last}, first recorded ${first}.">
  <path d="${area}" fill="${tone}" opacity=".12"/>
  <path d="${line}" fill="none" stroke="${tone}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
  <circle cx="${coords[coords.length - 1][0].toFixed(1)}" cy="${coords[coords.length - 1][1].toFixed(1)}" r="3" fill="${tone}"/>
</svg>`;
}

/**
 * Full page shell.
 * @param {{title:string, description:string, body:string, script?:string, owner:string}} input
 */
export function page({ title, description, body, script = '', owner }) {
	return `<!doctype html>
<html lang="en" data-theme="">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${attr(description)}">
<meta name="color-scheme" content="dark light">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="13" fill="none" stroke="%234ade80" stroke-width="5"/></svg>')}">
<style>${STYLES}</style>
<script>
(function(){try{var t=localStorage.getItem('fleet-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}})();
</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <div class="wrap">
    <a class="brand" href="/"><span class="dot" aria-hidden="true"></span><span>Fleet Console<small>${esc(owner)}</small></span></a>
    <nav>
      <a class="btn" href="/api/fleet">JSON API</a>
      <a class="btn" href="/docs">Docs</a>
      <button class="btn" id="theme" type="button" aria-label="Switch colour theme">Theme</button>
    </nav>
  </div>
</header>
<main id="main" class="wrap">
${body}
</main>
<footer class="foot">
  <div class="wrap" style="padding-bottom:0">
    Fleet Console probes the live internet on every scan. Every number on this page is measured, never assumed.
    <a href="/api/fleet">Machine-readable output</a> and <a href="/docs">documentation</a> are public.
  </div>
</footer>
<script>
(function(){
  var root=document.documentElement, btn=document.getElementById('theme');
  function current(){ return root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'); }
  btn && btn.addEventListener('click',function(){
    var next = current()==='dark' ? 'light' : 'dark';
    root.dataset.theme=next;
    try{ localStorage.setItem('fleet-theme',next); }catch(e){}
    btn.setAttribute('aria-label','Switch to '+(next==='dark'?'light':'dark')+' theme');
  });
})();
${script}
</script>
</body>
</html>`;
}
