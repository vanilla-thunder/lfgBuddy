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
//   adminClientIds: Set<clientId>,
//   adminToken: string,  // secret in admin links; joining with it grants admin
//   guidedMode: boolean,
//   overlayVisible: boolean,
// }
// `encounters` only holds entries for encounters a room has actually
// touched — a missing entry means that encounter is still blank. `members`
// tracks presence only (for room lifecycle); nothing about a member is
// shown in the UI. A client whose last socket closes stays a member for
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

// state-sync differs per client (see serializeRoom), so it's sent socket by
// socket instead of as one room broadcast.
function broadcastState(roomId, room) {
  for (const socketId of io.sockets.adapter.rooms.get(roomId) ?? []) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) socket.emit('state-sync', serializeRoom(room, socket.data.clientId));
  }
}

io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentClientId = null;

  socket.emit('activities-manifest', { activities: activityList });

  // One join per socket — clients reconnect (and switch rooms) with a new
  // socket, and a second join would unbalance the member's socket count.
  socket.on('join', ({ roomId, clientId, adminToken }) => {
    if (!roomId || !clientId || currentRoomId) return;

    currentRoomId = String(roomId).toUpperCase().slice(0, 32);
    currentClientId = String(clientId).slice(0, 64);
    socket.data.clientId = currentClientId;

    socket.join(currentRoomId);
    const room = getOrCreateRoom(currentRoomId);
    clearTimeout(room.leaveTimers.get(currentClientId));
    room.leaveTimers.delete(currentClientId);
    room.members.set(currentClientId, (room.members.get(currentClientId) ?? 0) + 1);
    if (room.adminClientIds.size === 0 || isValidAdminToken(room, adminToken)) {
      room.adminClientIds.add(currentClientId);
    }

    socket.emit('state-sync', serializeRoom(room, currentClientId));

    console.log(`[${currentRoomId}] ${logId(currentClientId)} joined (${room.members.size} members)`);
  });

  // activityId: null clears the room back to the activity picker; any other
  // value must be a real, currently-active activity.
  socket.on('select-activity', ({ activityId }) => {
    if (!currentRoomId) return;
    if (activityId !== null && !activitiesById.get(activityId)?.active) return;
    const room = rooms.get(currentRoomId);
    if (!room || !canAct(room, currentClientId)) return;
    room.activityId = activityId;
    room.encounterIndex = 0;
    room.encounters.clear();
    broadcastState(currentRoomId, room);
  });

  socket.on('set-encounter', ({ encounterIndex }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    const activity = activitiesById.get(room?.activityId);
    if (!room || !activity || !canAct(room, currentClientId)) return;
    if (!Number.isInteger(encounterIndex) || encounterIndex < 0 || encounterIndex >= activity.encounters.length) return;

    room.encounterIndex = encounterIndex;
    broadcastState(currentRoomId, room);
  });

  socket.on('reset-encounter', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !canAct(room, currentClientId)) return;
    const encounterId = currentEncounterId(room);
    if (!encounterId) return;

    room.encounters.set(encounterId, emptyEncounterState());
    broadcastState(currentRoomId, room);
  });

  socket.on('set-icon', ({ areaId, iconId }) => {
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
    if (iconId === null) encounterState.icons.delete(areaId);
    else encounterState.icons.set(areaId, iconId);

    io.to(currentRoomId).emit('icon-updated', { encounterId, areaId, iconId });
  });

  socket.on('toggle-svg', ({ areaId }) => {
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
  socket.on('draw-stroke', (payload) => {
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
  socket.on('erase-stroke', (payload) => {
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

  socket.on('clear-drawing', (payload) => {
    const encounterState = drawableEncounterState(payload?.encounterId);
    if (!encounterState) return;

    encounterState.strokes = [];
    encounterState.pointCount = 0;
    io.to(currentRoomId).emit('drawing-cleared', { encounterId: payload.encounterId });
  });

  socket.on('set-image-hidden', (payload) => {
    const encounterState = drawableEncounterState(payload?.encounterId);
    if (!encounterState) return;

    encounterState.imageHidden = Boolean(payload.hidden);
    io.to(currentRoomId).emit('image-hidden-updated', {
      encounterId: payload.encounterId,
      hidden: encounterState.imageHidden,
    });
  });

  // Only the room admin may toggle guided mode — this is the one action a
  // non-admin can never take, even before guided mode is on.
  socket.on('set-guided-mode', ({ enabled }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !isAdmin(room, currentClientId)) return;

    room.guidedMode = Boolean(enabled);
    broadcastState(currentRoomId, room);
  });

  // Only the room admin may remotely show/hide the Electron overlay window.
  socket.on('set-overlay-visible', ({ visible }) => {
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
  });
});

// Runs once a client's grace period has passed without it rejoining.
function removeMember(roomId, room, clientId) {
  if (rooms.get(roomId) !== room) return;
  room.leaveTimers.delete(clientId);
  room.members.delete(clientId);
  room.adminClientIds.delete(clientId);
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
