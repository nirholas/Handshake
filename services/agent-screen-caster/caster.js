/**
 * AgentScreenCaster
 * -----------------
 * Wraps a Playwright Chromium session, captures JPEG frames, and pushes them
 * to the three.ws screen-push endpoint so any connected watch-panel or 3D desk
 * can render the agent's live screen.
 *
 * Usage:
 *   const caster = new AgentScreenCaster({ agentId, bearerToken, pushUrl });
 *   await caster.launch();
 *   await caster.navigate('https://pump.fun');
 *   await caster.act('buy', 'Buying the dip', async () => { ... });
 *   caster.startFrameLoop();
 *   // … later …
 *   await caster.close();
 */

import { chromium } from 'playwright';

const DEFAULT_PUSH_URL       = 'https://three.ws/api/agent-screen-push';
const DEFAULT_FRAME_INTERVAL = 400;   // ms between periodic captures
const DEFAULT_JPEG_QUALITY   = 72;
const DEFAULT_VIEWPORT       = { width: 1280, height: 720 };
const ACTIVITY_RETRIES       = 2;     // extra attempts for an activity push
const RETRY_BACKOFF_MS       = 500;   // multiplied by the attempt number

/** 429 and 5xx are worth another attempt; every other status is a verdict. */
export function isRetryableStatus(status) {
	return status === 429 || (status >= 500 && status <= 599);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AgentScreenCaster {
	/**
	 * @param {object} opts
	 * @param {string} opts.agentId          UUID of the agent identity
	 * @param {string} opts.bearerToken      JWT or API key for /api/agent-screen-push
	 * @param {string} [opts.pushUrl]        Override the push endpoint
	 * @param {number} [opts.frameIntervalMs]  Milliseconds between frame captures
	 * @param {number} [opts.jpegQuality]    JPEG quality 1-100
	 */
	constructor({ agentId, bearerToken, pushUrl, frameIntervalMs, jpegQuality } = {}) {
		if (!agentId)     throw new Error('agentId required');
		if (!bearerToken) throw new Error('bearerToken required');

		this.agentId      = agentId;
		this.bearerToken  = bearerToken;
		this.pushUrl      = pushUrl      || DEFAULT_PUSH_URL;
		this.frameMs      = frameIntervalMs ?? DEFAULT_FRAME_INTERVAL;
		this.jpegQuality  = jpegQuality  ?? DEFAULT_JPEG_QUALITY;

		this.browser  = null;
		this.context  = null;
		this.page     = null;
		this._timer   = null;
		this._pushing = false; // guard against overlapping push calls
		this._closing = false; // set by close() so a racing capture stays quiet
	}

	// ── Lifecycle ──────────────────────────────────────────────────────────────

	async launch(headless = true) {
		this._closing = false;
		this.browser = await chromium.launch({
			headless,
			args: [
				'--no-sandbox',
				'--disable-setuid-sandbox',
				'--disable-dev-shm-usage',
				'--disable-gpu',
			],
		});

		this.context = await this.browser.newContext({
			viewport: DEFAULT_VIEWPORT,
			userAgent:
				'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
				'(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
			locale: 'en-US',
			timezoneId: 'America/New_York',
		});

		this.page = await this.context.newPage();

		// Push a frame on every finished navigation so the watcher sees transitions.
		this.page.on('load', () => this._safePushFrame());
	}

	async close() {
		this._closing = true;
		this.stopFrameLoop();
		try { await this.browser?.close(); } catch {}
		this.browser = this.context = this.page = null;
	}

	/**
	 * True once close() has begun. A task whose page call rejects during
	 * teardown is expected shutdown, not a failure worth narrating: callers
	 * check this before pushing an error activity to the agent's public log.
	 */
	get isClosing() {
		return this._closing;
	}

	// ── Navigation & actions ───────────────────────────────────────────────────

	/**
	 * Navigate to a URL. Pushes a frame + activity entry automatically.
	 */
	async navigate(url, { waitUntil = 'domcontentloaded' } = {}) {
		await this.pushActivity([{
			type: 'navigate',
			summary: `Navigating to ${url}`,
			ts: Date.now(),
		}]);
		await this.page.goto(url, { waitUntil });
		await this._safePushFrame();
	}

	/**
	 * Named action wrapper. Runs fn(), then pushes a frame capturing the result.
	 *
	 * @param {string}   type        Action type token (e.g. 'click', 'trade')
	 * @param {string}   summary     Human-readable description shown in watch panel
	 * @param {Function} fn          Async action body
	 */
	async act(type, summary, fn) {
		await this.pushActivity([{ type, summary, ts: Date.now() }]);
		await fn();
		await this._safePushFrame();
	}

	// ── Frame loop ─────────────────────────────────────────────────────────────

	startFrameLoop() {
		if (this._timer) return;
		this._timer = setInterval(() => this._safePushFrame(), this.frameMs);
	}

	stopFrameLoop() {
		if (this._timer) {
			clearInterval(this._timer);
			this._timer = null;
		}
	}

	// ── Push primitives ────────────────────────────────────────────────────────

	/**
	 * Capture the current page as JPEG and POST it to screen-push as a data URL.
	 */
	async pushFrame() {
		if (!this.page || this._closing) return;

		const buf = await this.page.screenshot({
			type:    'jpeg',
			quality: this.jpegQuality,
			fullPage: false,
		});

		// Frames are not retried: a dropped screenshot is worthless a second
		// later, the next capture is already on its way, and a retry backlog
		// would outlive the frame interval it was meant to protect.
		await this._post({
			agentId: this.agentId,
			frame:   { data: `data:image/jpeg;base64,${buf.toString('base64')}`, type: 'screenshot' },
		}, { retries: 0 });
	}

	/**
	 * POST structured activity records to screen-push. Each record becomes a
	 * text-only frame carrying the summary — the API appends it to the agent's
	 * activity log (types outside trade/analysis are coerced to 'activity').
	 *
	 * @param {Array<{ type: string, summary: string, payload?: any, ts?: number }>} actions
	 */
	async pushActivity(actions) {
		for (const a of actions || []) {
			if (!a?.summary) continue;
			// Activity is the semantic record of what the agent did, so unlike a
			// frame it is worth retrying through a rate limit or a server blip.
			await this._post({
				agentId: this.agentId,
				frame:   { activity: String(a.summary), type: a.type },
			}, { retries: ACTIVITY_RETRIES });
		}
	}

	// ── Internals ──────────────────────────────────────────────────────────────

	/** Non-throwing frame push — safe to call from event handlers and timers. */
	async _safePushFrame() {
		if (this._pushing || this._closing) return;
		this._pushing = true;
		try {
			await this.pushFrame();
		} catch (err) {
			// A capture that loses the race with close() is expected teardown,
			// not a failure worth printing on every shutdown.
			if (!this._closing) console.error('[caster] frame push failed:', err?.message || err);
		} finally {
			this._pushing = false;
		}
	}

	/**
	 * POST to the push endpoint, retrying only what a retry can fix.
	 *
	 * A 4xx (bad token, agent not owned, malformed frame) is a permanent answer
	 * and throws immediately. A 429, a 5xx, or a network error is transient, and
	 * a long-running caster that dies on one of those loses the whole session.
	 *
	 * @param {object} body
	 * @param {{ retries?: number }} [opts]
	 */
	async _post(body, { retries = 0 } = {}) {
		let lastErr;
		for (let attempt = 0; attempt <= retries; attempt++) {
			if (attempt > 0) await sleep(RETRY_BACKOFF_MS * attempt);
			try {
				const res = await fetch(this.pushUrl, {
					method:  'POST',
					headers: {
						'Content-Type':  'application/json',
						'Authorization': `Bearer ${this.bearerToken}`,
					},
					body: JSON.stringify(body),
				});

				if (res.ok) return res.json();

				const text = await res.text().catch(() => '');
				const err = new Error(`screen-push ${res.status}: ${text}`);
				err.status = res.status;
				if (!isRetryableStatus(res.status)) throw err;
				lastErr = err;
			} catch (err) {
				if (err?.status && !isRetryableStatus(err.status)) throw err;
				lastErr = err;
			}
		}
		throw lastErr;
	}
}
