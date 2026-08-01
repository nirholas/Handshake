/**
 * /play/solver: the solved economy of the /play open world.
 *
 * The companion page to /play/economy. That one publishes WHAT the world charges;
 * this one publishes what those numbers mean, by pricing every action in the world
 * at every skill level.
 *
 *   GET /api/play/solver  the whole model, plus a 99-level sweep for every node
 *
 * Two design decisions drive this file:
 *
 * 1. THE LEVEL CONTROL NEVER WAITS ON THE NETWORK. The endpoint ships the full
 *    per-level curve for every node in one response (about 20 KB), so dragging the
 *    slider redraws from memory. A page that round-tripped per level would feel
 *    broken at exactly the moment it is most interesting to play with.
 *
 * 2. NOTHING IS COMPUTED HERE. Every number rendered below comes off the wire from
 *    the model, which imports the game's own tables. Recomputing a rate client-side
 *    would create a second source of truth and reintroduce precisely the drift the
 *    whole design exists to prevent. The only arithmetic in this file is layout:
 *    turning numbers into pixel coordinates for the chart.
 *
 * The response is static config, so there is no meaningful "empty" state: it either
 * loads or the request failed, and a failure gets a real error state with a retry.
 */

const ENDPOINT = '/api/play/solver';

const fmtInt = (n) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
const fmt1 = (n) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n);
const fmt2 = (n) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);

// Family colours double as the chart legend, so they live in one place and are read
// back out of CSS custom properties at draw time to stay theme-correct.
const FAMILY = {
	chop: { label: 'Woodcutting', varName: '--ps-chop' },
	mine: { label: 'Mining', varName: '--ps-mine' },
	fish: { label: 'Fishing', varName: '--ps-fish' },
	cook: { label: 'Cooking', varName: '--ps-cook' },
	loop: { label: 'Fish and cook', varName: '--ps-loop' },
};

/** Minutes rendered the way a person would say them. */
function duration(minutes) {
	if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return 'never';
	if (minutes < 1) return `${fmt1(minutes * 60)}s`;
	if (minutes < 90) return `${fmt1(minutes)} min`;
	const hours = minutes / 60;
	if (hours < 48) return `${fmt1(hours)} hr`;
	return `${fmt1(hours / 24)} days`;
}

function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v === null || v === undefined || v === false) continue;
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else n.setAttribute(k, v === true ? '' : String(v));
	}
	for (const kid of [].concat(kids)) {
		if (kid === null || kid === undefined || kid === false) continue;
		n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
	}
	return n;
}

function svg(tag, props = {}, kids = []) {
	const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
	for (const [k, v] of Object.entries(props)) {
		if (v === null || v === undefined || v === false) continue;
		n.setAttribute(k, String(v));
	}
	for (const kid of [].concat(kids)) if (kid) n.append(kid);
	return n;
}

function stat(value, label, hint, tone) {
	return el('div', { class: `ps-stat${tone ? ` ps-stat-${tone}` : ''}` }, [
		el('div', { class: 'ps-stat-value', text: value }),
		el('div', { class: 'ps-stat-label', text: label }),
		hint ? el('div', { class: 'ps-stat-hint', text: hint }) : null,
	]);
}

/** Overflow that scrolls inside its own box, reachable by keyboard. */
function scroller(node, label) {
	return el(
		'div',
		{ class: 'ps-tablewrap', tabindex: '0', role: 'region', 'aria-label': label },
		[node],
	);
}

function table(headings, rows, { label, align = [] } = {}) {
	const thead = el('thead', {}, [
		el(
			'tr',
			{},
			headings.map((h, i) =>
				el('th', { scope: 'col', class: align[i] === 'right' ? 'ps-r' : null, text: h }),
			),
		),
	]);
	const tbody = el(
		'tbody',
		{},
		rows.map((cells) =>
			el(
				'tr',
				{ class: cells.rowClass || null },
				(cells.cells || cells).map((c, i) =>
					el(
						i === 0 ? 'th' : 'td',
						{
							scope: i === 0 ? 'row' : null,
							class: align[i] === 'right' ? 'ps-r' : null,
						},
						[c],
					),
				),
			),
		),
	);
	return scroller(el('table', { class: 'ps-table' }, [thead, tbody]), label);
}

