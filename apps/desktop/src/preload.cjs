// The only bridge between the companion's renderer and the machine.
//
// Context isolation is on and node integration is off, so the renderer (which
// embeds remote content from three.ws in an iframe) can reach exactly these
// calls and nothing else. No fs, no child_process, no ipcRenderer.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('companion', {
	// State
	credentials: () => ipcRenderer.invoke('companion:credentials'),
	saveToken: (payload) => ipcRenderer.invoke('companion:save-token', payload),

	// Events from the main process
	onDelivery: (handler) => {
		const listener = (_event, delivery) => handler(delivery);
		ipcRenderer.on('companion:delivery', listener);
		return () => ipcRenderer.removeListener('companion:delivery', listener);
	},
	onStatus: (handler) => {
		const listener = (_event, status) => handler(status);
		ipcRenderer.on('companion:status', listener);
		ipcRenderer.on('companion:connected', listener);
		return () => {
			ipcRenderer.removeListener('companion:status', listener);
			ipcRenderer.removeListener('companion:connected', listener);
		};
	},

	// Actions
	setInteractive: (interactive) => ipcRenderer.send('companion:set-interactive', Boolean(interactive)),
	sayNative: (text) => ipcRenderer.send('companion:say-native', String(text || '')),
	notifyNative: (delivery) => ipcRenderer.send('companion:notify-native', delivery),
	openExternal: (url) => ipcRenderer.invoke('companion:open-external', url),
});
