// GameHud — the DOM HUD layer for the /game isometric client: the hotbar, the
// quest panel (tutorial + daily quests), Aldric's dialog, and the bank panel.
//
// It owns only DOM + presentation. Every player intent flows back out through
// callbacks passed in `opts` (onEquip, onDeposit, onWithdraw, onTurnIn, …) so
// the scene controller (iso-game.js) stays the single owner of the network and
// world state. The HUD is told what to render via setHotbar/setInventory/
// setBank/setQuests and never reaches into the scene itself.
//
// All quest state shown here is the server's authoritative snapshot — progress
// bars, reward previews, turn-in availability, and the reset countdown are
// derived from it. The countdown ticks on the real clock and, when it elapses,
// asks the controller to re-fetch (onReset) so a new day's board appears
// without a reconnect.

// Item presentation. Icons are emoji so there is no asset pipeline to miss; the
// server's item registry (the 'items' message) can override labels later, but
// these cover everything the world produces today.
const ITEM_META = {
	axe: { icon: '🪓', label: 'Axe' },
	pickaxe: { icon: '⛏️', label: 'Pickaxe' },
	rod: { icon: '🎣', label: 'Fishing Rod' },
	hammer: { icon: '🔨', label: 'Hammer' },
	sword: { icon: '⚔️', label: 'Sword' },
	wood: { icon: '🪵', label: 'Wood' },
	stone: { icon: '🪨', label: 'Stone' },
	coal: { icon: '⚫', label: 'Coal' },
	fish: { icon: '🐟', label: 'Raw Fish' },
	cookedFish: { icon: '🍤', label: 'Cooked Fish' },
	bones: { icon: '🦴', label: 'Bones' },
	hide: { icon: '🟫', label: 'Beast Hide' },
	healthPotion: { icon: '🧪', label: 'Health Potion' },
	dire_wolf: { icon: '🐺', label: 'Dire Wolf' },
	war_boar: { icon: '🐗', label: 'War Boar' },
};
export function itemMeta(id) {
	return ITEM_META[id] || { icon: '📦', label: id ? id[0].toUpperCase() + id.slice(1) : '' };
}

// Emoji shown on a worn-prop cosmetic's shop/wardrobe chip, by cosmetic id. The
// 3D prop itself is the real cosmetic; this is just the catalogue glyph.
const PROP_ICON = {
	'hat-beanie': '🧢',
	'hat-baseball': '🧢',
	'hat-cowboy': '🤠',
};

const SKILL_LABEL = { combat: 'Combat', woodcutting: 'Woodcutting', mining: 'Mining', fishing: 'Fishing', cooking: 'Cooking' };

