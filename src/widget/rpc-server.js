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

import { Vector3, WebGLRenderTarget, NoToneMapping } from 'three';
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
			// AnimationManager exposes `stopAll()`; the underscore-named `stop`
			// I previously called doesn't exist (silent no-op). The baked
			// THREE.AnimationMixer also stops via stopAllAction when present.
			v.animationManager?.stopAll?.();
			if (v.mixer && typeof v.mixer.stopAllAction === 'function') v.mixer.stopAllAction();
			v.invalidate?.();
			return {};
		},

		// ── Screenshot ────────────────────────────────────────────────────────
		// Returns a data: URL of the rendered scene. With no `width`/`height`
		// it captures at the live canvas resolution; pass either or both to
		// render off-screen at an exact pixel size (useful for OG cards or
		// fixed thumbnails decoupled from the iframe dimensions).
		'screenshot.capture': (params) => {
			const v = requireViewer();
			const mime = String(params.mime || 'image/png');
			const cam = v.activeCamera || v.defaultCamera;
			const reqW = Number(params.width);
			const reqH = Number(params.height);
			const wantsResize =
				(Number.isFinite(reqW) && reqW > 0) || (Number.isFinite(reqH) && reqH > 0);

			if (!wantsResize) {
				v.renderer.render(v.scene, cam);
				return { dataUrl: v.renderer.domElement.toDataURL(mime) };
			}

			const w = Math.max(1, Math.round(Number.isFinite(reqW) && reqW > 0 ? reqW : reqH));
			const h = Math.max(1, Math.round(Number.isFinite(reqH) && reqH > 0 ? reqH : reqW));
			const target = new WebGLRenderTarget(w, h);
			const prevTarget = v.renderer.getRenderTarget();
			const prevAspect = cam.aspect;
			const prevToneMapping = v.renderer.toneMapping;
			try {
				cam.aspect = w / h;
				cam.updateProjectionMatrix();
				v.renderer.toneMapping = prevToneMapping ?? NoToneMapping;
				v.renderer.setRenderTarget(target);
				v.renderer.render(v.scene, cam);

				const pixels = new Uint8Array(w * h * 4);
				v.renderer.readRenderTargetPixels(target, 0, 0, w, h, pixels);

				// WebGL's origin is bottom-left; canvas 2D is top-left. Flip rows
				// during the copy so the resulting image isn't upside-down.
				const canvas = document.createElement('canvas');
				canvas.width = w;
				canvas.height = h;
				const ctx2d = canvas.getContext('2d');
				const imageData = ctx2d.createImageData(w, h);
				const data = imageData.data;
				const rowBytes = w * 4;
				for (let y = 0; y < h; y++) {
					const srcOffset = (h - 1 - y) * rowBytes;
					const dstOffset = y * rowBytes;
					data.set(pixels.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
				}
				ctx2d.putImageData(imageData, 0, 0);
				return { dataUrl: canvas.toDataURL(mime) };
			} finally {
				v.renderer.setRenderTarget(prevTarget);
				v.renderer.toneMapping = prevToneMapping;
				cam.aspect = prevAspect;
				cam.updateProjectionMatrix();
				target.dispose();
				v.invalidate?.();
			}
		},

		// ── Model swap ────────────────────────────────────────────────────────
		'model.load': async (params) => {
			const url = String(params.url || '').trim();
			if (!url) throw new Error('url required');
			await app.view(url, '', new Map());
			return { url };
		},

		// Export the currently-loaded scene as a binary GLB, returned as a
		// base64 string. Parent pages use this to save user-modified avatars,
		// stream them to a backend, etc. Matches the legacy
		// `{ action: 'exportGLB' }` bridge envelope so chat clients that still
		// use it keep working — this is the same code path, just JSON-RPC
		// shaped.
		'model.export': async () => {
			const v = requireViewer();
			if (!v.content) throw new Error('no model loaded');
			const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
			const exporter = new GLTFExporter();
			const buffer = await new Promise((resolve, reject) => {
				exporter.parse(
					v.content,
					(result) => resolve(result instanceof ArrayBuffer ? result : result.buffer),
					(err) => reject(new Error(String(err?.message || err))),
					{ binary: true },
				);
			});
			const bytes = new Uint8Array(buffer);
			let binary = '';
			for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
			return { base64: btoa(binary), bytes: bytes.length };
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
