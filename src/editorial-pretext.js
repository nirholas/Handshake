// Editorial pretext engine — canvas-measured text reflow around a draggable avatar obstacle
(function initEditorial() {
	var area = document.getElementById('editorial-text-area');
	var orbEl = document.getElementById('editorial-orb');
	var orbAvatarSlot = document.getElementById('editorial-orb-avatar');
	if (!area || !orbEl) return;

	var FONT = '17px Georgia,"Iowan Old Style","Palatino Linotype",Palatino,serif';
	var LINE_H = 28;
	var COL_GAP = 48;
	var ORB_DIM = 150;
	var ORB_R = ORB_DIM / 2;
	var ORB_PAD = 28;
	var MIN_SLOT = 60;
	var DROP_SIZE = 72;
	var DROP_LINES = 3;
	var PARA_GAP = 0.6;

	var COPY = [
		'The web was built for documents. Text, images, links — a flat canvas for static information. Then came video. Then interactivity. Then AI. But something fundamental was always missing: presence. Not a chatbot tucked into a corner. Not a popup demanding attention. A living digital being that inhabits your space, knows your visitors, and works while you sleep.',
		'three.ws gives your AI a body. A 3D character generated from a single photograph, deployed with two lines of HTML, monetized through micropayments that settle instantly. Every agent remembers across sessions, moves through multiplayer worlds, and earns revenue via the x402 payment protocol.',
		'This is not another widget. This is the layer where software has form, where interfaces have personality, where every website hosts a living intelligence that sees, hears, speaks, and transacts on your behalf. Two hundred animation clips. Real‑time voice. On‑chain identity. Cross‑device memory. Spatial multiplayer. All from one embed tag.',
		'Mint your agent as an ERC‑8004 token — the emerging standard for on‑chain AI identity. Let other agents discover and call yours via A2A and MCP protocols. Gate skills behind x402 micropayments in USDC. The economics are simple: you build, visitors pay, funds settle instantly to your wallet. No intermediary.',
		'The flat web had its moment. The living web starts now.'
	];

	// Canvas-based text measurement (zero DOM reflows)
	var mCtx = document.createElement('canvas').getContext('2d');
	mCtx.font = FONT;
	var spW = mCtx.measureText(' ').width;
	function mw(t) { mCtx.font = FONT; return mCtx.measureText(t).width; }

	// Build word list with paragraph-break markers
	var words = [];
	COPY.forEach(function(para, pi) {
		para.split(/\s+/).filter(Boolean).forEach(function(w, wi, arr) {
			words.push({ t: w, w: mw(w), pb: (wi === arr.length - 1 && pi < COPY.length - 1) });
		});
	});

	// Extract drop cap
	var dropChar = words[0].t[0];
	var dropRest = words[0].t.slice(1);
	if (dropRest) { words[0] = { t: dropRest, w: mw(dropRest), pb: words[0].pb }; }
	else { words.shift(); }

	mCtx.font = '700 ' + DROP_SIZE + 'px Georgia,"Iowan Old Style",Palatino,serif';
	var dropW = mCtx.measureText(dropChar).width + 10;
	var dropH = DROP_LINES * LINE_H;

	var dropEl = document.createElement('span');
	dropEl.className = 'ed-drop';
	dropEl.textContent = dropChar;
	dropEl.style.fontSize = DROP_SIZE + 'px';
	dropEl.style.left = '0px';
	dropEl.style.top = '0px';
	area.appendChild(dropEl);

	// Orb setup
	orbEl.style.width = ORB_DIM + 'px';
	orbEl.style.height = ORB_DIM + 'px';

	var cW = 0, cH = 600;
	var ox = 0, oy = 0, ovx = 18, ovy = 12;
	var edDrag = false, dox = 0, doy = 0;
	var edLastT = 0, edInView = false, edSelecting = false;
	var edReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

	// Load avatar thumbnail into orb
	var AVATAR_ID = window.AVATAR_ID || 'bacff13e-b64b-4ac0-860d-44f0168ad23b';
	var orbImg = document.createElement('img');
	orbImg.alt = 'Agent avatar';
	orbImg.draggable = false;
	orbImg.src = 'https://pub-2534e921bf9c4314addcd4d8a6e98b7b.r2.dev/thumb/' + AVATAR_ID + '.png';
	orbAvatarSlot.appendChild(orbImg);

	// Span pool — reuse DOM elements across frames
	var linePool = [];
	function edGetSpan(i) {
		if (i < linePool.length) return linePool[i];
		var s = document.createElement('span');
		s.className = 'ed-line';
		area.appendChild(s);
		linePool.push(s);
		return s;
	}

	// Circle-line chord intersection
	function edChord(cx, cy, r, lt, lb) {
		var my = (lt + lb) / 2, dy = Math.abs(my - cy);
		if (dy >= r) return null;
		var hc = Math.sqrt(r * r - dy * dy);
		return { s: cx - hc, e: cx + hc };
	}

	// Subtract blocked intervals from a range, returning available slots
	function edSubInt(s, e, bl) {
		bl = bl.filter(function(b) { return b.e > s && b.s < e; }).sort(function(a, b) { return a.s - b.s; });
		var slots = [], cur = s;
		for (var i = 0; i < bl.length; i++) {
			if (bl[i].s > cur) slots.push({ s: cur, e: Math.min(bl[i].s, e) });
			cur = Math.max(cur, bl[i].e);
		}
		if (cur < e) slots.push({ s: cur, e: e });
		return slots;
	}

	// Layout a single column: fill words top-to-bottom, flowing around obstacles
	function edLayCol(si, cl, cr, sy, my, obs, dr) {
		var lines = [], y = sy, wi = si, colW = cr - cl, pgap = false;
		while (wi < words.length && y + LINE_H <= my) {
			if (pgap) { y += LINE_H * PARA_GAP; pgap = false; if (y + LINE_H > my) break; }

			var bl = [];
			for (var oi = 0; oi < obs.length; oi++) {
				var c = edChord(obs[oi].x, obs[oi].y, obs[oi].r, y, y + LINE_H);
				if (c && c.e > cl && c.s < cr) {
					bl.push({ s: Math.max(c.s - cl, 0), e: Math.min(c.e - cl, colW) });
				}
			}
			if (dr && y < dr.b && y + LINE_H > dr.t && dr.r > cl && dr.l < cr) {
				bl.push({ s: Math.max(dr.l - cl, 0), e: Math.min(dr.r - cl, colW) });
			}

			var slots = edSubInt(0, colW, bl);
			for (var sj = 0; sj < slots.length; sj++) {
				var sw = slots[sj].e - slots[sj].s;
				if (sw < MIN_SLOT) continue;
				var txt = '', lw = 0;
				while (wi < words.length) {
					var wd = words[wi];
					var need = lw === 0 ? wd.w : spW + wd.w;
					if (lw + need > sw && lw > 0) break;
					txt += (lw === 0 ? '' : ' ') + wd.t;
					lw += (lw === 0 ? 0 : spW) + wd.w;
					wi++;
				}
				if (txt) lines.push({ t: txt, x: cl + slots[sj].s, y: y });
			}
			if (wi > 0 && words[wi - 1] && words[wi - 1].pb) pgap = true;
			y += LINE_H;
		}
		return { lines: lines, nw: wi };
	}

	// Full layout: 2 columns on desktop, 1 on mobile, with cursor handoff
	function edComputeLayout() {
		cW = area.clientWidth;
		var mob = cW < 720;
		var colW = mob ? cW : (cW - COL_GAP) / 2;
		var maxH = 1200;
		var obs = [{ x: ox, y: oy, r: ORB_R + ORB_PAD }];
		var dr = { l: 0, t: 0, r: dropW, b: dropH };
		var all;

		if (mob) {
			var r1 = edLayCol(0, 0, colW, 0, maxH, obs, dr);
			all = r1.lines;
			cH = r1.lines.length ? r1.lines[r1.lines.length - 1].y + LINE_H + 40 : 480;
		} else {
			var c1 = edLayCol(0, 0, colW, 0, maxH, obs, dr);
			var c2l = colW + COL_GAP;
			var c2 = edLayCol(c1.nw, c2l, c2l + colW, 0, maxH, obs, null);
			all = c1.lines.concat(c2.lines);
			var h1 = c1.lines.length ? c1.lines[c1.lines.length - 1].y + LINE_H : 0;
			var h2 = c2.lines.length ? c2.lines[c2.lines.length - 1].y + LINE_H : 0;
			cH = Math.max(h1, h2, 480) + 40;
		}
		return all;
	}

	// Render with projection equality check — skip DOM writes when nothing changed
	var edPrevProj = '';
	function edRender(lines) {
		var proj = '';
		for (var i = 0; i < lines.length; i++) proj += lines[i].t + '|' + (lines[i].x | 0) + '|' + (lines[i].y | 0) + '\n';
		if (proj === edPrevProj) return;
		edPrevProj = proj;

		var max = Math.max(lines.length, linePool.length);
		for (var j = 0; j < max; j++) {
			if (j < lines.length) {
				var sp = edGetSpan(j);
				sp.textContent = lines[j].t;
				sp.style.left = lines[j].x + 'px';
				sp.style.top = lines[j].y + 'px';
				sp.style.display = '';
			} else if (j < linePool.length) {
				linePool[j].style.display = 'none';
			}
		}
		area.style.height = cH + 'px';
	}

	// 60fps animation loop — physics + layout + render
	function edTick(now) {
		if (!edInView) { requestAnimationFrame(edTick); return; }
		var dt = edLastT ? Math.min((now - edLastT) / 1000, 0.05) : 0.016;
		edLastT = now;

		if (!edDrag && !edReduced && !edSelecting) {
			ox += ovx * dt;
			oy += ovy * dt;
			if (ox - ORB_R < 0) { ox = ORB_R; ovx = Math.abs(ovx); }
			if (ox + ORB_R > cW) { ox = cW - ORB_R; ovx = -Math.abs(ovx); }
			if (oy - ORB_R < 0) { oy = ORB_R; ovy = Math.abs(ovy); }
			if (oy + ORB_R > cH - 20) { oy = cH - 20 - ORB_R; ovy = -Math.abs(ovy); }
		}

		orbEl.style.transform = 'translate(' + (ox - ORB_R) + 'px,' + (oy - ORB_R) + 'px)';
		edRender(edComputeLayout());
		requestAnimationFrame(edTick);
	}

	// Pause drift while user is selecting text
	document.addEventListener('selectionchange', function() {
		var sel = window.getSelection();
		edSelecting = sel && sel.toString().length > 0 && area.contains(sel.anchorNode);
	});

	// Drag interaction
	area.addEventListener('pointerdown', function(e) {
		if (e.button !== 0) return;
		var rect = area.getBoundingClientRect();
		var px = e.clientX - rect.left, py = e.clientY - rect.top;
		var dx = px - ox, dy = py - oy;
		if (Math.sqrt(dx * dx + dy * dy) > ORB_R + 20) return;
		edDrag = true; dox = dx; doy = dy;
		orbEl.style.cursor = 'grabbing';
		e.preventDefault();
	});
	window.addEventListener('pointermove', function(e) {
		if (!edDrag) return;
		var rect = area.getBoundingClientRect();
		ox = Math.max(ORB_R, Math.min(cW - ORB_R, e.clientX - rect.left - dox));
		oy = Math.max(ORB_R, Math.min(cH - ORB_R, e.clientY - rect.top - doy));
	});
	window.addEventListener('pointerup', function() {
		if (!edDrag) return;
		edDrag = false;
		orbEl.style.cursor = '';
		ovx = (Math.random() - 0.5) * 30;
		ovy = (Math.random() - 0.5) * 20;
	});

	// Only animate when section is in viewport
	var edIO = new IntersectionObserver(function(entries) {
		edInView = entries[0].isIntersecting;
	}, { threshold: 0, rootMargin: '200px' });
	edIO.observe(area);

	function edInitPos() {
		cW = area.clientWidth;
		cH = 600;
		ox = cW * (cW < 720 ? 0.5 : 0.35);
		oy = 160;
		edRender(edComputeLayout());
	}

	requestAnimationFrame(function() {
		edInitPos();
		requestAnimationFrame(edTick);
	});

	var edResizeT;
	window.addEventListener('resize', function() {
		clearTimeout(edResizeT);
		edResizeT = setTimeout(function() {
			cW = area.clientWidth;
			ox = Math.max(ORB_R, Math.min(cW - ORB_R, ox));
			oy = Math.max(ORB_R, Math.min(cH - ORB_R, oy));
			edRender(edComputeLayout());
		}, 150);
	});
})();
