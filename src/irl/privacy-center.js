// src/irl/privacy-center.js — IRL "Location & privacy" control center (L3).
//
// One designed, reachable surface that tells the user — in plain language — what
// a placed pin actually shares and who can see it, and gives them the levers in
// one place: discovery precision (Precise vs Approximate, consumed by the L4
// proximity read), the "appear to others" presence opt-in, and a jump into
// pin management. Plus a one-time first-run disclosure shown the first time
// location is granted. This module owns the discovery-precision setting (single
// source of truth) so irl.js / loadNearbyPins read it without duplicating a key.

const PRECISION_KEY  = 'irl_discovery_precision';   // 'precise' | 'approximate'
const DISCLOSED_KEY  = 'irl_location_disclosed_v1';
const DEVICE_KEY     = 'irl_device_token';          // shared with src/irl.js (H2 identity)
const STYLE_ID       = 'irlpc-styles';

// The anonymous device token is a BEARER credential (H2): presenting it reads a
// device's pin history + inbox. It rides the `x-irl-device` REQUEST HEADER — never
// a URL — so it can't leak through access logs, history, or a Referer header. The
// session cookie (credentials: 'include') authenticates a signed-in caller; both
// arms are accepted by api/irl/privacy.js, which scopes every query to the owner.
function deviceToken() {
	try { return localStorage.getItem(DEVICE_KEY) || ''; } catch { return ''; }
}

function privacyHeaders(extra = {}) {
	const tok = deviceToken();
	return tok ? { 'x-irl-device': tok, ...extra } : { ...extra };
}

// Talk to api/irl/privacy.js. Token in the header, body for mutations, never a
// query string. Throws a plain-language Error on a non-2xx so the UI renders a
// designed error state rather than a silent failure.
async function privacyApi(method, { query = '', body } = {}) {
	const init = { method, credentials: 'include', headers: privacyHeaders() };
	if (body !== undefined) {
		init.headers = privacyHeaders({ 'content-type': 'application/json' });
		init.body = JSON.stringify(body);
	}
	let resp;
	try {
		resp = await fetch(`/api/irl/privacy${query}`, init);
	} catch {
		throw new Error('Network error — check your connection and try again.');
	}
	let data = null;
	try { data = await resp.json(); } catch { /* empty/non-JSON body */ }
	if (!resp.ok) {
		throw new Error(data?.error || `Request failed (${resp.status}).`);
	}
	return data;
}

// ── Discovery precision (single source of truth) ────────────────────────────
export function getDiscoveryPrecision() {
	try { return localStorage.getItem(PRECISION_KEY) === 'approximate' ? 'approximate' : 'precise'; }
	catch { return 'precise'; }
}
export function setDiscoveryPrecision(v) {
	try { localStorage.setItem(PRECISION_KEY, v === 'approximate' ? 'approximate' : 'precise'); } catch {}
}

// The three honest facts, shared by the sheet and the first-run disclosure so the
// copy never diverges. Grounded in api/irl/pins.js behavior (≤60 m radius read,
// no roster, owner id stripped, anon pins expire in 7 days).
const FACTS = [
	{ icon: '📍', t: 'Only people right next to it', b: 'A placed agent appears to someone only when they’re physically within ~60 m of it — never on a map or a browsable list.' },
	{ icon: '🕶️', t: 'Never tied to your identity', b: 'The nearby feed never includes your account or device id. Others see an agent at a spot, not who placed it.' },
	{ icon: '⏳', t: 'Gone on your terms', b: 'Pins you place without signing in auto-expire after 7 days, and you can remove any of them instantly from “My pins”.' },
];

