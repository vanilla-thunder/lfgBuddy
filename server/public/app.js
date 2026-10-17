'use strict';

// Persistent client ID — unique per browser profile
const clientId = localStorage.getItem('lfg_client_id') || (() => {
  const id = crypto.randomUUID();
  localStorage.setItem('lfg_client_id', id);
  return id;
})();

let currentRoomId = null;
let state = { activityId: null, encounterIndex: 0, encounters: {}, isAdmin: false, adminToken: null, guidedMode: false, overlayVisible: true };
let manifest = { activities: [] };
let socket = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────

const setupScreen      = document.getElementById('setup-screen');
const roomScreen       = document.getElementById('room-screen');
const nameInput        = document.getElementById('player-name');
const roomCodeInput    = document.getElementById('room-code');
const connectBtn       = document.getElementById('connect-btn');
const statusMsg        = document.getElementById('status-msg');
const roomDisplay      = document.getElementById('room-display');
const memberList       = document.getElementById('member-list');
const activityPicker    = document.getElementById('activity-picker');
const activityControls  = document.getElementById('activity-controls');
const backToActivitiesBtn = document.getElementById('back-to-activities-btn');
const encounterPrevBtn  = document.getElementById('encounter-prev-btn');
const encounterResetBtn = document.getElementById('encounter-reset-btn');
const encounterNextBtn  = document.getElementById('encounter-next-btn');
const encounterLabel    = document.getElementById('encounter-label');
const encounterImage    = document.getElementById('encounter-image');
const areaLayer        = document.getElementById('area-layer');
const iconPicker       = document.getElementById('icon-picker');
const disconnectBtn    = document.getElementById('disconnect-btn');
const copyLinkBtn      = document.getElementById('copy-link-btn');
const copyAdminLinkBtn = document.getElementById('copy-admin-link-btn');
const adminQrBtn       = document.getElementById('admin-qr-btn');
const readyCheckBtn    = document.getElementById('ready-check-btn');
const openInAppLink    = document.getElementById('open-in-app-link');
const reconnectBanner  = document.getElementById('reconnect-banner');
const guidedToggle       = document.getElementById('guided-toggle');
const guidedModeCheckbox = document.getElementById('guided-mode-checkbox');

const drawingBoard = createDrawingBoard({
  wrap: document.getElementById('encounter-wrap'),
  canvas: document.getElementById('draw-canvas'),
  toolbar: document.getElementById('draw-toolbar'),
  getCurrent() {
    const encounter = getCurrentEncounter();
    return encounter ? { encounterId: encounter.id, encounterState: ensureEncounterState(encounter.id) } : null;
  },
  canDraw: () => Boolean(socket?.connected) && canInteract(),
  emit: (event, data) => socket?.connected && socket.emit(event, data),
});

// Last member list from the server — also the source of ready-check state.
let currentMembers = [];
const readyView = createReadyCheckView({
  host: document.getElementById('board-panel'),
  container: document.getElementById('ready-check'),
  emit: (event, data) => socket?.connected && socket.emit(event, data),
  isAdmin: () => isAdmin(),
});

// ── Restore saved values ──────────────────────────────────────────────────────

nameInput.value = localStorage.getItem('lfg_name') || '';
roomCodeInput.value = localStorage.getItem('lfg_room') || '';

// An invite link (e.g. lfg.example.com/oida) auto-joins that room (see the
// connectToRoom(pathCode) call below); the code is also pre-filled into the
// input so it's still there if that connection attempt fails and the user
// retries manually. Takes priority over whatever was last used on this browser.
const ROOM_CODE_PATH_RE = /^[A-Za-z0-9_-]{1,32}$/;
const pathCode = decodeURIComponent(location.pathname.slice(1));
if (ROOM_CODE_PATH_RE.test(pathCode)) {
  roomCodeInput.value = pathCode.toUpperCase();
}

