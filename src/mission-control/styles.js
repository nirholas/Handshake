/**
 * Mission Control — styles. One injected stylesheet, built entirely on the
 * platform design tokens (public/tokens.css) with safe fallbacks so the cockpit
 * themes correctly in dark and light. Bloomberg-grade density, Linear-grade
 * polish: tabular numerics, hairline strokes, intentional motion, full
 * reduced-motion + focus-ring support.
 */

const STYLE_ID = 'mission-control-style';

const CSS = `
.mc-root {
	--mc-gap: var(--space-3, 12px);
	--mc-pos: var(--success, #4ade80);
	--mc-neg: var(--danger, #f87171);
	--mc-radius: var(--radius-md, 10px);
	position: fixed; inset: 0; display: flex; flex-direction: column;
	background: var(--bg-0, #0a0a0b); color: var(--ink, #e8e8e8);
	font-family: var(--font-sans, system-ui, sans-serif);
	font-size: var(--text-md, .8125rem);
	-webkit-font-smoothing: antialiased; overflow: hidden;
}
.mc-root *, .mc-root *::before, .mc-root *::after { box-sizing: border-box; }
.mc-num { font-variant-numeric: tabular-nums; font-feature-settings: 'tnum' 1; }
.mc-mono { font-family: var(--font-mono, ui-monospace, monospace); }

/* ── top bar ─────────────────────────────────────────────────────────────── */
.mc-topbar { display: flex; align-items: center; gap: var(--space-3,12px); padding: 8px 14px; border-bottom: 1px solid var(--stroke, rgba(255,255,255,.08)); background: var(--surface-1, rgba(255,255,255,.02)); flex: none; min-height: 50px; }
.mc-brand { display: flex; align-items: center; gap: 9px; font-weight: 700; color: var(--ink-bright, #fff); letter-spacing: .02em; text-decoration: none; white-space: nowrap; }
.mc-brand-logo { width: 22px; height: 22px; border-radius: 6px; }
.mc-brand h1 { margin: 0; font-family: var(--font-display, system-ui); font-size: var(--text-md,.8125rem); font-weight: 700; line-height: 1; }
.mc-brand span { color: var(--ink-dim,#888); font-weight: 600; font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .08em; padding: 2px 6px; border: 1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-pill,999px); }
.mc-topbar-spacer { flex: 1 1 auto; }
.mc-conn-group { display: flex; align-items: center; gap: 10px; }
.mc-topbar lang-switcher { display: inline-flex; align-items: center; min-width: 0; }
.mc-conn { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); white-space: nowrap; }
.mc-conn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ink-faint,#8a8a8a); flex: none; transition: background var(--duration-fast,140ms); }
.mc-conn[data-state="live"] .mc-conn-dot { background: var(--success,#4ade80); box-shadow: 0 0 6px color-mix(in srgb, var(--success,#4ade80) 70%, transparent); animation: mc-breathe 2.4s ease-in-out infinite; }
.mc-conn[data-state="reconnecting"] .mc-conn-dot { background: var(--warn,#fbbf24); animation: mc-pulse 1s ease-in-out infinite; }
.mc-conn[data-state="down"] .mc-conn-dot { background: var(--danger,#f87171); }
/* Idle dims the dot, never the label: at 11px the label needs the full
   --ink-dim to clear 4.5:1 on the bar, and a whole-chip opacity of .55 put
   "Positions" at 2.41:1 (the a11y floor caught it on /terminal). */
.mc-conn[data-state="idle"] .mc-conn-dot { background: var(--ink-faint,#8a8a8a); opacity: .55; }
.mc-ctrl { display: inline-flex; align-items: center; gap: 6px; }
.mc-select, .mc-iconbtn { font: inherit; font-size: var(--text-sm,.764rem); color: var(--ink,#e8e8e8); background: var(--surface-2, rgba(255,255,255,.05)); border: 1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-sm,6px); padding: 5px 9px; cursor: pointer; }
.mc-select:hover, .mc-iconbtn:hover { border-color: var(--stroke-strong, rgba(255,255,255,.18)); }
.mc-select:focus-visible, .mc-iconbtn:focus-visible, .mc-row:focus-visible, .mc-tab:focus-visible, .mc-chipbtn:focus-visible, .mc-size:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#7dd3fc); outline-offset: 2px; }
.mc-iconbtn { display: inline-grid; place-items: center; min-width: 30px; height: 30px; padding: 0 8px; }
.mc-balance { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); white-space: nowrap; }
.mc-balance b { color: var(--ink-bright,#fff); font-variant-numeric: tabular-nums; }

/* ── grid ────────────────────────────────────────────────────────────────── */
.mc-main { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: minmax(300px, 1.05fr) minmax(360px, 1.5fr) minmax(280px, 1fr); gap: 1px; background: var(--stroke, rgba(255,255,255,.07)); }
.mc-pane { background: var(--bg-0, #0a0a0b); min-height: 0; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.mc-pane-head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--stroke,rgba(255,255,255,.07)); flex: none; }
.mc-pane-title { font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .07em; color: var(--ink-dim,#888); font-weight: 700; }
.mc-pane-count { font-size: var(--text-2xs,.6875rem); color: var(--ink-faint,#8a8a8a); font-variant-numeric: tabular-nums; }
.mc-pane-head-spacer { flex: 1 1 auto; }
.mc-pane-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; scrollbar-color: var(--stroke-strong,rgba(255,255,255,.18)) transparent; position: relative; }

/* ── source / filter strip ───────────────────────────────────────────────── */
.mc-tabs { display: flex; gap: 2px; }
.mc-tab { appearance: none; font: inherit; font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm,6px); padding: 3px 9px; cursor: pointer; transition: color var(--duration-fast,140ms), background var(--duration-fast,140ms); }
.mc-tab:hover { color: var(--ink,#e8e8e8); background: var(--surface-1,rgba(255,255,255,.04)); }
.mc-tab[aria-selected="true"] { color: var(--ink-bright,#fff); background: var(--surface-2,rgba(255,255,255,.06)); border-color: var(--stroke,rgba(255,255,255,.1)); }
.mc-filterbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 7px 12px; border-bottom: 1px solid var(--stroke,rgba(255,255,255,.07)); flex: none; }
.mc-search { flex: 1 1 120px; min-width: 90px; font: inherit; font-size: var(--text-sm,.764rem); color: var(--ink,#e8e8e8); background: var(--surface-1,rgba(255,255,255,.04)); border: 1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-sm,6px); padding: 5px 8px; }
.mc-search:focus-visible { outline: none; border-color: var(--accent,#7dd3fc); }
.mc-chipbtn { appearance: none; font: inherit; font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); background: var(--surface-1,rgba(255,255,255,.04)); border: 1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-pill,999px); padding: 3px 9px; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; transition: all var(--duration-fast,140ms); }
.mc-chipbtn:hover { color: var(--ink,#e8e8e8); border-color: var(--stroke-strong,rgba(255,255,255,.18)); }
.mc-chipbtn[aria-pressed="true"], .mc-chipbtn.is-active { color: var(--ink-bright,#fff); background: color-mix(in srgb, var(--accent,#7dd3fc) 18%, transparent); border-color: color-mix(in srgb, var(--accent,#7dd3fc) 50%, transparent); }
.mc-views { margin-left: auto; display: inline-flex; gap: 6px; align-items: center; }

/* ── feed rows (virtualized) ─────────────────────────────────────────────── */
.mc-vlist { position: relative; width: 100%; }
.mc-vlist-spacer { position: absolute; inset: 0; pointer-events: none; }
.mc-row { position: absolute; left: 0; right: 0; display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; align-items: center; padding: 7px 12px; border-bottom: 1px solid var(--stroke,rgba(255,255,255,.05)); cursor: pointer; text-align: left; appearance: none; background: transparent; font: inherit; color: inherit; width: 100%; transition: background var(--duration-fast,140ms); content-visibility: auto; }
.mc-row:hover { background: var(--surface-1,rgba(255,255,255,.035)); }
.mc-row[aria-selected="true"] { background: color-mix(in srgb, var(--accent,#7dd3fc) 12%, transparent); box-shadow: inset 2px 0 0 var(--accent,#7dd3fc); }
.mc-row-top { display: flex; align-items: center; gap: 7px; min-width: 0; grid-column: 1; }
.mc-row-sym { font-weight: 700; color: var(--ink-bright,#fff); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 9ch; }
.mc-row-name { color: var(--ink-dim,#888); font-size: var(--text-sm,.764rem); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.mc-row-age { grid-column: 2; grid-row: 1; color: var(--ink-faint,#8a8a8a); font-size: var(--text-2xs,.6875rem); font-variant-numeric: tabular-nums; white-space: nowrap; justify-self: end; }
.mc-row-meta { grid-column: 1 / -1; grid-row: 2; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mc-row-mc { color: var(--ink,#cfcfcf); font-size: var(--text-2xs,.6875rem); font-variant-numeric: tabular-nums; }
.mc-row-mc b { color: var(--ink-bright,#fff); }
.mc-enter { animation: mc-rowin var(--duration-base,260ms) var(--ease-out, cubic-bezier(.22,1,.36,1)); }

/* chips */
.mc-chip { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-2xs,.6875rem); font-weight: 700; padding: 1px 6px; border-radius: var(--radius-sm,5px); line-height: 1.5; white-space: nowrap; border: 1px solid transparent; font-variant-numeric: tabular-nums; }
.mc-chip--allow { color: var(--success,#4ade80); background: color-mix(in srgb, var(--success,#4ade80) 13%, transparent); border-color: color-mix(in srgb, var(--success,#4ade80) 32%, transparent); }
.mc-chip--warn { color: var(--warn,#fbbf24); background: color-mix(in srgb, var(--warn,#fbbf24) 13%, transparent); border-color: color-mix(in srgb, var(--warn,#fbbf24) 32%, transparent); }
.mc-chip--block { color: var(--danger,#f87171); background: color-mix(in srgb, var(--danger,#f87171) 13%, transparent); border-color: color-mix(in srgb, var(--danger,#f87171) 36%, transparent); }
.mc-chip--unknown { color: var(--ink-faint,#8a8a8a); background: var(--surface-1,rgba(255,255,255,.04)); border-color: var(--stroke,rgba(255,255,255,.08)); }
.mc-chip--intel { color: var(--ink,#e8e8e8); background: var(--surface-2,rgba(255,255,255,.06)); border-color: var(--stroke,rgba(255,255,255,.1)); }
.mc-chip--smart { color: var(--accent,#7dd3fc); background: color-mix(in srgb, var(--accent,#7dd3fc) 12%, transparent); border-color: color-mix(in srgb, var(--accent,#7dd3fc) 30%, transparent); }
.mc-chip-skel { width: 38px; height: 15px; border-radius: 5px; background: var(--surface-2,rgba(255,255,255,.05)); animation: mc-skel 1.3s ease-in-out infinite; }

/* ── positions ───────────────────────────────────────────────────────────── */
.mc-poss { display: flex; flex-direction: column; }
.mc-pos { display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; padding: 8px 12px; border-bottom: 1px solid var(--stroke,rgba(255,255,255,.05)); align-items: center; }
.mc-pos-sym { font-weight: 700; color: var(--ink-bright,#fff); display: flex; align-items: center; gap: 6px; min-width: 0; }
.mc-pos-sym .mc-pos-name { color: var(--ink-dim,#888); font-weight: 400; font-size: var(--text-sm,.764rem); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mc-pos-pnl { justify-self: end; text-align: right; font-variant-numeric: tabular-nums; font-weight: 700; }
.mc-pos-sub { grid-column: 1; color: var(--ink-faint,#8a8a8a); font-size: var(--text-2xs,.6875rem); font-variant-numeric: tabular-nums; }
.mc-pos-actions { grid-column: 2; justify-self: end; display: flex; gap: 6px; }
.mc-pos.pos .mc-pos-pnl { color: var(--mc-pos); } .mc-pos.neg .mc-pos-pnl { color: var(--mc-neg); } .mc-pos.flat .mc-pos-pnl { color: var(--ink-dim,#888); }
.mc-pos--closed { opacity: .62; }
.mc-flash-pos { animation: mc-flashpos .8s ease-out; } .mc-flash-neg { animation: mc-flashneg .8s ease-out; }
.mc-pos-summary { display: flex; gap: 14px; padding: 9px 12px; border-bottom: 1px solid var(--stroke,rgba(255,255,255,.07)); flex: none; flex-wrap: wrap; }
.mc-pos-summary div { display: flex; flex-direction: column; gap: 1px; }
.mc-pos-summary span { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); text-transform: uppercase; letter-spacing: .05em; }
.mc-pos-summary b { font-size: var(--text-md,.8125rem); font-variant-numeric: tabular-nums; color: var(--ink-bright,#fff); }

/* ── focus / detail ──────────────────────────────────────────────────────── */
.mc-focus { padding: 14px; display: flex; flex-direction: column; gap: 14px; }
.mc-focus-head { display: flex; align-items: flex-start; gap: 12px; }
.mc-focus-img { width: 48px; height: 48px; border-radius: var(--radius-md,10px); object-fit: cover; background: var(--surface-2,rgba(255,255,255,.05)); border: 1px solid var(--stroke,rgba(255,255,255,.08)); flex: none; }
.mc-focus-id { min-width: 0; flex: 1 1 auto; }
.mc-focus-id h2 { margin: 0; font-size: var(--text-lg,1.236rem); color: var(--ink-bright,#fff); font-family: var(--font-display,system-ui); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.mc-focus-id .mc-focus-name { color: var(--ink-dim,#888); font-size: var(--text-md,.8125rem); }
.mc-focus-addr { display: inline-flex; align-items: center; gap: 6px; margin-top: 5px; font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); }
.mc-focus-addr a { color: inherit; text-decoration: none; border-bottom: 1px dotted currentColor; }
.mc-focus-socials { display: inline-flex; gap: 8px; margin-top: 6px; }
.mc-focus-socials a { color: var(--ink-dim,#888); text-decoration: none; font-size: var(--text-sm,.764rem); border: 1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-sm,6px); padding: 2px 8px; }
.mc-focus-socials a:hover { color: var(--ink-bright,#fff); border-color: var(--stroke-strong,rgba(255,255,255,.2)); }
.mc-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); gap: 1px; background: var(--stroke,rgba(255,255,255,.07)); border: 1px solid var(--stroke,rgba(255,255,255,.07)); border-radius: var(--mc-radius); overflow: hidden; }
.mc-stat { background: var(--surface-1,rgba(255,255,255,.02)); padding: 9px 11px; display: flex; flex-direction: column; gap: 2px; }
.mc-stat span { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); text-transform: uppercase; letter-spacing: .05em; }
.mc-stat b { font-size: var(--text-md,.8125rem); color: var(--ink-bright,#fff); font-variant-numeric: tabular-nums; }
.mc-section-h { font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .07em; color: var(--ink-dim,#888); font-weight: 700; margin: 0 0 8px; }
.mc-chart-wrap { border: 1px solid var(--stroke,rgba(255,255,255,.07)); border-radius: var(--mc-radius); padding: 10px 12px 8px; background: var(--surface-1,rgba(255,255,255,.02)); }
.mc-chart { display: flex; flex-direction: column; gap: 8px; }
.mc-chart-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 20px; }
.mc-chart-legend { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
.mc-chart-legend .mc-section-h { margin: 0; }
.mc-chart-px { font-size: var(--text-md,.8125rem); font-weight: 700; color: var(--ink-bright,#fff); font-variant-numeric: tabular-nums; font-family: var(--font-mono, ui-monospace, monospace); }
.mc-chart-chg { font-size: var(--text-2xs,.6875rem); font-variant-numeric: tabular-nums; font-weight: 700; }
.mc-chart-chg.pos { color: var(--success,#4ade80); } .mc-chart-chg.neg { color: var(--danger,#f87171); }
.mc-chart-ohlc { font-size: var(--text-2xs,.6875rem); color: var(--ink-faint,#8a8a8a); font-variant-numeric: tabular-nums; font-family: var(--font-mono, ui-monospace, monospace); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mc-chart-ohlc b { color: var(--ink-dim,#999); font-weight: 600; }
.mc-chart-right { display: flex; align-items: center; gap: 10px; flex: none; }
.mc-chart-live { display: inline-flex; align-items: center; gap: 5px; font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-faint,#8a8a8a); font-weight: 700; transition: color var(--duration-fast,140ms); }
.mc-chart-live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ink-faint,#8a8a8a); transition: background var(--duration-fast,140ms); }
.mc-chart-live[data-state="on"] { color: var(--success,#4ade80); }
.mc-chart-live[data-state="on"] .mc-chart-live-dot { background: var(--success,#4ade80); box-shadow: 0 0 6px color-mix(in srgb, var(--success,#4ade80) 70%, transparent); animation: mc-breathe 2.4s ease-in-out infinite; }
.mc-chart-ivs { display: inline-flex; gap: 2px; background: var(--surface-2,rgba(255,255,255,.04)); border: 1px solid var(--stroke,rgba(255,255,255,.08)); border-radius: var(--radius-sm,6px); padding: 2px; }
.mc-chart-iv { appearance: none; font: inherit; font-size: var(--text-2xs,.6875rem); font-weight: 600; color: var(--ink-dim,#888); background: transparent; border: 0; border-radius: 4px; padding: 2px 7px; cursor: pointer; transition: color var(--duration-fast,140ms), background var(--duration-fast,140ms); }
.mc-chart-iv:hover { color: var(--ink,#e8e8e8); }
.mc-chart-iv[aria-selected="true"] { color: var(--ink-bright,#fff); background: color-mix(in srgb, var(--accent,#7dd3fc) 22%, transparent); }
.mc-chart-iv:focus-visible { outline: 2px solid var(--accent,#7dd3fc); outline-offset: 1px; }
.mc-chart-body { position: relative; width: 100%; height: 240px; }
.mc-chart-canvas { position: absolute; inset: 0; }
.mc-chart-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--ink-faint,#8a8a8a); font-size: var(--text-sm,.764rem); pointer-events: none; text-align: center; padding: 0 12px; }
.mc-smart-bar { height: 8px; border-radius: 999px; background: var(--surface-2,rgba(255,255,255,.06)); overflow: hidden; }
.mc-smart-bar > i { display: block; height: 100%; background: linear-gradient(90deg, var(--accent,#7dd3fc), var(--success,#4ade80)); border-radius: 999px; transition: width var(--duration-base,260ms) var(--ease-out,ease); }
.mc-smart-wallets { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.mc-smart-wallets li { display: flex; align-items: center; gap: 8px; font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); }
.mc-smart-wallets b { color: var(--ink,#e8e8e8); font-variant-numeric: tabular-nums; }

/* ── focus section tabs (Trades / Security / Smart Money) ────────────────── */
.mc-focus-tabs { display: flex; gap: 2px; background: var(--surface-2,rgba(255,255,255,.04)); border: 1px solid var(--stroke,rgba(255,255,255,.08)); border-radius: 8px; padding: 2px; margin-bottom: 8px; }
.mc-focus-tab { appearance: none; font: inherit; font-size: var(--text-2xs,.6875rem); font-weight: 600; color: var(--ink-dim,#888); background: transparent; border: 0; border-radius: 5px; padding: 3px 10px; cursor: pointer; transition: color var(--duration-fast,140ms), background var(--duration-fast,140ms); }
.mc-focus-tab:hover { color: var(--ink,#e8e8e8); }
.mc-focus-tab[aria-selected="true"] { color: var(--ink-bright,#fff); background: color-mix(in srgb, var(--accent,#7dd3fc) 22%, transparent); }
.mc-focus-tab:focus-visible { outline: 2px solid var(--accent,#7dd3fc); outline-offset: 1px; }
.mc-focus-tabpanel[hidden] { display: none; }

/* ── live trades tape ────────────────────────────────────────────────────── */
.mc-tape-wrap { display: flex; flex-direction: column; min-height: 0; }
.mc-tape-head { display: grid; grid-template-columns: 36px 44px 62px 1fr 62px 72px; gap: 0 6px; padding: 4px 8px; font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .05em; color: var(--ink-faint,#8a8a8a); border-bottom: 1px solid var(--stroke,rgba(255,255,255,.06)); font-weight: 700; }
.mc-tape-body { overflow-y: auto; max-height: 220px; display: flex; flex-direction: column; }
.mc-tape-row { display: grid; grid-template-columns: 36px 44px 62px 1fr 62px 72px; gap: 0 6px; padding: 4px 8px; font-size: var(--text-2xs,.6875rem); font-variant-numeric: tabular-nums; border-bottom: 1px solid var(--stroke,rgba(255,255,255,.04)); transition: background var(--duration-fast,140ms); align-items: center; animation: mc-rowin var(--duration-base,200ms) var(--ease-out,ease); }
.mc-tape-row:hover { background: var(--surface-1,rgba(255,255,255,.03)); }
.mc-tape-row--buy { color: var(--ink-dim,#aaa); }
.mc-tape-row--buy .mc-tape-type a, .mc-tape-row--buy .mc-tape-type { color: var(--success,#4ade80); font-weight: 700; }
.mc-tape-row--sell .mc-tape-type a, .mc-tape-row--sell .mc-tape-type { color: var(--danger,#f87171); font-weight: 700; }
.mc-tape-row a { text-decoration: none; color: inherit; }
.mc-tape-row a:hover { text-decoration: underline; }
.mc-tape-col-amt { color: var(--ink-dim,#999); }
.mc-tape-empty { padding: 18px 12px; color: var(--ink-faint,#8a8a8a); font-size: var(--text-sm,.764rem); text-align: center; }

/* ── token security grid (GMGN-style stats) ──────────────────────────────── */
.mc-sec-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--stroke,rgba(255,255,255,.07)); border: 1px solid var(--stroke,rgba(255,255,255,.07)); border-radius: var(--mc-radius); overflow: hidden; margin-bottom: 10px; }
.mc-sec-cell { background: var(--surface-1,rgba(255,255,255,.02)); padding: 8px 10px; display: flex; flex-direction: column; gap: 2px; }
.mc-sec-cell span { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); text-transform: uppercase; letter-spacing: .04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mc-sec-cell b { font-size: var(--text-sm,.764rem); color: var(--ink-bright,#fff); font-variant-numeric: tabular-nums; }
.mc-sec-cell b.warn { color: var(--warn,#fbbf24); }
.mc-sec-cell b.danger { color: var(--danger,#f87171); }
.mc-sec-cell b.ok { color: var(--success,#4ade80); }
.mc-sec-checks { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
.mc-sec-check { display: inline-flex; align-items: center; gap: 4px; font-size: var(--text-2xs,.6875rem); padding: 2px 8px; border-radius: var(--radius-pill,999px); font-weight: 600; border: 1px solid transparent; }
.mc-sec-check--ok { color: var(--success,#4ade80); background: color-mix(in srgb, var(--success,#4ade80) 10%, transparent); border-color: color-mix(in srgb, var(--success,#4ade80) 28%, transparent); }
.mc-sec-check--warn { color: var(--warn,#fbbf24); background: color-mix(in srgb, var(--warn,#fbbf24) 10%, transparent); border-color: color-mix(in srgb, var(--warn,#fbbf24) 28%, transparent); }
.mc-sec-check--fail { color: var(--danger,#f87171); background: color-mix(in srgb, var(--danger,#f87171) 10%, transparent); border-color: color-mix(in srgb, var(--danger,#f87171) 28%, transparent); }
.mc-sec-check--dim { color: var(--ink-faint,#8a8a8a); background: var(--surface-2,rgba(255,255,255,.04)); border-color: var(--stroke,rgba(255,255,255,.08)); }
.mc-sec-flags { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 5px; }
.mc-sec-flags li { font-size: var(--text-2xs,.6875rem); color: var(--warn,#fbbf24); background: color-mix(in srgb, var(--warn,#fbbf24) 8%, transparent); border: 1px solid color-mix(in srgb, var(--warn,#fbbf24) 24%, transparent); border-radius: var(--radius-pill,999px); padding: 2px 8px; }

/* ── trade panel ─────────────────────────────────────────────────────────── */
.mc-trade { border: 1px solid var(--stroke,rgba(255,255,255,.08)); border-radius: var(--radius-lg,14px); background: var(--surface-1,rgba(255,255,255,.025)); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.mc-sizes { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.mc-size { appearance: none; font: inherit; font-size: var(--text-sm,.764rem); font-variant-numeric: tabular-nums; color: var(--ink,#e8e8e8); background: var(--surface-2,rgba(255,255,255,.05)); border: 1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-sm,6px); padding: 5px 11px; cursor: pointer; min-width: 30px; }
.mc-size[aria-pressed="true"] { color: #08121b; background: var(--accent,#7dd3fc); border-color: var(--accent,#7dd3fc); font-weight: 700; }
.mc-size-kbd { color: var(--ink-faint,#8a8a8a); font-size: .85em; margin-left: 3px; }
.mc-trade-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.mc-btn { appearance: none; font: inherit; font-size: var(--text-md,.8125rem); font-weight: 700; border-radius: var(--radius-md,10px); padding: 10px 14px; cursor: pointer; border: 1px solid transparent; transition: transform var(--duration-instant,80ms), background var(--duration-fast,140ms), opacity var(--duration-fast,140ms); display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
.mc-btn:active:not(:disabled) { transform: translateY(1px); }
.mc-btn:disabled { opacity: .4; cursor: not-allowed; }
.mc-btn--buy { background: var(--success,#4ade80); color: #04140a; }
.mc-btn--buy:hover:not(:disabled) { background: color-mix(in srgb, var(--success,#4ade80) 88%, #fff); }
.mc-btn--sell { background: color-mix(in srgb, var(--danger,#f87171) 18%, transparent); color: var(--danger,#f87171); border-color: color-mix(in srgb, var(--danger,#f87171) 45%, transparent); }
.mc-btn--sell:hover:not(:disabled) { background: color-mix(in srgb, var(--danger,#f87171) 28%, transparent); }
a.mc-btn { text-decoration: none; }
.mc-trade-cta { display: flex; flex-direction: column; gap: 10px; }
.mc-trade-cta p { margin: 0; color: var(--ink-dim,#888); font-size: var(--text-sm,.764rem); line-height: 1.5; }
.mc-btn kbd { font-family: var(--font-mono,ui-monospace,monospace); font-size: .8em; opacity: .7; border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; }
.mc-trade-note { font-size: var(--text-sm,.764rem); line-height: 1.45; min-height: 1.2em; }
.mc-trade-note.is-err { color: var(--danger,#f87171); } .mc-trade-note.is-warn { color: var(--warn,#fbbf24); } .mc-trade-note.is-ok { color: var(--success,#4ade80); } .mc-trade-note.is-dim { color: var(--ink-dim,#888); }

/* ── empty / loading / error states ──────────────────────────────────────── */
.mc-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 40px 20px; text-align: center; color: var(--ink-dim,#888); height: 100%; }
.mc-empty-ico { font-size: 26px; opacity: .5; }
.mc-empty h3 { margin: 0; font-size: var(--text-md,.8125rem); color: var(--ink,#e8e8e8); font-weight: 600; }
.mc-empty p { margin: 0; font-size: var(--text-sm,.764rem); max-width: 34ch; line-height: 1.5; }
.mc-empty button { margin-top: 4px; }
.mc-skelrow { height: 46px; border-bottom: 1px solid var(--stroke,rgba(255,255,255,.05)); padding: 8px 12px; display: flex; flex-direction: column; gap: 7px; }
.mc-skelrow i { display: block; height: 11px; border-radius: 5px; background: var(--surface-2,rgba(255,255,255,.05)); animation: mc-skel 1.3s ease-in-out infinite; }
.mc-skelrow i:first-child { width: 45%; } .mc-skelrow i:last-child { width: 70%; }

/* ── shortcut overlay ────────────────────────────────────────────────────── */
.mc-overlay { position: fixed; inset: 0; background: color-mix(in srgb, var(--bg-0,#0a0a0b) 78%, transparent); backdrop-filter: blur(4px); display: grid; place-items: center; z-index: 1000; animation: mc-fade var(--duration-base,220ms) ease; padding: 20px; }
.mc-overlay[hidden] { display: none; }
.mc-overlay-card { background: var(--surface-1,#16161a); border: 1px solid var(--stroke-strong,rgba(255,255,255,.16)); border-radius: var(--radius-lg,14px); box-shadow: var(--shadow-3, 0 20px 60px rgba(0,0,0,.6)); padding: 22px 26px; max-width: 540px; width: 100%; max-height: 86vh; overflow-y: auto; }
.mc-overlay-card h2 { margin: 0 0 14px; font-size: var(--text-lg,1.236rem); color: var(--ink-bright,#fff); font-family: var(--font-display,system-ui); }
.mc-keys { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 22px; }
.mc-keys dl { margin: 0; display: contents; }
.mc-keyrow { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 4px 0; border-bottom: 1px solid var(--stroke,rgba(255,255,255,.05)); }
.mc-keyrow span { color: var(--ink-dim,#888); font-size: var(--text-sm,.764rem); }
.mc-keyrow kbd { font-family: var(--font-mono,ui-monospace,monospace); font-size: var(--text-2xs,.6875rem); background: var(--surface-2,rgba(255,255,255,.07)); border: 1px solid var(--stroke,rgba(255,255,255,.12)); border-bottom-width: 2px; border-radius: 5px; padding: 2px 7px; color: var(--ink-bright,#fff); }

/* ── toast ───────────────────────────────────────────────────────────────── */
.mc-toast { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%) translateY(10px); background: var(--surface-1,#16161a); color: var(--ink-bright,#fff); border: 1px solid var(--stroke-strong,rgba(255,255,255,.16)); border-left-width: 3px; border-radius: var(--radius-md,10px); padding: 11px 16px; font-size: var(--text-md,.8125rem); box-shadow: var(--shadow-3,0 12px 40px rgba(0,0,0,.5)); opacity: 0; pointer-events: none; transition: opacity var(--duration-base,220ms), transform var(--duration-base,220ms); z-index: 1100; max-width: min(440px, 90vw); }
.mc-toast[data-show="true"] { opacity: 1; transform: translateX(-50%) translateY(0); }
.mc-toast.ok { border-left-color: var(--success,#4ade80); } .mc-toast.err { border-left-color: var(--danger,#f87171); } .mc-toast.warn { border-left-color: var(--warn,#fbbf24); } .mc-toast.info { border-left-color: var(--accent,#7dd3fc); }
.mc-toast a { color: var(--accent,#7dd3fc); }

/* ── mobile pane switch ──────────────────────────────────────────────────── */
.mc-mobilebar { display: none; }
.mc-sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }

/* ── responsive ──────────────────────────────────────────────────────────── */
@media (max-width: 1100px) {
	/* Two columns: the feed spans the full height on the left; focus + positions
	   stack in the right column. Every pane stays reachable — no hidden tab. */
	.mc-main { grid-template-columns: minmax(260px, 1fr) minmax(320px, 1.45fr); grid-template-rows: 1.25fr 1fr; }
	.mc-pane--feed { grid-column: 1; grid-row: 1 / span 2; }
	.mc-pane--focus { grid-column: 2; grid-row: 1; }
	.mc-pane--positions { grid-column: 2; grid-row: 2; }
}
@media (max-width: 760px) {
	.mc-main { grid-template-columns: 1fr; }
	.mc-pane { display: none; }
	.mc-pane.is-active { display: flex; }
	.mc-mobilebar { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; flex: none; border-top: 1px solid var(--stroke,rgba(255,255,255,.08)); background: var(--surface-1,rgba(255,255,255,.02)); }
	.mc-mobilebar button { appearance: none; font: inherit; font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); background: transparent; border: none; padding: 11px 6px; cursor: pointer; }
	.mc-mobilebar button[aria-selected="true"] { color: var(--ink-bright,#fff); box-shadow: inset 0 2px 0 var(--accent,#7dd3fc); }
	.mc-topbar { flex-wrap: wrap; min-height: auto; padding: 8px 10px; }
	.mc-conn-group { order: 3; flex-basis: 100%; }
}

/* ── motion ──────────────────────────────────────────────────────────────── */
/* Transform only, no opacity fade: this feed streams new rows continuously,
   so a fading row is always on screen and its text spends ~260ms below the
   4.5:1 contrast floor (axe caught it as a real colour-contrast failure on
   /terminal). The slide alone reads as the same entrance. */
@keyframes mc-rowin { from { transform: translateY(-6px); } to { transform: none; } }
@keyframes mc-skel { 0%,100% { opacity: .45; } 50% { opacity: .9; } }
@keyframes mc-pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
@keyframes mc-breathe { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
@keyframes mc-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes mc-flashpos { 0% { background: color-mix(in srgb, var(--success,#4ade80) 24%, transparent); } 100% { background: transparent; } }
@keyframes mc-flashneg { 0% { background: color-mix(in srgb, var(--danger,#f87171) 24%, transparent); } 100% { background: transparent; } }
@media (prefers-reduced-motion: reduce) {
	.mc-root *, .mc-enter, .mc-flash-pos, .mc-flash-neg, .mc-conn-dot, .mc-chip-skel, .mc-skelrow i { animation: none !important; transition: none !important; }
}
`;

export function injectMissionControlStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = STYLE_ID;
	tag.textContent = CSS;
	document.head.appendChild(tag);
}
