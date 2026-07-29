// Rarest Fits — the /play cosmetics flex surface (R25).
//
// A platform-wide status board that drives the Roblox-style "rare fit" loop: the
// scarcest premium cosmetics (fewest owners), the top collectors by a rarity-
// weighted flex score, the top earning coin creators, and the live drip of recent
// unlocks. Every number comes from /api/cosmetics/leaderboard — settled sales only,
// nothing simulated. Each fit and creator links back into the coin world it's tied
// to (/play?coin=<mint>), closing the loop from "I want that fit" to "go where it's
// worn". Self-contained: appends its own overlay + scoped styles, like coin-buy.js.
//
// $THREE is the only coin; cosmetic VALUE is quoted in $THREE in the shop, while
// these flex numbers report the USDC that actually settled — the asset, never a
// coin to hold.

const ENDPOINT = '/api/cosmetics/leaderboard';

let _open = null; // the live overlay controller, so a second open refocuses it

function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
	}
	for (const kid of [].concat(kids)) if (kid != null && kid !== false) n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	return n;
}

const RARITY_LABEL = { common: 'Common', rare: 'Rare', epic: 'Epic', legendary: 'Legendary' };
const shortAddr = (a) => (a && a.length > 10 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || '');
const isWallet = (a) => typeof a === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
const fmtUsd = (n) => '$' + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const accountLabel = (a) => (isWallet(a) ? shortAddr(a) : 'Guest');

/**
 * Open the Rarest Fits board. Idempotent — a second call refocuses.
 * @param {{ coinMint?: string }} [opts]  the current world, highlighted in the board.
 */
export function openCosmeticsFlex(opts = {}) {
	if (_open) { _open.focus(); return _open; }
	_open = new FlexBoard(opts || {});
	return _open;
}

class FlexBoard {
	constructor({ coinMint = '' } = {}) {
		this.coinMint = coinMint || '';
		this._injectStyles();
		this._build();
		this._load();
	}

	focus() { this.closeBtn?.focus(); }

	_build() {
		this.closeBtn = el('button', {
			class: 'cf-close', type: 'button', 'aria-label': 'Close rarest fits',
			onclick: () => this.close(),
		}, [el('span', { 'aria-hidden': 'true', text: '✕' })]);

		this.body = el('div', { class: 'cf-body' });

		this.panel = el('div', {
			class: 'cf-panel', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'Rarest fits leaderboard',
		}, [
			el('div', { class: 'cf-head' }, [
				el('div', { class: 'cf-title' }, [
					el('span', { class: 'cf-title-main', text: 'Rarest Fits' }),
					el('span', { class: 'cf-title-sub', text: 'Who owns the scarcest looks — and the creators earning from them' }),
				]),
				this.closeBtn,
			]),
			this.body,
		]);

		this.root = el('div', { class: 'cf-root', id: 'cc-flex', hidden: true }, [this.panel]);
		this.root.addEventListener('click', (e) => { if (e.target === this.root) this.close(); });
		this._onKey = (e) => { if (e.key === 'Escape' && !this.root.hidden) { e.stopPropagation(); this.close(); } };
		document.addEventListener('keydown', this._onKey, true);
		document.body.appendChild(this.root);
		requestAnimationFrame(() => { this.root.hidden = false; this.root.classList.add('cf-in'); this.focus(); });
	}

	_status(msg, kind = '') {
		this.body.replaceChildren(el('div', { class: `cf-status cf-${kind}`, role: 'status', 'aria-live': 'polite' }, [msg]));
	}

	async _load() {
		this._status('Loading the flex board…', 'pending');
		// Skeleton-ish: a brief pending line, then real data or an honest empty/error.
		try {
			const r = await fetch(`${ENDPOINT}?limit=12`, { headers: { accept: 'application/json' } });
			if (!r.ok) throw new Error(`HTTP ${r.status}`);
			const data = await r.json();
			this._render(data);
		} catch (err) {
			this.body.replaceChildren(
				el('div', { class: 'cf-status cf-error', role: 'status' }, [
					'Couldn’t load the flex board. ',
					el('button', { class: 'cf-retry', type: 'button', text: 'Retry', onclick: () => this._load() }),
				]),
			);
		}
	}

