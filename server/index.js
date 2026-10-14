'use strict';

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
//   encounters: Map<encounterId, { icons: Map<areaId, iconId>, svg: Set<areaId> }>,
//   members: Set<clientId>,
//   adminClientId: string|null,
//   guidedMode: boolean,
//   overlayVisible: boolean,
// }
// `encounters` only holds entries for encounters a room has actually
// touched — a missing entry means that encounter is still blank. `members`
// tracks presence only (for room lifecycle); nothing about a member is
// shown in the UI. `adminClientId` is the first client to ever join the
// room (re-assigned to a remaining member if the admin disconnects) — when
// `guidedMode` is on, only that client may mutate room state; enforced
// server-side in canAct(), never trusted from the client.
const rooms = new Map();

function emptyEncounterState() {
  return { icons: new Map(), svg: new Set() };
}

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      activityId: null,
      encounterIndex: 0,
      encounters: new Map(),
      members: new Set(),
      adminClientId: null,
      guidedMode: false,
      overlayVisible: true,
    });
  }
  return rooms.get(roomId);
}

function canAct(room, clientId) {
  return !room.guidedMode || room.adminClientId === clientId;
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

function serializeRoom(room) {
  return {
    activityId: room.activityId,
    encounterIndex: room.encounterIndex,
    encounters: Object.fromEntries(
      [...room.encounters.entries()].map(([encounterId, r]) => [
        encounterId,
        { icons: Object.fromEntries(r.icons), svg: [...r.svg] },
      ])
    ),
    adminClientId: room.adminClientId,
    guidedMode: room.guidedMode,
    overlayVisible: room.overlayVisible,
  };
}

io.on('connection', (socket) => {
  let currentRoomId = null;
  let currentClientId = null;

  socket.emit('activities-manifest', { activities: activityList });

  socket.on('join', ({ roomId, clientId }) => {
    if (!roomId || !clientId) return;

    currentRoomId = String(roomId).toUpperCase().slice(0, 32);
    currentClientId = String(clientId).slice(0, 64);

    socket.join(currentRoomId);
    const room = getOrCreateRoom(currentRoomId);
    room.members.add(currentClientId);
    if (!room.adminClientId) room.adminClientId = currentClientId;

    socket.emit('state-sync', serializeRoom(room));

    console.log(`[${currentRoomId}] ${currentClientId} joined (${room.members.size} members)`);
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
    io.to(currentRoomId).emit('state-sync', serializeRoom(room));
  });

  socket.on('set-encounter', ({ encounterIndex }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    const activity = activitiesById.get(room?.activityId);
    if (!room || !activity || !canAct(room, currentClientId)) return;
    if (!Number.isInteger(encounterIndex) || encounterIndex < 0 || encounterIndex >= activity.encounters.length) return;

    room.encounterIndex = encounterIndex;
    io.to(currentRoomId).emit('state-sync', serializeRoom(room));
  });

  socket.on('reset-encounter', () => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || !canAct(room, currentClientId)) return;
    const encounterId = currentEncounterId(room);
    if (!encounterId) return;

    room.encounters.set(encounterId, emptyEncounterState());
    io.to(currentRoomId).emit('state-sync', serializeRoom(room));
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

  // Only the room admin may toggle guided mode — this is the one action a
  // non-admin can never take, even before guided mode is on.
  socket.on('set-guided-mode', ({ enabled }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.adminClientId !== currentClientId) return;

    room.guidedMode = Boolean(enabled);
    io.to(currentRoomId).emit('state-sync', serializeRoom(room));
  });

  // Only the room admin may remotely show/hide the Electron overlay window.
  socket.on('set-overlay-visible', ({ visible }) => {
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room || room.adminClientId !== currentClientId) return;

    room.overlayVisible = Boolean(visible);
    io.to(currentRoomId).emit('state-sync', serializeRoom(room));
  });

  socket.on('disconnect', () => {
    if (!currentRoomId || !currentClientId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    room.members.delete(currentClientId);
    console.log(`[${currentRoomId}] ${currentClientId} left (${room.members.size} members)`);

    if (room.members.size === 0) {
      rooms.delete(currentRoomId);
      console.log(`[${currentRoomId}] room cleaned up`);
      return;
    }

    // Hand admin rights to a remaining member so guided mode can never
    // permanently lock a room out with no one left able to disable it.
    if (room.adminClientId === currentClientId) {
      room.adminClientId = room.members.values().next().value;
      io.to(currentRoomId).emit('state-sync', serializeRoom(room));
    }
  });
});

app.use(express.static(path.join(__dirname, 'public')));

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
