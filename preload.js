'use strict';

const { clipboard, contextBridge, ipcRenderer } = require('electron');
const { io } = require('socket.io-client');

const SERVER_ARG = '--lfg-server=';
const serverUrl = process.argv.find((a) => a.startsWith(SERVER_ARG))?.slice(SERVER_ARG.length) ?? '';

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
  serverUrl,

  connect(roomId, clientId, adminToken = null, name = '') {
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
    }

    socket = io(serverUrl, {
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionAttempts: Infinity,
    });

    socket.on('connect', () => {
      socket.emit('join', { roomId, clientId, adminToken, name });
    });

    attachListeners(socket);
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
    ipcRenderer.on('join-room', (_evt, join) => callback(String(join.code), join.adminToken ?? null));
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
