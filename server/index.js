'use strict';

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const activities = require('./activities');
const { fetchExternalImage, PictureError } = require('./external-image');

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
//     customImage: { id, host } | null,  // external picture replacing the encounter's
//   }>,
//   members: Map<clientId, number>,  // open sockets per client
//   leaveTimers: Map<clientId, Timeout>,
//   names: Map<clientId, string>,     // display names, sanitized
//   readyCheck: Map<clientId, boolean|null> | null,  // running check: answer per member (null = pending)
//   timer: { endsAt, durationMs, label, replaceBoard, timeout } | null,  // running timer (server clock)
//   video: { videoId, playing, position, updatedAt } | null,  // watch together; position in s at updatedAt (server clock)
//   images: Map<imageId, { buffer, contentType }>,  // external pictures' bytes (see customImage)
//   imageBytes: number,  // total size of `images`
//   fetchingImage: boolean,  // one picture download per room at a time
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

// Free text from clients (display names, timer texts): drop control and
// invisible format characters (incl. bidi overrides, which could disguise
// it), collapse whitespace, and cap the length in characters, not UTF-16
// units. Clients render it as text only, never as HTML.
function sanitizeText(raw, maxLength) {
  const text = String(raw ?? '').normalize('NFC').replace(/\s+/g, ' ').replace(/\p{C}/gu, '').trim();
  return [...text].slice(0, maxLength).join('').trim();
}

function sanitizeName(raw) {
  return sanitizeText(raw, MAX_NAME_LENGTH) || DEFAULT_NAME;
}

function emptyEncounterState() {
  return { icons: new Map(), svg: new Set(), strokes: [], pointCount: 0, imageHidden: false, customImage: null };
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
      id: roomId,
      activityId: null,
      encounterIndex: 0,
      encounters: new Map(),
      members: new Map(),
      leaveTimers: new Map(),
      names: new Map(),
      readyCheck: null,
      timer: null,
      video: null,
      images: new Map(),
      imageBytes: 0,
      fetchingImage: false,
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
// ── Timer ────────────────────────────────────────────────────────────────────
// Admins start/cancel (regardless of guided mode); a new one replaces a
// running one. Optional text (cleaned like names) and an option to show it
// instead of the board. The server keeps the end time on its own clock and
// only ever sends the *remaining* time — at start, and in state-sync for late
// joiners — so clients count down locally without per-second broadcasts,
// and their system clocks don't matter.
const MIN_TIMER_SECONDS = 1;
const MAX_TIMER_SECONDS = 60 * 60;
const MAX_TIMER_LABEL_LENGTH = 60;

function timerPayload(room) {
  if (!room.timer) return null;
  return {
    remainingMs: Math.max(0, room.timer.endsAt - Date.now()),
    durationMs: room.timer.durationMs,
    label: room.timer.label,
    replaceBoard: room.timer.replaceBoard,
  };
}

function clearTimer(room) {
  clearTimeout(room.timer?.timeout);
  room.timer = null;
}

// ── Watch together (YouTube) ─────────────────────────────────────────────────
// Admins load/close a video; every member may play, pause and seek (only
// admins in guided mode). Only the video ID ever leaves the server — clients
// build the embed URL themselves, and the server never fetches anything.
// Like the timer, the server keeps the playback position on its own clock and
// sends the *current* position; clients extrapolate it locally while playing.
const YOUTUBE_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
  'youtube-nocookie.com', 'www.youtube-nocookie.com',
]);
const YOUTUBE_ID_PATHS = new Set(['embed', 'shorts', 'live', 'v']);
const MAX_VIDEO_URL_LENGTH = 2048;
const MAX_VIDEO_POSITION = 24 * 60 * 60;

// "90", "90s", "1m30s", "1h2m3s" (YouTube's t= / start=) → seconds, else 0.
function parseVideoStart(raw) {
  const match = /^(?:(\d{1,2})h)?(?:(\d{1,4})m)?(?:(\d{1,5})s?)?$/.exec(raw ?? '');
  if (!match) return 0;
  const [, h = 0, m = 0, s = 0] = match;
  return Math.min(Number(h) * 3600 + Number(m) * 60 + Number(s), MAX_VIDEO_POSITION);
}

