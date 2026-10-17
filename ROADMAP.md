# Roadmap

Planned features, in intended order. Every feature ships in **both** clients
(Electron overlay `client/` and web `server/public/`) and is room-synced and
guided-mode-aware unless stated otherwise.

| # | Feature | Status |
|---|---|---|
| 1 | [Drawing pane](#1-drawing-pane) | Done |
| 2 | [Interactive areas grouping](#2-interactive-areas-grouping) | Done |
| 3 | [Ready check](#3-ready-check) | Done |
| 4 | [Electron app auto-update](#4-electron-app-auto-update) | Done |
| 5 | [Timer](#5-timer) | Done |
| 6 | [External picture via URL](#6-external-picture-via-url) | Planned |

---

## 1. Drawing pane

Freehand drawing on top of the current encounter, with a tool sidebar.

- **Tools:** picture show/hide (blank board), pen, eraser, clear.
- **Colors (fixed palette, in a picker popup):** white, red, green, blue, yellow, black.
- **Input:** mouse, pen and touch (smartphones/tablets) via Pointer Events.
- **Sync:** strokes are stored per encounter in room state, broadcast to the
  room, cleared by *Reset*, and restricted by guided mode like any other
  mutation.
- **Electron:** drawing only works in INTERACTIVE mode (F9).
- Implemented once in `shared/drawing.js`, used by both clients.

Later / nice to have: undo of own last stroke, live stroke streaming while
drawing, line-width selector.

## 2. Interactive areas grouping

Grouping Interactive areas should change the handling of available options.  
First grouping mode removes already assigned options from option lists for other areas in the same group.
Second grouping mode keeps already selected options available, but selecting an option already selected in another area unselects it there. 

Implemented as per-encounter `groups: { <id>: 'hide' | 'move' }` plus `group: '<id>'` on `icon-select` areas
(see README → Activities → Area groups); enforced server-side, validated at startup.

## 3. Ready check

An admin starts a ready check; every member answers ready / not ready;
everyone sees when all are ready.

- **Who:** only admins can start (and abort) a ready check — regardless of
  guided mode; enforced server-side.
- **Lifetime:** no timeout. The check stays open until every member has
  answered, or an admin aborts it.

- **View (both clients):** while a check runs, it replaces the board: every
  member as a big card with their answer (✅ / ❌ / ⏳ pending), and below them
  big, fully opaque Ready / Not ready buttons for your own answer. The result
  stays on the same view for 6 s, then the board returns. The web member
  list also shows the answers; the locked overlay shows "Press F9 to answer".
- **Hidden overlay:** brought up (without focus) while a check waits for
  your answer, and returned to its previous state afterwards.
- **Server:** stores answers per member for the running check and sends them
  with the existing per-client `members` list (names and flags only, never
  client IDs). Members joining mid-check count as pending; members leaving
  (after the reconnect grace period) drop out of the tally — which can
  complete the check if everyone remaining has answered.

## 4. Electron app auto-update

The overlay updates itself instead of every user installing new versions by
hand — needed because server protocol changes (e.g. the admin/ready-check
changes) break older overlays.

- **Approach:** package the app with `electron-builder` (an NSIS installer for
  Windows — there's no packaging setup yet) and update via `electron-updater`
  from GitHub Releases: check on start (and periodically), download in the
  background.
- **Silent updates (decided):** no prompt and never a restart mid-game — the
  downloaded update installs silently when the app quits and is active on
  the next start.
- **Code signing (decided: unsigned for now):** no certificate yet, so
  installers ship unsigned. Consequences: Windows SmartScreen warns on the
  first install ("More info → Run anyway"), and `electron-updater` can't
  verify a publisher signature — integrity then rests on HTTPS plus the
  SHA-512 hashes in the release's `latest.yml`, i.e. on whoever controls the
  release repo (protect that GitHub account with 2FA). Signing can be added
  later without changing the update flow. Options for a certificate: Azure
  Artifact Signing (~$10/month, but individuals only in US/Canada — EU
  organizations qualify) or an OV certificate from a CA such as Certum or
  Sectigo (~€50–300/year, key in the CA's cloud or on a hardware token).
- **Release source (decided):** this repo, now public; releases are built,
  Sigstore-signed and published by `.github/workflows/release.yml` on a
  version tag, and verified by the app before installing (`updater.js`).
- **No server built in:** the overlay works with any server — it comes from
  `lfgbuddy://<server>/<code>` links (the web invite link with `lfgbuddy://`)
  or the setup screen, with a one-time confirmation per new server and a
  separate client ID per server — so one installer serves every server and
  fork.

## 5. Timer

Admin starts a timer (presets in minutes or a custom duration, optional
text, optionally shown instead of the board); all clients show it in sync.

Notes:
- Server stores the end time and broadcasts the remaining duration; clients
  count down locally — no per-second broadcasts, robust against clock skew.

## 6. External picture via URL

Show a picture from an arbitrary URL (e.g. a custom strat map) to the room.

Security considerations (must be resolved before implementation):
- Loading the URL directly in every client leaks every member's IP to an
  arbitrary host and requires loosening the Electron CSP `img-src`.
- Proxying through the server avoids both but introduces SSRF risk: block
  private/loopback/link-local ranges (after DNS resolution), allow only
  `https`, cap size, verify the content type, and ideally re-encode.
- Restrict to the room admin and validate URL length/scheme server-side.
