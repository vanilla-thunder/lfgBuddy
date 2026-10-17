'use strict';

// Persistent client ID — survives restarts, unique per machine
const clientId = localStorage.getItem('lfg_client_id') || (() => {
  const id = crypto.randomUUID();
  localStorage.setItem('lfg_client_id', id);
  return id;
})();

const serverUrl = window.lfg.serverUrl.replace(/\/+$/, '');
let state = { activityId: null, encounterIndex: 0, encounters: {}, isAdmin: false, adminToken: null, guidedMode: false, overlayVisible: true };
let manifest = { activities: [] };
let isInteractive = false;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const setupScreen       = document.getElementById('setup-screen');
const overlayScreen     = document.getElementById('overlay-screen');
const statusBar         = document.getElementById('status-bar');
const nameInput         = document.getElementById('player-name');
const roomCodeInput     = document.getElementById('room-code');
const connectBtn        = document.getElementById('connect-btn');
const activityPickerView = document.getElementById('activity-picker-view');
const activityPicker    = document.getElementById('activity-picker');
const activityControls  = document.getElementById('activity-controls');
const backToActivitiesBtn = document.getElementById('back-to-activities-btn');
const encounterPrevBtn  = document.getElementById('encounter-prev-btn');
const encounterResetBtn = document.getElementById('encounter-reset-btn');
const encounterNextBtn  = document.getElementById('encounter-next-btn');
const encounterLabel    = document.getElementById('encounter-label');
const encounterImage    = document.getElementById('encounter-image');
const areaLayer         = document.getElementById('area-layer');
const iconPicker        = document.getElementById('icon-picker');
const disconnectBtn     = document.getElementById('disconnect-btn');
const adminLinkRow      = document.getElementById('admin-link-row');
const copyAdminLinkBtn  = document.getElementById('copy-admin-link-btn');
const adminQrBtn        = document.getElementById('admin-qr-btn');
const readyCheckBtn     = document.getElementById('ready-check-btn');
const reconnectBanner   = document.getElementById('reconnect-banner');
// Two copies: one above the activity picker, one in the encounter nav row.
const guidedToggles         = document.querySelectorAll('.guided-toggle');
const guidedModeCheckboxes  = document.querySelectorAll('.guided-mode-checkbox');

const drawingBoard = createDrawingBoard({
  wrap: document.getElementById('encounter-wrap'),
  canvas: document.getElementById('draw-canvas'),
  toolbar: document.getElementById('draw-toolbar'),
  getCurrent() {
    const encounter = getCurrentEncounter();
    return encounter ? { encounterId: encounter.id, encounterState: ensureEncounterState(encounter.id) } : null;
  },
  canDraw: canInteract,
  emit: (event, data) => window.lfg.emit(event, data),
});

// Last member list from the server. The overlay shows no member list of
// its own — only the ready-check view, which replaces the board while a
// check runs and is derived from it.
let currentMembers = [];
// Last values sent to the main process, so it only hears about changes.
let lastOverlayVisible = null;
let lastReadyPending = false;
const readyView = createReadyCheckView({
  host: document.getElementById('board-panel'),
  container: document.getElementById('ready-check'),
  emit: (event, data) => window.lfg.emit(event, data),
  isAdmin: () => isAdmin(),
});

// ── Restore saved settings ────────────────────────────────────────────────────

localStorage.removeItem('lfg_server'); // no longer user-configurable
nameInput.value = localStorage.getItem('lfg_name') || '';
roomCodeInput.value = localStorage.getItem('lfg_room') || '';

// Admin token from an lfgbuddy:// link, kept until the next connect — the
// link may arrive before a name was entered.
let pendingAdminToken = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(msg, type = '') {
  statusBar.textContent = msg;
  statusBar.className = 'status-bar' + (type ? ` ${type}` : '');
}

function assetUrl(path) {
  return `${serverUrl}${path}`;
}

// ── Activity / encounter model ───────────────────────────────────────────────

function getCurrentActivity() {
  return manifest.activities.find((a) => a.id === state.activityId) ?? null;
}

