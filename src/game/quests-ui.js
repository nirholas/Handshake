// Jobs Board UI (W08 hooking W05) — the client the quest engine never had.
// multiplayer/src/quests.js + quest-zones.js + WalkRoom's questReq/questAccept/
// questAbandon/questInteract handlers were fully built and fully wired
// server-side, but nothing on the client ever called requestQuests() or
// rendered what came back — "designed and completely unreachable", the same
// gap W04's economy pass found and closed for the cash economy. This is that
// same fix for jobs: walk up to any quest-giver NPC (npc/quest-npcs.js) or
// open it directly, and the real board — real daily rotation, real
// prereqs/repeat rules, real per-objective progress, real heist crew size —
// renders straight from the server's own snapshot. Every button only sends an
// intent; the server's reply re-renders, exactly like the store/bank panel
// this one is styled to match.

import { EconPanel } from './economy-ui.js';
import './quests-ui.css';

function el(tag, props = {}, kids = []) {
	const n = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (k === 'class') n.className = v;
		else if (k === 'text') n.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
		else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v === true ? '' : v);
	}
	for (const kid of [].concat(kids)) if (kid != null && kid !== false) n.appendChild(typeof kid === 'string' ? document.createTextNode(kid) : kid);
	return n;
}

const KIND_GLYPH = { job: '🎯', heist: '🤝' };
const EVENT_GLYPH = '🎉';
// How often the standings refresh while the Event tab is open. The room caches the
// upstream read, so this is a cheap way to watch the race move without a manual
// refresh; the interval is cleared with the panel.
const BOARD_POLL_MS = 15_000;

function rewardText(reward) {
	if (!reward) return '';
	const parts = [`💰 ${reward.gold ?? 0}`];
	if (reward.xp?.amount) parts.push(`✨ ${reward.xp.amount} ${reward.xp.skill}`);
	return parts.join(' · ');
}

// "3 runs · 960 cash" — the two numbers the ranking is actually sorted on, in the
// order it sorts them.
function scoreText(row) {
	const runs = row?.runs | 0;
	return `${runs} ${runs === 1 ? 'run' : 'runs'} · 💰 ${row?.cash | 0}`;
}

let _openQuests = null;

/**
 * Open the Jobs Board: browse offers, accept/abandon, and track active
 * objectives — all server-authoritative. Idempotent — a second open while one
 * is already up just refocuses it (and re-targets `highlight` if given).
 * @param {{ ui: object, net: object }} deps
 * @param {string} [highlight] a mission id to jump straight to (from the
 *   giver NPC the player just walked up to).
 */
export function openQuestsPanel({ ui, net } = {}, highlight) {
	if (!net) return;
	if (_openQuests) { _openQuests.focusMission(highlight); return; }
	_openQuests = new QuestsPanel({ ui, net, highlight, onClose: () => { _openQuests = null; } });
}

