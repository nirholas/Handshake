// dashboard-next — shell bootstrap.
//
// Every page in /dashboard-next imports this module. It renders the
// sidebar / topbar / drawer slot / palette overlay into <body>, then
// hands control back so the page module can render its own content
// into the <main> slot.
//
// Usage from a page entry module:
//
//   import { mountShell } from '/src/dashboard-next/shell.js';
//   const main = await mountShell();
//   main.innerHTML = '<h1>Hello</h1>';

import { renderSidebar,  mountSidebarBehavior, mountMobileNavBehavior } from './components/sidebar.js';
import { renderTopbar,   mountTopbarBehavior  } from './components/topbar.js';
import { renderDrawer,   mountDrawerBehavior  } from './components/drawer.js';
import { mountPaletteBehavior } from './components/palette.js';

/**
 * Build the shell, mount its behaviour, and resolve to the <main> slot
 * the caller should write its page content into.
 *
 * @returns {Promise<HTMLElement>}  the inner content container
 */
export async function mountShell() {
	if (document.querySelector('.dn-shell')) {
		// Some other page module already mounted us — return the slot.
		const existing = document.querySelector('.dn-main-inner');
		if (existing) return existing;
	}

	document.body.classList.add('dn-body');

	// Skip-link — hidden until focused, then jumps to main content. Lives
	// outside the shell grid so it can absolutely-position over chrome.
	if (!document.querySelector('.dn-skip')) {
		const skip = document.createElement('a');
		skip.className = 'dn-skip';
		skip.href = '#dn-main';
		skip.textContent = 'Skip to content';
		document.body.insertBefore(skip, document.body.firstChild);
	}

	const shell = document.createElement('div');
	shell.className = 'dn-shell';
	shell.setAttribute('data-rail-collapsed', 'false');
	shell.setAttribute('data-drawer-open', 'false');
	shell.innerHTML = `
		${renderSidebar(location.pathname)}
		${renderTopbar(location.pathname)}
		<main class="dn-main" id="dn-main" tabindex="-1">
			<div class="dn-main-inner" data-slot="page"></div>
		</main>
		${renderDrawer()}
	`;
	document.body.appendChild(shell);

	mountSidebarBehavior(shell);
	mountMobileNavBehavior(shell, location.pathname);
	mountTopbarBehavior(shell);
	mountDrawerBehavior(shell);
	mountPaletteBehavior();
	mountDrawerPulse(shell);

	// Light-up touch — the sidebar item we land on gets a brief accent
	// pulse so users see "you are here" without having to track the
	// indicator bar. Tasteful, not festive.
	const here = shell.querySelector('.dn-rail-item[aria-current="page"]');
	if (here) {
		here.animate(
			[{ background: 'rgba(154,124,255,0.32)' }, { background: 'rgba(154,124,255,0.18)' }],
			{ duration: 600, easing: 'ease-out' },
		);
	}

	return shell.querySelector('[data-slot="page"]');
}

// Listen for new-event signals dispatched by the drawer's live feed and
// briefly pulse the drawer toggle so the user knows there's something
// fresh to look at without having to open the drawer first.
function mountDrawerPulse(shellEl) {
	window.addEventListener('dn:drawer:new-event', () => {
		const btn = shellEl.querySelector('[data-action="toggle-drawer"]');
		if (!btn) return;
		btn.setAttribute('data-pulse', 'true');
		setTimeout(() => btn.removeAttribute('data-pulse'), 2500);
	});
}