function section(id, title, blurb, kids) {
	return el('section', { class: 'ps-section', id }, [
		el('h2', { class: 'ps-h2', text: title }),
		blurb ? el('p', { class: 'ps-blurb' }, [blurb]) : null,
		...[].concat(kids),
	]);
}

/* --- the chart ------------------------------------------------------------
 * A dependency-free SVG line chart. The repo has no shared chart helper and the
 * one charting dependency present is a candlestick library aimed at price series,
 * so a purpose-built 60-line renderer is both smaller and a better fit than
 * bending either to a level-versus-rate plot.
 *
 * viewBox coordinates with preserveAspectRatio="none" would distort stroke widths,
 * so the chart draws into a fixed logical box and scales with CSS width while
 * keeping its own aspect ratio. Every series is also published as a table below,
 * so the information is never trapped in the graphic.
 */
const CHART = { w: 900, h: 320, padL: 62, padR: 16, padT: 16, padB: 34 };

function chartFor(curves, metric, level, onScrub) {
	const series = curves.filter((c) => c.family !== 'cook');
	const levels = series[0] ? series[0][metric].length : 0;
	if (!levels) return el('div');

	const max = series.reduce(
		(m, s) => Math.max(m, s[metric].reduce((a, b) => Math.max(a, b), 0)),
		0,
	);
	const plotW = CHART.w - CHART.padL - CHART.padR;
	const plotH = CHART.h - CHART.padT - CHART.padB;
	const x = (i) => CHART.padL + (i / (levels - 1)) * plotW;
	const y = (v) => CHART.padT + plotH - (max > 0 ? v / max : 0) * plotH;

	const grid = [];
	const ticks = 4;
	for (let t = 0; t <= ticks; t += 1) {
		const value = (max / ticks) * t;
		const gy = y(value);
		grid.push(svg('line', { x1: CHART.padL, x2: CHART.w - CHART.padR, y1: gy, y2: gy, class: 'ps-grid' }));
		grid.push(
			svg('text', { x: CHART.padL - 8, y: gy + 4, class: 'ps-axis', 'text-anchor': 'end' }, [
				document.createTextNode(fmtInt(value)),
			]),
		);
	}
	for (const lv of [1, 25, 50, 75, levels]) {
		grid.push(
			svg('text', { x: x(lv - 1), y: CHART.h - 10, class: 'ps-axis', 'text-anchor': 'middle' }, [
				document.createTextNode(String(lv)),
			]),
		);
	}

	const lines = series.map((s) => {
		const points = s[metric].map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
		return svg('polyline', {
			points,
			class: `ps-line ps-line-${s.family}`,
			'data-key': s.key,
			fill: 'none',
		});
	});

	// The level marker is the whole point of the chart: it ties the tables below to
	// a position on every curve at once.
	const markerX = x(level - 1);
	const marker = svg('line', {
		x1: markerX, x2: markerX, y1: CHART.padT, y2: CHART.padT + plotH, class: 'ps-marker',
	});
	const dots = series.map((s) =>
		svg('circle', { cx: markerX, cy: y(s[metric][level - 1]), r: 4, class: `ps-dot ps-dot-${s.family}` }),
	);

	const node = svg(
		'svg',
		{
			viewBox: `0 0 ${CHART.w} ${CHART.h}`,
			class: 'ps-chart',
			role: 'img',
			'aria-label': `${metric === 'cash' ? 'Cash' : 'Experience'} per hour against skill level, for every gatherable node in the world. The full figures are in the activity table below.`,
		},
		[...grid, marker, ...lines, ...dots],
	);

	// Pointer scrubbing sets the level, so the chart is an input as well as an
	// output. Keyboard users get the same control from the slider, which is why the
	// SVG itself is not focusable: it would be a duplicate tab stop with no new
	// capability.
	if (onScrub) {
		const scrub = (event) => {
			const rect = node.getBoundingClientRect();
			const px = ((event.clientX - rect.left) / rect.width) * CHART.w;
			const ratio = (px - CHART.padL) / plotW;
			onScrub(Math.max(1, Math.min(levels, Math.round(ratio * (levels - 1)) + 1)));
		};
		node.addEventListener('pointerdown', (e) => {
			node.setPointerCapture(e.pointerId);
			scrub(e);
		});
		node.addEventListener('pointermove', (e) => {
			if (e.buttons) scrub(e);
		});
		node.classList.add('ps-chart-interactive');
	}
	return node;
}

