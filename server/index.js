'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const activities = require('./activities');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

const {
  activities: activityList,
  activitiesById,
  areasByActivityEncounter,
  groupsByActivityEncounter,
  optionIdsByActivity,
  mountStaticRoutes,
} = activities;

mountStaticRoutes(app);

// roomId -> {
//   activityId: string|null,
//   encounterIndex: number,
//   encounters: Map<encounterId, {
//     icons: Map<areaId, iconId>,
//     svg: Set<areaId>,
//     strokes: Array<{ id, color, points }>,
//     pointCount: number,
//     imageHidden: boolean,
//   }>,
//   members: Map<clientId, number>,  // open sockets per client
//   leaveTimers: Map<clientId, Timeout>,
//   names: Map<clientId, string>,     // display names, sanitized
//   readyCheck: Map<clientId, boolean|null> | null,  // running check: answer per member (null = pending)
//   adminClientIds: Set<clientId>,
//   adminToken: string,  // secret in admin links; joining with it grants admin
//   guidedMode: boolean,
//   overlayVisible: boolean,
// }
// `encounters` only holds entries for encounters a room has actually
// touched — a missing entry means that encounter is still blank. `members`
// tracks presence (for room lifecycle); the member list clients see (see
// serializeMembers) carries names and flags only, never client IDs. A client whose last socket closes stays a member for
// RECONNECT_GRACE_MS (`leaveTimers`), so a page reload or a brief network
// drop keeps its admin rights and doesn't wipe a room it's alone in.
//
// Admins: the first client to join, plus every client that joined with the
// room's `adminToken` (an admin link — e.g. the admin's own phone). If all
// admins leave, a remaining member is promoted. When `guidedMode` is on, only
// admins may mutate room state; enforced server-side in canAct(), never
// trusted from the client. Client IDs act as credentials, so they're never
// sent to other clients (state-sync only tells each client whether *it* is
// an admin) and only logged truncated.
const rooms = new Map();
const RECONNECT_GRACE_MS = 15000;
const MAX_NAME_LENGTH = 24;
const DEFAULT_NAME = 'Guest';

// Display names are free text from the client: drop control and invisible
// format characters (incl. bidi overrides, which could disguise a name),
// collapse whitespace, and cap the length in characters, not UTF-16 units.
// Clients render names as text only, never as HTML.
function sanitizeName(raw) {
  const name = String(raw ?? '').normalize('NFC').replace(/\s+/g, ' ').replace(/\p{C}/gu, '').trim();
  return [...name].slice(0, MAX_NAME_LENGTH).join('').trim() || DEFAULT_NAME;
}

function emptyEncounterState() {
  return { icons: new Map(), svg: new Set(), strokes: [], pointCount: 0, imageHidden: false };
}

// Drawing board limits — mirrored in the clients' drawing.js. Strokes are
// flat [x0, y0, x1, y1, …] integer arrays in board units (0..DRAW_COORD_MAX,
// relative to the encounter picture). The per-encounter budget bounds both
// room memory and the size of every state-sync broadcast. A stroke's `id`
// names the line it belongs to (client-generated; a long line is split into
// several strokes sharing it) and is what erase-stroke removes by.
const DRAW_STROKE_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const DRAW_COLOR_COUNT = 6;
const DRAW_COORD_MAX = 10000;
const MAX_STROKE_POINTS = 1000;
const MAX_ENCOUNTER_POINTS = 20000;
const MAX_ENCOUNTER_STROKES = 1000;

// Builds a fresh stroke from validated fields only, so nothing else a
// client sends ends up in room state or gets relayed to other members.
function parseStroke({ id, color, points }) {
  if (typeof id !== 'string' || !DRAW_STROKE_ID_RE.test(id)) return null;
  if (!Number.isInteger(color) || color < 0 || color >= DRAW_COLOR_COUNT) return null;
  if (!Array.isArray(points) || points.length < 2 || points.length % 2 !== 0) return null;
  if (points.length > MAX_STROKE_POINTS * 2) return null;
  if (!points.every((n) => Number.isInteger(n) && n >= 0 && n <= DRAW_COORD_MAX)) return null;
  return { id, color, points: points.slice() };
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      activityId: null,
      encounterIndex: 0,
      encounters: new Map(),
      members: new Map(),
      leaveTimers: new Map(),
      names: new Map(),
      readyCheck: null,
      adminClientIds: new Set(),
      adminToken: crypto.randomBytes(16).toString('hex'),
      guidedMode: false,
      overlayVisible: true,
    });
  }
  return rooms.get(roomId);
}

