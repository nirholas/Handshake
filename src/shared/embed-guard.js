// Failure handling for third-party <iframe> and widget-script embeds.
//
// A cross-origin embed gives the host page almost nothing to work with: `load`
// fires even for the other side's error page, and an embed an ad blocker or a
// network policy swallows outright often fires neither `load` nor `error`. So
// the page sat on a 300px empty box with no text, which reads as "three.ws is
// broken" rather than "your blocker ate DexScreener".
//
// Two pieces, both used by the coin page's chart terminals (TradingView,
// DexScreener, GeckoTerminal):
//   watchEmbed()        a deadline that only starts once the embed is actually
//                       on screen, because a lazy iframe below the fold has not
//                       begun loading and must not be reported as dead.
//   embedFallbackNode() the designed replacement: what happened, a link that
//                       opens the chart on the provider, and a retry.

export const DEFAULT_EMBED_TIMEOUT_MS = 12_000;

/**
 * Call `onTimeout` unless `cancel()` runs first.
 *
 * The clock starts at first intersection, not at mount: `loading="lazy"` frames
 * do not begin fetching until they scroll into view, and starting the timer at
 * mount reported every below-the-fold embed as dead. Where IntersectionObserver
 * is missing the timer starts immediately, which is the safe direction (a false
 * "did not load" beats a permanent skeleton).
 *
 * @param {Element} node
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]
 * @param {() => void} opts.onTimeout
 * @param {(cb: IntersectionObserverCallback) => IntersectionObserver} [opts.observerFactory] Injectable for tests.
 * @returns {() => void} cancel
 */
export function watchEmbed(node, { timeoutMs = DEFAULT_EMBED_TIMEOUT_MS, onTimeout, observerFactory } = {}) {
	let timer = null;
	let observer = null;
	// Once cancelled, stay cancelled. disconnect() should stop the callback, but
	// an observer that fires one queued entry after disconnect would otherwise
	// restart the clock on an embed the caller already settled.
	let cancelled = false;

	const start = () => {
		if (cancelled || timer !== null) return;
		timer = setTimeout(onTimeout, timeoutMs);
	};
	const cancel = () => {
		cancelled = true;
		if (timer !== null) clearTimeout(timer);
		timer = null;
		observer?.disconnect();
		observer = null;
	};

	const makeObserver = observerFactory
		|| (typeof IntersectionObserver === 'function' ? (cb) => new IntersectionObserver(cb) : null);
	if (!makeObserver) {
		start();
		return cancel;
	}
	observer = makeObserver((entries) => {
		if (!entries.some((e) => e.isIntersecting)) return;
		observer?.disconnect();
		observer = null;
		start();
	});
	observer.observe(node);
	return cancel;
}

/**
 * The panel that replaces a dead embed: one sentence naming what failed and the
 * likeliest cause, a link that opens the same chart on the provider's own site,
 * and a retry. Never a bare empty box.
 *
 * @param {object} opts
 * @param {string} opts.name    e.g. 'The TradingView chart'.
 * @param {string} opts.href    Where to see the same content.
 * @param {string} opts.label   Link text (an arrow is appended).
 * @param {() => void} opts.onRetry
 * @param {string} [opts.className]      Wrapper classes.
 * @param {string} [opts.buttonClassName] Retry-button classes.
 * @returns {HTMLElement}
 */
export function embedFallbackNode({
	name,
	href,
	label,
	onRetry,
	className = 'cv-chart-state col',
	buttonClassName = 'cv-range-btn',
}) {
	const panel = document.createElement('div');
	panel.className = className;
	panel.setAttribute('role', 'status');

	const why = document.createElement('p');
	why.textContent = `${name} did not load. It may be blocked by an ad blocker, an extension or your network.`;
	panel.appendChild(why);

	const linkRow = document.createElement('p');
	const link = document.createElement('a');
	link.href = href;
	link.target = '_blank';
	link.rel = 'noopener nofollow noreferrer';
	link.textContent = `${label} ↗`;
	linkRow.appendChild(link);
	panel.appendChild(linkRow);

	const retry = document.createElement('button');
	retry.type = 'button';
	retry.className = buttonClassName;
	retry.textContent = 'Try again';
	retry.addEventListener('click', onRetry);
	panel.appendChild(retry);

	return panel;
}

/**
 * Swap a dead embed for the fallback panel, in place.
 *
 * @param {HTMLElement} host  The element holding the embed.
 * @param {Parameters<typeof embedFallbackNode>[0]} opts
 */
export function renderEmbedFallback(host, opts) {
	host.replaceChildren(embedFallbackNode(opts));
}
