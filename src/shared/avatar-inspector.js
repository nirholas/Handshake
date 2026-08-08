/**
 * Avatar Inspector, one panel, every world.
 *
 * Press I (or select an avatar) in any three.ws world, /play, /city, a coin
 * world, the walk playground, and this side panel opens on whoever you're
 * looking at: who they are, the reputation they've earned, the wallet they
 * carry, and every public fact the platform knows about them. It is the
 * world-side twin of the Agora passport: non-modal, keyboard-first, honest.
 *
 * Everything shown is real, server-authoritative data, the same public
 * endpoints every other surface reads, so a number never disagrees across
 * the platform:
 *   - GET  /api/agents/:id                 → identity (name, bio, skills, links)
 *   - GET  /api/agents/:id/reputation      → 0, 100 trust score + pillars
 *     (rendered by the shared reputationPanelEl, the exact breakdown the
 *     wallet hub shows)
 *   - GET  /api/agents/:id/solana/networth → wallet address, USD/SOL/$THREE
 *     portfolio, top holdings, wealth tier
 *   - POST /api/wallet/balances            → balances for a bare verified
 *     wallet when the avatar isn't piloting a registered agent
 *
 * A guest with no wallet renders as exactly that, a designed empty state
 * that says what's missing and how to get it, never a fabricated number.
 *
 * Usage (each world supplies its own picking, raycast, nameplate click, or
 * the I key on the nearest avatar):
 *   import { openAvatarInspector } from '../shared/avatar-inspector.js';
 *   openAvatarInspector({
 *     kind: 'peer',                      // 'peer'|'self'|'npc'
 *     name: 'nick',
 *     world: 'play',                     // chip: which world surfaced it
 *     agentId: 'uuid-or-empty',          // three.ws agent this avatar pilots
 *     wallet: 'solana-address-or-empty', // verified account wallet
 *     facts: [{ label: 'Profession', value: 'Builder' }],
 *   }, { trigger: buttonEl });           // focus returns here on close
 */

import { apiFetch } from '../api.js';
import { friendsClient } from '../friends.js';
import { reputationPanelEl, ensureReputationStyles } from './agent-reputation.js';
import { shortAddress, formatWalletUsd } from './wallet-format.js';
import { log } from './log.js';

const STYLE_ID = 'tws-avatar-inspector-styles';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const USERNAME_RE = /^[a-z0-9_-]{3,30}$/;

const KIND_LABEL = {
	self: 'You',
	peer: 'Player',
	npc: 'Townsperson',
	citizen: 'Citizen',
};

const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtAmount = (n) => {
	const v = Number(n) || 0;
	if (v === 0) return '0';
	if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
	if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
	if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
	if (v < 0.001) return v.toExponential(1);
	return v.toLocaleString('en-US', { maximumFractionDigits: v < 1 ? 4 : 2 });
};

const explorerAddr = (a) => `https://explorer.solana.com/address/${encodeURIComponent(a)}`;

// ── singleton state ──────────────────────────────────────────────────────────

let _panel = null; // { root, subjectKey, trigger, onClose, keyHandler }

export function isAvatarInspectorOpen() {
	return !!_panel;
}

export function closeAvatarInspector() {
	if (!_panel) return;
	const { root, trigger, onClose, keyHandler } = _panel;
	_panel = null;
	window.removeEventListener('keydown', keyHandler, true);
	root.classList.remove('avi-in');
	const remove = () => root.remove();
	// Let the exit transition play unless the user prefers reduced motion.
	if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) remove();
	else setTimeout(remove, 220);
	try { onClose?.(); } catch (e) { log.warn('[avatar-inspector] onClose threw', e); }
	if (trigger && document.contains(trigger)) {
		try { trigger.focus({ preventScroll: true }); } catch { /* focus target gone */ }
	}
}

/**
 * Open (or toggle) the inspector for a subject.
 *
 * @param {object} subject
 * @param {string}  [subject.kind]      'peer'|'self'|'npc'
 * @param {string}  [subject.name]      display name
 * @param {string}  [subject.world]     world chip ('play', 'city', …)
 * @param {string}  [subject.agentId]   three.ws agent UUID this avatar pilots
 * @param {string}  [subject.wallet]    verified Solana address (used when no agentId)
 * @param {string}  [subject.avatarUrl] GLB url, shown as an "Avatar model" fact row
 * @param {string}  [subject.bio]       caller-supplied bio paragraph (used when the
 *                                      subject has no registered agent to load one from)
 * @param {string}  [subject.username]  verified three.ws username (W10), only pass a
 *                                      value the server verified (e.g. off the signed
 *                                      presence ticket via the player schema); it
 *                                      unlocks the real profile section: follow,
 *                                      friend/DM, and the creations shelf
 * @param {Array}   [subject.facts]     [{label, value, href?}] world-specific rows
 * @param {Array}   [subject.actions]   [{label, onClick, primary?}] footer buttons the
 *                                      host world wires (e.g. "Talk 1-on-1"); rendered
 *                                      before the profile links
 * @param {object} [opts]
 * @param {Element} [opts.trigger]      element to restore focus to on close
 * @param {Function}[opts.onClose]
 * @param {Function}[opts.onOpenDM]     (userId) → open the host world's DM surface on
 *                                      this thread; without it "Message" links to /friends
 */