function getCurrentEncounter() {
  return getCurrentActivity()?.encounters[state.encounterIndex] ?? null;
}

function getEncounterState(encounterId) {
  return state.encounters[encounterId] ?? emptyEncounterState();
}

function emptyEncounterState() {
  return { icons: {}, svg: [], strokes: [], imageHidden: false };
}

// Like getEncounterState, but stores the fresh state for an untouched
// encounter, so updates applied to it (e.g. own strokes) persist.
function ensureEncounterState(encounterId) {
  state.encounters[encounterId] ??= emptyEncounterState();
  return state.encounters[encounterId];
}

// Whether this client is a room admin is decided by the server (first
// joiner, a member promoted when all admins left, or a device that joined
// via an admin link) and sent only to this client — never decided locally,
// and no client ever learns another's ID. Guided mode, once an admin turns
// it on, restricts everyone else to read-only; this only gates the UI, the
// server enforces it authoritatively regardless of what a client sends.
function isAdmin() {
  return state.isAdmin === true;
}

function isLocked() {
  return state.guidedMode && !isAdmin();
}

// Interaction also requires the local INTERACTIVE hotkey mode (F9)
// — the overlay must be both unlocked locally and not read-only via guided
// mode.
function canInteract() {
  return isInteractive && !isLocked();
}

function renderPermissions() {
  for (const toggle of guidedToggles) toggle.classList.toggle('hidden', !isAdmin());
  for (const checkbox of guidedModeCheckboxes) checkbox.checked = state.guidedMode;
  adminLinkRow.classList.toggle('hidden', !isAdmin());
  if (!isAdmin()) hideAdminQr();
  areaLayer.classList.toggle('interactive', canInteract());
  activityPicker.classList.toggle('interactive', canInteract());
  backToActivitiesBtn.disabled = !canInteract();
  drawingBoard.updateControls();
  renderReadyCheck();
}

// Admins start a ready check from the footer's admin row; while it runs,
// the view in shared/ready-check.js replaces the board.
function renderReadyCheck() {
  readyCheckBtn.classList.toggle('hidden', isReadyCheckOpen(currentMembers));
  readyView.update(currentMembers);
  setReadyPending(currentMembers.find((m) => m.self)?.ready === 'pending');
}

// While a check waits for this user's answer, main.js brings up a hidden
// overlay; when that's over it restores the previous window state.
function setReadyPending(pending) {
  if (pending === lastReadyPending) return;
  lastReadyPending = pending;
  window.lfg.setReadyCheckPending(pending);
}

// Shown instead of the encounter view when the room has no activity chosen
// yet (e.g. a freshly created room, or after hitting "Back") — one card per
// active activity, its thumbnail as the background and its name overlaid
// as text. Sorted dungeons-then-raids, alphabetically within each group.
const ACTIVITY_TYPE_ORDER = { dungeon: 0, raid: 1 };

function renderActivityPicker() {
  const noActivity = !state.activityId;
  activityPickerView.classList.toggle('hidden', !noActivity);
  activityControls.classList.toggle('hidden', noActivity);
  if (!noActivity) return;

  const sortedActivities = manifest.activities
    .filter((a) => a.active)
    .sort((a, b) => {
      const typeDiff = (ACTIVITY_TYPE_ORDER[a.type] ?? 2) - (ACTIVITY_TYPE_ORDER[b.type] ?? 2);
      return typeDiff !== 0 ? typeDiff : a.name.localeCompare(b.name);
    });

  activityPicker.innerHTML = '';
  let lastType;
  for (const activity of sortedActivities) {
    if (lastType !== undefined && activity.type !== lastType) {
      const divider = document.createElement('div');
      divider.className = 'activity-picker-divider';
      activityPicker.appendChild(divider);
    }
    lastType = activity.type;

    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'activity-card';
    if (activity.thumbnail) card.style.backgroundImage = `url(${assetUrl(activity.thumbnail)})`;

    if (activity.type) {
      const badge = document.createElement('span');
      badge.className = 'activity-card-badge';
      badge.textContent = activity.type;
      card.appendChild(badge);
    }

    const label = document.createElement('span');
    label.className = 'activity-card-name';
    label.textContent = activity.name;
    card.appendChild(label);

    card.addEventListener('click', () => {
      if (!canInteract()) return;
      window.lfg.emit('select-activity', { activityId: activity.id });
    });
    activityPicker.appendChild(card);
  }
}

