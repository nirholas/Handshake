import { AvatarCreator } from './avatar-creator.js';
import { saveRemoteGlbToAccount } from './account.js';

const API_BASE = '/api';
const params = new URLSearchParams(location.search);
const agentId = params.get('id');

// Avatar handoff from marketplace modal ("Start an agent with this avatar")
const initAvatarId  = params.get('avatar_id')  || null;
const initAvatarGlb = params.get('avatar_glb') || null;
const initAvatarName = params.get('avatar_name') || null;

const $ = (id) => document.getElementById(id);

let agentData = null;
let outfitMounted = false;
let availableAvatars = null;

async function loadAgent() {
  if (!agentId) {
    if (initAvatarId || initAvatarGlb) {
      await createAgentFromAvatar();
    } else {
      showError('No agent ID provided.');
    }
    return;
  }
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}`, { credentials: 'include' });
    if (r.status === 401) {
      sessionStorage.setItem('login_redirect', location.href);
      location.replace('/login');
      return;
    }
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    const j = await r.json();
    agentData = j.agent;
    if (!agentData) throw new Error('agent not in response');
    render();
  } catch (err) {
    showError(err.message);
  }
}

async function createAgentFromAvatar() {
  showLoading('Creating agent…');
  try {
    const name = initAvatarName ? `${initAvatarName} Agent` : 'My Agent';
    const createRes = await fetch(`${API_BASE}/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name }),
    });
    if (!createRes.ok) {
      const j = await createRes.json().catch(() => ({}));
      if (createRes.status === 401) {
        sessionStorage.setItem('login_redirect', location.href);
        location.replace('/login');
        return;
      }
      throw new Error(j.error_description || `HTTP ${createRes.status}`);
    }
    const { agent } = await createRes.json();

    if (initAvatarId) {
      const patchRes = await fetch(`${API_BASE}/agents/${agent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ avatar_id: initAvatarId }),
      });
      if (!patchRes.ok) {
        console.warn('[agent-edit] avatar attach failed', patchRes.status);
      }
    }

    history.replaceState({}, '', `/agent/${agent.id}/edit`);
    agentData = agent;
    if (initAvatarName) {
      agentData.name = name;
      agentData.system_prompt = agentData.system_prompt ||
        `You are ${initAvatarName}, a 3D avatar agent. Be helpful and engaging.`;
    }
    render();
    showBanner(`Agent created from "${initAvatarName || 'avatar'}" — fill in the details below.`);
  } catch (err) {
    showError(err.message);
  }
}

function showLoading(msg) {
  const el = $('loading');
  if (el) { el.hidden = false; el.textContent = msg; }
}

function showBanner(msg) {
  let el = $('avatar-origin-banner');
  if (!el) {
    el = document.createElement('div');
    el.id = 'avatar-origin-banner';
    el.style.cssText =
      'padding:10px 20px;background:rgba(125,211,252,.1);border-bottom:1px solid rgba(125,211,252,.25);' +
      'color:#7dd3fc;font-size:13px;font-weight:500;';
    document.body.prepend(el);
  }
  el.textContent = msg;
}

function render() {
  $('loading').hidden = true;
  // Reveal the persona panel (the rest stay [hidden] until their tab is opened).
  $('panel-persona').hidden = false;
  $('panel-persona').classList.add('active');
  $('agent-title').textContent = `Edit Agent: ${agentData.name || 'Untitled'}`;
  $('back-link').href = `/agents/${agentData.id}`;

  // Persona
  $('f-name').value = agentData.name || '';
  $('f-desc').value = agentData.description || '';

  // Publish
  $('f-category').value = agentData.category || '';
  $('f-tags').value = (agentData.tags || []).join(', ');
  $('f-prompt').value = agentData.system_prompt || '';
  $('f-greeting').value = agentData.greeting || '';

  // Monetization
  renderMonetization();

  // Autopilot
  $('f-strategy').value = formatStrategy(agentData.meta?.strategy);
}

function formatStrategy(strategy) {
  if (strategy == null) return '';
  if (typeof strategy === 'string') return strategy;
  try { return JSON.stringify(strategy, null, 2); } catch { return String(strategy); }
}

function parseStrategy(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // If it parses as JSON, store as object; otherwise as plain string (freeform).
  try { return JSON.parse(trimmed); } catch { return trimmed; }
}

function renderMonetization() {
  renderLaunchTokenState();
  const container = $('skill-prices-list');
  const skills = agentData.skills || [];
  if (!skills.length) {
    container.innerHTML = '<div class="muted">This agent has no skills.</div>';
    return;
  }

  const skillPrices = agentData.skill_prices || {};

  container.innerHTML = skills.map(skill => {
    const skillName = typeof skill === 'string' ? skill : skill.name;
    const price = skillPrices[skillName];
    const isPaid = !!price;
    const amount = isPaid ? (price.amount / 1e6).toFixed(2) : '';
    const trialUses = isPaid ? (price.trial_uses ?? 0) : 0;

    return `
      <div class="skill-item" data-skill-name="${escapeHtml(skillName)}">
        <span class="skill-name">${escapeHtml(skillName)}</span>
        <div class="skill-pricing-controls">
          <label class="toggle-switch">
            <input type="checkbox" class="price-toggle" ${isPaid ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
          <div class="price-input-wrapper" style="display: ${isPaid ? 'flex' : 'none'}; align-items:center; gap:8px;">
            <input type="number" class="price-input" min="0" step="0.01" placeholder="0.50" value="${amount}">
            <span>USDC</span>
            <label style="font-size:12px;color:#a1a1aa;margin-left:8px;white-space:nowrap">
              Free trials:
              <input type="number" class="trial-uses-input" min="0" max="10" step="1" placeholder="0" value="${trialUses}" style="width:52px;margin-left:4px">
            </label>
          </div>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.price-toggle').forEach(toggle => {
    toggle.addEventListener('change', (e) => {
      const wrapper = e.target.closest('.skill-pricing-controls').querySelector('.price-input-wrapper');
      wrapper.style.display = e.target.checked ? 'flex' : 'none';
    });
  });
}

function renderLaunchTokenState() {
  const host = $('launch-token-state');
  if (!host) return;
  host.innerHTML = '';
  host.classList.remove('muted');

  const token = agentData.token || agentData.meta?.token || null;
  if (token?.mint) {
    const dashLink = token.pumpfun_url
      || (token.cluster === 'devnet'
        ? `https://explorer.solana.com/address/${token.mint}?cluster=devnet`
        : `https://pump.fun/${token.mint}`);
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap';
    row.innerHTML = `
      <span style="font-weight:600;color:#a4f0bc">$${escapeHtml(token.symbol || 'TOKEN')}</span>
      <span style="font-family:ui-monospace,monospace;font-size:12px;color:rgba(255,255,255,0.55)">${escapeHtml(token.mint)}</span>
    `;
    const view = document.createElement('a');
    view.href = dashLink;
    view.target = '_blank';
    view.rel = 'noopener noreferrer';
    view.className = 'btn-primary';
    view.textContent = `View on ${token.cluster === 'devnet' ? 'Solana Explorer' : 'pump.fun'} →`;
    row.appendChild(view);
    host.appendChild(row);
    return;
  }

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn-primary';
  btn.textContent = '🚀 Launch agent token';
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const { openLaunchTokenModal } = await import('/src/pump/launch-token-modal.js');
      const onchain = agentData.onchain || agentData.meta?.onchain || null;
      const needsDeploy = !onchain || onchain.family !== 'solana';
      const imageUrl = agentData.avatar_thumbnail_url || agentData.meta?.thumbnail_url || '';
      openLaunchTokenModal({
        agentId: agentData.id,
        agentName: agentData.name || 'Agent',
        imageUrl,
        needsDeploy,
        agentForDeploy: needsDeploy
          ? {
              id: agentData.id,
              name: agentData.name,
              description: agentData.description || '',
              avatar_id: agentData.avatar_id || null,
              skills: agentData.skills || undefined,
            }
          : null,
      });
    } finally {
      btn.disabled = false;
    }
  });
  host.appendChild(btn);
}

// ── Outfit tab ────────────────────────────────────────────────────────────
// Lazily mount the agent preview + avatar picker only when the user opens
// the tab so we don't pay for a WebGL context up front.