export function openAvatarInspector(subject = {}, opts = {}) {
	ensureStyles();
	ensureReputationStyles();

	const agentId = UUID_RE.test(String(subject.agentId || '')) ? String(subject.agentId) : '';
	const wallet = SOL_ADDR_RE.test(String(subject.wallet || '')) ? String(subject.wallet) : '';
	const username = USERNAME_RE.test(String(subject.username || '').toLowerCase())
		? String(subject.username).toLowerCase()
		: '';
	const subjectKey = `${subject.kind || ''}:${subject.name || ''}:${agentId}:${wallet}:${username}`;

	// Same avatar again (the I key, a second click) → toggle closed.
	if (_panel && _panel.subjectKey === subjectKey) {
		closeAvatarInspector();
		return null;
	}
	if (_panel) closeAvatarInspector();

	const kind = KIND_LABEL[subject.kind] ? subject.kind : 'peer';
	const name = String(subject.name || '').trim() || (kind === 'self' ? 'You' : 'guest');

	const root = document.createElement('aside');
	root.className = 'avi-root';
	root.setAttribute('role', 'dialog');
	root.setAttribute('aria-label', `Avatar inspector, ${name}`);
	root.innerHTML = `
		<header class="avi-head">
			<div class="avi-monogram" aria-hidden="true">${esc(name.replace(/^@/, '').slice(0, 2).toUpperCase())}</div>
			<div class="avi-id">
				<h2 class="avi-name">${esc(name)}</h2>
				<div class="avi-chips">
					<span class="avi-chip avi-chip-kind">${esc(KIND_LABEL[kind])}</span>
					${subject.world ? `<span class="avi-chip">${esc(subject.world)}</span>` : ''}
				</div>
			</div>
			<button type="button" class="avi-close" aria-label="Close inspector">✕</button>
		</header>
		<div class="avi-body">
			${username ? `
			<section class="avi-section" data-avi="profile">
				<h3 class="avi-h">three.ws profile</h3>
				<div class="avi-section-body"></div>
			</section>` : ''}
			<section class="avi-section" data-avi="wallet">
				<h3 class="avi-h">Wallet</h3>
				<div class="avi-section-body"></div>
			</section>
			<section class="avi-section" data-avi="reputation">
				<h3 class="avi-h">Reputation</h3>
				<div class="avi-section-body"></div>
			</section>
			<section class="avi-section" data-avi="about">
				<h3 class="avi-h">Details</h3>
				<div class="avi-section-body"></div>
			</section>
		</div>
		<footer class="avi-foot"></footer>
	`;

	const keyHandler = (e) => {
		if (e.key === 'Escape') {
			e.stopPropagation();
			closeAvatarInspector();
			return;
		}
		// I toggles the panel closed from anywhere except a text field. The panel
		// handles this itself (capture phase) because once focus moves into the
		// dialog, the host world's key handlers rightly ignore the event.
		if (e.key.toLowerCase() === 'i' && !e.repeat) {
			const t = e.target;
			if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
			e.stopPropagation();
			e.preventDefault();
			closeAvatarInspector();
		}
	};

	root.querySelector('.avi-close').addEventListener('click', closeAvatarInspector);
	window.addEventListener('keydown', keyHandler, true);
	document.body.appendChild(root);
	// Double-rAF so the entering transform actually transitions from offscreen.
	requestAnimationFrame(() => requestAnimationFrame(() => root.classList.add('avi-in')));

	_panel = { root, subjectKey, trigger: opts.trigger || null, onClose: opts.onClose || null, keyHandler };

	root.querySelector('.avi-close').focus({ preventScroll: true });

	if (username) {
		// Verified platform identity: surface the @handle under the display name
		// immediately, the profile section fills in the rest as it loads.
		const nameEl = root.querySelector('.avi-name');
		nameEl?.insertAdjacentHTML('afterend', `<div class="avi-subname">@${esc(username)}</div>`);
		renderProfile(root, { username, kind, onOpenDM: opts.onOpenDM });
	}
	renderAbout(root, subject, { agentId });
	renderWallet(root, { agentId, wallet, kind });
	renderReputation(root, { agentId, kind });
	renderFooter(root, { agentId, wallet, username, actions: subject.actions });

	return { close: closeAvatarInspector };
}

// ── sections ─────────────────────────────────────────────────────────────────

function sectionBody(root, key) {
	return root.querySelector(`[data-avi="${key}"] .avi-section-body`);
}

const skeleton = (rows = 2) =>
	Array.from({ length: rows }, (_, i) => `<div class="avi-sk" style="width:${88 - i * 18}%"></div>`).join('');

function emptyState(title, body, links = []) {
	return (
		`<div class="avi-empty">` +
		`<div class="avi-empty-title">${esc(title)}</div>` +
		`<p>${esc(body)}</p>` +
		(links.length
			? `<div class="avi-links">${links
					.map((l) => `<a href="${esc(l.href)}"${/^https?:/.test(l.href) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(l.label)} →</a>`)
					.join('')}</div>`
			: '') +
		`</div>`
	);
}

function errorState(message, retry) {
	const el = document.createElement('div');
	el.className = 'avi-error';
	el.setAttribute('role', 'alert');
	el.innerHTML = `<p>${esc(message)}</p><button type="button" class="avi-retry">Try again</button>`;
	el.querySelector('.avi-retry').addEventListener('click', retry);
	return el;
}

