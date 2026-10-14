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

Rooms are identified by a shared code (e.g. `TEAM-ALPHA`). All clients in the same room see the same shared activity. State is in-memory — it is reset when all members leave. There are no player identities — no names, no per-member status — the room just tracks who's connected so it can clean itself up when empty, and to know who the room admin is.

### Room admin & guided mode

The first client to join a room becomes its **admin** (if the admin disconnects, admin rights pass to another remaining member, so a room can never get permanently stuck). The admin gets a **Guided mode** checkbox in their UI. While guided mode is on, only the admin can switch activities, navigate/reset encounters, or interact with clickable areas — everyone else is read-only. This is enforced server-side (the server tracks each room's `adminClientId`/`guidedMode` and rejects mutating events from non-admins), not just hidden in the UI, so a modified client can't bypass it.

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

The server is reachable at `https://lfg.example.com` with TLS handled by Traefik (`letsencrypt` cert resolver).

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
npm start      # production — connects to https://lfg.example.com
npm run dev    # development — connects to http://localhost:3000
```

The server URL is fixed per mode (`SERVER_URLS` in `main.js`). On launch a setup panel appears; enter a room code and click **Connect**. `lfgbuddy://` links always launch in production mode unless the overlay is already running in dev mode.

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
      areas: [
        { id, type: 'icon-select', optionList: 'roles', x, y, w, h },
        { id, type: 'toggle-svg',
          trigger: { x, y, w, h },
          overlay: { x, y, w, h, svg: '<file>.svg' } },
      ],
    },
  ],
};
```

`x`/`y`/`w`/`h` are absolute px offsets from the encounter image's edges (not percentages, and not affected by how large the image renders). `x`/`y` ≥ 0 anchor from the left/top edge; negative `x`/`y` anchor from the right/bottom edge instead (e.g. `x: -5` = 5px from the right edge), so an area can stay pinned to a corner. `w`/`h` are always the area's pixel width/height. `server/activities/index.js` discovers every subdirectory with an `activity.js` at startup, rewrites each `image`/`svg`/`thumbnail` filename into its served URL (`/activities/<id>/images/<file>`), validates `type` against `['dungeon', 'raid']` (throwing at startup if it's set to anything else), builds the validation lookups `set-icon`/`toggle-svg` use, and mounts one static route per activity so its `images/` folder is servable — `server/index.js` itself only knows the room/socket protocol, not activity content.

The manifest is pushed to clients over the socket connection (`activities-manifest` event) on connect, so no separate HTTP fetch or CORS setup is needed — the Electron overlay's CSP (`client/index.html`) only allows images from the two `SERVER_URLS` origins in `main.js` — keep them in sync when changing either.

---

## Project Structure

```
lfgBuddy/
├── main.js               # Electron main process — window, hotkeys
├── preload.js            # contextBridge: exposes Socket.io API to renderer
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

> **Duplicated client logic:** `client/overlay.js` (Electron) and `server/public/app.js` (web) are two separate, hand-kept-in-sync copies of the same rendering/interaction logic — there's no shared module between them. Any change to how encounters/areas are rendered or handled (e.g. area positioning, icon picker, socket event handling) must be made in **both** files, or the two clients will drift out of sync.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Port the server listens on |
