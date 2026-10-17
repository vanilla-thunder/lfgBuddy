'use strict';

const { clipboard, contextBridge, ipcRenderer } = require('electron');
const { io } = require('socket.io-client');

// Pre-fill for the setup screen's server field (dev mode: local server).
const DEFAULT_SERVER_ARG = '--lfg-default-server=';
const defaultServer = process.argv.find((a) => a.startsWith(DEFAULT_SERVER_ARG))?.slice(DEFAULT_SERVER_ARG.length) ?? '';

let socket = null;
const eventListeners = {};

function attachListeners(sock) {
  for (const [event, callbacks] of Object.entries(eventListeners)) {
    for (const cb of callbacks) {
      sock.on(event, cb);
    }
  }
}

contextBridge.exposeInMainWorld('lfg', {
  defaultServer,

  // Asks main.js to join (validation + one-time trust confirmation for new
  // servers); the answer arrives via onJoinRoom or onJoinFailed.
  requestJoin({ server, code, adminToken = null }) {
    ipcRenderer.send('request-join', { server: String(server), code: String(code), adminToken });
  },

  // Only to servers main.js trusts — the renderer can't open a socket to
  // anything the user hasn't confirmed.
  connect(server, roomId, clientId, adminToken = null, name = '') {
    if (!ipcRenderer.sendSync('is-trusted-server', String(server))) return false;
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }

    socket = io(String(server), {
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionAttempts: Infinity,
    });

    socket.on('connect', () => {
      socket.emit('join', { roomId, clientId, adminToken, name });
    });

    attachListeners(socket);
    return true;
  },

  disconnect() {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }
  },

  on(event, callback) {
    if (!eventListeners[event]) eventListeners[event] = [];
    eventListeners[event].push(callback);
    if (socket) socket.on(event, callback);
  },

  emit(event, data) {
    if (socket?.connected) socket.emit(event, data);
  },

  onToggleInteractive(callback) {
    ipcRenderer.on('toggle-interactive', (_evt, isInteractive) => callback(isInteractive));
  },

  onJoinRoom(callback) {
    ipcRenderer.on('join-room', (_evt, join) => callback({
      server: String(join.server),
      code: String(join.code),
      adminToken: join.adminToken ?? null,
    }));
  },

  onJoinFailed(callback) {
    ipcRenderer.on('join-failed', (_evt, message) => callback(String(message)));
  },

  copyText(text) {
    clipboard.writeText(String(text));
  },

  setOverlayVisible(visible) {
    ipcRenderer.send('set-overlay-visible', Boolean(visible));
  },

  // true while a ready check waits for this user's answer (see main.js).
  setReadyCheckPending(pending) {
    ipcRenderer.send('ready-check-pending', Boolean(pending));
  },
});