function findAreaEl(areaId) {
  return [...areaLayer.children].find((el) => el.dataset.areaId === areaId);
}

function findAreaDef(areaId) {
  return getCurrentEncounter()?.areas.find((a) => a.id === areaId) ?? null;
}

function findIcon(activity, optionListName, iconId) {
  return activity?.optionLists?.[optionListName]?.find((o) => o.id === iconId) ?? null;
}

// An option is rendered as an <img> when it has an `icon` (image path), or as
// plain emoji text otherwise — the two are mutually exclusive per option.
function renderIconContent(el, icon) {
  el.textContent = '';
  el.replaceChildren();
  if (!icon) return;
  if (icon.icon) {
    const img = document.createElement('img');
    img.className = 'icon-img';
    img.src = assetUrl(icon.icon);
    img.alt = icon.label ?? '';
    el.appendChild(img);
  } else if (icon.emoji) {
    el.textContent = icon.emoji;
  }
}

// ── Rendering ─────────────────────────────────────────────────────────────────

function renderEncounterNav() {
  const activity = getCurrentActivity();
  const total = activity?.encounters.length ?? 0;
  const encounter = getCurrentEncounter();
  encounterLabel.textContent = total
    ? `${activity.name} · ${encounter?.name ?? 'Encounter'} (${state.encounterIndex + 1}/${total})`
    : '';
  encounterPrevBtn.disabled = !canInteract() || state.encounterIndex <= 0;
  encounterNextBtn.disabled = !canInteract() || state.encounterIndex >= total - 1;
  encounterResetBtn.disabled = !canInteract() || total === 0;
}

// Area coordinates are absolute px offsets from the encounter image's edges.
// A non-negative x/y anchors from the left/top; negative anchors from the
// right/bottom instead (e.g. x: -5 = 5px from the right edge), so an area can
// stay pinned to a corner regardless of the image's rendered size.
function positionEl(el, box) {
  if (box.x < 0) {
    el.style.right = `${-box.x}px`;
    el.style.left = '';
  } else {
    el.style.left = `${box.x}px`;
    el.style.right = '';
  }
  if (box.y < 0) {
    el.style.bottom = `${-box.y}px`;
    el.style.top = '';
  } else {
    el.style.top = `${box.y}px`;
    el.style.bottom = '';
  }
  el.style.width = `${box.w}px`;
  el.style.height = `${box.h}px`;
}

function renderEncounter() {
  const encounter = getCurrentEncounter();
  areaLayer.innerHTML = '';
  if (!encounter) {
    encounterImage.removeAttribute('src');
    drawingBoard.render();
    return;
  }

  encounterImage.src = assetUrl(encounter.image);
  const activity = getCurrentActivity();
  const encounterState = getEncounterState(encounter.id);

  for (const area of encounter.areas) {
    if (area.type === 'icon-select') {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'area area-icon';
      positionEl(el, area);
      el.dataset.areaId = area.id;
      renderIconContent(el, findIcon(activity, area.optionList, encounterState.icons[area.id]));
      el.addEventListener('click', (e) => openIconPicker(e.currentTarget, area));
      areaLayer.appendChild(el);
    } else if (area.type === 'toggle-svg') {
      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'area area-toggle';
      positionEl(trigger, area.trigger);
      trigger.dataset.areaId = area.id;
      trigger.addEventListener('click', () => {
        if (canInteract()) window.lfg.emit('toggle-svg', { areaId: area.id });
      });
      areaLayer.appendChild(trigger);

      const overlay = document.createElement('img');
      overlay.className = 'area-overlay-svg' + (encounterState.svg.includes(area.id) ? '' : ' hidden');
      overlay.dataset.overlayFor = area.id;
      overlay.src = assetUrl(area.overlay.svg);
      overlay.alt = '';
      positionEl(overlay, area.overlay);
      areaLayer.appendChild(overlay);
    }
  }
  drawingBoard.render();
}

