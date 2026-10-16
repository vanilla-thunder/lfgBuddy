'use strict';

// Admin link as a QR code, so a phone can join as co-admin by scanning the
// screen instead of the link being sent to it. Shared by both clients, like
// drawing.js; needs shared/vendor/qrcode-generator.js loaded first.
//
// Drawn on a <canvas> from the module matrix — no image URLs, so it works
// under the Electron overlay's CSP. Anyone who scans the code becomes an
// admin, and the overlay is often on a streamed/shared screen, so the popup
// says so and closes itself after a minute.

const ADMIN_QR_AUTO_CLOSE_MS = 60000;
const ADMIN_QR_QUIET_ZONE = 4; // modules of white border the QR spec requires

let adminQrModal = null;
let adminQrTimer = null;

// Renders `text` into the canvas: black modules on white, sized in whole
// device pixels per module so the code stays sharp and scannable.
function drawQrCode(canvas, text, cssSize) {
  const qr = qrcode(0, 'M'); // eslint-disable-line no-undef -- shared/vendor/qrcode-generator.js
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const modules = count + ADMIN_QR_QUIET_ZONE * 2;
  const scale = Math.max(1, Math.floor((cssSize * devicePixelRatio) / modules));
  canvas.width = canvas.height = modules * scale;

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) {
        ctx.fillRect((col + ADMIN_QR_QUIET_ZONE) * scale, (row + ADMIN_QR_QUIET_ZONE) * scale, scale, scale);
      }
    }
  }
}

function buildAdminQrModal() {
  const modal = document.createElement('div');
  modal.className = 'qr-modal hidden';

  const card = document.createElement('div');
  card.className = 'qr-card';
  modal.appendChild(card);

  const title = document.createElement('div');
  title.className = 'qr-title';
  title.textContent = 'Scan to join as admin';

  const canvas = document.createElement('canvas');
  canvas.className = 'qr-canvas';

  const hint = document.createElement('div');
  hint.className = 'qr-hint';
  hint.textContent = 'Anyone who scans this becomes an admin of the room — don’t show it on stream. Closes in 60 s.';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'qr-close';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', hideAdminQr);

  card.append(title, canvas, hint, closeBtn);

  // Click on the backdrop (not the card) closes it.
  modal.addEventListener('click', (event) => {
    if (event.target === modal) hideAdminQr();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hideAdminQr();
  });

  document.body.appendChild(modal);
  return modal;
}

// eslint-disable-next-line no-unused-vars
function showAdminQr(link) {
  adminQrModal ??= buildAdminQrModal();
  const canvas = adminQrModal.querySelector('.qr-canvas');
  adminQrModal.classList.remove('hidden');
  drawQrCode(canvas, link, canvas.getBoundingClientRect().width || 200);

  clearTimeout(adminQrTimer);
  adminQrTimer = setTimeout(hideAdminQr, ADMIN_QR_AUTO_CLOSE_MS);
}

function hideAdminQr() {
  clearTimeout(adminQrTimer);
  if (!adminQrModal) return;
  adminQrModal.classList.add('hidden');
  // Don't leave the token's pixels lying around in a hidden canvas.
  const canvas = adminQrModal.querySelector('.qr-canvas');
  canvas.width = canvas.height = 0;
}
