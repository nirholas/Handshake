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
		this._questOpen = false;
		this._bankOpen = false;
		this._npcOpen = false;
		this._resetAt = 0;
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
			</div>

			<div id="kq-hotbar" class="kq-hotbar" hidden role="toolbar" aria-label="Hotbar"></div>

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

		this.elQuestBtn.addEventListener('click', () => this.toggleQuests());
		root.querySelector('#kq-quests-x').addEventListener('click', () => this.closeQuests());
		this.elBankBtn.addEventListener('click', () => { this.opts.onBankOpen?.(); this.openBank(); });
		root.querySelector('#kq-bank-x').addEventListener('click', () => this.closeBank());
		root.querySelector('#kq-npc-x').addEventListener('click', () => this.closeNpc());
		root.querySelector('#kq-npc-quests').addEventListener('click', () => { this.closeNpc(); this.openQuests(); });
		// Click the backdrop (outside the card) to dismiss modals.
		this.elNpc.addEventListener('click', (e) => { if (e.target === this.elNpc) this.closeNpc(); });
		this.elBank.addEventListener('click', (e) => { if (e.target === this.elBank) this.closeBank(); });
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
			const slot = el('button', 'kq-slot' + (active ? ' kq-slot--active' : '') + (s.item ? '' : ' kq-slot--empty'));
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
			tutWrap.appendChild(el('h3', 'kq-h3', `Tutorial · step ${tut.stepIndex + 1} of ${tut.total}`));
			const card = el('div', 'kq-card-q kq-card-tut');
			card.appendChild(el('div', 'kq-q-title', tut.step.title));
			card.appendChild(el('div', 'kq-q-desc', tut.step.desc));
			if (tut.step.count > 1) card.appendChild(this._bar(tut.progress, tut.step.count));
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
	setInventory(inv) { this.inv = inv || []; if (this._bankOpen) this._renderBank(); }
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

	// ---------------------------------------------------------------- ticker
	_tick() {
		if (!this._resetAt) return;
		const remaining = this._resetAt - Date.now();
		if (remaining <= 0) { this.opts.onReset?.(); return; }
		if (this._questOpen) {
			const q = this.elQuestsBody.querySelector('#kq-reset-q');
			if (q) q.textContent = this._resetText();
			const inline = this.elQuestsBody.querySelector('.kq-reset-inline');
			if (inline) inline.textContent = this._resetText();
		}
	}

	destroy() {
		clearInterval(this._timer);
		this.root?.remove();
	}
}
