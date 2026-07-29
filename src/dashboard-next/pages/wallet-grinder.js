// dashboard-next — Wallet Grinder.
//
// In-dashboard vanity wallet generator for two chains:
//   • Solana — grind a Base58 keypair whose address starts/ends with chosen text.
//   • EVM    — grind a secp256k1 keypair whose 0x address matches a hex pattern
//              (Ethereum, Base, Polygon, and every other EVM chain share the
//              same address space, so one key works everywhere).
//
// Everything runs in the browser via a pool of Web Workers. The private keys
// are generated locally and never touch the network — there is no API call in
// this page that carries key material. The CREATE2 *contract* address grinder
// is a different tool (it produces a salt, not a key) and is linked out.

import { mountShell } from '../shell.js';
import { requireUser, esc } from '../api.js';
import bs58 from 'bs58';

import { grindVanity } from '../../solana/vanity/grinder.js';
import {
	validatePattern as validateSol,
	estimateAttempts as estimateSol,
	BASE58_ALPHABET,
	MAX_PATTERN_LENGTH as SOL_MAX,
} from '../../solana/vanity/validation.js';

import {
	grindEoaVanity,
	validatePattern as validateEvm,
	estimateAttempts as estimateEvm,
	letterCount as evmLetterCount,
} from '../../eth/vanity/eoa-grinder.js';
import { MAX_PATTERN_LENGTH as EVM_MAX } from '../../eth/vanity/validation.js';
import { toast } from '../../shared/toast.js';

const MONO = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;
const HW = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;

// ── Chain definitions ────────────────────────────────────────────────────────

const CHAINS = {
	solana: {
		key: 'solana',
		label: 'Solana',
		glyph: '◎',
		blurb: 'A Solana keypair whose Base58 address matches your pattern.',
		alphabet: BASE58_ALPHABET,
		alphabetHint: 'Base58 — case-sensitive. Excludes 0 (zero), O, I, l.',
		maxLen: SOL_MAX,
		sample: 'So11111111111111111111111111111111111111112',
		caseOption: false,
		keyLabel: 'Secret key',
		// Solana addresses are intrinsically case-sensitive: every position is
		// 1-in-58, so the difficulty model is uniform.
		validate: (p) => {
			const v = validateSol(p);
			return { valid: v.valid, errors: v.errors, normalized: p };
		},
		expected: (prefix, suffix) => estimateSol((prefix?.length || 0) + (suffix?.length || 0)),
		run: (opts) => grindVanity(opts),
		shape: (r) => {
			const secretArray = Array.from(r.secretKey);
			return {
				address: r.publicKey,
				addressDisplay: r.publicKey,
				secret: bs58.encode(r.secretKey),
				secretLabel: 'Secret key (Base58 — import into Phantom/Solflare)',
				attempts: r.attempts,
				durationMs: r.durationMs,
				workers: r.workers,
				download: {
					filename: `vanity-${r.publicKey.slice(0, 8)}.json`,
					mime: 'application/json',
					body: JSON.stringify(secretArray),
					hint: 'Solana CLI keypair format (64-byte array)',
				},
			};
		},
	},
	evm: {
		key: 'evm',
		label: 'EVM',
		glyph: 'Ξ',
		blurb: 'A secp256k1 keypair for Ethereum, Base, Polygon, and every EVM chain.',
		alphabet: '0123456789abcdefABCDEF',
		alphabetHint: 'Hex — 0-9, a-f. Add uppercase for an EIP-55 checksum match (slower).',
		maxLen: EVM_MAX,
		sample: '0x0000000000000000000000000000000000000000',
		caseOption: false, // casing is inferred from the pattern itself
		keyLabel: 'Private key',
		validate: (p) => {
			const v = validateEvm(p);
			return { valid: v.valid, errors: v.errors, normalized: v.normalized, caseSensitive: v.caseSensitive };
		},
		expected: (prefix, suffix) => {
			const all = (prefix || '') + (suffix || '');
			const caseSensitive = /[A-F]/.test(all);
			return estimateEvm((prefix?.length || 0) + (suffix?.length || 0), evmLetterCount(all), caseSensitive);
		},
		run: (opts) => grindEoaVanity(opts),
		shape: (r) => ({
			address: r.address,
			addressDisplay: r.addressChecksum || r.address,
			secret: r.privateKey,
			secretLabel: 'Private key (import into MetaMask / Rabbit / any EVM wallet)',
			attempts: r.attempts,
			durationMs: r.durationMs,
			workers: r.workers,
			download: {
				filename: `vanity-${(r.addressChecksum || r.address).slice(0, 10)}.json`,
				mime: 'application/json',
				body: JSON.stringify({ address: r.addressChecksum || r.address, privateKey: r.privateKey }, null, 2),
				hint: 'JSON { address, privateKey }',
			},
		}),
	},
};