async function ensureAgent3DLib() {
  if (customElements.get('agent-3d')) return true;
  const candidates = ['/agent-3d/latest/agent-3d.js', '/dist-lib/agent-3d.js'];
  for (const url of candidates) {
    try {
      await import(/* @vite-ignore */ url);
      if (customElements.get('agent-3d')) return true;
    } catch {
      /* try next candidate */
    }
  }
  return false;
}

async function ensureOutfitTab() {
  if (outfitMounted) return;
  outfitMounted = true;

  await ensureAgent3DLib();
  const preview = $('outfit-preview');
  const a3d = document.createElement('agent-3d');
  a3d.setAttribute('agent-id', agentId);
  a3d.setAttribute('controls', 'orbit');
  a3d.style.cssText = 'width:100%;height:100%;display:block';
  preview.innerHTML = '';
  preview.appendChild(a3d);

  await renderAvatarList();
  await renderAnimationsPicker();
}

async function renderAvatarList() {
  const container = $('avatar-picker-list');
  container.textContent = 'Loading avatars…';
  try {
    const r = await fetch(`${API_BASE}/avatars?limit=50`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    availableAvatars = j.avatars || [];
  } catch (err) {
    container.innerHTML = `<div class="error-msg" style="padding:1rem">Could not load avatars: ${escapeHtml(err.message)}</div>`;
    return;
  }

  if (!availableAvatars.length) {
    container.innerHTML = '<div class="no-named-mats">You have no avatars yet. <a href="/dashboard/#avatars" style="color:#93c5fd">Create one in the dashboard ›</a></div>';
    return;
  }

  const createTile = `
    <button type="button" class="avatar-tile avatar-create-tile" id="avatar-create-tile" title="Create a new avatar">
      <div class="avatar-tile-ph avatar-create-icon" aria-hidden="true">+</div>
      <span class="avatar-tile-name">Create new</span>
    </button>
  `;

  const tiles = availableAvatars.map((av) => {
    const thumb = av.thumbnail_url || av.url || '';
    const isCurrent = av.id === agentData.avatar_id;
    return `
      <button type="button" class="avatar-tile${isCurrent ? ' current' : ''}" data-avatar-id="${escapeHtml(av.id)}" title="${escapeHtml(av.name || av.id)}">
        ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" loading="lazy">` : '<div class="avatar-tile-ph">3D</div>'}
        <span class="avatar-tile-name">${escapeHtml(av.name || 'Untitled')}</span>
        ${isCurrent ? '<span class="avatar-tile-badge">Current</span>' : ''}
      </button>
    `;
  }).join('');

  container.innerHTML = createTile + tiles;

  container.querySelectorAll('.avatar-tile[data-avatar-id]').forEach((btn) => {
    btn.addEventListener('click', () => selectAvatar(btn.dataset.avatarId));
  });
  container.querySelector('#avatar-create-tile')?.addEventListener('click', () => openAvatarCreateMenu());
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline avatar creation
// ─────────────────────────────────────────────────────────────────────────────

let _avatarCreator = null;
function getAvatarCreator() {
  if (_avatarCreator) return _avatarCreator;
  _avatarCreator = new AvatarCreator(document.body, async (blob, meta = {}) => {
    await saveNewAvatarAndSelect(blob, meta);
  });
  return _avatarCreator;
}

function openAvatarCreateMenu() {
  // Close any existing menu first.
  document.getElementById('avatar-create-menu')?.remove();

  const tile = document.getElementById('avatar-create-tile');
  if (!tile) return;

  const menu = document.createElement('div');
  menu.id = 'avatar-create-menu';
  menu.className = 'avatar-create-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = `
    <button type="button" role="menuitem" data-source="characterstudio">
      <span class="acm-title">three.ws Studio</span>
      <span class="acm-sub">In-browser builder — hair, clothing, body</span>
    </button>
    <button type="button" role="menuitem" data-source="avaturn">
      <span class="acm-title">three.ws Selfie</span>
      <span class="acm-sub">Photo → photoreal avatar</span>
    </button>
    <button type="button" role="menuitem" data-source="upload">
      <span class="acm-title">Upload GLB</span>
      <span class="acm-sub">Bring your own model</span>
    </button>
  `;
  document.body.appendChild(menu);

  const r = tile.getBoundingClientRect();
  menu.style.top = `${Math.round(window.scrollY + r.bottom + 8)}px`;
  menu.style.left = `${Math.round(window.scrollX + r.left)}px`;

  const close = () => {
    menu.remove();
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const onDocDown = (e) => {
    if (!menu.contains(e.target) && e.target !== tile) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);

  menu.querySelectorAll('button[data-source]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const src = btn.dataset.source;
      close();
      startAvatarCreate(src);
    });
  });
}

function startAvatarCreate(source) {
  if (source === 'upload') {
    triggerHiddenGlbInput();
    return;
  }
  const creator = getAvatarCreator();
  if (source === 'characterstudio') creator.open();
  else if (source === 'avaturn') creator.openDefaultEditor();
}

function triggerHiddenGlbInput() {
  let input = document.getElementById('inline-glb-input');
  if (!input) {
    input = document.createElement('input');
    input.type = 'file';
    input.accept = '.glb,model/gltf-binary';
    input.id = 'inline-glb-input';
    input.hidden = true;
    document.body.appendChild(input);
    input.addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      // GLB magic-byte check before uploading.
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
      if (head[0] !== 0x67 || head[1] !== 0x6c || head[2] !== 0x54 || head[3] !== 0x46) {
        const status = $('outfit-status');
        if (status) { status.textContent = 'Not a valid .glb file.'; status.className = 'outfit-status err'; }
        return;
      }
      const name = file.name.replace(/\.glb$/i, '').trim() || 'My Avatar';
      await saveNewAvatarAndSelect(file, { provider: 'upload', name });
    });
  }
  input.click();
}

async function saveNewAvatarAndSelect(blob, meta = {}) {
  const status = $('outfit-status');
  if (status) { status.textContent = 'Saving avatar…'; status.className = 'outfit-status saving'; }
  try {
    const provider = meta.provider || 'upload';
    const source = provider === 'avaturn' ? 'avaturn' : provider === 'upload' ? 'upload' : 'import';
    const source_meta = { provider, ...(meta.sourceUrl ? { source_url: meta.sourceUrl } : {}) };
    const avatar = await saveRemoteGlbToAccount(blob, {
      source,
      source_meta,
      name: meta.name,
    });
    if (status) { status.textContent = 'Attaching to agent…'; }
    await selectAvatar(avatar.id);
    // Refresh the picker so the new avatar shows up; selectAvatar already
    // re-renders, but availableAvatars may be stale if the request raced.
    if (!availableAvatars.some((a) => a.id === avatar.id)) {
      availableAvatars = [avatar, ...availableAvatars];
      await renderAvatarList();
    }
  } catch (err) {
    if (status) { status.textContent = `Error: ${err.message || 'Failed to save avatar.'}`; status.className = 'outfit-status err'; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Animation picker
// ─────────────────────────────────────────────────────────────────────────────

const ANIMATIONS_MAX = 30;

let animationLibrary = null;        // [{ name, url, label, icon, loop }]
let selectedAnimNames = new Set();
// Animation state machine UI state — see src/animation-state-machine.js
const ANIM_STATES = ['idle', 'talk', 'walk', 'react', 'emote'];
const ANIM_STATE_DEFAULT_CLIP = {
  idle: 'idle', talk: 'idle', walk: 'walk', react: 'reaction', emote: 'wave',
};
let animGraphState = {};            // { idle: 'idle', talk: 'idle', ... } (clip names, "" = unset/use default)
let originalAnimGraphState = {};

let originalAnimNames = new Set();

async function renderAnimationsPicker() {
  const grid = $('anims-picker-grid');
  const status = $('anims-status');
  const saveBtn = $('anims-save');
  if (!grid) return;

  if (!animationLibrary) {
    try {
      const r = await fetch('/animations/manifest.json', { credentials: 'omit' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      animationLibrary = await r.json();
    } catch (err) {
      grid.innerHTML = `<div class="error-msg" style="padding:1rem">Could not load animation library: ${escapeHtml(err.message)}</div>`;
      return;
    }
  }

  const current = Array.isArray(agentData.meta?.animations) ? agentData.meta.animations : [];
  selectedAnimNames = new Set(current.map((a) => a.name));
  originalAnimNames = new Set(selectedAnimNames);

  grid.innerHTML = animationLibrary.map((a) => {
    const selected = selectedAnimNames.has(a.name);
    return `
      <button type="button" class="anim-tile${selected ? ' selected' : ''}" data-anim-name="${escapeHtml(a.name)}" title="${escapeHtml(a.label || a.name)}">
        <span class="anim-tile-icon" aria-hidden="true">${escapeHtml(a.icon || '🎬')}</span>
        <span class="anim-tile-name">${escapeHtml(a.label || a.name)}</span>
        <span class="anim-tile-check" aria-hidden="true">✓</span>
      </button>
    `;
  }).join('');

  grid.querySelectorAll('.anim-tile').forEach((btn) => {
    btn.addEventListener('click', () => {
      const name = btn.dataset.animName;
      if (selectedAnimNames.has(name)) {
        selectedAnimNames.delete(name);
        btn.classList.remove('selected');
      } else {
        if (selectedAnimNames.size >= ANIMATIONS_MAX) {
          if (status) {
            status.textContent = `Up to ${ANIMATIONS_MAX} clips per agent.`;
            status.className = 'form-status err';
          }
          return;
        }
        selectedAnimNames.add(name);
        btn.classList.add('selected');
      }
      updateAnimSaveButton();
    });
  });

  if (saveBtn && !saveBtn.dataset.wired) {
    saveBtn.dataset.wired = '1';
    saveBtn.addEventListener('click', saveAnimations);
  }
  updateAnimSaveButton();

  renderAnimGraphPicker();
}

function renderAnimGraphPicker() {
  const rows = $('anim-graph-rows');
  const saveBtn = $('anim-graph-save');
  if (!rows) return;

  const graph = agentData.meta?.animationGraph || {};
  animGraphState = {};
  for (const state of ANIM_STATES) {
    animGraphState[state] = graph.states?.[state]?.clip ?? '';
  }
  originalAnimGraphState = { ...animGraphState };

  rows.innerHTML = ANIM_STATES.map((state) => {
    const def = ANIM_STATE_DEFAULT_CLIP[state];
    const options = ['<option value="">— default —</option>']
      .concat(
        animationLibrary.map((a) => {
          const sel = animGraphState[state] === a.name ? ' selected' : '';
          return `<option value="${escapeHtml(a.name)}"${sel}>${escapeHtml(a.label || a.name)}</option>`;
        }),
      )
      .join('');
    return `
      <div class="anim-graph-row" data-state="${state}">
        <span class="anim-graph-row-label">${state}</span>
        <select aria-label="Clip for ${state} state">${options}</select>
        <span class="anim-graph-row-meta">default: ${def}</span>
      </div>
    `;
  }).join('');

  rows.querySelectorAll('.anim-graph-row').forEach((row) => {
    const state = row.dataset.state;
    const select = row.querySelector('select');
    select.addEventListener('change', () => {
      animGraphState[state] = select.value;
      updateAnimGraphSaveButton();
    });
  });

  if (saveBtn && !saveBtn.dataset.wired) {
    saveBtn.dataset.wired = '1';
    saveBtn.addEventListener('click', saveAnimationGraph);
  }
  updateAnimGraphSaveButton();
}

function updateAnimGraphSaveButton() {
  const saveBtn = $('anim-graph-save');
  if (!saveBtn) return;
  const dirty = ANIM_STATES.some((s) => animGraphState[s] !== originalAnimGraphState[s]);
  saveBtn.disabled = !dirty;
}

// Build the API-shaped graph object from the current picker selections.
// Empty (default) selections are omitted so the API receives only overrides.
function buildAnimGraphPayload() {
  const states = {};
  for (const state of ANIM_STATES) {
    const clip = animGraphState[state];
    if (clip && clip !== '' && clip !== ANIM_STATE_DEFAULT_CLIP[state]) {
      states[state] = { clip };
    }
  }
  return Object.keys(states).length > 0 ? { states } : null;
}

async function saveAnimationGraph() {
  const status = $('anim-graph-status');
  const saveBtn = $('anim-graph-save');
  if (!status || !saveBtn) return;

  // PUT /api/agents/:id/animations requires animations[] alongside the graph,
  // so we re-send the current selection unchanged.
  const animations = animationLibrary
    .filter((a) => selectedAnimNames.has(a.name))
    .map((a) => ({
      name: a.name,
      url: a.url,
      loop: a.loop !== false,
      source: 'mixamo',
      addedAt: new Date().toISOString(),
    }));
  const animationGraph = buildAnimGraphPayload();

  saveBtn.disabled = true;
  status.textContent = 'Saving…';
  status.className = 'form-status';

  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}/animations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ animations, animationGraph }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    const j = await r.json();
    if (!agentData.meta) agentData.meta = {};
    agentData.meta.animations = j.animations;
    agentData.meta.animationGraph = j.animationGraph;
    originalAnimGraphState = { ...animGraphState };
    status.textContent = 'Saved animation states.';
    status.className = 'form-status ok';
    reloadOutfitPreview();
    setTimeout(() => { status.textContent = ''; status.className = 'form-status'; }, 2500);
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  } finally {
    updateAnimGraphSaveButton();
  }
}

function updateAnimSaveButton() {
  const saveBtn = $('anims-save');
  if (!saveBtn) return;
  const dirty = selectedAnimNames.size !== originalAnimNames.size
    || [...selectedAnimNames].some((n) => !originalAnimNames.has(n));
  saveBtn.disabled = !dirty;
}

async function saveAnimations() {
  const status = $('anims-status');
  const saveBtn = $('anims-save');
  if (!status || !saveBtn) return;

  const animations = animationLibrary
    .filter((a) => selectedAnimNames.has(a.name))
    .map((a) => ({
      name: a.name,
      url: a.url,
      loop: a.loop !== false,
      source: 'mixamo',
      addedAt: new Date().toISOString(),
    }));

  saveBtn.disabled = true;
  status.textContent = 'Saving…';
  status.className = 'form-status';

  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}/animations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ animations }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    const j = await r.json();
    if (!agentData.meta) agentData.meta = {};
    agentData.meta.animations = j.animations;
    originalAnimNames = new Set(j.animations.map((a) => a.name));
    selectedAnimNames = new Set(originalAnimNames);
    status.textContent = `Saved ${j.animations.length} animation${j.animations.length === 1 ? '' : 's'}.`;
    status.className = 'form-status ok';
    // Repaint the live preview so the new clips are available immediately.
    reloadOutfitPreview();
    setTimeout(() => { status.textContent = ''; status.className = 'form-status'; }, 2500);
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  } finally {
    updateAnimSaveButton();
  }
}

async function selectAvatar(avatarId) {
  if (!avatarId || avatarId === agentData.avatar_id) return;
  const status = $('outfit-status');
  status.textContent = 'Saving…';
  status.className = 'outfit-status saving';
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ avatar_id: avatarId }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    agentData.avatar_id = avatarId;
    // Re-render the avatar tiles so the "Current" badge moves, and reload the
    // 3D preview so the new model paints.
    await renderAvatarList();
    reloadOutfitPreview();
    status.textContent = 'Saved.';
    status.className = 'outfit-status saved';
    setTimeout(() => { status.textContent = ''; status.className = 'outfit-status'; }, 2000);
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'outfit-status err';
  }
}

function reloadOutfitPreview() {
  const preview = $('outfit-preview');
  const a3d = document.createElement('agent-3d');
  a3d.setAttribute('agent-id', agentId);
  a3d.setAttribute('controls', 'orbit');
  a3d.style.cssText = 'width:100%;height:100%;display:block';
  preview.innerHTML = '';
  preview.appendChild(a3d);
}

function showError(msg) {
  $('loading').hidden = true;
  const errEl = $('error');
  errEl.textContent = `Error: ${msg}`;
  errEl.hidden = false;
}

function escapeHtml(s) {
  return String(s || '').replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch],
  );
}

// --- Event Listeners ---

$('persona-save').addEventListener('click', async () => {
  const status = $('persona-status');
  const name = $('f-name').value.trim();
  const description = $('f-desc').value.trim();
  if (!name) {
    status.textContent = 'Name is required.';
    status.className = 'form-status err';
    return;
  }
  status.textContent = 'Saving…';
  status.className = 'form-status';
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ name, description }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    const j = await r.json();
    if (j.agent) {
      agentData.name = j.agent.name;
      agentData.description = j.agent.description;
      $('agent-title').textContent = `Edit Agent: ${agentData.name}`;
    }
    status.textContent = 'Saved.';
    status.className = 'form-status ok';
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
});

$('publish-save').addEventListener('click', async () => {
  const status = $('publish-status');
  const category = $('f-category').value.trim();
  const tags = $('f-tags').value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 12);
  const system_prompt = $('f-prompt').value.trim();
  const greeting = $('f-greeting').value.trim();
  const changelog = $('f-changelog').value.trim() || null;

  if (!category) {
    status.textContent = 'Pick a category.';
    status.className = 'form-status err';
    return;
  }
  if (!system_prompt) {
    status.textContent = 'Agent profile (system prompt) is required.';
    status.className = 'form-status err';
    return;
  }

  status.textContent = 'Publishing…';
  status.className = 'form-status';
  try {
    const r = await fetch(`${API_BASE}/marketplace/agents/${agentId}/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ category, tags, system_prompt, greeting, changelog }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    const ver = j.data?.version;
    status.textContent = ver ? `Published v${ver}.` : 'Published.';
    status.className = 'form-status ok';
    const view = $('publish-view');
    if (view) {
      view.href = `/marketplace#${agentId}`;
      view.hidden = false;
    }
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
});