// three.ws profile (W10): the verified platform account behind an avatar.
// Only rendered for a username the SERVER verified (signed presence ticket →
// player schema), never a client-claimed handle. Reads the same endpoints the
// /u/:username page reads, and acts through the same follow + friends APIs the
// profile page and friends drawer use, so a follow made here is the same edge
// everywhere on the platform.
async function renderProfile(root, { username, kind, onOpenDM }) {
	const body = sectionBody(root, 'profile');
	if (!body) return;

	const CREATIONS_SHOWN = 5;
	const TYPE_ICON = { world: '⛰', restyle: '✦', model: '◎' };

	const load = async () => {
		body.innerHTML = skeleton(3);
		let prof = null;
		let follow = null;
		try {
			// The friends graph resolves in parallel with the profile so the action
			// row can tell "Message" from "Add friend" on first paint. refresh() is
			// a no-op for anonymous viewers and dedupes against live panel polling.
			const fc = friendsClient();
			const [profRes, followRes] = await Promise.all([
				apiFetch(`/api/users/${encodeURIComponent(username)}`, { allowAnonymous: true }),
				apiFetch(`/api/users/${encodeURIComponent(username)}/follow`, { allowAnonymous: true }),
				fc.loaded ? Promise.resolve() : fc.refresh(),
			]);
			if (!profRes.ok) throw new Error(`profile ${profRes.status}`);
			prof = await profRes.json();
			follow = followRes.ok ? await followRes.json() : null;
		} catch (err) {
			if (!document.contains(body)) return;
			log.warn('[avatar-inspector] profile failed', err?.message);
			body.innerHTML = '';
			body.appendChild(errorState('Could not load this player’s three.ws profile.', load));
			return;
		}
		if (!document.contains(body)) return;
		paint(prof, follow);
	};

	const paint = (prof, follow) => {
		const user = prof?.user || {};
		const stats = prof?.stats || {};
		const creations = Array.isArray(prof?.creations) ? prof.creations : [];
		const creationsTotal = Number(stats.creations) || creations.length;
		const coinsLaunched = Number(stats.coins) || 0;

		// Upgrade the monogram to the account's real profile picture.
		if (user.avatar_url) {
			const mono = root.querySelector('.avi-monogram');
			if (mono && !mono.querySelector('img')) {
				mono.innerHTML = `<img src="${esc(user.avatar_url)}" alt="" loading="lazy" />`;
			}
		}

		const metaBits = [
			user.location ? esc(user.location) : '',
			user.created_at
				? `joined ${new Date(user.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short' })}`
				: '',
		].filter(Boolean);

		const shown = creations.slice(0, CREATIONS_SHOWN);
		const creationRow = (c) => {
			const date = c.createdAt
				? new Date(c.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
				: '';
			return (
				`<a class="avi-creation" href="${esc(c.viewerUrl || '#')}" target="_blank" rel="noopener noreferrer">` +
				`<span class="avi-creation-ico" aria-hidden="true">${TYPE_ICON[c.type] || TYPE_ICON.model}</span>` +
				`<span class="avi-creation-title">${esc((c.title || 'Untitled').slice(0, 60))}</span>` +
				`<span class="avi-creation-date">${esc(date)}</span></a>`
			);
		};

		body.innerHTML =
			(user.bio ? `<p class="avi-bio">${esc(user.bio)}</p>` : '') +
			`<div class="avi-profile-counts">
				<span><b data-avi-followers>${esc(fmtAmount(follow?.followers_count ?? 0))}</b> followers</span>
				<span><b>${esc(fmtAmount(follow?.following_count ?? 0))}</b> following</span>
				<span><b>${esc(fmtAmount(creationsTotal))}</b> creation${creationsTotal === 1 ? '' : 's'}</span>
			</div>` +
			(metaBits.length ? `<p class="avi-note">${metaBits.join(' · ')}</p>` : '') +
			`<div class="avi-profile-actions"></div>` +
			(shown.length
				? `<div class="avi-creations">${shown.map(creationRow).join('')}</div>` +
					(creationsTotal > shown.length
						? `<a class="avi-more" href="/u/${encodeURIComponent(username)}">All ${esc(fmtAmount(creationsTotal))} creations →</a>`
						: '')
				: `<p class="avi-note">No public creations yet.</p>`) +
			(coinsLaunched
				? `<div class="avi-fact"><span class="avi-fact-l">Coins launched</span><span class="avi-fact-v"><a href="/u/${encodeURIComponent(username)}">${esc(fmtAmount(coinsLaunched))}</a></span></div>`
				: '');

		if (kind !== 'self') {
			renderProfileActions(body.querySelector('.avi-profile-actions'), {
				username,
				userId: user.id || '',
				following: !!follow?.following,
				followedBy: !!follow?.followed_by,
				canFollow: follow != null,
				onOpenDM,
			});
		} else {
			body.querySelector('.avi-profile-actions')?.remove();
		}
	};

	load();
}

// The action row on another player's profile card: follow/unfollow plus the
// right friends verb for the current relationship (Message when already
// friends, Accept when they asked first, Add friend otherwise). All state
// transitions re-render this row only, never the whole card.
function renderProfileActions(row, { username, userId, following, followedBy, canFollow, onOpenDM }) {
	if (!row) return;

	let isFollowing = following;
	let busy = false;

	const render = () => {
		row.innerHTML = '';

		// ── follow ──
		const followBtn = document.createElement('button');
		followBtn.type = 'button';
		followBtn.className = isFollowing ? 'avi-act avi-act-ghost' : 'avi-act';
		followBtn.textContent = isFollowing ? 'Following' : followedBy ? 'Follow back' : 'Follow';
		followBtn.disabled = busy || !canFollow;
		if (!canFollow) followBtn.title = 'Follow is unavailable right now';
		followBtn.addEventListener('click', async () => {
			if (busy) return;
			busy = true;
			render();
			try {
				const res = await apiFetch(`/api/users/${encodeURIComponent(username)}/follow`, {
					method: isFollowing ? 'DELETE' : 'POST',
					allowAnonymous: true,
				});
				if (res.status === 401) {
					// Signed out: swap the row for an honest sign-in path instead of
					// yanking the player out of the world with a hard redirect.
					row.innerHTML = `<a class="avi-act" href="/login?next=${encodeURIComponent(`/u/${username}`)}">Sign in to follow</a>`;
					return;
				}
				if (!res.ok) throw new Error(`follow ${res.status}`);
				const data = await res.json();
				isFollowing = !!data.following;
				const followersEl = row.closest('.avi-section-body')?.querySelector('[data-avi-followers]');
				if (followersEl && Number.isFinite(data.followers_count)) followersEl.textContent = fmtAmount(data.followers_count);
			} catch (err) {
				log.warn('[avatar-inspector] follow toggle failed', err?.message);
			} finally {
				busy = false;
				if (document.contains(row)) render();
			}
		});
		row.appendChild(followBtn);

		// ── friends / DM ──
		const fc = friendsClient();
		if (fc.loadError === 'signin' || !userId) {
			return; // anonymous viewer (or profile without an id): follow row handles the sign-in story
		}
		const isFriend = !!fc.friend(userId);
		const incoming = fc.incoming.some((r) => r.id === userId);
		const outgoing = fc.outgoing.some((r) => r.id === userId);

		const friendBtn = document.createElement('button');
		friendBtn.type = 'button';
		if (isFriend) {
			friendBtn.className = 'avi-act';
			friendBtn.textContent = 'Message';
			friendBtn.addEventListener('click', () => {
				closeAvatarInspector();
				if (typeof onOpenDM === 'function') onOpenDM(userId);
				else window.location.href = '/friends';
			});
		} else if (outgoing) {
			friendBtn.className = 'avi-act avi-act-ghost';
			friendBtn.textContent = 'Request sent';
			friendBtn.disabled = true;
		} else if (incoming) {
			friendBtn.className = 'avi-act';
			friendBtn.textContent = 'Accept friend request';
			friendBtn.addEventListener('click', async () => {
				friendBtn.disabled = true;
				try { await fc.accept(userId); } catch (err) { log.warn('[avatar-inspector] accept failed', err?.message); }
				if (document.contains(row)) render();
			});
		} else {
			friendBtn.className = 'avi-act avi-act-ghost';
			friendBtn.textContent = 'Add friend';
			friendBtn.addEventListener('click', async () => {
				friendBtn.disabled = true;
				try { await fc.sendRequest(userId); } catch (err) { log.warn('[avatar-inspector] friend request failed', err?.message); }
				if (document.contains(row)) render();
			});
		}
		row.appendChild(friendBtn);
	};

	render();
}

// About: agent bio + skills when piloting an agent, plus the world-supplied facts.
async function renderAbout(root, subject, { agentId }) {
	const body = sectionBody(root, 'about');
	if (!body) return;

	const factRows = (facts) =>
		facts
			.filter((f) => f && f.label && (f.value ?? '') !== '')
			.map(
				(f) =>
					`<div class="avi-fact"><span class="avi-fact-l">${esc(f.label)}</span><span class="avi-fact-v">${
						f.href ? `<a href="${esc(f.href)}"${/^https?:/.test(f.href) ? ' target="_blank" rel="noopener noreferrer"' : ''}>${esc(f.value)}</a>` : esc(f.value)
					}</span></div>`,
			)
			.join('');

	const baseFacts = Array.isArray(subject.facts) ? [...subject.facts] : [];
	// Caller-supplied bio: the subject's own words when it has no agent profile
	// to load one from (a gallery citizen's description, a world lore line).
	// The agent path below overwrites this with the live profile once loaded.
	const bioHtml = subject.bio ? `<p class="avi-bio">${esc(subject.bio)}</p>` : '';
	// The GLB this avatar is wearing, a real, linkable fact of the encounter.
	const avatarUrl = String(subject.avatarUrl || '');
	if (/^(https?:\/\/|\/)[^\s]+\.(glb|gltf|vrm)(\?|$)/i.test(avatarUrl)) {
		const file = avatarUrl.split('?')[0].split('/').pop();
		baseFacts.push({ label: 'Avatar model', value: file, href: avatarUrl });
	}
	const load = async () => {
		body.innerHTML = bioHtml + factRows(baseFacts) + (agentId ? skeleton(2) : '');
		if (!agentId) {
			if (!baseFacts.length && !bioHtml) {
				body.innerHTML = emptyState(
					'Nothing else on file',
					'This avatar is not piloting a registered three.ws agent, so there is no public profile to show.',
					[{ label: 'Create your own agent', href: '/agents' }],
				);
			}
			return;
		}
		try {
			const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}`, { allowAnonymous: true });
			if (!res.ok) throw new Error(`agent ${res.status}`);
			const { agent } = await res.json();
			if (!document.contains(body)) return;
			const skills = Array.isArray(agent?.skills) ? agent.skills.slice(0, 8) : [];
			body.innerHTML =
				(agent?.description ? `<p class="avi-bio">${esc(agent.description)}</p>` : '') +
				factRows([
					{ label: 'Agent', value: agent?.name || agentId.slice(0, 8), href: `/agent/${encodeURIComponent(agentId)}` },
					...(agent?.author_name ? [{ label: 'Creator', value: agent.author_name }] : []),
					...(agent?.erc8004_agent_id ? [{ label: 'ERC-8004', value: `#${agent.erc8004_agent_id} on-chain` }] : []),
					...baseFacts,
				]) +
				(skills.length
					? `<div class="avi-skills">${skills.map((s) => `<span class="avi-chip">${esc(typeof s === 'string' ? s : s?.name || '')}</span>`).join('')}</div>`
					: '');
			// Upgrade the monogram to the agent's real thumbnail once known.
			if (agent?.avatar_thumbnail_url) {
				const mono = root.querySelector('.avi-monogram');
				if (mono) mono.innerHTML = `<img src="${esc(agent.avatar_thumbnail_url)}" alt="" loading="lazy" />`;
			}
			if (agent?.name) {
				const nameEl = root.querySelector('.avi-name');
				// Peer nickname stays primary; the agent name rides underneath.
				if (nameEl && agent.name !== nameEl.textContent) {
					nameEl.insertAdjacentHTML('afterend', `<div class="avi-subname">pilots <a href="/agent/${encodeURIComponent(agentId)}">${esc(agent.name)}</a></div>`);
				}
			}
		} catch (err) {
			if (!document.contains(body)) return;
			log.warn('[avatar-inspector] agent profile failed', err?.message);
			body.innerHTML = bioHtml + factRows(baseFacts);
			body.appendChild(errorState('Could not load this agent’s profile.', load));
		}
	};
	load();
}

