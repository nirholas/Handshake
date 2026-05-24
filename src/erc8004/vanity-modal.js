/**
 * VanityModal — focused mini-modal for picking a Solana vanity prefix.
 *
 * Surfaces:
 *   - Live address preview ("AGNT9k4mPq3X…fT2H") that updates as the user types
 *   - Suggestion chips seeded from the agent name + curated short prefixes
 *   - Difficulty meter with per-tier (Free/Pro) callouts
 *   - Estimated grind time + paid-plan badge for >=5 chars
 *   - Mobile warning when hardwareConcurrency <= 2
 *
 * Returns the chosen prefix via `await openVanityModal({ agentName })`,
 * or `null` if the user dismisses.
 *
 * Persistence is the caller's job (see deploy-button.js).
 */

const FREE_THRESHOLD = 5;
const MAX_LENGTH = 6;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const RATE_PER_CORE = 5000; // empirical lower bound for JS Keypair.generate()
const CURATED_CHIPS = ['AGNT', 'BOT', 'NPC', 'AI', 'GOOD', 'WISE'];

function _b58Encode(bytes) {
	let n = 0n;
	for (const b of bytes) n = (n << 8n) | BigInt(b);
	let s = '';
	while (n > 0n) { s = BASE58_ALPHABET[Number(n % 58n)] + s; n /= 58n; }
	for (const b of bytes) { if (b) break; s = '1' + s; }
	return s;
}

function _esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	})[c]);
}

function _coreCount() {
	if (typeof navigator === 'undefined') return 4;
	return Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 8));
}

function _estimateSeconds(prefixLen) {
	if (prefixLen <= 0) return 0;
	const attempts = Math.pow(58, prefixLen);
	return attempts / (RATE_PER_CORE * _coreCount());
}

function _formatTime(seconds) {
	if (seconds < 1)    return '<1s';
	if (seconds < 60)   return `~${Math.round(seconds)}s`;
	if (seconds < 3600) return `~${Math.round(seconds / 60)}m`;
	if (seconds < 86400) return `~${Math.round(seconds / 3600)}h`;
	return '>1d';
}

/**
 * Random base58 suffix used purely to visualize address length in the modal.
 * The prefix portion is the real user input; the rest is shown grayed-out so
 * the layout previews the final 44-char keypair. Never persisted, never sent
 * to the grinder — see the CSS `.vm-preview .rest` rule and the "Preview"
 * label above the box.
 */
function _previewSuffix(prefix = '') {
	const len = 44 - prefix.length;
	let out = prefix;
	for (let i = 0; i < len; i++) {
		out += BASE58_ALPHABET[Math.floor(Math.random() * BASE58_ALPHABET.length)];
	}
	return out;
}

function _suggestionsFor(agentName) {
	const seeded = [];
	if (agentName) {
		// First 3-4 base58-valid chars of the name, capitalized.
		const cleaned = agentName.replace(/[^1-9A-HJ-NP-Za-km-z]/g, '');
		if (cleaned.length >= 3) seeded.push(cleaned.slice(0, 4));
	}
	const all = [...new Set([...seeded, ...CURATED_CHIPS])].slice(0, 6);
	return all;
}