function applyIconUpdate({ encounterId, areaId, iconId }) {
  const encounterState = ensureEncounterState(encounterId);
  if (iconId === null) delete encounterState.icons[areaId];
  else encounterState.icons[areaId] = iconId;

  if (getCurrentEncounter()?.id === encounterId) {
    const el = findAreaEl(areaId);
    if (el) renderIconContent(el, findIcon(getCurrentActivity(), findAreaDef(areaId)?.optionList, iconId));
  }
}

function applySvgUpdate({ encounterId, areaId, visible }) {
  const encounterState = ensureEncounterState(encounterId);
  encounterState.svg = encounterState.svg.filter((id) => id !== areaId);
  if (visible) encounterState.svg.push(areaId);

  if (getCurrentEncounter()?.id === encounterId) {
    const overlay = areaLayer.querySelector(`[data-overlay-for="${CSS.escape(areaId)}"]`);
    if (overlay) overlay.classList.toggle('hidden', !visible);
  }
}

// ── Drawing board (shared/drawing.js) ────────────────────────────────────────

function applyStrokeAdded({ encounterId, stroke }) {
  ensureEncounterState(encounterId).strokes.push(stroke);
  if (getCurrentEncounter()?.id === encounterId) drawingBoard.appendStroke(stroke);
}

function applyStrokeErased({ encounterId, strokeId }) {
  const encounterState = ensureEncounterState(encounterId);
  encounterState.strokes = encounterState.strokes.filter((stroke) => stroke.id !== strokeId);
  if (getCurrentEncounter()?.id === encounterId) drawingBoard.render();
}

function applyDrawingCleared({ encounterId }) {
  ensureEncounterState(encounterId).strokes = [];
  if (getCurrentEncounter()?.id === encounterId) drawingBoard.render();
}

function applyImageHidden({ encounterId, hidden }) {
  ensureEncounterState(encounterId).imageHidden = hidden;
  if (getCurrentEncounter()?.id !== encounterId) return;
  // The areas are hidden along with the picture — don't leave an icon
  // picker open for one of them.
  if (hidden) iconPicker.classList.add('hidden');
  drawingBoard.render();
}

// ── Icon picker popup ────────────────────────────────────────────────────────

function pickIcon(areaId, iconId) {
  window.lfg.emit('set-icon', { areaId, iconId });
  iconPicker.classList.add('hidden');
}

function openIconPicker(anchorEl, area) {
  if (!canInteract()) return;
  const activity = getCurrentActivity();
  const options = activity?.optionLists?.[area.optionList] ?? [];
  iconPicker.innerHTML = '';

  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'icon-option icon-clear';
  clearBtn.textContent = '✕';
  clearBtn.title = 'Clear';
  clearBtn.addEventListener('click', () => pickIcon(area.id, null));
  iconPicker.appendChild(clearBtn);

  // Area groups (shared/area-groups.js): 'hide' leaves out options another
  // area of the group holds, 'move' shows them dimmed — picking moves them.
  const encounter = getCurrentEncounter();
  const icons = getEncounterState(encounter.id).icons;
  for (const { option: icon, heldBy } of groupPickerOptions(encounter, icons, area, options)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'icon-option';
    renderIconContent(btn, icon);
    btn.title = heldBy ? `${icon.label} — move from ${heldBy}` : icon.label;
    btn.classList.toggle('icon-held', heldBy !== null);
    btn.addEventListener('click', () => pickIcon(area.id, icon.id));
    iconPicker.appendChild(btn);
  }

  iconPicker.classList.remove('hidden');
  positionIconPicker(anchorEl);
}