// Solana mainnet USDC.
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

$('monetization-save').addEventListener('click', async () => {
  const prices = [];
  document.querySelectorAll('#skill-prices-list .skill-item').forEach((item) => {
    const skill = item.dataset.skillName;
    const toggle = item.querySelector('.price-toggle');
    const input = item.querySelector('.price-input');

    if (toggle.checked && input.value) {
      const trialInput = item.querySelector('.trial-uses-input');
      const trialUses = trialInput ? Math.max(0, Math.min(10, parseInt(trialInput.value || '0', 10) || 0)) : 0;
      prices.push({
        skill,
        amount: Math.round(parseFloat(input.value) * 1e6),
        currency_mint: USDC_MINT,
        chain: 'solana',
        trial_uses: trialUses,
      });
    }
  });

  const status = $('monetization-status');
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}/skills-pricing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ prices }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    status.textContent = 'Prices saved.';
    status.className = 'form-status ok';
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
});

$('autopilot-save').addEventListener('click', async () => {
  const status = $('autopilot-status');
  const text = $('f-strategy').value;
  status.textContent = 'Saving…';
  status.className = 'form-status';
  try {
    const strategy = parseStrategy(text);
    const r = await fetch(`${API_BASE}/agent-strategy?id=${encodeURIComponent(agentId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ strategy }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    agentData.meta = agentData.meta || {};
    agentData.meta.strategy = strategy;
    status.textContent = 'Strategy saved.';
    status.className = 'form-status ok';
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Voice tab
// ─────────────────────────────────────────────────────────────────────────────

let voicesCache = null;
let voiceStatus = null;
let voicePreviewAudio = null;
let voiceTabMounted = false;

async function ensureVoiceTab() {
  if (voiceTabMounted) return;
  voiceTabMounted = true;
  await Promise.all([loadVoiceStatus(), loadVoiceList()]);
}

async function loadVoiceStatus() {
  const el = $('voice-current');
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}/voice`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    voiceStatus = await r.json();
    renderVoiceStatus();
  } catch (err) {
    el.textContent = `Could not load voice: ${err.message}`;
  }
}

function renderVoiceStatus() {
  const el = $('voice-current');
  const previewBtn = $('voice-preview-btn');
  const removeBtn = $('voice-remove-btn');
  if (!voiceStatus || !voiceStatus.voice_id) {
    el.textContent = `Browser speech synthesis (no custom voice set).`;
    previewBtn.hidden = true;
    removeBtn.hidden = true;
    return;
  }
  const name = (voicesCache || []).find((v) => v.voice_id === voiceStatus.voice_id)?.name || voiceStatus.voice_id;
  const cloned = voiceStatus.voice_cloned_at ? ` — cloned ${new Date(voiceStatus.voice_cloned_at).toLocaleDateString()}` : '';
  el.textContent = `${voiceStatus.voice_provider || 'elevenlabs'}: ${name}${cloned}`;
  previewBtn.hidden = false;
  removeBtn.hidden = false;
}

async function loadVoiceList(filter = '') {
  const container = $('voice-list');
  if (!voicesCache) {
    try {
      const r = await fetch(`${API_BASE}/tts/eleven/voices`, { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      voicesCache = j.voices || [];
    } catch (err) {
      container.innerHTML = `<div class="muted">Could not load voices: ${escapeHtml(err.message)}</div>`;
      return;
    }
  }
  renderVoiceList(filter);
}

function renderVoiceList(filter = '') {
  const container = $('voice-list');
  const f = filter.trim().toLowerCase();
  const list = (voicesCache || []).filter((v) => !f || (v.name || '').toLowerCase().includes(f) || (v.category || '').toLowerCase().includes(f));
  if (!list.length) {
    container.innerHTML = '<div class="muted">No voices match.</div>';
    return;
  }
  const currentId = voiceStatus?.voice_id;
  container.innerHTML = list.map((v) => `
    <div class="voice-tile${v.voice_id === currentId ? ' current' : ''}" data-voice-id="${escapeHtml(v.voice_id)}" data-preview="${escapeHtml(v.preview_url || '')}">
      <div class="voice-tile-name">
        <span>${escapeHtml(v.name || v.voice_id)}</span>
        <span class="voice-tile-meta">${escapeHtml(v.category || '')}</span>
      </div>
      ${v.preview_url ? '<button type="button" class="voice-tile-play" title="Preview">▶</button>' : ''}
    </div>
  `).join('');
  container.querySelectorAll('.voice-tile').forEach((tile) => {
    tile.addEventListener('click', (e) => {
      if (e.target.classList.contains('voice-tile-play')) {
        playVoicePreview(tile.dataset.preview);
        return;
      }
      selectVoice(tile.dataset.voiceId);
    });
  });
}

function playVoicePreview(url) {
  if (!url) return;
  try { voicePreviewAudio?.pause(); } catch {}
  voicePreviewAudio = new Audio(url);
  voicePreviewAudio.play().catch(() => {});
}

async function selectVoice(voiceId) {
  if (!voiceId) return;
  const status = $('voice-status');
  status.textContent = 'Saving…';
  status.className = 'form-status';
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ voice_provider: 'elevenlabs', voice_id: voiceId }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    voiceStatus = { voice_provider: 'elevenlabs', voice_id: voiceId, voice_cloned_at: null };
    renderVoiceStatus();
    renderVoiceList($('voice-filter').value);
    status.textContent = 'Saved.';
    status.className = 'form-status ok';
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
}

$('voice-filter').addEventListener('input', (e) => renderVoiceList(e.target.value));

$('voice-preview-btn').addEventListener('click', () => {
  const v = (voicesCache || []).find((x) => x.voice_id === voiceStatus?.voice_id);
  if (v?.preview_url) playVoicePreview(v.preview_url);
});

$('voice-remove-btn').addEventListener('click', async () => {
  const status = $('voice-status');
  if (!confirm('Remove cloned voice? This frees the ElevenLabs quota slot.')) return;
  status.textContent = 'Removing…';
  status.className = 'form-status';
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}/voice`, { method: 'DELETE', credentials: 'include' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    voiceStatus = { voice_provider: 'browser', voice_id: null, voice_cloned_at: null };
    renderVoiceStatus();
    renderVoiceList($('voice-filter').value);
    status.textContent = 'Removed.';
    status.className = 'form-status ok';
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
});

$('voice-clone-btn').addEventListener('click', () => $('voice-clone-file').click());

$('voice-clone-file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const status = $('voice-status');
  status.textContent = 'Uploading…';
  status.className = 'form-status';
  try {
    const cloneName = $('voice-clone-name').value.trim() || `${agentData.name || 'Agent'} voice`;
    const qs = new URLSearchParams({ name: cloneName });
    const audio = await blobToArrayBuffer(file);
    const r = await fetch(`${API_BASE}/agents/${agentId}/voice/clone?${qs}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': file.type || 'audio/mpeg' },
      body: audio,
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    const j = await r.json();
    voiceStatus = { voice_provider: 'elevenlabs', voice_id: j.voice_id, voice_cloned_at: new Date().toISOString() };
    renderVoiceStatus();
    status.textContent = 'Voice cloned.';
    status.className = 'form-status ok';
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  } finally {
    e.target.value = '';
  }
});

function blobToArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsArrayBuffer(blob);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Knowledge tab
// ─────────────────────────────────────────────────────────────────────────────

let knowledgeTabMounted = false;

async function ensureKnowledgeTab() {
  if (knowledgeTabMounted) return;
  knowledgeTabMounted = true;
  await loadMemories();
}

async function loadMemories() {
  const container = $('mem-list');
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}/memories`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    renderMemories(j.data || []);
  } catch (err) {
    container.innerHTML = `<div class="muted">Could not load memories: ${escapeHtml(err.message)}</div>`;
  }
}

function renderMemories(rows) {
  const container = $('mem-list');
  if (!rows.length) {
    container.innerHTML = '<div class="muted">No memories yet.</div>';
    return;
  }
  container.innerHTML = rows.map((m) => `
    <div class="mem-item" data-id="${escapeHtml(m.id)}">
      <div class="mem-item-body">
        <div class="mem-item-type">${escapeHtml(m.type)}</div>
        <div class="mem-item-content">${escapeHtml(m.content)}</div>
        ${m.tags?.length ? `<div class="mem-item-tags">${m.tags.map(escapeHtml).join(' · ')}</div>` : ''}
      </div>
      <button class="chip-remove" data-del="${escapeHtml(m.id)}" title="Delete">×</button>
    </div>
  `).join('');
  container.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => deleteMemory(btn.dataset.del));
  });
}

async function deleteMemory(id) {
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}/memories/${id}`, { method: 'DELETE', credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await loadMemories();
  } catch (err) {
    $('mem-status').textContent = `Delete failed: ${err.message}`;
    $('mem-status').className = 'form-status err';
  }
}

