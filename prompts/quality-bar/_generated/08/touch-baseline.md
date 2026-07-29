# Mobile input-ergonomics audit - baseline

Measured with `scripts/mobile-touch-audit.mjs` against https://three.ws in a real
Pixel 5 Playwright context (Chromium). Every value below is a live computed style or a
measured bounding box, not a source grep.

- Minimum target size checked: 44x44 CSS px
- Inline text links are exempt (WCAG 2.5.8) and counted separately
- Measured: 2026-07-29T06:04:43.521Z

| path | undersized targets | interactive checked | inline-exempt | canvases touch-action:auto / visible | viewport-fit=cover | bottom bars w/o safe-area / total | overflow-x |
|---|---|---|---|---|---|---|---|
| `/marketplace` | 1171 | 1502 | 0 | 1/1 | NO | 1/1 | 0 px |
| `/launches` | 232 | 299 | 0 | 2/2 | NO | 3/3 | 0 px |
| `/docs/start-here` | 176 | 289 | 47 | 0/0 | NO | 1/1 | 0 px |
| `/` | 172 | 314 | 5 | 5/6 | NO | 1/1 | 0 px |
| `/markets` | 120 | 196 | 0 | 2/2 | NO | 1/1 | 165 px |
| `/forge` | 49 | 135 | 1 | 2/2 | NO | 1/1 | 0 px |
| `/coin/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump` | 41 | 86 | 0 | 2/2 | NO | 2/2 | 0 px |
| `/play` | 37 | 46 | 0 | 0/1 | yes | 3/3 | 0 px |
| `/changelog` | 18 | 2245 | 4 | 1/1 | NO | 1/1 | 2 px |
| `/dashboard` | 14 | 37 | 3 | 1/1 | yes | 1/1 | 0 px |
| `/irl` | 12 | 59 | 0 | 0/1 | yes | 14/14 | 0 px |
| `/walk` | 9 | 60 | 0 | 1/1 | yes | 0/0 | 0 px |
| `/ar` | 6 | 14 | 6 | 0/0 | yes | 0/0 | 0 px |
| `/news` | 5 | 117 | 5 | 0/0 | NO | 0/0 | 127 px |

## Detail

### `/marketplace`

- undersized targets:
  - 200x `a.title.card-profile-link 316x32`
  - 200x `button.card-heart 17x21`
  - 200x `a.compose-cta 79x24`
  - 146x `button.tag-pill 47x18`
  - 114x `a.card-author 21x19`
  - 100x `button.tag-pill 49x18`
  - 96x `button.tag-pill 45x18`
  - 28x `button.tag-pill 66x18`
  - 24x `a.title.card-profile-link 289x32`
  - 10x `button.tag-pill 64x18`
  - 5x `button.tag-pill 31x18`
  - 4x `button.tag-pill 55x18`
- visible canvases:
  - `canvas#footer-bot-canvas` 90x90 touch-action=auto (parent auto)
- bottom-anchored bars:
  - `header.market-topbar` h=412 padding-bottom=9.888px safe-area-rule=false

### `/launches`

- undersized targets:
  - 24x `button.twc-make.twc-tip 37x10`
  - 24x `button.lx-action.lx-action-watch 35x29`
  - 23x `a.lx-agent-row 322x36`
  - 23x `span.twc 322x19`
  - 23x `a.lx-action 103x29`
  - 23x `a.lx-action 80x29`
  - 23x `a.lx-action 86x29`
  - 14x `a.mp-tick.mp-k-pay 201x20`
  - 14x `a.mp-tick.mp-k-pay 226x20`
  - 12x `a.mp-tick.mp-k-pay 242x20`
  - 1x `a.nav-skip 157x36`
  - 1x `a.lx-btn.lx-btn-primary 146x39`
- visible canvases:
  - `canvas#lx-field` 393x727 touch-action=auto (parent auto)
  - `canvas#footer-bot-canvas` 90x90 touch-action=auto (parent auto)
- bottom-anchored bars:
  - `canvas#lx-field` h=727 padding-bottom=0px safe-area-rule=false
  - `div.lx-aurora` h=1079 padding-bottom=0px safe-area-rule=false
  - `section.lx-toolbar` h=159 padding-bottom=6.112px safe-area-rule=false

### `/docs/start-here`

- undersized targets:
  - 160x `a.sidebar-link 267x30`
  - 1x `a.docs-logo 114x33`
  - 1x `a 67x28`
  - 1x `a 71x28`
  - 1x `a.btn-primary 58x30`
  - 1x `input#search-input 247x31`
  - 1x `a.sidebar-link.active 267x30`
  - 1x `a.sidebar-link.external 267x30`
  - 1x `button#pagetools-copy.docs-pagetools-btn 110x35`
  - 1x `button#pagetools-caret.docs-pagetools-caret 35x35`
  - 1x `a 146x21`
  - 1x `a 164x21`
- bottom-anchored bars:
  - `aside#sidebar.docs-sidebar` h=675 padding-bottom=67.776px safe-area-rule=false

### `/`