function legend(curves) {
	const families = [...new Set(curves.filter((c) => c.family !== 'cook').map((c) => c.family))];
	return el(
		'ul',
		{ class: 'ps-legend' },
		families.map((f) =>
			el('li', { class: 'ps-legend-item' }, [
				el('span', { class: `ps-swatch ps-swatch-${f}`, 'aria-hidden': 'true' }),
				FAMILY[f]?.label || f,
			]),
		),
	);
}

/* --- sections ------------------------------------------------------------- */

function headline(model) {
	const best = model.bestRate;
	const bestXp = model.bestXpRate;
	const next = model.nextLevel;
	const catalogCost = model.payback.reduce((s, p) => s + p.price, 0);
	const catalogMinutes = best.cashPerHour > 0 ? (catalogCost / best.cashPerHour) * 60 : null;

	return el('div', { class: 'ps-stats' }, [
		stat(`${fmtInt(best.cashPerHour)}`, 'Best cash per hour', best.label, 'cash'),
		stat(`${fmtInt(bestXp.xpPerHour)}`, 'Best XP per hour', bestXp.label, 'xp'),
		stat(
			next ? duration(next.minutes) : 'At the cap',
			next ? `To level ${next.level}` : 'Level 99',
			next ? `${fmtInt(next.xp)} XP via ${next.via.toLowerCase()}` : 'Nothing left to earn',
		),
		stat(duration(catalogMinutes), 'To buy the whole store', `${fmtInt(catalogCost)} cash across ${model.payback.length} entries`),
	]);
}

function findingsSection(model) {
	const cards = model.findings.map((f) =>
		el('article', { class: `ps-finding ps-finding-${f.kind}` }, [
			el('p', { class: 'ps-finding-kind', text: f.kind === 'trap' ? 'Watch out' : f.kind === 'reward' ? 'Worth doing' : 'For scale' }),
			el('h3', { class: 'ps-finding-title', text: f.title }),
			el('p', { class: 'ps-finding-detail', text: f.detail }),
		]),
	);
	return section(
		'findings',
		'What the arithmetic concludes',
		'These are not editorial notes. Each one is assembled from the numbers computed for the level you selected, so if the game is retuned and a conclusion stops being true, it stops being shown rather than going quietly stale.',
		el('div', { class: 'ps-findings' }, cards),
	);
}

function chartSection(model, curves, state, rerender) {
	const toggle = el('div', { class: 'ps-toggle', role: 'group', 'aria-label': 'Chart metric' }, [
		el('button', {
			type: 'button',
			class: `ps-toggle-btn${state.metric === 'cash' ? ' is-on' : ''}`,
			'aria-pressed': state.metric === 'cash' ? 'true' : 'false',
			text: 'Cash per hour',
			onclick: () => { state.metric = 'cash'; rerender(); },
		}),
		el('button', {
			type: 'button',
			class: `ps-toggle-btn${state.metric === 'xp' ? ' is-on' : ''}`,
			'aria-pressed': state.metric === 'xp' ? 'true' : 'false',
			text: 'XP per hour',
			onclick: () => { state.metric = 'xp'; rerender(); },
		}),
	]);

	return section(
		'curves',
		'Every node, every level',
		'One line per gatherable node in the world, across all 99 levels. Drag anywhere on the chart to move the level. Cooking is charted as part of the fish-and-cook loop rather than on its own, because its standalone rate needs a fish supply no single player can deliver.',
		[
			el('div', { class: 'ps-chart-head' }, [toggle, legend(curves)]),
			el('div', { class: 'ps-chart-wrap' }, [
				// The marker follows `state.level`, not the loaded model's level, so it
				// tracks a drag frame-for-frame while the tables catch up behind it.
				chartFor(curves, state.metric, state.level, (lvl) => {
					if (lvl !== state.level) { state.level = lvl; rerender(); }
				}),
			]),
		],
	);
}