// Wallet: the agent's full portfolio when piloting one; bare verified-wallet
// balances otherwise; a designed empty state when there is no wallet at all.
async function renderWallet(root, { agentId, wallet, kind }) {
	const body = sectionBody(root, 'wallet');
	if (!body) return;

	const addressPlate = (address, extraClass = '') => `
		<div class="avi-plate ${extraClass}">
			<code class="avi-addr" title="${esc(address)}">${esc(shortAddress(address, 6, 6))}</code>
			<button type="button" class="avi-mini" data-copy="${esc(address)}">Copy</button>
			<a class="avi-mini" href="${esc(explorerAddr(address))}" target="_blank" rel="noopener noreferrer">Explorer</a>
		</div>`;

	const wireCopy = () => {
		body.querySelectorAll('[data-copy]').forEach((btn) =>
			btn.addEventListener('click', async () => {
				try {
					await navigator.clipboard.writeText(btn.dataset.copy);
					const was = btn.textContent;
					btn.textContent = 'Copied';
					setTimeout(() => { btn.textContent = was; }, 1200);
				} catch {
					btn.textContent = 'Press ⌘C';
					setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
				}
			}),
		);
	};

	const load = async () => {
		body.innerHTML = skeleton(3);

		if (agentId) {
			try {
				const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/solana/networth`, { allowAnonymous: true });
				if (!res.ok) throw new Error(`networth ${res.status}`);
				const { data } = await res.json();
				if (!document.contains(body)) return;
				if (!data?.address) {
					body.innerHTML = emptyState(
						'Wallet provisioning',
						'This agent’s self-custodial wallet is still being set up. Reputation it has already earned still counts.',
					);
					return;
				}
				const p = data.portfolio || {};
				const top = Array.isArray(p.top) ? p.top : [];
				body.innerHTML =
					addressPlate(data.address) +
					`<div class="avi-worth">
						<div class="avi-worth-usd">${esc(formatWalletUsd(p.usd || 0))}</div>
						<div class="avi-worth-sub">${esc(fmtAmount(p.sol))} SOL${data.tier?.label ? ` · ${esc(data.tier.label)}` : ''}${data.stale ? ' · last known' : ''}</div>
					</div>` +
					(p.three
						? `<div class="avi-fact"><span class="avi-fact-l">$THREE</span><span class="avi-fact-v">${esc(fmtAmount(p.three.amount))} (${esc(formatWalletUsd(p.three.usd))})</span></div>`
						: '') +
					(top.length
						? `<div class="avi-holdings">${top
								.map(
									(t) =>
										`<div class="avi-holding"><span>${esc(t.symbol || shortAddress(t.mint))}</span><span>${esc(fmtAmount(t.amount))}${t.usd ? ` · ${esc(formatWalletUsd(t.usd))}` : ''}</span></div>`,
								)
								.join('')}</div>`
						: `<p class="avi-note">No token holdings yet, a real $0 wallet shows $0.</p>`) +
					(data.reputation?.tips?.count
						? `<div class="avi-fact"><span class="avi-fact-l">Tips received</span><span class="avi-fact-v">${esc(data.reputation.tips.count)} (${esc(formatWalletUsd(data.reputation.tips.usd))})</span></div>`
						: '');
				wireCopy();
			} catch (err) {
				if (!document.contains(body)) return;
				log.warn('[avatar-inspector] networth failed', err?.message);
				body.innerHTML = '';
				body.appendChild(errorState('Could not read this agent’s wallet right now. Its on-chain balances are unchanged.', load));
			}
			return;
		}

		if (wallet) {
			try {
				const res = await apiFetch('/api/wallet/balances', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ chain: 'solana', address: wallet }),
					allowAnonymous: true,
				});
				if (!res.ok) throw new Error(`balances ${res.status}`);
				const bal = await res.json();
				if (!document.contains(body)) return;
				const tokens = Array.isArray(bal?.tokens) ? bal.tokens.slice(0, 5) : [];
				body.innerHTML =
					addressPlate(wallet) +
					`<div class="avi-worth">
						<div class="avi-worth-usd">${esc(fmtAmount(bal?.native?.amount))} ${esc(bal?.native?.symbol || 'SOL')}</div>
						${bal?.native?.usd ? `<div class="avi-worth-sub">${esc(formatWalletUsd(bal.native.usd))}</div>` : ''}
					</div>` +
					(tokens.length
						? `<div class="avi-holdings">${tokens
								.map((t) => `<div class="avi-holding"><span>${esc(t.symbol || '?')}</span><span>${esc(fmtAmount(t.amount))}${t.usd ? ` · ${esc(formatWalletUsd(t.usd))}` : ''}</span></div>`)
								.join('')}</div>`
						: '') +
					`<p class="avi-note">Verified account wallet, this player signed in with it, but isn’t piloting a registered agent.</p>`;
				wireCopy();
			} catch (err) {
				if (!document.contains(body)) return;
				log.warn('[avatar-inspector] balances failed', err?.message);
				body.innerHTML = addressPlate(wallet);
				wireCopy();
				body.appendChild(errorState('Could not read balances right now.', load));
			}
			return;
		}

		body.innerHTML = emptyState(
			kind === 'npc' ? 'No wallet' : 'No wallet linked',
			kind === 'npc'
				? 'Townspeople sell real paid services at their counters, but don’t carry a public wallet of their own.'
				: kind === 'self'
					? 'Sign in with your wallet, or pilot one of your agents, and your balances and reputation appear here.'
					: 'This player is exploring as a guest, no verified wallet, no agent.',
			kind === 'self' ? [{ label: 'Get an agent wallet', href: '/agent-wallet' }] : [],
		);
	};
	load();
}

// Reputation: the shared server-computed trust breakdown for agents; honest
// empty states for everyone else.
function renderReputation(root, { agentId, kind }) {
	const body = sectionBody(root, 'reputation');
	if (!body) return;
	if (agentId) {
		body.appendChild(reputationPanelEl(agentId, { unlocks: false }));
		return;
	}
	body.innerHTML = emptyState(
		'No trust score',
		kind === 'npc'
			? 'Townspeople are part of the world itself, reputation applies to player-owned agents.'
			: 'Reputation is earned by registered agents through real settled activity. This avatar isn’t piloting one.',
		kind === 'npc' ? [] : [{ label: 'How trust is earned', href: '/reputation' }],
	);
}

function renderFooter(root, { agentId, wallet, username, actions }) {
	const foot = root.querySelector('.avi-foot');
	if (!foot) return;
	const hasActions = Array.isArray(actions) && actions.some((a) => a && a.label && typeof a.onClick === 'function');
	const links = [];
	if (username) {
		// A verified platform account leads with its real profile page; the agent
		// profile (when also present) steps back to a ghost link.
		links.push(`<a class="avi-cta${hasActions ? ' avi-cta-ghost' : ''}" href="/u/${encodeURIComponent(username)}">View profile</a>`);
		if (agentId) links.push(`<a class="avi-cta avi-cta-ghost" href="/agent/${encodeURIComponent(agentId)}">Agent profile</a>`);
	} else if (agentId) {
		// When a world action (Talk 1-on-1) leads the footer, the links step back
		// to ghost style and the wallet hub folds into the full profile page.
		links.push(`<a class="avi-cta${hasActions ? ' avi-cta-ghost' : ''}" href="/agent/${encodeURIComponent(agentId)}">Full profile</a>`);
		if (!hasActions) links.push(`<a class="avi-cta avi-cta-ghost" href="/agent/${encodeURIComponent(agentId)}/wallet">Wallet hub</a>`);
	} else if (wallet) {
		links.push(`<a class="avi-cta avi-cta-ghost" href="${esc(explorerAddr(wallet))}" target="_blank" rel="noopener noreferrer">View on explorer</a>`);
	}
	foot.innerHTML = links.join('') || '';
	// World-wired action buttons (e.g. "Talk 1-on-1") lead the footer. They close
	// the panel first so the action's own surface (a chat panel) takes the stage.
	const list = Array.isArray(actions) ? actions.filter((a) => a && a.label && typeof a.onClick === 'function') : [];
	for (const action of list.reverse()) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = action.primary ? 'avi-cta' : 'avi-cta avi-cta-ghost';
		btn.textContent = action.label;
		btn.addEventListener('click', () => {
			closeAvatarInspector();
			try { action.onClick(); } catch (e) { log.warn('[avatar-inspector] action failed', e?.message); }
		});
		foot.prepend(btn);
	}
	if (!foot.childNodes.length) foot.innerHTML = `<span class="avi-foot-hint">Esc closes · I inspects the nearest avatar</span>`;
}

// ── styles ───────────────────────────────────────────────────────────────────

function ensureStyles() {
	if (document.getElementById(STYLE_ID)) return;
	const s = document.createElement('style');
	s.id = STYLE_ID;
	s.textContent = `
.avi-root{position:fixed;top:0;right:0;bottom:0;z-index:940;width:min(400px,94vw);display:flex;flex-direction:column;
	background:color-mix(in srgb, var(--bg,#0b0b0b) 88%, transparent);border-left:1px solid var(--border,#26262b);
	backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);color:var(--text,#e7e7ea);
	transform:translateX(102%);transition:transform .22s cubic-bezier(.2,.8,.25,1);
	font:13.5px/1.5 var(--font-body,ui-sans-serif,system-ui,sans-serif)}
.avi-root.avi-in{transform:translateX(0)}
@media (prefers-reduced-motion: reduce){.avi-root{transition:none}}
.avi-head{display:flex;align-items:center;gap:12px;padding:16px 16px 12px;border-bottom:1px solid var(--border,#26262b)}
.avi-monogram{width:44px;height:44px;border-radius:12px;flex:0 0 auto;display:grid;place-items:center;overflow:hidden;
	background:linear-gradient(135deg,#1d1d24,#2a2a35);border:1px solid var(--border,#26262b);
	font-weight:700;font-size:15px;letter-spacing:.5px;color:var(--text,#e7e7ea)}
.avi-monogram img{width:100%;height:100%;object-fit:cover}
.avi-id{min-width:0;flex:1}
.avi-name{margin:0;font-size:16px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.avi-subname{font-size:12px;color:var(--ink-soft,#9a9aa3)}
.avi-subname a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.avi-subname a:hover{color:var(--text,#e7e7ea)}
.avi-chips{display:flex;gap:6px;margin-top:4px;flex-wrap:wrap}
.avi-chip{font-size:10.5px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;padding:2px 8px;border-radius:999px;
	border:1px solid var(--border,#26262b);color:var(--ink-soft,#9a9aa3);background:rgba(255,255,255,.03)}
.avi-chip-kind{color:var(--text,#e7e7ea);border-color:color-mix(in srgb, var(--accent,#c4b5fd) 45%, transparent)}
.avi-close{flex:0 0 auto;width:30px;height:30px;border-radius:8px;border:1px solid var(--border,#26262b);
	background:transparent;color:var(--ink-soft,#9a9aa3);font-size:13px;cursor:pointer;
	transition:background .15s ease,color .15s ease}
.avi-close:hover,.avi-close:focus-visible{background:rgba(255,255,255,.07);color:var(--text,#e7e7ea)}
.avi-close:focus-visible{outline:2px solid var(--accent,#c4b5fd);outline-offset:1px}
.avi-body{flex:1;overflow-y:auto;overscroll-behavior:contain;padding:6px 16px 16px}
.avi-section{padding:12px 0;border-bottom:1px solid color-mix(in srgb, var(--border,#26262b) 60%, transparent)}
.avi-section:last-child{border-bottom:none}
.avi-h{margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--ink-soft,#9a9aa3)}
.avi-bio{margin:0 0 10px;color:var(--ink-soft,#c2c2ca)}
.avi-fact{display:flex;justify-content:space-between;gap:12px;padding:4px 0;font-size:13px}
.avi-fact-l{color:var(--ink-soft,#9a9aa3);flex:0 0 auto}
.avi-fact-v{text-align:right;min-width:0;overflow-wrap:anywhere}
.avi-fact-v a{color:inherit;text-decoration:underline;text-underline-offset:2px}
.avi-fact-v a:hover{color:var(--accent,#c4b5fd)}
.avi-skills{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.avi-plate{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;
	border:1px solid var(--border,#26262b);background:rgba(255,255,255,.03)}
.avi-addr{font-family:var(--font-mono,ui-monospace,monospace);font-size:12.5px;flex:1;min-width:0;
	overflow:hidden;text-overflow:ellipsis}
.avi-mini{flex:0 0 auto;font-size:11px;font-weight:600;padding:3px 8px;border-radius:7px;cursor:pointer;
	border:1px solid var(--border,#26262b);background:transparent;color:var(--ink-soft,#9a9aa3);text-decoration:none;
	transition:background .15s ease,color .15s ease}
.avi-mini:hover,.avi-mini:focus-visible{background:rgba(255,255,255,.08);color:var(--text,#e7e7ea)}
.avi-mini:focus-visible{outline:2px solid var(--accent,#c4b5fd);outline-offset:1px}
.avi-worth{margin:12px 0 8px}
.avi-worth-usd{font-size:24px;font-weight:750;letter-spacing:-.02em}
.avi-worth-sub{font-size:12px;color:var(--ink-soft,#9a9aa3);margin-top:2px}
.avi-holdings{margin-top:8px;border:1px solid color-mix(in srgb, var(--border,#26262b) 70%, transparent);border-radius:10px;overflow:hidden}
.avi-holding{display:flex;justify-content:space-between;gap:10px;padding:6px 10px;font-size:12.5px}
.avi-holding:nth-child(odd){background:rgba(255,255,255,.025)}
.avi-holding span:last-child{color:var(--ink-soft,#c2c2ca)}
.avi-note{margin:8px 0 0;font-size:12px;color:var(--ink-soft,#9a9aa3)}
.avi-empty{padding:10px 12px;border:1px dashed color-mix(in srgb, var(--border,#26262b) 90%, transparent);border-radius:10px}
.avi-empty-title{font-weight:650;margin-bottom:2px}
.avi-empty p{margin:0;font-size:12.5px;color:var(--ink-soft,#9a9aa3)}
.avi-links{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}
.avi-links a{font-size:12.5px;font-weight:600;color:var(--accent,#c4b5fd);text-decoration:none}
.avi-links a:hover,.avi-links a:focus-visible{text-decoration:underline;text-underline-offset:2px}
.avi-profile-counts{display:flex;gap:14px;flex-wrap:wrap;margin:2px 0 6px;font-size:12.5px;color:var(--ink-soft,#9a9aa3)}
.avi-profile-counts b{color:var(--text,#e7e7ea);font-weight:700;margin-right:3px}
.avi-profile-actions{display:flex;gap:8px;margin:8px 0 10px;flex-wrap:wrap}
.avi-profile-actions:empty{display:none}
.avi-act{flex:1;min-width:110px;text-align:center;font-size:12.5px;font-weight:650;padding:7px 10px;border-radius:9px;cursor:pointer;
	border:1px solid transparent;background:var(--accent,#c4b5fd);color:#0b0b0b;text-decoration:none;transition:filter .15s ease,background .15s ease,color .15s ease}
.avi-act:hover,.avi-act:focus-visible{filter:brightness(1.08)}
.avi-act:focus-visible{outline:2px solid var(--text,#e7e7ea);outline-offset:1px}
.avi-act:disabled{opacity:.55;cursor:default;filter:none}
.avi-act-ghost{background:transparent;color:var(--text,#e7e7ea);border-color:var(--border,#26262b)}
.avi-act-ghost:hover:not(:disabled),.avi-act-ghost:focus-visible{background:rgba(255,255,255,.07)}
.avi-creations{margin-top:8px;border:1px solid color-mix(in srgb, var(--border,#26262b) 70%, transparent);border-radius:10px;overflow:hidden}
.avi-creation{display:flex;align-items:center;gap:8px;padding:6px 10px;font-size:12.5px;color:inherit;text-decoration:none;
	transition:background .15s ease}
.avi-creation:nth-child(odd){background:rgba(255,255,255,.025)}
.avi-creation:hover,.avi-creation:focus-visible{background:rgba(255,255,255,.07)}
.avi-creation-ico{flex:0 0 auto;color:var(--accent,#c4b5fd)}
.avi-creation-title{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.avi-creation-date{flex:0 0 auto;color:var(--ink-soft,#9a9aa3);font-size:11.5px}
.avi-more{display:inline-block;margin-top:8px;font-size:12.5px;font-weight:600;color:var(--accent,#c4b5fd);text-decoration:none}
.avi-more:hover,.avi-more:focus-visible{text-decoration:underline;text-underline-offset:2px}
.avi-error{margin-top:8px;padding:10px 12px;border:1px solid color-mix(in srgb, #f87171 40%, transparent);border-radius:10px}
.avi-error p{margin:0 0 8px;font-size:12.5px;color:var(--ink-soft,#c2c2ca)}
.avi-retry{font-size:12px;font-weight:600;padding:4px 10px;border-radius:8px;cursor:pointer;
	border:1px solid var(--border,#26262b);background:transparent;color:var(--text,#e7e7ea)}
.avi-retry:hover,.avi-retry:focus-visible{background:rgba(255,255,255,.08)}
.avi-sk{height:14px;border-radius:6px;margin:6px 0;background:linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.11),rgba(255,255,255,.05));
	background-size:200% 100%;animation:avi-shimmer 1.2s linear infinite}
@keyframes avi-shimmer{to{background-position:-200% 0}}
@media (prefers-reduced-motion: reduce){.avi-sk{animation:none}}
.avi-foot{display:flex;gap:8px;padding:12px 16px;border-top:1px solid var(--border,#26262b)}
.avi-foot-hint{font-size:11.5px;color:var(--ink-soft,#9a9aa3)}
.avi-cta{flex:1;text-align:center;font-size:13px;font-weight:650;padding:8px 10px;border-radius:10px;text-decoration:none;
	background:var(--accent,#c4b5fd);color:#0b0b0b;transition:filter .15s ease}
.avi-cta:hover,.avi-cta:focus-visible{filter:brightness(1.08)}
.avi-cta:focus-visible{outline:2px solid var(--text,#e7e7ea);outline-offset:1px}
.avi-cta-ghost{background:transparent;color:var(--text,#e7e7ea);border:1px solid var(--border,#26262b)}
@media (max-width:480px){.avi-root{width:100vw;border-left:none}}
`;
	document.head.appendChild(s);
}