	_render(data) {
		const rarestFits = data?.rarestFits || [];
		const topCollectors = data?.topCollectors || [];
		const topCreators = data?.topCreators || [];
		const recent = data?.recent || [];

		const empty = !rarestFits.length && !topCollectors.length && !recent.length;
		if (empty) {
			this.body.replaceChildren(el('div', { class: 'cf-empty' }, [
				el('div', { class: 'cf-empty-glyph', 'aria-hidden': 'true', text: '✦' }),
				el('div', { class: 'cf-empty-title', text: 'No fits owned yet' }),
				el('div', { class: 'cf-empty-sub', text: 'Be the first to buy a premium cosmetic — your fit tops the rarity board, and the coin’s creator earns a cut.' }),
				el('p', { class: 'cf-more' }, [
					el('a', { class: 'cf-more-link', href: '/fits', text: 'See the full cosmetics economy →' }),
				]),
			]));
			return;
		}

		const sections = [];

		// ── Rarest fits ──────────────────────────────────────────────────────
		if (rarestFits.length) {
			sections.push(el('section', { class: 'cf-sec' }, [
				el('h3', { class: 'cf-sec-h', text: 'Rarest fits' }),
				el('div', { class: 'cf-fits' }, rarestFits.map((f) => this._fitCard(f))),
			]));
		}

		// ── Top collectors ───────────────────────────────────────────────────
		if (topCollectors.length) {
			sections.push(el('section', { class: 'cf-sec' }, [
				el('h3', { class: 'cf-sec-h', text: 'Top collectors' }),
				el('ol', { class: 'cf-rank' }, topCollectors.map((c, i) => el('li', { class: 'cf-rank-row' }, [
					el('span', { class: 'cf-rank-n', text: String(i + 1) }),
					el('span', { class: 'cf-rank-who', text: accountLabel(c.account) }),
					el('span', { class: 'cf-rank-meta', text: `${c.fits} fit${c.fits === 1 ? '' : 's'}` }),
					el('span', { class: 'cf-rank-score', title: 'Rarity-weighted flex score', text: `${c.flexScore} flex` }),
				]))),
			]));
		}

		// ── Top creators (real USDC earnings) ────────────────────────────────
		if (topCreators.length) {
			sections.push(el('section', { class: 'cf-sec' }, [
				el('h3', { class: 'cf-sec-h', text: 'Top earning creators' }),
				el('ol', { class: 'cf-rank' }, topCreators.map((c, i) => el('li', { class: 'cf-rank-row' }, [
					el('span', { class: 'cf-rank-n', text: String(i + 1) }),
					el('span', { class: 'cf-rank-who', text: shortAddr(c.wallet) }),
					el('span', { class: 'cf-rank-meta', text: `${c.sales} sale${c.sales === 1 ? '' : 's'}` }),
					el('span', { class: 'cf-rank-score', text: fmtUsd(c.earnedUsdc) }),
				]))),
			]));
		}

		// ── Recent unlocks ───────────────────────────────────────────────────
		if (recent.length) {
			sections.push(el('section', { class: 'cf-sec' }, [
				el('h3', { class: 'cf-sec-h', text: 'Recent unlocks' }),
				el('ul', { class: 'cf-recent' }, recent.map((r) => el('li', { class: 'cf-recent-row' }, [
					el('span', { class: `cf-pill cf-r-${r.rarity}`, text: RARITY_LABEL[r.rarity] || r.rarity }),
					el('span', { class: 'cf-recent-name', text: r.name }),
					el('span', { class: 'cf-recent-by', text: `by ${accountLabel(r.buyer)}` }),
					r.mint ? this._worldLink(r.mint, 'visit world') : el('span', {}),
				]))),
			]));
		}

		// The full ledger (creator earnings, the whole collector board, sale
		// history) lives on its own public page; this panel is the in-game peek.
		sections.push(el('p', { class: 'cf-more' }, [
			el('a', {
				class: 'cf-more-link',
				href: '/fits',
				text: 'See the full cosmetics economy →',
			}),
		]));

		this.body.replaceChildren(...sections);
	}

