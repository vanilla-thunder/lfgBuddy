'use strict';

// Shared drawing board for the encounter view, used by both clients: the
// Electron overlay loads it from ../shared/, the web client from /shared/
// (served by server/index.js). One file — unlike overlay.js/app.js, there's
// nothing to keep in sync by hand.
//
// Strokes are vectors in board units (0..COORD_MAX on both axes, relative to
// the encounter picture), so they line up on every client no matter how
// large the board renders. Rendering is a plain in-order replay of the
// stroke list. Each stroke has an `id` naming the line it belongs to — a
// long line is split into several strokes that share it — and the eraser
// removes whole lines by that id.
//
// Own strokes and erasures are applied optimistically (the server relays
// them to everyone else); clear and image toggle wait for the server's
// broadcast.

// Index = color id on the wire; the server only checks the range.
const DRAW_COLORS = [
  { label: 'White', hex: '#ffffff' },
  { label: 'Red', hex: '#ef4444' },
  { label: 'Green', hex: '#22c55e' },
  { label: 'Blue', hex: '#3b82f6' },
  { label: 'Yellow', hex: '#fde047' },
  { label: 'Black', hex: '#000000' },
];

// Must match server/index.js — anything over these is dropped server-side.
const DRAW_COORD_MAX = 10000;
const DRAW_MAX_STROKE_POINTS = 1000;
const DRAW_MAX_ENCOUNTER_POINTS = 20000;
const DRAW_MAX_ENCOUNTER_STROKES = 1000;

// Pointer samples closer than this (board units) to the previous point are
// skipped — keeps strokes small without visibly changing their shape.
const DRAW_MIN_POINT_DISTANCE = 15;
// Pen line width and eraser hit radius, as a fraction of the board's
// rendered width.
const DRAW_PEN_WIDTH = 0.005;
const DRAW_ERASER_RADIUS = 0.012;

// Random line id; getRandomValues (unlike randomUUID) also works on plain
// http, e.g. a LAN dev server opened from a phone.
function newStrokeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.wrap      .encounter-wrap (gets drawing/image-hidden classes)
 * @param {HTMLCanvasElement} opts.canvas
 * @param {HTMLElement} opts.toolbar   empty container; buttons are built here
 * @param {() => ({ encounterId: string, encounterState: { strokes: object[], imageHidden: boolean } } | null)} opts.getCurrent
 *        current encounter and its *stored* state object (mutated on own strokes)
 * @param {() => boolean} opts.canDraw
 * @param {(event: string, data: object) => void} opts.emit
 */
