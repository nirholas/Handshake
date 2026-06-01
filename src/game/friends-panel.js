// Friends panel UI (Task 15) — a pure view over the shared FriendsClient. It
// renders into a container the host owns (the /play "friends" surface in
// iso-controls) and drives every account-level social interaction: incoming /
// outgoing requests, the friends list with live online + realm badges, a
// search-to-add flow, and per-friend DM threads with unread indicators.
//
// All state lives in the FriendsClient; this module subscribes to its 'change'
// signal and re-renders. Every state is designed: loading, signed-out, network
// error, empty graph, empty thread.

import { friendsClient } from '../friends.js';

const HOTKEY_NOTE = 'Press F to toggle this panel.';

function el(tag, attrs = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(attrs)) {
		if (v == null || v === false) continue;
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k === 'html') n.innerHTML = v;
		else if (k === 'dataset') Object.assign(n.dataset, v);
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
		else if (v === true) n.setAttribute(k, '');
		else n.setAttribute(k, v);
	}
	for (const c of [].concat(kids)) {
		if (c == null || c === false) continue;
		n.append(c.nodeType ? c : document.createTextNode(String(c)));
	}
	return n;
}

function initials(name) {
	const parts = String(name || '?').trim().split(/\s+/).slice(0, 2);
	return parts.map((p) => p[0] || '').join('').toUpperCase() || '?';
}

function relTime(ts) {
	if (!ts) return '';
	const d = new Date(ts).getTime();
	if (!d) return '';
	const s = Math.max(0, (Date.now() - d) / 1000);
	if (s < 45) return 'just now';
	if (s < 90) return '1 min ago';
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 5400) return '1 hr ago';
	if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
	if (s < 172800) return 'yesterday';
	return `${Math.round(s / 86400)} d ago`;
}