function isAdmin(room, clientId) {
  return room.adminClientIds.has(clientId);
}

function canAct(room, clientId) {
  return !room.guidedMode || isAdmin(room, clientId);
}

function isValidAdminToken(room, token) {
  if (typeof token !== 'string' || token.length !== room.adminToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(room.adminToken));
}

// Enough to tell clients apart in logs without leaking the credential.
function logId(clientId) {
  return clientId.slice(0, 8);
}

function getOrCreateEncounterState(room, encounterId) {
  if (!room.encounters.has(encounterId)) {
    room.encounters.set(encounterId, emptyEncounterState());
  }
  return room.encounters.get(encounterId);
}

// The room's current encounter is a shared, room-wide cursor (like
// activityId) — everyone in the room looks at the same encounter at the
// same time.
function currentEncounterId(room) {
  const activity = activitiesById.get(room.activityId);
  return activity?.encounters[room.encounterIndex]?.id ?? null;
}

// Per client: `isAdmin`/`adminToken` describe the receiving client only.
function serializeRoom(room, clientId) {
  const admin = isAdmin(room, clientId);
  return {
    activityId: room.activityId,
    encounterIndex: room.encounterIndex,
    encounters: Object.fromEntries(
      [...room.encounters.entries()].map(([encounterId, r]) => [
        encounterId,
        { icons: Object.fromEntries(r.icons), svg: [...r.svg], strokes: r.strokes, imageHidden: r.imageHidden },
      ])
    ),
    isAdmin: admin,
    adminToken: admin ? room.adminToken : null,
    guidedMode: room.guidedMode,
    overlayVisible: room.overlayVisible,
  };
}

// Member list for one receiving client, in join order. `self` marks the
// receiver's own entry; `online` is false during a member's reconnect grace
// period; `ready` is the member's ready-check answer ('ready' | 'not-ready'
// | 'pending'), or null while no check is running.
function serializeMembers(room, clientId) {
  return [...room.members].map(([memberId, sockets]) => ({
    name: room.names.get(memberId) ?? DEFAULT_NAME,
    isAdmin: isAdmin(room, memberId),
    online: sockets > 0,
    self: memberId === clientId,
    ready: readyStatus(room, memberId),
  }));
}

// ── Ready check ──────────────────────────────────────────────────────────────
// Started/aborted by admins only (regardless of guided mode); every member
// answers. No timeout: it ends when every current member has answered —
// members joining mid-check start as pending, members leaving (after their
// grace period) drop out — or when an admin aborts it.

function readyStatus(room, clientId) {
  if (!room.readyCheck) return null;
  const answer = room.readyCheck.get(clientId);
  if (answer === true) return 'ready';
  if (answer === false) return 'not-ready';
  return 'pending';
}

function endReadyCheck(roomId, room, outcome) {
  const answers = [...room.readyCheck.values()];
  room.readyCheck = null;
  io.to(roomId).emit('ready-check-done', {
    outcome, // 'complete' | 'aborted'
    ready: answers.filter((a) => a === true).length,
    notReady: answers.filter((a) => a === false).length,
    total: answers.length,
  });
}

// Callers broadcast the members list (with the final answers) before this,
// so clients' last snapshot of a running check is its result; and again
// after it if it returns true (answers cleared).
function completeReadyCheckIfAnswered(roomId, room) {
  if (!room.readyCheck || [...room.readyCheck.values()].some((a) => a === null)) return false;
  endReadyCheck(roomId, room, 'complete');
  return true;
}

function forEachRoomSocket(roomId, fn) {
  for (const socketId of io.sockets.adapter.rooms.get(roomId) ?? []) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) fn(socket);
  }
}