function ladderSection(model) {
	const rows = model.activities.map((a) => ({
		rowClass: a.sustainable ? null : 'ps-row-capped',
		cells: [
			el('div', { class: 'ps-cell-name' }, [
				el('span', { class: `ps-swatch ps-swatch-${a.family}`, 'aria-hidden': 'true' }),
				el('span', { text: a.label }),
				a.sustainable
					? null
					: el('span', { class: 'ps-tag', title: a.requires, text: 'needs a supply' }),
			]),
			a.node.difficulty ? fmt1(a.node.difficulty) : a.node.quality ? `${fmt1(a.node.quality)} quality` : 'n/a',
			`${fmt1(a.successPct)}%`,
			fmt1(a.unitsPerHour),
			a.coalPerHour ? fmt1(a.coalPerHour) : 'n/a',
			fmtInt(a.cashPerHour),
			fmtInt(a.xpPerHour),
			a.packHours ? `${fmt1(a.packHours)} hr` : 'n/a',
		],
	}));

	return section(
		'ladder',
		'The activity ladder',
		'Every node priced at the selected level, ranked by cash. Rates that cannot be sustained always sort last regardless of size: ranking a number nobody can hold above one anybody can would make the table advice you cannot follow.',
		table(
			['Activity', 'Node', 'Hit rate', 'Units per hour', 'Coal per hour', 'Cash per hour', 'XP per hour', 'Pack lasts'],
			rows,
			{
				label: 'Expected yield per hour for every gatherable node',
				align: ['', '', 'right', 'right', 'right', 'right', 'right', 'right'],
			},
		),
	);
}

function loopSection(model) {
	const loop = model.loop;
	const bar = el('div', { class: 'ps-split', role: 'img', 'aria-label': `${fmt1(loop.fishSharePct)} percent of the hour fishing, ${fmt1(loop.cookSharePct)} percent cooking` }, [
		el('div', { class: 'ps-split-fish', style: `width:${loop.fishSharePct}%` }, [
			el('span', { class: 'ps-split-label', text: `Fish ${fmt1(loop.fishSharePct)}%` }),
		]),
		el('div', { class: 'ps-split-cook', style: `width:${loop.cookSharePct}%` }, [
			el('span', { class: 'ps-split-label', text: `Cook ${fmt1(loop.cookSharePct)}%` }),
		]),
	]);

	return section(
		'loop',
		'The one split worth getting right',
		'Cooked fish sells for three times what raw fish sells for, but you cannot fish and cook at the same time. So the real question is how to divide an hour between them. Supply meets demand at exactly one split, and at that split nothing queues and nothing idles.',
		[
			bar,
			el('div', { class: 'ps-stats ps-stats-tight' }, [
				stat(fmtInt(loop.cashPerHour), 'Cash per hour, split', `at the ${fmt1(loop.fishSharePct)} to ${fmt1(loop.cookSharePct)} balance`, 'cash'),
				stat(fmtInt(loop.rawOnlyCashPerHour), 'Cash per hour, raw only', 'a full hour fishing, sold uncooked'),
				stat(`+${fmt1(loop.upliftPct)}%`, 'What cooking is worth', 'the return on learning to cook', 'good'),
				stat(fmt1(loop.cookedPerHour), 'Cooked fish per hour', `from ${fmt1(loop.fishPerHour)} caught`),
			]),
		],
	);
}

function paybackSection(model) {
	const rows = model.payback.map((p) => [
		p.qty > 1 ? `${p.label} (${p.qty})` : p.label,
		fmtInt(p.price),
		p.qty > 1 ? fmt2(p.unitPrice) : 'n/a',
		duration(p.minutes),
		p.attempts === null ? 'never' : fmtInt(p.attempts),
	]);

	return section(
		'payback',
		'What the store costs in playtime',
		el('span', {}, [
			'Every catalog entry priced against the best rate you can actually hold at this level (',
			el('strong', { text: model.bestRate.label.toLowerCase() }),
			`, ${fmtInt(model.bestRate.cashPerHour)} cash per hour). Bundles show their per-unit price, because a sticker price on a stack of twelve is not comparable to one on a single item.`,
		]),
		table(
			['Item', 'Price', 'Per unit', 'Time to afford', 'Swings'],
			rows,
			{ label: 'Time and swings to afford each store item', align: ['', 'right', 'right', 'right', 'right'] },
		),
	);
}

function wheelSection(model) {
	const w = model.wheel;
	return section(
		'wheel',
		"Fortune's Folly, priced",
		'Valuing every wedge at what the store would pay for it turns the wheel from a mystery into a number. The spread is almost entirely one jackpot wedge, which is why the average outcome is not the typical one.',
		el('div', { class: 'ps-stats ps-stats-tight' }, [
			stat(fmt1(w.evCash), 'Average spin', `across ${w.wedges} wedges`, 'cash'),
			stat(`±${fmt1(w.stdevCash)}`, 'Standard deviation', `best ${fmtInt(w.bestCash)}, worst ${fmtInt(w.worstCash)}`),
			stat(`${fmt1(w.aboveEvPct)}%`, 'Land at or above average', 'the jackpot drags the mean up'),
			stat(duration(w.minutesOfBestRate), 'A free spin, in playtime', `${fmtInt(w.evPerDayCash)} cash a day from ${fmt1(w.freeSpinsPerDay)} free spins`),
		]),
	);
}

