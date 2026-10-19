'use strict';

// "External picture" dialog (admins), shared by both clients: enter a URL to
// replace the current encounter's picture, or remove the replacement. The
// server downloads and checks the picture (server/external-image.js); its
// answer arrives as `custom-image-updated` (→ close) or `custom-image-error`
// (→ shown here).

let pictureDialog = null;

/**
 * @param {object} opts
 * @param {string|null} opts.currentHost  host of the picture in use, or null
 * @param {(url: string) => void} opts.onLoad
 * @param {() => void} opts.onRemove
 * @returns {{ showError(message: string): void, close(): void }}
 */
// eslint-disable-next-line no-unused-vars
function openPictureDialog({ currentHost, onLoad, onRemove }) {
  if (!pictureDialog) pictureDialog = buildPictureDialog();
  const { modal, input, status, loadBtn, removeBtn, current } = pictureDialog;

  pictureDialog.onLoad = onLoad;
  pictureDialog.onRemove = onRemove;
  // Host names come from user input (via the server): text only.
  current.textContent = currentHost ? `Current picture from ${currentHost}` : 'Using the encounter’s own picture';
  removeBtn.classList.toggle('hidden', !currentHost);
  status.textContent = '';
  status.className = 'picture-status';
  loadBtn.disabled = false;
  modal.classList.remove('hidden');
  input.focus();
  input.select();

  return {
    showError(message) {
      status.textContent = message;
      status.className = 'picture-status error';
      loadBtn.disabled = false;
    },
    close: closePictureDialog,
  };
}

function closePictureDialog() {
  pictureDialog?.modal.classList.add('hidden');
}

function buildPictureDialog() {
  const make = (tag, className, text = '') => {
    const node = document.createElement(tag);
    node.className = className;
    node.textContent = text;
    return node;
  };

  const modal = make('div', 'picture-modal hidden');
  const card = make('form', 'picture-card');
  const title = make('div', 'picture-title', 'Picture from URL');
  const current = make('div', 'picture-current');
  const input = document.createElement('input');
  input.type = 'url';
  input.className = 'picture-input';
  input.placeholder = 'https://…/strat-map.png';
  input.maxLength = 2048;
  input.setAttribute('aria-label', 'Picture URL');
  const hint = make('div', 'picture-hint', 'Direct https link to a PNG, JPEG, GIF or WebP (max 5 MB). The server downloads it once and shares it with the room.');
  const status = make('div', 'picture-status');
  const buttons = make('div', 'picture-buttons');
  const loadBtn = make('button', 'picture-btn', 'Load');
  loadBtn.type = 'submit';
  const removeBtn = make('button', 'picture-btn picture-remove', 'Remove picture');
  removeBtn.type = 'button';
  const closeBtn = make('button', 'picture-btn', 'Close');
  closeBtn.type = 'button';
  buttons.append(loadBtn, removeBtn, closeBtn);
  card.append(title, current, input, hint, status, buttons);
  modal.appendChild(card);
  document.body.appendChild(modal);

  const dialog = { modal, input, status, loadBtn, removeBtn, current, onLoad: null, onRemove: null };

  card.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = input.value.trim();
    if (!url) {
      input.focus();
      return;
    }
    status.textContent = 'Loading…';
    status.className = 'picture-status';
    loadBtn.disabled = true;
    dialog.onLoad?.(url);
  });
  removeBtn.addEventListener('click', () => {
    dialog.onRemove?.();
    closePictureDialog();
  });
  closeBtn.addEventListener('click', closePictureDialog);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closePictureDialog();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePictureDialog();
  });
  return dialog;
}
