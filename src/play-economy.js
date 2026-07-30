/**
 * /play/economy: the public reference for the in-game economy.
 *
 * The /play open world has a real economy (a cash purse, a general store, a
 * bank that protects your money through death, a $THREE cosmetics boutique and
 * a wheel), but until now the only way to learn any of its numbers was to walk
 * up to the NPC and read the modal. This page publishes the whole thing.
 *
 *   GET /api/play/economy  every catalog, gate and constant, read server-side
 *                          from the same modules WalkRoom prices trades with
 *
 * Nothing here is transcribed or estimated: the endpoint imports the game's own
 * tables, so a price rendered on this page is the price the server will charge.
 * That is also why there is no "empty" state to design. The response is static
 * config, so it is either present or the request failed, and a failed request
 * gets a real error state with a retry rather than a blank page.
 */

const ENDPOINT = '/api/play/economy';

const fmtCash = (n) => new Intl.NumberFormat('en-US').format(n);
const fmtToken = (n) =>
	new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);
const fmtPct = (n) =>
	new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n);

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

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

/** A labelled figure tile. Used for the gates and progression rows. */
function stat(value, label, hint) {
	return el('div', { class: 'pe-stat' }, [
		el('div', { class: 'pe-stat-value', text: value }),
		el('div', { class: 'pe-stat-label', text: label }),
		hint ? el('div', { class: 'pe-stat-hint', text: hint }) : null,
	]);
}

/**
 * Wrap a table so it scrolls inside its own box on narrow screens instead of
 * forcing the whole page to scroll sideways. Tabbable + labelled so a keyboard
 * user can actually reach the overflow.
 */
function scroller(table, label) {
	return el(
		'div',
		{ class: 'pe-tablewrap', tabindex: '0', role: 'region', 'aria-label': label },
		[table],
	);
}

function table(headings, rows, { label, align = [] } = {}) {
	const thead = el('thead', {}, [
		el(
			'tr',
			{},
			headings.map((h, i) =>
				el('th', { scope: 'col', class: align[i] === 'right' ? 'pe-r' : null, text: h }),
			),
		),
	]);
	const tbody = el(
		'tbody',
		{},
		rows.map((cells) =>
			el(
				'tr',
				{},
				cells.map((c, i) =>
					el(
						'td',
						{ class: align[i] === 'right' ? 'pe-r' : null },
						c && c.nodeType ? [c] : [c],
					),
				),
			),
		),
	);
	return scroller(el('table', { class: 'pe-table' }, [thead, tbody]), label);
}

function section(id, kicker, title, blurb, body) {
	return el('section', { class: 'pe-section', id }, [
		el('div', { class: 'pe-section-head' }, [
			el('p', { class: 'pe-kicker', text: kicker }),
			el('h2', { class: 'pe-h2', text: title }),
			blurb ? el('p', { class: 'pe-blurb', text: blurb }) : null,
		]),
		body,
	]);
}

function renderCurrencies(data) {
	const { cash, token } = data.currencies;
	const card = (c, tone) =>
		el('article', { class: `pe-cur pe-cur-${tone}` }, [
			el('div', { class: 'pe-cur-top' }, [
				el('span', { class: 'pe-cur-name', text: c.label }),
				el('span', {
					class: `pe-chip ${c.onchain ? 'pe-chip-chain' : 'pe-chip-game'}`,
					text: c.onchain ? 'On-chain' : 'In-game only',
				}),
			]),
			el('p', { class: 'pe-cur-sum', text: c.summary }),
			c.onchain
				? el('p', { class: 'pe-cur-foot' }, [
						'Settles on ',
						el('strong', { text: c.chain === 'solana' ? 'Solana' : c.chain }),
						'. Every purchase is verified on-chain before the item is granted.',
					])
				: el('p', { class: 'pe-cur-foot', text: 'Never leaves the game. Not a token, not tradable.' }),
		]);

	return el('div', { class: 'pe-cur-grid' }, [card(cash, 'game'), card(token, 'chain')]);
}

