/**
 * Agent ETH-CREATE2 vanity card — sibling of agent-vanity-grinder.js.
 *
 * Lifecycle states:
 *   none      → form (deployer + raw initCode + prefix/suffix)
 *               with leet-suggestions and word-chip presets
 *   saved     → predicted address + per-chain Deploy buttons
 *   deployed  → list of {chain, tx, verified} entries
 *
 * Same factory + same initCode + same salt = same address on every EVM
 * chain that has the factory deployed. The card surfaces this directly:
 * once you've ground a salt, you can deploy on Ethereum, Base, Arbitrum,
 * Optimism, Polygon, BNB, Avalanche, and the testnets in one click each.
 *
 * One-click deploy uses the Arachnid deterministic-deployment-proxy
 * (data = salt ‖ initCode → CREATE2). Other factories need their ABI
 * to deploy, but the saved record still carries everything they need.
 *
 * Defenses:
 *  - pre-deploy `eth_getCode` collision check on the predicted address
 *  - server-side bytecode verification on the deployed callback
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { grindCreate2Vanity } from './eth/vanity/grinder.js';
import {
	validatePattern, validateAddress, validateInitCodeHash,
	letterCount, eip55Checksum, MAX_PATTERN_LENGTH,
} from './eth/vanity/validation.js';
import { PRESET_CHIPS, suggestPrefixFromName } from './eth/vanity/wordlist.js';
import {
	CHAINS, ARACHNID_PROXY, CREATEX, SAFE_FACTORY, COINBASE_SW,
	chainsWithFactory, getChain, txUrl, addrUrl,
} from './eth/vanity/chains.js';

const PRESETS = [
	{ addr: ARACHNID_PROXY, label: 'Arachnid proxy',  deployable: true  },
	{ addr: CREATEX,        label: 'CreateX',         deployable: false },
	{ addr: SAFE_FACTORY,   label: 'Safe v1.4.1',     deployable: false },
	{ addr: COINBASE_SW,    label: 'Coinbase SW',     deployable: false },
];

const STYLE = `
.agent-eth-vanity-details { margin: .85rem 0; }
.agent-eth-vanity-summary { font: 11px/1.4 system-ui, sans-serif; color: rgba(230,230,234,0.4); cursor: pointer; list-style: none; padding: .2rem 0; user-select: none; }
.agent-eth-vanity-summary::-webkit-details-marker { display: none; }
.agent-eth-vanity-summary::before { content: '▸ '; font-size: .65rem; }
.agent-eth-vanity-details[open] .agent-eth-vanity-summary::before { content: '▾ '; }
.agent-eth-vanity { border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: .85rem 1rem; margin: .4rem 0 0; font: 13px/1.4 system-ui, sans-serif; background: rgba(255,255,255,0.03); color: #e6e6ea; }
.agent-eth-vanity h3 { margin: 0 0 .2rem; font-size: .85rem; font-weight: 600; color: #f2f2f5; display:flex; align-items:center; gap:.4rem; }
.agent-eth-vanity h3 .badge { font-size: .65rem; font-weight: 600; padding: .1rem .45rem; border-radius: 999px; background: linear-gradient(90deg, rgba(167,139,250,0.2), rgba(99,102,241,0.2)); color: #c4b5fd; border: 1px solid rgba(167,139,250,0.25); letter-spacing: .03em; }
.agent-eth-vanity h3 .badge.case { background: linear-gradient(90deg, rgba(251,191,36,0.18), rgba(239,68,68,0.18)); color: #fbbf24; border-color: rgba(251,191,36,0.25); }
.agent-eth-vanity .sub { color: rgba(230,230,234,0.6); font-size: .78rem; margin: 0 0 .55rem; }
.agent-eth-vanity .row { display: flex; gap: .5rem; align-items: center; margin-top: .35rem; flex-wrap: wrap; }
.agent-eth-vanity .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: .5rem; }
@media (max-width: 480px) { .agent-eth-vanity .grid2 { grid-template-columns: 1fr; } }
.agent-eth-vanity input, .agent-eth-vanity textarea, .agent-eth-vanity select { font: inherit; font-family: ui-monospace, monospace; padding: .35rem .55rem; border-radius: 5px; border: 1px solid rgba(255,255,255,0.12); background: #1a1a1a; color: #e6e6ea; width: 100%; }
.agent-eth-vanity input:focus, .agent-eth-vanity textarea:focus, .agent-eth-vanity select:focus { outline: none; border-color: rgba(255,255,255,0.3); }
.agent-eth-vanity input.invalid, .agent-eth-vanity textarea.invalid { border-color: #ff8a80; }
.agent-eth-vanity textarea { resize: vertical; min-height: 3em; }
.agent-eth-vanity label { display: block; font-size: .7rem; color: rgba(230,230,234,0.55); margin: .55rem 0 .15rem; }
.agent-eth-vanity button { font: inherit; padding: .35rem .75rem; border-radius: 5px; border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.04); color: #e6e6ea; cursor: pointer; font-size: .8rem; }
.agent-eth-vanity button:hover:not(:disabled) { background: rgba(255,255,255,0.08); }
.agent-eth-vanity button.primary { background: linear-gradient(90deg,#ffffff,#ffffff); color: #fff; border-color: transparent; font-weight: 600; }
.agent-eth-vanity button.primary:hover:not(:disabled) { filter: brightness(1.1); }
.agent-eth-vanity button.danger { color: #ff8a80; }
.agent-eth-vanity button:disabled { opacity: .45; cursor: not-allowed; }
.agent-eth-vanity .preset-row { display: flex; gap: .3rem; flex-wrap: wrap; margin-top: .3rem; }
.agent-eth-vanity .preset { padding: .2rem .55rem; border-radius: 999px; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1); font-size: .7rem; cursor: pointer; }
.agent-eth-vanity .preset.active { background: linear-gradient(90deg, rgba(167,139,250,0.18), rgba(99,102,241,0.18)); border-color: rgba(167,139,250,0.35); color: #c4b5fd; }
.agent-eth-vanity .progress { font-size: .72rem; color: rgba(230,230,234,0.7); margin-top: .55rem; font-family: ui-monospace, monospace; }
.agent-eth-vanity .err { color: #ff8a80; font-size: .72rem; margin-top: .4rem; }
.agent-eth-vanity .ok { color: #4ade80; font-size: .72rem; margin-top: .4rem; }
.agent-eth-vanity .addr { font-family: ui-monospace, monospace; font-size: .75rem; color: rgba(230,230,234,0.85); margin-top: .35rem; word-break: break-all; padding: .35rem .5rem; background: #0e0e10; border-radius: 5px; border: 1px solid rgba(255,255,255,0.06); }
.agent-eth-vanity .addr .pfx, .agent-eth-vanity .addr .sfx { background: linear-gradient(90deg,#ffffff,#ffffff); color: #fff; padding: 0 2px; border-radius: 2px; font-weight: 700; }
.agent-eth-vanity .meta-line { font-size: .68rem; color: rgba(230,230,234,0.5); margin-top: .4rem; font-family: ui-monospace, monospace; }
.agent-eth-vanity a { color: #ffffff; text-decoration: none; }
.agent-eth-vanity a:hover { text-decoration: underline; }
.agent-eth-vanity .chain-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(160px,1fr)); gap: .35rem; margin-top: .5rem; }
.agent-eth-vanity .chain-cell { display:flex; flex-direction:column; gap:.15rem; padding:.4rem .55rem; border:1px solid rgba(255,255,255,0.08); border-radius:6px; background:rgba(255,255,255,0.02); }
.agent-eth-vanity .chain-cell .ch-name { font-size:.72rem; color:rgba(230,230,234,0.85); font-weight:600; }
.agent-eth-vanity .chain-cell .ch-status { font-size:.65rem; color:rgba(230,230,234,0.55); font-family: ui-monospace, monospace; }
.agent-eth-vanity .chain-cell.deployed { border-color: rgba(74,222,128,0.25); background: rgba(74,222,128,0.05); }
.agent-eth-vanity .chain-cell.deployed .ch-status { color: #4ade80; }
.agent-eth-vanity .chain-cell.unverified { border-color: rgba(251,191,36,0.25); background: rgba(251,191,36,0.05); }
.agent-eth-vanity .chain-cell.unverified .ch-status { color: #fbbf24; }
.agent-eth-vanity .chain-cell button { padding: .2rem .5rem; font-size: .7rem; }
.agent-eth-vanity .chain-cell.testnet .ch-name::after { content: ' · testnet'; font-weight: 400; opacity: .6; }
`;

let _styleInjected = false;
function _injectStyle() {
	if (_styleInjected || typeof document === 'undefined') return;
	const tag = document.createElement('style');
	tag.id = 'agent-eth-vanity-style';
	tag.textContent = STYLE;
	document.head.appendChild(tag);
	_styleInjected = true;
}

function _esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}
function _hexToBytes(hex) {
	const h = hex.startsWith('0x') ? hex.slice(2) : hex;
	const out = new Uint8Array(h.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substring(i*2, i*2+2), 16);
	return out;
}
function _bytesToHex(b) { let s=''; for (let i=0;i<b.length;i++) s += b[i].toString(16).padStart(2,'0'); return s; }
function _isHex(s) { return typeof s === 'string' && /^0x[0-9a-f]*$/i.test(s) && s.length % 2 === 0; }

/**
 * @param {object} opts
 * @param {HTMLElement} opts.panel
 * @param {{ id: string, name?: string, isOwner?: boolean }} opts.identity
 * @param {() => void} [opts.onAssigned]
 */