// ── Per-tab grind state ──────────────────────────────────────────────────────

const state = {
	solana: freshTab(),
	evm: freshTab(),
};
let active = 'solana';

function freshTab() {
	return { prefix: '', suffix: '', workers: Math.min(HW, 8), running: false, paused: false, controller: null, abort: null, result: null, progress: null };
}

// ── Boot ─────────────────────────────────────────────────────────────────────

(async function boot() {
	const main = await mountShell();
	await requireUser();
	injectStyles();

	main.innerHTML = `
		<h1 class="dn-h1">Wallet Grinder</h1>
		<p class="dn-h1-sub">Generate a vanity wallet whose address starts or ends with text you choose. Runs entirely in your browser — keys never leave this device.</p>

		<div class="wg-tabs" role="tablist" aria-label="Chain">
			${Object.values(CHAINS).map((c) => `
				<button class="wg-tab${c.key === active ? ' active' : ''}" role="tab" id="wg-tab-${c.key}"
					aria-selected="${c.key === active}" aria-controls="wg-tabpanel" tabindex="${c.key === active ? '0' : '-1'}" data-tab="${c.key}">
					<span class="wg-glyph" aria-hidden="true">${c.glyph}</span> ${esc(c.label)}
				</button>
			`).join('')}
		</div>

		<div data-slot="tab" id="wg-tabpanel" role="tabpanel" aria-labelledby="wg-tab-${active}" tabindex="0"></div>

		<div class="dn-panel wg-create2">
			<div class="dn-panel-title">Grinding a contract address instead?</div>
			<div class="dn-panel-sub" style="margin:4px 0 12px">The CREATE2 grinder mines a deployment salt for a deterministic Ethereum <em>contract</em> address — no private key involved.</div>
			<a class="dn-btn" href="/eth-vanity" target="_blank" rel="noopener">Open CREATE2 grinder ↗</a>
		</div>
	`;

	const tabHost = main.querySelector('[data-slot="tab"]');
	const tabBtns = Array.from(main.querySelectorAll('[data-tab]'));
	renderTab(tabHost);

	function selectTab(key, { focus = false } = {}) {
		if (key === active) return;
		active = key;
		tabBtns.forEach((b) => {
			const on = b.dataset.tab === active;
			b.classList.toggle('active', on);
			b.setAttribute('aria-selected', String(on));
			b.tabIndex = on ? 0 : -1;
			if (on && focus) b.focus();
		});
		tabHost.setAttribute('aria-labelledby', `wg-tab-${active}`);
		renderTab(tabHost);
	}

	tabBtns.forEach((btn) => {
		btn.addEventListener('click', () => selectTab(btn.dataset.tab));
	});

	// Roving-tabindex keyboard nav for the WAI-ARIA tablist pattern.
	main.querySelector('.wg-tabs').addEventListener('keydown', (e) => {
		const idx = tabBtns.findIndex((b) => b.dataset.tab === active);
		if (idx < 0) return;
		let next = null;
		if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % tabBtns.length;
		else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + tabBtns.length) % tabBtns.length;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = tabBtns.length - 1;
		if (next === null) return;
		e.preventDefault();
		selectTab(tabBtns[next].dataset.tab, { focus: true });
	});
})();

// ── Tab render ───────────────────────────────────────────────────────────────