// state-sync and the member list differ per client (isAdmin/adminToken,
// self), so they're sent socket by socket instead of as one room broadcast.
function broadcastState(roomId, room) {
  forEachRoomSocket(roomId, (socket) => socket.emit('state-sync', serializeRoom(room, socket.data.clientId)));
}

function broadcastMembers(roomId, room) {
  forEachRoomSocket(roomId, (socket) => socket.emit('members', { members: serializeMembers(room, socket.data.clientId) }));
}

io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentClientId = null;

  socket.emit('activities-manifest', { activities: activityList });

  // Registers a client event handler that always gets a plain object
  // payload and can't take the process down: without this, one event sent
  // with no/invalid payload (e.g. emit('set-guided-mode')) threw inside
  // socket.io and crashed the server — every room for every user.
  function on(event, handler) {
    socket.on(event, (payload) => {
      try {
        handler(payload !== null && typeof payload === 'object' ? payload : {});
      } catch (err) {
        console.error(`[${currentRoomId ?? '-'}] ${event} handler failed:`, err);
      }
    });
  }

  // One join per socket — clients reconnect (and switch rooms) with a new
  // socket, and a second join would unbalance the member's socket count.
  on('join', ({ roomId, clientId, adminToken, name }) => {
    if (!roomId || !clientId || currentRoomId) return;

    currentRoomId = String(roomId).toUpperCase().slice(0, 32);
    currentClientId = String(clientId).slice(0, 64);
    socket.data.clientId = currentClientId;

    socket.join(currentRoomId);
    const room = getOrCreateRoom(currentRoomId);
    clearTimeout(room.leaveTimers.get(currentClientId));
    room.leaveTimers.delete(currentClientId);
    room.members.set(currentClientId, (room.members.get(currentClientId) ?? 0) + 1);
    room.names.set(currentClientId, sanitizeName(name));
    if (room.adminClientIds.size === 0 || isValidAdminToken(room, adminToken)) {
      room.adminClientIds.add(currentClientId);
    }
    if (room.readyCheck && !room.readyCheck.has(currentClientId)) room.readyCheck.set(currentClientId, null);

    socket.emit('state-sync', serializeRoom(room, currentClientId));
    broadcastMembers(currentRoomId, room);

    console.log(`[${currentRoomId}] ${logId(currentClientId)} joined (${room.members.size} members)`);
  });

  // activityId: null clears the room back to the activity picker; any other
  // value must be a real, currently-active activity.
  on('select-activity', ({ activityId }) => {
    if (!currentRoomId) return;
    if (activityId !== null && !activitiesById.get(activityId)?.active) return;
    const room = rooms.get(currentRoomId);
    if (!room || !canAct(room, currentClientId)) return;
    room.activityId = activityId;
    room.encounterIndex = 0;
    room.encounters.clear();
    broadcastState(currentRoomId, room);
  });

  on('set-encounter', ({ encounterIndex }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    const activity = activitiesById.get(room?.activityId);
    if (!room || !activity || !canAct(room, currentClientId)) return;
    if (!Number.isInteger(encounterIndex) || encounterIndex < 0 || encounterIndex >= activity.encounters.length) return;

    room.encounterIndex = encounterIndex;
    broadcastState(currentRoomId, room);
  });

  on('reset-encounter', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !canAct(room, currentClientId)) return;
    const encounterId = currentEncounterId(room);
    if (!encounterId) return;

    room.encounters.set(encounterId, emptyEncounterState());
    broadcastState(currentRoomId, room);
  });

  on('set-icon', ({ areaId, iconId }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.activityId || !canAct(room, currentClientId)) return;
    const encounterId = currentEncounterId(room);
    if (!encounterId) return;

    const areaDef = areasByActivityEncounter.get(room.activityId)?.get(encounterId)?.get(areaId);
    if (!areaDef || areaDef.type !== 'icon-select') return;
    const validOptions = optionIdsByActivity.get(room.activityId)?.get(areaDef.optionList);
    if (iconId !== null && !validOptions?.has(iconId)) return;

    const encounterState = getOrCreateEncounterState(room, encounterId);

    // Area groups (see server/activities/index.js): in a 'hide' group an
    // option held by another area can't be picked; in a 'move' group it's
    // taken over — cleared on the other area first, so clients never see
    // it twice.
    const group = areaDef.group ? groupsByActivityEncounter.get(room.activityId)?.get(encounterId)?.get(areaDef.group) : null;
    if (group && iconId !== null) {
      const holders = group.areaIds.filter((id) => id !== areaId && encounterState.icons.get(id) === iconId);
      if (holders.length > 0 && group.mode === 'hide') return;
      for (const holderId of holders) {
        encounterState.icons.delete(holderId);
        io.to(currentRoomId).emit('icon-updated', { encounterId, areaId: holderId, iconId: null });
      }
    }

    if (iconId === null) encounterState.icons.delete(areaId);
    else encounterState.icons.set(areaId, iconId);

    io.to(currentRoomId).emit('icon-updated', { encounterId, areaId, iconId });
  });

  on('toggle-svg', ({ areaId }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !room.activityId || !canAct(room, currentClientId)) return;
    const encounterId = currentEncounterId(room);
    if (!encounterId) return;

    const areaDef = areasByActivityEncounter.get(room.activityId)?.get(encounterId)?.get(areaId);
    if (!areaDef || areaDef.type !== 'toggle-svg') return;

    const encounterState = getOrCreateEncounterState(room, encounterId);
    const visible = !encounterState.svg.has(areaId);
    if (visible) encounterState.svg.add(areaId);
    else encounterState.svg.delete(areaId);

    io.to(currentRoomId).emit('svg-updated', { encounterId, areaId, visible });
  });

  // Drawing events carry the encounterId the client drew on, and are dropped
  // if the room has moved on to another encounter in the meantime — so a
  // stroke can never land on a different picture than it was drawn on.
  function drawableEncounterState(encounterId) {
    if (!currentRoomId) return null;
    const room = rooms.get(currentRoomId);
    if (!room || !canAct(room, currentClientId)) return null;
    if (typeof encounterId !== 'string' || encounterId !== currentEncounterId(room)) return null;
    return getOrCreateEncounterState(room, encounterId);
  }

  // Relayed to everyone but the sender, which has already drawn the stroke
  // locally. Over-budget strokes are dropped; the client enforces the same
  // limits, and the next state-sync corrects any divergence.
  on('draw-stroke', (payload) => {
    const encounterState = drawableEncounterState(payload?.encounterId);
    if (!encounterState) return;
    const stroke = parseStroke(payload);
    if (!stroke) return;

    const pointCount = stroke.points.length / 2;
    if (encounterState.strokes.length >= MAX_ENCOUNTER_STROKES) return;
    if (encounterState.pointCount + pointCount > MAX_ENCOUNTER_POINTS) return;

    encounterState.strokes.push(stroke);
    encounterState.pointCount += pointCount;
    socket.to(currentRoomId).emit('stroke-added', { encounterId: payload.encounterId, stroke });
  });

  // Removes every stroke of the given line. Relayed to everyone but the
  // sender, which has already removed it locally.
  on('erase-stroke', (payload) => {
    const encounterState = drawableEncounterState(payload?.encounterId);
    if (!encounterState) return;
    const { strokeId } = payload;
    if (typeof strokeId !== 'string') return;

    const remaining = encounterState.strokes.filter((stroke) => stroke.id !== strokeId);
    if (remaining.length === encounterState.strokes.length) return;

    encounterState.strokes = remaining;
    encounterState.pointCount = remaining.reduce((sum, stroke) => sum + stroke.points.length / 2, 0);
    socket.to(currentRoomId).emit('stroke-erased', { encounterId: payload.encounterId, strokeId });
  });

  on('clear-drawing', (payload) => {
    const encounterState = drawableEncounterState(payload?.encounterId);
    if (!encounterState) return;

    encounterState.strokes = [];
    encounterState.pointCount = 0;
    io.to(currentRoomId).emit('drawing-cleared', { encounterId: payload.encounterId });
  });

  on('set-image-hidden', (payload) => {
    const encounterState = drawableEncounterState(payload?.encounterId);
    if (!encounterState) return;

    encounterState.imageHidden = Boolean(payload.hidden);
    io.to(currentRoomId).emit('image-hidden-updated', {
      encounterId: payload.encounterId,
      hidden: encounterState.imageHidden,
    });
  });

  on('start-ready-check', () => {
    const room = rooms.get(currentRoomId);
    if (!room || !isAdmin(room, currentClientId) || room.readyCheck) return;

    room.readyCheck = new Map([...room.members.keys()].map((memberId) => [memberId, null]));
    broadcastMembers(currentRoomId, room);
  });

  // Any member may answer (also in guided mode — it's not a board change),
  // and change the answer until the check ends.
  on('ready-answer', ({ ready }) => {
    const room = rooms.get(currentRoomId);
    if (!room?.readyCheck?.has(currentClientId) || typeof ready !== 'boolean') return;

    room.readyCheck.set(currentClientId, ready);
    broadcastMembers(currentRoomId, room);
    if (completeReadyCheckIfAnswered(currentRoomId, room)) broadcastMembers(currentRoomId, room);
  });

  on('abort-ready-check', () => {
    const room = rooms.get(currentRoomId);
    if (!room?.readyCheck || !isAdmin(room, currentClientId)) return;

    endReadyCheck(currentRoomId, room, 'aborted');
    broadcastMembers(currentRoomId, room);
  });

  // Only the room admin may toggle guided mode — this is the one action a
  // non-admin can never take, even before guided mode is on.
  on('set-guided-mode', ({ enabled }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !isAdmin(room, currentClientId)) return;

    room.guidedMode = Boolean(enabled);
    broadcastState(currentRoomId, room);
  });

  // Only the room admin may remotely show/hide the Electron overlay window.
  on('set-overlay-visible', ({ visible }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !isAdmin(room, currentClientId)) return;

    room.overlayVisible = Boolean(visible);
    broadcastState(currentRoomId, room);
  });

  socket.on('disconnect', () => {
    if (!currentRoomId || !currentClientId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    const sockets = (room.members.get(currentClientId) ?? 1) - 1;
    room.members.set(currentClientId, sockets);
    if (sockets > 0) return; // still connected in another tab

    const roomId = currentRoomId;
    const clientId = currentClientId;
    room.leaveTimers.set(clientId, setTimeout(() => removeMember(roomId, room, clientId), RECONNECT_GRACE_MS));
    broadcastMembers(roomId, room); // shown as offline until it rejoins or the grace period ends
  });
});

