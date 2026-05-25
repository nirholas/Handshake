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

import { renderSidebar,  mountSidebarBehavior } from './components/sidebar.js';
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

	const shell = document.createElement('div');
	shell.className = 'dn-shell';
	shell.setAttribute('data-rail-collapsed', 'false');
	shell.setAttribute('data-drawer-open', 'false');
	shell.innerHTML = `
		${renderSidebar(location.pathname)}
		${renderTopbar(location.pathname)}
		<main class="dn-main" id="dn-main">
			<div class="dn-main-inner" data-slot="page"></div>
		</main>
		${renderDrawer()}
	`;
	document.body.appendChild(shell);

	mountSidebarBehavior(shell);
	mountTopbarBehavior(shell);
	mountDrawerBehavior(shell);
	mountPaletteBehavior();

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
