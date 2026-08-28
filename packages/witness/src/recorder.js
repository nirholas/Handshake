// The recorder: a bounded, semantic trace of what a person did before it broke.
//
// This is deliberately NOT a session replay recorder. Those capture the DOM
// mutation stream, weigh megabytes, cost real money to store, and produce a
// video a maintainer has to watch. What actually fixes a bug is the sequence of
// intents plus the failure, and that fits in about two kilobytes:
//
//   goto /avatar-studio
//   click  the button "Export"
//   fill   the field "Model name" (11 chars)
//   click  the button "Download"
//   xhr    POST /api/export -> 500
//   error  TypeError: exportGLB is not a function
//
// Because it is small it can be always-on, and because it is always-on the
// trace already exists at the moment the person decides to complain. That is
// the whole trick: nobody can reproduce a bug on request, but everybody has
// just done it.
//
// Design rules, all load-bearing:
//   1. Bounded. One ring buffer, a hard event cap, no growth over a long
//      session. A page left open for eight hours costs the same as one open for
//      eight seconds.
//   2. Passive. Listeners are capture-phase and never call preventDefault, and
//      the fetch/XHR wrappers return the original object untouched on every
//      path. Instrumentation that can change behaviour is a bug generator, not
//      a bug reporter.
//   3. Silent on failure. Every handler is wrapped: a throw inside the recorder
//      must never surface as an error in the page it is watching.
//   4. Values are never held (see redact.js).

import { describeElement } from './selector.js';
import { redactText, redactUrl, summarizeInput, isOptedOut } from './redact.js';

const DEFAULTS = {
	maxEvents: 60,
	// Two identical clicks a second apart are two facts. Fifty are one fact and
	// forty-nine of noise, so repeats collapse into a count.
	coalesceMs: 900,
	captureNetwork: true,
	captureConsole: true,
	sampleScrolls: false,
};

function now() {
	return Date.now();
}

export class Recorder {
	constructor(options = {}) {
		this.options = { ...DEFAULTS, ...options };
		this.events = [];
		this.startedAt = now();
		this.installed = false;
		this.listeners = new Set();
		this._teardown = [];
		this._seq = 0;
	}

