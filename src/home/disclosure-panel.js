// The disclosure panel: the sentences a person reads before they hand over a key
// to their building, or turn on a microphone in their kitchen.
//
// It is one function because both moments want the same thing rendered the same
// way, and because a promise written twice drifts. The strings come from
// src/shared/home-disclosure.js, the same module the server hands to
// GET /api/home/privacy, so what this screen says and what the API says are the
// same bytes rather than two texts somebody has to keep in step.
//
// Deliberately NOT a <details> the way "Where do I get an access token?" is.
// Help can be folded away; a disclosure that has to be opened before it is read
// has not been disclosed. It renders open, above the button that acts, and the
// only thing behind a link is the longer version.

import { CONNECT_DISCLOSURE, VOICE_DISCLOSURE } from '../shared/home-disclosure.js';

const BY_ID = { 'home.connect': CONNECT_DISCLOSURE, 'home.voice': VOICE_DISCLOSURE };

/**
 * @param {'home.connect'|'home.voice'} id which moment this is
 * @param {{ el?: (tag: string, className?: string, text?: string) => HTMLElement }} [deps]
 *   the host screen's element helper, so the panel inherits its class conventions
 *   rather than importing a second one. Falls back to a local equivalent.
 * @returns {HTMLElement}
 */
export function disclosurePanel(id, { el: mk } = {}) {
	const copy = BY_ID[id];
	if (!copy) throw new Error(`unknown disclosure: ${id}`);
	const el = mk || ((tag, className, text) => {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text != null) node.textContent = String(text);
		return node;
	});

	const wrap = el('section', 'hm-disclosure');
	// A region, not an aside: this is content a screen reader user should be able
	// to navigate to and should not have announced as supplementary.
	wrap.setAttribute('role', 'region');
	wrap.setAttribute('aria-labelledby', `${id.replace('.', '-')}-heading`);

	const heading = el('h3', 'hm-disclosure-title', copy.heading);
	heading.id = `${id.replace('.', '-')}-heading`;
	wrap.append(heading);

	const list = el('ul', 'hm-disclosure-list');
	for (const line of copy.lines) list.append(el('li', '', line));
	wrap.append(list);

	const more = el('a', 'hm-disclosure-more', copy.learnMoreLabel);
	more.href = copy.learnMoreHref;
	wrap.append(more);

	return wrap;
}
