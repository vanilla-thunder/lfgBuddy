# LFG Buddy

In-game overlay for looking-for-group coordination. Multiple instances on different machines sync in real time via a central server.

## Overview

| Component | Description |
|---|---|
| **Electron overlay** | Transparent, always-on-top window that sits above borderless windowed games |
| **Sync server** | Node.js + Socket.io — manages rooms and broadcasts state to all members |
| **Web client** | Browser UI served by the server at the root URL; same feature set as the overlay |

---

## Architecture

```
┌─────────────────────┐      WebSocket (Socket.io)      ┌──────────────────────┐
│  Electron Overlay   │ ──────────────────────────────► │                      │
│  (player machine)   │                                  │   Sync Server        │
└─────────────────────┘ ◄────────────────────────────── │   Node.js + Express  │
                                                         │   + Socket.io        │
┌─────────────────────┐      WebSocket (Socket.io)      │                      │
│  Browser / Web UI   │ ◄───────────────────────────── ►│                      │
│  (any device)       │                                  └──────────────────────┘
└─────────────────────┘
```

Rooms are identified by a shared code (e.g. `TEAM-ALPHA`). All clients in the same room see the same shared activity. State is in-memory — it is reset when all members leave. Every member enters a **display name** when joining (saved in `localStorage` for next time; the server strips control/invisible characters and caps it at 24 characters). The **web version shows the member list** — names, 👑 for admins, *(you)*, and reconnecting members greyed out; the Electron overlay doesn't. Client IDs are never part of that list.

### Room admin & guided mode

The first client to join a room becomes its **admin** (if all admins disconnect, admin rights pass to another remaining member, so a room can never get permanently stuck). Leaving only counts after a 15-second grace period: reloading the page or a short network drop rejoins with the same client ID and keeps admin rights — and a room you're alone in keeps its state instead of being wiped. Admins get a **Guided mode** checkbox in their UI. While guided mode is on, only admins can switch activities, navigate/reset encounters, draw, or interact with clickable areas — everyone else is read-only. This is enforced server-side (the server tracks each room's admins/`guidedMode` and rejects mutating events from non-admins), not just hidden in the UI, so a modified client can't bypass it.

**Ready check.** Admins start one with **Ready Check** (web header / overlay footer) — regardless of guided mode. While it runs, it **replaces the board** (activity picker or encounter) in both clients: every member as a big card with their answer (✅ ❌ ⏳), and below them big, fully opaque ✅ Ready / ❌ Not ready buttons for your own answer (also in guided mode; changeable while it runs). Admins can abort it. There's no timeout: it ends when every current member has answered (members joining mid-check start as pending; members who leave drop out after the grace period) or an admin aborts; the result stays on the same view for 6 s (or until *Close*), then the board returns. The web member list below the board shows the answers too; the locked overlay (F9) shows the cards and "Press F9 to answer". A **hidden overlay** (F8) is brought up — without taking focus from the game — while a check waits for your answer, and returns to its previous state (hidden, and locked again if you pressed F9 to answer) once you've answered or the check ends; an already visible overlay is left alone. Server events: `start-ready-check` / `abort-ready-check` (admins), `ready-answer` `{ ready: boolean }`; state travels in the `members` list (`ready` per member — sent with the final answer before the check ends) plus `ready-check-done` `{ outcome, ready, notReady, total }`. View code: `shared/ready-check.js`.

**Timer.** Admins start one with **Timer** (web header / overlay footer) — regardless of guided mode: presets 1/2/3/5/10 min or a custom duration in minutes (decimals allowed) or seconds, 1 s – 60 min; optional text (e.g. "Pull boss", max 60 characters, cleaned like names and shown as text only); and **Show instead of the board**, which replaces the board with a big timer like the ready check (a running ready check stays visible). A new timer replaces a running one, and admins can cancel it. Everyone sees it above the board — or instead of it — red for the last 3 s, then "GO!" for 2 s; in the overlay also while locked. The server stores the end time on its own clock and only sends the *remaining* time — on start (`timer` event) and in `state-sync` for late joiners — so clients count down locally on a monotonic clock: no per-second broadcasts, and wrong system clocks don't matter. Events: `start-timer` `{ seconds, label, replaceBoard }`, `cancel-timer` (admins). Code: `shared/timer.js`.

