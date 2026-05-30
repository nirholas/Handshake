// Chart Screen — a live in-world trading terminal for a coin community.
//
// Each /play world IS a pump.fun coin, so the community deserves a real screen
// on the plaza showing that coin's live chart: a jumbotron mounted on posts,
// its face an HTML canvas painted with the price line, current price, market
// cap, buy/sell pressure, and a scrolling ticker of the latest on-chain trades.
// The canvas is wrapped in a CanvasTexture, so the 3D "screen" updates in place
// as new trades land — no DOM overlay, it's a physical object in the world you
// can walk up to and click (which opens the coin on pump.fun).
//
// Data is real: /api/pump/coin-trades (the same swap-API proxy the homepage live
// card uses). We poll, accumulate a growing price series across the session, and
// derive price / change / volume / flow from genuine trades. Loading, empty, and
// error states are all painted on the screen itself.

import {
	Group, Mesh, MeshBasicMaterial, MeshStandardMaterial,
	PlaneGeometry, CylinderGeometry, BoxGeometry,
	CanvasTexture, SRGBColorSpace, DoubleSide,
} from 'three';

const TRADES_URL = (mint, limit = 100) =>
	`/api/pump/coin-trades?mint=${encodeURIComponent(mint)}&limit=${limit}`;
const POLL_MS = 5000;
const REDRAW_MS = 100;          // ~10fps: enough for a smooth ticker, cheap on the GPU
const MAX_POINTS = 220;         // rolling price history kept across the session
const CW = 1280, CH = 720;      // 16:9 canvas backing the screen

// Restrained palette — the /play client is monochrome, but a trading terminal
// earns a single directional accent (up green / down red) the way a real screen
// would. Everything else stays light-on-near-black to match the world's UI.
const COL = {
	bg0: '#0a0a0c', bg1: '#121216',
	grid: 'rgba(255,255,255,0.05)',
	text: '#f5f5f6', dim: '#8c8c92', faint: '#5a5a60',
	up: '#5fd08a', down: '#e06c75',
	line: '#f5f5f6',
};

// ── formatters ───────────────────────────────────────────────────────────────

// Memecoin prices span many orders of magnitude; render sub-cent values with the
// "0.0₍n₎digits" leading-zero notation (drawn with a real subscript on canvas).
function priceParts(v) {
	if (!isFinite(v) || v <= 0) return { whole: '—', sub: null, tail: '' };
	if (v >= 1) return { whole: '$' + v.toLocaleString('en-US', { maximumFractionDigits: 2 }), sub: null, tail: '' };
	if (v >= 0.001) return { whole: '$' + v.toFixed(5).replace(/0+$/, '').replace(/\.$/, '.0'), sub: null, tail: '' };
	const e = Math.floor(Math.log10(v));          // e.g. -7
	const zeros = -e - 1;                          // leading zeros after the decimal point
	const digits = String(Math.round(v / Math.pow(10, e - 2))).slice(0, 3); // 3 significant
	return { whole: '$0.0', sub: String(zeros), tail: digits };
}

function fmtCompactUsd(v) {
	const n = Number(v);
	if (!isFinite(n) || n <= 0) return '—';
	if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
	if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
	if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
	return '$' + n.toFixed(0);
}

function fmtSol(v) {
	const n = Number(v);
	if (!isFinite(n) || n === 0) return '0';
	if (n < 0.01) return n.toFixed(4);
	if (n < 1) return n.toFixed(3);
	return n.toFixed(2);
}

function shortAddr(a) {
	const s = String(a || '');
	return s.length > 9 ? `${s.slice(0, 4)}…${s.slice(-3)}` : s || '—';
}

function relTime(ms) {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 5) return 'now';
	if (s < 60) return s + 's';
	const m = Math.round(s / 60);
	if (m < 60) return m + 'm';
	const h = Math.round(m / 60);
	if (h < 24) return h + 'h';
	return Math.round(h / 24) + 'd';
}

