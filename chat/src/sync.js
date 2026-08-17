import { getAPIKeysAsObject, setAPIKeysFromObject, syncServer } from './stores.js';
import { get } from 'svelte/store';

// Empty by default: there is no hosted sync server right now. Users who
// self-host can paste their address into Settings → Sync server address.
export const syncHostedAddress = '';

// Encryption state
let encryptionKey = null;

// Network failure circuit-breaker: after MAX_FAILURES consecutive errors,
// stop attempting requests for COOLDOWN_MS so we don't spam an unreachable host.
const MAX_FAILURES = 3;
const COOLDOWN_MS = 5 * 60 * 1000;
let consecutiveFailures = 0;
let circuitOpenedAt = 0;
let failureWarned = false;

function circuitOpen() {
	if (consecutiveFailures < MAX_FAILURES) return false;
	if (Date.now() - circuitOpenedAt > COOLDOWN_MS) {
		// Cool-down elapsed, so allow one probe to test recovery.
		consecutiveFailures = 0;
		failureWarned = false;
		return false;
	}
	return true;
}

async function safePostJson(url, body, fallback) {
	// No address configured (or relative), so skip silently.
	if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return fallback;
	if (circuitOpen()) return fallback;
	try {
		const response = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		});
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const json = await response.json();
		consecutiveFailures = 0;
		failureWarned = false;
		return json;
	} catch (e) {
		consecutiveFailures++;
		if (consecutiveFailures >= MAX_FAILURES) circuitOpenedAt = Date.now();
		if (!failureWarned) {
			console.warn(
				`[sync] sync server unreachable (${url}): ${e?.message || e}. Sync paused.`
			);
			failureWarned = true;
		}
		return fallback;
	}
}

// Reset the breaker. Call it after the user changes the sync address so a new host
// gets a fresh attempt instead of inheriting the prior host's failure count.
export function resetSyncCircuit() {
	consecutiveFailures = 0;
	circuitOpenedAt = 0;
	failureWarned = false;
}

// Initialize encryption with password
export async function initEncryption(password) {
	if (!password) {
		encryptionKey = null;
		return false;
	}

	try {
		encryptionKey = await generateEncryptionKey(password);
		return true;
	} catch (e) {
		console.error('Failed to initialize encryption:', e);
		return false;
	}
}

export function isEncryptionEnabled() {
	return encryptionKey !== null;
}

// Encryption utilities
async function generateEncryptionKey(password) {
	const encoder = new TextEncoder();
	const passwordData = encoder.encode(password);
	const salt = encoder.encode('threews-sync-salt');

	const keyMaterial = await window.crypto.subtle.importKey(
		'raw',
		passwordData,
		{ name: 'PBKDF2' },
		false,
		['deriveBits', 'deriveKey']
	);

	return window.crypto.subtle.deriveKey(
		{
			name: 'PBKDF2',
			salt,
			iterations: 100000,
			hash: 'SHA-256',
		},
		keyMaterial,
		{ name: 'AES-GCM', length: 256 },
		false,
		['encrypt', 'decrypt']
	);
}

async function encryptData(data) {
	const iv = window.crypto.getRandomValues(new Uint8Array(12));
	const encoder = new TextEncoder();
	const dataBuffer = encoder.encode(JSON.stringify(data));

	const encryptedBuffer = await window.crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv },
		encryptionKey,
		dataBuffer
	);

	const result = new Uint8Array(iv.length + encryptedBuffer.byteLength);
	result.set(iv, 0);
	result.set(new Uint8Array(encryptedBuffer), iv.length);

	return bufferToBase64(result);
}

async function decryptData(encryptedBase64) {
	const encryptedData = base64ToBuffer(encryptedBase64);
	const iv = encryptedData.slice(0, 12);
	const encryptedBuffer = encryptedData.slice(12);

	const decryptedBuffer = await window.crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv },
		encryptionKey,
		encryptedBuffer
	);

	const decoder = new TextDecoder();
	const decryptedText = decoder.decode(decryptedBuffer);
	return JSON.parse(decryptedText);
}

