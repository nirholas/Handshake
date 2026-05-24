// JSON-RPC 2.0 server for the in-iframe widget surface.
//
// Parents that load /widget#... or /app#widget=... in an iframe can drive the
// viewer programmatically by posting JSON-RPC messages:
//
//   iframe.contentWindow.postMessage({
//       jsonrpc: '2.0', id: 1,
//       method: 'camera.setLookAt',
//       params: { eye: [0, 1.6, 3], target: [0, 1, 0], duration: 1.2 },
//   }, '*');
//
// The server replies with `{ jsonrpc: '2.0', id, result }` or
// `{ jsonrpc: '2.0', id, error: { code, message } }`. It also pushes events
// (notifications, no id) for viewer.ready, model.loaded, animation.ended, etc.
//
// The legacy `{ id, action, input }` bridge in app.js still works in parallel —
// this module is additive, not a replacement.

import { Vector3 } from 'three';
import { protocol, ACTION_TYPES } from '../agent-protocol.js';

const PROTOCOL = 'jsonrpc';
const VERSION = '2.0';

const ERR = {
	PARSE: { code: -32700, message: 'Parse error' },
	INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
	METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
	INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
	INTERNAL: { code: -32603, message: 'Internal error' },
	VIEWER_NOT_READY: { code: -32000, message: 'Viewer not ready' },
};

function arr3(v, fallback) {
	if (Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n))) return v;
	return fallback;
}

/**
 * Wire JSON-RPC handlers onto the App instance and start listening.
 * @param {App} app — the running App
 * @returns {() => void} teardown
 */
export function startWidgetRpcServer(app) {
	const methods = buildMethods(app);
	const onMessage = (event) => {
		const msg = event.data;
		if (!msg || typeof msg !== 'object' || msg.jsonrpc !== VERSION) return;
		// Ignore replies from clients (responses to events we sent).
		if (!msg.method) return;
		// Require a string method; reject malformed.
		if (typeof msg.method !== 'string') {
			if (msg.id != null) reply(event, msg.id, null, ERR.INVALID_REQUEST);
			return;
		}
		const handler = methods[msg.method];
		if (!handler) {
			if (msg.id != null) reply(event, msg.id, null, ERR.METHOD_NOT_FOUND);
			return;
		}
		Promise.resolve()
			.then(() => handler(msg.params || {}, event))
			.then(
				(result) => {
					if (msg.id != null) reply(event, msg.id, result ?? {}, null);
				},
				(err) => {
					if (msg.id != null) {
						reply(event, msg.id, null, {
							code: ERR.INTERNAL.code,
							message: String(err?.message || err || 'error'),
						});
					}
				},
			);
	};

	window.addEventListener('message', onMessage);

	// Push protocol-level lifecycle events to the parent. These mirror the
	// internal protocol bus so any subscriber can know when the model is live.
	const unsubLoad = protocol.on(ACTION_TYPES.LOAD_END, (action) => {
		const success = action?.payload?.success === true;
		if (success) {
			emit('model.loaded', {
				url: app._currentModelUrl || null,
				success: true,
			});
			if (!app._rpcReadyFired) {
				app._rpcReadyFired = true;
				emit('viewer.ready', {});
			}
		} else {
			emit('model.loaded', {
				url: app._currentModelUrl || null,
				success: false,
				error: action?.payload?.error || 'load failed',
			});
		}
	});

	// Cleanup helper exposed for tests; production never tears this down.
	return () => {
		window.removeEventListener('message', onMessage);
		unsubLoad();
	};
}

/**
 * Send a notification event to every plausible parent. We don't track a
 * specific origin because widgets are embedded in unknown third-party pages;
 * `*` is the standard for outbound notifications. Parents validate by
 * checking `event.source === iframe.contentWindow` on their side.
 */
function emit(method, params) {
	if (window.parent === window) return; // not in an iframe
	try {
		window.parent.postMessage({ jsonrpc: VERSION, method, params }, '*');
	} catch {
		/* parent gone — ignore */
	}
}

function reply(event, id, result, error) {
	const msg = error
		? { jsonrpc: VERSION, id, error }
		: { jsonrpc: VERSION, id, result };
	const replyTo = event.source || window.parent;
	if (!replyTo) return;
	// Reply to the exact origin we received from when we have one — otherwise
	// fall back to '*'. The wildcard is safe because the reply is keyed to
	// the request id, which the client generated.
	const origin = event.origin && event.origin !== 'null' ? event.origin : '*';
	try {
		replyTo.postMessage(msg, origin);
	} catch {
		/* dead window — ignore */
	}
}