export function mountAgentEthVanityCard({ panel, identity, onAssigned }) {
	if (!panel || !identity?.id) return null;
	if (identity.isOwner === false) return null;
	_injectStyle();

	const wrapper = document.createElement('details');
	wrapper.className = 'agent-eth-vanity-details';
	wrapper.hidden = true;
	const summary = document.createElement('summary');
	summary.className = 'agent-eth-vanity-summary';
	summary.textContent = 'Vanity address (ETH · CREATE2)';
	wrapper.appendChild(summary);
	panel.appendChild(wrapper);

	const root = document.createElement('section');
	root.className = 'agent-eth-vanity';
	wrapper.appendChild(root);

	const suggestedFromName = suggestPrefixFromName(identity.name || '');

	const state = {
		loaded: false,
		record: null,
		mode: 'view',
		busy: false,
		progress: null,
		err: null,
		ok: null,
		deployStatusByChain: {},  // { [chainId]: 'pending' | 'submitted' }
		form: {
			deployer: ARACHNID_PROXY,
			deployerLabel: 'Arachnid proxy',
			rawInitCode: '',
			prefix: suggestedFromName || '',
			suffix: '',
		},
	};
	let abort = null;

	async function load() {
		try {
			const r = await fetch(`/api/agents/${encodeURIComponent(identity.id)}/eth-vanity`, { credentials: 'include' });
			if (r.status === 403) { wrapper.remove(); return; }
			wrapper.hidden = false;
			if (r.status === 404) {
				state.record = null;
			} else if (r.ok) {
				const data = await r.json();
				state.record = data && typeof data === 'object' && 'data' in data ? data.data : data;
			} else {
				state.err = `load failed (${r.status})`;
			}
		} catch (e) {
			state.err = e.message || 'load failed';
		} finally {
			state.loaded = true;
			render();
		}
	}

	function render() {
		if (!state.loaded) {
			root.innerHTML = `<div class="sub">Loading…</div>`;
			return;
		}
		if (state.mode === 'form' || (!state.record && state.busy)) return renderForm();
		if (state.record)  return renderSaved();
		return renderEmpty();
	}

	function renderEmpty() {
		root.innerHTML = `
			<h3>Vanity address <span class="badge">CREATE2</span></h3>
			<p class="sub">
				Predict a smart-contract address whose hex starts (or ends) with characters you choose, then deploy it
				to <strong>every EVM chain</strong> that has your factory — same address everywhere.
				No keys. Mixed-case patterns enable EIP-55 checksum matching.
			</p>
			${suggestedFromName ? `<p class="sub" style="color:#c4b5fd">Suggested prefix from agent name: <code style="font-family:ui-monospace,monospace">${_esc(suggestedFromName)}</code></p>` : ''}
			<div class="row">
				<button class="primary" data-act="new">Set up CREATE2 vanity</button>
				<a href="/eth-vanity" target="_blank" rel="noopener" style="font-size:.72rem">open full grinder ↗</a>
			</div>
			${state.err ? `<div class="err">${_esc(state.err)}</div>` : ''}
		`;
		root.querySelector('[data-act="new"]').addEventListener('click', () => { state.mode = 'form'; state.err = null; render(); });
	}

	function renderForm() {
		const presetMatch = PRESETS.find((p) => p.addr === state.form.deployer.toLowerCase());
		const canDeploy = !!presetMatch?.deployable;
		const presets = PRESETS.map((p) =>
			`<button class="preset ${state.form.deployer.toLowerCase() === p.addr ? 'active' : ''}" data-preset="${p.addr}" data-label="${_esc(p.label)}" type="button">${_esc(p.label)}</button>`
		).join('');
		const wordChips = PRESET_CHIPS.map((w) => `<button class="preset" data-word="${_esc(w)}" type="button">${_esc(w)}</button>`).join('');
		const caseSensitive = /[A-F]/.test(state.form.prefix) || /[A-F]/.test(state.form.suffix);

		root.innerHTML = `
			<h3>Set up CREATE2 vanity <span class="badge">CREATE2</span>${caseSensitive ? '<span class="badge case">EIP-55</span>' : ''}</h3>
			<p class="sub">Pick the factory you'll deploy through, paste its init code, choose a pattern, and grind.</p>

			<label>Deployer / factory</label>
			<input data-field="deployer" type="text" value="${_esc(state.form.deployer)}" spellcheck="false" />
			<div class="preset-row">${presets}</div>
			${canDeploy
				? `<div class="meta-line">✓ Arachnid proxy supports one-click deploy from this card on every chain it's deployed to.</div>`
				: `<div class="meta-line">Note: this factory needs its own deploy ABI — saving works, but you'll deploy from your own tooling.</div>`}

			<label>Init code (raw deploy bytecode + ABI-encoded args)</label>
			<textarea data-field="initcode" rows="3" placeholder="0x…" spellcheck="false">${_esc(state.form.rawInitCode)}</textarea>

			<div class="grid2">
				<div>
					<label>Prefix (hex; mixed case → EIP-55)</label>
					<input data-field="prefix" type="text" maxlength="${MAX_PATTERN_LENGTH}" value="${_esc(state.form.prefix)}" placeholder="${_esc(suggestedFromName || 'beef')}" />
				</div>
				<div>
					<label>Suffix (hex)</label>
					<input data-field="suffix" type="text" maxlength="${MAX_PATTERN_LENGTH}" value="${_esc(state.form.suffix)}" placeholder="cafe" />
				</div>
			</div>
			<div class="preset-row">${wordChips}</div>

			<div class="row">
				<button class="primary" data-act="grind" ${state.busy ? 'disabled' : ''}>${state.busy ? 'Grinding…' : 'Grind & assign'}</button>
				${state.busy ? '<button data-act="cancel">cancel</button>' : '<button data-act="back">back</button>'}
			</div>
			${state.progress ? `<div class="progress">${state.progress.attempts.toLocaleString()} tries · ${Math.round(state.progress.rate).toLocaleString()}/s · eta ${_esc(state.progress.eta)}</div>` : ''}
			${state.err ? `<div class="err">${_esc(state.err)}</div>` : ''}
		`;

		root.querySelector('[data-field="deployer"]').addEventListener('input', (e) => {
			state.form.deployer = e.target.value.trim();
			const p = PRESETS.find((x) => x.addr === state.form.deployer.toLowerCase());
			state.form.deployerLabel = p ? p.label : null;
		});
		root.querySelector('[data-field="initcode"]').addEventListener('input', (e) => { state.form.rawInitCode = e.target.value.trim(); });
		root.querySelector('[data-field="prefix"]').addEventListener('input', (e) => { state.form.prefix = e.target.value.trim().replace(/^0x/i, ''); });
		root.querySelector('[data-field="suffix"]').addEventListener('input', (e) => { state.form.suffix = e.target.value.trim(); });
		root.querySelectorAll('[data-preset]').forEach((b) => {
			b.addEventListener('click', () => {
				state.form.deployer = b.dataset.preset;
				state.form.deployerLabel = b.dataset.label;
				render();
			});
		});
		root.querySelectorAll('[data-word]').forEach((b) => {
			b.addEventListener('click', () => {
				state.form.prefix = b.dataset.word;
				render();
			});
		});
		root.querySelector('[data-act="back"]')?.addEventListener('click', () => { state.mode = 'view'; state.err = null; render(); });
		root.querySelector('[data-act="cancel"]')?.addEventListener('click', () => abort?.abort());
		root.querySelector('[data-act="grind"]')?.addEventListener('click', onGrindAndAssign);
	}

	function renderSaved() {
		const r = state.record;
		const isCase = !!r.case_sensitive;
		const displayAddr = isCase ? ('0x' + eip55Checksum(r.predicted_address.slice(2))) : r.predicted_address;
		const noPrefix = displayAddr.slice(2);
		const pLen = (r.prefix || '').length;
		const sLen = (r.suffix || '').length;
		const mid = noPrefix.slice(pLen, noPrefix.length - sLen);
		const isArachnid = r.deployer.toLowerCase() === ARACHNID_PROXY;
		const canDeployHere = isArachnid && !!r.init_code;

		const deployments = Array.isArray(r.deployments) ? r.deployments : [];
		const deployedById = Object.fromEntries(deployments.map((d) => [d.chain_id, d]));
		const supported = chainsWithFactory(r.deployer);
		const status = state.deployStatusByChain;

		const cells = supported.map((c) => {
			const d = deployedById[c.id];
			const isPending = status[c.id] === 'pending' || status[c.id] === 'submitted';
			let cls = 'chain-cell';
			if (c.testnet) cls += ' testnet';
			if (d) cls += d.verified ? ' deployed' : ' unverified';
			let statusLine;
			if (d) {
				const tx = d.tx_hash;
				const url = txUrl(c.id, tx);
				statusLine = d.verified
					? `<a href="${_esc(url)}" target="_blank" rel="noopener">verified · ${_esc(tx.slice(0,10))}…</a>`
					: `<a href="${_esc(url)}" target="_blank" rel="noopener">unverified · ${_esc(tx.slice(0,10))}…</a>`;
			} else if (canDeployHere) {
				statusLine = `<button data-deploy="${c.id}" ${isPending ? 'disabled' : ''}>${isPending ? 'deploying…' : 'Deploy'}</button>`;
			} else {
				statusLine = `<span style="opacity:.5">deploy from your tooling</span>`;
			}
			return `<div class="${cls}"><div class="ch-name">${_esc(c.name)}</div><div class="ch-status">${statusLine}</div></div>`;
		}).join('');

		const verifiedCount = deployments.filter((d) => d.verified).length;
		const unverifiedCount = deployments.length - verifiedCount;

		root.innerHTML = `
			<h3>Vanity address <span class="badge">CREATE2</span>${isCase ? '<span class="badge case">EIP-55</span>' : ''}</h3>
			<p class="sub">
				Deterministic contract address — same on every chain that has the factory at <code style="font-family:ui-monospace,monospace">${_esc(r.deployer.slice(0,8))}…${_esc(r.deployer.slice(-4))}</code>${r.deployer_label ? ` (${_esc(r.deployer_label)})` : ''}.
			</p>
			<div class="addr">
				0x${r.prefix ? `<span class="pfx">${_esc(r.prefix)}</span>` : ''}${_esc(mid)}${r.suffix ? `<span class="sfx">${_esc(r.suffix)}</span>` : ''}
			</div>
			${isCase ? `<div class="meta-line">lowercase: ${_esc(r.predicted_address)}</div>` : ''}
			<div class="meta-line">
				salt ${_esc(r.salt.slice(0, 14))}…${_esc(r.salt.slice(-4))}${r.init_code ? ' · init code stored' : ' · init code hash only'}
				${verifiedCount ? ` · <span style="color:#4ade80">${verifiedCount} verified</span>` : ''}
				${unverifiedCount ? ` · <span style="color:#fbbf24">${unverifiedCount} unverified</span>` : ''}
			</div>
			<div class="chain-grid">${cells}</div>
			<div class="row" style="margin-top:.7rem">
				<button data-act="copy">Copy address</button>
				<button data-act="json">Download JSON</button>
				<button data-act="replace">Replace</button>
				<button class="danger" data-act="remove">Remove</button>
			</div>
			${state.ok  ? `<div class="ok">${_esc(state.ok)}</div>` : ''}
			${state.err ? `<div class="err">${_esc(state.err)}</div>` : ''}
		`;
		root.querySelector('[data-act="copy"]').addEventListener('click', async () => {
			try { await navigator.clipboard.writeText(displayAddr); state.ok = 'address copied'; render(); setTimeout(() => { state.ok = null; render(); }, 1500); } catch {}
		});
		root.querySelector('[data-act="json"]').addEventListener('click', () => {
			const blob = new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url; a.download = `agent-${identity.id}-vanity.json`;
			document.body.appendChild(a); a.click(); a.remove();
			URL.revokeObjectURL(url);
		});
		root.querySelector('[data-act="replace"]').addEventListener('click', async () => {
			if (!confirm('Replace the saved CREATE2 vanity record? The address above and any deploy history will no longer be associated with this agent.')) return;
			try {
				await fetch(`/api/agents/${encodeURIComponent(identity.id)}/eth-vanity`, { method: 'DELETE', credentials: 'include' });
				state.record = null; state.mode = 'form'; state.err = null; state.deployStatusByChain = {}; render();
			} catch (e) { state.err = e.message; render(); }
		});
		root.querySelector('[data-act="remove"]').addEventListener('click', async () => {
			if (!confirm('Remove the saved CREATE2 vanity record?')) return;
			try {
				await fetch(`/api/agents/${encodeURIComponent(identity.id)}/eth-vanity`, { method: 'DELETE', credentials: 'include' });
				state.record = null; state.err = null; state.deployStatusByChain = {}; render();
			} catch (e) { state.err = e.message; render(); }
		});
		root.querySelectorAll('[data-deploy]').forEach((b) => {
			b.addEventListener('click', () => onDeploy(Number(b.dataset.deploy)));
		});
	}

	async function onGrindAndAssign() {
		state.err = null;
		const f = state.form;
		const dv = validateAddress(f.deployer);
		if (!dv.valid) { state.err = `deployer: ${dv.error}`; render(); return; }
		if (!_isHex(f.rawInitCode)) { state.err = 'init code must be 0x-prefixed even-length hex'; render(); return; }
		if (!f.prefix && !f.suffix) { state.err = 'pick a prefix or suffix'; render(); return; }
		let caseSensitive = false;
		if (f.prefix) {
			const v = validatePattern(f.prefix);
			if (!v.valid) { state.err = `prefix: ${v.errors.join('; ')}`; render(); return; }
			if (v.caseSensitive) caseSensitive = true;
		}
		if (f.suffix) {
			const v = validatePattern(f.suffix);
			if (!v.valid) { state.err = `suffix: ${v.errors.join('; ')}`; render(); return; }
			if (v.caseSensitive) caseSensitive = true;
		}

		const initCode = f.rawInitCode.toLowerCase();
		const initCodeHash = '0x' + _bytesToHex(keccak_256(_hexToBytes(initCode)));
		const ich = validateInitCodeHash(initCodeHash);
		if (!ich.valid) { state.err = `init code: ${ich.error}`; render(); return; }

		state.busy = true; state.progress = null; render();
		abort = new AbortController();
		try {
			const result = await grindCreate2Vanity({
				deployer:     dv.normalized,
				initCodeHash: ich.normalized,
				prefix:       f.prefix || undefined,
				suffix:       f.suffix || undefined,
				signal:       abort.signal,
				onProgress:   (p) => { state.progress = p; render(); },
			});

			const res = await fetch(`/api/agents/${encodeURIComponent(identity.id)}/eth-vanity`, {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					deployer:          result.deployer,
					salt:              result.salt,
					init_code_hash:    result.initCodeHash,
					init_code:         initCode,
					predicted_address: result.address,
					prefix:            f.prefix || null,
					suffix:            f.suffix || null,
					case_sensitive:    caseSensitive,
					deployer_label:    f.deployerLabel || null,
				}),
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				if (res.status === 409) {
					await fetch(`/api/agents/${encodeURIComponent(identity.id)}/eth-vanity`, { method: 'DELETE', credentials: 'include' });
					return onGrindAndAssign();
				}
				throw new Error(data.error_description || `save failed (${res.status})`);
			}
			state.record  = data.data || data;
			state.mode    = 'view';
			state.progress = null;
			onAssigned?.(state.record);
		} catch (e) {
			state.err = e.name === 'AbortError' ? 'cancelled' : (e.message || 'failed');
			state.progress = null;
		} finally {
			state.busy = false; abort = null; render();
		}
	}

	/**
	 * Deploy on a specific chain. Switches the wallet to the target chain,
	 * checks for prior deployment (collision), submits the raw CREATE2 tx,
	 * and POSTs to the /deployed endpoint which verifies bytecode server-side.
	 */
	async function onDeploy(chainId) {
		const r = state.record;
		if (!r || !r.init_code) { state.err = 'no init code stored — cannot deploy from this card'; render(); return; }
		if (r.deployer.toLowerCase() !== ARACHNID_PROXY) { state.err = 'one-click deploy only supported for the Arachnid proxy'; render(); return; }
		const target = getChain(chainId);
		if (!target) { state.err = `unknown chain ${chainId}`; render(); return; }

		state.deployStatusByChain = { ...state.deployStatusByChain, [chainId]: 'pending' };
		state.err = null; state.ok = null; render();

		try {
			const { BrowserProvider } = await import('ethers');
			if (!window.ethereum) throw new Error('no EVM wallet detected — install MetaMask or another EIP-1193 wallet');
			const provider = new BrowserProvider(window.ethereum);
			await provider.send('eth_requestAccounts', []);

			// Switch network to the target chain (request → user approves).
			const hexChain = '0x' + chainId.toString(16);
			try {
				await provider.send('wallet_switchEthereumChain', [{ chainId: hexChain }]);
			} catch (switchErr) {
				if (switchErr?.code === 4902) {
					// Unknown to the wallet — try to add it from our registry.
					await provider.send('wallet_addEthereumChain', [{
						chainId: hexChain,
						chainName: target.name,
						rpcUrls: [target.rpc],
						blockExplorerUrls: [target.explorer],
						nativeCurrency: { name: target.currency, symbol: target.currency, decimals: 18 },
					}]);
				} else {
					throw switchErr;
				}
			}
			const signer = await provider.getSigner();

			// Pre-deploy collision check: if the predicted address already has
			// bytecode on this chain, bail rather than wasting gas / overwriting state.
			const code = await provider.send('eth_getCode', [r.predicted_address, 'latest']);
			if (code && code !== '0x' && code !== '0x0') {
				throw new Error('contract already deployed at this address on this chain — refusing to overwrite');
			}

			const data = r.salt + r.init_code.slice(2);
			const tx = await signer.sendTransaction({ to: r.deployer, data });
			state.deployStatusByChain = { ...state.deployStatusByChain, [chainId]: 'submitted' };
			state.ok = `${target.name}: submitted ${tx.hash.slice(0, 10)}… waiting for inclusion`;
			render();

			const receipt = await tx.wait();
			if (receipt?.status !== 1) throw new Error('deploy reverted');

			const mark = await fetch(`/api/agents/${encodeURIComponent(identity.id)}/eth-vanity/deployed`, {
				method: 'POST',
				credentials: 'include',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ chain_id: chainId, tx_hash: tx.hash }),
			});
			const md = await mark.json().catch(() => ({}));
			if (md?.data?.record) {
				state.record = md.data.record;
				state.ok = md.data.verified
					? `${target.name}: deployed and verified ✓`
					: `${target.name}: deployed but server couldn't verify bytecode (${md.data.reason || 'unknown'})`;
			} else {
				state.ok = `${target.name}: deploy submitted`;
			}
			delete state.deployStatusByChain[chainId];
		} catch (e) {
			state.err = `${target.name}: ${e.shortMessage || e.message || 'deploy failed'}`;
			delete state.deployStatusByChain[chainId];
		} finally {
			render();
		}
	}

	render();
	load();

	return {
		destroy: () => { abort?.abort(); wrapper.remove(); },
		refresh: () => load(),
	};
}
