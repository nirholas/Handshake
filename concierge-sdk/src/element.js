/**
 * <three-concierge> custom element: @three-ws/concierge
 * ======================================================
 *
 * Declarative wrapper around Concierge. The element itself is invisible (the
 * widget docks itself to the viewport corner); it exists so a site can add an
 * AI concierge with pure HTML:
 *
 *   <three-concierge name="Atelier AI" site-name="Atelier"
 *                    suggestions="What is Atelier?|How much does it cost?"
 *                    accent="#f97316"></three-concierge>
 *
 * Attributes (all optional):
 *   endpoint       answer API (default: https://three.ws/api/concierge)
 *   avatar         initial catalog avatar id (sol | nova | vera | atlas | echo)
 *   avatars        comma-separated allow-list of catalog ids for the picker
 *   custom-avatar  URL of a rigged GLB to use instead of the catalog
 *   asset-base     override the GLB host
 *   name           assistant display name (default: the avatar's name)
 *   site-name      product/site name used in the greeting + grounding
 *   greeting       first line shown in the empty state and teaser
 *   suggestions    pipe-separated prompt chips ("a|b|c", max 4)
 *   knowledge      curated facts (FAQ, policies) the answers are grounded in
 *   shop           Shopify store domain → shopping mode (catalog + product cards)
 *   shopping       "true"/"false" to force shopping mode on/off (auto on a store)
 *   currency       ISO currency for product prices (default: the store's / USD)
 *   max-products   how many product cards to recommend per answer (1–8, default 4)
 *   persona        one-line tone instruction, e.g. "warm, playful, concise"
 *   accent         CSS color for the whole widget chrome
 *   position       bottom-right | bottom-left
 *   theme          auto | dark | light
 *   lang           BCP-47 hint for voice in/out
 *   open           present → start with the panel open
 *   muted          present → start with voice off
 *   no-picker      present → hide the avatar picker
 *   no-teaser      present → never show the proactive teaser bubble
 *   z-index        stacking override
 *
 * Methods proxy the controller: ask(text), open(), close(), reset(),
 * setAvatar(id), setMuted(bool). Events re-dispatch as DOM CustomEvents:
 *   three-concierge:ready | :open | :close | :message | :agentchange
 *   three-concierge:catalog (store catalog loaded) | :addtocart | :error
 */

import { Concierge } from './widget.js';

const bool = (el, name) => el.hasAttribute(name);

export class ThreeConciergeElement extends HTMLElement {
	connectedCallback() {
		if (this._widget) return;
		this.style.display = 'none';

		this._widget = new Concierge({
			endpoint: this.getAttribute('endpoint') || undefined,
			avatar: this.getAttribute('avatar') || undefined,
			avatars: this.getAttribute('avatars')?.split(',').map((s) => s.trim()).filter(Boolean),
			customAvatar: this.getAttribute('custom-avatar') || undefined,
			assetBase: this.getAttribute('asset-base') || undefined,
			name: this.getAttribute('name') || undefined,
			siteName: this.getAttribute('site-name') || undefined,
			greeting: this.getAttribute('greeting') || undefined,
			suggestions: this.getAttribute('suggestions')?.split('|').map((s) => s.trim()).filter(Boolean),
			knowledge: this.getAttribute('knowledge') || undefined,
			shop: this.getAttribute('shop') || undefined,
			shopping: this.hasAttribute('shopping')
				? this.getAttribute('shopping') !== 'false'
				: undefined,
			currency: this.getAttribute('currency') || undefined,
			maxProducts: this.getAttribute('max-products')
				? Number(this.getAttribute('max-products'))
				: undefined,
			persona: this.getAttribute('persona') || undefined,
			accent: this.getAttribute('accent') || undefined,
			position: this.getAttribute('position') || undefined,
			theme: this.getAttribute('theme') || undefined,
			lang: this.getAttribute('lang') || undefined,
			open: bool(this, 'open'),
			muted: bool(this, 'muted'),
			picker: !bool(this, 'no-picker'),
			teaser: !bool(this, 'no-teaser'),
			zIndex: this.getAttribute('z-index') ? Number(this.getAttribute('z-index')) : undefined,
		});

		for (const ev of ['ready', 'open', 'close', 'message', 'agentchange', 'catalog', 'addtocart', 'error']) {
			this._widget.on(ev, (detail) => {
				this.dispatchEvent(
					new CustomEvent(`three-concierge:${ev}`, { detail, bubbles: true, composed: true }),
				);
			});
		}
	}

	disconnectedCallback() {
		this._widget?.dispose();
		this._widget = null;
	}

	// ── Imperative API proxy ──────────────────────────────────────────────────
	ask(text) {
		return this._widget?.ask(text);
	}
	open() {
		this._widget?.setOpen(true);
	}
	close() {
		this._widget?.setOpen(false);
	}
	reset() {
		this._widget?.reset();
	}
	setAvatar(id) {
		return this._widget?.setAvatar(id);
	}
	setMuted(muted) {
		this._widget?.setMuted(muted);
	}
	get controller() {
		return this._widget;
	}
}

export function registerElement(tag = 'three-concierge') {
	if (typeof customElements !== 'undefined' && !customElements.get(tag)) {
		customElements.define(tag, ThreeConciergeElement);
	}
	return tag;
}