	_fitCard(f) {
		const worn = f.worldMint
			? this._worldLink(f.worldMint, 'Visit world →')
			: el('span', { class: 'cf-fit-noworld', text: 'Untied' });
		const here = f.worldMint && f.worldMint === this.coinMint;
		return el('div', { class: 'cf-fit' + (here ? ' cf-fit-here' : '') }, [
			f.previewImage
				? el('img', { class: 'cf-fit-img', src: f.previewImage, alt: '', loading: 'lazy' })
				: el('div', { class: 'cf-fit-img cf-fit-img-ph', 'aria-hidden': 'true', text: '✦' }),
			el('div', { class: 'cf-fit-info' }, [
				el('div', { class: 'cf-fit-name', text: f.name }),
				el('div', { class: 'cf-fit-sub' }, [
					el('span', { class: `cf-pill cf-r-${f.rarity}`, text: RARITY_LABEL[f.rarity] || f.rarity }),
					el('span', { class: 'cf-fit-owners', text: `${f.owners} owner${f.owners === 1 ? '' : 's'}` }),
				]),
				worn,
			]),
		]);
	}

	// A link back into a coin world. Uses the same /play?coin=<mint> deep link the
	// scene already honours, so clicking a fit takes you where it's worn.
	_worldLink(mint, label) {
		return el('a', {
			class: 'cf-worldlink',
			href: `/play?coin=${encodeURIComponent(mint)}`,
			title: 'Enter this coin’s world',
			text: label,
		});
	}

	close() {
		if (!this.root) return;
		document.removeEventListener('keydown', this._onKey, true);
		this.root.classList.remove('cf-in');
		const root = this.root;
		setTimeout(() => { try { root.remove(); } catch {} }, 180);
		this.root = null;
		if (_open === this) _open = null;
	}