// A YouTube link (watch, youtu.be, shorts, live, embed) or a bare video ID
// → { videoId, start }, or null.
function parseYouTubeUrl(raw) {
  const input = String(raw ?? '').trim();
  if (input.length > MAX_VIDEO_URL_LENGTH) return null;
  if (YOUTUBE_ID_RE.test(input)) return { videoId: input, start: 0 };

  let url;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) return null;

  const [, first, second] = url.pathname.split('/');
  let videoId = null;
  if (url.hostname === 'youtu.be') videoId = first;
  else if (YOUTUBE_HOSTS.has(url.hostname)) {
    videoId = first === 'watch' ? url.searchParams.get('v') : YOUTUBE_ID_PATHS.has(first) ? second : null;
  }
  if (!YOUTUBE_ID_RE.test(videoId ?? '')) return null;
  return { videoId, start: parseVideoStart(url.searchParams.get('t') ?? url.searchParams.get('start')) };
}

function videoPosition(video) {
  const elapsed = video.playing ? (Date.now() - video.updatedAt) / 1000 : 0;
  return Math.min(video.position + elapsed, MAX_VIDEO_POSITION);
}

function videoPayload(room) {
  if (!room.video) return null;
  return { videoId: room.video.videoId, playing: room.video.playing, position: videoPosition(room.video) };
}

// ── External pictures ────────────────────────────────────────────────────────
// An admin can replace the current encounter's picture with one from a URL.
// The server downloads it (server/external-image.js: SSRF-hardened, https,
// public addresses only, ≤ 5 MB, PNG/JPEG/GIF/WebP) and serves it from
// memory at /rooms/<room>/images/<random id>; Reset, switching activity or
// the room closing frees it again.
const MAX_ROOM_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_ID_RE = /^[0-9a-f]{32}$/;

function customImagePayload(room, encounterState) {
  const image = encounterState.customImage;
  if (!image) return null;
  return { url: `/rooms/${encodeURIComponent(room.id)}/images/${image.id}`, host: image.host };
}

function dropCustomImage(room, encounterState) {
  const image = encounterState?.customImage;
  if (!image) return;
  room.imageBytes -= room.images.get(image.id)?.buffer.length ?? 0;
  room.images.delete(image.id);
  encounterState.customImage = null;
}

function dropAllCustomImages(room) {
  room.images.clear();
  room.imageBytes = 0;
  for (const encounterState of room.encounters.values()) encounterState.customImage = null;
}