function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = `
.irlpc-root{position:fixed;inset:0;z-index:10001;display:flex;align-items:flex-end;justify-content:center}
.irlpc-back{position:absolute;inset:0;background:rgba(4,6,12,.62);backdrop-filter:blur(2px);animation:irlpc-fade .2s ease}
.irlpc-sheet{position:relative;width:100%;max-width:540px;max-height:90vh;overflow-y:auto;background:#0c0f17;
  border:1px solid #232838;border-bottom:none;border-radius:18px 18px 0 0;box-shadow:0 -8px 40px rgba(0,0,0,.55);
  animation:irlpc-rise .26s cubic-bezier(.2,.8,.2,1)}
@media(min-width:600px){.irlpc-root{align-items:center}.irlpc-sheet{border-radius:18px;border-bottom:1px solid #232838}}
@keyframes irlpc-rise{from{transform:translateY(14px);opacity:.4}to{transform:translateY(0);opacity:1}}
@keyframes irlpc-fade{from{opacity:0}to{opacity:1}}
.irlpc-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 6px}
.irlpc-title{font:600 16px/1.2 system-ui,sans-serif;color:#eef1f7}
.irlpc-x{appearance:none;background:none;border:none;color:#8b93a7;font-size:24px;line-height:1;cursor:pointer;
  width:34px;height:34px;border-radius:8px;display:flex;align-items:center;justify-content:center;transition:background .15s,color .15s}
.irlpc-x:hover,.irlpc-x:focus-visible{background:#1a1f2e;color:#eef1f7;outline:none}
.irlpc-sec{padding:12px 18px;border-top:1px solid #161b27}
.irlpc-sec:first-of-type{border-top:none}
.irlpc-sec h4{margin:0 0 10px;font:600 12px/1.2 system-ui,sans-serif;letter-spacing:.06em;text-transform:uppercase;color:#7b8398}
.irlpc-fact{display:flex;gap:11px;margin-bottom:11px}
.irlpc-fact:last-child{margin-bottom:0}
.irlpc-fact .ic{font-size:17px;line-height:1.3;flex-shrink:0}
.irlpc-fact .t{font:600 13.5px/1.3 system-ui,sans-serif;color:#eef1f7;margin-bottom:2px}
.irlpc-fact .b{font:400 12.5px/1.45 system-ui,sans-serif;color:#aeb6c8}
.irlpc-seg{display:flex;gap:6px;background:#11151f;border:1px solid #232838;border-radius:11px;padding:4px}
.irlpc-seg button{flex:1;appearance:none;background:none;border:none;border-radius:8px;cursor:pointer;padding:9px 6px;
  font:600 13px/1.1 system-ui,sans-serif;color:#aeb6c8;transition:background .15s,color .15s}
.irlpc-seg button small{display:block;font-weight:500;font-size:10.5px;color:#6f7790;margin-top:2px}
.irlpc-seg button.on{background:#4f7cff;color:#fff}
.irlpc-seg button.on small{color:#dbe5ff}
.irlpc-note{margin-top:9px;font:400 11.5px/1.45 system-ui,sans-serif;color:#7b8398}
.irlpc-row{display:flex;align-items:center;justify-content:space-between;gap:14px}
.irlpc-row .rt{font:600 13.5px/1.3 system-ui,sans-serif;color:#eef1f7}
.irlpc-row .rb{font:400 12px/1.4 system-ui,sans-serif;color:#8b93a7;margin-top:2px;max-width:330px}
.irlpc-switch{position:relative;width:46px;height:27px;border-radius:999px;background:#2a3042;border:none;cursor:pointer;flex-shrink:0;transition:background .18s}
.irlpc-switch::after{content:'';position:absolute;top:3px;left:3px;width:21px;height:21px;border-radius:50%;background:#fff;transition:transform .18s}
.irlpc-switch[aria-pressed="true"]{background:#34c759}
.irlpc-switch[aria-pressed="true"]::after{transform:translateX(19px)}
.irlpc-switch:focus-visible{outline:2px solid #4f7cff;outline-offset:2px}
.irlpc-manage{display:flex;align-items:center;justify-content:space-between;width:100%;appearance:none;cursor:pointer;
  background:#11151f;border:1px solid #232838;border-radius:11px;padding:13px 14px;color:#eef1f7;
  font:600 13.5px system-ui,sans-serif;transition:background .15s}
.irlpc-manage:hover{background:#1a2032}
.irlpc-manage .ar{color:#8b93a7;font-size:18px}
.irlpc-foot{padding:14px 18px 18px}
.irlpc-done{width:100%;appearance:none;background:#4f7cff;color:#fff;border:none;border-radius:11px;
  font:600 14px system-ui,sans-serif;padding:13px;cursor:pointer;transition:background .15s}
.irlpc-done:hover{background:#3d6af0}
.irlpc-learn{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:11px;
  font:500 12.5px/1 system-ui,sans-serif;color:#7ec8e3;text-decoration:none;transition:color .15s}
.irlpc-learn:hover{color:#a6dcee}
.irlpc-learn:focus-visible{outline:2px solid #4f7cff;outline-offset:3px;border-radius:6px}
.irlpc-learn .ar{font-size:14px}
/* First-run disclosure reuses the sheet shell with a tighter body */
.irlpc-discl .irlpc-sec{border-top:none}
/* ── My data panel ──────────────────────────────────────────────────────── */
.irlpc-stats{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:4px}
.irlpc-stat{background:#11151f;border:1px solid #232838;border-radius:11px;padding:11px 12px}
.irlpc-stat .n{font:700 19px/1 system-ui,sans-serif;color:#eef1f7}
.irlpc-stat .l{font:500 11px/1.2 system-ui,sans-serif;color:#8b93a7;margin-top:4px}
.irlpc-stored{list-style:none;margin:10px 0 0;padding:0}
.irlpc-stored li{position:relative;padding:0 0 6px 16px;font:400 12px/1.45 system-ui,sans-serif;color:#aeb6c8}
.irlpc-stored li::before{content:'•';position:absolute;left:3px;color:#4f7cff}
.irlpc-pin{display:flex;align-items:center;gap:10px;padding:10px 0;border-top:1px solid #161b27}
.irlpc-pin:first-child{border-top:none}
.irlpc-pin .pmeta{flex:1;min-width:0}
.irlpc-pin .pname{font:600 13px/1.3 system-ui,sans-serif;color:#eef1f7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.irlpc-pin .psub{font:400 11px/1.3 system-ui,sans-serif;color:#7b8398;margin-top:2px}
.irlpc-pin.hidden .pname{color:#8b93a7}
.irlpc-tag{display:inline-block;margin-left:6px;font:600 9.5px/1.4 system-ui,sans-serif;letter-spacing:.04em;
  text-transform:uppercase;color:#cda13a;background:#2a2410;border:1px solid #4a3f17;border-radius:5px;padding:1px 5px;vertical-align:middle}
.irlpc-pinbtn{appearance:none;border:1px solid #2a3042;background:#161b27;color:#aeb6c8;border-radius:8px;cursor:pointer;
  font:600 11.5px system-ui,sans-serif;padding:7px 10px;transition:background .15s,color .15s,border-color .15s;flex-shrink:0}
.irlpc-pinbtn:hover,.irlpc-pinbtn:focus-visible{background:#1f2636;color:#eef1f7;outline:none;border-color:#3a4258}
.irlpc-pinbtn:focus-visible{outline:2px solid #4f7cff;outline-offset:2px}
.irlpc-pinbtn.danger{color:#ff8a8a;border-color:#4a2630}
.irlpc-pinbtn.danger:hover,.irlpc-pinbtn.danger:focus-visible{background:#2a1620;color:#ffb3b3}
.irlpc-actbtn{display:flex;align-items:center;justify-content:center;gap:7px;width:100%;appearance:none;cursor:pointer;
  border-radius:11px;padding:12px;font:600 13.5px system-ui,sans-serif;transition:background .15s,border-color .15s;margin-top:8px}
.irlpc-actbtn.ghost{background:#11151f;border:1px solid #232838;color:#eef1f7}
.irlpc-actbtn.ghost:hover{background:#1a2032}
.irlpc-actbtn.danger{background:#1c1014;border:1px solid #4a2630;color:#ff9a9a}
.irlpc-actbtn.danger:hover{background:#2a1620;border-color:#6a3340;color:#ffb3b3}
.irlpc-actbtn:disabled{opacity:.5;cursor:not-allowed}
.irlpc-empty{text-align:center;padding:22px 12px;color:#8b93a7;font:400 13px/1.5 system-ui,sans-serif}
.irlpc-empty .e-ic{font-size:26px;display:block;margin-bottom:8px}
.irlpc-skel{height:64px;border-radius:11px;background:linear-gradient(90deg,#11151f 25%,#171c28 50%,#11151f 75%);
  background-size:200% 100%;animation:irlpc-shimmer 1.3s infinite;margin-bottom:8px}
@keyframes irlpc-shimmer{from{background-position:200% 0}to{background-position:-200% 0}}
.irlpc-err{background:#1c1014;border:1px solid #4a2630;border-radius:11px;padding:12px 14px;color:#ffb3b3;
  font:500 12.5px/1.45 system-ui,sans-serif;display:flex;flex-direction:column;gap:9px}
.irlpc-err button{align-self:flex-start;appearance:none;background:#2a1620;border:1px solid #6a3340;color:#ffd1d1;
  border-radius:8px;padding:7px 12px;font:600 12px system-ui,sans-serif;cursor:pointer}
.irlpc-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(8px);z-index:10003;opacity:0;
  background:#11331c;border:1px solid #1f6b3a;color:#c8ffd9;border-radius:11px;padding:11px 16px;
  font:600 13px system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.5);transition:opacity .2s,transform .2s;pointer-events:none}
.irlpc-toast.show{opacity:1;transform:translateX(-50%) translateY(0)}
.irlpc-toast.err{background:#331114;border-color:#6b1f24;color:#ffd1d1}
/* Typed-confirm modal */
.irlpc-confirm h4{margin:0 0 8px;font:700 15px/1.3 system-ui,sans-serif;color:#eef1f7;text-transform:none;letter-spacing:0}
.irlpc-confirm p{margin:0 0 12px;font:400 13px/1.5 system-ui,sans-serif;color:#aeb6c8}
.irlpc-confirm code{background:#11151f;border:1px solid #232838;border-radius:5px;padding:1px 6px;color:#ffd1d1;font:600 12px ui-monospace,monospace}
.irlpc-confirm input{width:100%;box-sizing:border-box;background:#0a0d14;border:1px solid #2a3042;border-radius:9px;
  padding:11px 12px;color:#eef1f7;font:500 14px system-ui,sans-serif;margin-bottom:12px}
.irlpc-confirm input:focus{outline:2px solid #ff8a8a;outline-offset:1px;border-color:#ff8a8a}
.irlpc-confirm .row{display:flex;gap:9px}
.irlpc-confirm .row button{flex:1;appearance:none;border-radius:10px;padding:12px;font:600 13.5px system-ui,sans-serif;cursor:pointer}
.irlpc-confirm .cancel{background:#161b27;border:1px solid #232838;color:#eef1f7}
.irlpc-confirm .go{background:#7a1f2a;border:1px solid #a13340;color:#fff}
.irlpc-confirm .go:disabled{opacity:.45;cursor:not-allowed}
`;
	document.head.appendChild(el);
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function factsHTML() {
	return FACTS.map((f) => `<div class="irlpc-fact"><span class="ic">${f.icon}</span><div><div class="t">${esc(f.t)}</div><div class="b">${esc(f.b)}</div></div></div>`).join('');
}