class QuestsPanel extends EconPanel {
	constructor({ ui, net, highlight, onClose }) {
		super({ title: 'Jobs Board', onClose });
		this.ui = ui;
		this.net = net;
		this.tab = 'board';
		this.board = { offers: [], active: [], day: '' };
		// False until the first server snapshot lands, so an empty board renders as
		// "loading" rather than a premature "no jobs" (the server hasn't spoken yet).
		this._loaded = false;
		// The abandon just sent, confirmed by the next snapshot no longer listing it.
		this._abandoning = null; // { id, title }
		this._highlight = highlight || null;
		// One-shot flag: which id to flash/scroll-to on the NEXT render only —
		// kept separate from _pickForTab's persistent `_highlight` so a later
		// snapshot re-render (progress ticking in) doesn't keep re-pulsing it.
		this._flashId = highlight || null;

		// The event leaderboard's own view state. `null` = the first read is still in
		// flight (the loading state); a payload with ok:false is the error state.
		this.eventBoard = null;
		this._boardPoll = null;

		this.boardTabBtn = el('button', { class: 'ec-tab ec-on', type: 'button', role: 'tab', 'aria-selected': 'true', text: 'Board', onclick: () => this._setTab('board') });
		this.activeTabBtn = el('button', { class: 'ec-tab', type: 'button', role: 'tab', 'aria-selected': 'false', text: 'Active', onclick: () => this._setTab('active') });
		// The Event tab only exists when there is an event to show: live right now, or
		// finished with a standing still worth reading. Hidden until then rather than
		// shown empty, so the board doesn't grow a dead tab for 51 weeks of the year.
		this.eventTabBtn = el('button', {
			class: 'ec-tab qb-event-tab', type: 'button', hidden: true, role: 'tab', 'aria-selected': 'false',
			text: `${EVENT_GLYPH} Event`, onclick: () => this._setTab('event'),
		});
		this.tabs = el('div', { class: 'ec-tabs', role: 'tablist', 'aria-label': 'Jobs board sections' }, [this.boardTabBtn, this.activeTabBtn, this.eventTabBtn]);
		this.card.insertBefore(this.tabs, this.body);

		this.track(net.on('quests', (snap) => {
			this.board = snap && typeof snap === 'object' ? snap : this.board;
			this._loaded = true;
			// The server confirms an abandon by sending a snapshot without the run;
			// there's no dedicated notice for it, so this is where the status lands.
			if (this._abandoning && !this.board.active.some((r) => r.id === this._abandoning.id)) {
				this.setStatus(`Abandoned: ${this._abandoning.title}`, 'ok');
				this._abandoning = null;
			}
			this._pickTabForHighlight();
			this._render();
		}));
		this.track(net.on('questComplete', (c) => this._onComplete(c)));
		// Accept refusals ("You already took that job", prereqs, crew rules) come
		// back as 'quest' notices; without this the status sat on "Accepting…"
		// forever. `ok` styles it; older servers omit the flag, and every quest
		// notice they send is a refusal, so undefined styles as an error too.
		this.track(net.on('notice', (n) => {
			if (n?.kind !== 'quest' || !n.text) return;
			this._abandoning = null;
			this.setStatus(n.text, n.ok === true ? 'ok' : 'err');
		}));
		this.track(net.on('eventBoard', (b) => {
			this.eventBoard = b && typeof b === 'object' ? b : { ok: false, reason: 'unavailable' };
			this._render();
		}));
		// Finishing an event job moves the standings — pull the fresh ranking rather
		// than waiting out the poll, so the panel reacts to the player's own run.
		this.track(net.on('eventScore', () => this.net.requestEventBoard()));

		net.requestQuests();
		net.requestEventBoard();
		this._render();
	}

	close() {
		clearInterval(this._boardPoll);
		this._boardPoll = null;
		super.close();
	}

	// Called again if a giver NPC/menu opens the board while it's already up —
	// jump to whichever tab actually has that mission and flash it once.
	focusMission(id) {
		if (!id) return;
		this._highlight = id;
		this._flashId = id;
		this._pickTabForHighlight();
		this._render();
	}

	_pickTabForHighlight() {
		if (!this._highlight) return;
		if (this.board.active.some((r) => r.id === this._highlight)) this.tab = 'active';
		else if (this.board.offers.some((o) => o.id === this._highlight)) this.tab = 'board';
	}

	_setTab(tab) {
		this.tab = tab;
		for (const [btn, id] of [[this.boardTabBtn, 'board'], [this.activeTabBtn, 'active'], [this.eventTabBtn, 'event']]) {
			btn.classList.toggle('ec-on', tab === id);
			btn.setAttribute('aria-selected', tab === id ? 'true' : 'false');
		}
		// Poll only while the standings are actually on screen.
		clearInterval(this._boardPoll);
		this._boardPoll = null;
		if (tab === 'event') {
			this.net.requestEventBoard();
			this._boardPoll = setInterval(() => this.net.requestEventBoard(), BOARD_POLL_MS);
		}
		this._render();
	}

	_onComplete(c) {
		if (!c) return;
		const crew = c.coop && c.crew > 1 ? ` (crew of ${c.crew})` : '';
		const tag = c.event ? `${EVENT_GLYPH} Event job — ` : '';
		this.setStatus(`${tag}${c.title} complete${crew} — ${rewardText(c.reward)}`, 'ok');
	}

	// Is there an event worth surfacing a tab for? Live right now, or finished with a
	// standing still on the board (so winners stay readable after the window shuts).
	_hasEvent() {
		return !!this.board.eventLive || (this.eventBoard?.ok && this.eventBoard.players > 0);
	}

