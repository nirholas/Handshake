/**
 * @three-ws/assistant
 * ===================
 *
 * A 3D avatar assistant on any website. A floating launcher opens a real
 * animated avatar in a panel, against your page, a color, or a gradient, with
 * two modes: a chatbot (free model chain, or the visitor's own Groq/OpenRouter
 * key) and a speak mode where the avatar says whatever you type, out loud, in a
 * speech bubble.
 *
 * The avatar, chat, and speech run inside an iframe hosted on three.ws
 * (`/assistant-frame`); this package is the host-side loader. See
 * https://three.ws/docs/assistant-widget.
 *
 * npm / bundler use:
 *
 *   import ThreeAssistant from '@three-ws/assistant';
 *   ThreeAssistant.init({ avatar: '/avatars/selfie-girl.glb', name: 'Atelier AI' });
 *   ThreeAssistant.say('Welcome!');
 *
 * One-tag CDN use (no build):
 *
 *   <script src="https://three.ws/assistant/v1.js" async
 *           data-name="Atelier AI" data-bg="ember"></script>
 */

import { createAssistant, configFromScript } from './loader.js';

export const VERSION = '1.0.0';

export {
	Assistant,
	createAssistant,
	configFromScript,
	frameUrl,
	isHex,
	PARAM_KEYS,
	CHANNEL,
} from './loader.js';

// The default singleton API, bound to the hosted three.ws frame. Pass
// `{ origin }` to `init` to point at a self-hosted deployment.
const ThreeAssistant = createAssistant();

export const { init, open, close, toggle, say, setMode, destroy } = ThreeAssistant;

/** Alias for `init` (mirrors other three.ws SDKs). */
export const mount = (config) => ThreeAssistant.init(config);

/**
 * Auto-mount from the currently executing `<script>` tag's `data-*` attributes.
 * Idempotent per page. Skipped when the tag carries `data-manual`. Called by
 * the CDN global build; safe to call yourself if you inject the tag late.
 */
export function autoInit(script) {
	if (typeof window === 'undefined' || typeof document === 'undefined') return;
	if (window.__threeWsAssistant) return;
	const tag = script || document.currentScript;
	if (!tag || tag.hasAttribute('data-manual')) return;
	window.__threeWsAssistant = true;
	const config = configFromScript(tag);
	const boot = () => ThreeAssistant.init(config);
	if (document.body) boot();
	else document.addEventListener('DOMContentLoaded', boot);
}

export default ThreeAssistant;
