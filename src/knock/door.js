// The public door page: /knock/<handle>.
//
// One job, done for two very different visitors. A person reads who they are
// about to interrupt and what it costs, writes a message, and pays with the
// wallet they already have in this browser. An agent lands here to learn the
// endpoint, the price and the schema, then never opens the page again.
//
// Both get the same truth from GET /api/knock/door, so the page can never
// advertise a price the API would not charge.
//
// Payment is the browser x402 checkout (window.X402.pay, /x402.js), the same
// modal the club cover and the billboard use. It settles the USDC directly to
// the door owner and returns the endpoint's own JSON, which is the accepted
// knock plus its receipt URL.

import { knockApi } from './api.js';

const els = {};
let door = null;
let lastReceiptUrl = null;

document.addEventListener('DOMContentLoaded', () => {
	for (const id of [
		'loading', 'not-found', 'door-card', 'avatar', 'display-name', 'handle', 'verified',
		'headline', 'greeting', 'price-badge', 'price-note', 'form', 'from', 'subject',
		'message', 'url', 'counter', 'submit', 'form-error', 'sent', 'sent-line', 'receipt-url',
		'copy-receipt', 'check-reply', 'reply-box', 'knock-again', 'agent-panel', 'agent-endpoint',
		'curl-snippet', 'sdk-snippet', 'mcp-snippet', 'copy-endpoint',
	]) {
		els[id] = document.getElementById(id);
	}

	bind();
	load();
});

function handleFromPath() {
	const fromPath = decodeURIComponent(window.location.pathname.replace(/^\/knock\/?/, '')).trim();
	if (fromPath) return fromPath;
	return new URLSearchParams(window.location.search).get('to') || '';
}

async function load() {
	const handle = handleFromPath();
	if (!handle) return showNotFound('No handle in this link. Try /knock and pick a door.');

	try {
		const data = await knockApi.door(handle);
		door = data.door;
		render();
	} catch (err) {
		showNotFound(
			err.status === 404
				? `Nobody is answering at @${handle}. They may not have opened a door yet.`
				: err.message,
		);
	}
}

function showNotFound(message) {
	els.loading.hidden = true;
	els['not-found'].hidden = false;
	els['not-found'].querySelector('[data-msg]').textContent = message;
}

function render() {
	els.loading.hidden = true;
	els['door-card'].hidden = false;

	document.title = `Knock on ${door.display_name} · three.ws`;
	els['display-name'].textContent = door.display_name;
	els.handle.textContent = `@${door.handle}`;
	els.handle.href = `/u/${door.handle}`;
	els.verified.hidden = !door.verified;

	if (door.avatar_url) {
		els.avatar.src = door.avatar_url;
		els.avatar.alt = `${door.display_name}'s avatar`;
		els.avatar.hidden = false;
	} else {
		// No avatar is still a designed state: the initial keeps the layout
		// stable instead of leaving a hole where a face should be.
		els.avatar.hidden = true;
		els.avatar.parentElement.dataset.initial = (door.display_name || '?').slice(0, 1).toUpperCase();
	}

	els.headline.textContent = door.headline || '';
	els.headline.hidden = !door.headline;
	els.greeting.textContent = door.greeting || '';
	els.greeting.hidden = !door.greeting;

	els['price-badge'].textContent = door.free ? 'Free' : door.price;
	els['price-badge'].classList.toggle('is-free', door.free);
	els['price-note'].textContent = door.free
		? 'This door is open to anyone. One message, no payment.'
		: `${door.price} USDC on ${door.networks.join(' or ')}, settled straight to ${door.display_name}. One message.`;

	els.message.maxLength = door.max_chars;
	updateCounter();
	els.submit.textContent = door.free ? 'Knock' : `Pay ${door.price} and knock`;

	renderAgentPanel();
}

function renderAgentPanel() {
	const endpoint = door.endpoint;
	els['agent-endpoint'].textContent = endpoint;
	els['copy-endpoint'].dataset.copy = endpoint;

	const example = {
		from: 'Your agent',
		subject: 'One line they will hear out loud',
		message: 'What you actually want to say.',
	};

	els['curl-snippet'].textContent = door.free
		? `curl -X POST ${endpoint} \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify({ to: door.handle, ...example })}'`
		: `# 402 first, then pay and retry. Any x402 client does both steps.\ncurl -i -X POST '${endpoint}' \\\n  -H 'content-type: application/json' \\\n  -d '${JSON.stringify(example)}'`;

	els['sdk-snippet'].textContent = [
		"import { knock } from '@three-ws/knock';",
		'',
		'const receipt = await knock({',
		`  to: '${door.handle}',`,
		"  from: 'Your agent',",
		"  message: 'What you actually want to say.',",
		'  wallet,            // a Solana signer you already have',
		'  confirm: true,     // shows the price and asks before it pays',
		'});',
		'',
		'console.log(receipt.receipt_url); // poll this for a reply',
	].join('\n');

	els['mcp-snippet'].textContent = [
		'{',
		'  "mcpServers": {',
		'    "knock": {',
		'      "command": "npx",',
		'      "args": ["-y", "@three-ws/knock-mcp"]',
		'    }',
		'  }',
		'}',
	].join('\n');
}

function updateCounter() {
	const max = door?.max_chars ?? 600;
	const used = els.message.value.length;
	els.counter.textContent = `${used} / ${max}`;
	els.counter.classList.toggle('is-full', used >= max);
}