	_render() {
		this.activeTabBtn.textContent = this.board.active.length ? `Active (${this.board.active.length})` : 'Active';
		const showEvent = this._hasEvent();
		this.eventTabBtn.hidden = !showEvent;
		// The tab can vanish under the player when the window closes mid-session.
		if (this.tab === 'event' && !showEvent) this.tab = 'board';
		this.body.replaceChildren();
		if (this.tab === 'event') this._renderEvent();
		else if (this.tab === 'board') this._renderBoard();
		else this._renderActive();
		// One-shot: flash + scroll to the targeted row, then clear so a later
		// re-render (progress ticking in) doesn't keep re-pulsing it.
		if (this._flashId) {
			const flashed = this.body.querySelector('.qb-flash');
			flashed?.scrollIntoView({ block: 'center', behavior: 'smooth' });
			this._flashId = null;
		}
	}

	_renderBoard() {
		if (!this._loaded) {
			this.body.appendChild(el('div', { class: 'ec-empty ec-loading', text: 'Loading the jobs board…' }));
			return;
		}
		if (!this.board.offers.length) {
			this.body.appendChild(el('div', { class: 'ec-empty', text: 'No jobs on the board right now — dailies rotate at UTC midnight, and repeatable work is always open somewhere in town.' }));
			return;
		}
		for (const offer of this.board.offers) {
			const flash = offer.id === this._flashId;
			const row = el('div', { class: 'ec-row qb-row' + (offer.event ? ' qb-event-row' : '') + (flash ? ' qb-flash' : ''), 'data-mission': offer.id }, [
				el('span', { class: 'ec-row-glyph', text: offer.event ? EVENT_GLYPH : (KIND_GLYPH[offer.kind] || '🎯') }),
				el('div', { class: 'ec-row-main' }, [
					el('div', { class: 'ec-row-name' }, [
						offer.title,
						offer.event ? el('span', { class: 'qb-event-badge', text: 'EVENT' }) : null,
					]),
					el('div', { class: 'ec-row-sub', text: `${offer.giver} · ${offer.summary}` }),
					el('div', { class: 'qb-obj-preview', text: offer.objectives.map((o) => o.label).join('  →  ') }),
					el('div', { class: 'qb-reward', text: rewardText(offer.reward) + (offer.kind === 'heist' ? ` · needs a crew of ${offer.party}` : '') }),
				]),
				el('button', {
					class: 'ec-row-btn', type: 'button', text: 'Accept',
					'aria-label': `Accept ${offer.title}`,
					onclick: () => { this.setStatus('Accepting…'); this.net.questAccept(offer.id); },
				}),
			]);
			this.body.appendChild(row);
		}
	}

	_renderActive() {
		if (!this._loaded) {
			this.body.appendChild(el('div', { class: 'ec-empty ec-loading', text: 'Loading your jobs…' }));
			return;
		}
		if (!this.board.active.length) {
			this.body.appendChild(el('div', { class: 'ec-empty', text: 'No active jobs — accept one from the Board tab or talk to a quest-giver out in the world.' }));
			return;
		}
		for (const run of this.board.active) {
			const flash = run.id === this._flashId;
			const objList = el('div', { class: 'qb-obj-list' }, run.objectives.map((o) => el('div', {
				class: 'qb-obj' + (o.done ? ' is-done' : '') + (o.current ? ' is-current' : ''),
			}, [
				el('span', { class: 'qb-obj-mark', text: o.done ? '✔' : (o.current ? '▶' : '·') }),
				el('span', { class: 'qb-obj-label', text: o.label }),
				el('span', { class: 'qb-obj-count', text: o.count > 1 ? `${o.progress}/${o.count}` : '' }),
			])));
			const crewLine = run.kind === 'heist'
				? el('div', { class: 'qb-reward', text: `Crew: ${run.crew || 1}/${run.party || 2}` })
				: null;
			const row = el('div', { class: 'ec-row qb-row qb-active-row' + (run.event ? ' qb-event-row' : '') + (flash ? ' qb-flash' : ''), 'data-mission': run.id }, [
				el('div', { class: 'ec-row-main' }, [
					el('div', { class: 'ec-row-name' }, [
						run.title,
						run.event ? el('span', { class: 'qb-event-badge', text: 'EVENT' }) : null,
					]),
					el('div', { class: 'ec-row-sub', text: run.giver }),
					objList,
					crewLine,
					el('div', { class: 'qb-reward', text: rewardText(run.reward) }),
				].filter(Boolean)),
				el('button', {
					class: 'ec-row-btn ec-secondary', type: 'button', text: 'Abandon',
					'aria-label': `Abandon ${run.title}`,
					onclick: () => {
						this._abandoning = { id: run.id, title: run.title };
						this.setStatus('Abandoning…');
						this.net.questAbandon(run.id);
					},
				}),
			]);
			this.body.appendChild(row);
		}
	}

