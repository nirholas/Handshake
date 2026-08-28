// The viewer: a frame loop that owns the terminal while it runs.
//
// Responsibilities: size the subpixel grid to the terminal, render + encode a
// frame at a fixed cadence, redraw in place, poll the state directory for
// mood changes, and hand the terminal back exactly as it was found (alt
// screen, cursor) on exit or on any signal.

import { EventEmitter } from 'node:events';
import { createFrame, render } from './raster.js';
import { encode, MODES } from './encode.js';
import { MOODS, isMood, poseAt } from './moods.js';
import { defaultStateDir, pollState } from './state.js';

const ESC = '\x1b[';
const DIM = `${ESC}2m`;
const BOLD = `${ESC}1m`;
const RESET = `${ESC}0m`;

/**
 * @typedef {object} ViewerOptions
 * @property {'blocks'|'braille'|'ascii'} [mode]
 * @property {number} [fps]
 * @property {number} [columns]   override terminal width in cells
 * @property {number} [rows]      override terminal height in cells
 * @property {string} [mood]      starting mood
 * @property {number} [yaw]       base yaw in radians, added to the mood's motion
 * @property {number} [zoom]
 * @property {boolean} [altScreen]  default true when stdout is a TTY
 * @property {boolean} [caption]    default true
 * @property {string} [name]
 * @property {string} [stateDir]    default ~/.three-ws/tty-avatar; null disables polling
 * @property {NodeJS.WriteStream} [out]
 */

export class TtyAvatar extends EventEmitter {
	/**
	 * @param {import('./load.js').Mesh} mesh
	 * @param {ViewerOptions} [opts]
	 */
	constructor(mesh, opts = {}) {
		super();
		this.mesh = mesh;
		this.mode = opts.mode && MODES[opts.mode] ? opts.mode : 'blocks';
		this.fps = Math.max(1, Math.min(60, opts.fps || 24));
		this.out = opts.out || process.stdout;
		this.isTTY = Boolean(this.out.isTTY);
		this.columns = opts.columns || null;
		this.rows = opts.rows || null;
		this.baseYaw = opts.yaw || 0;
		this.zoom = opts.zoom || 1;
		this.altScreen = opts.altScreen ?? this.isTTY;
		this.caption = opts.caption ?? true;
		this.name = opts.name || 'avatar';
		this.stateDir = opts.stateDir === null ? null : (opts.stateDir || defaultStateDir());
		this.say = '';
		this.current = { name: isMood(opts.mood) ? opts.mood : 'idle', since: Date.now() };
		this.previous = null;
		this.until = null;
		this.lastStateAt = Date.now();
		this.frames = 0;
		this.timer = null;
		this.poller = null;
		this.frame = null;
		this._onResize = () => { this.frame = null; };
		this._onSignal = () => this.stop().then(() => process.exit(0));
	}

	/** Switch mood with a cross-fade; `ttlMs` returns to idle afterwards. */
	setMood(name, { say, ttlMs } = {}) {
		if (!isMood(name)) throw new Error(`unknown mood "${name}" (one of ${Object.keys(MOODS).join(', ')})`);
		if (name !== this.current.name) {
			this.previous = this.current;
			this.current = { name, since: Date.now() };
		}
		if (say !== undefined) this.say = say;
		this.until = ttlMs ? Date.now() + ttlMs : null;
		this.emit('mood', { mood: name, say: this.say });
	}

	setCaption(text) {
		this.say = text || '';
	}

	/** Cell geometry currently in use. */
	size() {
		const cols = this.columns || this.out.columns || 80;
		const rows = this.rows || this.out.rows || 24;
		const captionRows = this.caption ? 1 : 0;
		const drawRows = Math.max(4, rows - captionRows - (this.altScreen ? 0 : 1));
		const geom = MODES[this.mode];
		return { cols, rows, drawRows, width: cols * geom.sx, height: drawRows * geom.sy };
	}

	/** Render one frame to lines (no terminal writes). */
	renderLines(now = Date.now()) {
		const { width, height } = this.size();
		if (!this.frame || this.frame.width !== width || this.frame.height !== height) {
			this.frame = createFrame(width, height);
		}
		const pose = poseAt(this.current, this.previous, now);
		pose.yaw = (pose.yaw || 0) + this.baseYaw;
		render(this.mesh, this.frame, pose, { zoom: this.zoom });
		const lines = encode(this.frame, { mode: this.mode });
		if (this.caption) lines.push(this.captionLine());
		return lines;
	}

	captionLine() {
		const { cols } = this.size();
		const mood = MOODS[this.current.name]?.label || this.current.name;
		const left = `${BOLD}${this.name}${RESET} ${DIM}· ${mood}${RESET}`;
		const leftLen = this.name.length + 3 + mood.length;
		const say = this.say ? `  ${this.say}` : '';
		const room = Math.max(0, cols - leftLen - 1);
		const shown = say.length > room ? `${say.slice(0, Math.max(0, room - 1))}…` : say;
		return `${left}${DIM}${shown}${RESET}`;
	}

	async tick() {
		const now = Date.now();
		if (this.until && now >= this.until) {
			this.until = null;
			this.setMood('idle', { say: '' });
		}
		const lines = this.renderLines(now);
		const body = lines.join(`${ESC}0K\n`);
		this.out.write(`${ESC}H${body}${ESC}0K${ESC}0J`);
		this.frames++;
		this.emit('frame', this.frames);
	}

	async pollOnce() {
		if (!this.stateDir) return;
		const next = await pollState(this.stateDir, this.lastStateAt);
		if (!next) return;
		this.lastStateAt = next.at;
		if (next.mood) this.setMood(next.mood, { say: next.say ?? '', ttlMs: next.ttlMs ?? undefined });
	}

	/** Start the loop. Resolves when `stop()` is called (or after `frames` frames). */
	start({ frames = Infinity } = {}) {
		if (this.timer) return this.done;
		if (this.altScreen) this.out.write(`${ESC}?1049h`);
		if (this.isTTY) this.out.write(`${ESC}?25l`);
		this.out.write(`${ESC}2J${ESC}H`);
		this.out.on?.('resize', this._onResize);
		process.on('SIGINT', this._onSignal);
		process.on('SIGTERM', this._onSignal);
		this.done = new Promise((resolve) => { this._resolve = resolve; });
		let busy = false;
		this.timer = setInterval(async () => {
			if (busy) return;
			busy = true;
			try {
				await this.tick();
				if (this.frames >= frames) await this.stop();
			} finally { busy = false; }
		}, Math.round(1000 / this.fps));
		if (this.stateDir) this.poller = setInterval(() => this.pollOnce().catch(() => {}), 200);
		return this.done;
	}

	async stop() {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
		if (this.poller) { clearInterval(this.poller); this.poller = null; }
		this.out.off?.('resize', this._onResize);
		process.off('SIGINT', this._onSignal);
		process.off('SIGTERM', this._onSignal);
		if (this.isTTY) this.out.write(`${ESC}?25h`);
		if (this.altScreen) this.out.write(`${ESC}?1049l`);
		else this.out.write('\n');
		this.emit('stop');
		this._resolve?.();
	}
}
