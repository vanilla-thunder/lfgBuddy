'use strict';

const { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen, session } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow;
// { code, adminToken } from an lfgbuddy:// link that arrived before the
// page could receive it (cold start); delivered on did-finish-load.
let pendingJoin = null;
// Starts interactive so the user can connect/pick an activity right away;
// F9 switches to click-through.
let isInteractive = true;
// Set while a ready check has brought up the hidden overlay: the state to
// return to (hidden, plus the interactive mode it had) once answered.
let readyCheckRestore = null;

// `npm run client` (electron . --dev) targets a local server; everything
// else, including protocol-link launches, targets production — whose URL
// comes from app-config.json (git-ignored; see app-config.example.json), so
// the repo carries no deployment URL and forks just set their own. The URL
// is fixed here and handed to preload — the renderer can't choose the
// server.
const DEV_SERVER_URL = 'http://localhost:3000';
const CONFIG_FILE = path.join(__dirname, 'app-config.json');
const MODE = process.argv.includes('--dev') ? 'dev' : 'prod';

// Origin of a configured server URL, or null if unusable: https only —
// plain http just for localhost — so room traffic (incl. admin tokens) is
// never sent unencrypted over a network.
function serverOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) return null;
  return url.origin;
}

function loadServerUrl() {
  if (MODE === 'dev') return DEV_SERVER_URL;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
  return serverOrigin(config?.serverUrl);
}

const SERVER_URL = loadServerUrl();

// The overlay page's CSP, sent as a response header so it can name the
// configured server — a <meta> CSP is static, and a second one could only
// narrow it. Images may only come from that one server; scripts and styles
// only from the app itself.
function installContentSecurityPolicy() {
  const csp = `default-src 'self'; style-src 'self'; img-src 'self' ${SERVER_URL}`;
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['file:///*'] }, (details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [csp] } });
  });
}

function applyInteractive() {
  if (isInteractive) {
    mainWindow.setIgnoreMouseEvents(false);
  } else {
    mainWindow.setIgnoreMouseEvents(true, { forward: true });
  }
  mainWindow.webContents.send('toggle-interactive', isInteractive);
}

// lfgbuddy://join/<room-code>[?admin=<token>] — same code rules as the web
// invite links (server/public/app.js). Only the room code (and an optional
// admin token for that room) is taken from the link, never a server URL: any
// website can fire this protocol, and letting it pick the server would let
// it redirect the overlay to an attacker-controlled host. A forged admin
// token is harmless — at worst it's rejected, or makes you admin of a room
// the link's author already controls.
const PROTOCOL = 'lfgbuddy';
const ROOM_CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ADMIN_TOKEN_RE = /^[0-9a-f]{32}$/;

function parseJoinLink(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${PROTOCOL}:` || url.hostname !== 'join') return null;

  let code;
  try {
    code = decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, ''));
  } catch {
    return null;
  }
  if (!ROOM_CODE_RE.test(code)) return null;

  const adminToken = url.searchParams.get('admin');
  return { code: code.toUpperCase(), adminToken: ADMIN_TOKEN_RE.test(adminToken ?? '') ? adminToken : null };
}

// Windows passes the link as a plain argv entry (cold start and
// second-instance alike); ignore everything else in argv.
function findJoinLink(argv) {
  for (const arg of argv) {
    if (arg.toLowerCase().startsWith(`${PROTOCOL}://`)) return parseJoinLink(arg);
  }
  return null;
}

function joinRoom(join) {
  if (!mainWindow || mainWindow.webContents.isLoading()) {
    pendingJoin = join;
    return;
  }
  mainWindow.webContents.send('join-room', join);
  if (!mainWindow.isVisible()) mainWindow.showInactive();
}

// Window size/position from the last session, kept in the per-user app data
// dir. Anything malformed, or no longer on any connected display (monitor
// unplugged, resolution changed), falls back to the default placement.
const BOUNDS_FILE = path.join(app.getPath('userData'), 'window-bounds.json');
const MIN_SIZE = 100;
// How much of the window must still overlap a display to be grabbable.
const MIN_VISIBLE = 50;

function loadBounds() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(BOUNDS_FILE, 'utf8'));
  } catch {
    return null;
  }
  const keys = ['x', 'y', 'width', 'height'];
  if (!raw || !keys.every((k) => Number.isInteger(raw[k]))) return null;

  const bounds = { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
  if (bounds.width < MIN_SIZE || bounds.height < MIN_SIZE) return null;

  const visible = screen.getAllDisplays().some(({ workArea: a }) =>
    Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x) >= MIN_VISIBLE
    && Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y) >= MIN_VISIBLE);
  return visible ? bounds : null;
}