// Helper functions for base64 conversion
function bufferToBase64(buffer) {
	const bytes = new Uint8Array(buffer);
	let binary = '';
	for (let i = 0; i < bytes.byteLength; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return window.btoa(binary);
}

function base64ToBuffer(base64) {
	const binary = window.atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

// Encrypt/decrypt individual items
async function encryptItem(item) {
	if (!item || !encryptionKey) return item;

	// Keep sync-related metadata unencrypted
	const id = item.id;
	const deleted = item.deleted;
	const deletedAt = item.deletedAt;
	const modified = item.modified;

	// Encrypt everything else
	const contentToEncrypt = { ...item };
	delete contentToEncrypt.id;
	delete contentToEncrypt.deleted;
	delete contentToEncrypt.deletedAt;
	delete contentToEncrypt.modified;

	const encryptedContent = await encryptData(contentToEncrypt);

	// Return object with unencrypted sync metadata
	const result = {
		id,
		_encrypted: encryptedContent,
	};

	// Only include sync metadata that exists
	if (deleted !== undefined) result.deleted = deleted;
	if (deletedAt !== undefined) result.deletedAt = deletedAt;
	if (modified !== undefined) result.modified = modified;

	return result;
}

async function decryptItem(item) {
	if (!item || !encryptionKey) return item;
	if (!item._encrypted) return item; // Not an encrypted item

	try {
		// Extract sync metadata
		const id = item.id;
		const deleted = item.deleted;
		const deletedAt = item.deletedAt;
		const modified = item.modified;

		// Decrypt the content
		const decryptedContent = await decryptData(item._encrypted);

		// Combine sync metadata with decrypted content
		const result = {
			id,
			...decryptedContent,
		};

		// Only include sync metadata that exists
		if (deleted !== undefined) result.deleted = deleted;
		if (deletedAt !== undefined) result.deletedAt = deletedAt;
		if (modified !== undefined) result.modified = modified;

		return result;
	} catch (e) {
		console.error('Decryption failed:', e);
		throw new Error('Decryption failed, likely wrong password');
	}
}

// Encrypt/decrypt collections
async function encryptItems(items) {
	if (!items || !encryptionKey) return items;

	const result = {};
	for (const id in items) {
		result[id] = await encryptItem(items[id]);
	}
	return result;
}

async function decryptItems(items) {
	if (!items || !encryptionKey) return items;

	const result = {};
	for (const id in items) {
		try {
			result[id] = await decryptItem(items[id]);
		} catch (e) {
			console.error(`Failed to decrypt item ${id}:`, e);
			// Keep the encrypted version to avoid data loss
			result[id] = items[id];
		}
	}
	return result;
}

export async function syncPull({
	conversationIds,
	messageIds,
	saveConversation,
	saveMessage,
	deleteConversation,
	deleteMessage,
}) {
	const clientMissingResult = await checkClientMissing(
		get(syncServer).address,
		get(syncServer).token,
		conversationIds,
		messageIds
	);

	const serverItems = await getMissingItems(
		get(syncServer).address,
		get(syncServer).token,
		clientMissingResult.missingConversationIds,
		clientMissingResult.missingMessageIds
	);

	// Decrypt data if encryption is enabled
	let conversations = serverItems.conversations;
	let messages = serverItems.messages;
	let apiKeys = serverItems.apiKeys;

	if (encryptionKey) {
		try {
			conversations = await decryptItems(conversations);
			messages = await decryptItems(messages);
			apiKeys = await decryptItem(apiKeys);
		} catch (e) {
			console.error('Decryption failed during sync pull:', e);
			throw new Error('Decryption failed. Incorrect password?');
		}
	}

	const messageArray = Object.values(messages);
	const deletedMessages = messageArray.filter((m) => m.deleted);
	const newMessages = messageArray.filter((m) => !m.deleted);

	// Delete messages that were deleted on the server
	for (const message of deletedMessages) {
		deleteMessage(message, { syncToServer: false });
	}

	// First save all the messages we got from server
	for (const message of newMessages) {
		saveMessage(message, { syncToServer: false });
	}

	const conversationArray = Object.values(conversations);
	const deletedConversations = conversationArray.filter((c) => c.deleted);
	const newConversations = conversationArray.filter((c) => !c.deleted);

	for (const conversation of deletedConversations) {
		deleteConversation(conversation, { syncToServer: false });
	}

	// Then save all conversations we got from server
	for (const conversation of newConversations) {
		saveConversation(conversation, { convert: false, syncToServer: false });
	}

	if (Object.keys(apiKeys).length > 0) {
		setAPIKeysFromObject(apiKeys);
	}

	return {
		newConversations,
		deletedConversations,
		newMessages,
		deletedMessages,
	};
}

export async function syncPush({ conversations, messages }) {
	if (get(syncServer).token && get(syncServer).password) {
		await sendSingleItem(get(syncServer).address, get(syncServer).token, {
			conversation: null,
			message: null,
			apiKeys: getAPIKeysAsObject(),
		});
	}

	// Check what server is missing from client
	const serverMissingResult = await checkServerMissing(
		get(syncServer).address,
		get(syncServer).token,
		conversations.map((c) => c.id),
		messages.map((m) => m.id)
	);

	// Upload missing items if any
	if (
		serverMissingResult.missingConversationIds.length > 0 ||
		serverMissingResult.missingMessageIds.length > 0
	) {
		const conversationsToSend = {};
		for (const id of serverMissingResult.missingConversationIds) {
			conversationsToSend[id] = conversations.find((c) => c.id === id);
		}

		const messagesToSend = {};
		for (const id of serverMissingResult.missingMessageIds) {
			messagesToSend[id] = messages.find((m) => m.id === id);
		}

		// Encrypt data if encryption is enabled
		let encryptedConversations = conversationsToSend;
		let encryptedMessages = messagesToSend;

		if (encryptionKey) {
			encryptedConversations = await encryptItems(conversationsToSend);
			encryptedMessages = await encryptItems(messagesToSend);
		}

		// Send items to server
		await sendMissingItems(
			get(syncServer).address,
			get(syncServer).token,
			encryptedConversations,
			encryptedMessages
		);
	}
}

async function checkClientMissing(baseUrl, token, localConversationIds, localMessageIds) {
	return safePostJson(
		`${baseUrl}/api/sync/check-client-missing`,
		{ token, conversationIds: localConversationIds, messageIds: localMessageIds },
		{ missingConversationIds: [], missingMessageIds: [] }
	);
}

async function getMissingItems(baseUrl, token, missingConversationIds, missingMessageIds) {
	return safePostJson(
		`${baseUrl}/api/sync/get-items`,
		{ token, conversationIds: missingConversationIds, messageIds: missingMessageIds },
		{ conversations: {}, messages: {}, apiKeys: {} }
	);
}

async function checkServerMissing(baseUrl, token, allLocalConversationIds, allLocalMessageIds) {
	return safePostJson(
		`${baseUrl}/api/sync/check-server-missing`,
		{ token, conversationIds: allLocalConversationIds, messageIds: allLocalMessageIds },
		{ missingConversationIds: [], missingMessageIds: [] }
	);
}

async function sendMissingItems(baseUrl, token, conversationsToSend, messagesToSend) {
	return safePostJson(
		`${baseUrl}/api/sync/send-items`,
		{ token, conversations: conversationsToSend, messages: messagesToSend },
		{ success: false }
	);
}

export async function sendSingleItem(
	baseUrl,
	token,
	item = { conversation: null, message: null, apiKeys: null }
) {
	// Encrypt if needed
	let encryptedItem = { ...item };

	if (encryptionKey) {
		if (item.conversation) {
			encryptedItem.conversation = await encryptItem(item.conversation);
		}
		if (item.message) {
			encryptedItem.message = await encryptItem(item.message);
		}
		if (item.apiKeys) {
			encryptedItem.apiKeys = await encryptItem(item.apiKeys);
		}
	}

	return safePostJson(
		`${baseUrl}/api/sync/send-single-item`,
		{
			token,
			conversation: encryptedItem.conversation || null,
			message: encryptedItem.message || null,
			apiKeys: encryptedItem.apiKeys || null,
		},
		{ success: false }
	);
}

export async function deleteSingleItem(
	baseUrl,
	token,
	item = { conversationId: null, messageId: null }
) {
	return safePostJson(
		`${baseUrl}/api/sync/delete-single-item`,
		{
			token,
			conversationId: item.conversationId || null,
			messageId: item.messageId || null,
		},
		{ success: false }
	);
}