	/** Subscribe to "something notable happened" (a failure, not every click). */
	onSignal(fn) {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	_emit(event) {
		const last = this.events[this.events.length - 1];
		// Coalesce an identical repeat rather than spending buffer on it.
		if (
			last &&
			last.type === event.type &&
			last.target === event.target &&
			last.detail === event.detail &&
			event.at - last.at < this.options.coalesceMs
		) {
			last.count = (last.count || 1) + 1;
			last.at = event.at;
			return last;
		}
		event.i = this._seq++;
		this.events.push(event);
		if (this.events.length > this.options.maxEvents) {
			// Drop from the front, but never drop the initial navigation: without
			// it the trace has no starting point and cannot be replayed at all.
			const first = this.events[0];
			if (first.type === 'goto' && this.events.length > 1) this.events.splice(1, 1);
			else this.events.shift();
		}
		if (event.fatal) {
			for (const fn of this.listeners) {
				try {
					fn(event);
				} catch {
					/* a subscriber must never break recording */
				}
			}
		}
		return event;
	}

	_safe(fn) {
		return (...args) => {
			try {
				fn(...args);
			} catch {
				/* the recorder never throws into the page it watches */
			}
		};
	}

	record(type, { target = null, detail = null, fatal = false, meta = null } = {}) {
		return this._emit({ type, target, detail, fatal, meta, at: now() });
	}

	/** Note the page we are on. Called on install and on every history change. */
	noteNavigation(kind = 'goto') {
		if (typeof location === 'undefined') return;
		this.record(kind, { detail: redactUrl(location.href, { origin: location.origin }) });
	}

	install() {
		if (this.installed || typeof window === 'undefined') return this;
		this.installed = true;
		this.noteNavigation('goto');

		const on = (target, type, handler, opts) => {
			const wrapped = this._safe(handler);
			target.addEventListener(type, wrapped, opts);
			this._teardown.push(() => target.removeEventListener(type, wrapped, opts));
		};

		// ── Intent ──────────────────────────────────────────────────────────────
		on(
			document,
			'click',
			(e) => {
				const el = e.target?.closest?.(
					'a,button,input,select,textarea,summary,label,[role],[onclick],[data-testid],[tabindex]',
				);
				if (!el || isOptedOut(el)) return;
				const desc = describeElement(el);
				if (!desc) return;
				this.record('click', { target: JSON.stringify(desc), detail: null, meta: desc });
			},
			true,
		);

		on(
			document,
			'change',
			(e) => {
				const el = e.target;
				if (!el?.tagName || isOptedOut(el)) return;
				const tag = el.tagName;
				if (tag !== 'INPUT' && tag !== 'SELECT' && tag !== 'TEXTAREA') return;
				const desc = describeElement(el);
				if (!desc) return;
				const type = (el.getAttribute('type') || '').toLowerCase();
				if (type === 'checkbox' || type === 'radio') {
					this.record('check', { target: JSON.stringify(desc), detail: el.checked ? 'on' : 'off', meta: desc });
					return;
				}
				if (tag === 'SELECT') {
					// A select's chosen option is UI state a maintainer needs and is
					// not user-authored text, so the label itself is safe to keep.
					const label = redactText(el.selectedOptions?.[0]?.textContent || '', { max: 60 });
					this.record('select', { target: JSON.stringify(desc), detail: label, meta: desc });
					return;
				}
				const shape = summarizeInput(el, el.value);
				this.record('fill', {
					target: JSON.stringify(desc),
					detail: shape.length === null ? 'private' : `${shape.shape}:${shape.length}`,
					meta: desc,
				});
			},
			true,
		);

		on(
			document,
			'submit',
			(e) => {
				const desc = describeElement(e.target);
				if (desc) this.record('submit', { target: JSON.stringify(desc), meta: desc });
			},
			true,
		);

		on(
			window,
			'keydown',
			(e) => {
				// Only keys that are commands, never keys that are content. This is
				// the difference between recording a shortcut and keylogging.
				const isCommand = e.metaKey || e.ctrlKey || e.altKey;
				const named = ['Enter', 'Escape', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown'].includes(e.key);
				if (!isCommand && !named) return;
				const combo = [e.metaKey && 'Meta', e.ctrlKey && 'Control', e.altKey && 'Alt', e.shiftKey && 'Shift', e.key]
					.filter(Boolean)
					.join('+');
				this.record('key', { detail: combo });
			},
			true,
		);

		// ── Navigation ──────────────────────────────────────────────────────────
		on(window, 'popstate', () => this.noteNavigation('navigate'));
		on(window, 'hashchange', () => this.noteNavigation('navigate'));
		for (const method of ['pushState', 'replaceState']) {
			const native = history[method];
			if (typeof native !== 'function') continue;
			const self = this;
			history[method] = function patchedHistory(...args) {
				const result = native.apply(this, args);
				try {
					self.noteNavigation('navigate');
				} catch {
					/* never break a route change */
				}
				return result;
			};
			this._teardown.push(() => {
				history[method] = native;
			});
		}

		// ── Failure ─────────────────────────────────────────────────────────────
		if (this.options.captureConsole) {
			on(
				window,
				'error',
				(e) => {
					if (e.target && e.target !== window && e.target.tagName) {
						const src = e.target.currentSrc || e.target.src || e.target.href;
						if (src) {
							this.record('resource', {
								detail: redactUrl(src, { origin: location.origin }),
								fatal: true,
							});
						}
						return;
					}
					const where = e.filename ? ` (${e.filename.split('/').pop()}:${e.lineno})` : '';
					this.record('error', {
						detail: `${redactText(e.error?.name ? `${e.error.name}: ${e.error.message}` : e.message)}${where}`,
						fatal: true,
					});
				},
				true,
			);
			on(window, 'unhandledrejection', (e) => {
				const reason = e.reason;
				const text = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason?.message || reason);
				this.record('rejection', { detail: redactText(text), fatal: true });
			});
		}

		if (this.options.captureNetwork) this._installNetwork();

		return this;
	}

	_installNetwork() {
		const self = this;
		const origin = typeof location !== 'undefined' ? location.origin : null;

		const nativeFetch = window.fetch;
		if (typeof nativeFetch === 'function') {
			window.fetch = function witnessFetch(input, init) {
				const promise = nativeFetch.apply(this, arguments);
				try {
					const method = String(init?.method || input?.method || 'GET').toUpperCase();
					const raw = typeof input === 'string' ? input : input?.url || '';
					const path = redactUrl(raw, { origin });
					if (path && !self.options.ignore?.(path)) {
						promise.then(
							(res) => {
								if (res && !res.ok) {
									self.record('xhr', { detail: `${method} ${path} -> ${res.status}`, fatal: res.status >= 500 || res.status === 0 });
								}
							},
							(err) => {
								self.record('xhr', { detail: `${method} ${path} -> ${redactText(err?.message || 'network error', { max: 80 })}`, fatal: true });
							},
						);
					}
				} catch {
					/* instrumentation must never change a request */
				}
				return promise;
			};
			this._teardown.push(() => {
				window.fetch = nativeFetch;
			});
		}

		const XHR = window.XMLHttpRequest;
		if (typeof XHR === 'function' && XHR.prototype) {
			const nativeOpen = XHR.prototype.open;
			const nativeSend = XHR.prototype.send;
			XHR.prototype.open = function witnessOpen(method, url, ...rest) {
				try {
					this.__witness = { method: String(method || 'GET').toUpperCase(), url: redactUrl(url, { origin }) };
				} catch {
					/* keep the request working regardless */
				}
				return nativeOpen.call(this, method, url, ...rest);
			};
			XHR.prototype.send = function witnessSend(...args) {
				try {
					const meta = this.__witness;
					if (meta && !self.options.ignore?.(meta.url)) {
						this.addEventListener('loadend', () => {
							try {
								const status = this.status;
								if (status === 0 || status >= 400) {
									self.record('xhr', {
										detail: `${meta.method} ${meta.url} -> ${status || 'failed'}`,
										fatal: status === 0 || status >= 500,
									});
								}
							} catch {
								/* nothing to record */
							}
						});
					}
				} catch {
					/* never break a send */
				}
				return nativeSend.apply(this, args);
			};
			this._teardown.push(() => {
				XHR.prototype.open = nativeOpen;
				XHR.prototype.send = nativeSend;
			});
		}
	}

	/** The environment facts a replay needs to match the session it came from. */
	environment() {
		if (typeof window === 'undefined') return {};
		return {
			url: redactUrl(location.href, { origin: location.origin }),
			viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio || 1 },
			locale: navigator.language || null,
			userAgent: redactText(navigator.userAgent, { max: 200 }),
			touch: (navigator.maxTouchPoints || 0) > 0,
			reducedMotion: !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches,
		};
	}

	/** The trace as it stands. Safe to call at any time; does not stop recording. */
	trace() {
		return {
			version: 1,
			recordedMs: now() - this.startedAt,
			environment: this.environment(),
			// `target` is the coalescing key, not payload: when a descriptor exists
			// it is the same object serialized, so emitting both would double the
			// size of the one thing that has to stay small.
			events: this.events.map(({ meta, fatal, target, ...rest }) => ({
				...rest,
				...(meta ? { el: meta } : target ? { target } : {}),
				...(fatal ? { fatal: true } : {}),
			})),
		};
	}

	/** True when the session contains a failure worth asking the visitor about. */
	hasFailure({ withinMs = 20_000 } = {}) {
		const cutoff = now() - withinMs;
		return this.events.some((e) => e.fatal && e.at >= cutoff);
	}

	uninstall() {
		for (const undo of this._teardown.splice(0)) {
			try {
				undo();
			} catch {
				/* best effort */
			}
		}
		this.installed = false;
	}
}