function buildMethods(app) {
	const requireViewer = () => {
		const v = app.viewer || window.VIEWER?.app?.viewer;
		if (!v) throw Object.assign(new Error(ERR.VIEWER_NOT_READY.message), {
			code: ERR.VIEWER_NOT_READY.code,
		});
		return v;
	};

	return {
		// ── Camera ────────────────────────────────────────────────────────────
		'camera.getLookAt': () => {
			const v = requireViewer();
			const cam = v.activeCamera || v.defaultCamera;
			return {
				eye: cam.position.toArray(),
				target: v.controls.target.toArray(),
				fov: cam.fov,
			};
		},
		'camera.setLookAt': (params) => {
			const v = requireViewer();
			const cam = v.activeCamera || v.defaultCamera;
			const eye = arr3(params.eye, null);
			const target = arr3(params.target, null);
			const duration = Number(params.duration);
			if (!eye && !target) throw new Error('eye or target required');
			if (duration > 0) {
				// Tween via the viewer's own helper.
				const targetVec = target ? new Vector3().fromArray(target) : v.controls.target.clone();
				const eyeVec = eye ? new Vector3().fromArray(eye) : cam.position.clone();
				v._tweenCamera?.(eyeVec, targetVec, duration * 1000);
			} else {
				if (eye) cam.position.fromArray(eye);
				if (target) v.controls.target.fromArray(target);
				v.controls.update();
				v.invalidate();
			}
			return {
				eye: cam.position.toArray(),
				target: v.controls.target.toArray(),
			};
		},
		'camera.recenter': (params) => {
			const v = requireViewer();
			v.frameContent({
				animate: true,
				durationMs: Number(params.duration) > 0 ? Number(params.duration) * 1000 : 600,
			});
			return {};
		},

		// ── Animation ─────────────────────────────────────────────────────────
		'animation.list': () => {
			const v = requireViewer();
			const defs = v.animationManager?.getAnimationDefs?.() || [];
			const baked = (v.clips || []).map((c) => ({ name: c.name, duration: c.duration }));
			return {
				clips: [
					...defs.map((d) => ({ name: d.name, duration: d.duration ?? null })),
					...baked,
				],
			};
		},
		'animation.play': async (params) => {
			const v = requireViewer();
			const name = String(params.name || '').trim();
			if (!name) throw new Error('name required');
			const loop = params.loop !== false;
			if (v.animationManager?.ensureLoaded) {
				await v.animationManager.ensureLoaded(name).catch(() => {});
			}
			if (app.sceneCtrl?.playClipByName) {
				app.sceneCtrl.playClipByName(name, { loop });
			} else {
				v.animationManager?.play?.(name, { loop });
			}
			return { name };
		},
		'animation.stop': () => {
			const v = requireViewer();
			v.animationManager?.stop?.();
			return {};
		},

		// ── Screenshot ────────────────────────────────────────────────────────
		'screenshot.capture': async (params) => {
			const v = requireViewer();
			// Render once into the offscreen buffer at the requested size, then
			// snapshot. Falls back to canvas.toDataURL() if no resize requested.
			const w = Math.round(Number(params.width) || 0);
			const h = Math.round(Number(params.height) || 0);
			if (w > 0 && h > 0) {
				const blob = await v.captureScreenshot({ width: w, height: h }).catch(() => null);
				if (blob) {
					const reader = new FileReader();
					return await new Promise((resolve, reject) => {
						reader.onload = () => resolve({ dataUrl: reader.result });
						reader.onerror = () => reject(new Error('blob read failed'));
						reader.readAsDataURL(blob);
					});
				}
			}
			v.renderer.render(v.scene, v.activeCamera || v.defaultCamera);
			const mime = String(params.mime || 'image/png');
			return { dataUrl: v.renderer.domElement.toDataURL(mime) };
		},

		// ── Model swap ────────────────────────────────────────────────────────
		'model.load': async (params) => {
			const url = String(params.url || '').trim();
			if (!url) throw new Error('url required');
			await app.view(url, '', new Map());
			return { url };
		},

		// ── Display config ────────────────────────────────────────────────────
		'viewer.setBackground': (params) => {
			const v = requireViewer();
			if (!params.color) throw new Error('color required');
			v.setBackgroundColor(params.color);
			return {};
		},
		'viewer.setAutoRotate': (params) => {
			const v = requireViewer();
			if (typeof params.enabled === 'boolean') v.controls.autoRotate = params.enabled;
			if (typeof params.speed === 'number') v.controls.autoRotateSpeed = params.speed;
			v.invalidate();
			return {};
		},
		'viewer.setEnvironment': (params) => {
			const v = requireViewer();
			const preset = String(params.preset || '').trim();
			if (!preset || !v.setEnvironment) throw new Error('preset required');
			v.setEnvironment(preset);
			return {};
		},

		// ── Introspection ─────────────────────────────────────────────────────
		'viewer.getInfo': () => {
			const v = requireViewer();
			return {
				version: '1',
				ready: Boolean(v.content),
				model: app._currentModelUrl || null,
				widget: app.options?.widget || null,
				type: app.options?.type || null,
			};
		},

		// Optional ping for round-trip health checks.
		ping: () => ({ pong: true, t: Date.now() }),
	};
}

export { PROTOCOL, VERSION };
