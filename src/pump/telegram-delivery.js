// Required env: TELEGRAM_BOT_TOKEN — obtain from Telegram @BotFather

const KIND_LABEL = {
	mint: 'New Mint',
	whale: 'Whale Move',
	claim: 'Claim',
	graduation: 'Graduation',
};

export async function sendTelegramSignal({ botToken, chatId, signal }) {
	const text = formatSignal(signal);
	const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
	// Bounded, and retried once on the statuses Telegram uses for backpressure.
	// A signal is worth delivering late; it is not worth losing to one 429, and
	// an unbounded POST could hold the caller open indefinitely.
	let res = null;
	for (let attempt = 0; attempt < 2; attempt++) {
		res = await fetch(url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
			signal: AbortSignal.timeout(8000),
		});
		if (res.ok) break;
		if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
			const retryAfter = Number(res.headers.get('retry-after'));
			const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 5000) : 750;
			await new Promise((r) => setTimeout(r, waitMs));
			continue;
		}
		break;
	}
	if (!res.ok) {
		const body = await res.text();
		throw Object.assign(new Error(`Telegram API ${res.status}: ${body}`), { status: 502 });
	}
	const data = await res.json();
	return { ok: true, messageId: data.result.message_id };
}

// Every field below is attacker-influenced (a signal summary is derived from
// on-chain token metadata). Telegram's legacy `Markdown` parse_mode treats
// _ * ` [ as control characters, so unescaped text can break out of the
// formatting and smuggle a clickable link posted under the platform bot's
// verified identity. `]` is escaped too: it closes the link-text span, so a
// bracketed run in attacker text can never complete into a `[text](url)`
// entity. Escape before interpolating, never after.
function escapeMarkdown(text) {
	return String(text ?? '').replace(/[_*`[\]]/g, '\\$&');
}

function formatSignal({ kind, mint, summary, refs, ts }) {
	const label = escapeMarkdown(KIND_LABEL[kind] ?? kind);
	const time = ts ? new Date(ts).toUTCString() : new Date().toUTCString();
	let msg = `*${label}*\n\`${escapeMarkdown(mint)}\`\n\n${escapeMarkdown(summary)}`;
	if (refs?.length) msg += '\n\n' + refs.map((r) => `• ${escapeMarkdown(r)}`).join('\n');
	msg += `\n\n_${escapeMarkdown(time)}_`;
	return msg;
}