const STYLE = `
.vm-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 9999; display: flex; align-items: center; justify-content: center; padding: 1rem; }
.vm-modal { background: #fff; border-radius: 12px; max-width: 460px; width: 100%; padding: 1.25rem 1.4rem; box-shadow: 0 20px 60px rgba(0,0,0,.3); font: 14px/1.4 system-ui, sans-serif; color: #111; }
.vm-title { font-size: 1.1rem; font-weight: 600; margin: 0 0 .25rem; }
.vm-sub { color: #666; font-size: .8rem; margin: 0 0 1rem; }
.vm-input { font: inherit; font-family: ui-monospace, monospace; padding: .5rem .65rem; width: 100%; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; text-transform: none; }
.vm-input.invalid { border-color: #c33; background: #fff8f8; }
.vm-preview { font-family: ui-monospace, monospace; font-size: .85rem; padding: .55rem .65rem; background: #f7f7f8; border-radius: 6px; margin-top: .55rem; word-break: break-all; }
.vm-preview .pfx { background: linear-gradient(90deg,#ffd54f,#ff8a65); color: #1a1a1a; padding: 0 2px; border-radius: 2px; font-weight: 600; }
.vm-preview .rest { color: #888; }
.vm-meter { display: flex; gap: 3px; margin-top: .6rem; }
.vm-meter .seg { flex: 1; height: 6px; border-radius: 3px; background: #eee; }
.vm-meter .seg.lit-1, .vm-meter .seg.lit-2, .vm-meter .seg.lit-3, .vm-meter .seg.lit-4 { background: #4caf50; }
.vm-meter .seg.lit-5 { background: #fb8c00; }
.vm-meter .seg.lit-6 { background: #d32f2f; }
.vm-row { display: flex; justify-content: space-between; align-items: center; margin-top: .5rem; font-size: .78rem; color: #666; }
.vm-paid { background: linear-gradient(90deg,#ffd54f,#ff8a65); color: #1a1a1a; font-weight: 600; padding: .1rem .5rem; border-radius: 999px; font-size: .7rem; }
.vm-chips { display: flex; flex-wrap: wrap; gap: .35rem; margin-top: .85rem; }
.vm-chip { background: #f0f0f2; border: 1px solid #ddd; border-radius: 999px; padding: .25rem .65rem; cursor: pointer; font-family: ui-monospace, monospace; font-size: .75rem; color: #333; }
.vm-chip:hover { background: #e6e6e8; }
.vm-chip-est { color: #888; margin-left: .35rem; font-family: system-ui, sans-serif; }
.vm-warn { background: #fff3cd; color: #855008; padding: .5rem .65rem; border-radius: 6px; margin-top: .85rem; font-size: .75rem; }
.vm-actions { display: flex; gap: .5rem; justify-content: flex-end; margin-top: 1.1rem; }
.vm-btn { font: inherit; padding: .45rem .9rem; border-radius: 6px; border: 1px solid #ccc; background: #fff; cursor: pointer; }
.vm-btn.primary { background: #111; color: #fff; border-color: #111; }
.vm-btn:disabled { opacity: .4; cursor: not-allowed; }
.vm-skip { background: none; border: none; color: #666; font-size: .75rem; cursor: pointer; margin-top: .5rem; padding: 0; }
.vm-cli { margin-top: .85rem; padding: .55rem .65rem; background: #f7f7f8; border: 1px solid #eee; border-radius: 6px; font-size: .72rem; color: #555; }
.vm-cli code { background: #fff; padding: .1rem .3rem; border-radius: 3px; border: 1px solid #e0e0e0; font-family: ui-monospace, monospace; }
.vm-cli a { color: #0d47a1; }
.vm-cli .vm-paste-toggle { background: none; border: none; color: #0d47a1; cursor: pointer; padding: 0; font-size: .72rem; text-decoration: underline; }
.vm-paste { margin-top: .55rem; }
.vm-paste textarea { font: inherit; font-family: ui-monospace, monospace; font-size: .7rem; width: 100%; min-height: 70px; box-sizing: border-box; padding: .4rem .5rem; border: 1px solid #ccc; border-radius: 6px; resize: vertical; }
.vm-paste-status { margin-top: .35rem; font-size: .72rem; min-height: 1em; }
.vm-paste-status.ok  { color: #1b5e20; }
.vm-paste-status.bad { color: #b71c1c; }
`;

let _styleInjected = false;
function _injectStyle() {
	if (_styleInjected || typeof document === 'undefined') return;
	const tag = document.createElement('style');
	tag.id = 'vanity-modal-style';
	tag.textContent = STYLE;
	document.head.appendChild(tag);
	_styleInjected = true;
}

/**
 * Open the vanity prefix picker.
 *
 * @param {object} opts
 * @param {string} [opts.agentName]  Used to seed suggestion chips.
 * @param {string} [opts.initial]    Pre-fill (e.g. from localStorage).
 * @returns {Promise<string | { prefix: string, secretKey: Uint8Array } | null>}
 *   - `null`  → user dismissed
 *   - `''`    → user chose "skip"
 *   - `string` → prefix to grind in the browser
 *   - `{ prefix, secretKey }` → pre-ground keypair from a CLI tool
 *      (e.g. nirholas/solana-wallet-toolkit); skip the in-browser grinder.
 */