// eslint-disable-next-line no-unused-vars
function createDrawingBoard({ wrap, canvas, toolbar, getCurrent, canDraw, emit }) {
  const ctx = canvas.getContext('2d');
  let tool = null; // null = click through to the encounter areas
  let color = 1;
  // In-progress drag: { pointerId, encounterId, rect } plus `stroke` (pen)
  // or `last` (eraser: previous position in canvas px).
  let active = null;

  // ── Toolbar ──────────────────────────────────────────────────────────────

  function makeButton(title, content, parent = toolbar) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'draw-btn';
    btn.title = title;
    btn.textContent = content;
    parent.appendChild(btn);
    return btn;
  }

  const imageBtn = makeButton('Show / hide encounter picture', '🖼️');
  const penBtn = makeButton('Pen', '✏️');

  // Color picker: one button showing the current color, opening a popup
  // with all swatches (like a text editor's font-color picker).
  const colorWrap = document.createElement('div');
  colorWrap.className = 'draw-color';
  toolbar.appendChild(colorWrap);
  const colorBtn = makeButton('Color', '', colorWrap);
  const colorDot = document.createElement('span');
  colorDot.className = 'draw-color-dot';
  colorBtn.appendChild(colorDot);

  const colorPopup = document.createElement('div');
  colorPopup.className = 'draw-color-popup hidden';
  colorWrap.appendChild(colorPopup);

  const swatches = DRAW_COLORS.map(({ label, hex }, index) => {
    const btn = makeButton(label, '', colorPopup);
    btn.className = 'draw-swatch';
    btn.style.backgroundColor = hex;
    btn.addEventListener('click', () => {
      color = index;
      tool = 'pen';
      closeColorPopup();
      updateControls();
    });
    return btn;
  });

  function closeColorPopup() {
    colorPopup.classList.add('hidden');
    colorBtn.classList.remove('open');
  }

  colorBtn.addEventListener('click', () => {
    const open = colorPopup.classList.toggle('hidden') === false;
    colorBtn.classList.toggle('open', open);
  });
  document.addEventListener('pointerdown', (event) => {
    if (!colorWrap.contains(event.target)) closeColorPopup();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeColorPopup();
  });

  const eraserBtn = makeButton('Eraser', '🧽');
  const clearBtn = makeButton('Clear drawing', '🗑️');
  const allButtons = [imageBtn, penBtn, colorBtn, eraserBtn, clearBtn, ...swatches];

  // Moves the sidebar to the other side of the board (the .board parent
  // gets .toolbar-flipped). A per-device layout preference, not room state:
  // remembered in localStorage, never synced, and always usable.
  const SIDE_KEY = 'lfg_draw_toolbar_flipped';
  const board = toolbar.parentElement;
  const sideBtn = makeButton('Move toolbar to the other side', '⇄');
  sideBtn.classList.add('draw-side');

  function setFlipped(flipped) {
    board.classList.toggle('toolbar-flipped', flipped);
    try {
      localStorage.setItem(SIDE_KEY, flipped ? '1' : '0');
    } catch {
      // storage unavailable (private mode etc.) — just not remembered
    }
  }

  let storedSide = null;
  try {
    storedSide = localStorage.getItem(SIDE_KEY);
  } catch {
    // ignore
  }
  board.classList.toggle('toolbar-flipped', storedSide === '1');
  sideBtn.addEventListener('click', () => {
    closeColorPopup();
    setFlipped(!board.classList.contains('toolbar-flipped'));
  });

  function toggleTool(next) {
    tool = tool === next ? null : next;
    updateControls();
  }

  penBtn.addEventListener('click', () => toggleTool('pen'));
  eraserBtn.addEventListener('click', () => toggleTool('eraser'));

  imageBtn.addEventListener('click', () => {
    const current = getCurrent();
    if (!current || !canDraw()) return;
    emit('set-image-hidden', { encounterId: current.encounterId, hidden: !current.encounterState.imageHidden });
  });

  clearBtn.addEventListener('click', () => {
    const current = getCurrent();
    if (!current || !canDraw()) return;
    emit('clear-drawing', { encounterId: current.encounterId });
  });

  function updateControls() {
    const current = getCurrent();
    const enabled = Boolean(current) && canDraw();
    if (!enabled) {
      cancelStroke();
      closeColorPopup();
    }

    for (const btn of allButtons) btn.disabled = !enabled;
    imageBtn.classList.toggle('active', !current?.encounterState.imageHidden);
    penBtn.classList.toggle('active', tool === 'pen');
    eraserBtn.classList.toggle('active', tool === 'eraser');
    colorDot.style.backgroundColor = DRAW_COLORS[color].hex;
    colorBtn.title = `Color: ${DRAW_COLORS[color].label}`;
    swatches.forEach((btn, index) => btn.classList.toggle('active', index === color));

    wrap.classList.toggle('drawing', enabled && tool !== null);
    wrap.classList.toggle('image-hidden', Boolean(current?.encounterState.imageHidden));
  }

  // Briefly marks the clear button when the encounter's drawing budget is
  // used up, hinting that clearing is the way to keep drawing.
  function flashFull() {
    clearBtn.classList.add('draw-full');
    clearBtn.title = 'Drawing limit reached — clear to keep drawing';
    setTimeout(() => {
      clearBtn.classList.remove('draw-full');
      clearBtn.title = 'Clear drawing';
    }, 1500);
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function pointCount(stroke) {
    return stroke.points.length / 2;
  }

  function encounterPointCount(encounterState) {
    return encounterState.strokes.reduce((sum, stroke) => sum + pointCount(stroke), 0);
  }

  function penWidth() {
    return Math.max(2, canvas.width * DRAW_PEN_WIDTH);
  }

  // Draws the stroke from point `fromPoint` on (connected to the point
  // before it), so a live stroke can be extended segment by segment.
  function drawStroke(stroke, fromPoint = 0) {
    const { points } = stroke;
    const sx = canvas.width / DRAW_COORD_MAX;
    const sy = canvas.height / DRAW_COORD_MAX;
    const start = Math.max(0, fromPoint - 1);

    ctx.strokeStyle = DRAW_COLORS[stroke.color]?.hex ?? DRAW_COLORS[0].hex;
    ctx.lineWidth = penWidth();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // A one-point stroke (a tap) still renders: a zero-length line with
    // round caps is a dot.
    ctx.beginPath();
    ctx.moveTo(points[start * 2] * sx, points[start * 2 + 1] * sy);
    for (let i = start; i < points.length / 2; i++) {
      ctx.lineTo(points[i * 2] * sx, points[i * 2 + 1] * sy);
    }
    ctx.stroke();
  }

  function redraw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of getCurrent()?.encounterState.strokes ?? []) drawStroke(stroke);
    if (active?.stroke) drawStroke(active.stroke);
  }

  // Bitmap size follows the rendered size (incl. devicePixelRatio and the
  // page's CSS zoom, both already in getBoundingClientRect) so lines stay
  // crisp. Resizing clears the bitmap, so callers redraw afterwards.
  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.round(rect.width * devicePixelRatio);
    const height = Math.round(rect.height * devicePixelRatio);
    if (canvas.width === width && canvas.height === height) return false;
    canvas.width = width;
    canvas.height = height;
    return true;
  }

  new ResizeObserver(() => {
    if (resizeCanvas()) redraw();
  }).observe(canvas);

  // ── Pointer input (mouse, pen and touch alike) ───────────────────────────

  function boardPoint(event) {
    const { rect } = active;
    const clamp = (v) => Math.min(DRAW_COORD_MAX, Math.max(0, Math.round(v)));
    return {
      x: clamp(((event.clientX - rect.left) / rect.width) * DRAW_COORD_MAX),
      y: clamp(((event.clientY - rect.top) / rect.height) * DRAW_COORD_MAX),
    };
  }

  function addPoint(event, force) {
    const { x, y } = boardPoint(event);
    const { points } = active.stroke;
    if (!force && points.length >= 2) {
      const dx = x - points[points.length - 2];
      const dy = y - points[points.length - 1];
      if (dx * dx + dy * dy < DRAW_MIN_POINT_DISTANCE * DRAW_MIN_POINT_DISTANCE) return;
    }
    points.push(x, y);
  }

  // Returns false if the stroke didn't fit the encounter's budget (and was
  // dropped, so the canvas is redrawn without it).
  function commitStroke(encounterId, stroke) {
    const current = getCurrent();
    if (!current || current.encounterId !== encounterId) return false;
    const { encounterState } = current;

    if (encounterState.strokes.length >= DRAW_MAX_ENCOUNTER_STROKES
      || encounterPointCount(encounterState) + pointCount(stroke) > DRAW_MAX_ENCOUNTER_POINTS) {
      flashFull();
      return false;
    }

    encounterState.strokes.push(stroke);
    emit('draw-stroke', { encounterId, id: stroke.id, color: stroke.color, points: stroke.points });
    return true;
  }

  function cancelStroke() {
    if (!active) return;
    active = null;
    redraw();
  }

  function finishStroke() {
    if (!active) return;
    const { encounterId, stroke } = active;
    active = null;
    if (stroke && !commitStroke(encounterId, stroke)) redraw();
  }

  // ── Eraser: removes every line the eraser circle touches ─────────────────

  // Squared distance from point p to segment a–b (all in canvas px).
  function segmentDistanceSq(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq));
    const cx = ax + t * dx - px;
    const cy = ay + t * dy - py;
    return cx * cx + cy * cy;
  }

  function strokeHit(stroke, px, py, reach) {
    const { points } = stroke;
    const sx = canvas.width / DRAW_COORD_MAX;
    const sy = canvas.height / DRAW_COORD_MAX;
    const reachSq = reach * reach;
    // A one-point stroke (a dot) is a zero-length segment.
    const last = points.length / 2 - 1;
    for (let i = 0; i <= Math.max(0, last - 1); i++) {
      const j = Math.min(i + 1, last);
      const distSq = segmentDistanceSq(
        px, py,
        points[i * 2] * sx, points[i * 2 + 1] * sy,
        points[j * 2] * sx, points[j * 2 + 1] * sy,
      );
      if (distSq <= reachSq) return true;
    }
    return false;
  }

  // Erases along the path from the previous eraser position to (px, py),
  // sampled at half the radius so a fast swipe can't skip over a line.
  function eraseAlong(px, py) {
    const current = getCurrent();
    if (!current || current.encounterId !== active.encounterId) return;
    const { encounterState } = current;

    const radius = Math.max(6 * devicePixelRatio, canvas.width * DRAW_ERASER_RADIUS);
    const reach = radius + penWidth() / 2;
    const { x: lx, y: ly } = active.last;
    const steps = Math.max(1, Math.ceil(Math.hypot(px - lx, py - ly) / (radius / 2)));
    active.last = { x: px, y: py };

    const hitIds = new Set();
    for (const stroke of encounterState.strokes) {
      if (hitIds.has(stroke.id)) continue;
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        if (strokeHit(stroke, lx + (px - lx) * t, ly + (py - ly) * t, reach)) {
          hitIds.add(stroke.id);
          break;
        }
      }
    }
    if (hitIds.size === 0) return;

    encounterState.strokes = encounterState.strokes.filter((stroke) => !hitIds.has(stroke.id));
    redraw();
    for (const strokeId of hitIds) emit('erase-stroke', { encounterId: active.encounterId, strokeId });
  }

  function eraserPoint(event) {
    const { rect } = active;
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  // ── Pointer events ───────────────────────────────────────────────────────

  canvas.addEventListener('pointerdown', (event) => {
    if (active || !tool || !canDraw()) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const current = getCurrent();
    if (!current) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    if (tool === 'pen' && (current.encounterState.strokes.length >= DRAW_MAX_ENCOUNTER_STROKES
      || encounterPointCount(current.encounterState) >= DRAW_MAX_ENCOUNTER_POINTS)) {
      flashFull();
      return;
    }

    event.preventDefault();
    // Keeps the drag going when the pointer leaves the canvas. Throws if
    // the pointer is already gone — drawing still works without it.
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
    active = { pointerId: event.pointerId, encounterId: current.encounterId, rect };

    if (tool === 'eraser') {
      active.last = eraserPoint(event);
      eraseAlong(active.last.x, active.last.y);
      return;
    }
    active.stroke = { id: newStrokeId(), color, points: [] };
    addPoint(event, true);
    drawStroke(active.stroke);
  });

  canvas.addEventListener('pointermove', (event) => {
    if (event.pointerId !== active?.pointerId) return;
    if (!canDraw()) {
      cancelStroke();
      return;
    }

    // Coalesced events carry the samples the browser merged between
    // frames — without them fast strokes come out jagged.
    const coalesced = event.getCoalescedEvents?.() ?? [];
    const samples = coalesced.length ? coalesced : [event];

    if (!active.stroke) {
      const { x, y } = eraserPoint(samples[samples.length - 1]);
      eraseAlong(x, y);
      return;
    }

    const before = pointCount(active.stroke);
    for (const sample of samples) addPoint(sample, false);
    if (pointCount(active.stroke) > before) drawStroke(active.stroke, before);

    // Long lines are split into consecutive strokes that continue from the
    // last point and share the line's id, so there's no visible break, no
    // per-line cap, and the eraser still removes the whole line.
    if (pointCount(active.stroke) >= DRAW_MAX_STROKE_POINTS) {
      const { encounterId, stroke } = active;
      const lastPoint = stroke.points.slice(-2);
      if (!commitStroke(encounterId, stroke)) {
        active = null;
        redraw();
        return;
      }
      active.stroke = { id: stroke.id, color: stroke.color, points: lastPoint };
    }
  });

  canvas.addEventListener('pointerup', (event) => {
    if (event.pointerId !== active?.pointerId) return;
    if (active.stroke) addPoint(event, false);
    finishStroke();
  });
  canvas.addEventListener('pointercancel', (event) => {
    if (event.pointerId === active?.pointerId) finishStroke();
  });

  return {
    // Full refresh: after state-sync, encounter changes, clear, erase or
    // image toggle.
    render() {
      // Another member's change mustn't drop a line being drawn right now —
      // only a different encounter cancels it.
      if (active && getCurrent()?.encounterId !== active.encounterId) active = null;
      updateControls();
      resizeCanvas();
      redraw();
    },
    // A stroke from another member, already stored in state — drawn on top.
    appendStroke(stroke) {
      drawStroke(stroke);
    },
    // Permission changes (guided mode, Electron F9) only affect controls.
    updateControls,
  };
}
