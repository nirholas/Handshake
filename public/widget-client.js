// three.ws — widget client SDK.
//
// Drive an embedded /widget iframe from the parent page with a promise-based
// API. JSON-RPC 2.0 over postMessage; matches the spec the iframe serves at
// src/widget/rpc-server.js.
//
// Usage:
//
//   <iframe id="agent" src="https://three.ws/widget#widget=wdgt_..."></iframe>
//   <script src="https://three.ws/widget-client.js"></script>
//   <script>
//     const client = ThreeWidget.attach(document.getElementById('agent'));
//     client.on('viewer.ready', () => {
//       client.call('camera.setLookAt', { eye:[0,1.6,3], target:[0,1,0], duration:1.5 });
//     });
//     // any time:
//     const { dataUrl } = await client.call('screenshot.capture', { width: 800, height: 800 });
//   </script>
//
// No build step. No deps. Tiny.

(function (root) {
	'use strict';

	// The JSON-RPC 2.0 wire-format version. Distinct from the SDK version
	// exposed publicly as `ThreeWidget.sdkVersion` below — keeping them
	// separate so we can ship breaking SDK changes without touching the wire.
	var RPC_VERSION = '2.0';
	var SDK_VERSION = '1.0.0';

	function originOf(url) {
		try {
			return new URL(url, root.location.href).origin;
		} catch (_) {
			return null;
		}
	}

	function ThreeWidgetClient(iframe, opts) {
		if (!iframe || iframe.tagName !== 'IFRAME') {
			throw new Error('ThreeWidget.attach: first arg must be an <iframe>');
		}
		this.iframe = iframe;
		this.origin = (opts && opts.origin) || originOf(iframe.src) || '*';
		this._pending = Object.create(null);
		this._nextId = 1;
		this._handlers = Object.create(null);
		this._closed = false;
		this._onMessage = onMessage.bind(this);
		root.addEventListener('message', this._onMessage);
	}

	function onMessage(event) {
		if (this._closed) return;
		if (event.source !== this.iframe.contentWindow) return;
		if (this.origin !== '*' && event.origin !== this.origin) return;
		var msg = event.data;
		if (!msg || msg.jsonrpc !== RPC_VERSION) return;
		// Response to one of our requests.
		if (msg.id != null && this._pending[msg.id]) {
			var p = this._pending[msg.id];
			delete this._pending[msg.id];
			if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'error'), { code: msg.error.code }));
			else p.resolve(msg.result);
			return;
		}
		// Event from the iframe.
		if (typeof msg.method === 'string' && msg.id == null) {
			var subs = this._handlers[msg.method];
			if (subs) for (var i = 0; i < subs.length; i++) {
				try { subs[i](msg.params || {}); } catch (e) { /* user code threw — ignore */ }
			}
			// Wildcard subscribers (`'*'`) get every event.
			var any = this._handlers['*'];
			if (any) for (var j = 0; j < any.length; j++) {
				try { any[j](msg.method, msg.params || {}); } catch (_) {}
			}
		}
	}

	ThreeWidgetClient.prototype.call = function (method, params, timeoutMs) {
		if (this._closed) return Promise.reject(new Error('client closed'));
		var self = this;
		var id = self._nextId++;
		return new Promise(function (resolve, reject) {
			self._pending[id] = { resolve: resolve, reject: reject };
			var msg = { jsonrpc: RPC_VERSION, id: id, method: method, params: params || {} };
			try {
				self.iframe.contentWindow.postMessage(msg, self.origin);
			} catch (e) {
				delete self._pending[id];
				reject(e);
				return;
			}
			if (timeoutMs > 0) {
				setTimeout(function () {
					if (self._pending[id]) {
						delete self._pending[id];
						reject(new Error('timeout: ' + method));
					}
				}, timeoutMs);
			}
		});
	};

	ThreeWidgetClient.prototype.on = function (method, fn) {
		if (typeof fn !== 'function') return function () {};
		if (!this._handlers[method]) this._handlers[method] = [];
		this._handlers[method].push(fn);
		var self = this;
		return function off() {
			var arr = self._handlers[method];
			if (!arr) return;
			var idx = arr.indexOf(fn);
			if (idx >= 0) arr.splice(idx, 1);
		};
	};

	ThreeWidgetClient.prototype.ready = function (timeoutMs) {
		// Resolves on the first `viewer.ready` event the iframe pushes, or as
		// soon as a `viewer.getInfo` reports ready (covers attach-after-ready).
		// Total wait is bounded by `timeoutMs`; the internal ping retries every
		// 1s until either the deadline or a successful response.
		var self = this;
		if (self._closed) return Promise.reject(new Error('client closed'));
		var deadline = (timeoutMs && timeoutMs > 0) ? Date.now() + timeoutMs : Infinity;

		return new Promise(function (resolve, reject) {
			var done = false;
			function finish(err) {
				if (done) return;
				done = true;
				if (off) off();
				err ? reject(err) : resolve();
			}

			var off = self.on('viewer.ready', function () { finish(); });

			(function poll() {
				if (done) return;
				if (Date.now() >= deadline) {
					finish(new Error('ready timeout'));
					return;
				}
				// Per-attempt timeout is short (1s) so we re-poll until the
				// iframe finishes booting; the outer `deadline` bounds the
				// total wait.
				self.call('ping', null, 1000).then(
					function () {
						if (done) return;
						self.call('viewer.getInfo', null, 1500).then(
							function (info) {
								if (info && info.ready) finish();
								else setTimeout(poll, 500);
							},
							function () { setTimeout(poll, 500); },
						);
					},
					function () { setTimeout(poll, 500); },
				);
			})();
		});
	};

	ThreeWidgetClient.prototype.close = function () {
		if (this._closed) return;
		this._closed = true;
		root.removeEventListener('message', this._onMessage);
		// Reject any in-flight requests so callers don't dangle.
		for (var id in this._pending) {
			try { this._pending[id].reject(new Error('client closed')); } catch (_) {}
		}
		this._pending = Object.create(null);
		this._handlers = Object.create(null);
	};

	function attach(iframe, opts) {
		return new ThreeWidgetClient(iframe, opts);
	}

	var api = {
		attach: attach,
		Client: ThreeWidgetClient,
		sdkVersion: SDK_VERSION,
		rpcVersion: RPC_VERSION,
		VERSION: SDK_VERSION,
	};
	root.ThreeWidget = api;
	if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