**Admin on several devices.** An admin can add their other devices as co-admins — e.g. draw on a phone while guided mode is on:

- **Web:** the **👑 URL** button copies `<invite link>#admin=<token>`; open it on the other device (send it to yourself). **👑 QR** shows the same link as a QR code to scan with the phone instead. (Header order: 👑 URL, 👑 QR, Open in App, Copy URL, Ready Check, Timer, Leave — the 👑 buttons, Ready Check and Timer only for admins.) **Open in App** also carries the token for admins, so the admin's own overlay joins as admin.
- **Electron overlay:** **Copy Admin Link** / **Admin QR** (above *Leave Room*, interactive mode) copy or show the same web link for the overlay's server.
- The QR popup (`shared/admin-qr.js`) warns that anyone scanning it becomes admin, closes itself after 60 s, and in the overlay also when it's locked (F9) — the overlay is often on a streamed screen. It's drawn on a canvas with the vendored [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) 2.0.4 (`shared/vendor/`, MIT), so no external service ever sees the link.
- `lfgbuddy://<server>/<code>#admin=<token>` links (see [Server & links](#server--links)) make the overlay join as admin.

Each room has one random 128-bit admin token, created with the room and valid for its lifetime; anyone who has the link is an admin, so share it only with yourself. It travels in the URL fragment (never sent in HTTP requests, so it's not in server or proxy logs) and is removed from the address bar after joining.

Client IDs work as credentials, so they're never sent to other clients: `state-sync` is sent per client and only tells each one whether *it* is an admin (`isAdmin`, plus `adminToken` for admins). Server logs show only the first 8 characters.

---

## Prerequisites

- **Node.js** 20+ and **npm**
- **Docker** + **Docker Compose** (for server deployment)
- A running **Traefik** instance on the `web` Docker network (for production)

---

## Server

### Local development

```bash
cd server
npm install
npm start
# → listening on http://localhost:3000
```

The web client is served at `http://localhost:3000`.  
Health check: `GET /health` → `{ "ok": true, "rooms": <n> }`

### Production (Docker + Traefik)

```bash
# from repo root
docker compose up -d --build
```

The image contains only the npm dependencies; `server/` and `shared/` are bind-mounted read-only into the container. Uploading new static files (`server/public/`, `shared/`, activity images) takes effect immediately. Changes to `server/index.js` or any `activity.js` need `docker compose restart` (they're loaded once at startup — and a restart drops all in-memory rooms). Changes to `server/package*.json` need `docker compose up -d --build`.

> **Malformed events:** every socket handler in `server/index.js` is registered through `on()`, which hands it a plain object payload and catches exceptions — one bad event from a client must never crash the process (and with it every room). Register new client events the same way.

> **Upload, then restart.** Whenever a change touches the socket protocol (new/changed events or payloads — typically `server/index.js` together with `shared/` or `server/public/`), upload all files and then run `docker compose restart`. Until the restart, browsers already get the new client code while the old server code is still running, and the mismatched events are silently dropped (e.g. drawings stop syncing). The same applies locally: restart `npm run server` after pulling such a change, and restart the Electron overlay (`npm run client`), since it doesn't reload `shared/` on its own.

Before the first start, copy `.env.example` to `.env` (git-ignored) and set `LFG_HOST` (the server's public hostname) and `LFG_CERT_RESOLVER` (your Traefik certificate resolver) — compose refuses to start without them. The server is then reachable at `https://<LFG_HOST>` with TLS handled by Traefik.

> **Scaling note:** the room state is held in memory per process. If you run multiple replicas, add sticky sessions to the Traefik config:
> ```
> traefik.http.services.lfg-buddy.loadbalancer.sticky.cookie=true
> ```

---

## Electron Overlay

### Setup

```bash
# from repo root
npm install
npm run prod     # production mode
npm run client   # development — server field pre-filled with http://localhost:3000
```

On launch a setup panel appears: enter the server, your name and a room code, and click **Connect** (or just open an app link).

### Server & links

The overlay works with **any** sync server — nothing is built into the app. The server comes from an app link or the setup screen's **Server** field (remembered; `lfg.example.com` means `https://lfg.example.com`, a pasted invite link works too).

App links are the web invite links with `lfgbuddy://` instead of `https://` — the web version's **Open in App** builds them:

| Web | App |
|---|---|
| `https://lfg.example.com/oida` | `lfgbuddy://lfg.example.com/oida` |
| `https://lfg.example.com/oida#admin=<token>` | `lfgbuddy://lfg.example.com/oida#admin=<token>` |
| `http://localhost:3000/oida` | `lfgbuddy://localhost:3000/oida` (localhost uses `http`) |

Safety, since any website can fire `lfgbuddy://` links (all in `main.js` → `requestJoin`):

- **https only** — plain `http` just for localhost; no credentials, real hostnames only (the old `lfgbuddy://join/<code>` form is rejected).
- **Confirmation for new servers:** the first time a server is used, the overlay asks *"Connect to lfg.example.com?"*; confirmed servers are remembered (`trusted-servers.json` in the app's data folder). A link alone can never send the overlay to a stranger's server. Dev mode trusts `localhost:3000`.
- **A separate client ID per server** (client IDs are credentials), so no server ever learns the ID used on another.
- The preload refuses sockets to untrusted servers, and the overlay's CSP only allows images from trusted servers (trusting a new one reloads the page once).

`lfgbuddy://` links launch the overlay in production mode unless it's already running in dev mode.

### Releases & auto-update

The installed overlay updates itself **silently**: it checks this repo's GitHub Releases on start and every 4 hours, downloads in the background, and installs when the app quits — never a prompt or restart mid-game. Only packaged production builds update (`updater.js`); dev mode and runs from source never do. A log is kept in `%APPDATA%\lfg-buddy\updater.log`.

Installers aren't Authenticode-signed (Windows SmartScreen warns on the first install: *More info → Run anyway*). Instead every release is signed with **Sigstore** by the release workflow (a GitHub build-provenance attestation, uploaded as `update.sigstore.json`), and the app only installs an update if that signature verifies, was made by `.github/workflows/release.yml` of the repo in `package.json` → `build.publish` for exactly that version's tag, and covers the downloaded installer's SHA-256. Anything else — missing/invalid signature, other signer, tampered file — is discarded before it can be installed (fail-closed).

Cutting a release:

1. Bump `version` in `package.json`, commit, push.
2. `git tag vX.Y.Z && git push origin vX.Y.Z` — the workflow builds, signs and publishes the release.

Nothing deployment-specific goes into a build — one installer works with every server. Local build without publishing: `npm run dist` (output in `dist/`).

**Forks:** change `build.publish` (owner/repo) and `appId` in `package.json`; the update source and the expected signer follow automatically. Forks that only host their own server don't need their own app at all.

The installed app and `npm run client` share the same data folder (`%APPDATA%\lfg-buddy`: name, room, window position) and single-instance lock, so only one of them runs at a time.

### Hotkeys

| Hotkey | Action |
|---|---|
| `F9` | Toggle **INTERACTIVE** / **LOCKED** mode |
| `F8` | Hide / show the overlay |

**LOCKED** (default) — mouse events pass through to the game; the overlay is read-only.  
**INTERACTIVE** — the overlay captures mouse input; encounter areas and navigation become clickable.

In interactive mode the overlay window can be dragged by any empty space around the encounter (e.g. the encounter title row).

### Settings persistence

The room code is saved in `localStorage` and restored on next launch. The client ID (used to identify your connection to the room) is also persisted so reconnects don't create duplicate entries.

---

## Web Client

Accessible at the server's root URL (e.g. `https://lfg.example.com`).

Connects to the same room system as the Electron overlay — enter the same room code to join an existing room.

---

## Room Flow

1. One player creates a room code (any alphanumeric string, e.g. `RAID42`).
2. All players enter the same code when connecting (Electron or web).
3. The shared activity (current encounter's picture + area state) syncs in real time across all connected clients.
4. The room is cleaned up automatically when the last member disconnects.

---

## Activities

An **activity** is a named, predefined mini-guide made of one or more **encounters**, and everyone in the room looks at the same encounter together — prev/reset/next act on the whole room, not just the clicking player.

A freshly created room has no activity selected. Until one is picked, the room screen shows an **activity picker** instead of the encounter view — a grid of cards, one per active activity, using its `thumbnail` as the card background and its `name` overlaid as text (with a small badge for `type`, if set). Picking a card emits `select-activity`. A **‹ Change Activity** button above the shared board sends `select-activity` with `activityId: null`, which clears the room's activity and brings the picker back — that's the only way to switch activities; there is no dropdown. Like every other room mutation, this respects guided mode (see [Room admin & guided mode](#room-admin--guided-mode) above) — non-admins can't pick or change activity while it's on.

- **Encounter** — one fixed picture plus a custom set of clickable **areas** on top of it. Navigate encounters with the **‹ Prev** / **Next ›** buttons; **Reset** clears only the current encounter's progress. Each encounter keeps its own progress independently, so going back shows exactly what it looked like when you left it. Switching activities resets everything.
- **Area** — a clickable region on the encounter's picture, one of two interaction types:
  - `icon-select` — click opens a popup to assign an icon from a named **option list** to that spot (cycling by clicking again isn't implemented, only the popup). Which option list an area uses is per-area, and an activity can define multiple option lists (e.g. "roles" vs. "markers") shared across its encounters.
  - `toggle-svg` — click toggles a boolean; when on, a separate SVG graphic is overlaid on the encounter's picture. The clickable trigger and the revealed SVG have independent positions/sizes, so a small toggle button can reveal a graphic drawn anywhere else on the picture (e.g. a hazard-zone marker).
- **Drawing board** — a tool sidebar next to every encounter: picture show/hide, pen, a color picker popup with six colors (white, red, green, blue, yellow, black), eraser and clear. Works with mouse, pen and touch. Drawings are shared with the room, kept per encounter, cleared by **Reset**, and respect guided mode; in the Electron overlay they need INTERACTIVE mode (F9). While the pen or eraser is selected, the areas underneath aren't clickable — click the active tool again to switch back. Hiding the picture turns the encounter into a blank board (it keeps the picture's size, so strokes stay in place).
  - Strokes are vectors in board units (`0..10000` on both axes, relative to the picture), so they line up across clients of any size. Each stroke carries a client-generated line `id`; the eraser removes every line it touches as a whole, not just the pixels under it.
  - Socket events: `draw-stroke` (relayed to the other members as `stroke-added`), `erase-stroke` (removes all strokes with that line `id`; relayed as `stroke-erased`), `clear-drawing` → `drawing-cleared`, `set-image-hidden` → `image-hidden-updated`. Each carries the `encounterId` it was made on and is dropped if the room has moved on.
  - Limits (server-enforced, mirrored in `shared/drawing.js`): 1,000 points per stroke (longer lines are split client-side into strokes sharing one `id`), 20,000 points and 1,000 strokes per encounter.

Activities are predefined server-side config, not user uploads — and each one is fully self-contained in its own directory:

```
server/activities/
├── index.js              # loader: discovers activity dirs, validates, serves their images
└── <activity-id>/
    ├── activity.js        # module.exports = { name, optionLists, encounters }
    └── images/            # every picture/overlay this activity references
```

To add an activity, create a new folder under `server/activities/` (the folder name becomes its id) with an `activity.js` and an `images/` folder:

```js
// server/activities/<activity-id>/activity.js
module.exports = {
  name: '...',
  type: 'dungeon', // or 'raid' — optional, validated against this fixed list at startup
  active: false, // optional, defaults to true — false excludes it from the activity picker and from select-activity (e.g. vaulted/removed content)
  thumbnail: '<file>.png', // optional, filename only, resolved from this activity's images/
  optionLists: { roles: [{ id, label, emoji }, ...], '...': [...] },
  encounters: [
    {
      id: '...', name: '...', image: '<file>.svg', // filename only, resolved from this activity's images/
      groups: { glyphs: 'hide' }, // optional: groupId -> 'hide' | 'move' (see Area groups below)
      areas: [
        { id, type: 'icon-select', optionList: 'roles', x, y, w, h },
        { id, type: 'icon-select', optionList: 'roles', group: 'glyphs', x, y, w, h },
        { id, type: 'toggle-svg',
          trigger: { x, y, w, h },
          overlay: { x, y, w, h, svg: '<file>.svg' } },
      ],
    },
  ],
};
```

**Area groups.** `icon-select` areas of one encounter can share a `group` (declared in the encounter's `groups` with a mode) so they share their options:

- `'hide'` — an option assigned to one area of the group is removed from the pickers of the group's other areas (e.g. each glyph used at most once).
- `'move'` — every option stays available; picking one that another area of the group holds clears it there. The picker shows such options dimmed (tooltip "move from <area>").

Ungrouped areas behave as before. The server enforces both modes in `set-icon`, so a modified client can't bypass `'hide'`; the loader rejects bad configs at startup (unknown mode, undeclared group, group on a non-`icon-select` area, mixed option lists within a group). The picker filtering lives in `shared/area-groups.js`, used by both clients.

`x`/`y`/`w`/`h` are absolute px offsets from the encounter image's edges (not percentages, and not affected by how large the image renders). `x`/`y` ≥ 0 anchor from the left/top edge; negative `x`/`y` anchor from the right/bottom edge instead (e.g. `x: -5` = 5px from the right edge), so an area can stay pinned to a corner. `w`/`h` are always the area's pixel width/height. `server/activities/index.js` discovers every subdirectory with an `activity.js` at startup, rewrites each `image`/`svg`/`thumbnail` filename into its served URL (`/activities/<id>/images/<file>`), validates `type` against `['dungeon', 'raid']` (throwing at startup if it's set to anything else), builds the validation lookups `set-icon`/`toggle-svg` use, and mounts one static route per activity so its `images/` folder is servable — `server/index.js` itself only knows the room/socket protocol, not activity content.

The manifest is pushed to clients over the socket connection (`activities-manifest` event) on connect, so no separate HTTP fetch or CORS setup is needed — the Electron overlay's CSP is sent by `main.js` and only allows images from servers you've confirmed (see [Server & links](#server--links)).

---

## Project Structure

```
lfgBuddy/
├── main.js               # Electron main process — window, hotkeys
├── preload.js            # contextBridge: exposes Socket.io API to renderer
├── updater.js            # Silent, Sigstore-verified auto-update (packaged prod builds)
├── .github/workflows/release.yml  # Tag → build, Sigstore-sign, publish release
├── shared/               # Client code used by both clients (served at /shared/)
│   ├── drawing.js        # Drawing board: toolbar, canvas, pointer input
│   ├── admin-qr.js       # Admin link QR popup
│   ├── area-groups.js    # Icon picker filtering for area groups
│   ├── ready-check.js    # Ready check view (replaces the board while a check runs)
│   ├── timer.js          # Timer display + start dialog
│   └── vendor/           # Third-party code, vendored unmodified (qrcode-generator)
├── client/               # Electron renderer
│   ├── index.html
│   ├── overlay.js
│   └── overlay.css
├── server/
│   ├── index.js          # Express + Socket.io server — room/socket protocol only
│   ├── activities/
│   │   ├── index.js      # Activity loader/validator, mounts per-activity image routes
│   │   └── <id>/         # One self-contained folder per activity (activity.js + images/)
│   ├── Dockerfile
│   └── public/           # Web client (served statically)
│       ├── index.html
│       ├── style.css
│       └── app.js
└── docker-compose.yml    # Production deployment with Traefik labels
```

> **Duplicated client logic:** `client/overlay.js` (Electron) and `server/public/app.js` (web) are two separate, hand-kept-in-sync copies of the same rendering/interaction logic. Only `shared/` is common to both (the Electron overlay loads it from `../shared/`, the web client from `/shared/`) — prefer putting new client code there. Any change to how encounters/areas are rendered or handled (e.g. area positioning, icon picker, socket event handling) must be made in **both** files, or the two clients will drift out of sync.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
