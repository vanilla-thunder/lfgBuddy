'use strict';

const { app, BrowserWindow, dialog, globalShortcut, ipcMain, screen, session } = require('electron');
const fs = require('fs');
const path = require('path');

let mainWindow;
// { server, code, adminToken } join request (from an lfgbuddy:// link or the
// setup screen) that arrived while the page wasn't ready — cold start, or
// the reload after trusting a new server; handled on did-finish-load.
let pendingJoin = null;
// True between did-finish-load and the next load start. (isLoading() is
// still true inside did-finish-load, so it can't gate the retry there.)
let pageReady = false;
// Starts interactive so the user can connect/pick an activity right away;
// F9 switches to click-through.
let isInteractive = true;
// Set while a ready check has brought up the hidden overlay: the state to
// return to (hidden, plus the interactive mode it had) once answered.
let readyCheckRestore = null;

// The overlay works with any sync server — the server comes from the
// lfgbuddy:// link or the setup screen, nothing is baked into the app.
// Every join goes through requestJoin() here: the server must be https
// (plain http only for localhost), and a server the user hasn't connected
// to before needs a one-time confirmation — any website can fire lfgbuddy://
// links, so a link alone must never send the overlay to a stranger's
// server. The renderer additionally uses a separate client ID per server
// (client IDs are credentials), and preload refuses untrusted servers.
// `npm run client` (--dev) pre-fills and trusts the local dev server.
const MODE = process.argv.includes('--dev') ? 'dev' : 'prod';
const DEV_SERVER = 'http://localhost:3000';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

// Origin of a server URL, or null if unusable: http(s) only, https unless
// localhost, no credentials, and a real hostname (dotted, or localhost).
// Input without a scheme ("lfg.example.com") means https (http for
// localhost); a full invite link works too — only its origin is used.
function serverOrigin(raw) {
  let input = String(raw ?? '').trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    const host = input.split(/[/?#]/)[0].replace(/:\d+$/, '').toLowerCase();
    input = `${LOCAL_HOSTS.includes(host) ? 'http' : 'https'}://${input}`;
  }
  let url;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const isLocal = LOCAL_HOSTS.includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) return null;
  if (!isLocal && !url.hostname.includes('.')) return null;
  return url.origin;
}

// Servers the user has confirmed once (persisted), plus the dev server in
// dev mode. They're also the only image sources the CSP allows.
const TRUSTED_SERVERS_FILE = path.join(app.getPath('userData'), 'trusted-servers.json');
const trustedServers = new Set();

function loadTrustedServers() {
  try {
    for (const entry of JSON.parse(fs.readFileSync(TRUSTED_SERVERS_FILE, 'utf8'))) {
      const origin = serverOrigin(entry);
      if (origin) trustedServers.add(origin);
    }
  } catch {
    // none yet, or unreadable — start empty
  }
  if (MODE === 'dev') trustedServers.add(DEV_SERVER);
}

function trustServer(origin) {
  trustedServers.add(origin);
  try {
    fs.writeFileSync(TRUSTED_SERVERS_FILE, JSON.stringify([...trustedServers].filter((o) => o !== DEV_SERVER || MODE !== 'dev')));
  } catch (err) {
    console.error('Could not save trusted servers:', err);
  }
}