// Generic modal shell with backdrop + Esc + focus return. `build(sheet, close)`
// fills the sheet; `close()` tears down.
function modal(buildInner, { extraClass = '' } = {}) {
	ensureStyles();
	const root = document.createElement('div');
	root.className = `irlpc-root ${extraClass}`.trim();
	root.setAttribute('role', 'dialog');
	root.setAttribute('aria-modal', 'true');
	const back = document.createElement('div');
	back.className = 'irlpc-back';
	const sheet = document.createElement('div');
	sheet.className = 'irlpc-sheet';
	root.append(back, sheet);
	document.body.appendChild(root);
	const prevOverflow = document.body.style.overflow;
	document.body.style.overflow = 'hidden';
	const prevFocus = document.activeElement;

	let closed = false;
	const close = () => {
		if (closed) return;
		closed = true;
		document.removeEventListener('keydown', onKey, true);
		root.remove();
		document.body.style.overflow = prevOverflow;
		try { prevFocus?.focus?.(); } catch {}
	};
	const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
	document.addEventListener('keydown', onKey, true);
	back.addEventListener('click', close);
	buildInner(sheet, close);
	return close;
}

// ── The Location & privacy sheet ────────────────────────────────────────────
export function openPrivacyCenter({ getGhost, setGhost, onManagePins, onChanged } = {}) {
	modal((sheet, close) => {
		const precision = getDiscoveryPrecision();
		const ghostOn = !!(getGhost && getGhost());
		sheet.setAttribute('aria-label', 'Location and privacy');
		sheet.innerHTML = `
			<div class="irlpc-head">
				<div class="irlpc-title">Location &amp; privacy</div>
				<button class="irlpc-x" type="button" data-close aria-label="Close">×</button>
			</div>
			<div class="irlpc-sec">
				<h4>What others can see</h4>
				${factsHTML()}
			</div>
			<div class="irlpc-sec">
				<h4>Discovery precision</h4>
				<div class="irlpc-seg" role="group" aria-label="Discovery precision">
					<button type="button" data-prec="precise" class="${precision === 'precise' ? 'on' : ''}" aria-pressed="${precision === 'precise'}">Precise<small>exact spot</small></button>
					<button type="button" data-prec="approximate" class="${precision === 'approximate' ? 'on' : ''}" aria-pressed="${precision === 'approximate'}">Approximate<small>~25 m area</small></button>
				</div>
				<div class="irlpc-note">Approximate keeps your exact position off our servers while you browse — nearby agents may resolve a little less precisely. Placement is always exactly where you choose.</div>
			</div>
			<div class="irlpc-sec">
				<div class="irlpc-row">
					<div>
						<div class="rt">Appear to others nearby</div>
						<div class="rb">Off by default. When on, people viewing this area see you as a ghost marker. Your presence count is shared either way.</div>
					</div>
					<button class="irlpc-switch" type="button" data-ghost role="switch" aria-pressed="${ghostOn}" aria-label="Appear to others nearby"></button>
				</div>
			</div>
			<div class="irlpc-sec">
				<h4>Your placements &amp; data</h4>
				<button class="irlpc-manage" type="button" data-manage>
					<span>Manage &amp; remove agents you’ve placed</span><span class="ar">→</span>
				</button>
				<button class="irlpc-manage" type="button" data-mydata style="margin-top:8px">
					<span>Privacy &amp; my data — see, export &amp; erase everything</span><span class="ar">→</span>
				</button>
			</div>
			<div class="irlpc-foot">
				<button class="irlpc-done" type="button" data-close>Done</button>
				<a class="irlpc-learn" href="/irl-privacy" target="_blank" rel="noopener">How location works <span class="ar" aria-hidden="true">↗</span></a>
			</div>`;

		sheet.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));

		// Precision segmented control
		sheet.querySelectorAll('[data-prec]').forEach((btn) => {
			btn.addEventListener('click', () => {
				const v = btn.dataset.prec;
				setDiscoveryPrecision(v);
				sheet.querySelectorAll('[data-prec]').forEach((b) => {
					const on = b.dataset.prec === v;
					b.classList.toggle('on', on);
					b.setAttribute('aria-pressed', String(on));
				});
			});
		});

		// Presence opt-in — drives the host toggle so the topbar pill + room state stay in sync.
		const ghostBtn = sheet.querySelector('[data-ghost]');
		ghostBtn?.addEventListener('click', () => {
			const next = ghostBtn.getAttribute('aria-pressed') !== 'true';
			ghostBtn.setAttribute('aria-pressed', String(next));
			try { setGhost && setGhost(next); } catch {}
		});

		// Manage placements → close then open My pins
		sheet.querySelector('[data-manage]')?.addEventListener('click', () => {
			close();
			try { onManagePins && onManagePins(); } catch {}
		});

		// Privacy & my data → close then open the full H5 data-control surface
		// (summary, per-pin unpublish/delete, export, remove-all, forget device).
		sheet.querySelector('[data-mydata]')?.addEventListener('click', () => {
			close();
			openMyDataPanel({ onChanged });
		});

		setTimeout(() => sheet.querySelector('[data-close]')?.focus(), 60);
	});
}