function combatSection(model) {
	const rows = model.combat.map((m) => [
		el('div', { class: 'ps-cell-name' }, [
			el('span', { text: m.label }),
			m.hostile ? null : el('span', { class: 'ps-tag', text: 'passive' }),
		]),
		fmtInt(m.hp),
		fmtInt(m.xp),
		fmtInt(m.gold),
		fmt1(m.lootCash),
		fmt1(m.totalCash),
		m.mountPct > 0 ? `${fmt1(m.mountPct)}%` : 'none',
	]);

	return section(
		'combat',
		'What a kill is worth',
		'Combat is priced per kill rather than per hour, because kill speed depends on your weapon, your aim and how fast the world respawns, none of which is a constant the model can honestly assume. Loot is valued at store prices and every drop line is an independent roll, so the expectations simply add. Mounts have no sell price and never inflate a cash figure.',
		table(
			['Enemy', 'HP', 'XP', 'Cash', 'Loot value', 'Total per kill', 'Mount chance'],
			rows,
			{ label: 'Expected value of one kill, per enemy', align: ['', 'right', 'right', 'right', 'right', 'right', 'right'] },
		),
	);
}

function methodSection(model) {
	return section(
		'method',
		'How this is computed, and where it stops being true',
		null,
		[
			el('p', { class: 'ps-blurb', text: model.method.summary }),
			el('p', { class: 'ps-blurb', text: model.method.exactness }),
			el('h3', { class: 'ps-h3', text: 'Read from' }),
			el('ul', { class: 'ps-list' }, model.method.source.map((s) => el('li', {}, [el('code', { text: s.split(':')[0] }), s.slice(s.indexOf(':') + 1)]))),
			el('h3', { class: 'ps-h3', text: 'Assumptions' }),
			el('ol', { class: 'ps-list ps-list-numbered' }, model.assumptions.map((a) => el('li', { text: a }))),
		],
	);
}

/* --- the level control ---------------------------------------------------- */

function levelControl(state, model, rerender) {
	const slider = el('input', {
		type: 'range',
		min: '1',
		max: String(model.levelCap),
		value: String(state.level),
		class: 'ps-slider',
		id: 'ps-level',
		'aria-describedby': 'ps-level-readout',
	});
	slider.addEventListener('input', () => {
		state.level = Number(slider.value);
		rerender({ keepFocus: 'slider' });
	});

	const chips = [1, 3, 10, 30, 60, model.levelCap].map((lv) =>
		el('button', {
			type: 'button',
			class: `ps-chip${state.level === lv ? ' is-on' : ''}`,
			'aria-pressed': state.level === lv ? 'true' : 'false',
			text: lv === model.levelCap ? `${lv} (cap)` : String(lv),
			onclick: () => { state.level = lv; rerender(); },
		}),
	);

	return el('div', { class: 'ps-control' }, [
		el('div', { class: 'ps-control-head' }, [
			el('label', { class: 'ps-control-label', for: 'ps-level', text: 'Skill level' }),
			el('output', { class: 'ps-readout', id: 'ps-level-readout', for: 'ps-level', text: String(state.level) }),
		]),
		slider,
		el('div', { class: 'ps-chips' }, [
			el('span', { class: 'ps-chips-label', text: 'Jump to' }),
			...chips,
		]),
		el('p', {
			class: 'ps-control-note',
			text: 'The model holds every skill at this level at once, so the ladder compares like with like. In a real session your skills diverge, and each row tracks whichever skill it names.',
		}),
	]);
}

/* --- states --------------------------------------------------------------- */

function skeleton() {
	const bar = (w) => el('div', { class: 'ps-skel-bar', style: `width:${w}` });
	return el('div', { class: 'ps-skeleton', 'aria-hidden': 'true' }, [
		el('div', { class: 'ps-skel-control' }),
		el('div', { class: 'ps-stats' }, [0, 1, 2, 3].map(() => el('div', { class: 'ps-skel-stat' }))),
		el('div', { class: 'ps-skel-chart' }),
		el('div', { class: 'ps-skel-rows' }, [bar('92%'), bar('78%'), bar('85%'), bar('64%'), bar('71%')]),
	]);
}

