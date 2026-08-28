// three.ws Companion for the desktop - the main process.
//
// What this app is: a transparent, click-through window the size of your screen
// with a 3D character living in it. The character walks across the bottom of
// the desktop, and when something arrives that clears your bar (a message from
// a saved contact, a meeting about to start, a one-time code, an agent that
// decided you need to know), it walks over, turns to you, and says it out loud.
//
// Three details make it feel like part of the machine rather than a browser:
//
//   1. The window ignores the mouse everywhere except the character and its
//      speech bubble. `setIgnoreMouseEvents(true, { forward: true })` still
//      delivers move events to the renderer, so the renderer tells us the
//      moment the pointer is over something clickable and we hand input back.
//   2. It is visible on every workspace, including over full-screen apps
//      (macOS panel level), so it is a companion rather than another window to
//      manage.
//   3. It holds no credentials of its own. The bridge token is the same one the
//      CLI uses (packages/companion-sdk/src/config.js), so `companion login` on
//      the command line signs this app in too, and rotating the token at
//      three.ws/companion revokes every device at once.

import { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, Notification, nativeImage } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createCompanionClient } from '@three-ws/companion';
import { resolveCredentials, writeConfig, configPath } from '@three-ws/companion/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS = join(__dirname, '..', 'assets');

// How tall a strip of the screen the companion lives in. The window is only as
// large as it needs to be: a full-screen transparent window over every display
// costs compositor work for nothing.
const STAGE_HEIGHT = 420;

const state = {
	window: null,
	tray: null,
	client: null,
	stopStream: null,
	paused: false,
	lastDelivery: null,
	connected: false,
	signInWindow: null,
};

function credentials() {
	return resolveCredentials();
}

// ── The stage window ─────────────────────────────────────────────────────────

function createStageWindow() {
	const display = screen.getPrimaryDisplay();
	const { x, y, width, height } = display.workArea;

	const win = new BrowserWindow({
		x,
		y: y + Math.max(0, height - STAGE_HEIGHT),
		width,
		height: Math.min(STAGE_HEIGHT, height),
		transparent: true,
		frame: false,
		resizable: false,
		movable: false,
		minimizable: false,
		maximizable: false,
		fullscreenable: false,
		skipTaskbar: true,
		hasShadow: false,
		focusable: false,
		// 'panel' floats above full-screen apps on macOS; the other platforms
		// take the plain always-on-top path.
		...(process.platform === 'darwin' ? { type: 'panel' } : {}),
		webPreferences: {
			preload: join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
			// The renderer embeds three.ws/walk-embed in an iframe; that is the
			// only remote content it loads, and it runs sandboxed.
			sandbox: false,
		},
	});

	win.setAlwaysOnTop(true, 'screen-saver');
	win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
	// Click-through by default; the renderer hands input back when the pointer
	// is genuinely over the character or its bubble.
	win.setIgnoreMouseEvents(true, { forward: true });
	win.loadFile(join(__dirname, 'renderer', 'index.html'));

	if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });

	// Keep the stage glued to the bottom of whatever the display becomes.
	const reposition = () => {
		if (win.isDestroyed()) return;
		const area = screen.getPrimaryDisplay().workArea;
		win.setBounds({
			x: area.x,
			y: area.y + Math.max(0, area.height - STAGE_HEIGHT),
			width: area.width,
			height: Math.min(STAGE_HEIGHT, area.height),
		});
	};
	screen.on('display-metrics-changed', reposition);
	screen.on('display-added', reposition);
	screen.on('display-removed', reposition);

	return win;
}

function send(channel, payload) {
	if (state.window && !state.window.isDestroyed()) state.window.webContents.send(channel, payload);
}

// ── The delivery stream ──────────────────────────────────────────────────────

function connect() {
	state.stopStream?.();
	state.stopStream = null;
	state.connected = false;

	const { token, apiBase } = credentials();
	if (!token) {
		send('companion:status', { signedIn: false, apiBase });
		refreshTray();
		return;
	}

	state.client = createCompanionClient({ token, apiBase });
	send('companion:status', { signedIn: true, apiBase, paused: state.paused });

	state.stopStream = state.client.stream({
		onOpen: (hello) => {
			state.connected = true;
			refreshTray();
			send('companion:connected', { ...hello, apiBase });
		},
		onDelivery: (delivery) => {
			state.lastDelivery = delivery;
			if (state.paused) return;
			send('companion:delivery', delivery);
			// The stage says it; the OS notification is the fallback for a
			// machine whose screen is locked or whose GPU refused the renderer.
			if (!state.window || state.window.isDestroyed()) notifyNatively(delivery);
			state.client.markDelivered(delivery.id).catch(() => {});
		},
		onError: () => {
			state.connected = false;
			refreshTray();
		},
	});
	refreshTray();
}

function notifyNatively(delivery) {
	if (!Notification.isSupported()) return;
	new Notification({
		title: delivery.speaker || 'Your companion',
		body: delivery.spoken_line || delivery.title,
		silent: false,
	}).show();
}