function renderTab(host) {
	const chain = CHAINS[active];
	const t = state[active];

	host.innerHTML = `
		<div class="dn-panel">
			<div class="dn-panel-title">${esc(chain.label)} vanity wallet</div>
			<div class="dn-panel-sub" style="margin:4px 0 16px">${esc(chain.blurb)}</div>

			<div class="wg-grid">
				<label class="wg-field">
					<span class="wg-label">Starts with (prefix)</span>
					<input class="wg-input" data-field="prefix" type="text" inputmode="latin" autocomplete="off" spellcheck="false"
						maxlength="${chain.maxLen}" placeholder="e.g. ${active === 'solana' ? 'AGNT' : 'dead'}" value="${esc(t.prefix)}" />
				</label>
				<label class="wg-field">
					<span class="wg-label">Ends with (suffix)</span>
					<input class="wg-input" data-field="suffix" type="text" inputmode="latin" autocomplete="off" spellcheck="false"
						maxlength="${chain.maxLen}" placeholder="optional" value="${esc(t.suffix)}" />
				</label>
			</div>
			<div class="wg-hint">${esc(chain.alphabetHint)}</div>

			<div class="wg-preview" data-slot="preview"></div>
			<div class="wg-difficulty" data-slot="difficulty"></div>

			<label class="wg-field" style="margin-top:16px">
				<span class="wg-label">CPU cores <span class="wg-cores" data-slot="cores-val">${t.workers}</span> / ${HW}</span>
				<input class="wg-range" data-field="workers" type="range" min="1" max="${HW}" value="${t.workers}" />
			</label>

			<div class="wg-actions" data-slot="actions"></div>
			<div data-slot="progress"></div>
		</div>

		<div data-slot="result"></div>

		<div class="dn-panel wg-safety">
			<div class="dn-panel-title">🔒 Key safety</div>
			<ul class="wg-safety-list">
				<li>Keys are generated locally in your browser and are <strong>never sent to any server</strong>.</li>
				<li>Anyone with the ${active === 'solana' ? 'secret key' : 'private key'} controls the wallet. Store it in a password manager or hardware wallet.</li>
				<li>Close this tab after saving — the key is not persisted anywhere on this site.</li>
				<li>Longer patterns are exponentially slower. ${active === 'solana' ? 'Each Base58 character is 1-in-58.' : 'Each hex character is 1-in-16 (1-in-32 if uppercase).'}</li>
			</ul>
		</div>
	`;

	const fields = {
		prefix: host.querySelector('[data-field="prefix"]'),
		suffix: host.querySelector('[data-field="suffix"]'),
		workers: host.querySelector('[data-field="workers"]'),
	};

	const refresh = () => {
		updatePreview(host, chain, t);
		updateDifficulty(host, chain, t);
		renderActions(host, chain, t, refresh);
	};

	fields.prefix.addEventListener('input', () => {
		t.prefix = sanitize(fields.prefix.value, chain);
		if (fields.prefix.value !== t.prefix) fields.prefix.value = t.prefix;
		refresh();
	});
	fields.suffix.addEventListener('input', () => {
		t.suffix = sanitize(fields.suffix.value, chain);
		if (fields.suffix.value !== t.suffix) fields.suffix.value = t.suffix;
		refresh();
	});
	fields.workers.addEventListener('input', () => {
		t.workers = Number(fields.workers.value);
		host.querySelector('[data-slot="cores-val"]').textContent = t.workers;
	});

	refresh();
	if (t.result) renderResult(host, chain, t.result);
	if (t.running && t.progress) renderProgress(host, t.progress);
}

// ── Input sanitizing & validation ────────────────────────────────────────────

function sanitize(value, chain) {
	let v = value;
	if (chain.key === 'evm' && (v.startsWith('0x') || v.startsWith('0X'))) v = v.slice(2);
	const allowed = new Set(chain.alphabet);
	v = Array.from(v).filter((c) => allowed.has(c)).join('');
	return v.slice(0, chain.maxLen);
}

function validity(chain, t) {
	const errs = [];
	if (t.prefix) {
		const v = chain.validate(t.prefix);
		if (!v.valid) errs.push(...v.errors);
	}
	if (t.suffix) {
		const v = chain.validate(t.suffix);
		if (!v.valid) errs.push(...v.errors);
	}
	const hasPattern = !!(t.prefix || t.suffix);
	return { ok: hasPattern && errs.length === 0, hasPattern, errors: errs };
}

// ── Preview ──────────────────────────────────────────────────────────────────