// An admin link (<invite link>#admin=<token>) makes the opening device a
// room admin too. The token sits in the fragment, so it never reaches the
// server in an HTTP request (or its access logs) — only in the socket join.
// It's dropped from the address bar by the first state-sync's replaceState.
const ADMIN_TOKEN_RE = /^[0-9a-f]{32}$/;
let pendingAdminToken = new URLSearchParams(location.hash.slice(1)).get('admin');
if (!ADMIN_TOKEN_RE.test(pendingAdminToken ?? '')) pendingAdminToken = null;

function invitePathFor(code) {
  return `/${encodeURIComponent(code.toLowerCase())}`;
}

function inviteLinkFor(code) {
  return `${location.origin}${invitePathFor(code)}`;
}

function adminLinkFor(code, adminToken) {
  return `${inviteLinkFor(code)}#admin=${adminToken}`;
}

// Deep link for the Electron overlay: this page's invite link with
// lfgbuddy:// instead of https:// (see parseJoinLink in main.js, which
// re-validates it and asks before using a server for the first time). For
// admins it carries the admin token, so their own overlay becomes admin too.
function appLinkFor(code, adminToken) {
  const link = `lfgbuddy://${location.host}${invitePathFor(code)}`;
  return adminToken ? `${link}#admin=${adminToken}` : link;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function setStatus(msg, type = '') {
  statusMsg.textContent = msg;
  statusMsg.className = 'status-msg' + (type ? ` ${type}` : '');
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

function canInteract() {
  return !isLocked();
}

function renderPermissions() {
  guidedToggle.classList.toggle('hidden', !isAdmin());
  guidedModeCheckbox.checked = state.guidedMode;
  copyAdminLinkBtn.classList.toggle('hidden', !isAdmin());
  adminQrBtn.classList.toggle('hidden', !isAdmin());
  if (!isAdmin()) hideAdminQr();
  areaLayer.classList.toggle('interactive', canInteract());
  activityPicker.classList.toggle('interactive', canInteract());
  backToActivitiesBtn.disabled = !canInteract();
  drawingBoard.updateControls();
  renderReadyCheck();
}

// Admins start a ready check from the header; while it runs, the view in
// shared/ready-check.js (member cards, answer buttons, abort) replaces the
// board.
function renderReadyCheck() {
  readyCheckBtn.classList.toggle('hidden', !isAdmin() || isReadyCheckOpen(currentMembers));
  readyView.update(currentMembers);
}

// Shown instead of the encounter view when the room has no activity chosen
// yet (e.g. a freshly created room, or after hitting "Back") — one card per
// active activity, its thumbnail as the background and its name overlaid
// as text. Sorted dungeons-then-raids, alphabetically within each group.
const ACTIVITY_TYPE_ORDER = { dungeon: 0, raid: 1 };

function renderActivityPicker() {
  const noActivity = !state.activityId;
  activityPicker.classList.toggle('hidden', !noActivity);
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
    if (activity.thumbnail) card.style.backgroundImage = `url(${activity.thumbnail})`;

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
      if (!canInteract() || !socket?.connected) return;
      socket.emit('select-activity', { activityId: activity.id });
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
    img.src = icon.icon;
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
  encounterResetBtn.disabled = !canInteract();
}

function renderEncounter() {
  const encounter = getCurrentEncounter();
  areaLayer.innerHTML = '';
  if (!encounter) {
    encounterImage.removeAttribute('src');
    drawingBoard.render();
    return;
  }

  encounterImage.src = encounter.image;
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
      trigger.title = 'Toggle';
      trigger.addEventListener('click', () => {
        if (socket?.connected && canInteract()) socket.emit('toggle-svg', { areaId: area.id });
      });
      areaLayer.appendChild(trigger);

      const overlay = document.createElement('img');
      overlay.className = 'area-overlay-svg' + (encounterState.svg.includes(area.id) ? '' : ' hidden');
      overlay.dataset.overlayFor = area.id;
      overlay.src = area.overlay.svg;
      overlay.alt = '';
      positionEl(overlay, area.overlay);
      areaLayer.appendChild(overlay);
    }
  }
  drawingBoard.render();
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

// ── Member list (web only) ───────────────────────────────────────────────────

// Names are user input: rendered via textContent only, never as HTML.
function renderMembers(members) {
  currentMembers = members;
  renderReadyCheck();
  memberList.replaceChildren();
  for (const member of members) {
    const chip = document.createElement('span');
    chip.className = 'member';
    chip.classList.toggle('offline', !member.online);
    chip.classList.toggle('self', member.self);
    chip.title = [member.isAdmin && 'Admin', !member.online && 'Reconnecting…'].filter(Boolean).join(' · ');
    chip.textContent = `${readyMark(member)}${member.isAdmin ? '👑 ' : ''}${member.name}${member.self ? ' (you)' : ''}`;
    memberList.appendChild(chip);
  }
}

// ── Icon picker popup ────────────────────────────────────────────────────────

function pickIcon(areaId, iconId) {
  if (socket?.connected) socket.emit('set-icon', { areaId, iconId });
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

// Clamp the popup so it never renders outside the viewport — measured
// after unhiding since it needs its own rendered size.
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

  iconPicker.style.left = `${left}px`;
  iconPicker.style.top = `${top}px`;
}

document.addEventListener('click', (e) => {
  if (!iconPicker.contains(e.target) && !e.target.closest('.area-icon')) {
    iconPicker.classList.add('hidden');
  }
});

// ── Connect ───────────────────────────────────────────────────────────────────

// Every member needs a display name; it's remembered for next time. The
// server sanitizes it again — this is only for a friendly prompt.
function connectToRoom(code) {
  const name = nameInput.value.trim();
  if (!name) {
    setStatus('Enter your name to join.', 'error');
    nameInput.focus();
    return;
  }
  localStorage.setItem('lfg_name', name);

  currentRoomId = code;
  localStorage.setItem('lfg_room', code);

  setStatus('Connecting…', 'info');
  connectBtn.disabled = true;

  // Connect to same origin — no URL needed
  socket = io({ reconnection: true, reconnectionDelay: 2000 });

  socket.on('connect', () => {
    socket.emit('join', { roomId: code, clientId, adminToken: pendingAdminToken, name });
    reconnectBanner.classList.add('hidden');
  });

  socket.on('activities-manifest', (m) => {
    manifest = m;
    renderPermissions();
    renderActivityPicker();
    renderEncounterNav();
    renderEncounter();
  });

  socket.on('state-sync', (newState) => {
    state = newState;
    // Used once: from here on the server knows this client as an admin.
    pendingAdminToken = null;
    setupScreen.classList.add('hidden');
    roomScreen.classList.remove('hidden');
    roomDisplay.textContent = currentRoomId;
    renderPermissions();
    renderActivityPicker();
    renderEncounterNav();
    renderEncounter();
    setStatus('');
    history.replaceState(null, '', invitePathFor(currentRoomId));
    openInAppLink.href = appLinkFor(currentRoomId, state.adminToken);
  });

  socket.on('members', ({ members }) => renderMembers(members));
  socket.on('ready-check-done', (result) => readyView.showResult(result));
  socket.on('icon-updated', (payload) => applyIconUpdate(payload));
  socket.on('svg-updated', (payload) => applySvgUpdate(payload));
  socket.on('stroke-added', (payload) => applyStrokeAdded(payload));
  socket.on('stroke-erased', (payload) => applyStrokeErased(payload));
  socket.on('drawing-cleared', (payload) => applyDrawingCleared(payload));
  socket.on('image-hidden-updated', (payload) => applyImageHidden(payload));

  socket.on('disconnect', () => {
    reconnectBanner.classList.remove('hidden');
    drawingBoard.updateControls();
  });

  socket.on('connect_error', () => {
    if (!roomScreen.classList.contains('hidden')) return;
    setStatus('Could not connect to server.', 'error');
    connectBtn.disabled = false;
    socket.disconnect();
    socket = null;
  });
}

connectBtn.addEventListener('click', () => {
  const code = roomCodeInput.value.trim().toUpperCase();

  if (!code) {
    setStatus('Room code is required.', 'error');
    return;
  }

  connectToRoom(code);
});

// Opening an invite link (e.g. lfg.example.com/oida) joins that room right
// away, instead of just pre-filling the input and waiting for a click.
if (ROOM_CODE_PATH_RE.test(pathCode)) {
  connectToRoom(pathCode.toUpperCase());
}

// ── Disconnect ────────────────────────────────────────────────────────────────

disconnectBtn.addEventListener('click', () => {
  if (socket) { socket.disconnect(); socket = null; }
  roomScreen.classList.add('hidden');
  setupScreen.classList.remove('hidden');
  connectBtn.disabled = false;
  state = { activityId: null, encounterIndex: 0, encounters: {}, isAdmin: false, adminToken: null, guidedMode: false, overlayVisible: true };
  iconPicker.classList.add('hidden');
  hideAdminQr();
  renderMembers([]);
  readyView.hide();
  setStatus('');
  history.replaceState(null, '', '/');
});

// ── Copy invite link ──────────────────────────────────────────────────────────

async function copyLink(btn, link, promptText) {
  const original = btn.textContent;
  try {
    await navigator.clipboard.writeText(link);
    btn.textContent = 'Copied!';
  } catch {
    window.prompt(promptText, link);
  } finally {
    setTimeout(() => { btn.textContent = original; }, 1500);
  }
}

copyLinkBtn.addEventListener('click', () => {
  if (currentRoomId) copyLink(copyLinkBtn, inviteLinkFor(currentRoomId), 'Copy this invite link:');
});

copyAdminLinkBtn.addEventListener('click', () => {
  if (!currentRoomId || !state.adminToken) return;
  copyLink(copyAdminLinkBtn, adminLinkFor(currentRoomId, state.adminToken), 'Copy this admin link (keep it private):');
});

readyCheckBtn.addEventListener('click', () => {
  if (socket?.connected) socket.emit('start-ready-check', {});
});

adminQrBtn.addEventListener('click', () => {
  if (currentRoomId && state.adminToken) showAdminQr(adminLinkFor(currentRoomId, state.adminToken));
});

// ── Guided mode ───────────────────────────────────────────────────────────────

guidedModeCheckbox.addEventListener('change', () => {
  if (socket?.connected) socket.emit('set-guided-mode', { enabled: guidedModeCheckbox.checked });
});

// ── Back to activity picker ──────────────────────────────────────────────────

backToActivitiesBtn.addEventListener('click', () => {
  if (socket?.connected) socket.emit('select-activity', { activityId: null });
});

// ── Encounter navigation ─────────────────────────────────────────────────────

encounterPrevBtn.addEventListener('click', () => {
  if (socket?.connected && state.encounterIndex > 0) {
    socket.emit('set-encounter', { encounterIndex: state.encounterIndex - 1 });
  }
});

encounterNextBtn.addEventListener('click', () => {
  const total = getCurrentActivity()?.encounters.length ?? 0;
  if (socket?.connected && state.encounterIndex < total - 1) {
    socket.emit('set-encounter', { encounterIndex: state.encounterIndex + 1 });
  }
});

encounterResetBtn.addEventListener('click', () => {
  if (socket?.connected) socket.emit('reset-encounter', {});
});

// ── Uppercase room code as typed ─────────────────────────────────────────────

roomCodeInput.addEventListener('input', () => {
  const pos = roomCodeInput.selectionStart;
  roomCodeInput.value = roomCodeInput.value.toUpperCase();
  roomCodeInput.setSelectionRange(pos, pos);
});