// Clamp the popup so it never renders outside the (often small) window —
// measured after unhiding since it needs its own rendered size.
function positionIconPicker(anchorEl) {
  const anchorRect = anchorEl.getBoundingClientRect();
  const pickerRect = iconPicker.getBoundingClientRect();
  const margin = 4;

  let left = anchorRect.left + window.scrollX;
  let top = anchorRect.bottom + window.scrollY + margin;

  const maxLeft = window.scrollX + window.innerWidth - pickerRect.width - margin;
  left = Math.min(Math.max(left, window.scrollX + margin), Math.max(maxLeft, margin));

  if (top + pickerRect.height > window.scrollY + window.innerHeight) {
    top = anchorRect.top + window.scrollY - pickerRect.height - margin;
  }
  top = Math.max(top, window.scrollY + margin);

  // #icon-picker is itself inside the zoomed <html> (see overlay.css), so
  // getBoundingClientRect() values above are already scaled by that zoom
  // factor. Writing them straight back as style.left/top would get scaled
  // a second time on render, so divide it back out here.
  const zoom = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  iconPicker.style.left = `${left / zoom}px`;
  iconPicker.style.top = `${top / zoom}px`;
}

document.addEventListener('click', (e) => {
  if (!iconPicker.contains(e.target) && !e.target.closest('.area-icon')) {
    iconPicker.classList.add('hidden');
  }
});

// ── Connect flow ──────────────────────────────────────────────────────────────

// Every member needs a display name; it's remembered for next time (the
// server sanitizes it again). The member list itself is web-only.
function connectToRoom() {
  const name = nameInput.value.trim();
  const code = roomCodeInput.value.trim().toUpperCase();

  if (!name) {
    setStatus('Enter your name to join.', 'error');
    nameInput.focus();
    return;
  }
  if (!code) {
    setStatus('Room code is required.', 'error');
    return;
  }

  localStorage.setItem('lfg_name', name);
  localStorage.setItem('lfg_room', code);

  setStatus('Connecting…', 'info');
  connectBtn.disabled = true;

  window.lfg.connect(code, clientId, pendingAdminToken, name);
  pendingAdminToken = null;
}

function leaveRoom() {
  window.lfg.disconnect();
  overlayScreen.classList.add('hidden');
  setupScreen.classList.remove('hidden');
  connectBtn.disabled = false;
  state = { activityId: null, encounterIndex: 0, encounters: {}, isAdmin: false, adminToken: null, guidedMode: false, overlayVisible: true };
  iconPicker.classList.add('hidden');
  hideAdminQr();
  currentMembers = [];
  readyView.hide();
  setReadyPending(false);
  setStatus('');
}

connectBtn.addEventListener('click', () => connectToRoom());
disconnectBtn.addEventListener('click', leaveRoom);

// lfgbuddy://join/<code>[?admin=<token>] link (validated in main.js) —
// joins on the mode's fixed server, leaving the current room first if
// already in one.
window.lfg.onJoinRoom((code, adminToken) => {
  if (!overlayScreen.classList.contains('hidden')) leaveRoom();
  roomCodeInput.value = code;
  pendingAdminToken = adminToken;
  connectToRoom();
});

// Admin link for another device of this admin (e.g. a phone): the web
// invite link on this mode's server plus the room's admin token. The token
// goes in the fragment, so it never shows up in HTTP requests or logs.
function adminLink() {
  const code = localStorage.getItem('lfg_room');
  if (!code || !state.adminToken) return null;
  return `${serverUrl}/${encodeURIComponent(code.toLowerCase())}#admin=${state.adminToken}`;
}

copyAdminLinkBtn.addEventListener('click', () => {
  const link = adminLink();
  if (!link) return;
  window.lfg.copyText(link);
  copyAdminLinkBtn.textContent = 'Copied!';
  setTimeout(() => { copyAdminLinkBtn.textContent = 'Copy Admin Link'; }, 1500);
});

readyCheckBtn.addEventListener('click', () => {
  window.lfg.emit('start-ready-check', {});
});

adminQrBtn.addEventListener('click', () => {
  const link = adminLink();
  if (link) showAdminQr(link);
});

