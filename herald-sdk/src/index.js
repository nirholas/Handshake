/*
 * @three-ws/herald: deliver a message in person.
 * =============================================================================
 * Notifications are a badge you have to notice, in a tray you have to open,
 * competing with forty others. This SDK delivers the ones that matter the way a
 * colleague would: a character walks into the corner of the page, looks at you,
 * and tells you, with a link to the thing it is about.
 *
 * Three lines to the whole feature:
 *
 *   import { createHerald } from '@three-ws/herald';
 *   const herald = createHerald();
 *   herald.announce({ text: 'Deploy is green', importance: 80, url: '/builds' });
 *
 * What you get for those three lines is not a toast library. It is a delivery
 * discipline: importance scoring, an interrupt floor, quiet hours, a rate
 * limit, dedupe with a TTL, freshness, batching with a collapse line, focus
 * awareness, an accessible fallback for machines that cannot render 3D, and an
 * audit trail of every message that did not make it and why.
 *
 * The avatar is optional and so is the network. Everything degrades: no
 * @three-ws/walk and no WebGL leaves you with an accessible DOM card; no audio
 * permission leaves you with text; no rules leaves you with sane defaults.
 */

import {
	DEFAULT_RULES,
	DROP_REASONS,
	HOLD_REASONS,
	decide,
	dwellMsFor,
	planBatch,
	pruneSeen,
	resolveRules,
	toMessage,
} from './rules.js';
import { createAvatarPresenter } from './presenters/avatar.js';
import { createCardPresenter } from './presenters/card.js';
import { createVoice } from './voice.js';
import { manualSource } from './sources/index.js';

export const VERSION = '0.1.0';

export {
	DEFAULT_RULES,
	DROP_REASONS,
	HOLD_REASONS,
	decide,
	dwellMsFor,
	planBatch,
	resolveRules,
	scoreMessage,
	toMessage,
	withinQuietHours,
} from './rules.js';
export { createAvatarPresenter } from './presenters/avatar.js';
export { createCardPresenter } from './presenters/card.js';
export { createVoice } from './voice.js';
export { pollSource, sseSource, railSource, manualSource } from './sources/index.js';

// How often a held queue is re-examined. Holds are cleared by the passage of
// time (a rate window draining, quiet hours ending) or by an event we already
// listen for (focus), so this is a safety net rather than the mechanism.
const SWEEP_MS = 5_000;
const PRUNE_EVERY = 20;

/**
 * @param {object} [options]
 * @param {'auto'|'avatar'|'card'} [options.presenter='auto'] `auto` uses the
 *   avatar when one can be rendered and the card when it cannot.
 * @param {object} [options.presenters] override the built-in presenters
 *   (`{ avatar, card }`), for tests or a bespoke body.
 * @param {import('./rules.js').Rules} [options.rules]
 * @param {'off'|'auto'|'always'} [options.voice='off'] `auto` speaks only when
 *   audio is already unlocked by a gesture; `always` tries every time.
 * @param {object} [options.voiceOptions] see createVoice
 * @param {Array<(m: import('./rules.js').Message) => number|undefined>} [options.scorers]
 * @param {(m: object) => void} [options.onDeliver]
 * @param {(m: object, reason: string) => void} [options.onDrop]
 * @param {(m: object, reason: string) => void} [options.onHold]
 * @param {(m: object) => Array<object>} [options.actionsFor] extra buttons on a
 *   delivery; the default gives "Open" for a message with a url.
 * @param {object} [options.companion] a live @three-ws/walk control to reuse
 * @param {object} [options.avatarOptions] forwarded to createAvatarPresenter
 *   (`walkModule`, `companionOptions`), for pages that serve their own build of
 *   the companion rather than installing the package
 * @param {() => number} [options.now] clock seam, for tests
 */