function errorState(message, retry) {
	return el('div', { class: 'ps-error', role: 'alert' }, [
		el('h2', { class: 'ps-error-title', text: 'The solver could not load' }),
		el('p', { class: 'ps-error-body', text: message }),
		el('div', { class: 'ps-error-actions' }, [
			el('button', { type: 'button', class: 'ps-btn ps-btn-primary', text: 'Try again', onclick: retry }),
			el('a', { class: 'ps-btn', href: '/play/economy', text: 'See the raw price tables' }),
			el('a', { class: 'ps-btn', href: '/play', text: 'Enter the world' }),
		]),
	]);
}

/* --- boot ----------------------------------------------------------------- */

const root = document.getElementById('ps-content');
const status = document.getElementById('ps-status');

// One fetch holds the whole model plus the 99-level sweep. `models` caches the
// per-level solve so re-rendering a level already visited costs nothing; the curves
// are shared across all of them.
const state = { level: 1, metric: 'cash', curves: null, models: new Map() };

function setStatus(text) {
	if (status) status.textContent = text;
}

async function loadLevel(level) {
	if (state.models.has(level)) return state.models.get(level);
	const url = state.curves ? `${ENDPOINT}?level=${level}&curves=0` : `${ENDPOINT}?level=${level}`;
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) throw new Error(`The solver endpoint answered ${res.status}.`);
	const body = await res.json();
	if (body.curves) state.curves = body.curves;
	state.models.set(body.level, body);
	return body;
}

// A drag fires `input` on every pixel. Each unvisited level needs one solve from the
// server, so requests are coalesced: the chart and the level readout move on the
// current frame, and the tables re-solve once the control settles.
let pending = null;
function requestLevel(level, opts) {
	if (state.models.has(level)) { render(opts); return; }
	clearTimeout(pending);
	pending = setTimeout(() => {
		loadLevel(level)
			.then(() => { if (state.level === level) render(opts); })
			.catch((err) => setStatus(`Could not solve level ${level}: ${err.message}`));
	}, 120);
	// Draw the frame anyway so the chart marker and the readout stay live.
	render(opts);
}

function render(opts = {}) {
	// While an unvisited level is in flight, the tables keep showing the last solved
	// level rather than blanking. `stale` marks that explicitly instead of letting the
	// page quietly present one level's chart beside another level's numbers.
	const exact = state.models.get(state.level);
	const model = exact || state.lastModel;
	if (!model) return;
	state.lastModel = model;
	const stale = !exact;

	const rerender = (o) => requestLevel(state.level, o);

	root.replaceChildren(
		levelControl(state, model, rerender),
		headline(model),
		findingsSection(model),
		chartSection(model, state.curves || [], state, rerender),
		ladderSection(model),
		loopSection(model),
		paybackSection(model),
		wheelSection(model),
		combatSection(model),
		methodSection(model),
	);

	root.classList.toggle('ps-stale', stale);

	// Dragging the slider re-creates it, so focus has to be restored or the control
	// dies under the user's finger after one step.
	if (opts.keepFocus === 'slider') {
		const slider = document.getElementById('ps-level');
		if (slider) slider.focus();
	}
	setStatus(
		stale
			? `Solving level ${state.level}.`
			: `Solved at level ${model.level}. Best sustainable rate: ${model.bestRate.label}, ${fmtInt(model.bestRate.cashPerHour)} cash per hour.`,
	);
}

async function boot() {
	root.replaceChildren(skeleton());
	setStatus('Solving the world economy.');
	try {
		await loadLevel(state.level);
		render();
	} catch (err) {
		const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
		const message = offline
			? 'You appear to be offline. The solver reads live from the game server, so it needs a connection.'
			: `${err.message} The model is static config, so this is a transport problem rather than missing data. Retrying usually clears it.`;
		root.replaceChildren(errorState(message, boot));
		setStatus(message);
	}
}

// The solver is deep-linkable by level, so a shared URL lands on the same numbers.
const initial = Number(new URLSearchParams(location.search).get('level'));
if (Number.isFinite(initial) && initial >= 1) state.level = Math.min(99, Math.floor(initial));

boot();
