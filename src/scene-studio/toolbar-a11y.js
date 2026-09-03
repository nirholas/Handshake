// Scene Studio: accessible names for the vendored transform toolbar.
//
// The vendored Toolbar (vendor/js/Toolbar.js) builds its translate / rotate /
// scale controls as a <button> whose only child is an <img> carrying a `title`
// and no `alt`. A title on an <img> is not an accessible name for the button
// that wraps it, so all three shipped to screen readers as unlabelled buttons,
// and the pressed state (a `selected` class) was never announced at all.
//
// This runs over the mounted toolbar once and fixes both, reading the labels
// from the same `editor.strings` table the vendor uses for the tooltips, so a
// translated UI stays translated. Sibling module: it edits the live DOM, never
// vendor/**.

const MODE_KEYS = ['translate', 'rotate', 'scale'];

/**
 * Label the transform-mode buttons and keep aria-pressed in sync.
 * @param {import('./vendor/js/Editor.js').Editor} editor
 * @param {HTMLElement} toolbarDom the Toolbar instance's `.dom`.
 */
export function enhanceToolbarA11y(editor, toolbarDom) {
	toolbarDom.setAttribute('role', 'toolbar');
	toolbarDom.setAttribute('aria-label', 'Transform mode');

	const buttons = MODE_KEYS.map((mode) => {
		// Matched on the icon the vendor assigns, not on child order, so adding
		// a control to the vendored toolbar can never silently relabel these.
		const icon = toolbarDom.querySelector(`img[src$="/${mode}.svg"]`);
		const button = icon?.closest('button');
		if (!button) return null;
		// The vendor's own tooltip string, e.g. "translate" / "rotate" / "scale".
		const label = (icon?.title || mode).trim() || mode;

		// A decorative alt keeps the icon out of the accessibility tree so the
		// button's own label is what gets announced, rather than both.
		if (icon && !icon.hasAttribute('alt')) icon.setAttribute('alt', '');

		button.setAttribute('aria-label', label);
		button.setAttribute('type', 'button');
		if (!button.title) button.title = label;
		return { mode, button };
	}).filter(Boolean);

	const sync = () => {
		for (const { button } of buttons) {
			button.setAttribute('aria-pressed', String(button.classList.contains('selected')));
		}
	};

	// The vendor swaps the `selected` class inside its own handler for this
	// signal; listening after it was added means we always read the new state.
	editor.signals.transformModeChanged.add(sync);
	sync();

	return buttons.map(({ button }) => button);
}