function updatePreview(host, chain, t) {
	const el = host.querySelector('[data-slot="preview"]');
	const addr = chain.sample;
	const pfx = t.prefix;
	const sfx = t.suffix;

	if (!pfx && !sfx) {
		el.innerHTML = `<span class="wg-faded">${esc(addr)}</span>`;
		return;
	}

	// Build a synthetic preview: prefix + filler + suffix, fit to sample length.
	const base = chain.key === 'evm' ? addr.slice(2) : addr;
	const lead = chain.key === 'evm' ? '0x' : '';
	const fillLen = Math.max(0, base.length - pfx.length - sfx.length);
	const filler = base.slice(pfx.length, pfx.length + fillLen);
	el.innerHTML =
		`${lead}` +
		(pfx ? `<span class="wg-match">${esc(pfx)}</span>` : '') +
		`<span class="wg-faded">${esc(filler)}</span>` +
		(sfx ? `<span class="wg-match">${esc(sfx)}</span>` : '');
}

// ── Difficulty estimate ──────────────────────────────────────────────────────

function updateDifficulty(host, chain, t) {
	const el = host.querySelector('[data-slot="difficulty"]');
	const v = validity(chain, t);

	if (v.errors.length) {
		el.innerHTML = `<span class="wg-err">⚠ ${esc(v.errors[0])}</span>`;
		return;
	}
	if (!v.hasPattern) {
		el.innerHTML = `<span class="wg-faded-sm">Enter a prefix or suffix to begin.</span>`;
		return;
	}

	const expected = chain.expected(t.prefix, t.suffix);
	const caseNote = chain.key === 'evm' && /[A-F]/.test(t.prefix + t.suffix)
		? ' · checksum (case-sensitive) match'
		: '';
	el.innerHTML = `
		<span class="wg-tag-diff">1 in ${fmtBig(expected)}</span>
		<span class="wg-faded-sm">expected attempts${esc(caseNote)}. Time depends on your CPU — start to see a live rate.</span>
	`;
}

// ── Actions (start / pause / stop) ───────────────────────────────────────────

function renderActions(host, chain, t, refresh) {
	const el = host.querySelector('[data-slot="actions"]');
	const v = validity(chain, t);

	if (!t.running) {
		el.innerHTML = `<button class="dn-btn primary" data-act="start" ${v.ok ? '' : 'disabled'}>Start grinding</button>`;
		el.querySelector('[data-act="start"]').addEventListener('click', () => startGrind(host, chain, t, refresh));
		return;
	}

	el.innerHTML = `
		<button class="dn-btn" data-act="pause">${t.paused ? 'Resume' : 'Pause'}</button>
		<button class="dn-btn danger" data-act="stop">Stop</button>
	`;
	el.querySelector('[data-act="pause"]').addEventListener('click', () => {
		if (!t.controller) return;
		if (t.paused) { t.controller.resume(); t.paused = false; }
		else { t.controller.pause(); t.paused = true; }
		refresh();
	});
	el.querySelector('[data-act="stop"]').addEventListener('click', () => {
		t.abort?.abort();
	});
}

async function startGrind(host, chain, t, refresh) {
	t.running = true;
	t.paused = false;
	t.result = null;
	t.progress = { attempts: 0, rate: 0, eta: 'estimating…', sample: '' };
	t.controller = {};
	t.abort = new AbortController();

	host.querySelector('[data-slot="result"]').innerHTML = '';
	refresh();
	renderProgress(host, t.progress);

	try {
		const result = await chain.run({
			prefix: t.prefix || undefined,
			suffix: t.suffix || undefined,
			maxWorkers: t.workers,
			controller: t.controller,
			signal: t.abort.signal,
			onProgress: (p) => {
				t.progress = p;
				if (t.running) renderProgress(host, p);
			},
		});
		t.result = chain.shape(result);
		t.running = false;
		t.paused = false;
		// Clear the live progress bar — the result panel below carries the final
		// attempts / duration / core count, so a still-animating bar would read as
		// "still working" when the match is already found.
		host.querySelector('[data-slot="progress"]').innerHTML = '';
		refresh();
		renderResult(host, chain, t.result);
		toast('Match found ✦');
	} catch (err) {
		t.running = false;
		t.paused = false;
		refresh();
		const prog = host.querySelector('[data-slot="progress"]');
		if (err?.name === 'AbortError') {
			prog.innerHTML = `<div class="wg-stopped">Stopped after ${fmtNum(t.progress?.attempts || 0)} attempts.</div>`;
		} else {
			prog.innerHTML = `<div class="wg-err-box">⚠ ${esc(err?.message || 'Grind failed')}</div>`;
		}
	}
}

