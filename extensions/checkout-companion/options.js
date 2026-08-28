// Settings, and the only place the bridge token is entered or cleared.

const tokenInput = document.getElementById('bridgeToken');
const saved = document.getElementById('saved');
const priceCount = document.getElementById('priceCount');

const { bridgeToken = '' } = await chrome.storage.local.get({ bridgeToken: '' });
// The stored token is never rendered back. Showing a credential in a text field
// so it can be shoulder-surfed buys nothing: someone who wants to change it
// types a new one, and someone who wants it gone presses Disconnect.
tokenInput.placeholder = bridgeToken
	? 'A token is saved. Type a new one to replace it.'
	: 'Leave blank to use your signed-in session';

function flash(message) {
	saved.textContent = message;
	setTimeout(() => {
		saved.textContent = '';
	}, 2600);
}

document.getElementById('save').addEventListener('click', async () => {
	const value = tokenInput.value.trim();
	if (!value) {
		flash('Nothing to save. Clear the field and press Disconnect to remove a saved token.');
		return;
	}
	await chrome.storage.local.set({ bridgeToken: value });
	tokenInput.value = '';
	tokenInput.placeholder = 'A token is saved. Type a new one to replace it.';
	const state = await chrome.runtime.sendMessage({ type: 'checkout:ping' });
	flash(state?.connected ? 'Saved and connected.' : 'Saved, but three.ws did not accept it.');
});

document.getElementById('clear').addEventListener('click', async () => {
	await chrome.storage.local.remove('bridgeToken');
	tokenInput.value = '';
	tokenInput.placeholder = 'Leave blank to use your signed-in session';
	flash('Disconnected. It will use your signed-in session instead.');
});

async function renderPrices() {
	const { prices = {} } = await chrome.storage.local.get({ prices: {} });
	const n = Object.keys(prices).length;
	priceCount.textContent = n
		? `${n} site${n === 1 ? '' : 's'} remembered, each for up to an hour.`
		: 'None.';
}

document.getElementById('forget').addEventListener('click', async () => {
	await chrome.storage.local.set({ prices: {} });
	await renderPrices();
	flash('Forgotten.');
});

await renderPrices();
