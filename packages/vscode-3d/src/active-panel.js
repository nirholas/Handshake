// Which viewer a palette command acts on.
//
// Custom editors and remote panels both register here, so "Save a PNG snapshot"
// or "Try a library animation" works the same whether the model came from the
// workspace or from a URL. Each panel carries a `threews` record (its resource,
// remote URL, byte reader, and latest stats) that the commands read.

let current = null;
const listeners = new Set();

/** @param {import('vscode').WebviewPanel} panel */
export function trackPanel(panel) {
	current = panel;
	notify();
	panel.onDidChangeViewState(() => {
		if (panel.active) current = panel;
		else if (current === panel) current = null;
		notify();
	});
	panel.onDidDispose(() => {
		if (current === panel) current = null;
		notify();
	});
	return panel;
}

export function activeViewer() {
	return current;
}

/** Called whenever the active viewer changes or its stats update. */
export function onActiveViewerChanged(fn) {
	listeners.add(fn);
	return { dispose: () => listeners.delete(fn) };
}

export function notify() {
	for (const fn of [...listeners]) fn(current);
}