export function openVanityModal({ agentName = '', initial = '' } = {}) {
	_injectStyle();

	return new Promise((resolve) => {
		const overlay = document.createElement('div');
		overlay.className = 'vm-overlay';
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		overlay.setAttribute('aria-labelledby', 'vm-title');

		const suggestions = _suggestionsFor(agentName);
		const isMobile = _coreCount() <= 2;
		overlay.innerHTML = `
			<div class="vm-modal">
				<h2 class="vm-title" id="vm-title">Customize your agent's address</h2>
				<p class="vm-sub">Pick characters your agent's Solana address should start with.</p>

				<label for="vm-input" style="font-size:.8rem;color:#444;">Prefix (Base58, max ${MAX_LENGTH})</label>
				<input id="vm-input" class="vm-input" type="text" maxlength="${MAX_LENGTH}"
					placeholder="e.g. AGNT" autocomplete="off" spellcheck="false"
					value="${_esc(initial)}" />

				<div class="vm-preview-label" style="font-size:.7rem;color:#888;margin-top:.7rem;text-transform:uppercase;letter-spacing:.06em;">Preview — random suffix shown for layout only</div>
				<div class="vm-preview" aria-live="polite" id="vm-preview"></div>

				<div class="vm-meter" aria-hidden="true">
					${[1, 2, 3, 4, 5, 6].map((i) => `<div class="seg" data-seg="${i}"></div>`).join('')}
				</div>

				<div class="vm-row">
					<span id="vm-est">enter a prefix above</span>
					<span id="vm-tier"></span>
				</div>

				<div class="vm-chips" aria-label="Suggested prefixes">
					${suggestions.map((s) => `
						<button class="vm-chip" data-prefix="${_esc(s)}" type="button">
							${_esc(s)}<span class="vm-chip-est">${_formatTime(_estimateSeconds(s.length))}</span>
						</button>`).join('')}
				</div>

				${isMobile ? `<div class="vm-warn">⚠️ Vanity addresses work best on desktop — your device has limited CPU cores.</div>` : ''}

				<div class="vm-cli">
					Got a long prefix? Grind offline with
					<a href="https://github.com/nirholas/solana-wallet-toolkit" target="_blank" rel="noopener">solana-wallet-toolkit</a>
					(50–100k keys/s/core), then
					<button class="vm-paste-toggle" id="vm-paste-toggle" type="button">paste the keypair JSON</button>.
					<div class="vm-paste" id="vm-paste" hidden>
						<textarea id="vm-paste-input" placeholder="[12, 34, 56, ... ] — solana-keygen JSON, 64 bytes"></textarea>
						<div class="vm-paste-status" id="vm-paste-status"></div>
					</div>
				</div>

				<div class="vm-actions">
					<button class="vm-btn" id="vm-cancel" type="button">Cancel</button>
					<button class="vm-btn primary" id="vm-ok" type="button" disabled>Use prefix</button>
				</div>
				<button class="vm-skip" id="vm-skip" type="button">Skip — use a random address</button>
			</div>
		`;
		document.body.appendChild(overlay);

		const input    = overlay.querySelector('#vm-input');
		const preview  = overlay.querySelector('#vm-preview');
		const meter    = overlay.querySelectorAll('.vm-meter .seg');
		const estEl    = overlay.querySelector('#vm-est');
		const tierEl   = overlay.querySelector('#vm-tier');
		const okBtn    = overlay.querySelector('#vm-ok');
		const pasteToggle = overlay.querySelector('#vm-paste-toggle');
		const pastePanel  = overlay.querySelector('#vm-paste');
		const pasteInput  = overlay.querySelector('#vm-paste-input');
		const pasteStatus = overlay.querySelector('#vm-paste-status');

		/** @type {{ secretKey: Uint8Array, publicKey: string } | null} */
		let pasteResult = null;

		pasteToggle.addEventListener('click', () => {
			const open = pastePanel.hasAttribute('hidden');
			pastePanel.toggleAttribute('hidden', !open);
			if (open) pasteInput.focus();
		});

		pasteInput.addEventListener('input', async () => {
			pasteResult = null;
			const raw = pasteInput.value.trim();
			if (!raw) {
				pasteStatus.textContent = '';
				pasteStatus.className = 'vm-paste-status';
				update();
				return;
			}
			let bytes;
			try {
				const arr = JSON.parse(raw);
				if (!Array.isArray(arr) || arr.length !== 64) throw new Error('expected a 64-element JSON array');
				if (!arr.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) throw new Error('values must be 0–255');
				bytes = new Uint8Array(arr);
			} catch (e) {
				pasteStatus.textContent = `invalid: ${e.message}`;
				pasteStatus.className = 'vm-paste-status bad';
				update();
				return;
			}
			try {
				// Solana secretKey = seed(32) + pubkey(32). Read the pubkey from
				// bytes 32–63 and base58-encode it — no @solana/web3.js needed.
				const pub = bytes.slice(32, 64);
				const pubkey = _b58Encode(pub);
				const wantedPrefix = input.value.trim();
				if (wantedPrefix && !pubkey.startsWith(wantedPrefix)) {
					pasteStatus.textContent = `address ${pubkey.slice(0, 8)}… does not start with "${wantedPrefix}"`;
					pasteStatus.className = 'vm-paste-status bad';
					update();
					return;
				}
				pasteResult = { secretKey: bytes, publicKey: pubkey };
				pasteStatus.textContent = `✓ ${pubkey.slice(0, 12)}… ready`;
				pasteStatus.className = 'vm-paste-status ok';
			} catch (e) {
				pasteStatus.textContent = `invalid keypair: ${e.message || e}`;
				pasteStatus.className = 'vm-paste-status bad';
			}
			update();
		});

		let previewTimer = null;
		function update() {
			const raw = input.value;
			const valid = !raw || BASE58_RE.test(raw);
			input.classList.toggle('invalid', !valid);

			meter.forEach((seg, idx) => {
				seg.className = 'seg' + (raw.length > idx ? ` lit-${raw.length}` : '');
			});

			if (pasteResult) {
				preview.innerHTML = `<span class="pfx">${_esc(pasteResult.publicKey.slice(0, raw.length || 0))}</span><span class="rest">${_esc(pasteResult.publicKey.slice(raw.length || 0))}</span>`;
				estEl.textContent = `pre-ground (no browser grind)`;
				tierEl.innerHTML = `<span style="color:#1b5e20;font-weight:600">CLI</span>`;
				okBtn.disabled = false;
				okBtn.textContent = 'Use pre-ground keypair';
				return;
			}
			okBtn.textContent = 'Use prefix';

			if (!raw) {
				preview.innerHTML = '<span class="rest">' + _esc(_previewSuffix()) + '</span>';
				estEl.textContent = 'enter a prefix above';
				tierEl.innerHTML = '';
				okBtn.disabled = true;
				return;
			}
			if (!valid) {
				preview.textContent = 'invalid Base58 — avoid 0, O, I, l';
				estEl.textContent = '';
				tierEl.innerHTML = '';
				okBtn.disabled = true;
				return;
			}
			const sample = _previewSuffix(raw);
			preview.innerHTML = `<span class="pfx">${_esc(raw)}</span><span class="rest">${_esc(sample.slice(raw.length))}</span>`;
			estEl.textContent = `est. ${_formatTime(_estimateSeconds(raw.length))} on ${_coreCount()} cores`;
			tierEl.innerHTML = raw.length >= FREE_THRESHOLD
				? `<span class="vm-paid">✦ Paid plan</span>`
				: `<span style="color:#1b5e20;font-weight:600">Free</span>`;
			okBtn.disabled = false;
		}

		// Animate the preview's tail every 600ms so it feels alive — only when prefix is set.
		function startPreviewLoop() {
			stopPreviewLoop();
			previewTimer = setInterval(() => {
				const raw = input.value;
				if (raw && BASE58_RE.test(raw)) {
					const sample = _previewSuffix(raw);
					const pfxNode = preview.querySelector('.pfx');
					const restNode = preview.querySelector('.rest');
					if (pfxNode && restNode) restNode.textContent = sample.slice(raw.length);
				}
			}, 600);
		}
		function stopPreviewLoop() {
			if (previewTimer) clearInterval(previewTimer);
			previewTimer = null;
		}

		input.addEventListener('input', update);
		overlay.querySelectorAll('.vm-chip').forEach((c) => {
			c.addEventListener('click', () => {
				input.value = c.dataset.prefix;
				update();
				input.focus();
			});
		});

		function close(value) {
			stopPreviewLoop();
			overlay.remove();
			document.removeEventListener('keydown', onKey);
			resolve(value);
		}
		function resolveValue() {
			const prefix = input.value.trim();
			if (pasteResult) return { prefix, secretKey: pasteResult.secretKey };
			return prefix;
		}
		function onKey(e) {
			if (e.key === 'Escape') close(null);
			if (e.key === 'Enter' && !okBtn.disabled && document.activeElement !== pasteInput) close(resolveValue());
		}
		overlay.querySelector('#vm-cancel').addEventListener('click', () => close(null));
		overlay.querySelector('#vm-skip').addEventListener('click', () => close(''));
		overlay.querySelector('#vm-ok').addEventListener('click', () => close(resolveValue()));
		overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
		document.addEventListener('keydown', onKey);

		update();
		startPreviewLoop();
		setTimeout(() => input.focus(), 50);
	});
}
