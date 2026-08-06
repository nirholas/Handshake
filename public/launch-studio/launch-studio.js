// Launch Studio — a catalog of coin-launch recipes with LIVE previews of what
// each would mint right now, and one-click handoff to the real /launch wizard.
//
// Reads /api/pump/launch-studio (list + preview). Designed to be the most
// polished surface on the platform: instant search, category theming, favorites,
// keyboard navigation, a live preview drawer with signal-strength bars, a
// reward-target planner (GitHub / X / wallet / cashback / buyback), and a dev-buy
// slider wired straight into the launch deep-link.
//
// Entry: mountLaunchStudio(root) → { teardown }

const API = '/api/pump/launch-studio';
const FAV_KEY = 'ls:favs';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
	({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

// Per-category identity: icon + accent colour (drives card accent, chip, glow).
const CATEGORY_META = {
	github:    { label: 'GitHub',    icon: '⌥', hue: 145, blurb: 'Reward coins for trending repos & creators' },
	onchain:   { label: 'Onchain',   icon: '◎', hue: 265, blurb: 'pump.fun venue signals & hot sectors' },
	news:      { label: 'News',      icon: '◈', hue: 205, blurb: 'Tech zeitgeist & real-time attention' },
	culture:   { label: 'Culture',   icon: '✦', hue: 320, blurb: 'Memes & community pulse' },
	events:    { label: 'Events',    icon: '★', hue: 40,  blurb: 'What the world is looking up' },
	community: { label: 'Community', icon: '⬡', hue: 175, blurb: 'Builders, ecosystems & blends' },
};
const hue = (cat) => (CATEGORY_META[cat]?.hue ?? 150);

// Reward-target planner options. `needs` = extra input required.
const REWARD_TARGETS = [
	{ id: 'default',  label: 'As designed', hint: 'Use the recipe’s built-in routing' },
	{ id: 'creator',  label: 'Creator',     hint: 'Fees stay with the launching wallet' },
	{ id: 'github',   label: 'GitHub @user', hint: 'Route 100% to a GitHub account', needs: 'handle' },
	{ id: 'x',        label: 'X @handle',    hint: 'Route 100% to an X (Twitter) account', needs: 'handle' },
	{ id: 'wallet',   label: 'Wallet / .sol', hint: 'Route 100% to a Solana address or .sol name', needs: 'address' },
	{ id: 'cashback', label: 'Cashback',     hint: 'Trading fees return to holders' },
	{ id: 'buyback',  label: 'Buyback',      hint: 'Fees auto-buy-back & burn the coin' },
];

const CSS = `
.ls{--line:rgba(255,255,255,.08);--line2:rgba(255,255,255,.14);--ink:rgba(255,255,255,.92);--dim:rgba(255,255,255,.5);color:var(--ink);
  --ease:cubic-bezier(.22,.61,.36,1)}
.ls *{box-sizing:border-box}
.ls-tools{position:sticky;top:0;z-index:5;display:flex;flex-direction:column;gap:.7rem;padding:.7rem 0 .8rem;margin-bottom:.4rem;
  background:linear-gradient(180deg,#0b0e14 72%,rgba(11,14,20,0));backdrop-filter:blur(6px)}
.ls-search-row{display:flex;gap:.5rem;align-items:center}
.ls-search{flex:1;position:relative;min-width:0}
.ls-search input{width:100%;padding:.66rem .8rem .66rem 2.1rem;border-radius:11px;outline:none;font-size:.85rem;
  background:rgba(255,255,255,.045);border:1px solid var(--line);color:#fff;transition:border-color .15s,background .15s}
.ls-search input:focus{border-color:rgba(164,240,188,.5);background:rgba(255,255,255,.06)}
.ls-search input::placeholder{color:rgba(255,255,255,.32)}
.ls-search .ls-mag{position:absolute;left:.72rem;top:50%;transform:translateY(-50%);color:rgba(255,255,255,.35);font-size:.9rem;pointer-events:none}
.ls-search .ls-kbd{position:absolute;right:.6rem;top:50%;transform:translateY(-50%);font-size:.62rem;color:rgba(255,255,255,.3);
  border:1px solid var(--line2);border-radius:5px;padding:.08rem .3rem;font-family:ui-monospace,monospace}
.ls-surprise{white-space:nowrap;font-size:.78rem;font-weight:650;padding:.62rem .8rem;border-radius:11px;cursor:pointer;
  background:linear-gradient(135deg,rgba(180,140,240,.2),rgba(120,90,220,.14));border:1px solid rgba(170,130,240,.4);color:#e2d4fb;transition:all .15s}
.ls-surprise:hover{background:linear-gradient(135deg,rgba(180,140,240,.32),rgba(120,90,220,.2));border-color:rgba(170,130,240,.65);transform:translateY(-1px)}
.ls-tabs{display:flex;gap:.4rem;flex-wrap:wrap;align-items:center}
.ls-tab{display:inline-flex;align-items:center;gap:.4rem;font-size:.76rem;font-weight:600;padding:.4rem .68rem;border-radius:999px;cursor:pointer;
  background:rgba(255,255,255,.035);border:1px solid var(--line);color:var(--dim);transition:all .15s;white-space:nowrap}
.ls-tab:hover{color:#fff;border-color:var(--line2);transform:translateY(-1px)}
.ls-tab.on{color:#fff}
.ls-tab .n{font-size:.64rem;opacity:.65;font-weight:600}
.ls-modeseg{margin-left:auto;display:inline-flex;background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:999px;padding:.14rem}
.ls-modeseg button{font-size:.7rem;font-weight:650;padding:.3rem .62rem;border-radius:999px;cursor:pointer;background:none;border:none;color:var(--dim);transition:all .15s}
.ls-modeseg button.on{background:rgba(255,255,255,.1);color:#fff}
.ls-modeseg button:hover:not(.on){color:#fff}

.ls-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:.75rem}
.ls-card{position:relative;display:flex;flex-direction:column;gap:.55rem;padding:.9rem .95rem .9rem 1.1rem;border-radius:14px;cursor:pointer;text-align:left;overflow:hidden;
  background:rgba(255,255,255,.028);border:1px solid var(--line);transition:transform .18s var(--ease),border-color .15s,background .15s,box-shadow .2s}
.ls-card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px;background:hsl(var(--h) 70% 62%);opacity:.75;transition:opacity .15s}
.ls-card:hover{transform:translateY(-3px);background:rgba(255,255,255,.05);border-color:var(--line2);box-shadow:0 10px 30px -12px hsl(var(--h) 70% 40% / .5)}
.ls-card:hover::before{opacity:1}
.ls-card:focus-visible{outline:2px solid hsl(var(--h) 70% 62%);outline-offset:2px}
.ls-card.on{border-color:hsl(var(--h) 70% 55% / .6);background:hsl(var(--h) 60% 50% / .07)}
.ls-card-top{display:flex;align-items:center;gap:.5rem}
.ls-card-ic{width:26px;height:26px;flex-shrink:0;display:grid;place-items:center;border-radius:8px;font-size:.82rem;
  background:hsl(var(--h) 60% 55% / .14);color:hsl(var(--h) 75% 72%);border:1px solid hsl(var(--h) 60% 55% / .28)}
.ls-card-t{font-size:.87rem;font-weight:650;letter-spacing:-.01em;line-height:1.25;flex:1;min-width:0}
.ls-fav{flex-shrink:0;width:24px;height:24px;border-radius:7px;border:none;background:none;cursor:pointer;color:rgba(255,255,255,.28);font-size:.9rem;line-height:1;transition:color .15s,transform .15s}
.ls-fav:hover{color:#f6d878;transform:scale(1.15)}
.ls-fav.on{color:#f6d878}
.ls-card-d{font-size:.73rem;color:var(--dim);line-height:1.5}
.ls-card-foot{display:flex;align-items:center;gap:.4rem;margin-top:auto;flex-wrap:wrap}
.ls-mode{font-size:.58rem;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:.16rem .42rem;border-radius:999px}
.ls-mode.attribution{color:#a8c4f0;background:rgba(120,160,240,.14);border:1px solid rgba(120,160,240,.32)}
.ls-mode.narrative{color:#e6d3a6;background:rgba(240,205,130,.1);border:1px solid rgba(240,205,130,.28)}
.ls-card-r{font-size:.66rem;color:hsl(var(--h) 60% 70%);display:flex;align-items:center;gap:.3rem;margin-left:auto}

.ls-msg{padding:1.6rem;text-align:center;font-size:.82rem;color:var(--dim);border:1px dashed var(--line2);border-radius:14px;line-height:1.6}
.ls-msg b{color:#fff;display:block;margin-bottom:.35rem;font-size:.95rem}
.ls-msg .ls-btn{margin-top:.7rem}
.ls-err{color:#f6b3b3;border-color:rgba(246,179,179,.28)}
.ls-btn{display:inline-flex;align-items:center;gap:.4rem;font-size:.76rem;font-weight:650;padding:.44rem .78rem;border-radius:9px;cursor:pointer;text-decoration:none;
  background:rgba(255,255,255,.06);border:1px solid var(--line2);color:rgba(255,255,255,.82);transition:all .15s}
.ls-btn:hover{background:rgba(255,255,255,.11);color:#fff}
.ls-btn.primary{background:linear-gradient(135deg,rgba(120,200,140,.24),rgba(60,140,100,.15));border-color:rgba(120,200,140,.45);color:#d2f3df}
.ls-btn.primary:hover{background:linear-gradient(135deg,rgba(120,200,140,.36),rgba(60,140,100,.24));border-color:rgba(120,200,140,.7)}

.ls-skel{border-radius:14px;background:linear-gradient(100deg,rgba(255,255,255,.03) 30%,rgba(255,255,255,.07) 50%,rgba(255,255,255,.03) 70%);
  background-size:200% 100%;animation:ls-sh 1.3s linear infinite;height:132px}
@keyframes ls-sh{to{background-position:-200% 0}}

/* Preview drawer */
.ls-drawer{position:fixed;inset:0;z-index:60;display:flex;justify-content:flex-end;pointer-events:none}
.ls-drawer.open{pointer-events:auto}
.ls-scrim{position:absolute;inset:0;background:rgba(4,6,10,.62);opacity:0;transition:opacity .25s var(--ease);backdrop-filter:blur(2px)}
.ls-drawer.open .ls-scrim{opacity:1}
.ls-panel{position:relative;width:min(560px,100%);height:100%;overflow-y:auto;background:#0d1119;border-left:1px solid var(--line2);
  box-shadow:-30px 0 60px -20px rgba(0,0,0,.7);transform:translateX(100%);transition:transform .3s var(--ease);padding:1.1rem 1.2rem 2.4rem}
.ls-drawer.open .ls-panel{transform:none}
.ls-ph{display:flex;align-items:flex-start;gap:.6rem;position:sticky;top:-1.1rem;background:linear-gradient(180deg,#0d1119 80%,rgba(13,17,25,0));padding:.3rem 0 .7rem;margin:-.3rem 0 0;z-index:2}
.ls-ph-ic{width:34px;height:34px;flex-shrink:0;display:grid;place-items:center;border-radius:10px;font-size:1rem;
  background:hsl(var(--h) 60% 55% / .16);color:hsl(var(--h) 75% 72%);border:1px solid hsl(var(--h) 60% 55% / .3)}
.ls-ph-tt{flex:1;min-width:0}
.ls-ph-tt h3{font-size:1.02rem;font-weight:700;letter-spacing:-.02em;margin:0 0 .12rem}
.ls-ph-tt p{font-size:.72rem;color:var(--dim);margin:0;line-height:1.45}
.ls-x{flex-shrink:0;width:30px;height:30px;border-radius:8px;border:1px solid var(--line2);background:rgba(255,255,255,.04);color:var(--dim);cursor:pointer;font-size:1rem;line-height:1;transition:all .15s}
.ls-x:hover{background:rgba(255,255,255,.1);color:#fff}

.ls-ctrls{display:flex;flex-direction:column;gap:.6rem;padding:.85rem;border-radius:12px;background:rgba(255,255,255,.025);border:1px solid var(--line);margin:.3rem 0 1rem}
.ls-ctrl-l{font-size:.66rem;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:rgba(255,255,255,.42);margin-bottom:.38rem}
.ls-rt{display:flex;gap:.3rem;flex-wrap:wrap}
.ls-rt button{font-size:.68rem;font-weight:600;padding:.32rem .55rem;border-radius:8px;cursor:pointer;
  background:rgba(255,255,255,.04);border:1px solid var(--line);color:var(--dim);transition:all .13s}
.ls-rt button:hover{color:#fff;border-color:var(--line2)}
.ls-rt button.on{background:rgba(164,240,188,.13);border-color:rgba(164,240,188,.42);color:#c8f0d8}
.ls-rt-input{margin-top:.5rem;width:100%;padding:.42rem .6rem;border-radius:8px;outline:none;font-size:.74rem;font-family:ui-monospace,monospace;
  background:rgba(255,255,255,.04);border:1px solid var(--line);color:#fff}
.ls-rt-input:focus{border-color:rgba(164,240,188,.45)}
.ls-rt-hint{font-size:.66rem;color:rgba(255,255,255,.4);margin-top:.35rem;line-height:1.4}
.ls-slider-row{display:flex;align-items:center;gap:.6rem}
.ls-slider-row input[type=range]{flex:1;accent-color:#a4f0bc}
.ls-slider-v{font-size:.74rem;font-family:ui-monospace,monospace;color:#c8f0d8;min-width:4.5rem;text-align:right}
.ls-netseg{display:inline-flex;background:rgba(255,255,255,.04);border:1px solid var(--line);border-radius:8px;padding:.12rem}
.ls-netseg button{font-size:.68rem;font-weight:600;padding:.26rem .5rem;border-radius:6px;cursor:pointer;background:none;border:none;color:var(--dim)}
.ls-netseg button.on{background:rgba(255,255,255,.1);color:#fff}

.ls-coins{display:flex;flex-direction:column;gap:.55rem}
.ls-coin{display:flex;flex-direction:column;gap:.5rem;padding:.75rem;border-radius:12px;background:rgba(255,255,255,.03);border:1px solid var(--line);
  animation:ls-in .35s var(--ease) both}
@keyframes ls-in{from{opacity:0;transform:translateY(8px)}}
.ls-coin-top{display:flex;align-items:center;gap:.6rem}
.ls-coin-img{width:40px;height:40px;border-radius:10px;object-fit:cover;background:rgba(255,255,255,.06);flex-shrink:0}
.ls-coin-ph{width:40px;height:40px;border-radius:10px;flex-shrink:0;display:grid;place-items:center;font-weight:800;font-size:.95rem;color:#0c1410;
  background:hsl(var(--h) 65% 62%)}
.ls-coin-id{flex:1;min-width:0}
.ls-coin-n{font-size:.9rem;font-weight:700;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ls-coin-s{font-size:.68rem;color:var(--dim);font-family:ui-monospace,monospace}
.ls-copy{flex-shrink:0;width:28px;height:28px;border-radius:7px;border:1px solid var(--line);background:rgba(255,255,255,.04);color:var(--dim);cursor:pointer;font-size:.78rem;transition:all .13s}
.ls-copy:hover{background:rgba(255,255,255,.1);color:#fff}
.ls-coin-d{font-size:.72rem;color:rgba(255,255,255,.58);line-height:1.5}
.ls-bar{height:4px;border-radius:999px;background:rgba(255,255,255,.07);overflow:hidden}
.ls-bar>i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,hsl(var(--h) 70% 55%),hsl(var(--h) 80% 68%))}
.ls-coin-meta{display:flex;align-items:center;gap:.4rem;flex-wrap:wrap;font-size:.65rem}
.ls-tag{color:rgba(255,255,255,.42);background:rgba(255,255,255,.04);border:1px solid var(--line);padding:.15rem .42rem;border-radius:6px}
.ls-tag.reward{color:#9fdcb4;background:rgba(164,240,188,.07);border-color:rgba(164,240,188,.2)}
.ls-tag.reward.pending{color:#e6cf96;background:rgba(240,205,130,.07);border-color:rgba(240,205,130,.2)}
.ls-coin-go{margin-top:.15rem;display:flex;align-items:center;justify-content:center;gap:.4rem;font-size:.78rem;font-weight:700;padding:.55rem;border-radius:10px;
  text-decoration:none;background:linear-gradient(135deg,rgba(120,200,140,.24),rgba(60,140,100,.15));border:1px solid rgba(120,200,140,.45);color:#d2f3df;transition:all .15s}
.ls-coin-go:hover{background:linear-gradient(135deg,rgba(120,200,140,.38),rgba(60,140,100,.24));border-color:rgba(120,200,140,.72)}
.ls-toast{position:fixed;bottom:22px;left:50%;transform:translateX(-50%) translateY(20px);z-index:80;font-size:.78rem;font-weight:600;color:#0c1410;
  background:#a4f0bc;padding:.5rem .9rem;border-radius:10px;opacity:0;transition:all .25s var(--ease);pointer-events:none;box-shadow:0 8px 24px -8px rgba(0,0,0,.5)}
.ls-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
@media(max-width:560px){.ls-grid{grid-template-columns:1fr}.ls-modeseg{margin-left:0}}
@media(prefers-reduced-motion:reduce){.ls *{animation-duration:.01ms!important;transition-duration:.01ms!important}}
`;

export function mountLaunchStudio(root) {
	if (!document.getElementById('ls-css')) {
		const st = document.createElement('style'); st.id = 'ls-css'; st.textContent = CSS; document.head.appendChild(st);
	}
	let favs = new Set();
	try { favs = new Set(JSON.parse(localStorage.getItem(FAV_KEY) || '[]')); } catch { /* ignore */ }

	const s = {
		cats: [], useCases: [], total: 0,
		q: '', activeCat: 'all', mode: 'all',
		listLoading: true, listError: '',
		// drawer
		open: false, activeId: null, preview: null, previewLoading: false, previewError: '',
		rt: 'default', rtValue: '', devBuy: 0, network: 'mainnet',
	};
	let alive = true;
	const saveFavs = () => { try { localStorage.setItem(FAV_KEY, JSON.stringify([...favs])); } catch { /* ignore */ } };

	// ── data ────────────────────────────────────────────────────────────────
	async function loadList() {
		s.listLoading = true; s.listError = ''; renderGrid();
		try {
			const r = await fetch(`${API}?action=list`, { headers: { accept: 'application/json' } });
			const d = await r.json();
			if (!r.ok) throw new Error(d.error_description || d.error || `HTTP ${r.status}`);
			s.cats = d.categories || []; s.useCases = d.use_cases || []; s.total = d.count || s.useCases.length;
		} catch (e) { s.listError = e.message || String(e); }
		s.listLoading = false; renderAll();
	}

	async function loadPreview(id) {
		s.previewLoading = true; s.previewError = ''; s.preview = null; renderDrawer();
		try {
			const r = await fetch(`${API}?action=preview&id=${encodeURIComponent(id)}&limit=6&network=${s.network}`, { headers: { accept: 'application/json' } });
			const d = await r.json();
			if (!r.ok) throw new Error(d.error_description || d.error || `HTTP ${r.status}`);
			if (!alive || s.activeId !== id) return;
			s.preview = d;
		} catch (e) { s.previewError = e.message || String(e); }
		s.previewLoading = false; renderDrawer();
	}

	// ── filtering ─────────────────────────────────────────────────────────────
	function filtered() {
		const q = s.q.trim().toLowerCase();
		return s.useCases.filter((u) => {
			if (s.activeCat === 'saved') { if (!favs.has(u.id)) return false; }
			else if (s.activeCat !== 'all' && u.category !== s.activeCat) return false;
			if (s.mode !== 'all' && u.mode !== s.mode) return false;
			if (q && !(`${u.title} ${u.description} ${(u.tags || []).join(' ')} ${u.category}`.toLowerCase().includes(q))) return false;
			return true;
		});
	}

	// ── reward planner ──────────────────────────────────────────────────────────
	function effectiveReward(item) {
		const t = s.rt;
		if (t === 'default') return item.reward;
		if (t === 'creator') return { kind: 'creator', note: 'Fees stay with the launching wallet.' };
		if (t === 'cashback') return { kind: 'cashback', note: 'Trading fees return to holders as cashback.' };
		if (t === 'buyback') return { kind: 'buyback', note: 'Fees auto-buy-back & burn the coin.' };
		if (t === 'github') return { kind: 'github-owner', username: s.rtValue.replace(/^@/, ''), mode: 'pending', note: `Routes to @${s.rtValue.replace(/^@/, '') || '…'} on GitHub.` };
		if (t === 'x') return { kind: 'x-owner', username: s.rtValue.replace(/^@/, ''), mode: 'pending', note: `Routes to @${s.rtValue.replace(/^@/, '') || '…'} on X.` };
		if (t === 'wallet') return { kind: 'address', address: s.rtValue, note: 'Routes to a fixed Solana address / .sol name.' };
		return item.reward;
	}

	function rewardChip(reward) {
		if ((reward.kind === 'github-owner' || reward.kind === 'x-owner')) {
			const u = reward.username || reward.github_username;
			const plat = reward.kind === 'x-owner' ? '𝕏' : 'gh';
			return `<span class="ls-tag reward pending" title="${esc(reward.note || '')}">→ ${plat}:@${esc(u || '…')}</span>`;
		}
		if (reward.kind === 'address') return `<span class="ls-tag reward" title="${esc(reward.note || '')}">→ ${esc((reward.address || '').slice(0, 10)) || 'wallet'}…</span>`;
		if (reward.kind === 'cashback') return `<span class="ls-tag reward" title="${esc(reward.note || '')}">↩ cashback</span>`;
		if (reward.kind === 'buyback') return `<span class="ls-tag reward" title="${esc(reward.note || '')}">🔥 buyback</span>`;
		if (reward.kind === 'split') return `<span class="ls-tag reward pending">→ split</span>`;
		return `<span class="ls-tag">creator fees</span>`;
	}

	function launchHref(item) {
		const p = new URLSearchParams();
		p.set('name', item.identity.name);
		if (item.identity.symbol) p.set('symbol', item.identity.symbol);
		if (item.identity.description) p.set('description', item.identity.description);
		if (item.identity.image) p.set('image', item.identity.image);
		if (s.devBuy > 0) p.set('initialBuy', String(s.devBuy));
		const r = effectiveReward(item);
		if ((r.kind === 'github-owner' || r.kind === 'x-owner') && (r.username || r.github_username)) p.set('reward', `${r.kind === 'x-owner' ? 'x' : 'github'}:${r.username || r.github_username}`);
		else if (r.kind === 'address' && r.address) p.set('reward', `wallet:${r.address}`);
		else if (r.kind === 'cashback' || r.kind === 'buyback') p.set('reward', r.kind);
		return `/launch?${p.toString()}`;
	}

	// ── render ────────────────────────────────────────────────────────────────
	function renderAll() { root.innerHTML = `<div class="ls">${renderTools()}<div id="ls-grid"></div></div><div id="ls-drawer-root"></div><div class="ls-toast" id="ls-toast"></div>`; renderGrid(); renderDrawer(); wireTools(); }

	function renderTools() {
		if (s.listLoading || s.listError) return '<div id="ls-tools-slot"></div>';
		const tab = (id, label, n, extra = '') =>
			`<button class="ls-tab${s.activeCat === id ? ' on' : ''}" data-cat="${esc(id)}" ${extra}>${esc(label)}${n != null ? ` <span class="n">${n}</span>` : ''}</button>`;
		const catTabs = s.cats.map((c) => {
			const m = CATEGORY_META[c] || { label: c, icon: '' };
			const n = s.useCases.filter((u) => u.category === c).length;
			return `<button class="ls-tab${s.activeCat === c ? ' on' : ''}" data-cat="${esc(c)}" style="--h:${hue(c)}">
				<span style="color:hsl(${hue(c)} 75% 70%)">${esc(m.icon)}</span> ${esc(m.label)} <span class="n">${n}</span></button>`;
		}).join('');
		const savedTab = favs.size ? tab('saved', '★ Saved', favs.size) : '';
		return `<div class="ls-tools">
			<div class="ls-search-row">
				<div class="ls-search">
					<span class="ls-mag">⌕</span>
					<input id="ls-q" type="search" placeholder="Search 50 recipes — GitHub, memes, Hacker News, sectors…" value="${esc(s.q)}" autocomplete="off" spellcheck="false" aria-label="Search recipes" />
					<span class="ls-kbd">/</span>
				</div>
				<button class="ls-surprise" id="ls-surprise" title="Preview a random recipe">✦ Surprise me</button>
			</div>
			<div class="ls-tabs">
				${tab('all', 'All', s.total)}
				${catTabs}
				${savedTab}
				<div class="ls-modeseg" role="group" aria-label="Filter by type">
					<button data-mode="all" class="${s.mode === 'all' ? 'on' : ''}">All</button>
					<button data-mode="attribution" class="${s.mode === 'attribution' ? 'on' : ''}">Reward</button>
					<button data-mode="narrative" class="${s.mode === 'narrative' ? 'on' : ''}">Theme</button>
				</div>
			</div>
		</div>`;
	}

	function renderGrid() {
		const g = root.querySelector('#ls-grid'); if (!g) { return; }
		if (s.listLoading) { g.innerHTML = `<div class="ls-grid">${Array.from({ length: 9 }, () => '<div class="ls-skel"></div>').join('')}</div>`; return; }
		if (s.listError) { g.innerHTML = `<div class="ls-msg ls-err"><b>Couldn't load the catalog</b>${esc(s.listError)}<div><button class="ls-btn" id="ls-retry">↻ Retry</button></div></div>`; g.querySelector('#ls-retry')?.addEventListener('click', loadList); return; }
		const items = filtered();
		if (!items.length) { g.innerHTML = `<div class="ls-msg"><b>No recipes match</b>Try a different search or category.${s.q ? `<div><button class="ls-btn" id="ls-clear">Clear search</button></div>` : ''}</div>`; g.querySelector('#ls-clear')?.addEventListener('click', () => { s.q = ''; renderAll(); }); return; }
		g.innerHTML = `<div class="ls-grid">${items.map(renderCard).join('')}</div>`;
		g.querySelectorAll('.ls-card').forEach((el) => {
			el.addEventListener('click', () => openDrawer(el.dataset.id));
			el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrawer(el.dataset.id); } });
		});
		g.querySelectorAll('.ls-fav').forEach((el) => el.addEventListener('click', (e) => {
			e.stopPropagation(); const id = el.dataset.fav;
			if (favs.has(id)) favs.delete(id); else favs.add(id);
			saveFavs(); renderAll();
		}));
	}

	function renderCard(u) {
		const m = CATEGORY_META[u.category] || { icon: '' };
		const attribution = u.mode === 'attribution';
		const fav = favs.has(u.id);
		return `<div class="ls-card${s.activeId === u.id && s.open ? ' on' : ''}" data-id="${esc(u.id)}" style="--h:${hue(u.category)}" tabindex="0" role="button" aria-label="${esc(u.title)}">
			<div class="ls-card-top">
				<span class="ls-card-ic">${esc(m.icon)}</span>
				<span class="ls-card-t">${esc(u.title)}</span>
				<button class="ls-fav${fav ? ' on' : ''}" data-fav="${esc(u.id)}" title="${fav ? 'Saved' : 'Save recipe'}" aria-label="${fav ? 'Unsave' : 'Save'}">${fav ? '★' : '☆'}</button>
			</div>
			<div class="ls-card-d">${esc(u.description)}</div>
			<div class="ls-card-foot">
				<span class="ls-mode ${attribution ? 'attribution' : 'narrative'}">${attribution ? 'reward' : 'theme'}</span>
				<span class="ls-card-r">${attribution ? '🎁' : '◆'} ${esc(u.reward_label || (attribution ? 'Routes fees to the subject' : 'Creator fees'))}</span>
			</div>
		</div>`;
	}

	// ── drawer ────────────────────────────────────────────────────────────────
	function openDrawer(id) {
		s.activeId = id; s.open = true; s.rt = 'default'; s.rtValue = ''; s.devBuy = 0;
		renderAll(); loadPreview(id);
	}
	function closeDrawer() { s.open = false; renderDrawer(); setTimeout(() => { if (!s.open) { s.activeId = null; renderGrid(); } }, 300); }

	function renderDrawer() {
		const host = root.querySelector('#ls-drawer-root'); if (!host) return;
		if (!s.activeId) { host.innerHTML = ''; return; }
		const uc = s.useCases.find((u) => u.id === s.activeId) || { title: s.activeId, category: 'github', mode: 'narrative' };
		const m = CATEGORY_META[uc.category] || { icon: '' };
		let body;
		if (s.previewLoading) body = `<div class="ls-coins">${Array.from({ length: 3 }, () => '<div class="ls-skel" style="height:150px"></div>').join('')}</div>`;
		else if (s.previewError) body = `<div class="ls-msg ls-err"><b>Preview failed</b>${esc(s.previewError)}<div><button class="ls-btn" id="ls-reload">↻ Retry</button></div></div>`;
		else if (!s.preview || !s.preview.items.length) body = `<div class="ls-msg"><b>No live candidates right now</b>This source is quiet — try another recipe or refresh shortly.<div><button class="ls-btn" id="ls-reload">↻ Refresh</button></div></div>`;
		else body = `<div class="ls-coins">${s.preview.items.map((it, i) => renderCoin(it, i)).join('')}</div>`;

		const attribution = uc.mode === 'attribution';
		host.innerHTML = `<div class="ls-drawer${s.open ? ' open' : ''}" style="--h:${hue(uc.category)}">
			<div class="ls-scrim" id="ls-scrim"></div>
			<aside class="ls-panel" role="dialog" aria-modal="true" aria-label="${esc(uc.title)} preview">
				<div class="ls-ph">
					<span class="ls-ph-ic">${esc(m.icon)}</span>
					<div class="ls-ph-tt"><h3>${esc(uc.title)}</h3><p>${esc(uc.description || '')}</p></div>
					<button class="ls-x" id="ls-close" aria-label="Close">✕</button>
				</div>
				${renderControls(attribution)}
				<div class="ls-ctrl-l" style="margin:.2rem 0 .5rem">Live candidates — what this would mint right now</div>
				${body}
			</aside>
		</div>`;
		wireDrawer();
	}

	function renderControls(attribution) {
		const targets = REWARD_TARGETS.map((t) =>
			`<button data-rt="${t.id}" class="${s.rt === t.id ? 'on' : ''}" title="${esc(t.hint)}">${esc(t.label)}</button>`).join('');
		const active = REWARD_TARGETS.find((t) => t.id === s.rt);
		const input = active?.needs
			? `<input class="ls-rt-input" id="ls-rt-input" placeholder="${active.needs === 'handle' ? '@username' : 'Solana address or name.sol'}" value="${esc(s.rtValue)}" spellcheck="false" />`
			: '';
		return `<div class="ls-ctrls">
			<div>
				<div class="ls-ctrl-l">Route creator fees to${attribution ? ' <span style="color:#9fdcb4">(recipe defaults to the subject)</span>' : ''}</div>
				<div class="ls-rt">${targets}</div>
				${input}
				<div class="ls-rt-hint">${esc(active?.hint || '')}</div>
			</div>
			<div>
				<div class="ls-ctrl-l">Dev buy (optional) · flows into the launch</div>
				<div class="ls-slider-row">
					<input type="range" id="ls-devbuy" min="0" max="2" step="0.05" value="${s.devBuy}" aria-label="Dev buy in SOL" />
					<span class="ls-slider-v">${s.devBuy > 0 ? `${s.devBuy.toFixed(2)} SOL` : 'none'}</span>
				</div>
			</div>
			<div style="display:flex;align-items:center;gap:.6rem">
				<div class="ls-ctrl-l" style="margin:0">Network</div>
				<div class="ls-netseg">
					<button data-net="mainnet" class="${s.network === 'mainnet' ? 'on' : ''}">Mainnet</button>
					<button data-net="devnet" class="${s.network === 'devnet' ? 'on' : ''}">Devnet</button>
				</div>
			</div>
		</div>`;
	}

	function renderCoin(it, i) {
		const maxScore = Math.max(1, ...(s.preview.items.map((x) => Number(x.score) || 0)));
		const pct = Math.max(6, Math.round(((Number(it.score) || 0) / maxScore) * 100));
		const img = it.identity.image
			? `<img class="ls-coin-img" src="${esc(it.identity.image)}" alt="" loading="lazy" data-fallback="element" data-fallback-class="ls-coin-ph" data-fallback-text="${esc((it.identity.symbol || '?')[0])}" />`
			: `<div class="ls-coin-ph">${esc((it.identity.symbol || '?')[0])}</div>`;
		const signal = it.signal && it.signal.detail ? `<span class="ls-tag">${esc(it.signal.detail)}</span>` : '';
		return `<div class="ls-coin" style="animation-delay:${i * 40}ms">
			<div class="ls-coin-top">
				${img}
				<div class="ls-coin-id"><div class="ls-coin-n">${esc(it.identity.name)}</div><div class="ls-coin-s">$${esc(it.identity.symbol)}</div></div>
				<button class="ls-copy" data-copy="${esc(`${it.identity.name} $${it.identity.symbol}`)}" title="Copy name + ticker">⧉</button>
			</div>
			<div class="ls-coin-d">${esc(it.identity.description || '')}</div>
			<div class="ls-bar"><i style="width:${pct}%"></i></div>
			<div class="ls-coin-meta">${rewardChip(effectiveReward(it))}${signal}</div>
			<a class="ls-coin-go" href="${esc(launchHref(it))}">Launch this coin →</a>
		</div>`;
	}

	// ── wiring ────────────────────────────────────────────────────────────────
	const onSearch = debounce(() => { renderGrid(); }, 130);
	function wireTools() {
		const q = root.querySelector('#ls-q');
		if (q) {
			q.addEventListener('input', (e) => { s.q = e.target.value; onSearch(); });
			q.addEventListener('keydown', (e) => { if (e.key === 'Escape') { s.q = ''; e.target.value = ''; renderGrid(); } });
		}
		root.querySelectorAll('.ls-tab').forEach((el) => el.addEventListener('click', () => { s.activeCat = el.dataset.cat; renderAll(); }));
		root.querySelectorAll('.ls-modeseg button').forEach((el) => el.addEventListener('click', () => { s.mode = el.dataset.mode; renderAll(); }));
		root.querySelector('#ls-surprise')?.addEventListener('click', () => {
			const pool = filtered().length ? filtered() : s.useCases;
			if (pool.length) openDrawer(pool[Math.floor(Math.random() * pool.length)].id);
		});
	}

	function wireDrawer() {
		root.querySelector('#ls-close')?.addEventListener('click', closeDrawer);
		root.querySelector('#ls-scrim')?.addEventListener('click', closeDrawer);
		root.querySelector('#ls-reload')?.addEventListener('click', () => loadPreview(s.activeId));
		root.querySelectorAll('.ls-rt button').forEach((el) => el.addEventListener('click', () => { s.rt = el.dataset.rt; renderDrawer(); }));
		const rtIn = root.querySelector('#ls-rt-input');
		if (rtIn) rtIn.addEventListener('input', (e) => { s.rtValue = e.target.value; updateCoinsInPlace(); });
		const db = root.querySelector('#ls-devbuy');
		if (db) db.addEventListener('input', (e) => { s.devBuy = Number(e.target.value); const v = root.querySelector('.ls-slider-v'); if (v) v.textContent = s.devBuy > 0 ? `${s.devBuy.toFixed(2)} SOL` : 'none'; updateCoinsInPlace(); });
		root.querySelectorAll('.ls-netseg button').forEach((el) => el.addEventListener('click', () => { if (s.network !== el.dataset.net) { s.network = el.dataset.net; renderDrawer(); loadPreview(s.activeId); } }));
		root.querySelectorAll('.ls-copy').forEach((el) => el.addEventListener('click', () => { copy(el.dataset.copy); }));
	}

	// Update reward chips + launch hrefs without a full re-render (keeps input focus).
	function updateCoinsInPlace() {
		if (!s.preview) return;
		const nodes = root.querySelectorAll('.ls-coin');
		s.preview.items.forEach((it, i) => {
			const node = nodes[i]; if (!node) return;
			const meta = node.querySelector('.ls-coin-meta');
			if (meta) meta.innerHTML = rewardChip(effectiveReward(it)) + (it.signal?.detail ? `<span class="ls-tag">${esc(it.signal.detail)}</span>` : '');
			const go = node.querySelector('.ls-coin-go'); if (go) go.setAttribute('href', launchHref(it));
		});
	}

	function copy(text) {
		(navigator.clipboard?.writeText(text) || Promise.reject()).then(() => toast('Copied')).catch(() => toast('Copy failed'));
	}
	let toastT;
	function toast(msg) {
		const el = root.querySelector('#ls-toast'); if (!el) return;
		el.textContent = msg; el.classList.add('show');
		clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('show'), 1400);
	}

	// Global keyboard: "/" focus search, Esc close drawer.
	function onKey(e) {
		if (e.key === '/' && !/input|textarea/i.test(document.activeElement?.tagName || '')) { e.preventDefault(); root.querySelector('#ls-q')?.focus(); }
		if (e.key === 'Escape' && s.open) closeDrawer();
	}
	document.addEventListener('keydown', onKey);

	renderAll();
	loadList();
	return { teardown() { alive = false; document.removeEventListener('keydown', onKey); root.innerHTML = ''; } };
}