$('mem-add-btn').addEventListener('click', async () => {
  const status = $('mem-status');
  const type = $('mem-type').value;
  const content = $('mem-content').value.trim();
  const tags = $('mem-tags').value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20);
  if (!content) {
    status.textContent = 'Content is required.';
    status.className = 'form-status err';
    return;
  }
  status.textContent = 'Saving…';
  status.className = 'form-status';
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}/memories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ type, content, tags }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    $('mem-content').value = '';
    $('mem-tags').value = '';
    status.textContent = 'Added.';
    status.className = 'form-status ok';
    await loadMemories();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
});

$('mem-seed-btn').addEventListener('click', async () => {
  const status = $('mem-status');
  const url = $('mem-seed-url').value.trim();
  if (!url) {
    status.textContent = 'URL is required.';
    status.className = 'form-status err';
    return;
  }
  status.textContent = 'Seeding…';
  status.className = 'form-status';
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}/memory-seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ url }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    const j = await r.json().catch(() => ({}));
    $('mem-seed-url').value = '';
    status.textContent = `Seeded ${j.added ?? ''} memories.`.trim();
    status.className = 'form-status ok';
    await loadMemories();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Skills tab
// ─────────────────────────────────────────────────────────────────────────────

const BUILTIN_SKILLS = new Set(['greet', 'present-model', 'validate-model', 'remember', 'think']);
let skillsTabMounted = false;
let workingSkills = null;