// ── Toast (success / error confirmation) ────────────────────────────────────
function toast(msg, kind = 'ok') {
	if (typeof document === 'undefined') return;
	const t = document.createElement('div');
	t.className = `irlpc-toast ${kind === 'err' ? 'err' : ''}`.trim();
	t.setAttribute('role', 'status');
	t.textContent = msg;
	document.body.appendChild(t);
	requestAnimationFrame(() => t.classList.add('show'));
	setTimeout(() => {
		t.classList.remove('show');
		setTimeout(() => t.remove(), 240);
	}, 2600);
}

// ── Typed-confirm modal for the two irreversible actions ────────────────────
// The user must type the exact word to arm the destructive button — no accidental
// "remove everything." Resolves true only on a confirmed go.
function typedConfirm({ title, body, word, goLabel }) {
	return new Promise((resolve) => {
		let done = false;
		const finish = (ok) => { if (done) return; done = true; close(); resolve(ok); };
		const close = modal((sheet) => {
			sheet.classList.add('irlpc-confirm');
			sheet.setAttribute('aria-label', title);
			sheet.innerHTML = `
				<div class="irlpc-sec">
					<h4>${esc(title)}</h4>
					<p>${body}</p>
					<input type="text" autocomplete="off" autocapitalize="none" spellcheck="false"
						aria-label="Type ${esc(word)} to confirm" placeholder="Type ${esc(word)} to confirm" data-field />
					<div class="row">
						<button class="cancel" type="button" data-cancel>Cancel</button>
						<button class="go" type="button" data-go disabled>${esc(goLabel)}</button>
					</div>
				</div>`;
			const field = sheet.querySelector('[data-field]');
			const go = sheet.querySelector('[data-go]');
			field.addEventListener('input', () => {
				go.disabled = field.value.trim().toLowerCase() !== word.toLowerCase();
			});
			field.addEventListener('keydown', (e) => {
				if (e.key === 'Enter' && !go.disabled) finish(true);
			});
			go.addEventListener('click', () => finish(true));
			sheet.querySelector('[data-cancel]').addEventListener('click', () => finish(false));
			setTimeout(() => field.focus(), 60);
		}, { onClose: () => finish(false) });
	});
}

