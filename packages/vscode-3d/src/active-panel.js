// Which viewer a palette command acts on.
//
// Custom editors and remote panels both register here, so "Save a PNG snapshot"
// works the same whether the model came from the workspace or from a URL.

let current = null;

/** @param {import('vscode').WebviewPanel} panel */
export function trackPanel(panel) {
	current = panel;
	panel.onDidChangeViewState(() => {
		if (panel.active) current = panel;
		else if (current === panel) current = null;
	});
	panel.onDidDispose(() => {
		if (current === panel) current = null;
	});
	return panel;
}

export function activeViewer() {
	return current;
}