async function ensureSkillsTab() {
  if (skillsTabMounted) return;
  skillsTabMounted = true;
  workingSkills = [...(agentData.skills || [])];
  renderSkillsChips();
  await loadMarketplaceSkillSuggestions();
}

function renderSkillsChips() {
  const container = $('skills-list');
  if (!workingSkills.length) {
    container.innerHTML = '<div class="muted">No skills.</div>';
    return;
  }
  container.innerHTML = workingSkills.map((s) => {
    const builtin = BUILTIN_SKILLS.has(s);
    return `<span class="chip${builtin ? ' chip-builtin' : ''}">${escapeHtml(s)}${builtin ? '' : ` <button class="chip-remove" data-skill="${escapeHtml(s)}" title="Remove">×</button>`}</span>`;
  }).join('');
  container.querySelectorAll('.chip-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      workingSkills = workingSkills.filter((s) => s !== btn.dataset.skill);
      renderSkillsChips();
    });
  });
}

async function loadMarketplaceSkillSuggestions() {
  const datalist = $('skills-marketplace');
  try {
    const r = await fetch(`${API_BASE}/skills?limit=50`, { credentials: 'include' });
    if (!r.ok) return;
    const j = await r.json();
    const items = j.skills || j.data || [];
    datalist.innerHTML = items.map((s) => `<option value="${escapeHtml(s.slug || s.name)}">${escapeHtml(s.name || s.slug || '')}</option>`).join('');
  } catch {
    // Suggestions are optional; silently skip on error.
  }
}

$('skill-add-btn').addEventListener('click', () => {
  const status = $('skills-status');
  const value = $('skill-add-input').value.trim().toLowerCase();
  if (!value) return;
  if (workingSkills.includes(value)) {
    status.textContent = 'Already added.';
    status.className = 'form-status err';
    return;
  }
  workingSkills.push(value);
  $('skill-add-input').value = '';
  renderSkillsChips();
  status.textContent = '';
});