// ── Progress ─────────────────────────────────────────────────────────────────

function renderProgress(host, p) {
	const el = host.querySelector('[data-slot="progress"]');
	if (!el) return;
	const rate = p.rate ? `${fmtNum(Math.round(p.rate))}/s` : (p.paused ? 'paused' : '—');

	// Build the structure once, then update text/paused state in place. Rebuilding
	// innerHTML on every progress tick restarts the CSS keyframe on the moving bar
	// (visible jitter) and thrashes layout — this keeps it buttery smooth.
	let box = el.querySelector('.wg-progress');
	if (!box) {
		el.innerHTML = `
			<div class="wg-progress">
				<div class="wg-progress-bar"><div class="wg-progress-fill"></div></div>
				<div class="wg-progress-stats" role="status" aria-live="polite" aria-label="Grind progress">
					<div><span class="wg-stat" data-p="attempts">0</span><span class="wg-stat-label">attempts</span></div>
					<div><span class="wg-stat" data-p="rate">—</span><span class="wg-stat-label">rate</span></div>
					<div><span class="wg-stat" data-p="eta">—</span><span class="wg-stat-label">est. remaining</span></div>
				</div>
				<div class="wg-sample" data-p="sample" hidden></div>
			</div>
		`;
		box = el.querySelector('.wg-progress');
	}

	box.querySelector('.wg-progress-fill').classList.toggle('paused', !!p.paused);
	box.querySelector('[data-p="attempts"]').textContent = fmtNum(p.attempts || 0);
	box.querySelector('[data-p="rate"]').textContent = rate;
	box.querySelector('[data-p="eta"]').textContent = p.eta || '—';
	const sampleEl = box.querySelector('[data-p="sample"]');
	if (p.sample) { sampleEl.hidden = false; sampleEl.textContent = `trying ${p.sample}`; }
	else { sampleEl.hidden = true; sampleEl.textContent = ''; }
}

// ── Result ───────────────────────────────────────────────────────────────────

function renderResult(host, chain, r) {
	const el = host.querySelector('[data-slot="result"]');
	const pfx = state[active].prefix;
	const sfx = state[active].suffix;
	el.innerHTML = `
		<div class="dn-panel wg-result">
			<div class="wg-result-head">
				<span class="dn-tag success">Match found</span>
				<span class="wg-faded-sm">${fmtNum(r.attempts)} attempts · ${(r.durationMs / 1000).toFixed(1)}s · ${r.workers} core${r.workers > 1 ? 's' : ''}</span>
			</div>

			<div class="wg-result-label">Address</div>
			<div class="wg-addr">${highlightAddr(r.addressDisplay, pfx, sfx)}</div>
			<button class="dn-btn" data-act="copy-addr" style="margin-top:8px">Copy address</button>

			<div class="wg-result-label" style="margin-top:18px" id="wg-secret-label">${esc(r.secretLabel)}</div>
			<div class="wg-secret-wrap">
				<div class="wg-secret" data-slot="secret" role="textbox" aria-readonly="true" aria-labelledby="wg-secret-label" aria-label="Secret hidden — use Reveal to show">${'•'.repeat(44)}</div>
				<div class="wg-secret-actions">
					<button class="dn-btn" data-act="reveal" aria-pressed="false" aria-controls="wg-secret-label">Reveal</button>
					<button class="dn-btn" data-act="copy-secret">Copy</button>
					<button class="dn-btn primary" data-act="download">Download</button>
				</div>
			</div>
			<div class="wg-faded-sm" style="margin-top:8px">${esc(r.download.hint)} · keep this secret offline.</div>
		</div>
	`;

	let revealed = false;
	const secretEl = el.querySelector('[data-slot="secret"]');
	el.querySelector('[data-act="reveal"]').addEventListener('click', (e) => {
		revealed = !revealed;
		secretEl.textContent = revealed ? r.secret : '•'.repeat(44);
		secretEl.classList.toggle('shown', revealed);
		secretEl.setAttribute('aria-label', revealed ? 'Secret key revealed' : 'Secret hidden — use Reveal to show');
		e.currentTarget.textContent = revealed ? 'Hide' : 'Reveal';
		e.currentTarget.setAttribute('aria-pressed', String(revealed));
	});
	el.querySelector('[data-act="copy-addr"]').addEventListener('click', () => copy(r.addressDisplay, 'Address copied'));
	el.querySelector('[data-act="copy-secret"]').addEventListener('click', () => copy(r.secret, `${chain.keyLabel} copied`));
	el.querySelector('[data-act="download"]').addEventListener('click', () => download(r.download));
}