export function createHerald(options = {}) {
	const opts = { presenter: 'auto', voice: 'off', ...options };
	const rules = resolveRules(opts.rules);
	const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
	const scorers = [...(opts.scorers || [])];

	const seen = new Map();
	const recent = [];
	const held = [];
	const stops = [];
	const stats = { received: 0, delivered: 0, dropped: 0, held: 0, spoken: 0 };
	const drops = [];

	let busy = false;
	let muted = false;
	let mutedUntil = 0;
	let stopped = false;
	let sweepTimer = 0;
	let sincePrune = 0;

	const presenters = {
		avatar:
			opts.presenters?.avatar ||
			createAvatarPresenter({ companion: opts.companion, ...(opts.avatarOptions || {}) }),
		card: opts.presenters?.card || createCardPresenter(),
	};
	const voice =
		opts.voice === 'off' ? null : opts.voiceOptions === null ? null : createVoice(opts.voiceOptions);

	const manual = manualSource();
	attach(manual);

	// ── Intake ────────────────────────────────────────────────────────────────

	function intake(raw) {
		if (stopped) return null;
		const message = toMessage(raw);
		if (!message) {
			record(null, DROP_REASONS.EMPTY);
			return null;
		}
		stats.received += 1;
		return route(message);
	}

	function route(message) {
		const verdict = decide(message, {
			rules,
			now: now(),
			hour: localHour(now()),
			seen,
			recent,
			focused: isFocused(),
			busy,
			muted: isMuted(),
			scorers,
		});
		message.importance = verdict.importance;

		if (verdict.action === 'drop') {
			record(message, verdict.reason);
			return { action: 'drop', reason: verdict.reason, message };
		}
		if (verdict.action === 'hold') {
			stats.held += 1;
			held.push(message);
			opts.onHold?.(message, verdict.reason);
			scheduleSweep();
			return { action: 'hold', reason: verdict.reason, message };
		}
		deliver(message);
		return { action: 'deliver', message };
	}

	function record(message, reason) {
		stats.dropped += 1;
		drops.push({ at: now(), reason, text: message?.text || '' });
		if (drops.length > 50) drops.shift();
		opts.onDrop?.(message, reason);
	}

	// ── Delivery ──────────────────────────────────────────────────────────────

	async function deliver(message) {
		busy = true;
		const stamp = now();
		seen.set(message.key || message.id || message.text, stamp);
		recent.push(stamp);
		while (recent.length && recent[0] < stamp - rules.rateWindowMs) recent.shift();
		if (++sincePrune >= PRUNE_EVERY) {
			sincePrune = 0;
			pruneSeen(seen, stamp, rules.dedupeTtlMs);
		}

		const dwellMs = dwellMsFor(message.text);
		const actions = buildActions(message);
		const spoken = message.from ? `${message.from} says: ${message.text}` : message.text;

		if (voice && (opts.voice === 'always' || voice.unlocked)) {
			voice.speak(spoken).then((ok) => {
				if (ok) stats.spoken += 1;
			});
		}

		try {
			const presenter = await pickPresenter();
			// The presenter's promise resolves when the message LEAVES the screen
			// (which is what keeps deliveries one at a time), so the delivery is
			// counted when it goes UP. Anything else would report a message the
			// person is looking at right now as undelivered for its whole dwell.
			const showing = presenter.present(message, { dwellMs, actions });
			stats.delivered += 1;
			opts.onDeliver?.(message);
			// A presenter that reports it could not render is not a delivery: fall
			// through to the card so the message still reaches a human.
			if ((await showing) === false && presenter.name !== 'card') {
				await presenters.card.present(message, { dwellMs, actions });
			}
		} catch {
			// A presenter that throws must not wedge the queue, and must not leave
			// a delivery counted that nobody ever saw.
			stats.delivered = Math.max(0, stats.delivered - 1);
			record(message, 'presenter-failed');
		} finally {
			busy = false;
			scheduleSweep(0);
		}
	}

	function buildActions(message) {
		const built = [];
		if (message.url) {
			built.push({
				label: message.actionLabel || 'Open',
				href: message.url,
				title: `Open: ${message.text}`,
			});
		}
		const extra = opts.actionsFor?.(message);
		if (Array.isArray(extra)) built.push(...extra);
		return built.slice(0, 3);
	}

	let preferred = null;
	async function pickPresenter() {
		if (opts.presenter === 'card') return presenters.card;
		if (opts.presenter === 'avatar') return presenters.avatar;
		if (preferred) return preferred;
		preferred = (await presenters.avatar.ready?.()) ? presenters.avatar : presenters.card;
		return preferred;
	}

	// ── The held queue ────────────────────────────────────────────────────────

	function scheduleSweep(delay = SWEEP_MS) {
		clearTimeout(sweepTimer);
		if (stopped || !held.length) return;
		sweepTimer = setTimeout(sweep, delay);
	}

	function sweep() {
		if (stopped || busy || !held.length) return scheduleSweep();
		const ready = [];
		const stillHeld = [];
		for (const message of held) {
			const verdict = decide(message, {
				rules,
				now: now(),
				hour: localHour(now()),
				// A held message has not been delivered, so it must not be judged
				// against its own dedupe entry.
				seen: new Map(),
				recent,
				focused: isFocused(),
				busy: false,
				muted: isMuted(),
				scorers,
			});
			if (verdict.action === 'deliver') ready.push({ ...message, importance: verdict.importance });
			else if (verdict.action === 'hold') stillHeld.push(message);
			else record(message, verdict.reason);
		}
		held.length = 0;
		held.push(...stillHeld);

		if (!ready.length) return scheduleSweep();

		const plan = planBatch(ready, rules.batchSize);
		(async () => {
			for (const message of plan.deliver) {
				await deliver(message);
			}
			if (plan.summary) {
				await deliver({
					text: plan.summary,
					importance: 60,
					tone: 'neutral',
					url: plan.collapsed.find((m) => m.url)?.url,
					key: `herald:summary:${now()}`,
				});
			}
			scheduleSweep();
		})();
	}

	// ── Environment ───────────────────────────────────────────────────────────

	function isFocused() {
		const doc = globalThis.document;
		if (!doc) return true; // headless: nothing to hide behind
		return doc.visibilityState !== 'hidden';
	}

	function isMuted() {
		if (muted) return true;
		if (mutedUntil && now() < mutedUntil) return true;
		if (mutedUntil && now() >= mutedUntil) mutedUntil = 0;
		return false;
	}

	function localHour(ts) {
		return new Date(ts).getHours();
	}

	if (globalThis.document?.addEventListener) {
		globalThis.document.addEventListener('visibilitychange', () => {
			if (isFocused()) scheduleSweep(400);
		});
	}

	// ── Public surface ────────────────────────────────────────────────────────

	function attach(source) {
		if (!source?.start) return () => {};
		const stop = source.start((raw) => intake(raw));
		stops.push(stop);
		return stop;
	}

	const herald = {
		VERSION,

		/**
		 * Deliver one message. Returns the verdict, so a caller can log why a
		 * message was not shown instead of guessing.
		 * @param {import('./rules.js').Message|string} message
		 */
		announce(message) {
			return intake(typeof message === 'string' ? { text: message } : message);
		},

		/** Attach a source (poll, SSE, rail, or your own). Returns its stopper. */
		source: attach,

		/** Add an importance scorer: `(message) => number | undefined`. */
		rule(scorer) {
			if (typeof scorer === 'function') scorers.push(scorer);
			return herald;
		},

		/** Silence deliveries. `ms` omitted means until `unmute()`. */
		mute(ms) {
			if (ms == null) muted = true;
			else mutedUntil = now() + Number(ms);
			voice?.cancel();
			return herald;
		},

		unmute() {
			muted = false;
			mutedUntil = 0;
			scheduleSweep(0);
			return herald;
		},

		get muted() {
			return isMuted();
		},

		/** Counters plus the last 50 drops with their reasons. */
		stats() {
			return { ...stats, holding: held.length, drops: [...drops] };
		},

		/** The resolved rules, after defaults. */
		get rules() {
			return { ...rules };
		},

		/** Tear down every source, presenter, and timer. */
		stop() {
			stopped = true;
			clearTimeout(sweepTimer);
			for (const stop of stops.splice(0)) {
				try {
					stop?.();
				} catch {
					/* a source that fails to stop must not block the rest */
				}
			}
			voice?.cancel();
			presenters.avatar.stop?.();
			presenters.card.stop?.();
		},
	};

	return herald;
}

export default createHerald;