// ── Socket events ─────────────────────────────────────────────────────────────

window.lfg.on('connect', () => {
  reconnectBanner.classList.add('hidden');
  setStatus('');
});

window.lfg.on('connect_error', () => {
  if (!overlayScreen.classList.contains('hidden')) return;
  setStatus('Could not reach server.', 'error');
  connectBtn.disabled = false;
});

window.lfg.on('disconnect', () => {
  if (overlayScreen.classList.contains('hidden')) return;
  reconnectBanner.classList.remove('hidden');
});

window.lfg.on('activities-manifest', (m) => {
  manifest = m;
  renderPermissions();
  renderActivityPicker();
  renderEncounterNav();
  renderEncounter();
});

window.lfg.on('state-sync', (newState) => {
  state = newState;
  setupScreen.classList.add('hidden');
  overlayScreen.classList.remove('hidden');
  reconnectBanner.classList.add('hidden');
  renderPermissions();
  renderActivityPicker();
  renderEncounterNav();
  renderEncounter();
  // Only on an actual change of the room's remote visibility — re-applying
  // it on every state-sync would re-show an overlay hidden with F8 (or by
  // a ready check returning to its previous state) on any room change.
  const overlayVisible = state.overlayVisible !== false;
  if (overlayVisible !== lastOverlayVisible) {
    lastOverlayVisible = overlayVisible;
    window.lfg.setOverlayVisible(overlayVisible);
  }
});

window.lfg.on('icon-updated', (payload) => applyIconUpdate(payload));
window.lfg.on('svg-updated', (payload) => applySvgUpdate(payload));
window.lfg.on('members', ({ members }) => {
  currentMembers = members;
  renderReadyCheck();
});
window.lfg.on('ready-check-done', (result) => readyView.showResult(result));
window.lfg.on('stroke-added', (payload) => applyStrokeAdded(payload));
window.lfg.on('stroke-erased', (payload) => applyStrokeErased(payload));
window.lfg.on('drawing-cleared', (payload) => applyDrawingCleared(payload));
window.lfg.on('image-hidden-updated', (payload) => applyImageHidden(payload));

// ── Hotkey feedback from main process ─────────────────────────────────────────

window.lfg.onToggleInteractive((interactive) => {
  isInteractive = interactive;
  // Locked = click-through: the QR couldn't be closed by clicking, and the
  // overlay is most likely on screen over the game (and maybe on stream).
  if (!interactive) {
    iconPicker.classList.add('hidden');
    hideAdminQr();
  }
  renderPermissions();
  renderEncounterNav();
  document.body.classList.toggle('interactive-mode', interactive);
});

// ── Guided mode ───────────────────────────────────────────────────────────────

for (const checkbox of guidedModeCheckboxes) {
  checkbox.addEventListener('change', () => {
    window.lfg.emit('set-guided-mode', { enabled: checkbox.checked });
  });
}

// ── Back to activity picker ──────────────────────────────────────────────────

backToActivitiesBtn.addEventListener('click', () => {
  window.lfg.emit('select-activity', { activityId: null });
});

// ── Encounter navigation ─────────────────────────────────────────────────────

encounterPrevBtn.addEventListener('click', () => {
  if (state.encounterIndex > 0) window.lfg.emit('set-encounter', { encounterIndex: state.encounterIndex - 1 });
});

encounterNextBtn.addEventListener('click', () => {
  const total = getCurrentActivity()?.encounters.length ?? 0;
  if (state.encounterIndex < total - 1) window.lfg.emit('set-encounter', { encounterIndex: state.encounterIndex + 1 });
});

encounterResetBtn.addEventListener('click', () => {
  window.lfg.emit('reset-encounter', {});
});

// Uppercase room code as user types
roomCodeInput.addEventListener('input', () => {
  const pos = roomCodeInput.selectionStart;
  roomCodeInput.value = roomCodeInput.value.toUpperCase();
  roomCodeInput.setSelectionRange(pos, pos);
});
