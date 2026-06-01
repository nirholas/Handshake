// @vitest-environment jsdom
//
// Cosmetics shop HUD (Task 21) — the DOM half of the in-world shop the scene
// drives. Verifies the gold readout, the buy/wardrobe tabs, affordability +
// owned states, equip/unequip wiring, the rotation-section countdown, and the
// empty wardrobe state, so the player-facing chrome is exercised without a
// browser. Fed the same shapes the server sends (catalogue + shop board).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

globalThis.self = globalThis;

import { GameHud } from '../src/game/game-hud.js';
import { clientCatalog, currentOffers } from '../multiplayer/src/cosmetics.js';

const CAT = clientCatalog();
const T = Date.UTC(2026, 5, 1, 12, 0, 0);

let hud;
let calls;
afterEach(() => { hud?.destroy(); hud = null; document.body.innerHTML = ''; });

function mount() {
	calls = { buy: [], equip: [], unequip: 0, shopOpen: 0 };
	hud = new GameHud({
		onShopOpen: () => calls.shopOpen++,
		onBuyCosmetic: (id) => calls.buy.push(id),
		onEquipCosmetic: (id) => calls.equip.push(id),
		onUnequipCosmetic: () => calls.unequip++,
	});
	hud.setCosmeticCatalog(CAT.cosmetics, CAT.rarities);
	return hud;
}

// A shop board for instant T with a given purse / owned / equipped.
function board({ gold = 1000, owned = [], equipped = '' } = {}) {
	return { offers: currentOffers(T), owned, equipped, gold };
}

describe('gold readout', () => {
	it('reflects setGold in the toolbar and shop header', () => {
		mount();
		hud.setGold(1234);
		expect(document.querySelector('#kq-gold-n').textContent).toBe('1,234');
		expect(document.querySelector('#kq-shop-gold').textContent).toBe('1,234');
	});
});

describe('shop tab — buy board', () => {
	it('opens, fetches a fresh board, and renders the rotating + always sections', () => {
		mount();
		hud.openShop();
		expect(calls.shopOpen).toBe(1); // open pulls a fresh board
		hud.setShop(board({ gold: 2000 }));
		const sections = document.querySelectorAll('#kq-shop-body .kq-shop-section');
		expect(sections.length).toBe(3); // daily, weekly, always
		// A live countdown is present for the rotating sections.
		expect(document.querySelector('#kq-shop-daily-reset')).toBeTruthy();
		expect(document.querySelector('#kq-shop-weekly-reset')).toBeTruthy();
		// Every offered card is rendered.
		const offers = currentOffers(T);
		const total = offers.daily.length + offers.weekly.length + offers.always.length;
		expect(document.querySelectorAll('#kq-shop-body .kq-cos-card').length).toBe(total);
	});

	it('a buy click on an affordable card routes the cosmetic id to the server', () => {
		mount();
		hud.openShop();
		hud.setShop(board({ gold: 100000 }));
		const buy = document.querySelector('#kq-shop-body .kq-cos-buy');
		expect(buy).toBeTruthy();
		buy.click();
		expect(calls.buy.length).toBe(1);
		expect(typeof calls.buy[0]).toBe('string');
	});

	it('disables buying when the purse is short and shows the shortfall', () => {
		mount();
		hud.openShop();
		hud.setShop(board({ gold: 0 }));
		const card = document.querySelector('#kq-shop-body .kq-cos-card.kq-cos--short');
		expect(card).toBeTruthy();
		const btn = card.querySelector('.kq-cos-buy');
		expect(btn.disabled).toBe(true);
		btn.click();
		expect(calls.buy.length).toBe(0); // a disabled button never fires
	});

	it('marks an owned cosmetic as Owned instead of offering a buy button', () => {
		mount();
		hud.openShop();
		const ownedId = currentOffers(T).always[0];
		hud.setShop(board({ gold: 5000, owned: [ownedId] }));
		const ownedTag = [...document.querySelectorAll('#kq-shop-body .kq-cos-owned')];
		expect(ownedTag.length).toBeGreaterThan(0);
	});
});

describe('wardrobe tab — equip / unequip', () => {
	it('shows the empty state when nothing is owned', () => {
		mount();
		hud.openShop();
		hud.setShop(board({ owned: [] }));
		hud._setShopTab('wardrobe');
		expect(document.querySelector('#kq-shop-body .kq-shop-empty')).toBeTruthy();
	});

	it('lists owned cosmetics + a Default tile and equips on click', () => {
		mount();
		hud.openShop();
		const owned = currentOffers(T).always.slice(0, 1);
		hud.setShop(board({ owned, equipped: '' }));
		hud._setShopTab('wardrobe');
		// Default tile is equipped when nothing else is.
		const equippedTag = document.querySelector('#kq-shop-body .kq-cos--equipped');
		expect(equippedTag).toBeTruthy();
		// Equip the owned cosmetic.
		const equipBtn = document.querySelector('#kq-shop-body .kq-cos-equip');
		expect(equipBtn).toBeTruthy();
		equipBtn.click();
		expect(calls.equip).toEqual(owned);
	});

	it('the Default tile unequips when a cosmetic is equipped', () => {
		mount();
		hud.openShop();
		const owned = currentOffers(T).always.slice(0, 1);
		hud.setShop(board({ owned, equipped: owned[0] }));
		hud._setShopTab('wardrobe');
		// The equipped cosmetic shows "Equipped"; the Default tile offers Equip.
		const defaultCard = document.querySelector('#kq-shop-body .kq-cos--default');
		expect(defaultCard).toBeTruthy();
		defaultCard.querySelector('.kq-cos-equip').click();
		expect(calls.unequip).toBe(1);
	});
});