// ── "Privacy & my data" — the H5 control surface ────────────────────────────
// Renders the caller's real data summary (api/irl/privacy GET), a per-pin
// Unpublish/Republish + Delete, Download, and the two destructive actions behind
// a typed confirm. Every state — loading, empty, error, populated — is designed.
export function openMyDataPanel({ onChanged } = {}) {
	modal((sheet, close) => {
		sheet.setAttribute('aria-label', 'Privacy and my data');
		const head = `
			<div class="irlpc-head">
				<div class="irlpc-title">Privacy &amp; my data</div>
				<button class="irlpc-x" type="button" data-close aria-label="Close">×</button>
			</div>`;

		const renderLoading = () => {
			sheet.innerHTML = `${head}
				<div class="irlpc-sec"><div class="irlpc-skel"></div><div class="irlpc-skel"></div><div class="irlpc-skel"></div></div>`;
			sheet.querySelector('[data-close]')?.addEventListener('click', close);
		};

		const renderError = (message) => {
			sheet.innerHTML = `${head}
				<div class="irlpc-sec">
					<div class="irlpc-err">
						<span>${esc(message)}</span>
						<button type="button" data-retry>Try again</button>
					</div>
				</div>`;
			sheet.querySelector('[data-close]')?.addEventListener('click', close);
			sheet.querySelector('[data-retry]')?.addEventListener('click', load);
		};

		const fmtDate = (iso) => {
			if (!iso) return '';
			try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
			catch { return ''; }
		};

		async function load() {
			renderLoading();
			let data;
			try {
				data = await privacyApi('GET');
			} catch (e) {
				renderError(e.message || 'Could not load your data.');
				return;
			}
			renderSummary(data.summary || {});
		}

		function renderSummary(s) {
			const pins = s.pins || {};
			const ix = s.interactions || {};
			const ret = s.retention || {};
			const stored = Array.isArray(s.stored) ? s.stored : [];
			const totalPins = pins.total || 0;

			if (totalPins === 0 && (ix.onYourPins || 0) === 0 && (ix.youLeftElsewhere || 0) === 0) {
				sheet.innerHTML = `${head}
					<div class="irlpc-sec">
						<div class="irlpc-empty">
							<span class="e-ic">🫧</span>
							We hold no location data for this ${s.account === 'signed-in' ? 'account' : 'device'}.
							Place an agent in /irl and it’ll show up here — yours to manage or remove anytime.
						</div>
					</div>
					<div class="irlpc-foot"><button class="irlpc-done" type="button" data-close>Done</button></div>`;
				sheet.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
				return;
			}

			const expiryNote = ret.nextPinExpiry
				? `Your next anonymous pin expires ${fmtDate(ret.nextPinExpiry)}.`
				: (pins.permanent ? 'Your pins are permanent until you remove them.' : '');

			sheet.innerHTML = `${head}
				<div class="irlpc-sec">
					<h4>What we hold</h4>
					<div class="irlpc-stats">
						<div class="irlpc-stat"><div class="n">${totalPins}</div><div class="l">placed agent${totalPins === 1 ? '' : 's'}${pins.unpublished ? ` · ${pins.unpublished} hidden` : ''}</div></div>
						<div class="irlpc-stat"><div class="n">${ix.onYourPins || 0}</div><div class="l">encounters on your agents</div></div>
						<div class="irlpc-stat"><div class="n">${ix.youLeftElsewhere || 0}</div><div class="l">taps you left elsewhere</div></div>
						<div class="irlpc-stat"><div class="n">${pins.permanent || 0}</div><div class="l">permanent · ${pins.expiring || 0} auto-expiring</div></div>
					</div>
					${expiryNote ? `<div class="irlpc-note">${esc(expiryNote)} Encounters auto-delete after ${ret.interactionsExpireInDays || 180} days.</div>` : ''}
					<ul class="irlpc-stored">${stored.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
				</div>
				<div class="irlpc-sec" data-pins-sec>
					<h4>Your placed agents</h4>
					<div data-pins><div class="irlpc-skel"></div></div>
				</div>
				<div class="irlpc-sec">
					<h4>Export &amp; erase</h4>
					<button class="irlpc-actbtn ghost" type="button" data-export>⬇ Download my data (JSON)</button>
					<button class="irlpc-actbtn danger" type="button" data-del-all>Remove all my pins</button>
					<button class="irlpc-actbtn danger" type="button" data-forget>Forget this device</button>
					<div class="irlpc-note">“Forget this device” erases every pin and every tap tied to this device, everywhere — instantly and permanently.</div>
				</div>
				<div class="irlpc-foot"><button class="irlpc-done" type="button" data-close>Done</button></div>`;

			sheet.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
			loadPins();

			sheet.querySelector('[data-export]')?.addEventListener('click', onExport);
			sheet.querySelector('[data-del-all]')?.addEventListener('click', () => onDestructive('all'));
			sheet.querySelector('[data-forget]')?.addEventListener('click', () => onDestructive('device'));
		}

		async function loadPins() {
			const host = sheet.querySelector('[data-pins]');
			if (!host) return;
			let data;
			try {
				data = await privacyApi('GET', { query: '?export=1' });
			} catch (e) {
				host.innerHTML = `<div class="irlpc-err"><span>${esc(e.message || 'Could not load your pins.')}</span></div>`;
				return;
			}
			const pins = Array.isArray(data?.pins) ? data.pins : [];
			if (!pins.length) {
				host.innerHTML = `<div class="irlpc-empty">No placed agents on this ${data.account === 'signed-in' ? 'account' : 'device'} yet.</div>`;
				return;
			}
			host.innerHTML = pins.map((p) => renderPinRow(p)).join('');
			host.querySelectorAll('[data-pin]').forEach((rowEl) => wirePinRow(rowEl));
		}

		function renderPinRow(p) {
			// `published === false` is PRIVATE: still yours to see in AR, withheld from
			// everyone else. `hidden_at` is the moderation/expiry hide — a pin taken out
			// of the world entirely — so a row is "private" only on the published flag.
			const priv = p.published === false;
			const name = p.avatar_name || p.caption || 'Placed agent';
			const sub = fmtDate(p.placed_at) + (p.expires_at ? ` · expires ${fmtDate(p.expires_at)}` : ' · permanent');
			return `
				<div class="irlpc-pin ${priv ? 'hidden' : ''}" data-pin="${esc(p.id)}" data-hidden="${priv}">
					<div class="pmeta">
						<div class="pname">${esc(name)}${priv ? '<span class="irlpc-tag">private</span>' : ''}</div>
						<div class="psub">${esc(sub)}${priv ? ' · only you can see this' : ''}</div>
					</div>
					<button class="irlpc-pinbtn" type="button" data-toggle
						title="${priv ? 'Let anyone standing here discover this agent' : 'Keep this agent visible to you, hidden from everyone else'}"
					>${priv ? 'Make public' : 'Make private'}</button>
					<button class="irlpc-pinbtn danger" type="button" data-del>Delete</button>
				</div>`;
		}

		function wirePinRow(rowEl) {
			const id = rowEl.getAttribute('data-pin');
			const toggleBtn = rowEl.querySelector('[data-toggle]');
			const delBtn = rowEl.querySelector('[data-del]');

			toggleBtn?.addEventListener('click', async () => {
				const wasPrivate = rowEl.getAttribute('data-hidden') === 'true';
				const action = wasPrivate ? 'republish' : 'unpublish';
				toggleBtn.disabled = true; toggleBtn.textContent = '…';
				try {
					const r = await privacyApi('PATCH', { body: { pinId: id, action } });
					const nowPrivate = r?.visibility === 'private';
					rowEl.setAttribute('data-hidden', String(nowPrivate));
					rowEl.classList.toggle('hidden', nowPrivate);
					toggleBtn.textContent = nowPrivate ? 'Make public' : 'Make private';
					const nameEl = rowEl.querySelector('.pname');
					const tag = nameEl.querySelector('.irlpc-tag');
					if (nowPrivate && !tag) nameEl.insertAdjacentHTML('beforeend', '<span class="irlpc-tag">private</span>');
					if (!nowPrivate && tag) tag.remove();
					toast(nowPrivate ? 'Only you can see this agent now' : 'Anyone standing here can discover this agent');
					onChanged?.();
				} catch (e) {
					toast(e.message || 'Could not update the pin', 'err');
					toggleBtn.textContent = wasPrivate ? 'Make public' : 'Make private';
				} finally {
					toggleBtn.disabled = false;
				}
			});

			delBtn?.addEventListener('click', async () => {
				delBtn.disabled = true; toggleBtn && (toggleBtn.disabled = true);
				try {
					const r = await privacyApi('DELETE', { body: { scope: 'pin', pinId: id } });
					rowEl.style.transition = 'opacity .2s, height .2s';
					rowEl.style.opacity = '0';
					setTimeout(() => {
						rowEl.remove();
						const host = sheet.querySelector('[data-pins]');
						if (host && !host.querySelector('[data-pin]')) {
							host.innerHTML = '<div class="irlpc-empty">No placed agents left on this device.</div>';
						}
					}, 200);
					toast(`Deleted${r?.deletedInteractions ? ` (and ${r.deletedInteractions} encounter${r.deletedInteractions === 1 ? '' : 's'})` : ''}`);
					onChanged?.();
				} catch (e) {
					toast(e.message || 'Could not delete the pin', 'err');
					delBtn.disabled = false; toggleBtn && (toggleBtn.disabled = false);
				}
			});
		}

		async function onExport() {
			const btn = sheet.querySelector('[data-export]');
			if (btn) { btn.disabled = true; }
			try {
				const data = await privacyApi('GET', { query: '?export=1' });
				const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
				const url = URL.createObjectURL(blob);
				const a = document.createElement('a');
				a.href = url;
				a.download = 'irl-my-data.json';
				document.body.appendChild(a);
				a.click();
				a.remove();
				setTimeout(() => URL.revokeObjectURL(url), 1000);
				toast('Your data is downloading');
			} catch (e) {
				toast(e.message || 'Export failed', 'err');
			} finally {
				if (btn) btn.disabled = false;
			}
		}

		async function onDestructive(scope) {
			const isDevice = scope === 'device';
			const ok = await typedConfirm({
				title: isDevice ? 'Forget this device?' : 'Remove all your pins?',
				body: isDevice
					? 'This permanently deletes every agent you placed and every tap or message this device left anywhere. It cannot be undone.'
					: 'This permanently deletes every agent you placed and the encounters on them. It cannot be undone.',
				word: isDevice ? 'forget' : 'delete',
				goLabel: isDevice ? 'Forget device' : 'Remove all',
			});
			if (!ok) return;
			try {
				const r = await privacyApi('DELETE', { body: { scope } });
				const n = r?.deletedPins || 0;
				const ic = r?.deletedInteractions || 0;
				toast(`Removed ${n} pin${n === 1 ? '' : 's'}${ic ? ` and ${ic} encounter${ic === 1 ? '' : 's'}` : ''}`);
				onChanged?.();
				load(); // refresh — the summary should now read empty
			} catch (e) {
				toast(e.message || 'Could not complete that', 'err');
			}
		}

		load();
	});
}

// ── First-run disclosure (shown once, the first time location is granted) ────
export function maybeShowFirstRunDisclosure() {
	let already = false;
	try { already = localStorage.getItem(DISCLOSED_KEY) === '1'; } catch {}
	if (already) return;
	try { localStorage.setItem(DISCLOSED_KEY, '1'); } catch {}

	modal((sheet, close) => {
		sheet.setAttribute('aria-label', 'How location works here');
		sheet.innerHTML = `
			<div class="irlpc-head">
				<div class="irlpc-title">How location works here</div>
				<button class="irlpc-x" type="button" data-close aria-label="Close">×</button>
			</div>
			<div class="irlpc-sec">${factsHTML()}</div>
			<div class="irlpc-foot">
				<button class="irlpc-done" type="button" data-close>Got it</button>
				<a class="irlpc-learn" href="/irl-privacy" target="_blank" rel="noopener">Learn more <span class="ar" aria-hidden="true">↗</span></a>
			</div>`;
		sheet.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
		setTimeout(() => sheet.querySelector('.irlpc-done')?.focus(), 60);
	}, { extraClass: 'irlpc-discl' });
}
