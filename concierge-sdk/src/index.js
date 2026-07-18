/**
 * @three-ws/concierge, public entry
 * ==================================
 *
 * An AI concierge for any website: floating launcher, chat panel with a
 * rigged 3D avatar that blinks and lipsyncs, streaming answers grounded in
 * the live page, voice out (Web Speech TTS) and push-to-talk voice in.
 *
 * Three ways in:
 *
 *  1. Zero-JS CDN tag:
 *       <script type="module"
 *               src="https://three.ws/concierge/concierge.global.js"
 *               data-concierge data-site-name="Acme"></script>
 *  2. HTML tag:
 *       import '@three-ws/concierge';
 *       <three-concierge site-name="Acme" accent="#f97316"></three-concierge>
 *  3. Imperative:
 *       import { Concierge } from '@three-ws/concierge';
 *       const c = new Concierge({ siteName: 'Acme', knowledge: FAQ });
 *       c.ask('What does the Pro plan cost?');
 *
 * `three` is a peer dependency for the module builds; the .global.js build
 * inlines it for script-tag use.
 */

export const VERSION = '0.1.0';

export { Concierge, drainSentences } from './widget.js';
export { ThreeConciergeElement, registerElement } from './element.js';
export { AvatarStage } from './stage.js';
export { SpeechNarrator } from './narrator.js';
export { createLipsync, buildMorphMap, estimateDurationMs } from './lipsync.js';
export {
	AVATARS, DEFAULT_AVATAR_ID, DEFAULT_ASSET_BASE,
	getAvatar, avatarUrl, customAvatarEntry,
} from './catalog.js';
export { harvestSiteContext, buildSitePayload, MAX_CONTENT_CHARS, MAX_KNOWLEDGE_CHARS } from './context.js';
export { askConcierge, parseSseEvent, createSseBuffer, DEFAULT_ENDPOINT, MAX_HISTORY_TURNS } from './client.js';
export { renderMarkdown, stripMarkdown, escapeHtml } from './markdown.js';
export { createMic, micSupported } from './mic.js';
export { CSS, ensureStyles } from './styles.js';

import { Concierge } from './widget.js';
import { registerElement } from './element.js';

// Register the <three-concierge> element on import (browser only).
if (typeof window !== 'undefined') {
	registerElement();
}

/**
 * Convenience factory, mount a concierge and return the controller.
 * @param {ConstructorParameters<typeof Concierge>[0]} [config]
 */
export function mount(config) {
	return new Concierge(config);
}

/**
 * Auto-init from a `<script data-concierge>` tag so a site can install the
 * widget with no JS at all, the script's `data-*` attributes become config.
 * Idempotent: only the first tagged script mounts an instance.
 */
function autoInit() {
	if (typeof document === 'undefined' || window.__threeWsConcierge) return;
	const tag = document.currentScript || document.querySelector('script[data-concierge]');
	if (!tag || !tag.hasAttribute('data-concierge')) return;

	const d = tag.dataset;
	window.__threeWsConcierge = new Concierge({
		endpoint: d.endpoint || undefined,
		avatar: d.avatar || undefined,
		avatars: d.avatars?.split(',').map((s) => s.trim()).filter(Boolean),
		customAvatar: d.customAvatar || undefined,
		assetBase: d.assetBase || undefined,
		name: d.name || undefined,
		siteName: d.siteName || undefined,
		greeting: d.greeting || undefined,
		suggestions: d.suggestions?.split('|').map((s) => s.trim()).filter(Boolean),
		knowledge: d.knowledge || undefined,
		persona: d.persona || undefined,
		accent: d.accent || undefined,
		position: d.position || undefined,
		theme: d.theme || undefined,
		lang: d.lang || undefined,
		open: 'open' in d,
		muted: 'muted' in d,
		picker: !('noPicker' in d),
		teaser: !('noTeaser' in d),
		zIndex: d.zIndex ? Number(d.zIndex) : undefined,
	});
}

if (typeof window !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', autoInit, { once: true });
	} else {
		autoInit();
	}
}

export default Concierge;
