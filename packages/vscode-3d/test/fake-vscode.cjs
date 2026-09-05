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
};

const vscode = {
	EventEmitter,
	Uri,
	TreeItem,
	ThemeIcon,
	MarkdownString,
	RelativePattern,
	TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
	ViewColumn: { Active: -1 },
	ProgressLocation: { Notification: 15 },
	ConfigurationTarget: { Global: 1 },
	window: {
		activeTextEditor: undefined,
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