function realmLabel(realm) {
	if (!realm) return '';
	return String(realm).replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export class FriendsPanel {
	constructor(container) {
		this.root = container;
		this.client = friendsClient();
		this.tab = 'friends'; // 'friends' | 'requests' | 'add'
		this._searchResults = [];
		this._searchTerm = '';
		this._searching = false;
		this._searchSeq = 0;
		this._busy = new Set(); // userIds with an action in flight (disable buttons)
		this._error = null; // transient action error banner
		this._unsub = null;
		this._draft = ''; // preserved DM input across re-renders
	}

	mount() {
		if (this._mounted) return;
		this._mounted = true;
		this._unsub = this.client.subscribe(() => this.render());
		this.client.activate();
		this.render();
	}

	unmount() {
		this._mounted = false;
		if (this._unsub) this._unsub();
		this._unsub = null;
		this.client.closeThread();
		this.client.deactivate();
	}

	// Whether the panel is currently showing a DM thread (vs. the list tabs).
	get inThread() {
		return !!this.client.openWith;
	}

	async _run(userId, fn) {
		this._busy.add(userId);
		this._error = null;
		this.render();
		try {
			await fn();
		} catch (err) {
			this._error = err?.message || 'Something went wrong.';
		} finally {
			this._busy.delete(userId);
			this.render();
		}
	}

	// ── render ────────────────────────────────────────────────────────────────
	render() {
		if (!this._mounted) return;
		this.root.innerHTML = '';
		this.root.classList.add('kg-fr');

		const c = this.client;
		if (!c.loaded) {
			this.root.append(this._skeleton());
			return;
		}
		if (c.loadError === 'signin') {
			this.root.append(this._signedOut());
			return;
		}
		if (this.inThread) {
			this.root.append(this._threadView());
			return;
		}
		this.root.append(this._tabs(), this._error ? this._banner(this._error) : null, this._tabBody());
	}

	_skeleton() {
		const wrap = el('div', { class: 'kg-fr-skel' });
		for (let i = 0; i < 4; i++) wrap.append(el('div', { class: 'kg-fr-skel-row' }));
		return wrap;
	}

	_banner(msg) {
		return el('div', { class: 'kg-fr-banner', role: 'alert' }, msg);
	}

	_signedOut() {
		return el('div', { class: 'kg-fr-empty' }, [
			el('div', { class: 'kg-fr-empty-glyph', 'aria-hidden': 'true' }, '👥'),
			el('p', { class: 'kg-fr-empty-title' }, 'Sign in to add friends'),
			el('p', { class: 'kg-fr-empty-sub' }, 'Friends, presence, and direct messages are tied to your account.'),
			el('a', { class: 'kg-fr-btn kg-fr-btn--primary', href: `/login?next=${encodeURIComponent(location.pathname)}` }, 'Sign in'),
		]);
	}

	_tabs() {
		const c = this.client;
		const reqCount = c.incoming.length;
		const mk = (id, label, badge) =>
			el(
				'button',
				{
					class: 'kg-fr-tab' + (this.tab === id ? ' is-active' : ''),
					type: 'button',
					'aria-selected': this.tab === id ? 'true' : 'false',
					onclick: () => {
						this.tab = id;
						this.render();
					},
				},
				[label, badge ? el('span', { class: 'kg-fr-pill' }, String(badge)) : null],
			);
		return el('div', { class: 'kg-fr-tabs', role: 'tablist' }, [
			mk('friends', 'Friends', c.totalUnread || null),
			mk('requests', 'Requests', reqCount || null),
			mk('add', 'Add', null),
		]);
	}

	_tabBody() {
		if (this.tab === 'requests') return this._requestsTab();
		if (this.tab === 'add') return this._addTab();
		return this._friendsTab();
	}

	// ── friends list ────────────────────────────────────────────────────────
	_friendsTab() {
		const friends = this.client.friends;
		if (!friends.length) {
			return el('div', { class: 'kg-fr-empty' }, [
				el('div', { class: 'kg-fr-empty-glyph', 'aria-hidden': 'true' }, '🫂'),
				el('p', { class: 'kg-fr-empty-title' }, 'No friends yet'),
				el('p', { class: 'kg-fr-empty-sub' }, 'Search to add someone, then message them or see when they’re online.'),
				el('button', { class: 'kg-fr-btn kg-fr-btn--primary', type: 'button', onclick: () => { this.tab = 'add'; this.render(); } }, 'Search to add'),
			]);
		}
		// Online first, then alphabetical (the store already sorts by name).
		const sorted = [...friends].sort((a, b) => Number(!!b.online) - Number(!!a.online));
		const list = el('ul', { class: 'kg-fr-list' });
		for (const f of sorted) list.append(this._friendRow(f));
		return list;
	}

	_friendRow(f) {
		const presence = f.online
			? el('span', { class: 'kg-fr-status kg-fr-status--on' }, f.realm ? realmLabel(f.realm) : 'Online')
			: el('span', { class: 'kg-fr-status kg-fr-status--off' }, 'Offline');
		const open = () => this.client.openThread(f.id);
		return el('li', { class: 'kg-fr-row' }, [
			el('button', { class: 'kg-fr-rowmain', type: 'button', onclick: open, 'aria-label': `Open chat with ${f.name}` }, [
				this._avatar(f),
				el('span', { class: 'kg-fr-meta' }, [
					el('span', { class: 'kg-fr-name' }, f.name),
					presence,
				]),
				f.unread ? el('span', { class: 'kg-fr-unread', title: `${f.unread} unread` }, String(f.unread)) : null,
			]),
			el('div', { class: 'kg-fr-rowactions' }, [
				el('button', { class: 'kg-fr-icon', type: 'button', title: 'Message', 'aria-label': `Message ${f.name}`, onclick: open }, '✉'),
				el('button', {
					class: 'kg-fr-icon', type: 'button', title: 'Mute', 'aria-label': `Mute ${f.name}`,
					disabled: this._busy.has(f.id), onclick: () => this._run(f.id, () => this.client.mute(f.id)),
				}, '🔕'),
				el('button', {
					class: 'kg-fr-icon kg-fr-icon--danger', type: 'button', title: 'Remove friend', 'aria-label': `Remove ${f.name}`,
					disabled: this._busy.has(f.id),
					onclick: () => { if (confirm(`Remove ${f.name} from your friends?`)) this._run(f.id, () => this.client.remove(f.id)); },
				}, '✕'),
			]),
		]);
	}

	_avatar(u) {
		const dot = el('span', { class: 'kg-fr-dot ' + (u.online ? 'kg-fr-dot--on' : 'kg-fr-dot--off') });
		if (u.avatarUrl) {
			return el('span', { class: 'kg-fr-av' }, [
				el('img', { class: 'kg-fr-av-img', src: u.avatarUrl, alt: '', loading: 'lazy' }),
				dot,
			]);
		}
		return el('span', { class: 'kg-fr-av kg-fr-av--mono' }, [
			el('span', { class: 'kg-fr-av-ini', 'aria-hidden': 'true' }, initials(u.name)),
			dot,
		]);
	}

	// ── requests ──────────────────────────────────────────────────────────────
	_requestsTab() {
		const { incoming, outgoing } = this.client;
		if (!incoming.length && !outgoing.length) {
			return el('div', { class: 'kg-fr-empty' }, [
				el('div', { class: 'kg-fr-empty-glyph', 'aria-hidden': 'true' }, '📨'),
				el('p', { class: 'kg-fr-empty-title' }, 'No pending requests'),
				el('p', { class: 'kg-fr-empty-sub' }, 'Friend invites you send or receive show up here.'),
			]);
		}
		const frag = el('div', { class: 'kg-fr-reqs' });
		if (incoming.length) {
			frag.append(el('h3', { class: 'kg-fr-subhead' }, 'Incoming'));
			const ul = el('ul', { class: 'kg-fr-list' });
			for (const u of incoming) ul.append(this._incomingRow(u));
			frag.append(ul);
		}
		if (outgoing.length) {
			frag.append(el('h3', { class: 'kg-fr-subhead' }, 'Sent'));
			const ul = el('ul', { class: 'kg-fr-list' });
			for (const u of outgoing) ul.append(this._outgoingRow(u));
			frag.append(ul);
		}
		return frag;
	}

	_incomingRow(u) {
		return el('li', { class: 'kg-fr-row' }, [
			el('div', { class: 'kg-fr-rowmain kg-fr-rowmain--static' }, [
				this._avatar(u),
				el('span', { class: 'kg-fr-meta' }, [
					el('span', { class: 'kg-fr-name' }, u.name),
					el('span', { class: 'kg-fr-status' }, `Sent ${relTime(u.requestedAt)}`),
				]),
			]),
			el('div', { class: 'kg-fr-rowactions' }, [
				el('button', {
					class: 'kg-fr-btn kg-fr-btn--primary kg-fr-btn--sm', type: 'button', disabled: this._busy.has(u.id),
					onclick: () => this._run(u.id, () => this.client.accept(u.id)),
				}, 'Accept'),
				el('button', {
					class: 'kg-fr-btn kg-fr-btn--ghost kg-fr-btn--sm', type: 'button', disabled: this._busy.has(u.id),
					onclick: () => this._run(u.id, () => this.client.decline(u.id)),
				}, 'Decline'),
			]),
		]);
	}

	_outgoingRow(u) {
		return el('li', { class: 'kg-fr-row' }, [
			el('div', { class: 'kg-fr-rowmain kg-fr-rowmain--static' }, [
				this._avatar(u),
				el('span', { class: 'kg-fr-meta' }, [
					el('span', { class: 'kg-fr-name' }, u.name),
					el('span', { class: 'kg-fr-status' }, `Requested ${relTime(u.requestedAt)}`),
				]),
			]),
			el('div', { class: 'kg-fr-rowactions' }, [
				el('span', { class: 'kg-fr-tagpending' }, 'Pending'),
				el('button', {
					class: 'kg-fr-btn kg-fr-btn--ghost kg-fr-btn--sm', type: 'button', disabled: this._busy.has(u.id),
					onclick: () => this._run(u.id, () => this.client.remove(u.id)),
				}, 'Cancel'),
			]),
		]);
	}

	// ── add / search ──────────────────────────────────────────────────────────
	_addTab() {
		const wrap = el('div', { class: 'kg-fr-add' });
		const input = el('input', {
			class: 'kg-fr-search', type: 'search', placeholder: 'Search by name or username…',
			value: this._searchTerm, autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Search players',
		});
		input.addEventListener('input', () => this._onSearchInput(input.value));
		wrap.append(el('div', { class: 'kg-fr-searchwrap' }, [el('span', { class: 'kg-fr-search-ico', 'aria-hidden': 'true' }, '🔍'), input]));

		const results = el('div', { class: 'kg-fr-results' });
		if (this._searchTerm.trim().length < 2) {
			results.append(el('p', { class: 'kg-fr-hint' }, 'Type at least 2 characters to search.'));
		} else if (this._searching) {
			results.append(el('p', { class: 'kg-fr-hint' }, 'Searching…'));
		} else if (!this._searchResults.length) {
			results.append(el('p', { class: 'kg-fr-hint' }, `No players match “${this._searchTerm.trim()}”.`));
		} else {
			const ul = el('ul', { class: 'kg-fr-list' });
			for (const u of this._searchResults) ul.append(this._searchRow(u));
			results.append(ul);
		}
		wrap.append(results);
		// Keep focus + caret in the search box across re-renders.
		queueMicrotask(() => {
			if (this.tab === 'add' && document.contains(input)) {
				input.focus();
				const v = input.value;
				input.setSelectionRange?.(v.length, v.length);
			}
		});
		return wrap;
	}

	_onSearchInput(value) {
		this._searchTerm = value;
		const term = value.trim();
		const seq = ++this._searchSeq;
		clearTimeout(this._searchDebounce);
		if (term.length < 2) {
			this._searchResults = [];
			this._searching = false;
			this.render();
			return;
		}
		this._searching = true;
		this.render();
		this._searchDebounce = setTimeout(async () => {
			const res = await this.client.search(term);
			if (seq !== this._searchSeq) return; // a newer keystroke superseded this
			this._searchResults = res;
			this._searching = false;
			this.render();
		}, 280);
	}

	_searchRow(u) {
		let action;
		if (u.relationship === 'friends') {
			action = el('span', { class: 'kg-fr-tagpending kg-fr-tagpending--ok' }, 'Friends');
		} else if (u.relationship === 'outgoing') {
			action = el('span', { class: 'kg-fr-tagpending' }, 'Pending');
		} else if (u.relationship === 'incoming') {
			action = el('button', {
				class: 'kg-fr-btn kg-fr-btn--primary kg-fr-btn--sm', type: 'button', disabled: this._busy.has(u.id),
				onclick: () => this._run(u.id, async () => { await this.client.accept(u.id); this._refreshSearchRow(u.id, 'friends'); }),
			}, 'Accept');
		} else {
			action = el('button', {
				class: 'kg-fr-btn kg-fr-btn--primary kg-fr-btn--sm', type: 'button', disabled: this._busy.has(u.id),
				onclick: () => this._run(u.id, async () => {
					const r = await this.client.sendRequest(u.id);
					this._refreshSearchRow(u.id, r.relationship || 'outgoing');
				}),
			}, 'Add');
		}
		return el('li', { class: 'kg-fr-row' }, [
			el('div', { class: 'kg-fr-rowmain kg-fr-rowmain--static' }, [
				this._avatar(u),
				el('span', { class: 'kg-fr-meta' }, [
					el('span', { class: 'kg-fr-name' }, u.name),
					u.username ? el('span', { class: 'kg-fr-status' }, `@${u.username}`) : null,
				]),
			]),
			el('div', { class: 'kg-fr-rowactions' }, action),
		]);
	}

	// Optimistically reflect a relationship change in the cached search results so
	// the row updates instantly (the full graph also refreshes underneath).
	_refreshSearchRow(id, relationship) {
		const row = this._searchResults.find((r) => r.id === id);
		if (row) row.relationship = relationship;
		this.render();
	}

	// ── DM thread ───────────────────────────────────────────────────────────
	_threadView() {
		const id = this.client.openWith;
		const f = this.client.friend(id);
		const msgs = this.client.threads.get(id);
		const head = el('div', { class: 'kg-fr-thread-head' }, [
			el('button', { class: 'kg-fr-back', type: 'button', 'aria-label': 'Back to friends', onclick: () => this.client.closeThread() }, '‹'),
			f ? this._avatar(f) : null,
			el('span', { class: 'kg-fr-meta' }, [
				el('span', { class: 'kg-fr-name' }, f ? f.name : 'Conversation'),
				el('span', { class: 'kg-fr-status' }, f ? (f.online ? (f.realm ? `Online · ${realmLabel(f.realm)}` : 'Online') : 'Offline') : ''),
			]),
		]);

		const scroll = el('div', { class: 'kg-fr-thread-msgs' });
		if (!msgs) {
			scroll.append(el('p', { class: 'kg-fr-hint' }, 'Loading messages…'));
		} else if (!msgs.length) {
			scroll.append(el('div', { class: 'kg-fr-thread-empty' }, [
				el('p', { class: 'kg-fr-empty-title' }, `Say hello to ${f ? f.name : 'your friend'}`),
				el('p', { class: 'kg-fr-empty-sub' }, 'Messages deliver instantly when they’re online, and wait for them when they’re not.'),
			]));
		} else {
			let lastDay = '';
			for (const m of msgs) {
				const day = new Date(m.ts).toDateString();
				if (day !== lastDay) {
					scroll.append(el('div', { class: 'kg-fr-daysep' }, relDay(m.ts)));
					lastDay = day;
				}
				scroll.append(
					el('div', { class: 'kg-fr-msg ' + (m.mine ? 'kg-fr-msg--mine' : 'kg-fr-msg--theirs') }, [
						el('span', { class: 'kg-fr-msg-body' }, m.body),
						el('span', { class: 'kg-fr-msg-time', title: new Date(m.ts).toLocaleString() }, fmtTime(m.ts)),
					]),
				);
			}
		}

		const input = el('input', {
			class: 'kg-fr-dm-input', type: 'text', maxlength: '2000', placeholder: 'Message…',
			value: this._draft, 'aria-label': 'Type a message',
		});
		const sendBtn = el('button', { class: 'kg-fr-dm-send', type: 'button', 'aria-label': 'Send' }, '➤');
		const submit = async () => {
			const text = input.value.trim();
			if (!text) return;
			input.value = '';
			this._draft = '';
			try {
				await this.client.sendDM(id, text);
			} catch (err) {
				this._draft = text;
				this._error = err?.message || 'Could not send.';
				this.render();
			}
		};
		input.addEventListener('input', () => { this._draft = input.value; });
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); submit(); }
			e.stopPropagation(); // don't let the game hotkeys eat typing
		});
		sendBtn.addEventListener('click', submit);

		const composer = el('div', { class: 'kg-fr-dm-bar' }, [input, sendBtn]);
		const view = el('div', { class: 'kg-fr-thread' }, [head, this._error ? this._banner(this._error) : null, scroll, composer]);

		// Pin to newest + focus the composer after paint.
		queueMicrotask(() => {
			scroll.scrollTop = scroll.scrollHeight;
			if (document.contains(input)) input.focus();
		});
		return view;
	}
}

function fmtTime(ts) {
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return '';
	return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function relDay(ts) {
	const d = new Date(ts);
	const today = new Date();
	const yest = new Date();
	yest.setDate(today.getDate() - 1);
	if (d.toDateString() === today.toDateString()) return 'Today';
	if (d.toDateString() === yest.toDateString()) return 'Yesterday';
	return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export { HOTKEY_NOTE };