function serializeRoom(room, clientId) {
  const admin = isAdmin(room, clientId);
  return {
    activityId: room.activityId,
    encounterIndex: room.encounterIndex,
    encounters: Object.fromEntries(
      [...room.encounters.entries()].map(([encounterId, r]) => [
        encounterId,
        {
          icons: Object.fromEntries(r.icons),
          svg: [...r.svg],
          strokes: r.strokes,
          imageHidden: r.imageHidden,
          customImage: customImagePayload(room, r),
        },
      ])
    ),
    isAdmin: admin,
    adminToken: admin ? room.adminToken : null,
    guidedMode: room.guidedMode,
    timer: timerPayload(room),
    video: videoPayload(room),
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
    const fail = (err) => console.error(`[${currentRoomId ?? '-'}] ${event} handler failed:`, err);
    socket.on(event, (payload) => {
      try {
        // async handlers too: a rejected promise would otherwise be an
        // unhandled rejection — which also takes the process down.
        handler(payload !== null && typeof payload === 'object' ? payload : {})?.catch?.(fail);
      } catch (err) {
        fail(err);
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
    dropAllCustomImages(room);
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

    dropCustomImage(room, room.encounters.get(encounterId));
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

  // Admins only (regardless of guided mode): it makes the server fetch an
  // arbitrary URL, so not every member should be able to trigger that.
  // Errors go back to the requester only.
  on('set-custom-image', async ({ encounterId, url }) => {
    const room = rooms.get(currentRoomId);
    if (!room || !isAdmin(room, currentClientId)) return;
    if (typeof encounterId !== 'string' || encounterId !== currentEncounterId(room)) return;
    const fail = (message) => socket.emit('custom-image-error', { message });
    if (room.fetchingImage) {
      fail('Another picture is still loading.');
      return;
    }

    const activityId = room.activityId;
    room.fetchingImage = true;
    let image;
    try {
      image = await fetchExternalImage(url);
    } catch (err) {
      if (!(err instanceof PictureError)) console.error(`[${room.id}] picture download failed:`, err);
      fail(err instanceof PictureError ? err.message : 'The download failed.');
      return;
    } finally {
      room.fetchingImage = false;
    }

    // The room may have closed or switched activity while downloading.
    if (rooms.get(room.id) !== room || room.activityId !== activityId) return;
    const encounterState = getOrCreateEncounterState(room, encounterId);
    const replacedBytes = room.images.get(encounterState.customImage?.id)?.buffer.length ?? 0;
    if (room.imageBytes - replacedBytes + image.buffer.length > MAX_ROOM_IMAGE_BYTES) {
      fail('This room has too many pictures — reset another encounter first.');
      return;
    }

    dropCustomImage(room, encounterState);
    const id = crypto.randomBytes(16).toString('hex');
    room.images.set(id, { buffer: image.buffer, contentType: image.contentType });
    room.imageBytes += image.buffer.length;
    encounterState.customImage = { id, host: image.host };
    io.to(room.id).emit('custom-image-updated', { encounterId, customImage: customImagePayload(room, encounterState) });
  });

  on('clear-custom-image', ({ encounterId }) => {
    const room = rooms.get(currentRoomId);
    if (!room || !isAdmin(room, currentClientId)) return;
    if (typeof encounterId !== 'string' || encounterId !== currentEncounterId(room)) return;
    const encounterState = room.encounters.get(encounterId);
    if (!encounterState?.customImage) return;

    dropCustomImage(room, encounterState);
    io.to(currentRoomId).emit('custom-image-updated', { encounterId, customImage: null });
  });

  on('start-timer', ({ seconds, label, replaceBoard }) => {
    const room = rooms.get(currentRoomId);
    if (!room || !isAdmin(room, currentClientId)) return;
    if (!Number.isInteger(seconds) || seconds < MIN_TIMER_SECONDS || seconds > MAX_TIMER_SECONDS) return;

    clearTimer(room);
    const durationMs = seconds * 1000;
    const timer = {
      endsAt: Date.now() + durationMs,
      durationMs,
      label: sanitizeText(label, MAX_TIMER_LABEL_LENGTH),
      replaceBoard: replaceBoard === true,
      timeout: null,
    };
    // Clients finish on their own; the server just forgets it at the end.
    timer.timeout = setTimeout(() => {
      if (room.timer === timer) room.timer = null;
    }, durationMs);
    room.timer = timer;
    io.to(currentRoomId).emit('timer', timerPayload(room));
  });

  on('cancel-timer', () => {
    const room = rooms.get(currentRoomId);
    if (!room?.timer || !isAdmin(room, currentClientId)) return;

    clearTimer(room);
    io.to(currentRoomId).emit('timer', null);
  });

  // Admins only (regardless of guided mode). A new video replaces the
  // current one and starts paused, at the link's t= if it has one.
  on('set-video', ({ url }) => {
    const room = rooms.get(currentRoomId);
    if (!room || !isAdmin(room, currentClientId)) return;
    const parsed = parseYouTubeUrl(url);
    if (!parsed) {
      socket.emit('video-error', { message: 'Not a YouTube video link.' });
      return;
    }

    room.video = { videoId: parsed.videoId, playing: false, position: parsed.start, updatedAt: Date.now() };
    io.to(currentRoomId).emit('video', videoPayload(room));
  });

  on('clear-video', () => {
    const room = rooms.get(currentRoomId);
    if (!room?.video || !isAdmin(room, currentClientId)) return;

    room.video = null;
    io.to(currentRoomId).emit('video', null);
  });

  // Play/pause/seek: the sender's wanted state. Carries the videoId it was
  // meant for, so a late event can't act on a newly loaded video. Sent to
  // the sender too — the server's state is the one everyone follows.
  on('video-state', ({ videoId, playing, position }) => {
    const room = rooms.get(currentRoomId);
    if (!room?.video || !canAct(room, currentClientId) || videoId !== room.video.videoId) return;
    if (typeof playing !== 'boolean' || typeof position !== 'number') return;
    if (!Number.isFinite(position) || position < 0 || position > MAX_VIDEO_POSITION) return;

    room.video = { videoId, playing, position, updatedAt: Date.now() };
    io.to(currentRoomId).emit('video', videoPayload(room));
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
    clearTimer(room);
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

// External pictures (see customImagePayload). The id is random and only
// sent to room members; the bytes were verified as PNG/JPEG/GIF/WebP, and
// nosniff + a locked-down CSP keep browsers from treating them as anything
// else.
app.get('/rooms/:roomId/images/:imageId', (req, res) => {
  const image = IMAGE_ID_RE.test(req.params.imageId)
    ? rooms.get(String(req.params.roomId).toUpperCase())?.images.get(req.params.imageId)
    : null;
  if (!image) {
    res.status(404).end();
    return;
  }
  res.set({
    'Content-Type': image.contentType,
    'Content-Length': String(image.buffer.length),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, max-age=86400, immutable',
  });
  res.end(image.buffer);
});

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