function renderStore(data) {
	const { sell, buy } = data.generalStore;

	const sellTable = table(
		['Item', 'Store pays'],
		sell.map((r) => [r.label, el('span', { class: 'pe-cash', text: `${fmtCash(r.price)} cash` })]),
		{ label: 'What the general store pays for gathered goods', align: ['left', 'right'] },
	);

	const buyTable = table(
		['Item', 'Qty', 'Price', 'Per unit'],
		buy.map((r) => [
			r.label,
			`x${r.qty}`,
			el('span', { class: 'pe-cash', text: `${fmtCash(r.price)} cash` }),
			el('span', { class: 'pe-muted', text: r.qty > 1 ? `${fmtCash(r.unitPrice)} ea` : '' }),
		]),
		{ label: 'What the general store sells', align: ['left', 'right', 'right', 'right'] },
	);

	return el('div', { class: 'pe-split' }, [
		el('div', { class: 'pe-panel' }, [
			el('h3', { class: 'pe-h3', text: 'It buys what you gather' }),
			el('p', {
				class: 'pe-note',
				text: 'Only gathered and looted goods are sellable. Tools, weapons, mounts and your starter kit are deliberately excluded, so nobody can dump their kit for cash or farm a buy-then-sell loop.',
			}),
			sellTable,
		]),
		el('div', { class: 'pe-panel' }, [
			el('h3', { class: 'pe-h3', text: 'It sells what you need' }),
			el('p', {
				class: 'pe-note',
				text: 'Tools, consumables and ammo, all priced by the server. The client renders this catalog from the same table the server charges against, so the price you see is the price you pay.',
			}),
			buyTable,
		]),
	]);
}

function renderBank(data) {
	return el('div', { class: 'pe-panel pe-bank' }, [
		el('div', { class: 'pe-bank-copy' }, [
			el('h3', { class: 'pe-h3', text: 'The bank is the only thing death cannot take' }),
			el('p', { class: 'pe-blurb', text: data.bank.summary }),
		]),
		el('div', { class: 'pe-bank-viz' }, [
			el('div', { class: 'pe-bank-row pe-bank-risk' }, [
				el('span', { class: 'pe-bank-label', text: 'Carried purse' }),
				el('span', { class: 'pe-bank-fate', text: 'Drops on death' }),
			]),
			el('div', { class: 'pe-bank-row pe-bank-safe' }, [
				el('span', { class: 'pe-bank-label', text: 'Banked cash' }),
				el('span', { class: 'pe-bank-fate', text: 'Survives' }),
			]),
		]),
	]);
}

function renderBoutique(data) {
	const { listings, currency, rewardsBps, treasuryBps } = data.boutique;
	const sorted = [...listings].sort((a, b) => {
		const ra = RARITY_ORDER.indexOf(a.rarity);
		const rb = RARITY_ORDER.indexOf(b.rarity);
		if (ra !== rb) return rb - ra;
		return b.price - a.price;
	});

	const cards = el(
		'div',
		{ class: 'pe-fit-grid' },
		sorted.map((c) =>
			el('article', { class: `pe-fit pe-rar-${c.rarity || 'common'}` }, [
				el('div', {
					class: 'pe-fit-swatch',
					style: c.swatch ? `--sw:${c.swatch}` : null,
					'aria-hidden': 'true',
				}),
				el('div', { class: 'pe-fit-body' }, [
					el('h4', { class: 'pe-fit-name', text: c.name }),
					el('p', { class: 'pe-fit-meta' }, [
						el('span', { class: 'pe-fit-slot', text: c.slotLabel }),
						el('span', { class: `pe-rarity pe-rarity-${c.rarity || 'common'}`, text: c.rarity }),
					]),
				]),
				el('div', { class: 'pe-fit-price' }, [
					el('span', { class: 'pe-fit-amt', text: fmtToken(c.price) }),
					el('span', { class: 'pe-fit-cur', text: currency }),
				]),
			]),
		),
	);

	const split = el('div', { class: 'pe-splitbar' }, [
		el('div', {
			class: 'pe-splitbar-seg pe-splitbar-rewards',
			style: `--w:${rewardsBps / 100}%`,
			text: `${rewardsBps / 100}% holder rewards`,
		}),
		el('div', {
			class: 'pe-splitbar-seg pe-splitbar-treasury',
			style: `--w:${treasuryBps / 100}%`,
			text: `${treasuryBps / 100}% treasury`,
		}),
	]);

	return el('div', {}, [
		cards,
		el('div', { class: 'pe-panel pe-flow' }, [
			el('h3', { class: 'pe-h3', text: 'How a purchase settles' }),
			el('ol', { class: 'pe-steps' }, [
				el('li', {}, [
					el('strong', { text: 'Quote. ' }),
					'The server prices the charge from its own catalog, never from a number the client sends.',
				]),
				el('li', {}, [
					el('strong', { text: 'Sign. ' }),
					'You sign one split transaction from your connected Solana wallet.',
				]),
				el('li', {}, [
					el('strong', { text: 'Verify. ' }),
					'The server re-fetches the confirmed transaction from RPC and checks destination and amount before granting anything. A settled quote cannot be replayed.',
				]),
			]),
			el('p', { class: 'pe-note', text: `Every paid ${currency} sale splits like this:` }),
			split,
		]),
	]);
}