function fmtCountdown(ms) {
	if (ms <= 0) return 'now';
	const s = Math.floor(ms / 1000);
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${sec}s`;
	return `${sec}s`;
}

function el(tag, cls, html) {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (html != null) e.innerHTML = html;
	return e;
}

export class GameHud {
	constructor(opts = {}) {
		this.opts = opts;
		this.snapshot = null;       // latest quest snapshot
		this.inv = [];              // local player's backpack slots
		this.bank = [];             // bank contents
		this.hotbarSlots = [];
		this.activeSlot = -1;
		this._tutHintSlot = -1; // hotbar index the active tutorial step is teaching (-1 = none)
		this._questOpen = false;
		this._bankOpen = false;
		this._npcOpen = false;
		this._resetAt = 0;
		// Cosmetics shop (Task 21): the static catalogue (id → entry) + rarity
		// palette, the latest live board (offers/owned/equipped), the current gold,
		// the open flag + active tab, and the rotation deadlines the ticker counts
		// down to (re-fetching the board when one elapses).
		this.cosmetics = new Map();
		this.rarities = {};
		this.shop = null;
		this.gold = 0;
		this._shopOpen = false;
		this._shopTab = 'shop';
		this._dailyResetAt = 0;
		this._weeklyResetAt = 0;
		// Marketplace (Task 20): the latest board (active listings + your own), the
		// token-payment capability flags, the open flag + active tab, per-listing
		// "busy" labels driven by the controller during an on-chain buy, an error
		// banner, and the Sell-form draft state (mode + selected item + inputs).
		this.market = { listings: [], mine: [], token: { enabled: false, symbol: '$THREE', decimals: 6, treasuryBps: 500 }, canToken: false };
		this._marketOpen = false;
		this._marketTab = 'buy';
		this._marketBusy = new Map(); // listingId -> status label shown on its card
		this._marketError = '';
		this._marketLoading = false;
		this._buyFilter = '';
		this._buySort = 'recent';
		this._sellMode = 'gold'; // 'gold' (item→gold) | 'token' (gold→$THREE)
		this._sellItem = '';     // selected backpack item id for a gold listing
		this._build();
		// One shared 1Hz ticker drives the live reset countdown wherever it shows.
		this._tick = this._tick.bind(this);
		this._timer = setInterval(this._tick, 1000);
	}

	// ---------------------------------------------------------------- build
	_build() {
		const root = el('div', 'kq-root');
		root.innerHTML = `
			<div id="kq-toolbar" class="kq-toolbar" hidden>
				<button id="kq-quest-btn" class="kq-tool-btn" type="button" aria-label="Quests (Q)" title="Quests (Q)">
					<span class="kq-tool-ic">📜</span><span class="kq-tool-lbl">Quests</span>
					<span id="kq-quest-dot" class="kq-dot" hidden></span>
				</button>
				<button id="kq-bank-btn" class="kq-tool-btn" type="button" aria-label="Open bank" title="Open bank" hidden>
					<span class="kq-tool-ic">🏦</span><span class="kq-tool-lbl">Bank</span>
				</button>
				<button id="kq-build-btn" class="kq-tool-btn" type="button" aria-label="Build (B)" title="Build (B)" hidden aria-expanded="false">
					<span class="kq-tool-ic">🔨</span><span class="kq-tool-lbl">Build</span>
				</button>
				<button id="kq-shop-btn" class="kq-tool-btn" type="button" aria-label="Cosmetics shop" title="Cosmetics shop" aria-expanded="false">
					<span class="kq-tool-ic">✨</span><span class="kq-tool-lbl">Shop</span>
				</button>
				<button id="kq-market-btn" class="kq-tool-btn" type="button" aria-label="Marketplace (M)" title="Marketplace (M)" aria-expanded="false">
					<span class="kq-tool-ic">🛒</span><span class="kq-tool-lbl">Market</span>
				</button>
				<span id="kq-gold" class="kq-gold" title="Gold"><span class="kq-gold-ic">🪙</span><b id="kq-gold-n">0</b></span>
			</div>

			<div id="kq-hotbar" class="kq-hotbar" hidden role="toolbar" aria-label="Hotbar"></div>

			<div id="kq-build-menu" class="kq-build-menu" hidden role="dialog" aria-label="Build menu">
				<header class="kq-build-head"><span class="kq-tool-ic">🔨</span><h2>Build</h2><button class="kq-x" id="kq-build-x" type="button" aria-label="Close">✕</button></header>
				<div class="kq-build-list" id="kq-build-list"></div>
			</div>

			<div id="kq-build-banner" class="kq-build-banner" hidden role="status">
				<span class="kq-build-banner-ic" id="kq-build-banner-ic">🔥</span>
				<span class="kq-build-banner-txt">Placing <b id="kq-build-banner-name">structure</b> · tap a tile to place</span>
				<button class="kq-btn kq-btn-ghost" id="kq-build-cancel" type="button">Cancel</button>
			</div>

			<aside id="kq-quests" class="kq-panel" hidden aria-label="Quests">
				<header class="kq-panel-head">
					<h2>Quests</h2>
					<button class="kq-x" id="kq-quests-x" type="button" aria-label="Close">✕</button>
				</header>
				<div class="kq-panel-body" id="kq-quests-body"></div>
			</aside>

			<div id="kq-npc" class="kq-modal" hidden>
				<div class="kq-modal-card kq-npc-card" role="dialog" aria-modal="true" aria-label="Conversation">
					<button class="kq-x" id="kq-npc-x" type="button" aria-label="Close">✕</button>
					<div class="kq-npc-head"><span class="kq-npc-portrait">🧙</span><div><div class="kq-npc-name" id="kq-npc-name">Aldric the Guide</div><div class="kq-npc-role">Mainland Guide</div></div></div>
					<p class="kq-npc-line" id="kq-npc-line"></p>
					<div class="kq-npc-body" id="kq-npc-body"></div>
					<button class="kq-btn kq-btn-ghost" id="kq-npc-quests" type="button">Open quest log</button>
				</div>
			</div>

			<div id="kq-bank" class="kq-modal" hidden>
				<div class="kq-modal-card kq-bank-card" role="dialog" aria-modal="true" aria-label="Bank">
					<button class="kq-x" id="kq-bank-x" type="button" aria-label="Close">✕</button>
					<header class="kq-bank-head"><span class="kq-tool-ic">🏦</span><h2>Bank</h2><span class="kq-bank-hint">Click an item to move it</span></header>
					<div class="kq-bank-cols">
						<section class="kq-bank-col"><h3>Backpack</h3><div class="kq-grid" id="kq-bank-inv"></div></section>
						<section class="kq-bank-col"><h3>Stored</h3><div class="kq-grid" id="kq-bank-store"></div></section>
					</div>
				</div>
			</div>

			<div id="kq-shop" class="kq-modal" hidden>
				<div class="kq-modal-card kq-shop-card" role="dialog" aria-modal="true" aria-label="Cosmetics shop">
					<button class="kq-x" id="kq-shop-x" type="button" aria-label="Close">✕</button>
					<header class="kq-shop-head">
						<span class="kq-tool-ic">✨</span>
						<h2>Cosmetics</h2>
						<span class="kq-shop-purse" title="Your gold">🪙 <b id="kq-shop-gold">0</b></span>
					</header>
					<div class="kq-shop-tabs" role="tablist">
						<button class="kq-shop-tab kq-shop-tab--on" id="kq-shop-tab-shop" type="button" role="tab" aria-selected="true">Shop</button>
						<button class="kq-shop-tab" id="kq-shop-tab-wardrobe" type="button" role="tab" aria-selected="false">Wardrobe</button>
					</div>
					<p class="kq-shop-note">Cosmetics are purely cosmetic — they change how you look, never how you play.</p>
					<div class="kq-shop-body" id="kq-shop-body"></div>
				</div>
			</div>

			<div id="kq-market" class="kq-modal" hidden>
				<div class="kq-modal-card kq-market-card" role="dialog" aria-modal="true" aria-label="Marketplace">
					<button class="kq-x" id="kq-market-x" type="button" aria-label="Close">✕</button>
					<header class="kq-market-head">
						<span class="kq-tool-ic">🛒</span>
						<h2>Marketplace</h2>
						<span class="kq-shop-purse" title="Your gold">🪙 <b id="kq-market-gold">0</b></span>
					</header>
					<div class="kq-market-tabs" role="tablist">
						<button class="kq-market-tab kq-market-tab--on" id="kq-market-tab-buy" type="button" role="tab" aria-selected="true">Buy</button>
						<button class="kq-market-tab" id="kq-market-tab-sell" type="button" role="tab" aria-selected="false">Sell</button>
						<button class="kq-market-tab" id="kq-market-tab-mine" type="button" role="tab" aria-selected="false">My Listings</button>
					</div>
					<div class="kq-market-body" id="kq-market-body"></div>
				</div>
			</div>
		`;
		document.body.appendChild(root);
		this.root = root;
		this.elToolbar = root.querySelector('#kq-toolbar');
		this.elQuestBtn = root.querySelector('#kq-quest-btn');
		this.elQuestDot = root.querySelector('#kq-quest-dot');
		this.elBankBtn = root.querySelector('#kq-bank-btn');
		this.elHotbar = root.querySelector('#kq-hotbar');
		this.elQuests = root.querySelector('#kq-quests');
		this.elQuestsBody = root.querySelector('#kq-quests-body');
		this.elNpc = root.querySelector('#kq-npc');
		this.elNpcName = root.querySelector('#kq-npc-name');
		this.elNpcLine = root.querySelector('#kq-npc-line');
		this.elNpcBody = root.querySelector('#kq-npc-body');
		this.elBank = root.querySelector('#kq-bank');
		this.elBankInv = root.querySelector('#kq-bank-inv');
		this.elBankStore = root.querySelector('#kq-bank-store');
		this.elBuildBtn = root.querySelector('#kq-build-btn');
		this.elBuildMenu = root.querySelector('#kq-build-menu');
		this.elBuildList = root.querySelector('#kq-build-list');
		this.elBuildBanner = root.querySelector('#kq-build-banner');
		this.elBuildBannerIc = root.querySelector('#kq-build-banner-ic');
		this.elBuildBannerName = root.querySelector('#kq-build-banner-name');
		this.elShopBtn = root.querySelector('#kq-shop-btn');
		this.elGoldN = root.querySelector('#kq-gold-n');
		this.elShop = root.querySelector('#kq-shop');
		this.elShopBody = root.querySelector('#kq-shop-body');
		this.elShopGold = root.querySelector('#kq-shop-gold');
		this.elShopTabShop = root.querySelector('#kq-shop-tab-shop');
		this.elShopTabWardrobe = root.querySelector('#kq-shop-tab-wardrobe');

		this.elQuestBtn.addEventListener('click', () => this.toggleQuests());
		root.querySelector('#kq-quests-x').addEventListener('click', () => this.closeQuests());
		this.elBankBtn.addEventListener('click', () => { this.opts.onBankOpen?.(); this.openBank(); });
		root.querySelector('#kq-bank-x').addEventListener('click', () => this.closeBank());
		root.querySelector('#kq-npc-x').addEventListener('click', () => this.closeNpc());
		root.querySelector('#kq-npc-quests').addEventListener('click', () => { this.closeNpc(); this.openQuests(); });
		// Click the backdrop (outside the card) to dismiss modals.
		this.elNpc.addEventListener('click', (e) => { if (e.target === this.elNpc) this.closeNpc(); });
		this.elBank.addEventListener('click', (e) => { if (e.target === this.elBank) this.closeBank(); });
		this.elBuildBtn.addEventListener('click', () => this.toggleBuild());
		root.querySelector('#kq-build-x').addEventListener('click', () => this.closeBuild());
		root.querySelector('#kq-build-cancel').addEventListener('click', () => this.opts.onBuildCancel?.());
		this.elShopBtn.addEventListener('click', () => this.toggleShop());
		root.querySelector('#kq-shop-x').addEventListener('click', () => this.closeShop());
		this.elShop.addEventListener('click', (e) => { if (e.target === this.elShop) this.closeShop(); });
		this.elShopTabShop.addEventListener('click', () => this._setShopTab('shop'));
		this.elShopTabWardrobe.addEventListener('click', () => this._setShopTab('wardrobe'));

		// Marketplace (Task 20).
		this.elMarketBtn = root.querySelector('#kq-market-btn');
		this.elMarket = root.querySelector('#kq-market');
		this.elMarketBody = root.querySelector('#kq-market-body');
		this.elMarketGold = root.querySelector('#kq-market-gold');
		this.elMarketTabBuy = root.querySelector('#kq-market-tab-buy');
		this.elMarketTabSell = root.querySelector('#kq-market-tab-sell');
		this.elMarketTabMine = root.querySelector('#kq-market-tab-mine');
		this.elMarketBtn.addEventListener('click', () => this.toggleMarket());
		root.querySelector('#kq-market-x').addEventListener('click', () => this.closeMarket());
		this.elMarket.addEventListener('click', (e) => { if (e.target === this.elMarket) this.closeMarket(); });
		this.elMarketTabBuy.addEventListener('click', () => this._setMarketTab('buy'));
		this.elMarketTabSell.addEventListener('click', () => this._setMarketTab('sell'));
		this.elMarketTabMine.addEventListener('click', () => this._setMarketTab('mine'));
	}

	// Reveal the toolbar + hotbar once the player is in the world.
	enterWorld() {
		this.elToolbar.hidden = false;
		this.elHotbar.hidden = false;
	}

	// ---------------------------------------------------------------- hotbar
	setHotbar(slots, activeSlot) {
		this.hotbarSlots = slots || [];
		this.activeSlot = activeSlot;
		this._renderHotbar();
	}

	_renderHotbar() {
		const frag = document.createDocumentFragment();
		for (let i = 0; i < this.hotbarSlots.length; i++) {
			const s = this.hotbarSlots[i] || { item: '', qty: 0 };
			const active = i === this.activeSlot;
			const hint = i === this._tutHintSlot && !active; // pulse only when not already selected
			const slot = el('button', 'kq-slot' + (active ? ' kq-slot--active' : '') + (hint ? ' kq-slot--hint' : '') + (s.item ? '' : ' kq-slot--empty'));
			slot.type = 'button';
			slot.setAttribute('aria-label', s.item ? `${itemMeta(s.item).label} (slot ${i + 1})` : `Empty slot ${i + 1}`);
			slot.setAttribute('aria-pressed', String(active));
			slot.innerHTML =
				`<span class="kq-key">${i + 1}</span>` +
				(s.item ? `<span class="kq-ic">${itemMeta(s.item).icon}</span>` : '') +
				(s.item && s.qty > 1 ? `<span class="kq-qty">${s.qty}</span>` : '');
			slot.addEventListener('click', () => this.opts.onEquip?.(i));
			frag.appendChild(slot);
		}
		this.elHotbar.replaceChildren(frag);
	}

	// ---------------------------------------------------------------- quests
	setQuests(snapshot) {
		this.snapshot = snapshot || null;
		this._resetAt = snapshot?.daily?.resetAt || 0;
		// Extract the hotbar slot the current tutorial step is teaching so the
		// hotbar can pulse it as a visual hint. -1 when there is none.
		const newHint = snapshot?.tutorial?.done === false && snapshot.tutorial.step
			? (snapshot.tutorial.step.slot ?? -1)
			: -1;
		if (newHint !== this._tutHintSlot) {
			this._tutHintSlot = newHint;
			this._renderHotbar(); // re-render so the hint class applies/removes
		}
		this._renderQuestDot();
		if (this._questOpen) this._renderQuests();
		if (this._npcOpen) this._renderNpc();
	}

	// A pulsing dot on the Quests button when there's something to do: tutorial in
	// progress, or a daily finished and waiting to be claimed.
	_renderQuestDot() {
		this.elQuestDot.hidden = !this._hasActionableQuest();
	}

	_hasActionableQuest() {
		const s = this.snapshot;
		if (!s) return false;
		if (s.tutorial && !s.tutorial.done) return true;
		return (s.daily?.quests || []).some((q) => q.progress >= q.count && !q.claimed);
	}

	// True when a daily is finished and unclaimed — drives Aldric's "?" marker.
	hasTurnInReady() {
		return (this.snapshot?.daily?.quests || []).some((q) => q.progress >= q.count && !q.claimed);
	}

	tutorialActive() {
		return !!(this.snapshot?.tutorial && !this.snapshot.tutorial.done);
	}

	toggleQuests() { this._questOpen ? this.closeQuests() : this.openQuests(); }
	openQuests() { this._questOpen = true; this.elQuests.hidden = false; this.elQuests.classList.add('kq-in'); this._renderQuests(); }
	closeQuests() { this._questOpen = false; this.elQuests.classList.remove('kq-in'); this.elQuests.hidden = true; }

	_renderQuests() {
		const s = this.snapshot;
		const body = this.elQuestsBody;
		if (!s) { body.replaceChildren(el('p', 'kq-empty', 'Loading your quests…')); return; }
		const frag = document.createDocumentFragment();

		// Tutorial section.
		const tut = s.tutorial || {};
		const tutWrap = el('section', 'kq-section');
		if (tut.done) {
			tutWrap.appendChild(el('h3', 'kq-h3', 'Tutorial'));
			tutWrap.appendChild(el('div', 'kq-tut-done', '🎓 Training complete — you know the ropes.'));
		} else if (tut.step) {
			const stepHead = el('div', 'kq-tut-head');
			stepHead.appendChild(el('h3', 'kq-h3', 'Tutorial'));
			// Overall tutorial progress pill (steps done out of total).
			const overallBar = el('div', 'kq-tut-overall');
			const pctDone = tut.total > 0 ? (tut.stepIndex / tut.total) * 100 : 0;
			overallBar.innerHTML = `<span class="kq-tut-pips">${Array.from({ length: tut.total }, (_, i) => `<span class="kq-tut-pip${i < tut.stepIndex ? ' kq-tut-pip--done' : i === tut.stepIndex ? ' kq-tut-pip--active' : ''}"></span>`).join('')}</span><span class="kq-tut-frac">${tut.stepIndex + 1} / ${tut.total}</span>`;
			stepHead.appendChild(overallBar);
			tutWrap.appendChild(stepHead);

			const card = el('div', 'kq-card-q kq-card-tut');
			// Slot hint chip — "Equip slot 3" — when the step targets a hotbar slot.
			if (typeof tut.step.slot === 'number' && tut.step.slot >= 0) {
				const chip = el('div', 'kq-tut-slot-chip', `Equip slot <b>${tut.step.slot + 1}</b>`);
				chip.title = `Press ${tut.step.slot + 1} to equip`;
				card.appendChild(chip);
			}
			card.appendChild(el('div', 'kq-q-title', tut.step.title));
			card.appendChild(el('div', 'kq-q-desc', tut.step.desc));
			// Always show a progress bar — for count=1 it acts as a completion indicator.
			card.appendChild(this._bar(tut.progress, tut.step.count));
			tutWrap.appendChild(card);
		}
		frag.appendChild(tutWrap);

		// Daily section.
		const daily = s.daily || { quests: [] };
		const dWrap = el('section', 'kq-section');
		const head = el('div', 'kq-daily-head');
		head.appendChild(el('h3', 'kq-h3', 'Daily quests'));
		const reset = el('span', 'kq-reset');
		reset.id = 'kq-reset-q';
		reset.textContent = this._resetText();
		head.appendChild(reset);
		dWrap.appendChild(head);

		const allClaimed = daily.quests.length > 0 && daily.quests.every((q) => q.claimed);
		if (allClaimed) {
			const done = el('div', 'kq-empty kq-empty-good');
			done.innerHTML = `🌟 All dailies complete — back tomorrow.<br><span class="kq-reset-inline">${this._resetText()}</span>`;
			dWrap.appendChild(done);
		}
		for (const q of daily.quests) dWrap.appendChild(this._questCard(q));
		frag.appendChild(dWrap);

		// Badges.
		const badges = s.badges || [];
		const bWrap = el('section', 'kq-section');
		bWrap.appendChild(el('h3', 'kq-h3', 'Badges'));
		if (badges.length) {
			const row = el('div', 'kq-badges');
			for (const b of badges) {
				const chip = el('span', 'kq-badge', `<span class="kq-badge-ic">${b.icon}</span>${b.label}`);
				chip.title = b.desc || b.label;
				row.appendChild(chip);
			}
			bWrap.appendChild(row);
		} else {
			bWrap.appendChild(el('p', 'kq-empty', 'No badges yet — clear daily quests to earn them.'));
		}
		frag.appendChild(bWrap);

		body.replaceChildren(frag);
	}

	_questCard(q) {
		const complete = q.progress >= q.count;
		const card = el('div', 'kq-card-q' + (q.claimed ? ' kq-claimed' : complete ? ' kq-ready' : ''));
		card.appendChild(el('div', 'kq-q-title', q.title));
		card.appendChild(el('div', 'kq-q-desc', q.desc));
		card.appendChild(this._bar(q.progress, q.count));
		const footer = el('div', 'kq-q-foot');
		footer.appendChild(this._rewardChips(q.reward));
		if (q.claimed) {
			footer.appendChild(el('span', 'kq-claimed-tag', '✓ Claimed'));
		} else {
			const btn = el('button', 'kq-btn kq-turnin' + (complete ? '' : ' kq-btn-disabled'), complete ? 'Turn in' : `${q.progress}/${q.count}`);
			btn.type = 'button';
			btn.disabled = !complete;
			btn.addEventListener('click', () => this.opts.onTurnIn?.(q.id));
			footer.appendChild(btn);
		}
		card.appendChild(footer);
		return card;
	}

	_bar(progress, count) {
		const pct = count > 0 ? Math.max(0, Math.min(1, progress / count)) : 0;
		const wrap = el('div', 'kq-progress');
		wrap.innerHTML = `<i style="width:${(pct * 100).toFixed(1)}%"></i><span class="kq-progress-txt">${Math.min(progress, count)} / ${count}</span>`;
		return wrap;
	}

	_rewardChips(reward) {
		const row = el('div', 'kq-rewards');
		if (!reward) return row;
		if (reward.gold) row.appendChild(el('span', 'kq-rw', `🪙 ${reward.gold}`));
		if (reward.xp) {
			for (const [skill, amt] of Object.entries(reward.xp)) {
				row.appendChild(el('span', 'kq-rw', `✦ ${amt} ${SKILL_LABEL[skill] || skill}`));
			}
		}
		if (reward.item) row.appendChild(el('span', 'kq-rw', `${itemMeta(reward.item.id).icon} ${reward.item.qty}`));
		if (reward.badge) {
			const chip = el('span', 'kq-rw kq-rw-badge', `${reward.badge.icon} ${reward.badge.label}`);
			chip.title = `Badge: ${reward.badge.label}`;
			row.appendChild(chip);
		}
		return row;
	}

	_resetText() {
		return this._resetAt ? `Resets in ${fmtCountdown(this._resetAt - Date.now())}` : '';
	}

	// ---------------------------------------------------------------- NPC dialog
	openNpc(name) {
		this._npcOpen = true;
		if (name) this.elNpcName.textContent = name;
		this.elNpc.hidden = false;
		this._renderNpc();
	}
	closeNpc() { this._npcOpen = false; this.elNpc.hidden = true; }

	_renderNpc() {
		const s = this.snapshot;
		this.elNpcLine.textContent = s?.guide || '…';
		const frag = document.createDocumentFragment();

		// Current tutorial objective, phrased as the guide's instruction.
		if (s?.tutorial && !s.tutorial.done && s.tutorial.step) {
			const obj = el('div', 'kq-npc-objective');
			obj.innerHTML = `<span class="kq-npc-obj-label">Your task</span>${s.tutorial.step.title}<span class="kq-npc-obj-desc">${s.tutorial.step.desc}</span>`;
			frag.appendChild(obj);
		}

		// Any daily ready to be turned in, with a claim button right here.
		const ready = (s?.daily?.quests || []).filter((q) => q.progress >= q.count && !q.claimed);
		if (ready.length) {
			frag.appendChild(el('div', 'kq-npc-sub', 'Bounties ready to settle'));
			for (const q of ready) {
				const row = el('div', 'kq-npc-turnin');
				row.appendChild(el('span', 'kq-npc-turnin-name', q.title));
				const btn = el('button', 'kq-btn kq-turnin', 'Claim');
				btn.type = 'button';
				btn.addEventListener('click', () => this.opts.onTurnIn?.(q.id));
				row.appendChild(btn);
				frag.appendChild(row);
			}
		}
		this.elNpcBody.replaceChildren(frag);
	}

	// ---------------------------------------------------------------- bank
	setBankAvailable(available) {
		this.elBankBtn.hidden = !available;
		if (!available && this._bankOpen) this.closeBank();
	}
	setInventory(inv) {
		this.inv = inv || [];
		if (this._bankOpen) this._renderBank();
		// The Sell tab picks from the backpack, so a pickup/drop while it's open keeps
		// the item picker honest. Drop a stale selection that no longer exists.
		if (this._marketOpen && this._marketTab === 'sell') {
			if (this._sellItem && !this.inv.some((s) => s && s.item === this._sellItem)) this._sellItem = '';
			this._renderMarket();
		}
	}
	setBank(slots) { this.bank = slots || []; if (this._bankOpen) this._renderBank(); }

	openBank() { this._bankOpen = true; this.elBank.hidden = false; this._renderBank(); }
	closeBank() { this._bankOpen = false; this.elBank.hidden = true; }

	_renderBank() {
		// Backpack (deposit on click).
		const invFrag = document.createDocumentFragment();
		let invItems = 0;
		this.inv.forEach((s, i) => {
			if (!s || !s.item) return;
			invItems++;
			invFrag.appendChild(this._bankCell(s, () => this.opts.onDeposit?.(i)));
		});
		if (!invItems) invFrag.appendChild(el('p', 'kq-empty', 'Your backpack is empty.'));
		this.elBankInv.replaceChildren(invFrag);

		// Stored (withdraw on click).
		const stFrag = document.createDocumentFragment();
		let stItems = 0;
		this.bank.forEach((s, i) => {
			if (!s || !s.item) return;
			stItems++;
			stFrag.appendChild(this._bankCell(s, () => this.opts.onWithdraw?.(i)));
		});
		if (!stItems) stFrag.appendChild(el('p', 'kq-empty', 'Nothing stored yet.'));
		this.elBankStore.replaceChildren(stFrag);
	}

	_bankCell(slot, onClick) {
		const m = itemMeta(slot.item);
		const cell = el('button', 'kq-cell');
		cell.type = 'button';
		cell.title = m.label;
		cell.setAttribute('aria-label', `${m.label}${slot.qty > 1 ? ' ×' + slot.qty : ''}`);
		cell.innerHTML = `<span class="kq-ic">${m.icon}</span>${slot.qty > 1 ? `<span class="kq-qty">${slot.qty}</span>` : ''}`;
		cell.addEventListener('click', onClick);
		return cell;
	}

	// ---------------------------------------------------------------- cosmetics shop
	// The persistent gold readout (toolbar + shop header). Drives buy affordability,
	// so an open shop re-renders when the purse changes.
	setGold(gold) {
		const g = Math.max(0, gold | 0);
		if (g === this.gold) return;
		this.gold = g;
		if (this.elGoldN) this.elGoldN.textContent = g.toLocaleString('en-US');
		if (this.elShopGold) this.elShopGold.textContent = g.toLocaleString('en-US');
		if (this.elMarketGold) this.elMarketGold.textContent = g.toLocaleString('en-US');
		if (this._shopOpen) this._renderShop();
		// The Sell tab's affordability + max-amount caps read off live gold.
		if (this._marketOpen && (this._marketTab === 'sell' || this._marketTab === 'buy')) this._renderMarket();
	}

	// The static catalogue (sent once on join): every cosmetic's id, name, rarity,
	// price, rotation, and visual, plus the rarity palette. Everything the shop +
	// wardrobe render from — no prices or rarities are hard-coded in the HUD.
	setCosmeticCatalog(list, rarities) {
		this.cosmetics = new Map((list || []).map((c) => [c.id, c]));
		this.rarities = rarities || {};
		if (this._shopOpen) this._renderShop();
	}

	// The live shop board (offers + rotation deadlines + owned ids + equipped + gold).
	setShop(snapshot) {
		this.shop = snapshot || null;
		if (snapshot) {
			this._dailyResetAt = snapshot.offers?.dailyResetAt || 0;
			this._weeklyResetAt = snapshot.offers?.weeklyResetAt || 0;
			if (Number.isFinite(snapshot.gold)) this.setGold(snapshot.gold);
		}
		if (this._shopOpen) this._renderShop();
	}

	toggleShop() { this._shopOpen ? this.closeShop() : this.openShop(); }
	openShop() {
		this._shopOpen = true;
		this.elShop.hidden = false;
		this.elShopBtn.setAttribute('aria-expanded', 'true');
		// Always pull a fresh board on open so offers + the countdown are current.
		this.opts.onShopOpen?.();
		this._renderShop();
	}
	closeShop() {
		this._shopOpen = false;
		this.elShop.hidden = true;
		this.elShopBtn.setAttribute('aria-expanded', 'false');
	}

	_setShopTab(tab) {
		this._shopTab = tab === 'wardrobe' ? 'wardrobe' : 'shop';
		const onShop = this._shopTab === 'shop';
		this.elShopTabShop.classList.toggle('kq-shop-tab--on', onShop);
		this.elShopTabWardrobe.classList.toggle('kq-shop-tab--on', !onShop);
		this.elShopTabShop.setAttribute('aria-selected', String(onShop));
		this.elShopTabWardrobe.setAttribute('aria-selected', String(!onShop));
		this._renderShop();
	}

	_renderShop() {
		if (!this._shopOpen) return;
		const body = this.elShopBody;
		if (!this.cosmetics.size) { body.replaceChildren(el('p', 'kq-empty', 'Loading the shop…')); return; }
		body.replaceChildren(this._shopTab === 'wardrobe' ? this._renderWardrobe() : this._renderShopCatalog());
	}

	// Buy tab: the rotating board grouped by bucket, each rotating group headed by a
	// live countdown to its next rotation. Cosmetics already owned read "Owned";
	// affordable ones get a Buy button; short ones show how much more gold is needed.
	_renderShopCatalog() {
		const frag = document.createDocumentFragment();
		if (!this.shop) { frag.appendChild(el('p', 'kq-empty', 'Loading the shop…')); return frag; }
		const owned = new Set(this.shop.owned || []);
		const offers = this.shop.offers || {};
		const section = (title, ids, resetId, resetAt) => {
			if (!ids || !ids.length) return;
			const sec = el('section', 'kq-shop-section');
			const head = el('div', 'kq-shop-section-head');
			head.appendChild(el('h3', 'kq-h3', title));
			if (resetId) {
				const r = el('span', 'kq-shop-reset', this._rotateText(resetAt));
				r.id = resetId;
				head.appendChild(r);
			}
			sec.appendChild(head);
			const grid = el('div', 'kq-cos-grid');
			for (const id of ids) {
				const c = this.cosmetics.get(id);
				if (c) grid.appendChild(this._shopCard(c, owned.has(id)));
			}
			sec.appendChild(grid);
			frag.appendChild(sec);
		};
		section('Daily rotation', offers.daily, 'kq-shop-daily-reset', this._dailyResetAt);
		section('Weekly rotation', offers.weekly, 'kq-shop-weekly-reset', this._weeklyResetAt);
		section('Always available', offers.always, null, 0);
		return frag;
	}

	_shopCard(c, owned) {
		const affordable = this.gold >= c.price;
		const card = el('div', `kq-cos-card kq-cos--${c.rarity}${owned ? ' kq-cos--owned' : affordable ? '' : ' kq-cos--short'}`);
		card.style.setProperty('--cos-accent', this._rarityColor(c.rarity));
		card.appendChild(this._cosSwatch(c));
		const meta = el('div', 'kq-cos-meta');
		meta.appendChild(el('div', 'kq-cos-name', c.name));
		meta.appendChild(el('div', 'kq-cos-rarity', this._rarityLabel(c.rarity)));
		card.appendChild(meta);
		const foot = el('div', 'kq-cos-foot');
		if (owned) {
			foot.appendChild(el('span', 'kq-cos-owned', '✓ Owned'));
		} else {
			foot.appendChild(el('span', 'kq-cos-price' + (affordable ? '' : ' kq-cos-price--short'), `🪙 ${c.price.toLocaleString('en-US')}`));
			const btn = el('button', 'kq-btn kq-cos-buy' + (affordable ? '' : ' kq-btn-disabled'), affordable ? 'Buy' : `Need ${(c.price - this.gold).toLocaleString('en-US')}`);
			btn.type = 'button';
			btn.disabled = !affordable;
			if (affordable) btn.addEventListener('click', () => this.opts.onBuyCosmetic?.(c.id));
			foot.appendChild(btn);
		}
		card.appendChild(foot);
		return card;
	}

	// Wardrobe tab: a "Default look" tile (unequip) plus every owned cosmetic, with
	// the equipped one highlighted. Equipping previews live on the avatar in-world.
	_renderWardrobe() {
		const frag = document.createDocumentFragment();
		const ownedIds = (this.shop?.owned || []).filter((id) => this.cosmetics.has(id));
		const equipped = this.shop?.equipped || '';
		frag.appendChild(el('p', 'kq-shop-sub', 'Equip an owned look — it shows on your avatar instantly, for you and everyone around you.'));
		const grid = el('div', 'kq-cos-grid');

		// Default (no cosmetic) tile.
		const def = el('div', 'kq-cos-card kq-cos--default' + (equipped ? '' : ' kq-cos--equipped'));
		def.appendChild(el('span', 'kq-cos-swatch kq-cos-swatch--default', '🙂'));
		const dmeta = el('div', 'kq-cos-meta');
		dmeta.appendChild(el('div', 'kq-cos-name', 'Default look'));
		dmeta.appendChild(el('div', 'kq-cos-rarity', 'No cosmetic'));
		def.appendChild(dmeta);
		const dfoot = el('div', 'kq-cos-foot');
		if (equipped) {
			const b = el('button', 'kq-btn kq-cos-equip', 'Equip');
			b.type = 'button';
			b.addEventListener('click', () => this.opts.onUnequipCosmetic?.());
			dfoot.appendChild(b);
		} else {
			dfoot.appendChild(el('span', 'kq-cos-equipped', '✓ Equipped'));
		}
		def.appendChild(dfoot);
		grid.appendChild(def);

		for (const id of ownedIds) {
			const c = this.cosmetics.get(id);
			const isEq = id === equipped;
			const card = el('div', `kq-cos-card kq-cos--${c.rarity}${isEq ? ' kq-cos--equipped' : ''}`);
			card.style.setProperty('--cos-accent', this._rarityColor(c.rarity));
			card.appendChild(this._cosSwatch(c));
			const meta = el('div', 'kq-cos-meta');
			meta.appendChild(el('div', 'kq-cos-name', c.name));
			meta.appendChild(el('div', 'kq-cos-rarity', this._rarityLabel(c.rarity)));
			card.appendChild(meta);
			const foot = el('div', 'kq-cos-foot');
			if (isEq) {
				foot.appendChild(el('span', 'kq-cos-equipped', '✓ Equipped'));
			} else {
				const b = el('button', 'kq-btn kq-cos-equip', 'Equip');
				b.type = 'button';
				b.addEventListener('click', () => this.opts.onEquipCosmetic?.(id));
				foot.appendChild(b);
			}
			card.appendChild(foot);
			grid.appendChild(card);
		}
		frag.appendChild(grid);

		if (!ownedIds.length) {
			const empty = el('div', 'kq-empty kq-shop-empty');
			empty.innerHTML = 'You don’t own any cosmetics yet.';
			const go = el('button', 'kq-btn kq-btn-ghost', 'Browse the shop →');
			go.type = 'button';
			go.addEventListener('click', () => this._setShopTab('shop'));
			empty.appendChild(go);
			frag.appendChild(empty);
		}
		return frag;
	}

	// A small visual chip for a cosmetic: auras glow, tints fill, props show their
	// emoji over a neutral chip — enough to tell looks apart at a glance.
	_cosSwatch(c) {
		const v = c.visual || {};
		const sw = el('span', 'kq-cos-swatch');
		if (v.aura) {
			sw.style.background = `radial-gradient(circle at 50% 55%, ${v.aura}, rgba(0,0,0,0.25) 72%)`;
			sw.style.boxShadow = `0 0 12px ${v.aura}`;
		} else if (v.tint) {
			sw.style.background = `linear-gradient(150deg, ${v.tint}, rgba(255,255,255,0.18))`;
		}
		if (v.prop) sw.textContent = PROP_ICON[c.id] || '🎩';
		return sw;
	}

	_rarityColor(rarity) { return this.rarities[rarity]?.color || '#9aa7b4'; }
	_rarityLabel(rarity) { return this.rarities[rarity]?.label || (rarity ? rarity[0].toUpperCase() + rarity.slice(1) : ''); }
	_rotateText(at) { return at ? `resets in ${fmtCountdown(at - Date.now())}` : ''; }

	// ---------------------------------------------------------------- build
	// The Build button shows only in realms that permit player building (the scene
	// derives this from the realm's structure list). Hidden elsewhere so a mine or
	// the wilderness town never offers a no-op button.
	setBuildAvailable(available) {
		if (!this.elBuildBtn) return;
		this.elBuildBtn.hidden = !available;
		if (!available) this.closeBuild();
	}

	// Render the buildable list. `items` is the scene's affordability-resolved view:
	//   [{ kind, icon, label, desc, capNote, affordable, costs:[{item,icon,need,have,ok}] }]
	// Each row shows the live cost (red where short) and a Build button gated on
	// affordability — the authoritative server re-checks everything on placement.
	setBuildables(items) {
		this._buildables = items || [];
		if (this._buildOpen) this._renderBuild();
	}

	toggleBuild() { this._buildOpen ? this.closeBuild() : this.openBuild(); }
	openBuild() {
		if (this.elBuildBtn?.hidden) return;
		this._buildOpen = true;
		this.elBuildMenu.hidden = false;
		this.elBuildMenu.classList.add('kq-in');
		this.elBuildBtn?.setAttribute('aria-expanded', 'true');
		this._renderBuild();
	}
	closeBuild() {
		this._buildOpen = false;
		if (this.elBuildMenu) { this.elBuildMenu.classList.remove('kq-in'); this.elBuildMenu.hidden = true; }
		this.elBuildBtn?.setAttribute('aria-expanded', 'false');
	}

	_renderBuild() {
		const list = this.elBuildList;
		if (!list) return;
		const items = this._buildables || [];
		if (!items.length) { list.replaceChildren(el('p', 'kq-empty', 'Nothing to build here.')); return; }
		const frag = document.createDocumentFragment();
		for (const b of items) {
			const card = el('div', 'kq-build-card' + (b.affordable ? '' : ' kq-build-card--short'));
			const head = el('div', 'kq-build-card-head');
			head.appendChild(el('span', 'kq-build-ic', b.icon));
			const title = el('div', 'kq-build-titles');
			title.appendChild(el('div', 'kq-build-name', b.label + (b.capNote ? ` <span class="kq-build-cap">${b.capNote}</span>` : '')));
			title.appendChild(el('div', 'kq-build-desc', b.desc || ''));
			head.appendChild(title);
			card.appendChild(head);

			const costs = el('div', 'kq-build-costs');
			for (const c of b.costs || []) {
				const chip = el('span', 'kq-build-cost' + (c.ok ? '' : ' kq-build-cost--short'));
				chip.innerHTML = `<span class="kq-build-cost-ic">${c.icon}</span>${c.have}/${c.need}`;
				chip.title = `${c.have} of ${c.need} ${itemMeta(c.item).label}`;
				costs.appendChild(chip);
			}
			card.appendChild(costs);

			const btn = el('button', 'kq-btn kq-build-go' + (b.affordable ? '' : ' kq-btn-disabled'), b.affordable ? 'Build' : 'Need more');
			btn.type = 'button';
			btn.disabled = !b.affordable;
			btn.addEventListener('click', () => { this.opts.onBuildSelect?.(b.kind); this.closeBuild(); });
			card.appendChild(btn);
			frag.appendChild(card);
		}
		list.replaceChildren(frag);
	}

	// Build-mode banner: shown while a ghost is being placed, with a Cancel control
	// (the only cancel affordance on touch, where there's no right-click).
	showBuildBanner(meta) {
		if (!this.elBuildBanner) return;
		this.elBuildBannerIc.textContent = meta?.icon || '🔨';
		this.elBuildBannerName.textContent = meta?.label || 'structure';
		this.elBuildBanner.hidden = false;
	}
	hideBuildBanner() { if (this.elBuildBanner) this.elBuildBanner.hidden = true; }

	// ---------------------------------------------------------------- marketplace (Task 20)
	//
	// A player-to-player market with Buy / Sell / My Listings tabs. The board is the
	// server's authoritative snapshot (setMarket); every action flows back out
	// through opts callbacks so the controller owns the network + the on-chain token
	// flow. Gold buys are one click; token buys go through a controller-driven
	// quote → wallet-sign → settle sequence whose progress shows as a per-listing
	// busy label (setMarketBusy).

	toggleMarket() { this._marketOpen ? this.closeMarket() : this.openMarket(); }

	openMarket() {
		if (this._marketOpen) return;
		this._marketOpen = true;
		this._marketError = '';
		this._marketLoading = !this.market.listings.length && !this.market.mine.length;
		this.elMarket.hidden = false;
		this.elMarketBtn.setAttribute('aria-expanded', 'true');
		this._renderMarket();
		// Always refetch on open so the board is live, not whatever was last cached.
		this.opts.onMarketOpen?.();
	}

	closeMarket() {
		this._marketOpen = false;
		this.elMarket.hidden = true;
		this.elMarketBtn.setAttribute('aria-expanded', 'false');
	}

	_setMarketTab(tab) {
		this._marketTab = tab;
		for (const [name, btn] of [['buy', this.elMarketTabBuy], ['sell', this.elMarketTabSell], ['mine', this.elMarketTabMine]]) {
			const on = name === tab;
			btn.classList.toggle('kq-market-tab--on', on);
			btn.setAttribute('aria-selected', String(on));
		}
		// Re-pull a fresh board when switching to a browse tab so it never shows stale
		// listings after time on the Sell form.
		if (tab === 'buy' || tab === 'mine') this.opts.onMarketOpen?.();
		this._renderMarket();
	}

	// The server's market board: active listings, the player's own, and the token
	// capability flags. Clears the loading/error state and re-renders if open.
	setMarket(data) {
		if (!data) return;
		this.market = {
			listings: Array.isArray(data.listings) ? data.listings : [],
			mine: Array.isArray(data.mine) ? data.mine : [],
			token: data.token || this.market.token,
			canToken: !!data.canToken,
		};
		this._marketLoading = false;
		this._marketError = '';
		if (this._marketOpen) this._renderMarket();
	}

	// A listing changed somewhere — refetch if the market is open on a browse tab.
	marketDirty() {
		if (this._marketOpen && (this._marketTab === 'buy' || this._marketTab === 'mine')) this.opts.onMarketOpen?.();
	}

	setMarketError(msg) {
		this._marketError = msg || '';
		this._marketLoading = false;
		if (this._marketOpen) this._renderMarket();
	}

	// The controller drives these during an on-chain token buy so the listing's card
	// shows "Preparing…", "Confirm in wallet…", "Settling…", etc.
	setMarketBusy(id, label) {
		if (!id) return;
		this._marketBusy.set(id, label || 'Working…');
		if (this._marketOpen) this._renderMarket();
	}
	clearMarketBusy(id) {
		if (id) this._marketBusy.delete(id); else this._marketBusy.clear();
		if (this._marketOpen) this._renderMarket();
	}

	_fmtGold(n) { return Math.max(0, n | 0).toLocaleString('en-US'); }
	_fmtUsd(n) { return '$' + (Math.round(Number(n) * 100) / 100).toFixed(2); }

	_renderMarket() {
		if (!this.elMarketBody) return;
		let node;
		if (this._marketTab === 'sell') node = this._renderSell();
		else if (this._marketTab === 'mine') node = this._renderMine();
		else node = this._renderBuy();
		this.elMarketBody.replaceChildren(node);
	}

	// ---- Buy tab ----------------------------------------------------------
	_renderBuy() {
		const wrap = el('div', 'kq-market-pane');
		if (this._marketError) { wrap.appendChild(this._marketErrorEl()); return wrap; }
		if (this._marketLoading) { wrap.appendChild(this._marketSkeleton()); return wrap; }

		// Filter + sort controls.
		const controls = el('div', 'kq-market-controls');
		const search = el('input', 'kq-market-search');
		search.type = 'search';
		search.placeholder = 'Filter by item or seller…';
		search.value = this._buyFilter;
		search.setAttribute('aria-label', 'Filter listings');
		search.addEventListener('input', () => { this._buyFilter = search.value.toLowerCase(); this._renderBuyList(list); });
		const sort = el('select', 'kq-market-sort');
		sort.setAttribute('aria-label', 'Sort listings');
		for (const [val, label] of [['recent', 'Newest'], ['priceAsc', 'Price ↑'], ['priceDesc', 'Price ↓']]) {
			const o = el('option'); o.value = val; o.textContent = label; if (val === this._buySort) o.selected = true; sort.appendChild(o);
		}
		sort.addEventListener('change', () => { this._buySort = sort.value; this._renderBuyList(list); });
		controls.append(search, sort);
		wrap.appendChild(controls);

		const list = el('div', 'kq-market-list');
		this._renderBuyList(list);
		wrap.appendChild(list);
		return wrap;
	}

	_renderBuyList(list) {
		const q = this._buyFilter;
		let items = this.market.listings.slice();
		if (q) {
			items = items.filter((l) => {
				const label = l.type === 'gold' ? itemMeta(l.item).label : 'gold';
				return label.toLowerCase().includes(q) || (l.seller || '').toLowerCase().includes(q);
			});
		}
		const priceOf = (l) => (l.type === 'gold' ? l.priceGold : l.priceUsd * 1e9); // token prices sort above gold consistently
		if (this._buySort === 'priceAsc') items.sort((a, b) => priceOf(a) - priceOf(b));
		else if (this._buySort === 'priceDesc') items.sort((a, b) => priceOf(b) - priceOf(a));
		else items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

		if (!items.length) {
			const empty = el('div', 'kq-market-empty');
			empty.innerHTML = this._buyFilter
				? '<div class="kq-market-empty-ic">🔍</div><p>No listings match that filter.</p>'
				: '<div class="kq-market-empty-ic">🛒</div><p><b>No listings yet — be the first to sell.</b></p><span>Open the Sell tab to list items for gold, or gold for $THREE.</span>';
			list.replaceChildren(empty);
			return;
		}
		const frag = document.createDocumentFragment();
		for (const l of items) frag.appendChild(this._buyCard(l));
		list.replaceChildren(frag);
	}

	_buyCard(l) {
		const card = el('div', 'kq-market-card-row' + (l.mine ? ' kq-market-mine' : ''));
		const icon = el('span', 'kq-market-ic', l.type === 'gold' ? itemMeta(l.item).icon : '🪙');
		const info = el('div', 'kq-market-info');
		const title = el('div', 'kq-market-title');
		if (l.type === 'gold') title.textContent = `${l.qty}× ${itemMeta(l.item).label}`;
		else title.textContent = `${this._fmtGold(l.goldAmount)} gold`;
		const sub = el('div', 'kq-market-sub');
		const seller = el('span', 'kq-market-seller'); seller.textContent = `by ${l.seller || 'Trader'}`;
		sub.appendChild(seller);
		info.append(title, sub);

		const right = el('div', 'kq-market-right');
		const price = el('div', 'kq-market-price');
		if (l.type === 'gold') price.innerHTML = `<span class="kq-market-coin">🪙</span>${this._fmtGold(l.priceGold)}`;
		else price.innerHTML = `<span class="kq-market-usd">${this._fmtUsd(l.priceUsd)}</span><span class="kq-market-token">in ${this.market.token.symbol}</span>`;
		right.appendChild(price);

		const busy = this._marketBusy.get(l.id);
		if (l.mine) {
			right.appendChild(el('span', 'kq-market-badge', 'Your listing'));
		} else if (busy) {
			const b = el('span', 'kq-market-busy'); b.innerHTML = `<span class="kq-spin"></span>${busy}`;
			right.appendChild(b);
		} else if (l.type === 'gold') {
			const buy = el('button', 'kq-btn kq-btn-primary kq-market-buy', 'Buy');
			buy.type = 'button';
			const afford = this.gold >= l.priceGold;
			if (!afford) { buy.disabled = true; buy.classList.add('kq-btn-disabled'); buy.title = 'Not enough gold'; }
			buy.addEventListener('click', () => this.opts.onMarketBuyGold?.(l.id));
			right.appendChild(buy);
		} else {
			// Token listing.
			if (!this.market.canToken) {
				const note = el('span', 'kq-market-note', 'Connect a wallet to buy');
				right.appendChild(note);
			} else {
				const buy = el('button', 'kq-btn kq-btn-primary kq-market-buy', `Buy with ${this.market.token.symbol}`);
				buy.type = 'button';
				buy.addEventListener('click', () => this.opts.onMarketBuyToken?.(l.id));
				right.appendChild(buy);
			}
		}
		card.append(icon, info, right);
		return card;
	}

	// ---- Sell tab ---------------------------------------------------------
	_renderSell() {
		const wrap = el('div', 'kq-market-pane kq-market-sell');
		// Mode toggle: items-for-gold vs gold-for-token.
		const modes = el('div', 'kq-market-modes');
		for (const [val, label] of [['gold', 'Item → Gold'], ['token', `Gold → ${this.market.token.symbol}`]]) {
			const b = el('button', 'kq-market-mode' + (this._sellMode === val ? ' kq-market-mode--on' : ''), label);
			b.type = 'button';
			b.addEventListener('click', () => { this._sellMode = val; this._renderMarket(); });
			modes.appendChild(b);
		}
		wrap.appendChild(modes);
		wrap.appendChild(this._sellMode === 'token' ? this._renderSellToken() : this._renderSellGold());
		return wrap;
	}

	_renderSellGold() {
		const pane = el('div', 'kq-market-sellform');
		// Aggregate backpack stacks by item so the picker shows one tile per item.
		const totals = new Map();
		for (const s of this.inv) if (s && s.item && s.qty > 0) totals.set(s.item, (totals.get(s.item) || 0) + s.qty);
		if (!totals.size) {
			pane.appendChild(el('p', 'kq-market-hint', 'Your backpack is empty — gather or loot something to sell.'));
			return pane;
		}
		pane.appendChild(el('label', 'kq-market-label', 'Choose an item to sell'));
		const grid = el('div', 'kq-market-pick');
		for (const [item, qty] of totals) {
			const m = itemMeta(item);
			const cell = el('button', 'kq-cell kq-market-pickcell' + (this._sellItem === item ? ' kq-cell--on' : ''));
			cell.type = 'button';
			cell.title = `${m.label} ×${qty}`;
			cell.setAttribute('aria-label', `${m.label} ×${qty}`);
			cell.setAttribute('aria-pressed', String(this._sellItem === item));
			cell.innerHTML = `<span class="kq-ic">${m.icon}</span><span class="kq-qty">${qty}</span>`;
			cell.addEventListener('click', () => { this._sellItem = item; this._renderMarket(); });
			grid.appendChild(cell);
		}
		pane.appendChild(grid);

		if (!this._sellItem) {
			pane.appendChild(el('p', 'kq-market-hint', 'Pick an item above to set the amount and price.'));
			return pane;
		}
		const held = totals.get(this._sellItem) || 0;
		const m = itemMeta(this._sellItem);

		const row = el('div', 'kq-market-fields');
		const qtyWrap = el('label', 'kq-market-field');
		qtyWrap.appendChild(el('span', 'kq-market-field-lbl', `Quantity (max ${held})`));
		const qtyInput = el('input', 'kq-market-input');
		qtyInput.type = 'number'; qtyInput.min = '1'; qtyInput.max = String(held); qtyInput.value = String(held); qtyInput.step = '1';
		qtyWrap.appendChild(qtyInput);

		const priceWrap = el('label', 'kq-market-field');
		priceWrap.appendChild(el('span', 'kq-market-field-lbl', 'Price (gold)'));
		const priceInput = el('input', 'kq-market-input');
		priceInput.type = 'number'; priceInput.min = '1'; priceInput.step = '1'; priceInput.placeholder = 'e.g. 100';
		priceWrap.appendChild(priceInput);
		row.append(qtyWrap, priceWrap);
		pane.appendChild(row);

		const btn = el('button', 'kq-btn kq-btn-primary kq-market-listbtn', `List ${m.label} for gold`);
		btn.type = 'button';
		btn.addEventListener('click', () => {
			const qty = Math.max(1, Math.min(held, qtyInput.value | 0));
			const price = priceInput.value | 0;
			if (!(price >= 1)) { priceInput.focus(); priceInput.classList.add('kq-input-bad'); return; }
			this.opts.onMarketListGold?.(this._sellItem, qty, price);
			this._sellItem = '';
		});
		pane.appendChild(btn);
		pane.appendChild(el('p', 'kq-market-fineprint', 'Gold sales have no fee — you receive the full price.'));
		return pane;
	}

	_renderSellToken() {
		const pane = el('div', 'kq-market-sellform');
		if (!this.market.token.enabled) {
			pane.appendChild(el('p', 'kq-market-hint', `${this.market.token.symbol} sales are unavailable right now.`));
			return pane;
		}
		if (!this.market.canToken) {
			pane.appendChild(el('p', 'kq-market-hint', 'Connect a Solana wallet to sell gold for tokens — your proceeds are paid on-chain to your wallet.'));
			return pane;
		}
		if (this.gold <= 0) {
			pane.appendChild(el('p', 'kq-market-hint', 'You have no gold to sell yet.'));
			return pane;
		}
		const feePct = (this.market.token.treasuryBps / 100).toFixed(0);
		const row = el('div', 'kq-market-fields');
		const goldWrap = el('label', 'kq-market-field');
		goldWrap.appendChild(el('span', 'kq-market-field-lbl', `Gold to sell (max ${this._fmtGold(this.gold)})`));
		const goldInput = el('input', 'kq-market-input');
		goldInput.type = 'number'; goldInput.min = '1'; goldInput.max = String(this.gold); goldInput.step = '1'; goldInput.placeholder = 'e.g. 1000';
		goldWrap.appendChild(goldInput);

		const usdWrap = el('label', 'kq-market-field');
		usdWrap.appendChild(el('span', 'kq-market-field-lbl', 'Price (USD)'));
		const usdInput = el('input', 'kq-market-input');
		usdInput.type = 'number'; usdInput.min = '0.01'; usdInput.step = '0.01'; usdInput.placeholder = 'e.g. 1.50';
		usdWrap.appendChild(usdInput);
		row.append(goldWrap, usdWrap);
		pane.appendChild(row);

		const btn = el('button', 'kq-btn kq-btn-primary kq-market-listbtn', `List gold for ${this.market.token.symbol}`);
		btn.type = 'button';
		btn.addEventListener('click', () => {
			const goldAmount = Math.max(1, Math.min(this.gold, goldInput.value | 0));
			const usd = Math.round(Number(usdInput.value) * 100) / 100;
			if (!(goldAmount >= 1)) { goldInput.focus(); goldInput.classList.add('kq-input-bad'); return; }
			if (!(usd >= 0.01)) { usdInput.focus(); usdInput.classList.add('kq-input-bad'); return; }
			this.opts.onMarketListToken?.(goldAmount, usd);
		});
		pane.appendChild(btn);
		pane.appendChild(el('p', 'kq-market-fineprint', `Buyers pay in ${this.market.token.symbol}. You receive ${100 - Number(feePct)}% to your wallet; ${feePct}% goes to the treasury.`));
		return pane;
	}

	// ---- My Listings tab --------------------------------------------------
	_renderMine() {
		const wrap = el('div', 'kq-market-pane');
		if (this._marketError) { wrap.appendChild(this._marketErrorEl()); return wrap; }
		const mine = (this.market.mine || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
		if (!mine.length) {
			const empty = el('div', 'kq-market-empty');
			empty.innerHTML = '<div class="kq-market-empty-ic">📦</div><p><b>You have no listings.</b></p><span>List items for gold or gold for $THREE from the Sell tab.</span>';
			wrap.appendChild(empty);
			return wrap;
		}
		const list = el('div', 'kq-market-list');
		for (const l of mine) list.appendChild(this._mineCard(l));
		wrap.appendChild(list);
		return wrap;
	}

	_mineCard(l) {
		const card = el('div', 'kq-market-card-row kq-market-status-' + l.status);
		const icon = el('span', 'kq-market-ic', l.type === 'gold' ? itemMeta(l.item).icon : '🪙');
		const info = el('div', 'kq-market-info');
		const title = el('div', 'kq-market-title');
		title.textContent = l.type === 'gold' ? `${l.qty}× ${itemMeta(l.item).label}` : `${this._fmtGold(l.goldAmount)} gold`;
		const sub = el('div', 'kq-market-sub');
		const price = l.type === 'gold' ? `🪙 ${this._fmtGold(l.priceGold)}` : `${this._fmtUsd(l.priceUsd)} in ${this.market.token.symbol}`;
		sub.textContent = price;
		info.append(title, sub);

		const right = el('div', 'kq-market-right');
		if (l.status === 'active') {
			right.appendChild(el('span', 'kq-market-statlbl kq-market-statlbl--active', 'Active'));
			const cancel = el('button', 'kq-btn kq-btn-ghost kq-market-cancel', 'Cancel');
			cancel.type = 'button';
			cancel.addEventListener('click', () => this.opts.onMarketCancel?.(l.id));
			right.appendChild(cancel);
		} else if (l.status === 'sold') {
			right.appendChild(el('span', 'kq-market-statlbl kq-market-statlbl--sold', l.buyer ? `Sold to ${l.buyer}` : 'Sold'));
		} else if (l.status === 'settling') {
			right.appendChild(el('span', 'kq-market-statlbl', 'Payment pending…'));
		} else {
			right.appendChild(el('span', 'kq-market-statlbl kq-market-statlbl--cancelled', 'Cancelled'));
		}
		card.append(icon, info, right);
		return card;
	}

	_marketErrorEl() {
		const e = el('div', 'kq-market-empty kq-market-err');
		e.innerHTML = `<div class="kq-market-empty-ic">⚠️</div><p>${this._marketError}</p>`;
		const retry = el('button', 'kq-btn kq-btn-ghost', 'Retry');
		retry.type = 'button';
		retry.addEventListener('click', () => { this._marketError = ''; this._marketLoading = true; this._renderMarket(); this.opts.onMarketOpen?.(); });
		e.appendChild(retry);
		return e;
	}

	_marketSkeleton() {
		const sk = el('div', 'kq-market-list');
		for (let i = 0; i < 4; i++) sk.appendChild(el('div', 'kq-market-card-row kq-market-skel'));
		return sk;
	}

	// ---------------------------------------------------------------- ticker
	_tick() {
		// Daily-quest reset countdown + auto re-fetch when the day turns over.
		if (this._resetAt) {
			if (this._resetAt - Date.now() <= 0) { this.opts.onReset?.(); }
			else if (this._questOpen) {
				const q = this.elQuestsBody.querySelector('#kq-reset-q');
				if (q) q.textContent = this._resetText();
				const inline = this.elQuestsBody.querySelector('.kq-reset-inline');
				if (inline) inline.textContent = this._resetText();
			}
		}
		// Cosmetics shop rotation countdowns. When a rotation elapses, re-fetch the
		// board so the new offers + a fresh countdown appear without a reconnect.
		if (this._shopOpen && this._shopTab === 'shop') {
			const now = Date.now();
			let rotated = false;
			if (this._dailyResetAt && now >= this._dailyResetAt) { this._dailyResetAt = 0; rotated = true; }
			if (this._weeklyResetAt && now >= this._weeklyResetAt) { this._weeklyResetAt = 0; rotated = true; }
			if (rotated) { this.opts.onShopOpen?.(); return; }
			const d = this.elShopBody.querySelector('#kq-shop-daily-reset');
			if (d) d.textContent = this._rotateText(this._dailyResetAt);
			const w = this.elShopBody.querySelector('#kq-shop-weekly-reset');
			if (w) w.textContent = this._rotateText(this._weeklyResetAt);
		}
		// Keep an open Buy/My-Listings board live as others list and sell — a light
		// refetch every few seconds (the Sell form is left alone so typing isn't lost).
		if (this._marketOpen && (this._marketTab === 'buy' || this._marketTab === 'mine')) {
			this._marketPoll = (this._marketPoll || 0) + 1;
			if (this._marketPoll >= 5) { this._marketPoll = 0; this.opts.onMarketOpen?.(); }
		}
	}

	destroy() {
		clearInterval(this._timer);
		this.root?.remove();
	}
}
