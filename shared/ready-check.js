'use strict';

// Ready check view, shared by both clients. While a check runs (and for a
// few seconds after it ends) it replaces the board — activity picker or
// encounter — inside `host`: every member as a big card with their answer,
// and below them this client's own Ready / Not ready buttons.
//
// All state comes from the server's per-client `members` list (each entry's
// `ready`: 'ready' | 'not-ready' | 'pending', or null while no check runs)
// plus the `ready-check-done` result event — nothing is decided locally.
// The server sends the members list with the final answer before
// `ready-check-done`, so the last snapshot is the final result.

const READY_RESULT_MS = 6000;
const READY_MARKS = { ready: '✅', 'not-ready': '❌', pending: '⏳' };

// eslint-disable-next-line no-unused-vars
function isReadyCheckOpen(members) {
  return members.some((member) => member.ready !== null);
}

// Prefix for a member's name in a member list ('' while no check runs).
// eslint-disable-next-line no-unused-vars
function readyMark(member) {
  return member.ready ? `${READY_MARKS[member.ready]} ` : '';
}

function readyTally(members) {
  const ready = members.filter((m) => m.ready === 'ready').length;
  const notReady = members.filter((m) => m.ready === 'not-ready').length;
  return `${ready}/${members.length} ready${notReady ? ` · ${notReady} not ready` : ''}`;
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.host       board container; gets .ready-check-active
 *                                      (CSS hides its other children then)
 * @param {HTMLElement} opts.container  empty element inside host; the view is built here
 * @param {(event: string, data: object) => void} opts.emit
 * @param {() => boolean} opts.isAdmin  shows Abort for admins
 */
// eslint-disable-next-line no-unused-vars
function createReadyCheckView({ host, container, emit, isAdmin }) {
  container.classList.add('ready-check', 'hidden');

  function el(tag, className, text = '') {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    const btn = el('button', className, label);
    btn.type = 'button';
    btn.addEventListener('click', onClick);
    return btn;
  }

  const title = el('div', 'ready-title');
  const tally = el('div', 'ready-tally');
  const cards = el('div', 'ready-members');
  const actions = el('div', 'ready-actions');
  const readyBtn = button('✅ Ready', 'ready-answer ready-yes', () => emit('ready-answer', { ready: true }));
  const notReadyBtn = button('❌ Not ready', 'ready-answer ready-no', () => emit('ready-answer', { ready: false }));
  actions.append(readyBtn, notReadyBtn);
  // Only visible in the locked (click-through) overlay, where the buttons
  // can't be clicked — see client/overlay.css.
  const lockedHint = el('div', 'ready-locked-hint', 'Press F9 to answer');
  const abortBtn = button('Abort ready check', 'ready-secondary ready-abort', () => emit('abort-ready-check', {}));
  const closeBtn = button('Close', 'ready-secondary', () => hide());
  const footer = el('div', 'ready-footer');
  footer.append(abortBtn, closeBtn);
  container.append(title, tally, cards, actions, lockedHint, footer);

  // Last members list of the running check: the result screen shows it.
  let snapshot = [];
  let resultTimer = null;

  function setActive(active) {
    host.classList.toggle('ready-check-active', active);
    container.classList.toggle('hidden', !active);
  }

  // Names are user input: rendered via textContent only, never as HTML.
  function renderCards(members) {
    cards.replaceChildren();
    for (const member of members) {
      const status = member.ready ?? 'pending';
      const card = el('div', `ready-member ready-${status}`);
      card.classList.toggle('offline', !member.online);
      card.classList.toggle('self', member.self);
      card.append(
        el('span', 'ready-icon', READY_MARKS[status]),
        el('span', 'ready-name', `${member.isAdmin ? '👑 ' : ''}${member.name}${member.self ? ' (you)' : ''}`),
      );
      cards.appendChild(card);
    }
  }

  function update(members) {
    if (!isReadyCheckOpen(members)) {
      if (!resultTimer) setActive(false);
      return;
    }
    clearTimeout(resultTimer);
    resultTimer = null;
    snapshot = members;

    const own = members.find((m) => m.self)?.ready;
    title.textContent = 'Ready check';
    tally.textContent = readyTally(members);
    renderCards(members);
    readyBtn.classList.toggle('active', own === 'ready');
    notReadyBtn.classList.toggle('active', own === 'not-ready');
    actions.classList.remove('hidden');
    lockedHint.classList.remove('hidden');
    abortBtn.classList.toggle('hidden', !isAdmin());
    closeBtn.classList.add('hidden');
    container.classList.remove('ready-all', 'ready-not-all');
    setActive(true);
  }

  function showResult({ outcome, ready, total }) {
    const allReady = outcome === 'complete' && ready === total;
    title.textContent = outcome === 'aborted' ? 'Ready check aborted' : allReady ? 'Everyone is ready ✅' : 'Not everyone is ready ❌';
    tally.textContent = readyTally(snapshot);
    renderCards(snapshot);
    actions.classList.add('hidden');
    lockedHint.classList.add('hidden');
    abortBtn.classList.add('hidden');
    closeBtn.classList.remove('hidden');
    container.classList.toggle('ready-all', allReady);
    container.classList.toggle('ready-not-all', !allReady);
    setActive(true);

    clearTimeout(resultTimer);
    resultTimer = setTimeout(hide, READY_RESULT_MS);
  }

  function hide() {
    clearTimeout(resultTimer);
    resultTimer = null;
    snapshot = [];
    setActive(false);
  }

  return { update, showResult, hide };
}