- undersized targets:
  - 27x `a 165x20`
  - 14x `button.pg-avatar-item 32x32`
  - 8x `a.eco-row-link 288x38`
  - 8x `a.eco-row-tx 23x28`
  - 4x `a.har-cta-link 353x22`
  - 3x `button.pg-anim 50x24`
  - 3x `a.wyg-card-link 295x21`
  - 3x `button.hp-btn 111x41`
  - 3x `button.bento-pill.bento-pill-btn 83x22`
  - 2x `button.pg-chip 50x24`
  - 2x `button.pg-anim 78x24`
  - 2x `button.bento-pill.bento-pill-btn 50x22`
- visible canvases:
  - `canvas` 393x399 touch-action=none (parent auto)
  - `canvas#mocap-waveform.mocap-waveform` 287x48 touch-action=auto (parent auto)
  - `canvas#walk-minimap.walk-minimap` 285x140 touch-action=auto (parent auto)
  - `canvas.walk-preview-canvas` 351x197 touch-action=auto (parent auto)
  - `canvas#drop-canvas` 393x627 touch-action=auto (parent auto)
  - `canvas.walk-companion-canvas` 148x208 touch-action=auto (parent auto)
- bottom-anchored bars:
  - `div.walk-c2w-fx` h=727 padding-bottom=0px safe-area-rule=false

### `/markets`

- undersized targets:
  - 100x `a 202x22`
  - 5x `button.nw-star 21x19`
  - 1x `a.nav-skip 157x36`
  - 1x `a.mkt-more 139x22`
  - 1x `a.mkt-more 75x22`
  - 1x `a 420x19`
  - 1x `a 450x39`
  - 1x `a 410x19`
  - 1x `a 500x19`
  - 1x `a 406x19`
  - 1x `a.h-footer-nvidia 24x44`
  - 1x `a 83x20`
- visible canvases:
  - `canvas#footer-bot-canvas` 90x90 touch-action=auto (parent auto)
  - `canvas.walk-companion-canvas` 148x208 touch-action=auto (parent auto)
- bottom-anchored bars:
  - `div.walk-c2w-fx` h=1033 padding-bottom=0px safe-area-rule=false
- horizontal overflow: 165 px beyond 558 px viewport

### `/forge`

- undersized targets:
  - 12x `button.showcase-vote 43x20`
  - 12x `button.showcase-remix 59x22`
  - 3x `button 36x44`
  - 1x `a.nav-skip 157x36`
  - 1x `button#tab-text 120x39`
  - 1x `button#tab-image 120x39`
  - 1x `button#tab-sketch 120x39`
  - 1x `a 70x15`
  - 1x `button 42x44`
  - 1x `a 218x15`
  - 1x `button#connect-wallet-btn.fq-connect-btn 109x23`
  - 1x `button#roll-forge.btn.forge-roll 155x41`
- visible canvases:
  - `canvas#footer-bot-canvas` 90x90 touch-action=auto (parent auto)
  - `canvas.walk-companion-canvas` 148x208 touch-action=auto (parent auto)
- bottom-anchored bars:
  - `div.walk-c2w-fx` h=727 padding-bottom=0px safe-area-rule=false

### `/coin/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump`

- undersized targets:
  - 7x `a.cv-mkt-x 104x22`
  - 2x `button.cv-range-btn 49x27`
  - 2x `a.cv-mkt-pair 103x17`
  - 2x `a.cv-pill 87x36`
  - 2x `a.cv-pill 96x36`
  - 1x `a.nav-skip 157x36`
  - 1x `a 38x22`
  - 1x `a 54x22`
  - 1x `button.cv-range-btn 48x27`
  - 1x `button.cv-range-btn 40x27`
  - 1x `button.cv-range-btn 37x27`
  - 1x `button.cv-range-btn 87x27`
- visible canvases:
  - `canvas#footer-bot-canvas` 90x90 touch-action=auto (parent auto)
  - `canvas.walk-companion-canvas` 148x208 touch-action=auto (parent auto)
- bottom-anchored bars:
  - `th.left` h=47 padding-bottom=12px safe-area-rule=false
  - `div.walk-c2w-fx` h=727 padding-bottom=0px safe-area-rule=false

### `/play`

- undersized targets:
  - 20x `button.cc-card-holders 92x20`
  - 1x `a.cc-nav-brand 103x20`
  - 1x `button#cc-nav-toggle.cc-nav-toggle 38x34`
  - 1x `input 290x18`
  - 1x `a.cc-adventure 165x34`
  - 1x `button.pi-reopen 99x28`
  - 1x `input#cc-name-input.cc-name-input 207x38`
  - 1x `input 202x37`
  - 1x `button.cc-gallery-btn 143x35`
  - 1x `a 31x16`
  - 1x `a 43x16`
  - 1x `a 54x16`
- visible canvases:
  - `canvas#kx-canvas` 393x727 touch-action=none (parent auto)
- bottom-anchored bars:
  - `canvas#kx-canvas` h=727 padding-bottom=0px safe-area-rule=false
  - `div#cc-lobby` h=727 padding-bottom=0px safe-area-rule=false
  - `div#pi-overlay.pi-show` h=727 padding-bottom=20px safe-area-rule=false

