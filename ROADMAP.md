# Roadmap

Planned features, in intended order. Every feature ships in **both** clients
(Electron overlay `client/` and web `server/public/`) and is room-synced and
guided-mode-aware unless stated otherwise.

| # | Feature | Status |
|---|---|---|
| 1 | [Drawing pane](#1-drawing-pane) | Done |
| 2 | [Interactive areas grouping](#2-interactive-areas-grouping) | Done |
| 3 | [Ready check](#3-ready-check) | Planned |
| 4 | [Countdown timer](#4-countdown-timer) | Planned |
| 5 | [External picture via URL](#5-external-picture-via-url) | Planned |

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

- **Web:** each member's answer is shown next to their name in the member
  list (e.g. ✅ / ❌ / ⏳ pending), so it's clear *who* isn't ready yet.
- **Electron overlay:** no member list there, so it shows a compact tally
  ("4/6 ready") plus its own Ready / Not ready buttons.
- **Server:** stores answers per member for the running check and sends them
  with the existing per-client `members` list (names and flags only, never
  client IDs). Members joining mid-check count as pending; members leaving
  (after the reconnect grace period) drop out of the tally — which can
  complete the check if everyone remaining has answered.

## 4. Countdown timer

Admin starts a countdown (e.g. 5 s / 10 s / custom); all clients show it in
sync.

Notes:
- Server stores the end time and broadcasts the remaining duration; clients
  count down locally — no per-second broadcasts, robust against clock skew.

## 5. External picture via URL

Show a picture from an arbitrary URL (e.g. a custom strat map) to the room.

Security considerations (must be resolved before implementation):
- Loading the URL directly in every client leaks every member's IP to an
  arbitrary host and requires loosening the Electron CSP `img-src`.
- Proxying through the server avoids both but introduces SSRF risk: block
  private/loopback/link-local ranges (after DNS resolution), allow only
  `https`, cap size, verify the content type, and ideally re-encode.
- Restrict to the room admin and validate URL length/scheme server-side.
