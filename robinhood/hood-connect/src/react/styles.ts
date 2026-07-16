/**
 * Default skin for the hood-connect React components. Injected once as a
 * `<style>` tag (idempotent); pass `unstyled` to any component to skip
 * injection and bring your own CSS. Every rule is namespaced under `.hc-`
 * and themable via CSS custom properties on `:root` or any ancestor.
 */

export const HOOD_CONNECT_STYLES = `
.hc-scope {
  --hc-accent: #00c805;
  --hc-accent-2: #00e0b0;
  --hc-bg: #101418;
  --hc-bg-raised: #171d23;
  --hc-border: #2a323b;
  --hc-text: #e8edf2;
  --hc-text-dim: #93a1af;
  --hc-danger: #ff5d5d;
  --hc-radius: 10px;
  --hc-font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  font-family: var(--hc-font);
  color: var(--hc-text);
  box-sizing: border-box;
}
.hc-scope *, .hc-scope *::before, .hc-scope *::after { box-sizing: inherit; }

.hc-btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px;
  border: 1px solid transparent;
  border-radius: var(--hc-radius);
  background: linear-gradient(135deg, var(--hc-accent), var(--hc-accent-2));
  color: #06130a;
  font-weight: 600;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  transition: transform 120ms ease, box-shadow 120ms ease, filter 120ms ease;
}
.hc-btn:hover { filter: brightness(1.08); box-shadow: 0 4px 18px rgba(0, 200, 5, 0.25); }
.hc-btn:active { transform: translateY(1px); }
.hc-btn:focus-visible { outline: 2px solid var(--hc-accent-2); outline-offset: 2px; }
.hc-btn[disabled] { cursor: wait; opacity: 0.75; filter: none; box-shadow: none; }

.hc-btn--secondary {
  background: var(--hc-bg-raised);
  border-color: var(--hc-border);
  color: var(--hc-text);
}
.hc-btn--secondary:hover { box-shadow: none; border-color: var(--hc-accent); filter: none; }
.hc-btn--danger { background: transparent; border-color: var(--hc-border); color: var(--hc-danger); }
.hc-btn--danger:hover { border-color: var(--hc-danger); box-shadow: none; filter: none; }

.hc-spinner {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid rgba(6, 19, 10, 0.3);
  border-top-color: currentColor;
  animation: hc-spin 700ms linear infinite;
}
.hc-btn--secondary .hc-spinner { border-color: rgba(232, 237, 242, 0.2); border-top-color: var(--hc-accent); }
@keyframes hc-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .hc-spinner { animation-duration: 1.6s; }
  .hc-btn { transition: none; }
}

.hc-menu-wrap { position: relative; display: inline-block; }
.hc-menu {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 240px;
  background: var(--hc-bg-raised);
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  padding: 6px;
  z-index: 50;
  animation: hc-pop 120ms ease;
}
@keyframes hc-pop { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
.hc-menu-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--hc-text);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.hc-menu-item:hover, .hc-menu-item:focus-visible { background: rgba(0, 200, 5, 0.1); outline: none; }
.hc-menu-item img { width: 20px; height: 20px; border-radius: 5px; }
.hc-menu-label { padding: 8px 10px 4px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--hc-text-dim); }

.hc-pill {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--hc-bg-raised);
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius);
  font-size: 13px;
  cursor: pointer;
  transition: border-color 120ms ease;
}
.hc-pill:hover, .hc-pill:focus-visible { border-color: var(--hc-accent); outline: none; }
.hc-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--hc-accent); box-shadow: 0 0 8px rgba(0, 200, 5, 0.7); }
.hc-dot--warn { background: #ffb020; box-shadow: 0 0 8px rgba(255, 176, 32, 0.7); }
.hc-balances { display: inline-flex; gap: 8px; color: var(--hc-text-dim); font-variant-numeric: tabular-nums; }
.hc-balances strong { color: var(--hc-text); font-weight: 600; }

.hc-error {
  margin-top: 8px;
  padding: 10px 12px;
  border: 1px solid rgba(255, 93, 93, 0.35);
  border-radius: var(--hc-radius);
  background: rgba(255, 93, 93, 0.08);
  color: var(--hc-danger);
  font-size: 13px;
  max-width: 380px;
}
.hc-hint { margin-top: 8px; font-size: 12px; color: var(--hc-text-dim); max-width: 380px; }
.hc-hint a, .hc-fund a { color: var(--hc-accent-2); text-decoration: none; }
.hc-hint a:hover, .hc-fund a:hover { text-decoration: underline; }

.hc-install { display: flex; flex-direction: column; gap: 6px; }
.hc-install-links { display: flex; flex-wrap: wrap; gap: 8px; }
.hc-install-links a {
  display: inline-flex;
  align-items: center;
  padding: 8px 12px;
  border: 1px solid var(--hc-border);
  border-radius: var(--hc-radius);
  background: var(--hc-bg-raised);
  color: var(--hc-text);
  font-size: 13px;
  text-decoration: none;
  transition: border-color 120ms ease;
}
.hc-install-links a:hover, .hc-install-links a:focus-visible { border-color: var(--hc-accent); outline: none; }

/* Funding funnel */
.hc-fund {
  width: 100%;
  max-width: 420px;
  background: var(--hc-bg-raised);
  border: 1px solid var(--hc-border);
  border-radius: 14px;
  padding: 16px;
}
.hc-fund-tabs { display: flex; gap: 6px; margin-bottom: 14px; }
.hc-fund-tab {
  flex: 1;
  padding: 8px 10px;
  border: 1px solid var(--hc-border);
  border-radius: 8px;
  background: transparent;
  color: var(--hc-text-dim);
  font: inherit;
  font-size: 13px;
  cursor: pointer;
}
.hc-fund-tab[aria-selected="true"] { color: var(--hc-text); border-color: var(--hc-accent); background: rgba(0, 200, 5, 0.08); }
.hc-fund-tab:focus-visible { outline: 2px solid var(--hc-accent-2); outline-offset: 1px; }
.hc-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.hc-field label { font-size: 12px; color: var(--hc-text-dim); }
.hc-field select, .hc-field input {
  padding: 10px 12px;
  border: 1px solid var(--hc-border);
  border-radius: 8px;
  background: var(--hc-bg);
  color: var(--hc-text);
  font: inherit;
  font-size: 14px;
}
.hc-field select:focus-visible, .hc-field input:focus-visible { outline: 2px solid var(--hc-accent-2); outline-offset: 1px; border-color: var(--hc-accent); }
.hc-quote {
  border: 1px solid var(--hc-border);
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 12px;
  font-size: 13px;
  display: grid;
  gap: 6px;
}
.hc-quote-row { display: flex; justify-content: space-between; color: var(--hc-text-dim); }
.hc-quote-row strong { color: var(--hc-text); font-variant-numeric: tabular-nums; }
.hc-skeleton {
  height: 14px;
  border-radius: 6px;
  background: linear-gradient(90deg, var(--hc-border) 25%, #333c46 50%, var(--hc-border) 75%);
  background-size: 200% 100%;
  animation: hc-shimmer 1.2s linear infinite;
}
@keyframes hc-shimmer { to { background-position: -200% 0; } }
.hc-steps { margin: 0; padding-left: 20px; font-size: 13px; color: var(--hc-text-dim); display: grid; gap: 8px; }
.hc-steps strong { color: var(--hc-text); }
.hc-success { color: var(--hc-accent); font-size: 13px; margin-top: 8px; word-break: break-all; }
`

let injected = false

/** Inject the default skin once. No-op on re-call and in non-DOM environments. */
export function injectStyles(): void {
  if (injected || typeof document === 'undefined') return
  if (document.getElementById('hood-connect-styles')) {
    injected = true
    return
  }
  const style = document.createElement('style')
  style.id = 'hood-connect-styles'
  style.textContent = HOOD_CONNECT_STYLES
  document.head.appendChild(style)
  injected = true
}