	// --- Event leaderboard ----------------------------------------------------
	// Four states, all designed: the first read in flight (skeleton rows), the read
	// failed (a reason plus a retry that actually retries), nobody has run a job yet
	// (an invitation, not a void), and the ranking itself with the player's own row
	// pinned below the top ten whether or not they made it.

	_renderEvent() {
		const b = this.eventBoard;
		if (!b) { this._renderBoardSkeleton(); return; }
		if (!b.ok) { this._renderBoardError(b.reason); return; }

		const ev = b.event || {};
		this.body.appendChild(el('div', { class: 'qb-lb-head' }, [
			el('div', { class: 'qb-lb-title', text: ev.name || 'Live event' }),
			el('div', {
				class: 'qb-lb-note',
				text: ev.live
					? `Live now · ${b.players} ${b.players === 1 ? 'runner' : 'runners'} · ${b.totalRuns} event ${b.totalRuns === 1 ? 'job' : 'jobs'} finished`
					: 'Final standings — the event has ended',
			}),
		]));

		if (!b.top?.length) {
			this.body.appendChild(el('div', { class: 'ec-empty' }, [
				el('div', { text: 'No event runs yet — be the first.' }),
				el('div', {
					class: 'qb-lb-note',
					text: 'Take an EVENT job from the Board tab and finish it. Every completed event job is one run.',
				}),
			]));
			this._renderPrizeNote();
			return;
		}

		const list = el('ol', { class: 'qb-lb-list' });
		for (const row of b.top) {
			list.appendChild(this._leaderRow(row, !!b.you && b.you.rank === row.rank));
		}
		this.body.appendChild(list);

		// Your own rank, pinned. Shown even when you are already in the top ten (as a
		// restatement below the list) so "where am I" is answered in one place, always.
		if (b.you) {
			this.body.appendChild(el('div', { class: 'qb-lb-you-wrap' }, [
				el('div', { class: 'qb-lb-note', text: b.you.inTop ? 'Your standing' : 'Your standing (outside the top ten)' }),
				this._leaderRow(b.you, true),
			]));
		} else {
			this.body.appendChild(el('div', { class: 'qb-lb-you-wrap' }, [
				el('div', { class: 'qb-lb-note', text: 'You have not finished an event job yet — one run puts you on this board.' }),
			]));
		}
		this._renderPrizeNote();
	}

	_leaderRow(row, mine) {
		return el('li', { class: 'qb-lb-row' + (mine ? ' is-you' : '') }, [
			el('span', { class: 'qb-lb-rank', text: `#${row.rank}` }),
			el('span', { class: 'qb-lb-name', text: row.name || 'Anonymous' }),
			el('span', { class: 'qb-lb-score', text: scoreText(row) }),
		]);
	}

	_renderBoardSkeleton() {
		const list = el('div', { class: 'qb-lb-list qb-lb-skeleton', 'aria-hidden': 'true' });
		for (let i = 0; i < 5; i++) list.appendChild(el('div', { class: 'qb-lb-row qb-lb-ghost' }));
		this.body.appendChild(el('div', { class: 'qb-lb-note', role: 'status', text: 'Loading the standings…' }));
		this.body.appendChild(list);
	}

	_renderBoardError(reason) {
		this.body.appendChild(el('div', { class: 'ec-empty' }, [
			el('div', { text: 'The standings could not be read just now.' }),
			el('div', {
				class: 'qb-lb-note',
				text: reason === 'unavailable'
					? 'Your own progress is safe — every finished job was already paid and recorded. Only this view is offline.'
					: 'Try again in a moment.',
			}),
			el('button', {
				class: 'ec-row-btn', type: 'button', text: 'Retry',
				onclick: () => { this.eventBoard = null; this._render(); this.net.requestEventBoard(); },
			}),
		]));
	}

	// The one line that has to be on this panel: the board ranks, the team pays.
	// Nothing in this client or the server ever settles a prize automatically.
	_renderPrizeNote() {
		this.body.appendChild(el('div', {
			class: 'qb-lb-prize',
			text: 'Winners are announced from this board and settled by the three.ws team after the event. No prize is paid automatically.',
		}));
	}
}
