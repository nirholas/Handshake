import { AvatarCreator } from './avatar-creator.js';
import { saveRemoteGlbToAccount } from './account.js';
import { apiFetch } from './api.js';
import { openAvatarPicker } from './avatar-gallery-picker.js';
import { walletChipHTML, wireWalletChips } from './shared/agent-wallet-chip.js';
import { log } from './shared/log.js';
import { isValidGlbMagic } from './shared/glb-magic.js';
import { agentBus } from './agents/agent-bus.js';
import { mountAutopilotMind } from './autopilot-mind.js';
import { mountMoodInspector } from './agents/mood-inspector.js';
import { SLOTS, DEFAULT_ANIMATION_MAP } from './runtime/animation-slots.js';
// Boot the mood engine + embodiment so the edit-page avatar reflects mood live.
import './agents/mood-embodiment.js';

const API_BASE = '/api';
const params = new URLSearchParams(location.search);

// Resolve agent id from the canonical clean URL /agent/<uuid>(/edit)?, falling
// back to the legacy /agent-edit.html?id=<uuid> querystring form. Kept as a
// `let` so it can be reassigned after the create-from-avatar flow mints a real
// agent — every fetch below uses this value, so the URL must stay the source
// of truth across both create and edit flows.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function resolveAgentIdFromUrl() {
  const seg = location.pathname.split('/').filter(Boolean);
  // /agent/<id>(/edit)?  →  seg = ['agent', '<id>', 'edit'?]
  if (seg[0] === 'agent' && seg[1] && UUID_RE.test(seg[1])) return seg[1];
  const qid = params.get('id');
  return qid && UUID_RE.test(qid) ? qid : null;
}
let agentId = resolveAgentIdFromUrl();

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
    await createDraftAgent();
    return;
  }
  try {
    const r = await apiFetch(`${API_BASE}/agents/${agentId}`, { credentials: 'include' });
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

async function createDraftAgent() {
  const fromAvatar = !!(initAvatarId || initAvatarGlb);
  showLoading(fromAvatar ? 'Creating agent…' : 'Creating a new agent…');
  try {
    const name = initAvatarName ? `${initAvatarName} Agent` : 'Untitled Agent';
    const createRes = await apiFetch(`${API_BASE}/agents`, {
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
      const patchRes = await apiFetch(`${API_BASE}/agents/${agent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ avatar_id: initAvatarId }),
      });
      if (!patchRes.ok) {
        log.warn('[agent-edit] avatar attach failed', patchRes.status);
      }
    }

    history.replaceState({}, '', `/agent/${agent.id}/edit`);
    agentId = agent.id;
    agentData = agent;
    if (initAvatarName) {
      agentData.name = name;
      agentData.system_prompt = agentData.system_prompt ||
        `You are ${initAvatarName}, a 3D avatar agent. Be helpful and engaging.`;
    }
    render();
    if (fromAvatar) {
      showBanner(`Agent created from "${initAvatarName || 'avatar'}" — fill in the details below.`);
    } else {
      showBanner('Draft agent created — give it a name and description to get started.');
      const nameField = $('f-name');
      if (nameField) { nameField.focus(); nameField.select(); }
    }
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
      'padding:10px 20px;background:rgba(255,255,255,.1);border-bottom:1px solid rgba(255,255,255,.25);' +
      'color:#ffffff;font-size:13px;font-weight:500;';
    document.body.prepend(el);
  }
  el.textContent = msg;
}

function render() {
  $('loading').hidden = true;
  $('agent-title').textContent = `Edit Agent: ${agentData.name || 'Untitled'}`;
  $('back-link').href = `/agents/${agentData.id}`;
  renderHeaderWalletChip();

  // Reveal section nav and preview actions
  const secNav = $('section-nav');
  if (secNav) secNav.hidden = false;
  const previewActions = $('preview-actions');
  if (previewActions) {
    previewActions.style.display = 'flex';
    const viewLink = $('preview-view-link');
    const chatLink = $('preview-chat-link');
    if (viewLink) viewLink.href = `/agents/${agentData.id}`;
    if (chatLink) chatLink.href = `/agents/${agentData.id}`;
  }

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

  // Mount all sections eagerly now that agent data is available
  initAllSections();

  // Wire sticky section-nav active highlight
  initSectionNavHighlight();
}

function initAllSections() {
  // These are all idempotent (each has a mounted guard)
  ensureOutfitTab();
  ensureVoiceTab();
  ensureKnowledgeTab();
  ensureBrainTab();
  ensureMindTab();
  ensureOwnershipTab();
  ensureDreamsTab();
  ensureSkillsTab();
  ensureAutopilotTab();
  ensureEmbedTab();
  ensureWidgetsTab();
  ensureSocialTab();
  ensureAnalyticsTab();
  ensureStudioTab();
  ensureWalletTab();
  if (!plansLoaded) loadSubscriptionPlans();
}

function initSectionNavHighlight() {
  const contentCol = document.querySelector('.content-col');
  const sections = document.querySelectorAll('.edit-section');
  const links = document.querySelectorAll('.snav-link');
  if (!contentCol || !sections.length || !links.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const id = entry.target.id; // e.g. "section-identity"
      const key = id.replace('section-', '');
      const link = document.querySelector(`.snav-link[href="#${id}"]`);
      if (link) link.classList.toggle('active', entry.isIntersecting);
    });
  }, {
    root: contentCol,
    threshold: 0.15,
  });

  sections.forEach((s) => observer.observe(s));
}

// Render the shared custodial-wallet chip in the edit header. This page is the
// owner's own agent (the GET above 401s anyone who isn't signed in, and the
// record carries an authoritative `is_owner` flag), so the chip shows the owner
// affordances — the "✦ Vanity" entry point routes to the wallet hub where the
// money-safe grind/swap lives. We never inline withdraw/launch UI here.
function renderHeaderWalletChip() {
  const header = document.querySelector('.edit-header');
  if (!header) return;
  let host = $('agent-wallet-chip');
  if (!host) {
    host = document.createElement('div');
    host.id = 'agent-wallet-chip';
    host.className = 'edit-header-wallet';
    header.appendChild(host);
  }
  // showPending so the header always communicates that every agent has a wallet,
  // even in the brief window before provisioning completes.
  host.innerHTML = walletChipHTML(agentData, {
    isOwner: !!agentData.is_owner,
    showPending: true,
    link: true,
  });
  wireWalletChips(host);
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
    const pricingType = isPaid && price.pricing_type === 'pwyw' ? 'pwyw' : 'fixed';
    const isPwyw = pricingType === 'pwyw';
    const minimum = isPwyw && price.minimum_amount != null
      ? (Number(price.minimum_amount) / 1e6).toFixed(2)
      : '';

    return `
      <div class="skill-item" data-skill-name="${escapeHtml(skillName)}">
        <span class="skill-name">${escapeHtml(skillName)}</span>
        <div class="skill-pricing-controls">
          <label class="toggle-switch">
            <input type="checkbox" class="price-toggle" ${isPaid ? 'checked' : ''}>
            <span class="slider"></span>
          </label>
          <div class="price-input-wrapper" style="display: ${isPaid ? 'flex' : 'none'}; flex-direction:column; align-items:flex-start; gap:8px;">
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <label class="pricing-type-field" style="font-size:12px;color:#a1a1aa;white-space:nowrap">
                Pricing:
                <select class="pricing-type-select" aria-label="Pricing model for ${escapeHtml(skillName)}" style="margin-left:4px">
                  <option value="fixed" ${isPwyw ? '' : 'selected'}>Fixed price</option>
                  <option value="pwyw" ${isPwyw ? 'selected' : ''}>Pay what you want</option>
                </select>
              </label>
            </div>
            <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
              <label class="price-field" style="display:flex;align-items:center;gap:6px">
                <span class="price-field-label" style="font-size:12px;color:#a1a1aa;white-space:nowrap">${isPwyw ? 'Suggested:' : 'Price:'}</span>
                <input type="number" class="price-input" min="0" step="0.01" placeholder="0.50" value="${amount}" aria-label="${isPwyw ? 'Suggested' : 'Price'} for ${escapeHtml(skillName)} in USDC">
              </label>
              <label class="min-field" style="display:${isPwyw ? 'flex' : 'none'};align-items:center;gap:6px">
                <span style="font-size:12px;color:#a1a1aa;white-space:nowrap">Minimum:</span>
                <input type="number" class="min-amount-input" min="0" step="0.01" placeholder="0.00" value="${minimum}" aria-label="Minimum amount for ${escapeHtml(skillName)} in USDC">
              </label>
              <span>USDC</span>
              <label style="font-size:12px;color:#a1a1aa;margin-left:8px;white-space:nowrap">
                Free trials:
                <input type="number" class="trial-uses-input" min="0" max="10" step="1" placeholder="0" value="${trialUses}" style="width:52px;margin-left:4px" aria-label="Free trial uses for ${escapeHtml(skillName)}">
              </label>
            </div>
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

  // Toggle the minimum-amount field + suggested/price label when the creator
  // switches a skill between Fixed and Pay-what-you-want.
  container.querySelectorAll('.pricing-type-select').forEach(select => {
    select.addEventListener('change', (e) => {
      const controls = e.target.closest('.price-input-wrapper');
      const minField = controls.querySelector('.min-field');
      const priceLabel = controls.querySelector('.price-field-label');
      const isPwyw = e.target.value === 'pwyw';
      if (minField) minField.style.display = isPwyw ? 'flex' : 'none';
      if (priceLabel) priceLabel.textContent = isPwyw ? 'Suggested:' : 'Price:';
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
  const candidates = [
    'https://three.ws/agent-3d/latest/agent-3d.js',
    '/agent-3d/latest/agent-3d.js',
    '/dist-lib/agent-3d.js',
  ];
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

  // Show animation graph skeleton immediately so the section isn't a blank
  // void while the library loads. It'll be repopulated by renderAnimationsPicker.
  renderAnimGraphSkeleton();

  await ensureAgent3DLib();
  const preview = $('outfit-preview');
  const a3d = document.createElement('agent-3d');
  a3d.setAttribute('agent-id', agentId);
  a3d.setAttribute('controls', 'orbit');
  a3d.style.cssText = 'width:100%;height:100%;display:block';
  preview.innerHTML = '';
  preview.appendChild(a3d);

  await Promise.all([renderAvatarList(), renderAnimationsPicker()]);
}

async function renderAvatarList() {
  const container = $('avatar-picker-list');
  container.textContent = 'Loading avatars…';
  try {
    const r = await apiFetch(`${API_BASE}/avatars?limit=50`, { credentials: 'include' });
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
    <button type="button" role="menuitem" data-source="gallery">
      <span class="acm-title">Browse public gallery</span>
      <span class="acm-sub">Pick from community avatars</span>
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
      if (src === 'gallery') {
        openGalleryPicker();
      } else {
        startAvatarCreate(src);
      }
    });
  });
}

async function openGalleryPicker() {
  const picked = await openAvatarPicker({
    source: 'both',
    title: 'Choose an avatar for this agent',
    selectedId: agentData?.avatar_id || '',
    showModes: false,
    ctaLabel: 'Use this avatar',
  });
  if (picked) {
    await selectAvatar(picked.id);
  }
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
      if (!(await isValidGlbMagic(file))) {
        const status = $('outfit-status');
        if (status) { status.textContent = 'Not a valid GLB file (bad header).'; status.className = 'outfit-status err'; }
        return;
      }
      const name = file.name.replace(/\.glb$/i, '').trim() || 'My Avatar';
      await saveNewAvatarAndSelect(file, { provider: 'upload', name });
    });
  }
  input.click();
}

let _uploadController = null;

async function saveNewAvatarAndSelect(blob, meta = {}) {
  // Cancel any in-flight upload before starting a new one.
  if (_uploadController) _uploadController.abort();
  _uploadController = new AbortController();
  const { signal } = _uploadController;

  const status = $('outfit-status');
  const cancelBtn = $('outfit-cancel');

  const setStatus = (text, cls = 'outfit-status saving') => {
    if (status) { status.textContent = text; status.className = cls; }
  };
  const onProgress = (pct) => {
    if (status && !signal.aborted) status.textContent = `Uploading… ${pct}%`;
  };

  setStatus('Saving avatar…');
  if (cancelBtn) cancelBtn.hidden = false;

  try {
    const provider = meta.provider || 'upload';
    const source = provider === 'avaturn' ? 'avaturn' : provider === 'upload' ? 'upload' : 'import';
    const source_meta = { provider, ...(meta.sourceUrl ? { source_url: meta.sourceUrl } : {}) };
    const avatar = await saveRemoteGlbToAccount(blob, {
      source,
      source_meta,
      name: meta.name,
    }, { signal, onProgress });
    setStatus('Attaching to agent…');
    await selectAvatar(avatar.id);
    if (!availableAvatars.some((a) => a.id === avatar.id)) {
      availableAvatars = [avatar, ...availableAvatars];
      await renderAvatarList();
    }
    setStatus('', 'outfit-status');
  } catch (err) {
    if (err?.name === 'AbortError' || signal.aborted) {
      setStatus('Upload cancelled.', 'outfit-status');
    } else {
      setStatus(`Error: ${err.message || 'Failed to save avatar.'}`, 'outfit-status err');
    }
  } finally {
    if (cancelBtn) cancelBtn.hidden = true;
    _uploadController = null;
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
      const raw = await r.json();
      // Deduplicate by name — a malformed manifest with repeated clip names would
      // produce non-deterministic select behaviour in the animation graph picker.
      const seen = new Set();
      animationLibrary = raw.filter((a) => a?.name && !seen.has(a.name) && seen.add(a.name));
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
  renderAnimSlotsPicker();
}

function renderAnimGraphSkeleton() {
  const rows = $('anim-graph-rows');
  if (!rows) return;
  rows.innerHTML = ANIM_STATES.map((state) => {
    const def = ANIM_STATE_DEFAULT_CLIP[state];
    return `
      <div class="anim-graph-row" data-state="${state}">
        <span class="anim-graph-row-label">${state}</span>
        <select aria-label="Clip for ${state} state" disabled>
          <option>— loading —</option>
        </select>
        <span class="anim-graph-row-meta">default: ${def}</span>
      </div>
    `;
  }).join('');
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

// Warn before navigating away with unsaved animation graph changes.
window.addEventListener('beforeunload', (e) => {
  const dirty = ANIM_STATES.some((s) => animGraphState[s] !== originalAnimGraphState[s]) || animSlotsDirty();
  if (dirty) e.preventDefault();
});

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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/animations`, {
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

// ── Gesture slots ──────────────────────────────────────────────────────────
// The agent's own bindings for the fixed gesture vocabulary, stored at
// meta.edits.animations and applied by src/agent-avatar.js. Same shape as the
// animation-state picker above: one row per slot, "Platform default" inherits the
// platform clip, and only real overrides are sent.

let animSlotState = {};
let originalAnimSlotState = {};

function renderAnimSlotsPicker() {
  const rows = $('anim-slots-rows');
  const saveBtn = $('anim-slots-save');
  if (!rows) return;

  const saved = agentData.meta?.edits?.animations || {};
  animSlotState = {};
  for (const slot of SLOTS) animSlotState[slot] = saved[slot] ?? '';
  originalAnimSlotState = { ...animSlotState };

  rows.innerHTML = SLOTS.map((slot) => {
    const def = DEFAULT_ANIMATION_MAP[slot];
    const options = ['<option value="">Platform default</option>']
      .concat(
        animationLibrary.map((a) => {
          const sel = animSlotState[slot] === a.name ? ' selected' : '';
          return `<option value="${escapeHtml(a.name)}"${sel}>${escapeHtml(a.label || a.name)}</option>`;
        }),
      )
      .join('');
    return `
      <div class="anim-graph-row" data-slot="${escapeHtml(slot)}">
        <span class="anim-graph-row-label">${escapeHtml(slot)}</span>
        <select aria-label="Clip for the ${escapeHtml(slot)} gesture">${options}</select>
        <span class="anim-graph-row-meta">default: ${escapeHtml(def)}</span>
      </div>
    `;
  }).join('');

  rows.querySelectorAll('.anim-graph-row').forEach((row) => {
    const slot = row.dataset.slot;
    const select = row.querySelector('select');
    select.addEventListener('change', () => {
      animSlotState[slot] = select.value;
      updateAnimSlotsSaveButton();
    });
  });

  if (saveBtn && !saveBtn.dataset.wired) {
    saveBtn.dataset.wired = '1';
    saveBtn.addEventListener('click', saveAnimationSlots);
  }
  updateAnimSlotsSaveButton();
}

function animSlotsDirty() {
  return SLOTS.some((s) => animSlotState[s] !== originalAnimSlotState[s]);
}

function updateAnimSlotsSaveButton() {
  const saveBtn = $('anim-slots-save');
  if (saveBtn) saveBtn.disabled = !animSlotsDirty();
}

/** { slot: clip } for real overrides only, so defaults stay inherited. */
function buildAnimSlotsPayload() {
  const out = {};
  for (const slot of SLOTS) {
    const clip = animSlotState[slot];
    if (clip && clip !== DEFAULT_ANIMATION_MAP[slot]) out[slot] = clip;
  }
  return out;
}

async function saveAnimationSlots() {
  const status = $('anim-slots-status');
  const saveBtn = $('anim-slots-save');
  if (!status || !saveBtn) return;

  // PUT /api/agents/:id/animations requires animations[] alongside the slots,
  // so re-send the current clip selection unchanged.
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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/animations`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ animations, animationSlots: buildAnimSlotsPayload() }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    const j = await r.json();
    if (!agentData.meta) agentData.meta = {};
    agentData.meta.animations = j.animations;
    agentData.meta.edits = { ...(agentData.meta.edits || {}), animations: j.animationSlots || {} };
    originalAnimSlotState = { ...animSlotState };
    const count = Object.keys(j.animationSlots || {}).length;
    status.textContent = count
      ? `Saved ${count} gesture override${count === 1 ? '' : 's'}.`
      : 'Cleared every gesture override.';
    status.className = 'form-status ok';
    reloadOutfitPreview();
    setTimeout(() => { status.textContent = ''; status.className = 'form-status'; }, 2500);
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  } finally {
    updateAnimSlotsSaveButton();
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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/animations`, {
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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}`, {
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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}`, {
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
    const r = await apiFetch(`${API_BASE}/marketplace/agents/${agentId}/publish`, {
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
      const parsed = parseFloat(input.value);
      if (Number.isNaN(parsed) || parsed <= 0) return;
      const trialInput = item.querySelector('.trial-uses-input');
      const trialUses = trialInput ? Math.max(0, Math.min(10, parseInt(trialInput.value || '0', 10) || 0)) : 0;
      const typeSelect = item.querySelector('.pricing-type-select');
      const pricingType = typeSelect && typeSelect.value === 'pwyw' ? 'pwyw' : 'fixed';
      const entry = {
        skill,
        amount: Math.round(parsed * 1e6),
        currency_mint: USDC_MINT,
        chain: 'solana',
        trial_uses: trialUses,
        pricing_type: pricingType,
      };
      if (pricingType === 'pwyw') {
        const minInput = item.querySelector('.min-amount-input');
        const minVal = minInput ? parseFloat(minInput.value || '0') : 0;
        entry.minimum_amount = Number.isNaN(minVal) || minVal < 0 ? 0 : Math.round(minVal * 1e6);
      }
      prices.push(entry);
    }
  });

  const status = $('monetization-status');
  try {
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/skills-pricing`, {
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
    const r = await apiFetch(`${API_BASE}/agent-strategy?id=${encodeURIComponent(agentId)}`, {
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
// Subscription Plans (Monetization tab)
// ─────────────────────────────────────────────────────────────────────────────

let plansLoaded = false;

function escHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function loadSubscriptionPlans() {
  const list = $('subscription-plans-list');
  if (!list) return;
  try {
    const r = await apiFetch(`${API_BASE}/subscriptions/plans?agent_id=${encodeURIComponent(agentId)}&include_inactive=1`, { credentials: 'include' });
    const j = await r.json().catch(() => ({}));
    const plans = j.plans || [];
    plansLoaded = true;
    renderPlansList(plans);
  } catch (err) {
    const list2 = $('subscription-plans-list');
    if (list2) list2.innerHTML = `<span class="muted">Could not load plans.</span>`;
  }
}

function renderPlansList(plans) {
  const list = $('subscription-plans-list');
  if (!list) return;
  if (!plans.length) {
    list.innerHTML = `<span class="muted" style="font-size:0.764rem;">No plans yet — create one below.</span>`;
    return;
  }
  list.innerHTML = plans.map(p => {
    const isActive = p.active !== false;
    const planJson = JSON.stringify(p).replace(/"/g, '&quot;');
    const action = isActive
      ? `<button class="btn-ghost danger" style="font-size:0.7rem; padding:0.25rem 0.6rem;" data-plan-action="deactivate" data-plan-id="${p.id}">Deactivate</button>`
      : `<button class="btn-ghost" style="font-size:0.7rem; padding:0.25rem 0.6rem; color:#86efac; border-color:rgba(134,239,172,0.4);" data-plan-action="reactivate" data-plan-id="${p.id}">Reactivate</button>`;
    return `
    <div class="plan-row" style="display:flex; align-items:center; justify-content:space-between; padding:0.5rem 0.75rem; border:1px solid rgba(255,255,255,${isActive ? '0.08' : '0.05'}); border-radius:6px; background:rgba(255,255,255,0.02); opacity:${isActive ? '1' : '0.6'};">
      <div>
        <span style="font-weight:600; font-size:0.875rem;">${escHtml(p.name)}</span>
        <span style="color:rgba(255,255,255,0.45); font-size:0.764rem; margin-left:0.5rem;">$${Number(p.price_usd).toFixed(2)} / ${p.interval}</span>
        ${isActive ? '' : `<span style="font-size:0.6rem; text-transform:uppercase; letter-spacing:0.05em; color:rgba(255,255,255,0.5); background:rgba(255,255,255,0.08); padding:0.1rem 0.4rem; border-radius:4px; margin-left:0.5rem;">Inactive</span>`}
        ${p.perks?.length ? `<div style="font-size:0.7rem; color:rgba(255,255,255,0.35); margin-top:0.15rem;">${escHtml(p.perks.join(' · '))}</div>` : ''}
        ${p.included_skills?.length ? `<div style="font-size:0.7rem; color:rgba(164,240,188,0.65); margin-top:0.15rem;">Includes ${p.included_skills.length} skill${p.included_skills.length === 1 ? '' : 's'}: ${escHtml(p.included_skills.join(' · '))}</div>` : ''}
      </div>
      <div style="display:flex; gap:0.4rem;">
        <button class="btn-ghost" style="font-size:0.7rem; padding:0.25rem 0.6rem;" data-plan-action="edit" data-plan="${planJson}">Edit</button>
        ${action}
      </div>
    </div>`;
  }).join('');

  // Rows are rendered from strings, so each action declares itself and one
  // delegated listener runs it. Inline onclick attributes do not survive the
  // site CSP, which allows inline <script> by hash and nothing else.
  list.onclick = (event) => {
    const btn = event.target.closest('[data-plan-action]');
    if (!btn) return;
    if (btn.dataset.planAction === 'edit') return openPlanEditor(JSON.parse(btn.dataset.plan));
    if (btn.dataset.planAction === 'deactivate') return deletePlan(btn.dataset.planId);
    if (btn.dataset.planAction === 'reactivate') reactivatePlan(btn.dataset.planId);
  };
}

// Skill names available on this agent (skills may be strings or {name} objects).
function planSkillNames() {
  return (agentData.skills || [])
    .map((s) => (typeof s === 'string' ? s : s?.name))
    .filter(Boolean);
}

// Render the agent's skills as a checklist inside the plan editor, pre-checking
// the ones already bundled into the plan being edited.
function renderPlanSkillsChecklist(selected = []) {
  const host = $('plan-skills-checklist');
  if (!host) return;
  const selectedSet = new Set(selected);
  const names = planSkillNames();
  if (!names.length) {
    host.innerHTML = `<span class="plan-skills-empty">This agent has no skills yet. Add skills in the Skills tab to bundle them into a plan.</span>`;
    return;
  }
  host.innerHTML = names.map((name) => `
    <label class="plan-skill-check">
      <input type="checkbox" value="${escHtml(name)}" ${selectedSet.has(name) ? 'checked' : ''}>
      <span>${escHtml(name)}</span>
    </label>`).join('');
}

function openPlanEditor(plan) {
  const editor = $('plan-editor');
  if (!editor) return;
  $('plan-editor-id').value = plan?.id ?? '';
  $('plan-name-input').value = plan?.name ?? '';
  $('plan-price-input').value = plan?.price_usd ?? '';
  $('plan-interval-input').value = plan?.interval ?? 'monthly';
  $('plan-perks-input').value = (plan?.perks ?? []).join('\n');
  $('plan-active-input').checked = plan?.active !== false;
  renderPlanSkillsChecklist(plan?.included_skills ?? []);
  $('plan-status').textContent = '';
  editor.style.display = 'block';
  $('show-create-plan-btn').style.display = 'none';
  $('plan-name-input').focus();
};

async function deletePlan(planId) {
  if (!confirm('Deactivate this plan? It will be hidden from new subscribers; existing subscribers keep access until their period ends. You can reactivate it later.')) return;
  try {
    const r = await apiFetch(`${API_BASE}/subscriptions/plans/${planId}`, { method: 'DELETE', credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    loadSubscriptionPlans();
  } catch (err) {
    alert(`Error deactivating plan: ${err.message}`);
  }
};

async function reactivatePlan(planId) {
  try {
    const r = await apiFetch(`${API_BASE}/subscriptions/plans/${planId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ active: true }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    loadSubscriptionPlans();
  } catch (err) {
    alert(`Could not reactivate plan: ${err.message}`);
  }
};

$('show-create-plan-btn')?.addEventListener('click', () => {
  openPlanEditor(null);
});

$('plan-cancel-btn')?.addEventListener('click', () => {
  $('plan-editor').style.display = 'none';
  $('show-create-plan-btn').style.display = '';
});

$('plan-save-btn')?.addEventListener('click', async () => {
  const status = $('plan-status');
  const planId = $('plan-editor-id').value.trim();
  const name = $('plan-name-input').value.trim();
  const price_usd = parseFloat($('plan-price-input').value);
  const interval = $('plan-interval-input').value;
  const perks = $('plan-perks-input').value.split('\n').map(s => s.trim()).filter(Boolean);
  const active = $('plan-active-input').checked;
  const included_skills = Array.from(
    document.querySelectorAll('#plan-skills-checklist input[type="checkbox"]:checked'),
  ).map((cb) => cb.value);

  if (!name) { status.textContent = 'Name is required.'; status.className = 'form-status err'; return; }
  if (!price_usd || price_usd < 0.99) { status.textContent = 'Price must be at least $0.99.'; status.className = 'form-status err'; return; }

  status.textContent = 'Saving…'; status.className = 'form-status';
  try {
    const url = planId ? `${API_BASE}/subscriptions/plans/${planId}` : `${API_BASE}/subscriptions/plans`;
    const body = planId
      ? { name, price_usd, interval, perks, included_skills, active }
      : { name, price_usd, interval, perks, included_skills, active, agent_id: agentId };
    const r = await apiFetch(url, {
      method: planId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    $('plan-editor').style.display = 'none';
    $('show-create-plan-btn').style.display = '';
    status.textContent = '';
    loadSubscriptionPlans();
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
});

// Plans are loaded eagerly via initAllSections() on render.

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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/voice`, { credentials: 'include' });
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
  const tune = $('voice-tune');
  if (!voiceStatus || !voiceStatus.voice_id) {
    el.textContent = `Browser speech synthesis (no custom voice set).`;
    previewBtn.hidden = true;
    removeBtn.hidden = true;
    if (tune) tune.hidden = true;
    return;
  }
  const name = (voicesCache || []).find((v) => v.voice_id === voiceStatus.voice_id)?.name || voiceStatus.voice_id;
  const cloned = voiceStatus.voice_cloned_at ? ` — cloned ${new Date(voiceStatus.voice_cloned_at).toLocaleDateString()}` : '';
  el.textContent = `${voiceStatus.voice_provider || 'elevenlabs'}: ${name}${cloned}`;
  previewBtn.hidden = false;
  removeBtn.hidden = false;
  if (tune) {
    tune.hidden = false;
    populateVoiceSettings();
  }
}

// null  = not yet fetched
// false = fetched, ElevenLabs not configured
// []    = fetched, configured, no voices (edge case)
// [...]  = fetched, configured, voices available
let voiceEnabledFetched = false;

async function loadVoiceList(filter = '') {
  const container = $('voice-list');
  if (!voiceEnabledFetched) {
    voiceEnabledFetched = true;
    try {
      const r = await apiFetch(`${API_BASE}/tts/eleven/voices`, { credentials: 'include' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.enabled === false) {
        voicesCache = false;
        const filterGroup = $('voice-filter')?.closest('.form-group');
        if (filterGroup) filterGroup.hidden = true;
        container.innerHTML = `
          <div class="voice-unconfigured">
            <div class="voice-unconfigured-icon">🎙</div>
            <div class="voice-unconfigured-title">ElevenLabs not configured</div>
            <p class="voice-unconfigured-body">
              Add <code>ELEVENLABS_API_KEY</code> to your environment variables to unlock
              AI voice selection, voice cloning, and fine-tuned delivery controls.
            </p>
            <a class="btn-ghost" href="https://elevenlabs.io" target="_blank" rel="noopener">
              Get an API key ›
            </a>
          </div>`;
        return;
      }
      voicesCache = j.voices || [];
      if (j.models?.length) {
        voiceModelsCache = j.models;
        populateModelSelect();
      }
    } catch (err) {
      container.innerHTML = `<div class="muted">Could not load voices: ${escapeHtml(err.message)}</div>`;
      return;
    }
  }
  if (voicesCache === false) return;
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
      ${v.preview_url ? '<button type="button" class="voice-tile-play" aria-label="Preview voice" title="Preview">▶</button>' : ''}
    </div>
  `).join('');
  container.querySelectorAll('.voice-tile').forEach((tile) => {
    tile.addEventListener('click', (e) => {
      if (e.target.classList.contains('voice-tile-play')) {
        playVoicePreview(tile.dataset.preview, e.target);
        return;
      }
      selectVoice(tile.dataset.voiceId);
    });
  });
}

let voicePreviewBtn = null;

function playVoicePreview(url, btn) {
  if (!url) return;
  // Stop current preview and reset its button
  if (voicePreviewBtn && voicePreviewBtn !== btn) {
    voicePreviewBtn.textContent = '▶';
    voicePreviewBtn.classList.remove('playing');
  }
  // Toggle: clicking the playing button stops it
  if (voicePreviewAudio && !voicePreviewAudio.paused && voicePreviewBtn === btn) {
    voicePreviewAudio.pause();
    if (btn) { btn.textContent = '▶'; btn.classList.remove('playing'); }
    voicePreviewBtn = null;
    return;
  }
  try { voicePreviewAudio?.pause(); } catch {}
  voicePreviewAudio = new Audio(url);
  voicePreviewBtn = btn || null;
  if (btn) { btn.textContent = '■'; btn.classList.add('playing'); }
  voicePreviewAudio.addEventListener('ended', () => {
    if (btn) { btn.textContent = '▶'; btn.classList.remove('playing'); }
    if (voicePreviewBtn === btn) voicePreviewBtn = null;
  });
  voicePreviewAudio.play().catch(() => {
    if (btn) { btn.textContent = '▶'; btn.classList.remove('playing'); }
  });
}

async function selectVoice(voiceId) {
  if (!voiceId) return;
  const status = $('voice-status');
  status.textContent = 'Saving…';
  status.className = 'form-status';
  try {
    // The dedicated voice endpoint validates library membership and frees a
    // replaced clone's quota slot — the generic agent PUT ignores voice fields.
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/voice`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ voice_id: voiceId }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    voiceStatus = await r.json();
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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/voice`, { method: 'DELETE', credentials: 'include' });
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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/voice/clone?${qs}`, {
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

// ── Voice fine-tuning (model + delivery settings) ─────────────────────────────

// Fallback only — the live catalog is served by GET /api/tts/eleven/voices
// (`models`) so the editor and the API's validator share one source of truth.
const VOICE_MODELS_FALLBACK = [
  { id: 'eleven_flash_v2_5', label: 'Flash v2.5', note: 'lowest latency' },
  { id: 'eleven_turbo_v2_5', label: 'Turbo v2.5', note: 'balanced' },
  { id: 'eleven_multilingual_v2', label: 'Multilingual v2', note: 'highest quality' },
];
const VOICE_SETTING_DEFAULTS = { stability: 0.5, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true };
let voiceModelsCache = null;
let voiceTestAudio = null;

function voiceModels() {
  return voiceModelsCache?.length ? voiceModelsCache : VOICE_MODELS_FALLBACK;
}

function populateModelSelect() {
  const sel = $('voice-model');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = voiceModels()
    .map((m) => {
      const label = m.note ? `${m.label} — ${m.note}` : m.label;
      return `<option value="${escapeHtml(m.id)}">${escapeHtml(label)}</option>`;
    })
    .join('');
  if (cur) sel.value = cur;
}

function initVoiceSettingsControls() {
  populateModelSelect();
  for (const key of ['stability', 'similarity', 'style']) {
    const input = $(`voice-${key}`);
    const label = $(`voice-${key}-val`);
    input?.addEventListener('input', () => {
      if (label) label.textContent = Number(input.value).toFixed(2);
    });
  }
  $('voice-save-settings-btn')?.addEventListener('click', saveVoiceSettings);
  $('voice-test-btn')?.addEventListener('click', testVoice);
}

function setRange(id, value) {
  const input = $(id);
  if (!input) return;
  input.value = String(value);
  const label = $(`${id}-val`);
  if (label) label.textContent = Number(value).toFixed(2);
}

function populateVoiceSettings() {
  const s = voiceStatus?.voice_settings || VOICE_SETTING_DEFAULTS;
  const model = voiceStatus?.voice_model || 'eleven_flash_v2_5';
  const sel = $('voice-model');
  if (sel) sel.value = voiceModels().some((m) => m.id === model) ? model : 'eleven_flash_v2_5';
  setRange('voice-stability', s.stability ?? 0.5);
  setRange('voice-similarity', s.similarity_boost ?? 0.75);
  setRange('voice-style', s.style ?? 0.5);
  const boost = $('voice-speaker-boost');
  if (boost) boost.checked = s.use_speaker_boost !== false;
}

function readVoiceSettingsFromUI() {
  return {
    voice_model: $('voice-model')?.value || 'eleven_flash_v2_5',
    voice_settings: {
      stability: Number($('voice-stability').value),
      similarity_boost: Number($('voice-similarity').value),
      style: Number($('voice-style').value),
      use_speaker_boost: $('voice-speaker-boost').checked,
    },
  };
}

async function saveVoiceSettings() {
  const status = $('voice-settings-status');
  status.textContent = 'Saving…';
  status.className = 'form-status';
  try {
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/voice`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(readVoiceSettingsFromUI()),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    voiceStatus = await r.json();
    status.textContent = 'Saved.';
    status.className = 'form-status ok';
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  }
}

async function testVoice() {
  if (!voiceStatus?.voice_id) return;
  const status = $('voice-settings-status');
  const btn = $('voice-test-btn');
  const text = ($('voice-test-text').value || '').trim() || 'Hi! This is how I sound.';
  const { voice_model, voice_settings } = readVoiceSettingsFromUI();
  status.textContent = 'Synthesizing…';
  status.className = 'form-status';
  btn.disabled = true;
  try {
    const r = await apiFetch(`${API_BASE}/tts/eleven`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ voiceId: voiceStatus.voice_id, text, modelId: voice_model, voice_settings }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    const blob = await r.blob();
    try { voiceTestAudio?.pause(); } catch {}
    const url = URL.createObjectURL(blob);
    voiceTestAudio = new Audio(url);
    voiceTestAudio.onended = () => URL.revokeObjectURL(url);
    await voiceTestAudio.play();
    status.textContent = 'Playing…';
    status.className = 'form-status ok';
  } catch (err) {
    status.textContent = `Error: ${err.message}`;
    status.className = 'form-status err';
  } finally {
    btn.disabled = false;
  }
}

initVoiceSettingsControls();

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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/memories`, { credentials: 'include' });
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
  container.innerHTML = rows.map((m) => {
    const isPublic = m.is_public === true;
    return `
    <div class="mem-item" id="mem-${escapeHtml(m.id)}" data-id="${escapeHtml(m.id)}">
      <div class="mem-item-body">
        <div class="mem-item-type">${escapeHtml(m.type)}</div>
        <div class="mem-item-content">${escapeHtml(m.content)}</div>
        ${m.tags?.length ? `<div class="mem-item-tags">${m.tags.map(escapeHtml).join(' · ')}</div>` : ''}
      </div>
      <div class="mem-item-actions">
        <button
          class="mem-vis-toggle${isPublic ? ' is-public' : ''}"
          data-vis="${escapeHtml(m.id)}"
          aria-pressed="${isPublic}"
          title="${isPublic ? 'Public — shown on your profile. Click to make private.' : 'Private — only you can see this. Click to show it on your profile.'}"
        >${isPublic ? '◉ Public' : '○ Private'}</button>
        <button class="chip-remove" data-del="${escapeHtml(m.id)}" title="Delete">×</button>
      </div>
    </div>
  `;
  }).join('');
  container.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => deleteMemory(btn.dataset.del));
  });
  container.querySelectorAll('[data-vis]').forEach((btn) => {
    btn.addEventListener('click', () => toggleMemoryVisibility(btn));
  });
  revealCitedMemory();
}

// Every autopilot receipt cites the memories that motivated it and links here as
// /agent/<id>/edit?tab=knowledge#mem-<memoryId>. The list renders after the
// browser has already resolved the fragment, so nothing scrolled and the cited
// memory was indistinguishable from the rest: bring it into view and mark it.
function revealCitedMemory() {
  if (!hasCitedMemoryTarget()) return;
  const row = document.getElementById(decodeURIComponent(location.hash.slice(1)));
  if (!row) return;
  row.classList.add('mem-cited');
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function toggleMemoryVisibility(btn) {
  const id = btn.dataset.vis;
  const makePublic = btn.getAttribute('aria-pressed') !== 'true';
  btn.disabled = true;
  try {
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/memories/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ isPublic: makePublic }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    }
    btn.setAttribute('aria-pressed', String(makePublic));
    btn.classList.toggle('is-public', makePublic);
    btn.textContent = makePublic ? '◉ Public' : '○ Private';
    btn.title = makePublic
      ? 'Public — shown on your profile. Click to make private.'
      : 'Private — only you can see this. Click to show it on your profile.';
  } catch (err) {
    $('mem-status').textContent = `Could not update visibility: ${err.message}`;
    $('mem-status').className = 'form-status err';
  } finally {
    btn.disabled = false;
  }
}

async function deleteMemory(id) {
  try {
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/memories/${id}`, { method: 'DELETE', credentials: 'include' });
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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/memories`, {
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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/memory-seed`, {
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
    const r = await apiFetch(`${API_BASE}/skills?limit=50`, { credentials: 'include' });
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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}`, {
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
    const r = await apiFetch(`${API_BASE}/portfolio/summary`, { credentials: 'include' });
    if (!r.ok) return;
    const j = await r.json();
    // /api/portfolio/summary returns each wallet as { usd, native, tokens }.
    // This read used `usd_total` and a flat `assets` array, neither of which the
    // route has ever sent, so the panel showed 0 / 0 / $0.00 for every agent.
    const mine = (j.wallets || []).filter((w) => w.agent_id === agentId);
    let solBal = null, usdcBal = null, totalUsd = 0;
    for (const w of mine) {
      totalUsd += Number(w.usd || 0);
      if (w.chain !== 'solana') continue;
      if (w.native?.symbol === 'SOL') solBal = w.native;
      usdcBal = (w.tokens || []).find((t) => t.symbol === 'USDC') || usdcBal;
    }
    $('wallet-sol-balance').textContent = solBal ? Number(solBal.amount).toFixed(4) : '0';
    $('wallet-usdc-balance').textContent = usdcBal ? Number(usdcBal.amount).toFixed(2) : '0';
    $('wallet-total-usd').textContent = `$${totalUsd.toFixed(2)}`;
  } catch {
    // Balance fetch is non-fatal, the addresses above are still useful.
  }
}

async function loadWalletActivity() {
  const el = $('wallet-activity');
  if (!walletInfo?.solAddr) {
    el.innerHTML = '<span class="muted">No Solana wallet.</span>';
    return;
  }
  try {
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/solana/activity?limit=5`, { credentials: 'include' });
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
  const picked = $('send-asset').value;
  const recipient = $('send-to').value.trim();
  // Send the typed decimal string, not a re-serialized float: `parseFloat(…)
  // .toString()` turns a small amount into exponential notation ("1e-7"), which
  // the route's amount regex rejects.
  const amount = $('send-amount').value.trim();
  if (!recipient || !(parseFloat(amount) > 0)) {
    status.textContent = 'Recipient and positive amount required.';
    status.className = 'form-status err';
    return;
  }
  // The route takes 'native' for SOL and a mint address for an SPL token; the
  // select's raw 'sol'/'usdc' values were rejected as an unknown asset.
  const asset = picked === 'sol' ? 'native' : USDC_MINT;
  if (!confirm(`Send ${amount} ${picked.toUpperCase()} to ${recipient}?`)) return;
  status.textContent = 'Sending…';
  status.className = 'form-status';
  try {
    const r = await apiFetch(`${API_BASE}/portfolio/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ agent_id: agentId, chain: 'solana', asset, recipient, amount }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);
    status.textContent = `Sent. tx ${j.tx_hash?.slice(0, 8) || ''}…`;
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
    const r = await apiFetch(`${API_BASE}/x/status`, { credentials: 'include' });
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
    const r = await apiFetch(`${API_BASE}/x/status`, { method: 'DELETE', credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    await loadXStatus();
  } catch (err) {
    alert(`Disconnect failed: ${err.message}`);
  }
});

$('x-username-save').addEventListener('click', async () => {
  const val = $('x-username').value.trim().replace(/^@/, '') || null;
  try {
    const r = await apiFetch(`${API_BASE}/agents/${agentId}`, {
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
    const r = await apiFetch(`${API_BASE}/x/triggers`, { credentials: 'include' });
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
    const r = await apiFetch(`${API_BASE}/x/triggers?id=${encodeURIComponent(id)}`, {
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
  await apiFetch(`${API_BASE}/x/triggers?id=${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
}

async function deleteTrigger(id) {
  if (!confirm('Delete this trigger?')) return;
  await apiFetch(`${API_BASE}/x/triggers?id=${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
  await loadXTriggers();
}

$('x-trigger-add').addEventListener('click', async () => {
  const kind = $('x-trigger-kind').value;
  const config = defaultTriggerConfig(kind);
  try {
    const r = await apiFetch(`${API_BASE}/x/triggers`, {
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
    const r = await apiFetch(`${API_BASE}/x/post`, {
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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/usage`, { credentials: 'include' });
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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/payments?direction=${direction}&limit=10`, { credentials: 'include' });
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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/embed-policy`, { credentials: 'include' });
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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/embed-policy`, {
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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}/embed-policy`, { method: 'DELETE', credentials: 'include' });
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
    const r = await apiFetch(`${API_BASE}/widgets`, { credentials: 'include' });
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
    const r = await apiFetch(`${API_BASE}/widgets`, {
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
    const r = await apiFetch(`${API_BASE}/widgets/${id}`, { method: 'DELETE', credentials: 'include' });
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
    const r = await apiFetch(`${API_BASE}/agents/${agentId}`, { method: 'DELETE', credentials: 'include' });
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

// ─────────────────────────────────────────────────────────────────────────────
// Dreams tab — reflection review (memory consolidation)
// ─────────────────────────────────────────────────────────────────────────────

let dreamsTabMounted = false;
let dreamsReflecting = false;
let dreamsJournalLoaded = false;

const KIND_LABEL = { insight: 'Insight', belief: 'Belief', question: 'Question', prune: 'Prune' };

function setDreamsBadge(n) {
  const b = $('dreams-tab-badge');
  if (!b) return;
  const count = Number(n) || 0;
  if (count > 0) {
    b.textContent = String(count);
    b.hidden = false;
    b.setAttribute('aria-hidden', 'false');
  } else {
    b.hidden = true;
    b.setAttribute('aria-hidden', 'true');
  }
}

async function ensureDreamsTab() {
  if (!dreamsTabMounted) {
    dreamsTabMounted = true;
    $('dreams-reflect-btn').addEventListener('click', () => reflectNow());
    $('dreams-journal-toggle').addEventListener('click', toggleDreamJournal);
  }
  await loadDreams();
  // Opening the review surface kicks a debounced background reflection so a user
  // returning after time away finds fresh dreams — the server debounce makes
  // repeated opens cheap (it simply reports it reflected recently).
  backgroundReflect();
}

async function loadDreams() {
  const list = $('dreams-list');
  try {
    const r = await apiFetch(`${API_BASE}/agent/dreams?agentId=${agentId}&status=pending`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    renderDreams(j.dreams || []);
    setDreamsBadge(j.pending ?? (j.dreams || []).length);
    renderDreamsMeta(j.lastRun);
    $('dreams-journal').hidden = false;
    if (dreamsJournalLoaded) loadDreamJournal();
  } catch (err) {
    list.innerHTML = `<div class="dream-card-status err">Could not load dreams: ${escapeHtml(err.message)}. <button class="link-btn" id="dreams-retry">Retry</button></div>`;
    const retry = $('dreams-retry');
    if (retry) retry.addEventListener('click', loadDreams);
  }
}

function renderDreamsMeta(lastRun) {
  const meta = $('dreams-meta');
  if (!meta) return;
  if (!lastRun) {
    meta.textContent = 'Your agent has not reflected yet.';
    return;
  }
  const when = timeAgo(lastRun.at);
  if (lastRun.status === 'ok' && lastRun.dreamsCreated > 0) {
    meta.innerHTML = `<span class="dot">●</span> Last reflected ${escapeHtml(when)} — ${lastRun.dreamsCreated} new dream${lastRun.dreamsCreated === 1 ? '' : 's'}.`;
  } else if (lastRun.status === 'skipped') {
    meta.innerHTML = `<span class="dot">●</span> Last checked ${escapeHtml(when)} — ${escapeHtml(lastRun.reason || 'nothing new to consolidate')}.`;
  } else if (lastRun.status === 'error') {
    meta.innerHTML = `<span class="dot">●</span> Last attempt ${escapeHtml(when)} hit an error (${escapeHtml(lastRun.reason || 'unknown')}).`;
  } else {
    meta.innerHTML = `<span class="dot">●</span> Last reflected ${escapeHtml(when)} — no new insights that pass.`;
  }
}

function timeAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'recently';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function renderDreams(dreams) {
  const list = $('dreams-list');
  if (!dreams.length) {
    list.innerHTML = `
      <div class="dreams-empty">
        <span class="moon" aria-hidden="true">🌙</span>
        <div class="lead">No new reflections yet.</div>
        <div>Your agent consolidates its memories on its own while you're away. Give it some memories and conversations to think about — or reflect now.</div>
      </div>`;
    return;
  }
  list.innerHTML = dreams.map(dreamCardHTML).join('');
  dreams.forEach((d) => wireDreamCard(d));
}

function dreamCardHTML(d) {
  const conf = Math.round((Number(d.confidence) || 0) * 100);
  const kindClass = d.kind === 'question' ? ' kind-question' : '';
  const propType = d.proposedType ? `<span class="pill">→ ${escapeHtml(d.proposedType)} memory</span>` : '';
  const propSal = `<span class="pill">salience ${Number(d.proposedSalience).toFixed(2)}</span>`;
  const propAction = d.proposedAction
    ? `<span class="pill" title="${escapeHtml(JSON.stringify(d.proposedAction))}">⚡ proposes an automation</span>`
    : '';
  const sources = (d.sources || []).map((s) => {
    if (s.forgotten) {
      return `<div class="dream-src forgotten" aria-disabled="true">source memory was forgotten</div>`;
    }
    return `<button type="button" class="dream-src" data-src-id="${escapeHtml(s.id)}" data-full="${escapeHtml(s.content)}" title="Click to view full memory">
      <span class="src-type">${escapeHtml(s.type)}</span>${escapeHtml(truncateText(s.content, 140))}
    </button>`;
  }).join('');

  const isQuestion = d.kind === 'question' && d.question;
  const questionUI = isQuestion
    ? `<div class="dream-answer">
         <input class="form-input" type="text" id="dream-ans-${escapeHtml(d.id)}" placeholder="Your answer…" maxlength="2000" aria-label="Answer the agent's question" />
         <button class="dream-answer-send" data-answer="${escapeHtml(d.id)}">Answer &amp; save</button>
       </div>`
    : '';

  const acceptLabel = isQuestion ? 'Accept as-is' : 'Accept';

  return `
  <article class="dream-card entering" data-dream="${escapeHtml(d.id)}">
    <span class="dream-kind${kindClass}">${escapeHtml(KIND_LABEL[d.kind] || d.kind)}</span>
    <p class="dream-statement">${escapeHtml(d.statement)}</p>
    ${isQuestion ? `<p class="dream-rationale">${escapeHtml(d.question)}</p>` : (d.rationale ? `<p class="dream-rationale">${escapeHtml(d.rationale)}</p>` : '')}
    <div class="dream-conf" title="How confident the agent is in this synthesis">
      confidence ${conf}%
      <span class="dream-conf-bar"><span class="dream-conf-fill" style="width:${conf}%"></span></span>
    </div>
    <div class="dream-prop">${propType}${propSal}${propAction}</div>
    ${sources ? `<div class="dream-sources"><div class="dream-sources-label">Drawn from ${(d.sources || []).length} ${(d.sources || []).length === 1 ? 'memory' : 'memories'} — its evidence</div>${sources}</div>` : ''}
    ${questionUI}
    <div class="dream-actions">
      <button class="dream-accept" data-accept="${escapeHtml(d.id)}">${acceptLabel}</button>
      <button class="dream-reject" data-reject="${escapeHtml(d.id)}">Reject</button>
    </div>
    <div class="dream-card-status" data-status="${escapeHtml(d.id)}" role="status" aria-live="polite"></div>
  </article>`;
}

function wireDreamCard(d) {
  const card = document.querySelector(`.dream-card[data-dream="${cssEscape(d.id)}"]`);
  if (!card) return;
  card.querySelectorAll('.dream-src[data-src-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const expanded = btn.classList.toggle('expanded');
      const full = btn.dataset.full || '';
      const type = btn.querySelector('.src-type')?.outerHTML || '';
      btn.innerHTML = `${type}${escapeHtml(expanded ? full : truncateText(full, 140))}`;
    });
  });
  card.querySelector('[data-accept]')?.addEventListener('click', () => reviewDream(d, 'accept'));
  card.querySelector('[data-reject]')?.addEventListener('click', () => reviewDream(d, 'reject'));
  const ans = card.querySelector('[data-answer]');
  if (ans) ans.addEventListener('click', () => reviewDream(d, 'answer'));
}

function cssEscape(s) {
  return String(s).replace(/["\\\]]/g, '\\$&');
}

function truncateText(s, n) {
  const str = String(s ?? '');
  return str.length > n ? str.slice(0, n - 1) + '…' : str;
}

async function reviewDream(d, decision) {
  const card = document.querySelector(`.dream-card[data-dream="${cssEscape(d.id)}"]`);
  const statusEl = card?.querySelector(`[data-status]`);
  const buttons = card?.querySelectorAll('button') || [];
  let answer = null;
  if (decision === 'answer') {
    const input = $(`dream-ans-${d.id}`);
    answer = (input?.value || '').trim();
    if (!answer) {
      if (statusEl) { statusEl.textContent = 'Type an answer first.'; statusEl.className = 'dream-card-status err'; }
      input?.focus();
      return;
    }
  }
  buttons.forEach((b) => (b.disabled = true));
  if (statusEl) {
    statusEl.textContent = decision === 'reject' ? 'Letting it go…' : 'Saving…';
    statusEl.className = 'dream-card-status';
  }
  try {
    const r = await apiFetch(`${API_BASE}/agent/dreams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ agentId, dreamId: d.id, decision, answer }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error_description || j.error || `HTTP ${r.status}`);

    if (j.memory) {
      // A real, higher-salience memory now exists — tell the rest of the app.
      agentBus.emit('memory:added', {
        agentId,
        memoryId: j.memory.id,
        type: j.memory.type,
        salience: j.memory.salience,
        source: 'reflection',
        ts: j.memory.createdAt,
      });
      // Refresh the Knowledge tab if the user has it open so the new memory shows.
      if (knowledgeTabMounted) loadMemories();
    }

    // Animate the card out, then refresh counts + journal.
    if (card) {
      card.classList.add('leaving');
      setTimeout(() => {
        card.remove();
        const remaining = document.querySelectorAll('.dream-card').length;
        setDreamsBadge(remaining);
        if (remaining === 0) renderDreams([]);
      }, 250);
    }
    dreamsJournalLoaded = false; // journal is now stale
  } catch (err) {
    buttons.forEach((b) => (b.disabled = false));
    if (statusEl) {
      statusEl.textContent = `Could not ${decision}: ${err.message}`;
      statusEl.className = 'dream-card-status err';
    }
  }
}

async function runReflectPass({ force }) {
  if (dreamsReflecting) return;
  dreamsReflecting = true;
  const btn = $('dreams-reflect-btn');
  if (force && btn) {
    btn.disabled = true;
    btn.classList.add('is-dreaming');
    btn.querySelector('.dreams-reflect-label').textContent = 'Reflecting';
  } else if (btn) {
    btn.classList.add('is-dreaming');
  }
  try {
    const r = await apiFetch(`${API_BASE}/agent/reflect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ agentId, force: !!force }),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.status === 'ok' && Array.isArray(j.created) && j.created.length) {
      for (const dream of j.created) {
        agentBus.emit('dream:created', {
          agentId,
          dreamId: dream.id,
          kind: dream.kind,
          statement: dream.statement,
          ts: dream.createdAt,
        });
      }
      await loadDreams();
    } else if (force) {
      // Force run that produced nothing — refresh so the meta line explains why.
      await loadDreams();
    }
  } catch {
    // Background reflection failures are non-fatal; the meta line + list already
    // reflect the last known state. A forced run surfaces the error via meta.
    if (force) await loadDreams();
  } finally {
    dreamsReflecting = false;
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-dreaming');
      btn.querySelector('.dreams-reflect-label').textContent = 'Reflect now';
    }
  }
}

function reflectNow() {
  runReflectPass({ force: true });
}

function backgroundReflect() {
  runReflectPass({ force: false });
}

function toggleDreamJournal() {
  const toggle = $('dreams-journal-toggle');
  const listEl = $('dreams-journal-list');
  const open = toggle.getAttribute('aria-expanded') === 'true';
  const next = !open;
  toggle.setAttribute('aria-expanded', String(next));
  listEl.hidden = !next;
  if (next && !dreamsJournalLoaded) loadDreamJournal();
}

async function loadDreamJournal() {
  const listEl = $('dreams-journal-list');
  const countEl = $('dreams-journal-count');
  try {
    const r = await apiFetch(`${API_BASE}/agent/dreams?agentId=${agentId}&limit=100`, { credentials: 'include' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    dreamsJournalLoaded = true;
    const reviewed = (j.dreams || []).filter((d) => d.status === 'accepted' || d.status === 'rejected');
    if (countEl) countEl.textContent = reviewed.length ? `(${reviewed.length})` : '';
    if (!reviewed.length) {
      listEl.innerHTML = '<div class="muted" style="font-size:0.78rem">Accepted and rejected dreams will appear here as your agent grows.</div>';
      return;
    }
    listEl.innerHTML = reviewed.map((d) => `
      <div class="journal-item">
        <span class="jstatus ${escapeHtml(d.status)}">${d.status === 'accepted' ? '✓ kept' : '✕ let go'}</span>
        <span class="jtext">${escapeHtml(d.statement)}${d.answer ? ` — <em>${escapeHtml(d.answer)}</em>` : ''}</span>
      </div>`).join('');
  } catch (err) {
    listEl.innerHTML = `<div class="dream-card-status err">Could not load journal: ${escapeHtml(err.message)}</div>`;
  }
}

let brainTabMounted = false;
async function ensureBrainTab() {
  if (brainTabMounted) return;
  brainTabMounted = true;
  const host = $('brain-studio-host');
  try {
    const { mountBrainStudio } = await import('./brain-studio.js');
    await mountBrainStudio(host, { agentId, agent: agentData });
  } catch (err) {
    brainTabMounted = false;
    host.innerHTML = `<div class="error-msg" style="padding:1rem">Could not load the Brain Studio: ${escapeHtml(err.message)}</div>`;
  }
}

// Brain Ownership — Portable & Verifiable Brain. Passport, storage mode, IPFS
// pins, on-chain anchor, signed export/import.
let ownershipTabMounted = false;
async function ensureOwnershipTab() {
  if (ownershipTabMounted) return;
  ownershipTabMounted = true;
  const host = $('brain-ownership-host');
  try {
    const { mountBrainOwnership } = await import('./brain-ownership.js');
    await mountBrainOwnership(host, { agentId, agent: agentData });
  } catch (err) {
    ownershipTabMounted = false;
    host.innerHTML = `<div class="error-msg" style="padding:1rem">Could not load brain ownership: ${escapeHtml(err.message)}</div>`;
  }
}

// Mind Palace — the agent's memory as a navigable spatial scene with the live
// avatar at its core. Mounts the same module the standalone /agent/:id/mind
// route uses; the empty state can ask the editor to jump to the Knowledge tab.
let mindMounted = false;
let mindController = null;
async function ensureMindTab() {
  const link = $('mind-fullscreen-link');
  if (link && agentId) link.href = `/agent/${agentId}/mind`;
  if (mindMounted || !agentId) return;
  mindMounted = true;
  const host = $('mind-palace-host');
  if (!host) return;
  host.addEventListener('mind:add-memory', () => {
    const target = document.getElementById('section-brain');
    const contentCol = document.querySelector('.content-col');
    if (target && contentCol) contentCol.scrollTo({ top: target.offsetTop, behavior: 'smooth' });
    const knowledgePanel = document.getElementById('panel-knowledge');
    if (knowledgePanel) knowledgePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  try {
    const { mountMindPalace } = await import('./mind-palace.js');
    mindController = mountMindPalace(host, { agentId, agent: agentData, embedded: true });
  } catch (err) {
    mindMounted = false;
    host.innerHTML = `<div class="error-msg" style="padding:1rem">Could not load the Mind Palace: ${escapeHtml(err.message)}</div>`;
  }
}

// Memory-grounded Autopilot — explainable autonomy. The strategy textarea above
// stays; this mounts the scopes / proposals / trust / signed-receipts surface.
let autopilotMounted = false;
function ensureAutopilotTab() {
  if (autopilotMounted || !agentId) return;
  const host = $('autopilot-mind');
  if (!host) return;
  autopilotMounted = true;
  mountAutopilotMind(host, { agentId });
}

// True when the URL fragment names a specific memory (an autopilot receipt's
// provenance link). That target is more precise than the ?tab= section, so it
// owns the scroll and the section scroll stands down: two smooth scrolls racing
// each other landed the reader wherever the slower one finished.
function hasCitedMemoryTarget() {
  return /^#mem-/.test(location.hash);
}

// Scroll to a named section in the unified layout (used by OAuth callback redirects via ?tab=…)
function scrollToSection(tabId) {
  if (hasCitedMemoryTarget()) return;
  const sectionMap = {
    persona: 'section-identity',
    outfit: 'section-identity',
    voice: 'section-identity',
    brain: 'section-brain',
    knowledge: 'section-brain',
    mind: 'section-brain',
    ownership: 'section-brain',
    dreams: 'section-brain',
    skills: 'section-brain',
    autopilot: 'section-brain',
    publish: 'section-distribute',
    embed: 'section-distribute',
    widgets: 'section-distribute',
    social: 'section-distribute',
    monetization: 'section-money',
    wallet: 'section-money',
    analytics: 'section-money',
    studio: 'section-advanced',
    danger: 'section-advanced',
  };
  const panelId = `panel-${tabId}`;
  const panel = document.getElementById(panelId);
  if (panel) {
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  const sectionId = sectionMap[tabId];
  if (sectionId) {
    const section = document.getElementById(sectionId);
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

const _cancelBtn = $('outfit-cancel');
if (_cancelBtn) {
  _cancelBtn.addEventListener('click', () => {
    if (_uploadController) _uploadController.abort();
  });
}

async function init() {
  await loadAgent();
  if (!agentData) return;
  const params = new URLSearchParams(location.search);
  const initialTab = params.get('tab');
  if (initialTab) {
    // Defer slightly so sections are painted before scrolling
    requestAnimationFrame(() => scrollToSection(initialTab));
  }
  // Surface the pending-dreams count on the tab badge without forcing the user
  // to open the tab — so a returning user sees "their agent has been thinking".
  primeDreamsBadge();

  // Mood & embodiment inspector — current mood, the real signals that moved it,
  // a mood-over-time sparkline, and the emotional-sensitivity control.
  const moodHost = document.getElementById('mood-inspector-host');
  if (moodHost && agentData?.id) {
    mountMoodInspector(moodHost, { agentId: agentData.id });
  }

  // Autonomous capabilities — alpha hunt, coin launcher, auto-claim, market maker.
  initAlphaHunt();
  initLauncher();
  initMarketMaker();
}

async function primeDreamsBadge() {
  if (!agentId) return;
  try {
    const r = await apiFetch(`${API_BASE}/agent/dreams?agentId=${agentId}&status=pending&limit=1`, { credentials: 'include' });
    if (!r.ok) return;
    const j = await r.json();
    setDreamsBadge(j.pending || 0);
  } catch {
    // Non-fatal — the badge simply stays hidden until the tab is opened.
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ALPHA HUNT — strategy config wired to /api/sniper/strategy
// ═══════════════════════════════════════════════════════════════════════════

async function initAlphaHunt() {
  if (!agentId) return;
  const statusEl = document.getElementById('alpha-hunt-status');
  function setStatus(msg, ok = true) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = ok ? 'rgba(255,255,255,0.6)' : '#f87171';
    if (msg) setTimeout(() => { statusEl.textContent = ''; }, 4000);
  }

  // Load existing alpha_hunt strategy for this agent
  try {
    const r = await apiFetch(`${API_BASE}/sniper/strategy?agentId=${agentId}`, { credentials: 'include' });
    if (r.ok) {
      const { strategies = [] } = await r.json();
      const s = strategies.find(x => x.trigger === 'alpha_hunt');
      if (s) {
        const g = id => document.getElementById(id);
        if (g('alpha-enabled')) g('alpha-enabled').checked = !!s.enabled;
        if (g('alpha-min-smart-money')) g('alpha-min-smart-money').value = s.alpha_min_smart_money ?? '';
        if (g('alpha-min-quality-score')) g('alpha-min-quality-score').value = s.alpha_min_quality_score ?? '';
        if (g('alpha-min-organic-score')) g('alpha-min-organic-score').value = s.alpha_min_organic_score ?? '';
        if (g('alpha-max-mcap-usd')) g('alpha-max-mcap-usd').value = s.alpha_max_mcap_usd ?? '';
        if (g('alpha-narrative-keywords') && s.alpha_narrative_keywords?.length) {
          g('alpha-narrative-keywords').value = s.alpha_narrative_keywords.join(', ');
        }
        if (g('alpha-per-trade-sol')) g('alpha-per-trade-sol').value = s.per_trade_sol ?? '';
        if (g('alpha-daily-budget-sol')) g('alpha-daily-budget-sol').value = s.daily_budget_sol ?? '';
        if (g('alpha-stop-loss')) g('alpha-stop-loss').value = s.stop_loss_pct ?? '';
        if (g('alpha-take-profit')) g('alpha-take-profit').value = s.take_profit_pct ?? '';
        if (g('alpha-trailing-stop')) g('alpha-trailing-stop').value = s.trailing_stop_pct ?? '';
        if (g('alpha-mev-tip')) g('alpha-mev-tip').value = s.mev_tip_mode || 'economy';
      }
    }
  } catch { /* load errors are non-fatal — form stays at defaults */ }

  const saveBtn = document.getElementById('alpha-hunt-save');
  if (!saveBtn) return;
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    setStatus('Saving…');
    const g = id => document.getElementById(id);
    const keywords = (g('alpha-narrative-keywords')?.value || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const body = {
      agentId,
      trigger: 'alpha_hunt',
      enabled: g('alpha-enabled')?.checked ?? true,
      alpha_min_smart_money: g('alpha-min-smart-money')?.value !== '' ? Number(g('alpha-min-smart-money').value) : null,
      alpha_min_quality_score: g('alpha-min-quality-score')?.value !== '' ? Number(g('alpha-min-quality-score').value) : null,
      alpha_min_organic_score: g('alpha-min-organic-score')?.value !== '' ? Number(g('alpha-min-organic-score').value) : null,
      alpha_max_mcap_usd: g('alpha-max-mcap-usd')?.value !== '' ? Number(g('alpha-max-mcap-usd').value) : null,
      alpha_narrative_keywords: keywords.length ? keywords : null,
      mev_tip_mode: g('alpha-mev-tip')?.value || 'economy',
    };
    try {
      const r = await apiFetch(`${API_BASE}/sniper/strategy`, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || j.error || 'Save failed');
      setStatus('Saved');
    } catch (err) {
      setStatus(err.message, false);
    } finally {
      saveBtn.disabled = false;
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// LAUNCHER — wired to /api/agent/launcher
// ═══════════════════════════════════════════════════════════════════════════

async function initLauncher() {
  if (!agentId) return;
  const statusEl = document.getElementById('launcher-status');
  function setStatus(msg, ok = true) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = ok ? 'rgba(255,255,255,0.6)' : '#f87171';
    if (msg) setTimeout(() => { statusEl.textContent = ''; }, 4000);
  }

  async function loadLauncher() {
    try {
      const r = await apiFetch(`${API_BASE}/agent/launcher?agentId=${agentId}`, { credentials: 'include' });
      if (!r.ok) return;
      const { configs = [], coins = [] } = await r.json();
      const cfg = configs[0];
      if (cfg) {
        const g = id => document.getElementById(id);
        if (g('launcher-enabled')) g('launcher-enabled').checked = !!cfg.enabled;
        if (g('launcher-network')) g('launcher-network').value = cfg.network || 'mainnet';
        if (g('launcher-interval-hours')) g('launcher-interval-hours').value = cfg.interval_hours ?? '';
        if (g('launcher-max-launches')) g('launcher-max-launches').value = cfg.max_launches ?? '';
        if (g('launcher-name-template')) g('launcher-name-template').value = cfg.name_template ?? '';
        if (g('launcher-symbol')) g('launcher-symbol').value = cfg.symbol ?? '';
        if (g('launcher-description')) g('launcher-description').value = cfg.description ?? '';
        if (g('launcher-image-url')) g('launcher-image-url').value = cfg.image_url ?? '';
        if (g('launcher-twitter')) g('launcher-twitter').value = cfg.twitter ?? '';
        if (g('launcher-telegram')) g('launcher-telegram').value = cfg.telegram ?? '';
        if (g('launcher-website')) g('launcher-website').value = cfg.website ?? '';
        if (g('launcher-initial-buy')) g('launcher-initial-buy').value = cfg.initial_buy_sol ?? '';
        if (g('auto-claim-enabled')) g('auto-claim-enabled').checked = !!cfg.auto_claim_enabled;
        if (g('auto-claim-threshold')) g('auto-claim-threshold').value = cfg.auto_claim_threshold_sol ?? '';
        const reinvest = document.getElementById('auto-claim-reinvest');
        const reinvestVal = document.getElementById('auto-claim-reinvest-val');
        if (reinvest) reinvest.value = cfg.auto_claim_reinvest_pct ?? 0;
        if (reinvestVal) reinvestVal.textContent = `${Math.round(cfg.auto_claim_reinvest_pct ?? 0)}%`;
      }
      renderLaunchedCoins(coins);
      renderClaimableFees(coins);
    } catch { /* non-fatal */ }
  }

  function renderLaunchedCoins(coins) {
    const wrap = document.getElementById('launched-coins-table-wrap');
    if (!wrap) return;
    if (!coins.length) {
      wrap.innerHTML = '<div class="muted">No coins launched yet.</div>';
      return;
    }
    wrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:0.78rem">
        <thead>
          <tr style="color:rgba(255,255,255,0.4);text-align:left">
            <th style="padding:0.4rem 0.6rem">Symbol</th>
            <th style="padding:0.4rem 0.6rem">Name</th>
            <th style="padding:0.4rem 0.6rem">Network</th>
            <th style="padding:0.4rem 0.6rem">Claimed SOL</th>
            <th style="padding:0.4rem 0.6rem">Graduated</th>
            <th style="padding:0.4rem 0.6rem">Launched</th>
          </tr>
        </thead>
        <tbody>
          ${coins.map(c => `
            <tr style="border-top:1px solid rgba(255,255,255,0.06)">
              <td style="padding:0.4rem 0.6rem;font-weight:600">$${escHtml(c.symbol || '—')}</td>
              <td style="padding:0.4rem 0.6rem;color:rgba(255,255,255,0.7)">${escHtml(c.name || '—')}</td>
              <td style="padding:0.4rem 0.6rem;color:rgba(255,255,255,0.5)">${escHtml(c.network || 'mainnet')}</td>
              <td style="padding:0.4rem 0.6rem">${c.total_claimed_lamports ? (Number(c.total_claimed_lamports) / 1e9).toFixed(4) : '0'}</td>
              <td style="padding:0.4rem 0.6rem">${c.is_graduated ? '<span style="color:#34d399">Yes</span>' : '<span style="color:rgba(255,255,255,0.3)">No</span>'}</td>
              <td style="padding:0.4rem 0.6rem;color:rgba(255,255,255,0.4)">${c.created_at ? new Date(c.created_at).toLocaleDateString() : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  }

  function renderClaimableFees(coins) {
    const wrap = document.getElementById('claimable-fees-table-wrap');
    if (!wrap) return;
    const withFees = coins.filter(c => Number(c.claimable_lamports) > 0);
    if (!withFees.length) {
      wrap.innerHTML = '<div class="muted">No claimable fees yet. Fees accumulate as your coins trade.</div>';
      return;
    }
    wrap.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:0.78rem">
        <thead>
          <tr style="color:rgba(255,255,255,0.4);text-align:left">
            <th style="padding:0.4rem 0.6rem">Symbol</th>
            <th style="padding:0.4rem 0.6rem">Claimable (SOL)</th>
            <th style="padding:0.4rem 0.6rem">Auto-Claim</th>
            <th style="padding:0.4rem 0.6rem">Last Checked</th>
          </tr>
        </thead>
        <tbody>
          ${withFees.map(c => `
            <tr style="border-top:1px solid rgba(255,255,255,0.06)">
              <td style="padding:0.4rem 0.6rem;font-weight:600">$${escHtml(c.symbol || '—')}</td>
              <td style="padding:0.4rem 0.6rem;color:#34d399">${(Number(c.claimable_lamports) / 1e9).toFixed(4)}</td>
              <td style="padding:0.4rem 0.6rem">${c.auto_claim_enabled ? '<span style="color:#60a5fa">On</span>' : '<span style="color:rgba(255,255,255,0.3)">Off</span>'}</td>
              <td style="padding:0.4rem 0.6rem;color:rgba(255,255,255,0.4)">${c.last_fee_check_at ? new Date(c.last_fee_check_at).toLocaleDateString() : 'Never'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>`;
  }

  // Wire reinvest slider display
  const reinvest = document.getElementById('auto-claim-reinvest');
  const reinvestVal = document.getElementById('auto-claim-reinvest-val');
  if (reinvest && reinvestVal) {
    reinvest.addEventListener('input', () => { reinvestVal.textContent = `${reinvest.value}%`; });
  }

  await loadLauncher();

  const saveBtn = document.getElementById('launcher-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      setStatus('Saving…');
      const g = id => document.getElementById(id);
      const body = {
        agentId,
        enabled: g('launcher-enabled')?.checked ?? false,
        network: g('launcher-network')?.value || 'mainnet',
        interval_hours: g('launcher-interval-hours')?.value !== '' ? Number(g('launcher-interval-hours').value) : null,
        max_launches: g('launcher-max-launches')?.value !== '' ? Number(g('launcher-max-launches').value) : null,
        name_template: g('launcher-name-template')?.value || '',
        symbol: (g('launcher-symbol')?.value || '').toUpperCase(),
        description: g('launcher-description')?.value || null,
        image_url: g('launcher-image-url')?.value || null,
        twitter: g('launcher-twitter')?.value || null,
        telegram: g('launcher-telegram')?.value || null,
        website: g('launcher-website')?.value || null,
        initial_buy_sol: g('launcher-initial-buy')?.value !== '' ? Number(g('launcher-initial-buy').value) : 0,
        auto_claim_enabled: g('auto-claim-enabled')?.checked ?? false,
        auto_claim_threshold_sol: g('auto-claim-threshold')?.value !== '' ? Number(g('auto-claim-threshold').value) : 0.5,
        auto_claim_reinvest_pct: g('auto-claim-reinvest')?.value !== '' ? Number(g('auto-claim-reinvest').value) : 0,
      };
      try {
        const r = await apiFetch(`${API_BASE}/agent/launcher`, {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message || j.error || 'Save failed');
        setStatus('Saved');
        await loadLauncher();
      } catch (err) {
        setStatus(err.message, false);
      } finally {
        saveBtn.disabled = false;
      }
    });
  }

  // Auto-claim save mirrors launcher save (same endpoint, same config row)
  const acSaveBtn = document.getElementById('auto-claim-save');
  if (acSaveBtn) {
    acSaveBtn.addEventListener('click', () => {
      if (saveBtn) saveBtn.click();
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MARKET MAKER — wired to /api/agent/market-maker
// ═══════════════════════════════════════════════════════════════════════════

async function initMarketMaker() {
  if (!agentId) return;
  const addStatusEl = document.getElementById('mm-add-status');
  function setAddStatus(msg, ok = true) {
    if (!addStatusEl) return;
    addStatusEl.textContent = msg;
    addStatusEl.style.color = ok ? 'rgba(255,255,255,0.6)' : '#f87171';
    if (msg) setTimeout(() => { addStatusEl.textContent = ''; }, 4000);
  }

  // Spread slider display
  const spreadSlider = document.getElementById('mm-spread');
  const spreadVal = document.getElementById('mm-spread-val');
  if (spreadSlider && spreadVal) {
    spreadSlider.addEventListener('input', () => {
      spreadVal.textContent = `${(Number(spreadSlider.value) / 100).toFixed(2)}%`;
    });
  }

  async function loadMarkets() {
    const wrap = document.getElementById('active-markets-table-wrap');
    if (!wrap) return;
    try {
      const r = await apiFetch(`${API_BASE}/agent/market-maker?agentId=${agentId}`, { credentials: 'include' });
      if (!r.ok) { wrap.innerHTML = '<div class="muted">Could not load markets.</div>'; return; }
      const { configs = [] } = await r.json();
      const active = configs.filter(c => c.enabled);
      if (!active.length) {
        wrap.innerHTML = '<div class="muted">No active markets. Add one above.</div>';
        return;
      }
      wrap.innerHTML = `
        <table style="width:100%;border-collapse:collapse;font-size:0.78rem">
          <thead>
            <tr style="color:rgba(255,255,255,0.4);text-align:left">
              <th style="padding:0.4rem 0.6rem">Symbol</th>
              <th style="padding:0.4rem 0.6rem">Spread</th>
              <th style="padding:0.4rem 0.6rem">Order Size</th>
              <th style="padding:0.4rem 0.6rem">Inventory</th>
              <th style="padding:0.4rem 0.6rem">P&amp;L (SOL)</th>
              <th style="padding:0.4rem 0.6rem">MEV Tip</th>
              <th style="padding:0.4rem 0.6rem"></th>
            </tr>
          </thead>
          <tbody>
            ${active.map(c => `
              <tr style="border-top:1px solid rgba(255,255,255,0.06)" data-mm-id="${escHtml(c.id)}">
                <td style="padding:0.4rem 0.6rem;font-weight:600">${escHtml(c.symbol || c.mint.slice(0, 6))}</td>
                <td style="padding:0.4rem 0.6rem">${(Number(c.spread_bps) / 100).toFixed(2)}%</td>
                <td style="padding:0.4rem 0.6rem">${Number(c.order_size_sol).toFixed(3)} SOL</td>
                <td style="padding:0.4rem 0.6rem">${Number(c.current_inventory_sol || 0).toFixed(3)} / ${Number(c.max_inventory_sol).toFixed(3)}</td>
                <td style="padding:0.4rem 0.6rem;color:${Number(c.total_pnl_sol) >= 0 ? '#34d399' : '#f87171'}">${Number(c.total_pnl_sol || 0).toFixed(4)}</td>
                <td style="padding:0.4rem 0.6rem;color:rgba(255,255,255,0.5)">${escHtml(c.mev_tip_mode || 'off')}</td>
                <td style="padding:0.4rem 0.6rem">
                  <button class="btn-ghost mm-remove-btn" style="font-size:0.7rem;padding:0.25rem 0.6rem" data-id="${escHtml(c.id)}">Remove</button>
                </td>
              </tr>
            `).join('')}
          </tbody>
        </table>`;
      wrap.querySelectorAll('.mm-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            const r = await apiFetch(`${API_BASE}/agent/market-maker?id=${encodeURIComponent(btn.dataset.id)}`, {
              method: 'DELETE', credentials: 'include',
            });
            if (!r.ok) { const j = await r.json(); throw new Error(j.message || 'Failed'); }
            await loadMarkets();
          } catch (err) {
            setAddStatus(err.message, false);
            btn.disabled = false;
          }
        });
      });
    } catch { wrap.innerHTML = '<div class="muted">Failed to load markets.</div>'; }
  }

  await loadMarkets();

  const addBtn = document.getElementById('mm-add-market');
  if (addBtn) {
    addBtn.addEventListener('click', async () => {
      addBtn.disabled = true;
      setAddStatus('Adding…');
      const g = id => document.getElementById(id);
      const body = {
        agentId,
        mint: g('mm-mint')?.value?.trim() || '',
        symbol: (g('mm-symbol')?.value || '').toUpperCase(),
        spread_bps: Number(g('mm-spread')?.value || 200),
        order_size_sol: Number(g('mm-order-size')?.value || 0.05),
        max_inventory_sol: Number(g('mm-max-inventory')?.value || 1.0),
        rebalance_interval_ms: Number(g('mm-rebalance')?.value || 30) * 1000,
        mev_tip_mode: g('mm-mev-tip')?.value || 'economy',
      };
      if (!body.mint) { setAddStatus('Mint address is required', false); addBtn.disabled = false; return; }
      try {
        const r = await apiFetch(`${API_BASE}/agent/market-maker`, {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j.message || j.error || 'Add failed');
        setAddStatus('Market added');
        if (g('mm-mint')) g('mm-mint').value = '';
        if (g('mm-symbol')) g('mm-symbol').value = '';
        await loadMarkets();
      } catch (err) {
        setAddStatus(err.message, false);
      } finally {
        addBtn.disabled = false;
      }
    });
  }
}

init();