function saveBounds() {
  try {
    fs.writeFileSync(BOUNDS_FILE, JSON.stringify(mainWindow.getBounds()));
  } catch (err) {
    console.error('Could not save window bounds:', err);
  }
}

function defaultBounds() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const width = 480;
  const height = 400;
  return { x: sw - width - 16, y: Math.round((sh - height) / 2), width, height };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...(loadBounds() ?? defaultBounds()),
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    resizable: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      additionalArguments: [`--lfg-server=${SERVER_URL}`],
      contextIsolation: true,
      nodeIntegration: false,
      // Electron defaults preload scripts to the sandbox, which restricts
      // require() to a small built-in allowlist — preload.js needs full
      // Node module resolution to require('socket.io-client'). The
      // renderer itself still has no Node access (contextIsolation stays
      // on, nodeIntegration stays off); contextBridge is what selectively
      // exposes preload's API to the page.
      sandbox: false,
    },
  });

  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  // 'moved'/'resized' fire once at the end of a drag on Windows, so the last
  // placement survives even if the app is killed rather than closed.
  mainWindow.on('moved', saveBounds);
  mainWindow.on('resized', saveBounds);
  mainWindow.on('close', saveBounds);
  // The renderer defaults to locked, so sync it with the initial mode once
  // the page (and its IPC listener) is loaded — also covers reloads.
  mainWindow.webContents.on('did-finish-load', () => {
    applyInteractive();
    if (pendingJoin) {
      mainWindow.webContents.send('join-room', pendingJoin);
      pendingJoin = null;
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'client', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    // showInactive so the overlay doesn't steal focus from the game
    mainWindow.showInactive();
  });
}

// A second launch (e.g. clicking an lfgbuddy:// link while the overlay is
// already running) hands its argv to this instance and exits.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) app.quit();

app.on('second-instance', (_event, argv) => {
  const join = findJoinLink(argv);
  if (join) joinRoom(join);
});

// When run unpackaged (`electron .`) Windows must launch electron.exe with
// the app path, otherwise the link would open a bare Electron.
if (process.defaultApp) {
  app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
} else {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

pendingJoin = findJoinLink(process.argv);

app.whenReady().then(() => {
  // app.quit() is async — don't open a window in the instance that's exiting.
  if (!gotInstanceLock) return;
  if (!SERVER_URL) {
    dialog.showErrorBox('LFG Buddy', `No valid server URL configured.\n\nCreate ${CONFIG_FILE} with\n{ "serverUrl": "https://your-server.example" }\n(see app-config.example.json; https required except for localhost).`);
    app.quit();
    return;
  }
  installContentSecurityPolicy();
  createWindow();

  // F9 — toggle between interactive and click-through
  globalShortcut.register('F9', () => {
    isInteractive = !isInteractive;
    applyInteractive();
  });

  // F8 — hide/show the overlay
  globalShortcut.register('F8', () => {
    if (mainWindow.isVisible()) {
      mainWindow.hide();
    } else {
      mainWindow.showInactive();
    }
  });

  // Room-admin visibility toggle, relayed from the web room-admin session via
  // the renderer's socket connection (see client/overlay.js state-sync).
  ipcMain.on('set-overlay-visible', (_event, visible) => {
    if (visible) {
      mainWindow.showInactive();
    } else {
      mainWindow.hide();
    }
  });

  // A ready check waiting for this user's answer shows a hidden overlay
  // (without taking focus from the game). Once answered — or the check ends
  // unanswered — it goes back to how it was: hidden again and, if the user
  // pressed F9 to answer, locked again so the game gets the mouse back.
  // An overlay that was already visible is left alone.
  ipcMain.on('ready-check-pending', (_event, pending) => {
    if (pending) {
      if (!mainWindow.isVisible() && !readyCheckRestore) {
        readyCheckRestore = { interactive: isInteractive };
        mainWindow.showInactive();
      }
      return;
    }
    if (!readyCheckRestore) return;
    const { interactive } = readyCheckRestore;
    readyCheckRestore = null;
    if (isInteractive !== interactive) {
      isInteractive = interactive;
      applyInteractive();
    }
    mainWindow.hide();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  app.quit();
});
