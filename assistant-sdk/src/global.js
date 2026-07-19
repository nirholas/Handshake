/**
 * CDN entry: @three-ws/assistant
 * ==============================
 *
 * The one-tag build served at https://three.ws/assistant/v1.js. It binds the
 * API to the origin the script itself was loaded from (so preview and
 * self-hosted deployments work with no config), exposes it at
 * window.ThreeAssistant, and auto-mounts from the script tag's `data-*`
 * attributes unless the tag carries `data-manual`.
 *
 *   <script src="https://three.ws/assistant/v1.js" async
 *           data-name="Atelier AI" data-bg="ember"></script>
 */

import { createAssistant, configFromScript } from './loader.js';

(function () {
	if (typeof window === 'undefined') return;
	if (window.__threeWsAssistantV1) return; // idempotent across multiple includes
	window.__threeWsAssistantV1 = true;

	// document.currentScript is the running <script> during synchronous eval,
	// even for async scripts. Bind the frame origin to wherever it was served.
	const script = document.currentScript;
	let origin = 'https://three.ws';
	try {
		origin = new URL(script.src).origin;
	} catch {
		/* keep the default origin */
	}

	const api = createAssistant({ origin });
	window.ThreeAssistant = api;

	if (script && !script.hasAttribute('data-manual')) {
		const config = configFromScript(script);
		const boot = () => api.init(config);
		if (document.body) boot();
		else document.addEventListener('DOMContentLoaded', boot);
	}
})();