function bind() {
	els.message?.addEventListener('input', updateCounter);
	els.form?.addEventListener('submit', onSubmit);
	els['knock-again']?.addEventListener('click', () => {
		els.sent.hidden = true;
		els.form.hidden = false;
		els.message.value = '';
		els.subject.value = '';
		updateCounter();
		els.from.focus();
	});
	els['check-reply']?.addEventListener('click', checkReply);
	for (const btn of document.querySelectorAll('[data-copy-target], [data-copy]')) {
		btn.addEventListener('click', () => copy(btn));
	}
	// Cmd/Ctrl+Enter sends, because everyone tries it in a message box.
	els.message?.addEventListener('keydown', (e) => {
		if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') els.form.requestSubmit();
	});
}

async function copy(btn) {
	const text = btn.dataset.copy || document.getElementById(btn.dataset.copyTarget)?.textContent || '';
	if (!text) return;
	try {
		await navigator.clipboard.writeText(text);
		const original = btn.textContent;
		btn.textContent = 'Copied';
		btn.classList.add('is-ok');
		setTimeout(() => {
			btn.textContent = original;
			btn.classList.remove('is-ok');
		}, 1400);
	} catch {
		// Clipboard blocked (insecure context, denied permission). Select the
		// text instead so the visitor can copy it by hand rather than get
		// nothing at all.
		const target = document.getElementById(btn.dataset.copyTarget);
		if (target) window.getSelection()?.selectAllChildren(target);
	}
}

function payload() {
	const body = {
		from: els.from.value.trim(),
		message: els.message.value.trim(),
		sender_kind: 'human',
	};
	if (els.subject.value.trim()) body.subject = els.subject.value.trim();
	if (els.url.value.trim()) body.url = els.url.value.trim();
	return body;
}

async function onSubmit(e) {
	e.preventDefault();
	setError('');
	const body = payload();
	if (body.message.length < 8) return setError('Say at least 8 characters.');
	if (!body.from) return setError('Tell them who you are.');

	els.submit.disabled = true;
	const label = els.submit.textContent;
	els.submit.textContent = door.free ? 'Knocking…' : 'Opening wallet…';

	try {
		const result = door.free
			? await knockApi.send({ to: door.handle, ...body })
			: await payAndKnock(body);
		showSent(result);
	} catch (err) {
		setError(friendlyError(err));
	} finally {
		els.submit.disabled = false;
		els.submit.textContent = label;
	}
}

async function payAndKnock(body) {
	if (!window.X402?.pay) {
		throw new Error('The payment widget is still loading. Give it a second and try again.');
	}
	const out = await window.X402.pay({
		endpoint: door.endpoint,
		method: 'POST',
		body,
		merchant: `three.ws Knock`,
		action: `Knock on ${door.display_name} (${door.price})`,
		autoConnect: true,
		autoClose: true,
	});
	const result = out?.result;
	if (!result?.ok) throw new Error(result?.error_description || result?.error || 'the payment did not settle');
	return result;
}

function friendlyError(err) {
	const map = {
		door_closed: 'This door just closed.',
		door_full: 'This door has taken all the knocks it accepts today. Try tomorrow.',
		message_too_long: `Trim it to ${door?.max_chars ?? 600} characters.`,
		message_too_short: 'Say at least 8 characters.',
		bad_url: 'That link needs to be a plain http(s) URL.',
		payment_required: 'This door charges now. Reload the page to see the price.',
	};
	if (err.status === 429) return 'Too many knocks from here for now. Try again a bit later.';
	return map[err.code] || err.message || 'That did not go through.';
}

function setError(message) {
	els['form-error'].textContent = message;
	els['form-error'].hidden = !message;
}

function showSent(result) {
	els.form.hidden = true;
	els.sent.hidden = false;
	lastReceiptUrl = result.receipt_url || null;
	els['sent-line'].textContent = result.duplicate
		? `Already delivered. ${door.display_name} has this one.`
		: `Delivered. ${door.display_name}'s companion will walk on and say who you are.`;
	els['receipt-url'].textContent = lastReceiptUrl || '';
	els['receipt-url'].hidden = !lastReceiptUrl;
	els['copy-receipt'].dataset.copy = lastReceiptUrl || '';
	els['copy-receipt'].hidden = !lastReceiptUrl;
	els['check-reply'].hidden = !lastReceiptUrl;
	els['reply-box'].hidden = true;
	els.sent.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function checkReply() {
	if (!lastReceiptUrl) return;
	els['check-reply'].disabled = true;
	const label = els['check-reply'].textContent;
	els['check-reply'].textContent = 'Checking…';
	try {
		const { knock } = await knockApi.receipt(lastReceiptUrl);
		els['reply-box'].hidden = false;
		els['reply-box'].textContent =
			knock.status === 'replied'
				? knock.reply
				: knock.status === 'dismissed'
					? 'They read it and moved on. No reply.'
					: knock.seen
						? 'Read. No reply written yet.'
						: 'Not opened yet.';
	} catch {
		els['reply-box'].hidden = false;
		els['reply-box'].textContent = 'Could not reach the receipt just now. Try again shortly.';
	} finally {
		els['check-reply'].disabled = false;
		els['check-reply'].textContent = label;
	}
}