$('skills-save').addEventListener('click', async () => {
  const status = $('skills-status');
  status.textContent = 'Saving…';
  status.className = 'form-status';
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ skills: workingSkills }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    const j = await r.json();
    agentData.skills = j.agent?.skills || workingSkills;
    status.textContent = 'Saved.';
    status.className = 'form-status ok';
    renderMonetization();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Wallet tab
// ─────────────────────────────────────────────────────────────────────────────

let walletTabMounted = false;
let walletInfo = null;

async function ensureWalletTab() {
  if (walletTabMounted) return;
  walletTabMounted = true;
  await loadWallet();
  loadWalletActivity();
}

async function loadWallet() {
  const meta = agentData.meta || {};
  const solAddr = meta.solana_address || agentData.solana_address || null;
  const evmAddr = agentData.wallet_address || null;
  const chainId = agentData.chain_id || null;

  walletInfo = { solAddr, evmAddr, chainId };

  if (solAddr) {
    $('wallet-sol-address').textContent = solAddr;
    $('wallet-explorer').href = `https://solscan.io/account/${solAddr}`;
    $('wallet-explorer').hidden = false;
  } else {
    $('wallet-sol-address').textContent = 'Not provisioned.';
    $('wallet-explorer').hidden = true;
  }

  if (evmAddr) {
    $('wallet-evm-address').textContent = evmAddr;
    $('wallet-evm-chain').textContent = chainId ? `Chain ${chainId}` : '—';
    const explorer = $('wallet-evm-explorer');
    explorer.href = chainId === 8453 ? `https://basescan.org/address/${evmAddr}` : `https://etherscan.io/address/${evmAddr}`;
    explorer.hidden = false;
  } else {
    $('wallet-evm-address').textContent = 'Not linked.';
    $('wallet-evm-chain').textContent = '—';
    $('wallet-evm-explorer').hidden = true;
  }

  const idParts = [];
  if (agentData.erc8004_agent_id) idParts.push(`ERC-8004 agent #${agentData.erc8004_agent_id} on chain ${chainId}`);
  const fname = meta.farcaster_fname || agentData.farcaster_fname;
  if (fname) idParts.push(`Farcaster: @${fname}`);
  if (agentData.registration_cid) idParts.push(`IPFS: ${agentData.registration_cid}`);
  if (agentData.x_username) idParts.push(`X: @${agentData.x_username}`);
  $('wallet-identity').innerHTML = idParts.length
    ? idParts.map(escapeHtml).join('<br>')
    : '<span class="muted">No on-chain registrations linked.</span>';

  await refreshBalances();
}

async function refreshBalances() {
  try {
    const r = await fetch(`${API_BASE}/portfolio/summary`, { credentials: 'include' });
    if (!r.ok) return;
    const j = await r.json();
    const mine = (j.wallets || []).filter((w) => w.agent_id === agentId);
    let solBal = null, usdcBal = null, totalUsd = 0;
    for (const w of mine) {
      totalUsd += Number(w.usd_total || 0);
      for (const a of (w.assets || [])) {
        if (w.chain === 'solana') {
          if (a.symbol === 'SOL') solBal = a;
          if (a.symbol === 'USDC') usdcBal = a;
        }
      }
    }
    $('wallet-sol-balance').textContent = solBal ? Number(solBal.amount).toFixed(4) : '0';
    $('wallet-usdc-balance').textContent = usdcBal ? Number(usdcBal.amount).toFixed(2) : '0';
    $('wallet-total-usd').textContent = `$${totalUsd.toFixed(2)}`;
  } catch {
    // Balance fetch is non-fatal — addresses are still useful.
  }
}

async function loadWalletActivity() {
  const el = $('wallet-activity');
  if (!walletInfo?.solAddr) {
    el.innerHTML = '<span class="muted">No Solana wallet.</span>';
    return;
  }
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}/solana/activity?limit=5`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const items = j.activity || [];
    if (!items.length) {
      el.innerHTML = '<span class="muted">No recent activity.</span>';
      return;
    }
    el.innerHTML = items.map((it) => {
      const date = it.blockTime ? new Date(it.blockTime * 1000).toLocaleDateString() : '';
      const delta = it.lamportDelta != null ? `${(it.lamportDelta / 1e9).toFixed(4)} SOL` : '';
      return `<div class="pay-item"><span>${escapeHtml(it.summary || it.signature?.slice(0, 8) || 'tx')} · ${escapeHtml(date)}</span><span>${escapeHtml(delta)}</span></div>`;
    }).join('');
  } catch {
    el.innerHTML = `<span class="muted">Activity unavailable.</span>`;
  }
}

function copyToClipboard(text) {
  return navigator.clipboard.writeText(text).catch(() => {});
}

$('wallet-copy-sol').addEventListener('click', () => walletInfo?.solAddr && copyToClipboard(walletInfo.solAddr));
$('wallet-evm-copy').addEventListener('click', () => walletInfo?.evmAddr && copyToClipboard(walletInfo.evmAddr));

$('wallet-send-btn').addEventListener('click', () => {
  if (!walletInfo?.solAddr) { alert('Solana wallet not provisioned yet.'); return; }
  $('send-modal').hidden = false;
});

$('send-cancel').addEventListener('click', () => { $('send-modal').hidden = true; });

$('send-confirm').addEventListener('click', async () => {
  const status = $('send-status');
  const asset = $('send-asset').value;
  const to = $('send-to').value.trim();
  const amount = parseFloat($('send-amount').value);
  if (!to || !(amount > 0)) {
    status.textContent = 'Recipient and positive amount required.';
    status.className = 'form-status err';
    return;
  }
  if (!confirm(`Send ${amount} ${asset.toUpperCase()} to ${to}?`)) return;
  status.textContent = 'Sending…';
  status.className = 'form-status';
  try {
    const r = await fetch(`${API_BASE}/portfolio/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ agent_id: agentId, chain: 'solana', asset, to, amount: amount.toString() }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    status.textContent = `Sent. tx ${j.signature?.slice(0, 8) || ''}…`;
    status.className = 'form-status ok';
    $('send-to').value = '';
    $('send-amount').value = '';
    refreshBalances();
    setTimeout(() => { $('send-modal').hidden = true; status.textContent = ''; }, 2500);
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
});

$('wallet-fund-btn').addEventListener('click', () => {
  if (!walletInfo?.solAddr) { alert('Solana wallet not provisioned yet.'); return; }
  $('fund-address').textContent = walletInfo.solAddr;
  $('fund-qr').src = `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(walletInfo.solAddr)}`;
  $('fund-modal').hidden = false;
});
$('fund-close').addEventListener('click', () => { $('fund-modal').hidden = true; });
$('fund-copy').addEventListener('click', () => walletInfo?.solAddr && copyToClipboard(walletInfo.solAddr));

// ─────────────────────────────────────────────────────────────────────────────
// Social (X) tab
// ─────────────────────────────────────────────────────────────────────────────

let socialTabMounted = false;
let xConnection = null;

async function ensureSocialTab() {
  if (socialTabMounted) return;
  socialTabMounted = true;

  $('x-username').value = agentData.x_username || '';
  await Promise.all([loadXStatus(), loadXTriggers()]);

  const params = new URLSearchParams(location.search);
  const xParam = params.get('x');
  if (xParam === 'connected') {
    $('x-post-status').textContent = 'X connected.';
    $('x-post-status').className = 'form-status ok';
  } else if (xParam === 'error' || xParam === 'denied') {
    $('x-post-status').textContent = `X connect failed (${xParam}).`;
    $('x-post-status').className = 'form-status err';
  }
}

