'use strict';

// Timer display and start dialog, shared by both clients. The server sends
// only the remaining time (event `timer`, and `timer` in state-sync for late
// joiners) plus an optional text and whether to show it instead of the
// board; each client counts down on its own monotonic clock
// (performance.now()), so system clocks don't matter.

const TIMER_PRESET_MINUTES = [1, 2, 3, 5, 10];
// Must match server/index.js.
const TIMER_MIN_SECONDS = 1;
const TIMER_MAX_SECONDS = 60 * 60;
const TIMER_MAX_LABEL_LENGTH = 60;
const TIMER_GO_MS = 2000;
const TIMER_FINAL_MS = 3000;
// state-sync without a timer while ours is about to end means it just ended
// on the server too — let ours finish (and show GO) instead.
const TIMER_END_TOLERANCE_MS = 1000;

function formatTimer(ms) {
  const seconds = Math.ceil(ms / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : String(seconds);
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.container  empty element; the display is built here
 * @param {HTMLElement} opts.host       board container; gets .timer-replaces-board
 *                                      while a timer is shown instead of the board
 * @param {(event: string, data: object) => void} opts.emit
 * @param {() => boolean} opts.isAdmin  shows Cancel for admins
 */
// eslint-disable-next-line no-unused-vars
function createTimer({ container, host, emit, isAdmin }) {
  container.classList.add('timer', 'hidden');
  container.setAttribute('role', 'timer');

  const number = document.createElement('div');
  number.className = 'timer-number';
  // Text from other users: textContent only, never HTML.
  const label = document.createElement('div');
  label.className = 'timer-label';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'timer-cancel';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => emit('cancel-timer', {}));
  container.append(number, label, cancelBtn);

  let endAt = null; // performance.now() timestamp while running
  let tickTimer = null;
  let goTimer = null;

  function setReplaceBoard(replace) {
    container.classList.toggle('timer-large', replace);
    host.classList.toggle('timer-replaces-board', replace);
  }

  function hide() {
    clearTimeout(tickTimer);
    clearTimeout(goTimer);
    endAt = null;
    container.classList.add('hidden');
    container.classList.remove('timer-final', 'timer-go');
    setReplaceBoard(false);
  }

  function tick() {
    const remaining = endAt - performance.now();
    if (remaining <= 0) {
      endAt = null;
      number.textContent = 'GO!';
      cancelBtn.classList.add('hidden');
      container.classList.remove('timer-final');
      container.classList.add('timer-go');
      goTimer = setTimeout(hide, TIMER_GO_MS);
      return;
    }
    number.textContent = formatTimer(remaining);
    container.classList.toggle('timer-final', remaining <= TIMER_FINAL_MS);
    // Wake at the next whole-second boundary.
    tickTimer = setTimeout(tick, (remaining % 1000) || 1000);
  }

  // payload: { remainingMs, durationMs, label, replaceBoard } or null
  // (cancelled / none running). fromSync: it came with a state-sync (see
  // TIMER_END_TOLERANCE_MS).
  function apply(payload, fromSync = false) {
    if (!payload) {
      if (endAt === null) return; // nothing running (maybe showing GO)
      if (fromSync && endAt - performance.now() < TIMER_END_TOLERANCE_MS) return;
      hide();
      return;
    }
    clearTimeout(tickTimer);
    clearTimeout(goTimer);
    endAt = performance.now() + payload.remainingMs;
    label.textContent = payload.label ?? '';
    label.classList.toggle('hidden', !payload.label);
    setReplaceBoard(payload.replaceBoard === true);
    container.classList.remove('hidden', 'timer-go');
    cancelBtn.classList.toggle('hidden', !isAdmin());
    tick();
  }

  // Admin rights can change while one runs.
  function updateControls() {
    cancelBtn.classList.toggle('hidden', endAt === null || !isAdmin());
  }

  return { apply, hide, updateControls };
}

// ── Start dialog (admins) ─────────────────────────────────────────────────────

let timerDialog = null;
let timerStartHandler = null;

function closeTimerDialog() {
  timerDialog?.classList.add('hidden');
}

function timerEl(tag, className, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * Opens the start dialog: preset minutes, a custom duration (minutes by
 * default, or seconds), optional text, and whether to show the timer
 * instead of the board. Inputs keep their values between openings.
 * @param {(options: { seconds: number, label: string, replaceBoard: boolean }) => void} onStart
 */
// eslint-disable-next-line no-unused-vars
function openTimerDialog(onStart) {
  timerStartHandler = onStart;
  if (timerDialog) {
    timerDialog.classList.remove('hidden');
    return;
  }

  timerDialog = timerEl('div', 'timer-modal');
  const card = timerEl('div', 'timer-card');

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'timer-text-input';
  labelInput.maxLength = TIMER_MAX_LABEL_LENGTH;
  labelInput.placeholder = 'Text (optional), e.g. Pull boss';
  labelInput.setAttribute('aria-label', 'Timer text');

  const replaceRow = timerEl('label', 'timer-replace');
  const replaceBox = document.createElement('input');
  replaceBox.type = 'checkbox';
  replaceRow.append(replaceBox, document.createTextNode(' Show instead of the board'));

  function start(seconds) {
    if (!Number.isInteger(seconds) || seconds < TIMER_MIN_SECONDS || seconds > TIMER_MAX_SECONDS) return false;
    closeTimerDialog();
    timerStartHandler?.({ seconds, label: labelInput.value.trim(), replaceBoard: replaceBox.checked });
    return true;
  }

  const presets = timerEl('div', 'timer-presets');
  for (const minutes of TIMER_PRESET_MINUTES) {
    const btn = timerEl('button', 'timer-preset', `${minutes} min`);
    btn.type = 'button';
    btn.addEventListener('click', () => start(minutes * 60));
    presets.appendChild(btn);
  }

  const custom = timerEl('form', 'timer-custom');
  const amount = document.createElement('input');
  amount.type = 'number';
  amount.min = '0';
  amount.step = 'any';
  amount.placeholder = 'custom';
  amount.setAttribute('aria-label', 'Custom duration');
  const unit = document.createElement('select');
  unit.setAttribute('aria-label', 'Unit');
  for (const [value, text] of [['min', 'min'], ['sec', 'sec']]) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    unit.appendChild(option);
  }
  const startBtn = timerEl('button', 'timer-preset', 'Start');
  startBtn.type = 'submit';
  custom.append(amount, unit, startBtn);
  custom.addEventListener('submit', (event) => {
    event.preventDefault();
    const seconds = Math.round(Number(amount.value) * (unit.value === 'min' ? 60 : 1));
    if (!start(seconds)) {
      amount.focus();
      amount.select();
    }
  });

  const closeBtn = timerEl('button', 'timer-close', 'Close');
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', closeTimerDialog);

  card.append(timerEl('div', 'timer-card-title', 'Start timer'), labelInput, replaceRow, presets, custom, closeBtn);
  timerDialog.appendChild(card);
  timerDialog.addEventListener('click', (event) => {
    if (event.target === timerDialog) closeTimerDialog();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeTimerDialog();
  });
  document.body.appendChild(timerDialog);
}