	_injectStyles() {
		if (document.getElementById('cc-flex-styles')) return;
		const css = `
		.cf-root{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;
			background:rgba(6,8,14,.62);backdrop-filter:blur(6px);opacity:0;transition:opacity .18s ease;padding:16px}
		.cf-root.cf-in{opacity:1}
		.cf-panel{width:min(680px,96vw);max-height:88vh;display:flex;flex-direction:column;overflow:hidden;
			background:#0e1018;color:#e9eaf2;border:1px solid #23263a;border-radius:16px;
			box-shadow:0 24px 80px rgba(0,0,0,.55);transform:translateY(8px);transition:transform .18s ease}
		.cf-root.cf-in .cf-panel{transform:translateY(0)}
		.cf-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;
			padding:18px 20px 14px;border-bottom:1px solid #1c1f30}
		.cf-title-main{display:block;font-size:18px;font-weight:700;letter-spacing:-.01em}
		.cf-title-sub{display:block;font-size:12.5px;color:#9aa0b8;margin-top:2px}
		.cf-close{background:#171a28;border:1px solid #262a40;color:#cfd2e6;width:34px;height:34px;border-radius:9px;
			cursor:pointer;font-size:14px;line-height:1;transition:background .12s,border-color .12s}
		.cf-close:hover{background:#202438;border-color:#363b58}
		.cf-close:focus-visible{outline:2px solid #6f7bff;outline-offset:2px}
		.cf-body{padding:14px 20px 22px;overflow:auto}
		.cf-status{padding:28px 8px;text-align:center;color:#9aa0b8;font-size:14px}
		.cf-status.cf-error{color:#ffb4b4}
		.cf-retry{margin-left:6px;background:#262a40;border:1px solid #3a3f5e;color:#e9eaf2;border-radius:7px;
			padding:4px 10px;cursor:pointer;font-size:13px}
		.cf-retry:hover{background:#30364f}
		.cf-empty{text-align:center;padding:34px 12px;color:#aeb4cc}
		.cf-empty-glyph{font-size:34px;opacity:.5}
		.cf-empty-title{font-size:16px;font-weight:650;margin-top:6px;color:#e9eaf2}
		.cf-empty-sub{font-size:13px;margin-top:6px;max-width:42ch;margin-inline:auto;line-height:1.5}
		.cf-more{margin:14px 0 2px;text-align:center}
		.cf-more-link{font-size:13px;color:#9aa3c7;text-decoration:none;border-bottom:1px solid transparent;transition:color .15s ease,border-color .15s ease}
		.cf-more-link:hover{color:#e9eaf2;border-bottom-color:currentColor}
		.cf-more-link:focus-visible{outline:2px solid #6f7bff;outline-offset:3px;border-radius:3px}
		.cf-sec{margin-top:18px}
		.cf-sec:first-child{margin-top:2px}
		.cf-sec-h{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#8b91ac;margin:0 0 10px}
		.cf-fits{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:10px}
		.cf-fit{display:flex;gap:10px;align-items:center;background:#141726;border:1px solid #20243a;border-radius:12px;padding:10px}
		.cf-fit-here{border-color:#6f7bff;box-shadow:0 0 0 1px rgba(111,123,255,.4) inset}
		.cf-fit-img{width:48px;height:48px;border-radius:9px;object-fit:cover;background:#1c2032;flex:none}
		.cf-fit-img-ph{display:flex;align-items:center;justify-content:center;font-size:20px;color:#5a6086}
		.cf-fit-info{min-width:0;flex:1}
		.cf-fit-name{font-weight:650;font-size:13.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
		.cf-fit-sub{display:flex;align-items:center;gap:6px;margin:4px 0 6px}
		.cf-fit-owners{font-size:11.5px;color:#9aa0b8}
		.cf-fit-noworld{font-size:11.5px;color:#6b7090}
		.cf-pill{font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;
			padding:2px 7px;border-radius:999px;border:1px solid transparent}
		.cf-r-common{color:#c3c8db;background:#1d2133;border-color:#2a3047}
		.cf-r-rare{color:#7fb6ff;background:#13233b;border-color:#234668}
		.cf-r-epic{color:#caa6ff;background:#241a3b;border-color:#4a3a6e}
		.cf-r-legendary{color:#ffd479;background:#2c2410;border-color:#5e4d1d}
		.cf-worldlink{font-size:11.5px;color:#8aa0ff;text-decoration:none;border-bottom:1px dashed transparent}
		.cf-worldlink:hover{border-bottom-color:#8aa0ff}
		.cf-rank{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
		.cf-rank-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:9px}
		.cf-rank-row:nth-child(odd){background:#12141f}
		.cf-rank-n{width:20px;text-align:center;font-variant-numeric:tabular-nums;color:#7b819c;font-size:12px}
		.cf-rank-who{flex:1;font-weight:600;font-size:13px}
		.cf-rank-meta{font-size:12px;color:#9aa0b8}
		.cf-rank-score{font-size:12.5px;font-weight:650;color:#bfe3c8;font-variant-numeric:tabular-nums}
		.cf-recent{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px}
		.cf-recent-row{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:9px;font-size:12.5px}
		.cf-recent-row:nth-child(odd){background:#12141f}
		.cf-recent-name{font-weight:600}
		.cf-recent-by{color:#9aa0b8}
		.cf-recent-row .cf-worldlink{margin-left:auto}
		@media (max-width:520px){.cf-fits{grid-template-columns:1fr}}
		`;
		const style = el('style', { id: 'cc-flex-styles', text: css });
		document.head.appendChild(style);
	}
}