async function loadXStatus() {
  const el = $('x-status');
  try {
    const r = await fetch(`${API_BASE}/x/status`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    xConnection = await r.json();
    renderXStatus();
  } catch (err) {
    el.textContent = `Could not load status: ${err.message}`;
  }
}

function renderXStatus() {
  const el = $('x-status');
  const connectBtn = $('x-connect-btn');
  const disconnectBtn = $('x-disconnect-btn');
  if (!xConnection?.connected) {
    el.textContent = 'Not connected.';
    connectBtn.hidden = false;
    disconnectBtn.hidden = true;
    return;
  }
  el.innerHTML = `Connected as <strong>@${escapeHtml(xConnection.username)}</strong> · ${xConnection.posts_used}/${xConnection.quota} posts this month`;
  connectBtn.hidden = true;
  disconnectBtn.hidden = false;
}

$('x-connect-btn').addEventListener('click', () => {
  location.href = `${API_BASE}/auth/x/connect?agent_id=${encodeURIComponent(agentId)}`;
});

$('x-disconnect-btn').addEventListener('click', async () => {
  if (!confirm('Disconnect X account?')) return;
  try {
    const r = await fetch(`${API_BASE}/x/status`, { method: 'DELETE', credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await loadXStatus();
  } catch (err) {
    alert(`Disconnect failed: ${err.message}`);
  }
});

$('x-username-save').addEventListener('click', async () => {
  const val = $('x-username').value.trim().replace(/^@/, '') || null;
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ x_username: val }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    agentData.x_username = val;
    $('x-post-status').textContent = 'Handle saved.';
    $('x-post-status').className = 'form-status ok';
  } catch (err) {
    $('x-post-status').textContent = `Error: ${err.message}`;
    $('x-post-status').className = 'form-status err';
  }
});

async function loadXTriggers() {
  const container = $('x-triggers-list');
  try {
    const r = await fetch(`${API_BASE}/x/triggers`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const mine = (j.triggers || []).filter((t) => !t.agent_id || t.agent_id === agentId);
    renderXTriggers(mine);
  } catch (err) {
    container.innerHTML = `<div class="muted">Could not load triggers: ${escapeHtml(err.message)}</div>`;
  }
}

function defaultTriggerConfig(kind) {
  if (kind === 'daily_persona') return { hour_utc: 14, topic: '' };
  if (kind === 'weekly_digest') return { day_of_week: 1, hour_utc: 14 };
  if (kind === 'price_milestone') return { thresholds_usd: [10, 100, 1000] };
  if (kind === 'payment_received') return { min_amount_usd: 1 };
  return {};
}

function triggerLabel(kind) {
  return {
    daily_persona: 'Daily persona post',
    weekly_digest: 'Weekly digest',
    price_milestone: 'Price milestone',
    payment_received: 'Payment received',
  }[kind] || kind;
}

function renderXTriggers(rows) {
  const container = $('x-triggers-list');
  if (!rows.length) {
    container.innerHTML = '<div class="muted">No triggers yet.</div>';
    return;
  }
  container.innerHTML = rows.map((t) => {
    const cfg = t.config || {};
    let body = '';
    if (t.kind === 'daily_persona') {
      body = `<label>Hour (UTC): <input type="number" min="0" max="23" data-cfg="hour_utc" value="${cfg.hour_utc ?? 14}"></label>
        <label>Topic: <input type="text" data-cfg="topic" value="${escapeHtml(cfg.topic || '')}" placeholder="optional"></label>`;
    } else if (t.kind === 'weekly_digest') {
      body = `<label>Day: <select data-cfg="day_of_week">
        ${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((d, i) => `<option value="${i}" ${cfg.day_of_week === i ? 'selected' : ''}>${d}</option>`).join('')}
      </select></label>
      <label>Hour (UTC): <input type="number" min="0" max="23" data-cfg="hour_utc" value="${cfg.hour_utc ?? 14}"></label>`;
    } else if (t.kind === 'price_milestone') {
      body = `<label>Thresholds (USD, comma-separated): <input type="text" data-cfg="thresholds_usd" value="${(cfg.thresholds_usd || []).join(', ')}"></label>`;
    } else if (t.kind === 'payment_received') {
      body = `<label>Min amount (USD): <input type="number" min="0" step="0.01" data-cfg="min_amount_usd" value="${cfg.min_amount_usd ?? 1}"></label>`;
    }
    return `
      <div class="trigger-item" data-id="${escapeHtml(t.id)}">
        <div class="trigger-item-head">
          <div class="trigger-item-kind">${escapeHtml(triggerLabel(t.kind))}</div>
          <label style="display:inline-flex;align-items:center;gap:.5rem;font-size:.764rem;color:rgba(255,255,255,.6)">
            <input type="checkbox" class="trigger-enabled" ${t.enabled ? 'checked' : ''}> Enabled
          </label>
          <label style="display:inline-flex;align-items:center;gap:.5rem;font-size:.764rem;color:rgba(255,255,255,.6)" title="If off, fired triggers queue as drafts instead of posting automatically.">
            <input type="checkbox" class="trigger-auto" ${t.auto_publish !== false ? 'checked' : ''}> Auto-publish
          </label>
          <button class="chip-remove" data-del="${escapeHtml(t.id)}" title="Delete">×</button>
        </div>
        <div class="trigger-item-body">${body}</div>
        <div class="form-actions" style="margin-top:.5rem">
          <button class="btn-ghost trigger-save">Save</button>
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.trigger-item').forEach((item) => {
    const id = item.dataset.id;
    item.querySelector('[data-del]').addEventListener('click', () => deleteTrigger(id));
    item.querySelector('.trigger-save').addEventListener('click', () => saveTrigger(item, id));
    item.querySelector('.trigger-enabled').addEventListener('change', (e) => patchTrigger(id, { enabled: e.target.checked }));
    item.querySelector('.trigger-auto').addEventListener('change', (e) => patchTrigger(id, { auto_publish: e.target.checked }));
  });
}

function readTriggerConfig(item) {
  const cfg = {};
  item.querySelectorAll('[data-cfg]').forEach((el) => {
    const key = el.dataset.cfg;
    let val = el.value;
    if (el.type === 'number') val = Number(val);
    if (key === 'thresholds_usd') val = val.split(',').map((n) => Number(n.trim())).filter((n) => n > 0);
    if (key === 'day_of_week') val = Number(val);
    cfg[key] = val;
  });
  return cfg;
}

async function saveTrigger(item, id) {
  const cfg = readTriggerConfig(item);
  try {
    const r = await fetch(`${API_BASE}/x/triggers?id=${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ config: cfg }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
  } catch (err) {
    alert(`Save failed: ${err.message}`);
  }
}

async function patchTrigger(id, body) {
  await fetch(`${API_BASE}/x/triggers?id=${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
}

async function deleteTrigger(id) {
  if (!confirm('Delete this trigger?')) return;
  await fetch(`${API_BASE}/x/triggers?id=${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
  await loadXTriggers();
}

$('x-trigger-add').addEventListener('click', async () => {
  const kind = $('x-trigger-kind').value;
  const config = defaultTriggerConfig(kind);
  try {
    const r = await fetch(`${API_BASE}/x/triggers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ kind, config, agent_id: agentId, enabled: true }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    await loadXTriggers();
  } catch (err) {
    alert(`Add trigger failed: ${err.message}`);
  }
});

$('x-post-btn').addEventListener('click', async () => {
  const status = $('x-post-status');
  const text = $('x-post-text').value.trim();
  if (!text) {
    status.textContent = 'Tweet text required.';
    status.className = 'form-status err';
    return;
  }
  status.textContent = 'Posting…';
  status.className = 'form-status';
  try {
    const r = await fetch(`${API_BASE}/x/post`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text, agent_id: agentId }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    status.textContent = `Posted (${j.tweet_id || 'ok'}).`;
    status.className = 'form-status ok';
    $('x-post-text').value = '';
    loadXStatus();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Analytics tab
// ─────────────────────────────────────────────────────────────────────────────

let analyticsTabMounted = false;

async function ensureAnalyticsTab() {
  if (analyticsTabMounted) return;
  analyticsTabMounted = true;
  await Promise.all([loadUsage(), loadPayments('received'), loadPayments('sent')]);
}

async function loadUsage() {
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}/usage`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    $('m-llm-month').textContent = String(j.currentMonthCalls ?? 0);
    const daily = j.dailyBreakdown || [];
    const total30 = daily.reduce((sum, d) => sum + (d.calls || 0), 0);
    $('m-llm-30d').textContent = String(total30);
    renderBarChart(daily);
  } catch (err) {
    $('m-llm-month').textContent = '—';
    $('m-llm-30d').textContent = '—';
    $('m-chart').innerHTML = `<div class="muted">Usage unavailable: ${escapeHtml(err.message)}</div>`;
  }
}

function renderBarChart(daily) {
  const container = $('m-chart');
  const byDay = new Map(daily.map((d) => [String(d.day).slice(0, 10), d.calls]));
  const cols = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    cols.push({ key, calls: byDay.get(key) || 0 });
  }
  const max = Math.max(1, ...cols.map((c) => c.calls));
  container.innerHTML = cols.map((c) => {
    const h = Math.round((c.calls / max) * 100);
    return `<div class="bar-chart-col" data-value="${c.calls}" style="height:${h}%" title="${c.key}: ${c.calls}"></div>`;
  }).join('');
}

async function loadPayments(direction) {
  const el = direction === 'received' ? $('m-pay-in') : $('m-pay-out');
  const totalEl = direction === 'received' ? $('m-earn-in') : $('m-earn-out');
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}/payments?direction=${direction}&limit=10`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const rows = j.payments || j.data || [];
    let total = 0;
    rows.forEach((p) => { total += Number(p.amount_wei || 0) / 1e6; });
    totalEl.textContent = `$${total.toFixed(2)}`;
    if (!rows.length) { el.innerHTML = '<div class="muted">None yet.</div>'; return; }
    el.innerHTML = rows.slice(0, 10).map((p) => {
      const amt = (Number(p.amount_wei || 0) / 1e6).toFixed(2);
      const who = direction === 'received' ? (p.payer_name || p.payer_agent_id?.slice(0, 8)) : (p.payee_name || p.payee_agent_id?.slice(0, 8));
      const skill = p.skill_name || p.skill_slug || '';
      return `<div class="pay-item"><span>${escapeHtml(who || 'someone')}${skill ? ` · ${escapeHtml(skill)}` : ''}</span><span class="pay-amount${direction === 'sent' ? ' out' : ''}">$${amt}</span></div>`;
    }).join('');
  } catch {
    el.innerHTML = `<div class="muted">Unavailable.</div>`;
    totalEl.textContent = '—';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Embed tab
// ─────────────────────────────────────────────────────────────────────────────

let embedTabMounted = false;

function embedOrigin() {
  return location.origin;
}

function ensureEmbedTab() {
  if (embedTabMounted) return;
  embedTabMounted = true;
  updateEmbedPreview();
  loadEmbedPolicy();
}

function parseSize(token) {
  const [w, h] = token.split('x');
  return { w, h };
}

function updateEmbedPreview() {
  const { w, h } = parseSize($('embed-size').value);
  const origin = embedOrigin();
  const embedUrl = `${origin}/agent/${agentId}/embed`;
  const pageUrl = `${origin}/agent/${agentId}`;
  const oembedUrl = `${origin}/api/oembed?url=${encodeURIComponent(pageUrl)}`;

  const iframeAttrs = `src="${embedUrl}" width="${w}" height="${h}" frameborder="0" allow="microphone; autoplay; clipboard-write" style="border:0;border-radius:12px;background:#000"`;
  $('embed-iframe-code').value = `<iframe ${iframeAttrs}></iframe>`;
  $('embed-link').value = pageUrl;
  $('embed-oembed').value = oembedUrl;
  $('embed-open').href = pageUrl;

  $('embed-preview').innerHTML = `<iframe ${iframeAttrs}></iframe>`;
}

async function loadEmbedPolicy() {
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}/embed-policy`, { credentials: 'include' });
    if (!r.ok) return;
    const j = await r.json();
    const origins = j.policy?.allowed_origins || [];
    $('embed-allowed-origins').value = origins.join('\n');
  } catch {
    // Policy is optional — silent.
  }
}

$('embed-size').addEventListener('change', updateEmbedPreview);

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const target = document.querySelector(btn.dataset.copy);
  if (!target) return;
  copyToClipboard(target.value);
  const original = btn.textContent;
  btn.textContent = 'Copied';
  setTimeout(() => { btn.textContent = original; }, 1200);
});

$('embed-policy-save').addEventListener('click', async () => {
  const status = $('embed-policy-status');
  const origins = $('embed-allowed-origins').value.split('\n').map((s) => s.trim()).filter(Boolean);
  status.textContent = 'Saving…';
  status.className = 'form-status';
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}/embed-policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ allowed_origins: origins }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    status.textContent = 'Saved.';
    status.className = 'form-status ok';
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
});