// The overlay page's CSP, sent as a response header (built per page load)
// so it can name the trusted servers — a <meta> CSP is static, and a second
// one could only narrow it. Images only from trusted servers; scripts and
// styles only from the app itself. Trusting a new server reloads the page.
function installContentSecurityPolicy() {
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['file:///*'] }, (details, callback) => {
    const csp = `default-src 'self'; style-src 'self'; img-src 'self' ${[...trustedServers].join(' ')}`;
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

// lfgbuddy://<server-host[:port]>/<room-code>[#admin=<token>] — the web
// invite link with lfgbuddy:// instead of https:// (http:// for localhost),
// same code rules (server/public/app.js). A forged admin token is harmless —
// at worst it's rejected, or makes you admin of a room the link's author
// already controls; the server itself still needs the user's confirmation
// (requestJoin).
const PROTOCOL = 'lfgbuddy';
const ROOM_CODE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ADMIN_TOKEN_RE = /^[0-9a-f]{32}$/;

function parseRoomCode(raw) {
  const code = String(raw ?? '').trim();
  return ROOM_CODE_RE.test(code) ? code.toUpperCase() : null;
}

function parseAdminToken(raw) {
  return ADMIN_TOKEN_RE.test(raw ?? '') ? raw : null;
}

function parseJoinLink(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${PROTOCOL}:` || url.username || url.password) return null;

  // A custom scheme's host isn't normalized or validated by the URL parser;
  // serverOrigin() re-parses it as an http(s) host, which does both.
  const isLocal = LOCAL_HOSTS.includes(url.hostname.toLowerCase());
  const server = serverOrigin(`${isLocal ? 'http' : 'https'}://${url.host}`);

  let code;
  try {
    code = parseRoomCode(decodeURIComponent(url.pathname.replace(/^\/+|\/+$/g, '')));
  } catch {
    return null;
  }
  if (!server || !code) return null;

  // #admin=… like the web admin link; ?admin=… accepted too.
  const adminToken = new URLSearchParams(url.hash.slice(1)).get('admin') ?? url.searchParams.get('admin');
  return { server, code, adminToken: parseAdminToken(adminToken) };
}

// Windows passes the link as a plain argv entry (cold start and
// second-instance alike); ignore everything else in argv.
function findJoinLink(argv) {
  for (const arg of argv) {
    if (arg.toLowerCase().startsWith(`${PROTOCOL}://`)) return parseJoinLink(arg);
  }
  return null;
}

// Single entry point for every join (protocol link or setup screen).
// Trusted server → tell the renderer to connect. New server → ask once; on
// yes, trust it and reload the page (the CSP is per page load, so its
// images are only allowed after that), then join.
async function requestJoin(join) {
  if (!mainWindow || !pageReady) {
    pendingJoin = join;
    return;
  }
  if (!mainWindow.isVisible()) mainWindow.showInactive();

  if (!trustedServers.has(join.server)) {
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      buttons: ['Connect', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'LFG Buddy',
      message: `Connect to ${new URL(join.server).host}?`,
      detail: 'This server hasn\u2019t been used before. Only connect to servers you trust — they see your name and everything you do in the room.',
    });
    if (response !== 0) {
      mainWindow.webContents.send('join-failed', 'Connection cancelled.');
      return;
    }
    trustServer(join.server);
    pendingJoin = join;
    mainWindow.webContents.reload();
    return;
  }
  mainWindow.webContents.send('join-room', join);
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
      additionalArguments: MODE === 'dev' ? [`--lfg-default-server=${DEV_SERVER}`] : [],
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
  mainWindow.webContents.on('did-start-loading', () => {
    pageReady = false;
  });
  mainWindow.webContents.on('did-finish-load', () => {
    pageReady = true;
    applyInteractive();
    if (pendingJoin) {
      const join = pendingJoin;
      pendingJoin = null;
      requestJoin(join);
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
  if (join) requestJoin(join);
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
  loadTrustedServers();
  installContentSecurityPolicy();
  createWindow();

  // Silent, Sigstore-verified updates — only for the installed production
  // app (see updater.js); never in dev or when run from source.
  if (app.isPackaged && MODE === 'prod') require('./updater').startAutoUpdate();

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

  // Join from the setup screen: same validation and trust flow as links.
  ipcMain.on('request-join', (_event, raw) => {
    const server = serverOrigin(raw?.server);
    const code = parseRoomCode(raw?.code);
    if (!server) {
      mainWindow.webContents.send('join-failed', 'Invalid server — use https:// (http only for localhost).');
      return;
    }
    if (!code) {
      mainWindow.webContents.send('join-failed', 'Invalid room code.');
      return;
    }
    requestJoin({ server, code, adminToken: parseAdminToken(raw?.adminToken) });
  });

  // preload only opens sockets to servers trusted here.
  ipcMain.on('is-trusted-server', (event, origin) => {
    event.returnValue = trustedServers.has(origin);
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
