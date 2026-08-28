// Email lane: IMAP with the user's own credentials.
//
// IMAP is the only inbox protocol every provider still speaks without an OAuth
// application, which is what makes it the honest BYOK choice: the user creates
// an app password (Gmail, iCloud, Fastmail, Proton Bridge, Outlook) scoped to
// mail only, and can revoke it from their provider at any moment. The password
// is stored encrypted (api/_lib/companion/crypto.js) and used for nothing but a
// short read-only connection during a poll.
//
// Only headers and a short text preview are ever pulled. Nothing is marked as
// read: the mailbox is opened read-only, so the user's own inbox state is
// untouched by the companion watching it.

import { ImapFlow } from 'imapflow';
import { parse as parseHtml } from 'node-html-parser';
import { resolvePublicHost } from '../../ssrf.js';
import { shorten } from '../triage.js';

const CONNECT_TIMEOUT_MS = 15_000;
const MAX_MESSAGES_PER_POLL = 20;
const PREVIEW_CHARS = 900;

// The host comes from the user, so it is resolved on our side and the socket is
// opened against a validated public address with the original hostname kept for
// TLS verification. That blocks the internal-target case (an IMAP "server" on
// 169.254.169.254 or a private range) the same way the HTTP fetchers do.
async function connectionOptions(config) {
	const host = String(config.host || '').trim();
	const addresses = await resolvePublicHost(host);
	const port = Number(config.port) || 993;
	const secure = config.secure !== false;
	return {
		host: addresses[0].address,
		servername: host,
		port,
		secure,
		auth: { user: config.user, pass: config.pass },
		logger: false,
		emitLogs: false,
		clientInfo: { name: 'three.ws companion' },
		greetingTimeout: CONNECT_TIMEOUT_MS,
		socketTimeout: 60_000,
		connectionTimeout: CONNECT_TIMEOUT_MS,
	};
}

async function withMailbox(config, fn) {
	const client = new ImapFlow(await connectionOptions(config));
	await client.connect();
	const folder = config.folder || 'INBOX';
	// Read-only: the poll must never consume the user's unread state.
	const lock = await client.getMailboxLock(folder, { readOnly: true });
	try {
		return await fn(client, lock);
	} finally {
		lock.release();
		await client.logout().catch(() => client.close());
	}
}

export async function verifyEmail(config) {
	return withMailbox(config, async (client) => ({
		detail: `Connected to ${client.mailbox.path} as ${config.user}. ${client.mailbox.exists} message${client.mailbox.exists === 1 ? '' : 's'} in the folder.`,
		mailbox: client.mailbox.path,
		exists: client.mailbox.exists,
		uid_next: client.mailbox.uidNext,
	}));
}

function addressOf(entry) {
	if (!entry?.length) return { name: null, address: null };
	const first = entry[0];
	return { name: first.name || null, address: first.address || null };
}

// Pick the part worth reading: plain text if the message has it, HTML otherwise.
function previewPart(node) {
	if (!node) return null;
	if (node.childNodes?.length) {
		const parts = node.childNodes.flatMap((child) => {
			const found = previewPart(child);
			return found ? [found] : [];
		});
		return parts.find((p) => p.type === 'text/plain') || parts[0] || null;
	}
	const type = String(node.type || '').toLowerCase();
	if (type !== 'text/plain' && type !== 'text/html') return null;
	if (String(node.disposition || '').toLowerCase() === 'attachment') return null;
	return { type, part: node.part || '1', size: node.size || 0 };
}

function decodeBuffer(buffer, charset) {
	try {
		return new TextDecoder(charset || 'utf-8', { fatal: false }).decode(buffer);
	} catch {
		return buffer.toString('utf8');
	}
}

function toPlainText(text, type) {
	if (type !== 'text/html') return text;
	try {
		return parseHtml(text).textContent || '';
	} catch {
		return text.replace(/<[^>]+>/g, ' ');
	}
}

async function readPreview(client, uid, structure) {
	const target = previewPart(structure);
	if (!target) return '';
	try {
		const { content, meta } = await client.download(uid, target.part, { uid: true, maxBytes: 64_000 });
		const chunks = [];
		for await (const chunk of content) chunks.push(chunk);
		const text = decodeBuffer(Buffer.concat(chunks), meta?.charset);
		return shorten(toPlainText(text, target.type).replace(/^\s*>.*$/gm, ''), PREVIEW_CHARS);
	} catch {
		// A part that will not download (server quirk, oversized part) still
		// leaves a fully usable event: subject, sender, and time.
		return '';
	}
}

/**
 * Read everything that arrived since the stored UID.
 *
 * The first poll of a new connection does not replay the mailbox: it records
 * the current UIDNEXT and starts from the next message, so connecting an inbox
 * with 40,000 messages does not make the companion announce 40,000 of them.
 *
 * @returns {{ items: Array, cursor: object }}
 */
export async function pollEmail({ config, cursor = {} }) {
	return withMailbox(config, async (client) => {
		const uidNext = client.mailbox.uidNext || 1;
		const lastUid = Number(cursor.uid) || 0;
		if (!lastUid) {
			return { items: [], cursor: { uid: Math.max(0, uidNext - 1), uid_validity: String(client.mailbox.uidValidity || '') } };
		}
		// A changed UIDVALIDITY means the server renumbered the mailbox and old
		// UIDs mean nothing. Re-baseline instead of replaying the whole folder.
		const validity = String(client.mailbox.uidValidity || '');
		if (cursor.uid_validity && cursor.uid_validity !== validity) {
			return { items: [], cursor: { uid: Math.max(0, uidNext - 1), uid_validity: validity } };
		}

		const rows = [];
		// `N:*` always returns at least the newest message even when its UID is
		// below N, so every row is re-checked against the cursor below.
		for await (const message of client.fetch(
			{ uid: `${lastUid + 1}:*` },
			{ uid: true, envelope: true, bodyStructure: true, flags: true },
			{ uid: true },
		)) {
			if (message.uid <= lastUid) continue;
			rows.push(message);
			if (rows.length >= MAX_MESSAGES_PER_POLL) break;
		}

		const items = [];
		let highest = lastUid;
		for (const message of rows) {
			highest = Math.max(highest, message.uid);
			const from = addressOf(message.envelope?.from);
			const body = await readPreview(client, message.uid, message.bodyStructure);
			items.push({
				external_id: `imap:${validity}:${message.uid}`,
				sender: from.name || from.address || 'Email',
				sender_id: from.address,
				identity_candidates: [from.address, from.name].filter(Boolean),
				title: message.envelope?.subject || '(no subject)',
				body: body || null,
				url: null,
				occurs_at: message.envelope?.date ? new Date(message.envelope.date).toISOString() : null,
			});
		}

		return { items, cursor: { uid: highest, uid_validity: validity } };
	});
}
