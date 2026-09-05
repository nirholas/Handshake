// A minimal stand-in for the VS Code extension host API.
//
// Enough of the real surface for the bundled extension to activate, register
// everything it contributes, and render the viewer webview, so the tests
// exercise the shipped dist/extension.cjs rather than a rearranged copy of it.

class EventEmitter {
	constructor() {
		this.listeners = new Set();
		this.event = (fn) => {
			this.listeners.add(fn);
			return { dispose: () => this.listeners.delete(fn) };
		};
	}
	fire(value) {
		for (const fn of [...this.listeners]) fn(value);
	}
	dispose() {
		this.listeners.clear();
	}
}

class Uri {
	constructor(scheme, path) {
		this.scheme = scheme;
		this.path = path;
	}
	get fsPath() {
		return this.path;
	}
	toString() {
		return `${this.scheme}://${this.path}`;
	}
	static file(p) {
		return new Uri('file', p);
	}
	static parse(value) {
		const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(String(value));
		return match ? new Uri(match[1], match[2]) : new Uri('file', String(value));
	}
	static joinPath(base, ...parts) {
		const joined = [base.path.replace(/\/+$/, ''), ...parts].join('/');
		// Resolve the ".." segment the viewer uses to reach a model's folder.
		const stack = [];
		for (const segment of joined.split('/')) {
			if (segment === '..') stack.pop();
			else if (segment !== '.') stack.push(segment);
		}
		return new Uri(base.scheme, stack.join('/'));
	}
}

class TreeItem {
	constructor(label, collapsibleState) {
		this.label = label;
		this.collapsibleState = collapsibleState;
	}
}

class ThemeIcon {
	constructor(id) {
		this.id = id;
	}
}
ThemeIcon.Folder = new ThemeIcon('folder');

class MarkdownString {
	constructor(value) {
		this.value = value;
	}
}

class RelativePattern {
	constructor(base, pattern) {
		this.base = base;
		this.pattern = pattern;
	}
}

class Position {
	constructor(line, character) {
		this.line = line;
		this.character = character;
	}
}

class Range {
	constructor(start, end) {
		this.start = start;
		this.end = end;
	}
}

class Diagnostic {
	constructor(range, message, severity) {
		this.range = range;
		this.message = message;
		this.severity = severity;
	}
}

class CodeAction {
	constructor(title, kind) {
		this.title = title;
		this.kind = kind;
	}
}

class WorkspaceEdit {
	constructor() {
		this.edits = [];
	}
	replace(uri, range, text) {
		this.edits.push({ uri, range, text });
	}
}

class Hover {
	constructor(contents, range) {
		this.contents = contents;
		this.range = range;
	}
}

class CompletionItem {
	constructor(label, kind) {
		this.label = label;
		this.kind = kind;
	}
}

class SnippetString {
	constructor(value) {
		this.value = value;
	}
}

class CodeLens {
	constructor(range, command) {
		this.range = range;
		this.command = command;
	}
}

/** A text document the language features can run over. */
class TextDocument {
	constructor(uri, languageId, text) {
		this.uri = uri;
		this.languageId = languageId;
		this.text = text;
	}
	getText() {
		return this.text;
	}
	offsetAt(position) {
		const lines = this.text.split('\n');
		let offset = 0;
		for (let i = 0; i < position.line; i++) offset += lines[i].length + 1;
		return offset + position.character;
	}
	positionAt(offset) {
		const before = this.text.slice(0, offset).split('\n');
		return new Position(before.length - 1, before[before.length - 1].length);
	}
}

function watcher() {
	return {
		onDidCreate: () => ({ dispose() {} }),
		onDidChange: () => ({ dispose() {} }),
		onDidDelete: () => ({ dispose() {} }),
		dispose() {},
	};
}

const state = {
	commands: new Map(),
	trees: new Map(),
	customEditors: new Map(),
	outputs: [],
	messages: [],
	config: {},
	files: [],
	fileBytes: new Map(),
	statusBarItems: [],
	diagnostics: new Map(),
	providers: { codeActions: [], hovers: [], completions: [], codeLenses: [] },
	documents: [],
	openDocument: new EventEmitter(),
	changeDocument: new EventEmitter(),
	closeDocument: new EventEmitter(),
	changeConfiguration: new EventEmitter(),
};

