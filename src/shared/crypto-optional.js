// three.ws — "crypto is optional" messaging.
//
// One reusable component, one canonical copy, used on every top entry surface
// (homepage, /features, the create flow, the dashboard first-run). It surfaces
// the truth that the core product works with no wallet, and frames every crypto
// feature as an explicit opt-in.
//
// Two pieces:
//   1. A reassurance banner — "No crypto required to start." Mounts wherever a
//      `[data-crypto-optional]` element exists. The attribute value picks a
//      variant: "" / "banner" (full), "compact" (one line), "hero" (bare line).
//   2. An "Optional" tag for any individual crypto action — a pill + one-line
//      plain benefit + a "?" whose tooltip explains it. Drop a
//      `[data-crypto-optional-badge]` element (with `data-benefit`, optional
//      `data-tip`) and it gets decorated, or call twsCryptoOptional.tagHTML().
//
// Self-contained: injects its own scoped styles so it renders identically
// whether or not the host page loads style.css. Works as a classic <script>
// (self-mounts) and as an ES module (import the HTML helpers for JS-rendered
// surfaces like the dashboard). Honours <html data-crypto-optional="off">.

const LEAD = 'No crypto needed to start';
const BODY =
	'The 3D web component, dashboard, and API all work without a wallet. ' +
	'Crypto is optional — connect one only when you want on-chain identity, ' +
	'payable skills, or payouts.';
const COMPACT_TAIL = "it's optional.";
// The plain-English answer behind every "Optional / what's this?" affordance.
const WHATS =
	'Connecting a wallet is never required to use three.ws. It only unlocks ' +
	'opt-in extras: a verifiable on-chain identity for your agent, charging ' +
	'for skills, and receiving payouts. Skip it and everything else works.';
const LEARN_HREF = '/pricing#no-crypto';

// Lock-open glyph — signals "this gate is open, you may pass without crypto".
const ICON =
	'<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" ' +
	'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
	'<rect x="4" y="9" width="12" height="8" rx="2"/>' +
	'<path d="M7 9V6.5A3 3 0 0 1 12.8 5.5"/><circle cx="10" cy="13" r="1.2"/></svg>';