// ── Tray ─────────────────────────────────────────────────────────────────────

function refreshTray() {
	if (!state.tray) return;
	const { token } = credentials();
	const status = !token
		? 'Not signed in'
		: state.paused
			? 'Paused'
			: state.connected
				? 'Listening'
				: 'Reconnecting…';

	state.tray.setToolTip(`three.ws Companion - ${status}`);
	state.tray.setContextMenu(Menu.buildFromTemplate([
		{ label: `three.ws Companion (${status})`, enabled: false },
		{ type: 'separator' },
		{
			label: state.paused ? 'Resume' : 'Pause deliveries',
			click: () => {
				state.paused = !state.paused;
				send('companion:status', { signedIn: Boolean(token), paused: state.paused });
				refreshTray();
			},
		},
		{
			label: 'Say the last one again',
			enabled: Boolean(state.lastDelivery),
			click: () => state.lastDelivery && send('companion:delivery', state.lastDelivery),
		},
		{ type: 'separator' },
		{ label: token ? 'Change bridge token…' : 'Sign in…', click: openSignIn },
		{ label: 'Open three.ws/companion', click: () => shell.openExternal(`${credentials().apiBase}/companion`) },
		{
			label: 'Start at login',
			type: 'checkbox',
			checked: app.getLoginItemSettings().openAtLogin,
			click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, openAsHidden: true }),
		},
		{ type: 'separator' },
		{ label: `Config: ${configPath()}`, enabled: false },
		{ label: 'Quit', role: 'quit' },
	]));
}

// ── Sign in ──────────────────────────────────────────────────────────────────

function openSignIn() {
	if (state.signInWindow && !state.signInWindow.isDestroyed()) {
		state.signInWindow.focus();
		return;
	}
	state.signInWindow = new BrowserWindow({
		width: 460,
		height: 380,
		resizable: false,
		title: 'Sign in to your companion',
		webPreferences: {
			preload: join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	state.signInWindow.loadFile(join(__dirname, 'renderer', 'sign-in.html'));
	state.signInWindow.on('closed', () => {
		state.signInWindow = null;
	});
}

// ── IPC ──────────────────────────────────────────────────────────────────────

ipcMain.handle('companion:credentials', () => {
	const { token, apiBase } = credentials();
	return { signedIn: Boolean(token), apiBase, paused: state.paused, configPath: configPath() };
});

ipcMain.handle('companion:save-token', async (_event, { token, apiBase }) => {
	const trimmed = String(token || '').trim();
	if (!trimmed) return { ok: false, error: 'Paste the bridge token from three.ws/companion.' };
	const base = String(apiBase || credentials().apiBase);
	try {
		// Prove it before storing it: a bad token should fail here, in a window
		// the person is looking at, not silently at 3am.
		await createCompanionClient({ token: trimmed, apiBase: base }).list({ limit: 1 });
	} catch (err) {
		return { ok: false, error: `That token was refused: ${err.message}` };
	}
	writeConfig({ token: trimmed, apiBase: base });
	connect();
	return { ok: true };
});

ipcMain.handle('companion:open-external', (_event, url) => {
	const target = String(url || '');
	if (!/^https?:\/\//i.test(target)) return false;
	shell.openExternal(target);
	return true;
});

// The renderer owns hit-testing: it knows where the character and bubble are.
ipcMain.on('companion:set-interactive', (_event, interactive) => {
	if (!state.window || state.window.isDestroyed()) return;
	state.window.setIgnoreMouseEvents(!interactive, { forward: true });
});

// macOS ships a real speech synthesiser; used when the hosted voice lanes and
// the renderer's own speech synthesis both come up empty.
ipcMain.on('companion:say-native', (_event, text) => {
	if (process.platform !== 'darwin') return;
	try {
		spawn('say', [String(text).slice(0, 500)], { stdio: 'ignore', detached: true }).unref();
	} catch {
		/* no `say` binary: the bubble already carries the line */
	}
});

ipcMain.on('companion:notify-native', (_event, delivery) => notifyNatively(delivery || {}));

// ── Lifecycle ────────────────────────────────────────────────────────────────

// One instance only: two companions on one desktop would speak in unison.
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => openSignIn());

	app.whenReady().then(() => {
		// The dock icon is noise for something that lives in the menu bar.
		if (process.platform === 'darwin') app.dock?.hide();

		state.window = createStageWindow();

		const icon = nativeImage.createFromPath(join(ASSETS, 'tray-icon.png'));
		state.tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 18, height: 18 }));
		refreshTray();
		state.tray.on('click', () => state.tray.popUpContextMenu());

		connect();

		if (!credentials().token) openSignIn();
	});

	// A companion has no windows to close back into: it lives in the tray.
	app.on('window-all-closed', (event) => event.preventDefault?.());

	app.on('before-quit', () => {
		state.stopStream?.();
	});
}