const vscode = {
	EventEmitter,
	Uri,
	TreeItem,
	ThemeIcon,
	MarkdownString,
	RelativePattern,
	Position,
	Range,
	Diagnostic,
	CodeAction,
	WorkspaceEdit,
	Hover,
	CompletionItem,
	SnippetString,
	CodeLens,
	TextDocument,
	Disposable: {
		from: (...items) => ({ dispose: () => items.forEach((d) => d?.dispose?.()) }),
	},
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ViewColumn: { Active: -1, Beside: -2 },
	ProgressLocation: { Notification: 15, Window: 10 },
	ConfigurationTarget: { Global: 1 },
	StatusBarAlignment: { Left: 1, Right: 2 },
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	CodeActionKind: { QuickFix: 'quickfix' },
	CompletionItemKind: { Property: 9, EnumMember: 19 },
	QuickPickItemKind: { Separator: -1, Default: 0 },
	languages: {
		createDiagnosticCollection(name) {
			const collection = {
				name,
				set: (uri, items) => state.diagnostics.set(uri.toString(), items),
				delete: (uri) => state.diagnostics.delete(uri.toString()),
				dispose() {},
			};
			return collection;
		},
		registerCodeActionsProvider: (selector, provider) => (state.providers.codeActions.push({ selector, provider }), { dispose() {} }),
		registerHoverProvider: (selector, provider) => (state.providers.hovers.push({ selector, provider }), { dispose() {} }),
		registerCompletionItemProvider: (selector, provider) => (state.providers.completions.push({ selector, provider }), { dispose() {} }),
		registerCodeLensProvider: (selector, provider) => (state.providers.codeLenses.push({ selector, provider }), { dispose() {} }),
	},
	window: {
		activeTextEditor: undefined,
		createStatusBarItem() {
			const item = { shown: false, show: () => (item.shown = true), hide: () => (item.shown = false), dispose() {} };
			state.statusBarItems.push(item);
			return item;
		},
		setStatusBarMessage: () => ({ dispose() {} }),
		createQuickPick: () => ({ items: [], show() {}, hide() {}, dispose() {}, onDidAccept: () => ({ dispose() {} }), onDidHide: () => ({ dispose() {} }) }),
		createOutputChannel(name) {
			const channel = { name, lines: [], appendLine: (l) => channel.lines.push(l), show() {}, dispose() {} };
			state.outputs.push(channel);
			return channel;
		},
		createTreeView(id, options) {
			const view = {
				id,
				provider: options.treeDataProvider,
				visible: false,
				onDidChangeVisibility: () => ({ dispose() {} }),
				dispose() {},
			};
			state.trees.set(id, view);
			return view;
		},
		registerCustomEditorProvider(viewType, provider) {
			state.customEditors.set(viewType, provider);
			return { dispose() {} };
		},
		createWebviewPanel: () => makePanel(),
		showInformationMessage: (m) => {
			state.messages.push(['info', m]);
			return Promise.resolve(undefined);
		},
		showWarningMessage: (m) => {
			state.messages.push(['warn', m]);
			return Promise.resolve(undefined);
		},
		showErrorMessage: (m) => {
			state.messages.push(['error', m]);
			return Promise.resolve(undefined);
		},
		showInputBox: () => Promise.resolve(undefined),
		withProgress: (_options, task) =>
			task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
	},
	workspace: {
		workspaceFolders: [{ uri: Uri.file('/workspace'), name: 'workspace', index: 0 }],
		getConfiguration: () => ({
			get: (key, fallback) => (key in state.config ? state.config[key] : fallback),
			update: () => Promise.resolve(),
		}),
		findFiles: () => Promise.resolve(state.files),
		createFileSystemWatcher: watcher,
		get textDocuments() {
			return state.documents;
		},
		onDidOpenTextDocument: (fn) => state.openDocument.event(fn),
		onDidChangeTextDocument: (fn) => state.changeDocument.event(fn),
		onDidCloseTextDocument: (fn) => state.closeDocument.event(fn),
		onDidChangeConfiguration: (fn) => state.changeConfiguration.event(fn),
		openTextDocument: ({ language, content }) => Promise.resolve(new TextDocument(Uri.parse(`untitled://doc-${Date.now()}`), language, content)),
		asRelativePath: (uri) => String(uri.path || uri).replace('/workspace/', ''),
		fs: {
			stat: () => Promise.resolve({ size: 1024 }),
			readFile: (uri) => Promise.resolve(state.fileBytes.get(uri.path) || new Uint8Array()),
			writeFile: (uri, bytes) => {
				state.fileBytes.set(uri.path, bytes);
				return Promise.resolve();
			},
			readDirectory: () => Promise.resolve([]),
			createDirectory: () => Promise.resolve(),
		},
	},
	commands: {
		registerCommand(id, fn) {
			state.commands.set(id, fn);
			return { dispose: () => state.commands.delete(id) };
		},
		executeCommand: (id, ...args) => Promise.resolve(state.commands.get(id)?.(...args)),
	},
	env: {
		clipboard: { writeText: () => Promise.resolve() },
		openExternal: () => Promise.resolve(true),
	},
};

function makePanel() {
	const emitter = new EventEmitter();
	return {
		webview: {
			options: {},
			html: '',
			cspSource: 'vscode-resource://fake',
			asWebviewUri: (uri) => Uri.parse(`https://fake.vscode-cdn.net${uri.path}`),
			onDidReceiveMessage: (fn) => {
				emitter.event(fn);
				return { dispose() {} };
			},
			postMessage: () => Promise.resolve(true),
			send: (msg) => emitter.fire(msg),
		},
		active: true,
		title: '',
		reveal() {},
		onDidChangeViewState: () => ({ dispose() {} }),
		onDidDispose: () => ({ dispose() {} }),
		dispose() {},
	};
}

module.exports = { vscode, state, makePanel };