function renderWheel(data) {
	const w = data.wheel;
	const maxOdds = Math.max(...w.paytable.map((r) => r.oddsPct), 1);

	const gates = el('div', { class: 'pe-stats' }, [
		stat(`${w.freeSpinCooldownHours}h`, 'Free spin cooldown', 'Persisted, survives a disconnect'),
		stat(`$${w.paidSpinUsd}`, 'Paid spin', `Charged in ${data.boutique.currency}`),
		stat(`Lv ${w.minAvgLevel}`, 'Average level gate', 'A light anti-farm floor'),
		stat(String(w.wedges), 'Wedges', 'All equal odds by design'),
	]);

	const rows = w.paytable.map((r) => [
		el('span', { class: r.kind === 'gold' ? 'pe-cash' : '' , text: r.label }),
		String(r.wedges),
		el('div', { class: 'pe-odds' }, [
			el('div', { class: 'pe-odds-bar' }, [
				el('span', { class: 'pe-odds-fill', style: `--w:${(r.oddsPct / maxOdds) * 100}%` }),
			]),
			el('span', { class: 'pe-odds-num', text: `${fmtPct(r.oddsPct)}%` }),
		]),
	]);

	return el('div', {}, [
		gates,
		el('div', { class: 'pe-panel' }, [
			el('h3', { class: 'pe-h3', text: 'Every outcome, and how often it lands' }),
			el('p', {
				class: 'pe-note',
				text: 'Identical wedges are grouped here, with their odds summed. The wheel checks there is pack room for any possible item prize before a spin is offered or paid for, so a win can never be lost to a full inventory.',
			}),
			table(['Prize', 'Wedges', 'Chance'], rows, {
				label: 'Wheel of Fortune paytable',
				align: ['left', 'right', 'left'],
			}),
		]),
	]);
}

function renderProgression(data) {
	const p = data.progression;
	return el('div', {}, [
		el('div', { class: 'pe-stats' }, [
			stat(String(p.skills.length), 'Skills', p.skills.join(', ')),
			stat(String(p.levelCap), 'Level cap', 'Per skill'),
			stat(String(p.inventorySlots), 'Inventory slots', `Stacks to ${fmtCash(p.maxStack)}`),
			stat(String(p.hotbarSlots), 'Hotbar slots', 'Quick-use row'),
		]),
	]);
}

function render(root, data) {
	root.replaceChildren(
		section(
			'currencies',
			'Two currencies',
			'Cash and $THREE never mix',
			'One is a game resource, the other is a real on-chain token. Keeping them separate is deliberate: nothing you earn by playing can be cashed out, and nothing you buy on-chain can be farmed.',
			renderCurrencies(data),
		),
		section(
			'store',
			'The general store',
			'Walk up to the clerk, press E',
			null,
			renderStore(data),
		),
		section('bank', 'The bank', 'Deposit before you go anywhere dangerous', null, renderBank(data)),
		section(
			'boutique',
			'The boutique',
			`Premium fits, paid in ${data.boutique.currency}`,
			'The only place in the world economy that touches the chain. Everything else settles in room state.',
			renderBoutique(data),
		),
		section('wheel', 'Fortune’s Folly', 'The wheel in the plaza', null, renderWheel(data)),
		section(
			'progression',
			'Progression',
			'What the economy is tuned against',
			null,
			renderProgression(data),
		),
	);
}

function renderSkeleton(root) {
	const block = (h) => el('div', { class: 'pe-skel', style: `--h:${h}` });
	root.replaceChildren(
		el('div', { class: 'pe-skel-wrap' }, [
			block('120px'),
			block('260px'),
			block('180px'),
			block('220px'),
		]),
	);
}

function renderError(root, message, retry) {
	root.replaceChildren(
		el('div', { class: 'pe-error', role: 'alert' }, [
			el('h2', { class: 'pe-h2', text: 'The economy reference did not load' }),
			el('p', { class: 'pe-blurb', text: message }),
			el('div', { class: 'pe-error-actions' }, [
				el('button', { class: 'pe-btn pe-btn-primary', type: 'button', onclick: retry }, [
					'Try again',
				]),
				el('a', { class: 'pe-btn', href: '/play' }, ['Go to /play instead']),
			]),
		]),
	);
}

async function load() {
	const root = document.getElementById('pe-content');
	const status = document.getElementById('pe-status');
	if (!root) return;

	renderSkeleton(root);
	if (status) status.textContent = 'Loading the economy reference';

	try {
		const res = await fetch(ENDPOINT, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`The server returned ${res.status}.`);
		const data = await res.json();
		render(root, data);
		if (status) status.textContent = 'Economy reference loaded';
	} catch (err) {
		const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
		renderError(
			root,
			offline
				? 'You appear to be offline. Reconnect and try again.'
				: `${err.message || 'The request failed.'} These numbers are static config, so a retry usually works.`,
			load,
		);
		if (status) status.textContent = 'Economy reference failed to load';
	}
}

load();