function highlightAddr(addr, pfx, sfx) {
	const lead = addr.startsWith('0x') ? '0x' : '';
	const body = lead ? addr.slice(2) : addr;
	let head = 0;
	if (pfx && body.toLowerCase().startsWith(pfx.toLowerCase())) head = pfx.length;
	let tail = 0;
	if (sfx && body.toLowerCase().endsWith(sfx.toLowerCase())) tail = sfx.length;
	const start = body.slice(0, head);
	const mid = body.slice(head, body.length - tail);
	const end = tail ? body.slice(body.length - tail) : '';
	return `${lead}` +
		(start ? `<span class="wg-match">${esc(start)}</span>` : '') +
		`${esc(mid)}` +
		(end ? `<span class="wg-match">${esc(end)}</span>` : '');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function download({ filename, mime, body }) {
	const blob = new Blob([body], { type: mime });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	a.remove();
	URL.revokeObjectURL(url);
	toast('Keypair downloaded');
}

async function copy(text, msg) {
	try {
		await navigator.clipboard.writeText(text);
		toast(msg);
	} catch {
		toast('Copy failed — select manually');
	}
}

function fmtNum(n) {
	return Number(n || 0).toLocaleString('en-US');
}

function fmtBig(n) {
	if (!Number.isFinite(n)) return '∞';
	if (n >= 1e12) return (n / 1e12).toFixed(1).replace(/\.0$/, '') + ' trillion';
	if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + ' billion';
	if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + ' million';
	if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
	return String(Math.round(n));
}


// ── Styles ───────────────────────────────────────────────────────────────────

function injectStyles() {
	if (document.getElementById('wg-css')) return;
	const css = document.createElement('style');
	css.id = 'wg-css';
	css.textContent = `
		.wg-tabs { display:flex; gap:8px; margin:18px 0; }
		.wg-tab { display:inline-flex; align-items:center; gap:7px; padding:8px 16px; font-size:13.5px;
			border:1px solid var(--nxt-stroke); background:rgba(255,255,255,0.02); color:var(--nxt-ink-dim);
			border-radius:999px; cursor:pointer; transition:all .16s; font-family:inherit; }
		.wg-tab:hover { color:var(--nxt-ink); border-color:var(--nxt-stroke-strong); }
		.wg-tab:active { transform:translateY(1px); }
		.wg-tab.active { background:var(--nxt-accent); color:#000; border-color:var(--nxt-accent); font-weight:600; }
		.wg-tab:focus-visible { outline:none; box-shadow:0 0 0 3px var(--nxt-accent-soft); }
		#wg-tabpanel:focus-visible { outline:none; }
		.wg-glyph { font-size:15px; }

		.wg-grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
		@media (max-width:600px) { .wg-grid { grid-template-columns:1fr; } }
		.wg-field { display:flex; flex-direction:column; gap:6px; }
		.wg-label { font-size:12px; color:var(--nxt-ink-fade); }
		.wg-cores { color:var(--nxt-ink); font-variant-numeric:tabular-nums; }
		.wg-input { font-family:${MONO}; font-size:14px; padding:10px 12px; border-radius:var(--nxt-radius-sm);
			background:rgba(255,255,255,0.03); border:1px solid var(--nxt-stroke); color:var(--nxt-ink);
			transition:border-color .16s; }
		.wg-input:focus { outline:none; border-color:var(--nxt-stroke-strong); background:rgba(255,255,255,0.05); }
		.wg-input::placeholder { color:var(--nxt-ink-fade); }
		.wg-range { width:100%; accent-color:var(--nxt-accent); cursor:pointer; }
		.wg-hint { font-size:12px; color:var(--nxt-ink-fade); margin-top:8px; }

		.wg-preview { font-family:${MONO}; font-size:14px; padding:12px 14px; margin-top:14px;
			background:rgba(0,0,0,0.35); border:1px solid var(--nxt-stroke); border-radius:var(--nxt-radius-sm);
			word-break:break-all; line-height:1.5; min-height:1.5em; }
		.wg-match { background:var(--nxt-accent); color:#000; padding:0 2px; border-radius:3px; font-weight:700; }
		.wg-faded { color:var(--nxt-ink-fade); }
		.wg-faded-sm { color:var(--nxt-ink-fade); font-size:12.5px; }
		.wg-difficulty { margin-top:10px; display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:12.5px; }
		.wg-tag-diff { display:inline-flex; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:600;
			background:rgba(255,255,255,0.06); border:1px solid var(--nxt-stroke); color:var(--nxt-ink);
			font-variant-numeric:tabular-nums; white-space:nowrap; }
		.wg-err { color:var(--nxt-danger); }

		.wg-actions { display:flex; gap:10px; margin-top:18px; flex-wrap:wrap; }

		.wg-progress { margin-top:16px; padding:16px; border:1px solid var(--nxt-stroke); border-radius:var(--nxt-radius);
			background:rgba(0,0,0,0.3); }
		.wg-progress-bar { height:4px; border-radius:2px; background:var(--nxt-stroke); overflow:hidden; margin-bottom:14px; }
		.wg-progress-fill { height:100%; width:40%; border-radius:2px; background:var(--nxt-accent);
			animation:wg-indeterminate 1.1s ease-in-out infinite; }
		.wg-progress-fill.paused { animation:none; opacity:0.4; }
		@keyframes wg-indeterminate { 0% { transform:translateX(-120%); } 100% { transform:translateX(320%); } }
		@media (prefers-reduced-motion:reduce) {
			.wg-progress-fill { animation:none; width:100%; opacity:0.45; }
		}
		.wg-progress-stats { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; }
		.wg-progress-stats > div { display:flex; flex-direction:column; gap:3px; }
		.wg-stat { font-size:18px; font-weight:700; letter-spacing:-0.01em; font-variant-numeric:tabular-nums; }
		.wg-stat-label { font-size:11px; color:var(--nxt-ink-fade); text-transform:uppercase; letter-spacing:0.05em; }
		.wg-sample { margin-top:12px; font-family:${MONO}; font-size:11.5px; color:var(--nxt-ink-fade); word-break:break-all; }
		.wg-stopped { margin-top:16px; padding:12px 14px; border:1px solid var(--nxt-stroke); border-radius:var(--nxt-radius-sm);
			color:var(--nxt-ink-dim); font-size:13px; }
		.wg-err-box { margin-top:16px; padding:12px 14px; border:1px solid var(--nxt-danger); border-radius:var(--nxt-radius-sm);
			color:var(--nxt-danger); font-size:13px; }

		.wg-result { margin-top:16px; border-color:var(--nxt-stroke-strong); }
		.wg-result-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
		.wg-result-label { font-size:11.5px; color:var(--nxt-ink-fade); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px; }
		.wg-addr { font-family:${MONO}; font-size:15px; word-break:break-all; line-height:1.5; }
		.wg-secret-wrap { display:flex; flex-direction:column; gap:10px; }
		.wg-secret { font-family:${MONO}; font-size:13px; padding:12px 14px; border-radius:var(--nxt-radius-sm);
			background:rgba(0,0,0,0.4); border:1px solid var(--nxt-stroke); color:var(--nxt-ink-fade);
			word-break:break-all; line-height:1.5; user-select:all; }
		.wg-secret.shown { color:var(--nxt-ink); border-color:var(--nxt-stroke-strong); }
		.wg-secret-actions { display:flex; gap:8px; flex-wrap:wrap; }

		.wg-create2, .wg-safety { margin-top:16px; }
		.wg-safety-list { margin:8px 0 0; padding-left:18px; display:flex; flex-direction:column; gap:7px;
			font-size:13px; color:var(--nxt-ink-dim); line-height:1.5; }
		.wg-safety-list strong { color:var(--nxt-ink); }
	`;
	document.head.appendChild(css);
}
