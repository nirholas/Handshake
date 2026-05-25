/**
 * three.ws MotionPath — drives a DOM element along a Bezier spline.
 * Used by embed.js (host-page wrapper movement) and agent-chat-widget.html
 * (standalone self-animation mode).
 *
 * Syncs walk/idle animations into the avatar iframe via JSON-RPC 2.0 postMessage.
 */

(function (root, factory) {
	if (typeof module !== 'undefined' && module.exports) {
		module.exports = factory();
	} else {
		root.MotionPath = factory();
	}
}(typeof self !== 'undefined' ? self : this, function () {
	'use strict';

	// ── Preset path generators ────────────────────────────────────────────────
	// Each returns [[x,y], ...] as viewport-fraction coordinates [0–1, 0–1].
	// The path is evaluated as a uniform Catmull-Rom spline through all points.

	var PRESETS = {
		'patrol': function () {
			return [[0.05, 0.75], [0.35, 0.75], [0.65, 0.75], [0.88, 0.75], [0.65, 0.75], [0.35, 0.75], [0.05, 0.75]];
		},
		'slide-in': function () {
			return [[-0.25, 0.75], [0.05, 0.75], [0.12, 0.75]];
		},
		'bounce-across': function () {
			return [[-0.25, 0.75], [0.25, 0.7], [0.5, 0.75], [0.75, 0.7], [1.15, 0.75]];
		},
		'orbit': function () {
			var pts = [];
			var cx = 0.5, cy = 0.5, rx = 0.3, ry = 0.2;
			var steps = 16;
			for (var i = 0; i <= steps; i++) {
				var a = (i / steps) * Math.PI * 2;
				pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
			}
			return pts;
		},
		'figure-eight': function () {
			var pts = [];
			var cx = 0.5, cy = 0.55, rx = 0.28, ry = 0.15;
			var steps = 32;
			for (var i = 0; i <= steps; i++) {
				var t = (i / steps) * Math.PI * 2;
				pts.push([
					cx + rx * Math.sin(t),
					cy + ry * Math.sin(2 * t)
				]);
			}
			return pts;
		},
		'float': function () {
			return [[0.12, 0.75], [0.12, 0.62], [0.12, 0.55], [0.12, 0.62], [0.12, 0.75]];
		},
	};

	// ── Catmull-Rom spline ────────────────────────────────────────────────────

	function catmullRomSegment(p0, p1, p2, p3, t) {
		var t2 = t * t, t3 = t2 * t;
		return [
			0.5 * ((2*p1[0]) + (-p0[0]+p2[0])*t + (2*p0[0]-5*p1[0]+4*p2[0]-p3[0])*t2 + (-p0[0]+3*p1[0]-3*p2[0]+p3[0])*t3),
			0.5 * ((2*p1[1]) + (-p0[1]+p2[1])*t + (2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2 + (-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3)
		];
	}

	/**
	 * Evaluate a Catmull-Rom spline at global parameter t ∈ [0,1].
	 * Returns [x_frac, y_frac].
	 */
	function evalSpline(points, t) {
		var n = points.length;
		if (n === 1) return [points[0][0], points[0][1]];
		if (n === 2) {
			return [points[0][0] + (points[1][0] - points[0][0]) * t,
			        points[0][1] + (points[1][1] - points[0][1]) * t];
		}
		var segments = n - 1;
		var seg = Math.min(Math.floor(t * segments), segments - 1);
		var lt = t * segments - seg;
		var p0 = points[Math.max(seg - 1, 0)];
		var p1 = points[seg];
		var p2 = points[Math.min(seg + 1, n - 1)];
		var p3 = points[Math.min(seg + 2, n - 1)];
		return catmullRomSegment(p0, p1, p2, p3, lt);
	}

	/** Approximate arc length by sampling. Returns array of cumulative lengths. */
	function buildArcTable(points, samples) {
		samples = samples || 200;
		var table = [0];
		var prev = evalSpline(points, 0);
		for (var i = 1; i <= samples; i++) {
			var cur = evalSpline(points, i / samples);
			var dx = cur[0] - prev[0], dy = cur[1] - prev[1];
			table.push(table[i - 1] + Math.sqrt(dx * dx + dy * dy));
			prev = cur;
		}
		return table;
	}

	/** Remap t by arc length so movement speed is constant. */
	function arcLengthRemap(table, t) {
		var target = t * table[table.length - 1];
		var lo = 0, hi = table.length - 1;
		while (lo < hi) {
			var mid = (lo + hi) >> 1;
			if (table[mid] < target) lo = mid + 1; else hi = mid;
		}
		var samples = table.length - 1;
		if (lo === 0) return 0;
		var prev = table[lo - 1], next = table[lo];
		var frac = next === prev ? 0 : (target - prev) / (next - prev);
		return ((lo - 1) + frac) / samples;
	}

	// ── RPC helpers ───────────────────────────────────────────────────────────

	var _rpcId = 1;
	function rpcSend(iframe, method, params) {
		if (!iframe || !iframe.contentWindow) return;
		try {
			iframe.contentWindow.postMessage({
				jsonrpc: '2.0',
				id: _rpcId++,
				method: method,
				params: params || {}
			}, '*');
		} catch (_) {}
	}

	// ── MotionPath class ──────────────────────────────────────────────────────

	/**
	 * @param {HTMLElement} element  — DOM node to translate (the embed wrapper).
	 * @param {Object}      config   — parsed motion JSON (see docs).
	 * @param {HTMLIFrameElement|null} iframe — avatar iframe for anim sync.
	 */
	function MotionPath(element, config, iframe) {
		this.element  = element;
		this.config   = config;
		this.iframe   = iframe || null;
		this._raf     = null;
		this._startTs = null;
		this._moving  = false;
		this._arcTable = null;

		var raw = config.type === 'preset'
			? (PRESETS[config.preset] ? PRESETS[config.preset]() : PRESETS['patrol']())
			: (config.points || PRESETS['patrol']());

		this._points = raw;
		this._duration = (parseFloat(config.duration) || 4000);
		this._loop = config.loop !== false;
		this._walkAnim = config.walkAnim || 'Walking';
		this._idleAnim = config.idleAnim || (config.idleAnim === undefined ? null : config.idleAnim);
		this._arcTable = buildArcTable(this._points);

		// Grab initial element dimensions before any transform
		this._elW = element.offsetWidth  || 420;
		this._elH = element.offsetHeight || 600;

		// Place element at path start immediately to avoid flash
		this._applyPosition(evalSpline(this._points, 0));
	}

	MotionPath.prototype._applyPosition = function (pt) {
		var vw = window.innerWidth  || document.documentElement.clientWidth;
		var vh = window.innerHeight || document.documentElement.clientHeight;
		var x = pt[0] * vw - this._elW * 0.5;
		var y = pt[1] * vh - this._elH * 0.5;
		this.element.style.left = x + 'px';
		this.element.style.top  = y + 'px';
	};

	MotionPath.prototype._tick = function (ts) {
		if (!this._startTs) this._startTs = ts;
		var elapsed = ts - this._startTs;
		var rawT = elapsed / this._duration;

		if (!this._loop && rawT >= 1) {
			this._applyPosition(evalSpline(this._points, arcLengthRemap(this._arcTable, 1)));
			this._setMoving(false);
			this._raf = null;
			return;
		}

		var t = rawT % 1;
		var remapped = arcLengthRemap(this._arcTable, t);
		var pos = evalSpline(this._points, remapped);

		// Compute velocity to detect movement and direction
		var tPrev = ((rawT - 0.016 / this._duration * 1000) % 1 + 1) % 1;
		var posPrev = evalSpline(this._points, arcLengthRemap(this._arcTable, tPrev));
		var dx = pos[0] - posPrev[0];
		var dy = pos[1] - posPrev[1];
		var speed = Math.sqrt(dx * dx + dy * dy);

		var isMoving = speed > 0.0001;
		this._setMoving(isMoving, dx);
		this._applyPosition(pos);

		var self = this;
		this._raf = requestAnimationFrame(function (ts) { self._tick(ts); });
	};

	MotionPath.prototype._setMoving = function (moving, dx) {
		if (moving === this._moving) return;
		this._moving = moving;
		if (!this.iframe) return;

		if (moving) {
			rpcSend(this.iframe, 'animation.play', { name: this._walkAnim, loop: true });
			// Flip avatar horizontally based on direction
			if (dx !== undefined) {
				rpcSend(this.iframe, 'avatar.setFlipX', { flip: dx < 0 });
			}
		} else {
			// Restore idle — if no idleAnim stored, send a crossfade to a neutral state
			if (this._idleAnim) {
				rpcSend(this.iframe, 'animation.play', { name: this._idleAnim, loop: true });
			} else {
				rpcSend(this.iframe, 'animation.resumeIdle', {});
			}
		}
	};

	MotionPath.prototype.start = function () {
		if (this._raf) return;
		// Switch element to fixed positioning for page-level movement
		this.element.style.position = 'fixed';
		this.element.style.zIndex   = '9990';
		this._startTs = null;
		var self = this;
		this._raf = requestAnimationFrame(function (ts) { self._tick(ts); });
	};

	MotionPath.prototype.stop = function () {
		if (this._raf) {
			cancelAnimationFrame(this._raf);
			this._raf = null;
		}
		this._setMoving(false);
	};

	/** Play once then stop. Useful for studio preview. */
	MotionPath.prototype.preview = function () {
		var orig = this._loop;
		this._loop = false;
		this._startTs = null;
		var self = this;
		this._raf = requestAnimationFrame(function (ts) { self._tick(ts); });
		// Restore loop setting after duration + a bit
		setTimeout(function () {
			self._loop = orig;
		}, this._duration + 200);
	};

	// ── Static helpers ────────────────────────────────────────────────────────

	MotionPath.PRESETS = PRESETS;

	/** Encode config to base64 string safe for URL params. */
	MotionPath.encode = function (config) {
		return btoa(JSON.stringify(config));
	};

	/** Decode base64 string back to config object. */
	MotionPath.decode = function (str) {
		return JSON.parse(atob(str));
	};

	return MotionPath;
}));