// Runs once a client's grace period has passed without it rejoining.
function removeMember(roomId, room, clientId) {
  if (rooms.get(roomId) !== room) return;
  room.leaveTimers.delete(clientId);
  room.members.delete(clientId);
  room.adminClientIds.delete(clientId);
  room.names.delete(clientId);
  room.readyCheck?.delete(clientId);
  console.log(`[${roomId}] ${logId(clientId)} left (${room.members.size} members)`);

  if (room.members.size === 0) {
    rooms.delete(roomId);
    console.log(`[${roomId}] room cleaned up`);
    return;
  }

  // Last admin gone: promote a remaining member — preferably one that's
  // connected right now — so guided mode can never permanently lock a room
  // out with no one left able to disable it.
  if (room.adminClientIds.size === 0) {
    const members = [...room.members];
    room.adminClientIds.add((members.find(([, sockets]) => sockets > 0) ?? members[0])[0]);
    broadcastState(roomId, room);
  }
  broadcastMembers(roomId, room);
  // The leaver may have been the last one the ready check was waiting for.
  if (completeReadyCheckIfAnswered(roomId, room)) broadcastMembers(roomId, room);
}

app.use(express.static(path.join(__dirname, 'public')));
// Client code shared with the Electron overlay (repo-root shared/, mounted
// next to server/ in the Docker container).
app.use('/shared', express.static(path.join(__dirname, '..', 'shared')));

app.get('/health', (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

// Shareable invite links: lfg.example.com/<code> loads the app with the
// room code pre-filled. Only matches a single path segment made of the
// same characters allowed in a room code, so it never shadows static
// assets (which have extensions) or other routes.
const ROOM_CODE_PATH_RE = /^[A-Za-z0-9_-]{1,32}$/;

app.get('/:code', (req, res, next) => {
  if (!ROOM_CODE_PATH_RE.test(req.params.code)) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`LFG Buddy server listening on :${PORT}`);
});