$('embed-policy-clear').addEventListener('click', async () => {
  if (!confirm('Clear embed policy (allow embedding everywhere)?')) return;
  const status = $('embed-policy-status');
  status.textContent = 'Clearing…';
  status.className = 'form-status';
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}/embed-policy`, { method: 'DELETE', credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    $('embed-allowed-origins').value = '';
    status.textContent = 'Cleared.';
    status.className = 'form-status ok';
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Widgets tab
// ─────────────────────────────────────────────────────────────────────────────

let widgetsTabMounted = false;

async function ensureWidgetsTab() {
  if (widgetsTabMounted) return;
  widgetsTabMounted = true;
  await loadWidgets();
}

async function loadWidgets() {
  const container = $('widgets-list');
  try {
    const r = await fetch(`${API_BASE}/widgets`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const items = j.widgets || [];
    if (!items.length) {
      container.innerHTML = '<div class="muted">No widgets yet. Create one above.</div>';
      return;
    }
    container.innerHTML = items.map((w) => {
      const url = `${embedOrigin()}/w/${encodeURIComponent(w.id)}`;
      return `
        <div class="widget-card" data-id="${escapeHtml(w.id)}">
          <div class="widget-card-type">${escapeHtml(w.type)}</div>
          <div class="widget-card-name">${escapeHtml(w.name || 'Untitled')}</div>
          <div class="widget-card-meta">${w.view_count || 0} views · ${w.is_public ? 'public' : 'private'}</div>
          <div class="form-actions">
            <a class="btn-ghost" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open ›</a>
            <button class="btn-ghost" data-copy-text="${escapeHtml(url)}">Copy link</button>
            <button class="btn-ghost danger" data-del-widget="${escapeHtml(w.id)}">Delete</button>
          </div>
        </div>
      `;
    }).join('');
    container.querySelectorAll('[data-del-widget]').forEach((btn) => {
      btn.addEventListener('click', () => deleteWidget(btn.dataset.delWidget));
    });
    container.querySelectorAll('[data-copy-text]').forEach((btn) => {
      btn.addEventListener('click', () => {
        copyToClipboard(btn.dataset.copyText);
        const t = btn.textContent;
        btn.textContent = 'Copied';
        setTimeout(() => { btn.textContent = t; }, 1200);
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="muted">Could not load widgets: ${escapeHtml(err.message)}</div>`;
  }
}

$('widget-new-btn').addEventListener('click', async () => {
  const status = $('widget-status');
  const type = $('widget-new-type').value;
  const name = $('widget-new-name').value.trim() || `${agentData.name || 'Agent'} ${type}`;
  if (!agentData.avatar_id) {
    status.textContent = 'Pick an avatar first (Outfit tab).';
    status.className = 'form-status err';
    return;
  }
  status.textContent = 'Creating…';
  status.className = 'form-status';
  try {
    const r = await fetch(`${API_BASE}/widgets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ type, name, avatar_id: agentData.avatar_id, config: { agent_id: agentId }, is_public: true }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    $('widget-new-name').value = '';
    status.textContent = 'Created.';
    status.className = 'form-status ok';
    await loadWidgets();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
});

async function deleteWidget(id) {
  if (!confirm('Delete this widget?')) return;
  try {
    const r = await fetch(`${API_BASE}/widgets/${id}`, { method: 'DELETE', credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await loadWidgets();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Studio tab
// ─────────────────────────────────────────────────────────────────────────────

let studioTabMounted = false;

function ensureStudioTab() {
  if (studioTabMounted) return;
  studioTabMounted = true;
  const origin = embedOrigin();
  $('studio-playground').href = `/playground?agent_id=${encodeURIComponent(agentId)}`;
  $('studio-avatar').href = agentData.avatar_id ? `/avatars/${encodeURIComponent(agentData.avatar_id)}` : '/dashboard/#avatars';
  $('studio-public').href = `/agent/${agentId}`;
  $('studio-manifest').href = `${origin}/api/agents/${agentId}/manifest`;

  const anims = agentData.meta?.animations || [];
  const animsEl = $('studio-animations');
  if (!anims.length) {
    animsEl.innerHTML = '<div class="muted">No animations attached.</div>';
  } else {
    animsEl.innerHTML = anims.map((a) => `<span class="chip">${escapeHtml(a.name)}${a.source ? ` <span class="voice-tile-meta">(${escapeHtml(a.source)})</span>` : ''}</span>`).join('');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Danger zone
// ─────────────────────────────────────────────────────────────────────────────

$('danger-confirm').addEventListener('input', (e) => {
  $('danger-delete-btn').disabled = !agentData?.name || e.target.value.trim() !== agentData.name.trim();
});

$('danger-delete-btn').addEventListener('click', async () => {
  const status = $('danger-status');
  if ($('danger-confirm').value.trim() !== agentData.name) {
    status.textContent = 'Name does not match.';
    status.className = 'form-status err';
    return;
  }
  status.textContent = 'Deleting…';
  status.className = 'form-status';
  try {
    const r = await fetch(`${API_BASE}/agents/${agentId}`, { method: 'DELETE', credentials: 'include' });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    status.textContent = 'Deleted. Redirecting…';
    status.className = 'form-status ok';
    setTimeout(() => location.replace('/dashboard/'), 1000);
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Tab switching
// ─────────────────────────────────────────────────────────────────────────────

const TAB_LOADERS = {
  outfit: ensureOutfitTab,
  voice: ensureVoiceTab,
  knowledge: ensureKnowledgeTab,
  skills: ensureSkillsTab,
  wallet: ensureWalletTab,
  social: ensureSocialTab,
  analytics: ensureAnalyticsTab,
  embed: ensureEmbedTab,
  widgets: ensureWidgetsTab,
  studio: ensureStudioTab,
};

function activateTab(tabId) {
  document.querySelectorAll('.edit-tab').forEach((t) => {
    const active = t.dataset.tab === tabId;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.edit-panel').forEach((p) => {
    const active = p.id === `panel-${tabId}`;
    p.classList.toggle('active', active);
    if (active) p.removeAttribute('hidden');
    else p.setAttribute('hidden', '');
  });
  if (agentData && TAB_LOADERS[tabId]) TAB_LOADERS[tabId]();
}

document.querySelectorAll('.edit-tab').forEach((tab) => {
  tab.addEventListener('click', (e) => activateTab(e.currentTarget.dataset.tab));
});

// Open a specific tab via ?tab=… (used by OAuth callback redirects).
async function init() {
  await loadAgent();
  if (!agentData) return;
  const params = new URLSearchParams(location.search);
  const initialTab = params.get('tab');
  if (initialTab && document.getElementById(`panel-${initialTab}`)) {
    activateTab(initialTab);
  }
}

init();