function roundRect(ctx, x, y, w, h, r) {
	ctx.beginPath();
	ctx.moveTo(x + r, y);
	ctx.arcTo(x + w, y, x + w, y + h, r);
	ctx.arcTo(x + w, y + h, x, y + h, r);
	ctx.arcTo(x, y + h, x, y, r);
	ctx.arcTo(x, y, x + w, y, r);
	ctx.closePath();
}

// ── factory ──────────────────────────────────────────────────────────────────

/**
 * Build a live chart screen for one coin and add it to the scene.
 * @param {THREE.Scene} scene
 * @param {{mint:string,name:string,symbol:string,image:string,marketCap:number}} coin
 * @param {{position?:[number,number,number], rotationY?:number, width?:number}} [opts]
 * @returns {{group:THREE.Group, mesh:THREE.Mesh, update:Function, dispose:Function, openExternal:Function}}
 */
export function createChartScreen(scene, coin, opts = {}) {
	const position = opts.position || [0, 0, -26];
	const rotationY = opts.rotationY || 0;
	const width = opts.width || 18;
	const height = (width * CH) / CW;

	const group = new Group();
	group.position.set(position[0], position[1], position[2]);
	group.rotation.y = rotationY;

	const postH = 3.2;
	const cy = postH + height / 2; // screen vertical center

	// Two support posts + a crossbar read as a real jumbotron rig.
	const postMat = new MeshStandardMaterial({ color: 0x141417, roughness: 0.5, metalness: 0.6 });
	const postX = width / 2 - 0.7;
	for (const sx of [-postX, postX]) {
		const post = new Mesh(new CylinderGeometry(0.28, 0.34, postH + height, 16), postMat);
		post.position.set(sx, (postH + height) / 2, -0.15);
		post.castShadow = true;
		group.add(post);
	}
	const base = new Mesh(new BoxGeometry(width - 0.4, 0.4, 1.6), postMat);
	base.position.set(0, 0.2, -0.15); base.castShadow = true; base.receiveShadow = true;
	group.add(base);

	// Bezel behind the live face.
	const bezel = new Mesh(
		new BoxGeometry(width + 0.6, height + 0.6, 0.4),
		new MeshStandardMaterial({ color: 0x050506, roughness: 0.4, metalness: 0.7 }),
	);
	bezel.position.set(0, cy, -0.22);
	bezel.castShadow = true;
	group.add(bezel);

	// The live face: an HTML canvas → CanvasTexture → unlit plane (so it glows
	// like a screen rather than catching world light).
	const canvas = document.createElement('canvas');
	canvas.width = CW; canvas.height = CH;
	const ctx = canvas.getContext('2d');
	const tex = new CanvasTexture(canvas);
	tex.colorSpace = SRGBColorSpace;
	tex.anisotropy = 4;
	const panel = new Mesh(
		new PlaneGeometry(width, height),
		new MeshBasicMaterial({ map: tex, side: DoubleSide, toneMapped: false }),
	);
	panel.position.set(0, cy, 0.01);
	panel.userData.chartScreen = true; // raycast tag
	group.add(panel);

	scene.add(group);

	// Optional coin logo for the header (loaded async; header still renders without it).
	let logo = null;
	if (coin.image) {
		const im = new Image();
		im.crossOrigin = 'anonymous';
		im.referrerPolicy = 'no-referrer';
		im.onload = () => { logo = im; };
		im.src = coin.image;
	}

	// ── live state ──────────────────────────────────────────────────────────
	let seen = new Set();     // trade tx signatures already ingested
	let points = [];          // [{ ts, price }] ascending by ts
	let recent = [];          // newest-first trades for the ticker/flow
	let status = 'loading';   // loading | live | empty | error
	let lastErr = 0;
	let pollTimer = null;
	let destroyed = false;
	let acc = 0;              // redraw accumulator
	let t = 0;                // elapsed seconds (ticker scroll + pulse)

	function ingest(trades) {
		let added = 0;
		for (const tr of trades) {
			if (!tr.tx || seen.has(tr.tx)) continue;
			seen.add(tr.tx);
			added++;
			const ts = tr.timestamp ? Date.parse(tr.timestamp) : Date.now();
			const price = tr.price_usd != null ? Number(tr.price_usd) : null;
			if (price > 0 && isFinite(price)) points.push({ ts, price });
			recent.push({
				tx: tr.tx,
				ts,
				isBuy: tr.is_buy === true,
				sol: Number(tr.sol_amount) || 0,
				usd: tr.usd_amount != null ? Number(tr.usd_amount) : null,
				trader: tr.user || '',
			});
		}
		if (!added) return;
		points.sort((a, b) => a.ts - b.ts);
		if (points.length > MAX_POINTS) points = points.slice(-MAX_POINTS);
		recent.sort((a, b) => b.ts - a.ts);
		if (recent.length > 40) recent = recent.slice(0, 40);
		// Keep the dedup set from growing unbounded across a long session — the
		// upstream only ever returns the latest window, so the recent tx are all
		// we need to keep recognising.
		if (seen.size > 800) seen = new Set(recent.map((r) => r.tx));
		status = points.length ? 'live' : (recent.length ? 'live' : 'empty');
	}

	async function fetchTrades() {
		try {
			const r = await fetch(TRADES_URL(coin.mint), { headers: { accept: 'application/json' } });
			if (!r.ok) throw new Error('HTTP ' + r.status);
			const data = await r.json();
			const trades = Array.isArray(data?.trades) ? data.trades : [];
			ingest(trades);
			if (status === 'loading') status = trades.length ? 'live' : 'empty';
		} catch {
			lastErr = Date.now();
			if (!points.length && !recent.length) status = 'error';
		}
	}

	function poll() {
		if (destroyed) return;
		clearTimeout(pollTimer);
		fetchTrades().finally(() => {
			if (destroyed) return;
			pollTimer = setTimeout(poll, POLL_MS);
		});
	}

	// ── derived metrics ───────────────────────────────────────────────────────
	function metrics() {
		const priced = points;
		const cur = priced.length ? priced[priced.length - 1].price : null;
		const first = priced.length ? priced[0].price : null;
		const pct = first && cur ? ((cur - first) / first) * 100 : null;
		let vol = 0, buys = 0, sells = 0;
		for (const r of recent) {
			if (r.usd) vol += r.usd;
			if (r.isBuy) buys++; else sells++;
		}
		const flow = buys + sells ? buys / (buys + sells) : 0.5;
		return { cur, pct, vol, buys, sells, flow };
	}

	// ── canvas rendering ──────────────────────────────────────────────────────
	function draw() {
		const m = metrics();
		const up = m.pct == null ? null : m.pct >= 0;
		const accent = up == null ? COL.line : up ? COL.up : COL.down;

		// Background — deep glass with a soft top sheen.
		const bg = ctx.createLinearGradient(0, 0, 0, CH);
		bg.addColorStop(0, COL.bg1); bg.addColorStop(1, COL.bg0);
		ctx.fillStyle = bg; ctx.fillRect(0, 0, CW, CH);

		// Header -----------------------------------------------------------------
		const padX = 48;
		let hx = padX;
		const headY = 64;
		// logo chip
		const chip = 56;
		ctx.save();
		roundRect(ctx, hx, headY - chip / 2, chip, chip, 10);
		ctx.fillStyle = '#1a1a1f'; ctx.fill();
		ctx.clip();
		if (logo) ctx.drawImage(logo, hx, headY - chip / 2, chip, chip);
		else {
			ctx.fillStyle = COL.dim;
			ctx.font = '700 22px Inter, system-ui, sans-serif';
			ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
			ctx.fillText((coin.symbol || '?').slice(0, 3).toUpperCase(), hx + chip / 2, headY);
		}
		ctx.restore();
		hx += chip + 18;

		ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
		ctx.fillStyle = COL.text;
		ctx.font = '800 34px Inter, system-ui, sans-serif';
		const nm = (coin.name || 'Community').toUpperCase();
		ctx.fillText(nm.length > 22 ? nm.slice(0, 21) + '…' : nm, hx, headY - 4);
		ctx.fillStyle = COL.dim;
		ctx.font = '600 20px Inter, system-ui, sans-serif';
		const sym = coin.symbol ? '$' + coin.symbol.toUpperCase() : '';
		ctx.fillText(`${sym}${sym ? '  ·  ' : ''}pump.fun`, hx, headY + 24);

		// live badge (top-right), pulsing
		const pulse = 0.55 + 0.45 * Math.sin(t * 4);
		const badgeW = 116, badgeH = 40, bx = CW - padX - badgeW, by = headY - badgeH / 2 - 6;
		roundRect(ctx, bx, by, badgeW, badgeH, 20);
		ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fill();
		ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1; ctx.stroke();
		ctx.beginPath();
		ctx.arc(bx + 26, by + badgeH / 2, 6, 0, Math.PI * 2);
		ctx.fillStyle = status === 'live' ? `rgba(95,208,138,${pulse})` : COL.faint;
		ctx.fill();
		ctx.fillStyle = COL.text;
		ctx.font = '700 18px Inter, system-ui, sans-serif';
		ctx.fillText(status === 'live' ? 'LIVE' : status === 'error' ? 'OFFLINE' : '···', bx + 44, by + 26);

		// "↗ pump.fun" affordance, bottom-right of header row
		ctx.fillStyle = COL.faint;
		ctx.font = '600 16px Inter, system-ui, sans-serif';
		ctx.textAlign = 'right';
		ctx.fillText('↗ tap to open on pump.fun', CW - padX, headY + 40);
		ctx.textAlign = 'left';

		// Price block ------------------------------------------------------------
		const priceY = 168;
		const pp = priceParts(m.cur);
		ctx.fillStyle = COL.text;
		ctx.font = '800 76px Inter, system-ui, sans-serif';
		ctx.textBaseline = 'alphabetic';
		let px = padX;
		ctx.fillText(pp.whole, px, priceY);
		px += ctx.measureText(pp.whole).width;
		if (pp.sub != null) {
			ctx.font = '800 44px Inter, system-ui, sans-serif';
			ctx.fillText(pp.sub, px + 4, priceY + 14);
			px += ctx.measureText(pp.sub).width + 8;
			ctx.font = '800 76px Inter, system-ui, sans-serif';
			ctx.fillText(pp.tail, px, priceY);
		}
		// change pill
		if (m.pct != null) {
			const lbl = `${up ? '▲' : '▼'} ${Math.abs(m.pct).toFixed(m.pct >= 100 ? 0 : 2)}%`;
			ctx.font = '800 30px Inter, system-ui, sans-serif';
			const w = ctx.measureText(lbl).width + 36;
			const pillX = padX, pillY = priceY + 22;
			roundRect(ctx, pillX, pillY, w, 46, 23);
			ctx.fillStyle = up ? 'rgba(95,208,138,0.14)' : 'rgba(224,108,117,0.14)';
			ctx.fill();
			ctx.fillStyle = accent;
			ctx.fillText(lbl, pillX + 18, pillY + 33);
		}
		// session-window note next to the pill
		ctx.fillStyle = COL.faint;
		ctx.font = '600 17px Inter, system-ui, sans-serif';
		ctx.fillText('live session · prices from on-chain swaps', padX + 230, priceY + 52);

		// Chart ------------------------------------------------------------------
		const cxL = padX, cxR = CW - padX;
		const cTop = 280, cBot = CH - 132;
		const cW = cxR - cxL, cH = cBot - cTop;

		// grid
		ctx.strokeStyle = COL.grid; ctx.lineWidth = 1;
		for (let i = 0; i <= 4; i++) {
			const gy = cTop + (cH * i) / 4;
			ctx.beginPath(); ctx.moveTo(cxL, gy); ctx.lineTo(cxR, gy); ctx.stroke();
		}

		if (points.length >= 2) {
			let lo = Infinity, hi = -Infinity;
			for (const p of points) { if (p.price < lo) lo = p.price; if (p.price > hi) hi = p.price; }
			if (hi === lo) { hi *= 1.0001; lo *= 0.9999; }
			const pad = (hi - lo) * 0.12;
			lo -= pad; hi += pad;
			const t0 = points[0].ts, t1 = points[points.length - 1].ts || t0 + 1;
			const span = Math.max(1, t1 - t0);
			const X = (ts) => cxL + (cW * (ts - t0)) / span;
			const Y = (pr) => cBot - (cH * (pr - lo)) / (hi - lo);

			// area fill
			ctx.beginPath();
			ctx.moveTo(X(points[0].ts), cBot);
			for (const p of points) ctx.lineTo(X(p.ts), Y(p.price));
			ctx.lineTo(X(points[points.length - 1].ts), cBot);
			ctx.closePath();
			const fill = ctx.createLinearGradient(0, cTop, 0, cBot);
			const rgb = up == null ? '245,245,246' : up ? '95,208,138' : '224,108,117';
			fill.addColorStop(0, `rgba(${rgb},0.28)`);
			fill.addColorStop(1, `rgba(${rgb},0.01)`);
			ctx.fillStyle = fill; ctx.fill();

			// line
			ctx.beginPath();
			points.forEach((p, i) => { const x = X(p.ts), y = Y(p.price); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
			ctx.strokeStyle = accent; ctx.lineWidth = 3; ctx.lineJoin = 'round';
			ctx.shadowColor = accent; ctx.shadowBlur = 14; ctx.stroke(); ctx.shadowBlur = 0;

			// leading dot, pulsing
			const lastP = points[points.length - 1];
			const lx = X(lastP.ts), ly = Y(lastP.price);
			ctx.beginPath(); ctx.arc(lx, ly, 9 + pulse * 3, 0, Math.PI * 2);
			ctx.fillStyle = `rgba(${rgb},${0.18 + pulse * 0.22})`; ctx.fill();
			ctx.beginPath(); ctx.arc(lx, ly, 5, 0, Math.PI * 2);
			ctx.fillStyle = accent; ctx.fill();

			// hi/lo labels
			ctx.fillStyle = COL.dim; ctx.font = '600 16px Inter, system-ui, sans-serif';
			ctx.textAlign = 'right';
			const hiP = priceParts(hi), loP = priceParts(lo);
			ctx.fillText(hiP.whole + (hiP.sub ? '·' + hiP.tail : ''), cxR - 6, cTop + 20);
			ctx.fillText(loP.whole + (loP.sub ? '·' + loP.tail : ''), cxR - 6, cBot - 8);
			ctx.textAlign = 'left';
		} else {
			ctx.fillStyle = COL.dim;
			ctx.font = '600 24px Inter, system-ui, sans-serif';
			ctx.textAlign = 'center';
			const msg = status === 'error' ? 'Live feed unavailable — retrying…'
				: status === 'empty' ? 'No recent trades yet — be the first to ape in.'
				: 'Loading on-chain trades…';
			ctx.fillText(msg, CW / 2, cTop + cH / 2);
			ctx.textAlign = 'left';
		}

		// Stat strip -------------------------------------------------------------
		const sY = cBot + 16, sH = 56;
		const stats = [
			['MARKET CAP', fmtCompactUsd(coin.marketCap)],
			['VOLUME (live)', fmtCompactUsd(m.vol)],
			['TRADES', String(recent.length || 0)],
			['FLOW', `${m.buys}B / ${m.sells}S`],
		];
		const colW = (CW - padX * 2) / stats.length;
		stats.forEach(([k, v], i) => {
			const x = padX + colW * i;
			ctx.fillStyle = COL.faint; ctx.font = '700 15px Inter, system-ui, sans-serif';
			ctx.fillText(k, x, sY + 16);
			ctx.fillStyle = COL.text; ctx.font = '800 26px Inter, system-ui, sans-serif';
			ctx.fillText(v, x, sY + 44);
			if (i) {
				ctx.strokeStyle = COL.grid; ctx.beginPath();
				ctx.moveTo(x - 16, sY); ctx.lineTo(x - 16, sY + sH); ctx.stroke();
			}
		});

		// buy/sell pressure bar under the stat strip
		const barY = sY + sH + 6, barH = 6, barW = CW - padX * 2;
		roundRect(ctx, padX, barY, barW, barH, 3); ctx.fillStyle = 'rgba(224,108,117,0.5)'; ctx.fill();
		roundRect(ctx, padX, barY, barW * m.flow, barH, 3); ctx.fillStyle = COL.up; ctx.fill();

		// Ticker -----------------------------------------------------------------
		const tickY = CH - 30;
		ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, tickY - 26, CW, 56);
		ctx.save();
		ctx.beginPath(); ctx.rect(padX, tickY - 26, CW - padX * 2, 56); ctx.clip();
		if (recent.length) {
			const seg = recent.slice(0, 16).map((r) => {
				const side = r.isBuy ? 'BUY' : 'SELL';
				const usd = r.usd ? '  ' + fmtCompactUsd(r.usd) : '';
				return { r, txt: `${side}  ${fmtSol(r.sol)} SOL${usd}  ·  ${shortAddr(r.trader)}  ·  ${relTime(r.ts)}` };
			});
			ctx.font = '700 18px Inter, system-ui, sans-serif';
			const gap = 64;
			const widths = seg.map((s) => ctx.measureText(s.txt).width + gap);
			const total = widths.reduce((a, b) => a + b, 0) || 1;
			let scroll = (t * 70) % total;
			let x = padX - scroll;
			// draw twice so it wraps seamlessly
			for (let pass = 0; pass < 2; pass++) {
				let xx = x + pass * total;
				seg.forEach((s, i) => {
					ctx.fillStyle = s.r.isBuy ? COL.up : COL.down;
					ctx.fillText(s.txt.split('  ')[0], xx, tickY);
					const lead = ctx.measureText(s.txt.split('  ')[0] + '  ').width;
					ctx.fillStyle = COL.dim;
					ctx.fillText('  ' + s.txt.split('  ').slice(1).join('  '), xx + lead - 8, tickY);
					xx += widths[i];
				});
			}
		} else {
			ctx.fillStyle = COL.faint; ctx.font = '600 17px Inter, system-ui, sans-serif';
			ctx.fillText('Awaiting live trades…', padX, tickY);
		}
		ctx.restore();

		tex.needsUpdate = true;
	}

	// first paint + go live
	draw();
	poll();

	return {
		group,
		mesh: panel,
		mint: coin.mint,
		update(dt) {
			if (destroyed) return;
			t += dt;
			acc += dt;
			if (acc >= REDRAW_MS / 1000) { acc = 0; draw(); }
		},
		openExternal() {
			window.open(`https://pump.fun/coin/${coin.mint}`, '_blank', 'noopener,noreferrer');
		},
		dispose() {
			destroyed = true;
			clearTimeout(pollTimer);
			scene.remove(group);
			group.traverse((n) => {
				if (n.isMesh) {
					n.geometry?.dispose?.();
					const mats = Array.isArray(n.material) ? n.material : [n.material];
					for (const mm of mats) { mm?.map?.dispose?.(); mm?.dispose?.(); }
				}
			});
		},
	};
}