### `/changelog`

- undersized targets:
  - 1x `a.nav-skip 157x36`
  - 1x `button.cl-filter 46x28`
  - 1x `button.cl-filter 71x28`
  - 1x `button.cl-filter 73x28`
  - 1x `button.cl-filter 109x28`
  - 1x `button.cl-filter 45x28`
  - 1x `button.cl-filter 52x28`
  - 1x `button.cl-filter 79x28`
  - 1x `button.cl-filter 58x28`
  - 1x `button.cl-filter 59x28`
  - 1x `a.h-footer-community-btn 145x41`
  - 1x `a 83x15`
- visible canvases:
  - `canvas.walk-companion-canvas` 148x208 touch-action=auto (parent auto)
- bottom-anchored bars:
  - `div.walk-c2w-fx` h=731 padding-bottom=0px safe-area-rule=false
- horizontal overflow: 2 px beyond 395 px viewport

### `/dashboard`

- undersized targets:
  - 1x `a.nav-skip 157x36`
  - 1x `a.skip-link 1x1`
  - 1x `a.brand 287x40`
  - 1x `input#privy-email-input 177x42`
  - 1x `input#email 287x42`
  - 1x `input#password 287x42`
  - 1x `input#remember 18x18`
  - 1x `a.forgot 105x18`
  - 1x `button#submit 287x41`
  - 1x `a.panel-brand 76x17`
  - 1x `a 83x19`
  - 1x `a 79x19`
- visible canvases:
  - `canvas#avatar-canvas` 393x727 touch-action=auto (parent auto)
- bottom-anchored bars:
  - `canvas#avatar-canvas` h=727 padding-bottom=0px safe-area-rule=false

### `/irl`

- undersized targets:
  - 1x `button#irl-consent-exact.irl-consent-btn 170x43`
  - 1x `button#irl-consent-approx.irl-consent-btn 170x43`
  - 1x `input#irl-consent-dontshow 16x16`
  - 1x `button#irl-sheet-view.irl-sheet-btn 349x43`
  - 1x `button#irl-sheet-report.irl-sheet-report 97x32`
  - 1x `button#irl-cal-down.irl-cal-step 40x40`
  - 1x `button#irl-cal-up.irl-cal-step 40x40`
  - 1x `button#irl-cal-save 272x41`
  - 1x `button#irl-cal-cancel 76x41`
  - 1x `a.irl-ob-learn 144x32`
  - 1x `button.tws-es-btn.tws-es-btn--primary 283x40`
  - 1x `button.tws-es-btn 283x40`
- visible canvases:
  - `canvas#irl-canvas` 393x727 touch-action=none (parent none)
- bottom-anchored bars:
  - `div.irl-bg` h=727 padding-bottom=0px safe-area-rule=false
  - `canvas#irl-canvas` h=727 padding-bottom=0px safe-area-rule=false
  - `div#irl-more-sheet` h=375 padding-bottom=28px safe-area-rule=false
  - `footer.irl-bottom` h=238 padding-bottom=14px safe-area-rule=false
  - `div#irl-caption-panel` h=288 padding-bottom=36px safe-area-rule=false
  - `div#irl-consent-sheet` h=443 padding-bottom=32px safe-area-rule=false
  - `div#irl-error-sheet` h=207 padding-bottom=36px safe-area-rule=false
  - `div#irl-mypins-sheet` h=200 padding-bottom=36px safe-area-rule=false
  - `div#irl-sheet` h=308 padding-bottom=36px safe-area-rule=false
  - `div#irl-report-sheet` h=485 padding-bottom=36px safe-area-rule=false
  - `div#irl-agents-sheet` h=200 padding-bottom=36px safe-area-rule=false
  - `div#irl-calibrate-panel` h=230 padding-bottom=18px safe-area-rule=false
  - `div#irl-onboard.irl-onboard.is-open` h=727 padding-bottom=24px safe-area-rule=false
  - `section.irl-drops-panel` h=390 padding-bottom=16px safe-area-rule=false

### `/walk`

- undersized targets:
  - 1x `a.nav-skip 157x36`
  - 1x `a.skip-link 393x26`
  - 1x `a.btn.btn--ghost 164x37`
  - 1x `button#wl-copy.wl-copy-btn 50x23`
  - 1x `a.btn.btn--primary 123x37`
  - 1x `a.btn.btn--ghost 189x37`
  - 1x `a.h-footer-nvidia 24x44`
  - 1x `a 83x20`
  - 1x `a 80x20`
- visible canvases:
  - `canvas#footer-bot-canvas` 90x90 touch-action=auto (parent auto)

### `/ar`

- undersized targets:
  - 1x `a.brand 98x19`
  - 1x `a.top 81x15`
  - 1x `button.chip 165x29`
  - 1x `button.chip 223x29`
  - 1x `button.chip 146x29`
  - 1x `button.chip 162x29`

### `/news`

- undersized targets:
  - 1x `a.brand 103x31`
  - 1x `a 38x26`
  - 1x `a 58x26`
  - 1x `a 82x26`
  - 1x `a.subscribe 165x42`
- horizontal overflow: 127 px beyond 520 px viewport