const esc = (s) =>
	String(s == null ? '' : s).replace(/[&<>"]/g, (c) => (
		{ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
	));

/** Reassurance banner markup. variant: 'banner' | 'compact' | 'hero'. */
export function cryptoOptionalBannerHTML(variant = 'banner') {
	const learn =
		`<a class="tws-copt-learn" href="${LEARN_HREF}">What's this?</a>`;

	if (variant === 'hero') {
		return (
			`<p class="tws-copt tws-copt--hero" role="note">` +
			`<span class="tws-copt-ico">${ICON}</span>` +
			`<span><strong>${esc(LEAD)}</strong> — ${COMPACT_TAIL}</span>` +
			`${learn}</p>`
		);
	}
	if (variant === 'compact') {
		return (
			`<div class="tws-copt tws-copt--compact" role="note">` +
			`<span class="tws-copt-ico">${ICON}</span>` +
			`<span class="tws-copt-compact-text">` +
			`<strong>${esc(LEAD)}</strong> — ${COMPACT_TAIL}</span>` +
			`${learn}</div>`
		);
	}
	return (
		`<div class="tws-copt tws-copt--banner" role="note">` +
		`<span class="tws-copt-ico">${ICON}</span>` +
		`<span class="tws-copt-body">` +
		`<strong class="tws-copt-lead">${esc(LEAD)}.</strong> ` +
		`<span class="tws-copt-sub">${esc(BODY)}</span></span>` +
		`${learn}</div>`
	);
}

/**
 * "Optional" tag for a single crypto action.
 * @param {string} benefit  one-line plain benefit (e.g. "Get an on-chain identity")
 * @param {string} [tip]    longer "what's this?" explanation (defaults to WHATS)
 */
export function cryptoOptionalTagHTML(benefit, tip) {
	return (
		`<span class="tws-copt-tag" role="note">` +
		`<span class="tws-copt-tag-pill">Optional</span>` +
		(benefit ? `<span class="tws-copt-tag-benefit">${esc(benefit)}</span>` : '') +
		`<button type="button" class="tws-copt-tag-q" aria-label="What's this?" ` +
		`data-copt-tip="${esc(tip || WHATS)}">?</button>` +
		`</span>`
	);
}

// ── Self-contained styles ────────────────────────────────────────────────────
const STYLE_ID = 'tws-copt-styles';
const CSS = `
.tws-copt{box-sizing:border-box;font-family:var(--font-body,'Inter',system-ui,sans-serif)}
.tws-copt *,.tws-copt *::before{box-sizing:border-box}
.tws-copt-ico{display:inline-flex;flex:none;color:rgba(255,255,255,.62)}
.tws-copt-learn{flex:none;color:rgba(255,255,255,.62);font-size:12px;font-weight:500;
	text-decoration:underline;text-decoration-color:rgba(255,255,255,.28);text-underline-offset:2px;
	white-space:nowrap;transition:color .15s ease,text-decoration-color .15s ease}
.tws-copt-learn:hover{color:#fff;text-decoration-color:rgba(255,255,255,.6)}
.tws-copt-learn:focus-visible{outline:2px solid rgba(255,255,255,.5);outline-offset:2px;border-radius:4px}

/* Full banner */
.tws-copt--banner{display:flex;align-items:flex-start;gap:11px;padding:13px 15px;
	background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.10);
	border-radius:12px;line-height:1.5}
.tws-copt--banner .tws-copt-ico{margin-top:1px}
.tws-copt-body{flex:1;min-width:0;font-size:13px;color:rgba(255,255,255,.62)}
.tws-copt-lead{color:rgba(255,255,255,.92);font-weight:600}
.tws-copt-sub{color:rgba(255,255,255,.58)}
.tws-copt--banner .tws-copt-learn{margin-top:1px}

/* Compact one-line */
.tws-copt--compact{display:inline-flex;align-items:center;gap:9px;padding:8px 13px;
	background:rgba(255,255,255,.035);border:1px solid rgba(255,255,255,.10);
	border-radius:999px;font-size:12.5px;color:rgba(255,255,255,.6);max-width:100%}
.tws-copt-compact-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tws-copt-compact-text strong{color:rgba(255,255,255,.9);font-weight:600}

/* Bare hero line */
.tws-copt--hero{display:inline-flex;align-items:center;gap:8px;margin:0;
	font-size:13px;color:rgba(255,255,255,.55)}
.tws-copt--hero strong{color:rgba(255,255,255,.82);font-weight:600}
.tws-copt--hero .tws-copt-ico{color:rgba(255,255,255,.5)}

/* "Optional" action tag */
.tws-copt-tag{display:inline-flex;align-items:center;gap:7px;vertical-align:middle;
	font-family:var(--font-body,'Inter',system-ui,sans-serif);line-height:1.2}
.tws-copt-tag-pill{flex:none;font-size:10px;font-weight:600;letter-spacing:.04em;
	text-transform:uppercase;padding:2px 7px;border-radius:999px;
	color:rgba(255,255,255,.7);background:rgba(255,255,255,.07);
	border:1px solid rgba(255,255,255,.14)}
.tws-copt-tag-benefit{font-size:12px;color:rgba(255,255,255,.55)}
.tws-copt-tag-q{flex:none;width:15px;height:15px;padding:0;border-radius:50%;cursor:help;
	font-size:9px;line-height:1;font-weight:700;display:inline-flex;align-items:center;
	justify-content:center;color:rgba(255,255,255,.5);background:rgba(255,255,255,.08);
	border:0;position:relative;transition:background .12s ease,color .12s ease}
.tws-copt-tag-q:hover,.tws-copt-tag-q:focus-visible{background:rgba(255,255,255,.2);color:#fff}
.tws-copt-tag-q:focus-visible{outline:2px solid rgba(255,255,255,.5);outline-offset:2px}
/* Self-contained tooltip — no dependency on the glossary system */
.tws-copt-tag-q::after{content:attr(data-copt-tip);position:absolute;left:50%;bottom:calc(100% + 9px);
	transform:translateX(-50%) translateY(4px);width:max-content;max-width:260px;
	padding:9px 12px;border-radius:10px;background:rgba(12,13,18,.98);
	border:1px solid rgba(255,255,255,.14);box-shadow:0 8px 28px rgba(0,0,0,.55);
	color:rgba(255,255,255,.82);font-size:11.5px;font-weight:400;line-height:1.5;
	text-transform:none;letter-spacing:0;text-align:left;white-space:normal;
	opacity:0;pointer-events:none;transition:opacity .14s ease,transform .14s ease;z-index:10000}
.tws-copt-tag-q:hover::after,.tws-copt-tag-q:focus-visible::after{opacity:1;transform:translateX(-50%) translateY(0)}
@media (max-width:560px){.tws-copt-tag-q::after{max-width:200px}}

@media (pointer:coarse){
	.tws-copt-learn{display:inline-flex;align-items:center;min-height:44px;margin:-12px 0}
	.tws-copt--banner .tws-copt-learn{margin:-12px 0}
}

@media (prefers-reduced-motion:reduce){
	.tws-copt-learn,.tws-copt-tag-q,.tws-copt-tag-q::after{transition:none}
}`;

export function injectStyles() {
	if (typeof document === 'undefined') return;
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = CSS;
	document.head.appendChild(style);
}

// ── Self-mount on static pages ───────────────────────────────────────────────
function mountAll() {
	if (typeof document === 'undefined') return;
	if (document.documentElement.getAttribute('data-crypto-optional') === 'off') return;

	injectStyles();

	document.querySelectorAll('[data-crypto-optional]').forEach((el) => {
		if (el === document.documentElement || el.dataset.coptMounted) return;
		el.dataset.coptMounted = '1';
		const variant = el.getAttribute('data-crypto-optional') || 'banner';
		el.innerHTML = cryptoOptionalBannerHTML(variant);
	});

	document.querySelectorAll('[data-crypto-optional-badge]').forEach((el) => {
		if (el.dataset.coptMounted) return;
		el.dataset.coptMounted = '1';
		el.innerHTML = cryptoOptionalTagHTML(
			el.getAttribute('data-benefit') || '',
			el.getAttribute('data-tip') || '',
		);
	});
}

if (typeof window !== 'undefined') {
	window.twsCryptoOptional = {
		bannerHTML: cryptoOptionalBannerHTML,
		tagHTML: cryptoOptionalTagHTML,
		injectStyles,
		mount: mountAll,
	};
	if (typeof document !== 'undefined') {
		if (document.readyState === 'loading') {
			document.addEventListener('DOMContentLoaded', mountAll, { once: true });
		} else {
			mountAll();
		}
	}
}
