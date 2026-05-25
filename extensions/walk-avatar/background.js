// background.js — service worker for the Walk Avatar extension.
// Manages state persistence, auth token relay, and per-tab enable/disable.

const THREEWS_ORIGIN = 'https://three.ws';

// Default settings merged into chrome.storage.local on first install.
const DEFAULTS = {
	avatarId: '',
	walkSpeed: 1.0,
	position: 'bottom-right',
	width: 180,
	height: 260,
	enabledGlobal: false,
	siteAllowlist: [],
	siteBlocklist: [],
	narrationEnabled: false,
	voice: 'default',
	theme: 'auto',
};

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
	if (reason === 'install') {
		await chrome.storage.sync.set(DEFAULTS);
	}
});

// Relay messages between popup and content scripts.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
	if (msg.type === 'get-state') {
		Promise.all([
			chrome.storage.local.get(['threews_session']),
			chrome.storage.sync.get(null),
		]).then(([local, sync]) => {
			sendResponse({ session: local.threews_session || null, settings: sync });
		});
		return true; // async
	}

	if (msg.type === 'set-avatar') {
		chrome.storage.sync.set({ avatarId: msg.avatarId }).then(() => {
			// Push new avatar to all active content scripts.
			chrome.tabs.query({ status: 'complete' }, (tabs) => {
				tabs.forEach((tab) => {
					chrome.tabs.sendMessage(tab.id, {
						type: 'walk:setAvatar',
						avatarId: msg.avatarId,
					}).catch(() => {}); // tab may not have content script
				});
			});
			sendResponse({ ok: true });
		});
		return true;
	}

	if (msg.type === 'toggle-tab') {
		const { tabId, enabled, avatarId } = msg;
		if (enabled) {
			// Inject content script into the tab.
			chrome.scripting.executeScript({
				target: { tabId },
				files: ['content.js'],
			}).then(() => {
				chrome.tabs.sendMessage(tabId, {
					type: 'walk:mount',
					avatarId,
				}).catch(() => {});
				sendResponse({ ok: true });
			}).catch((err) => {
				sendResponse({ ok: false, error: err.message });
			});
		} else {
			chrome.tabs.sendMessage(tabId, { type: 'walk:unmount' }).catch(() => {});
			sendResponse({ ok: true });
		}
		return true;
	}

	if (msg.type === 'store-session') {
		chrome.storage.local.set({ threews_session: msg.token }).then(() => {
			sendResponse({ ok: true });
		});
		return true;
	}

	if (msg.type === 'clear-session') {
		chrome.storage.local.remove('threews_session').then(() => {
			sendResponse({ ok: true });
		});
		return true;
	}

	if (msg.type === 'update-settings') {
		chrome.storage.sync.set(msg.settings).then(() => {
			sendResponse({ ok: true });
		});
		return true;
	}
});

// Listen for the auth callback page posting the session token via postMessage.
// The login page at three.ws/login?redirect=ext fires a broadcast that the
// background service worker intercepts here via declarativeNetRequest or
// chrome.tabs, then stores it.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
	if (
		changeInfo.status === 'complete' &&
		tab.url &&
		tab.url.startsWith(THREEWS_ORIGIN + '/extension/auth-callback')
	) {
		chrome.scripting.executeScript({
			target: { tabId },
			func: () => {
				const params = new URLSearchParams(location.search);
				return params.get('token');
			},
		}).then(([result]) => {
			const token = result?.result;
			if (token) {
				chrome.storage.local.set({ threews_session: token });
				chrome.tabs.remove(tabId).catch(() => {});
			}
		}).catch(() => {});
	}
});
