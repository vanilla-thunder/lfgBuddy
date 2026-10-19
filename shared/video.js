'use strict';

// Watch together: a YouTube player shared by both clients, shown instead of
// the board while a video is loaded. The server holds the playback state
// (event `video`, and `video` in state-sync): { videoId, playing, position }
// with position in seconds *now*; each client extrapolates it on its own
// monotonic clock and keeps its player within a small drift of it.
//
// The player is a youtube-nocookie.com iframe driven over the embed's
// postMessage protocol (what YouTube's iframe_api script does internally) —
// so no third-party script runs in our pages, where it could read the admin
// token or reach the overlay's bridge. Messages are only accepted from that
// iframe's window and origin. YouTube's own controls are off and the iframe
// ignores the mouse, so a player can't drift from the room by local clicks:
// only our controls change the state, and only through the server.

const VIDEO_ORIGIN = 'https://www.youtube-nocookie.com';
const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const VIDEO_SYNC_INTERVAL_MS = 2000;
// Tolerated difference between the player and the room before seeking.
const VIDEO_DRIFT_PLAYING_S = 1.5;
const VIDEO_DRIFT_PAUSED_S = 0.3;
const VIDEO_SKIP_S = 10;
const VIDEO_VOLUME_KEY = 'lfg_video_volume';
// YouTube player states.
const YT_ENDED = 0;
const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_BUFFERING = 3;
// A play/pause within this time after our own play/pause/seek command is the
// player following it; later ones come from outside (see onExternalPlayback).
const VIDEO_OWN_COMMAND_MS = 1500;
const VIDEO_PLAYBACK_COMMANDS = new Set(['playVideo', 'pauseVideo', 'seekTo']);
const YT_ERRORS = {
  2: 'Invalid video.',
  5: 'This video can’t be played here.',
  100: 'Video not found or private.',
  101: 'The owner doesn’t allow embedding this video.',
  150: 'The owner doesn’t allow embedding this video.',
  153: 'YouTube rejected the player (missing referrer).',
};

function formatVideoTime(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function videoEl(tag, className, text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

function videoButton(text, className, title, onClick) {
  const btn = videoEl('button', className, text);
  btn.type = 'button';
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * @param {object} opts
 * @param {HTMLElement} opts.container  empty element inside host; the player is built here
 * @param {HTMLElement} opts.host       board container; gets .video-replaces-board
 *                                      while a video is loaded
 * @param {(event: string, data: object) => void} opts.emit
 * @param {() => boolean} opts.canControl  play/pause/seek allowed (guided mode, overlay lock)
 * @param {() => boolean} opts.canUseMediaKeys  media keys may play/pause for the room
 *                                      (guided mode only — they work in the locked overlay)
 * @param {() => boolean} opts.isAdmin     shows Close video
 */
// eslint-disable-next-line no-unused-vars
function createVideoPlayer({ container, host, emit, canControl, canUseMediaKeys, isAdmin }) {
  container.classList.add('video', 'hidden');

  const frameWrap = videoEl('div', 'video-frame');
  const status = videoEl('div', 'video-status hidden');
  const startBtn = videoButton('▶ Click to start playback', 'video-start hidden', 'Your browser blocked autoplay', () => {
    startBtn.classList.add('hidden');
    command('playVideo');
  });
  frameWrap.append(status, startBtn);

  const controls = videoEl('div', 'video-controls');
  const playBtn = videoButton('▶', 'video-btn video-play', 'Play / pause for everyone', togglePlay);
  const backBtn = videoButton(`−${VIDEO_SKIP_S}s`, 'video-btn', `Back ${VIDEO_SKIP_S} seconds for everyone`, () => seekBy(-VIDEO_SKIP_S));
  const fwdBtn = videoButton(`+${VIDEO_SKIP_S}s`, 'video-btn', `Forward ${VIDEO_SKIP_S} seconds for everyone`, () => seekBy(VIDEO_SKIP_S));
  const seek = document.createElement('input');
  seek.type = 'range';
  seek.className = 'video-seek';
  seek.min = '0';
  seek.max = '0';
  seek.step = '1';
  seek.value = '0';
  seek.setAttribute('aria-label', 'Position');
  const time = videoEl('span', 'video-time', '0:00');
  const muteBtn = videoButton('🔊', 'video-btn', 'Mute (only for you)', toggleMute);
  const volume = document.createElement('input');
  volume.type = 'range';
  volume.className = 'video-volume';
  volume.min = '0';
  volume.max = '100';
  volume.setAttribute('aria-label', 'Volume (only for you)');
  volume.title = 'Volume (only for you)';
  const closeBtn = videoButton('✕', 'video-btn video-close', 'Close the video for everyone', () => emit('clear-video', {}));
  controls.append(playBtn, backBtn, fwdBtn, seek, time, muteBtn, volume, closeBtn);
  container.append(frameWrap, controls);

  let iframe = null;
  let ready = false;
  // Room state: position (s) at `at` (performance.now()).
  let target = null;
  // Last report from the player, and when it arrived.
  let player = { time: 0, at: 0, state: -1, duration: 0 };
  let syncTimer = null;
  let seeking = false;
  let lastCommandAt = -Infinity;

  let localVolume = { level: 100, muted: false };
  try {
    const saved = JSON.parse(localStorage.getItem(VIDEO_VOLUME_KEY));
    if (Number.isInteger(saved?.level) && saved.level >= 0 && saved.level <= 100) {
      localVolume = { level: saved.level, muted: saved.muted === true };
    }
  } catch {
    // none saved — defaults
  }
  volume.value = String(localVolume.level);

  function post(message) {
    iframe?.contentWindow?.postMessage(JSON.stringify({ ...message, id: 1, channel: 'widget' }), VIDEO_ORIGIN);
  }

  function command(func, args = []) {
    if (VIDEO_PLAYBACK_COMMANDS.has(func)) lastCommandAt = performance.now();
    post({ event: 'command', func, args });
  }

  function expectedPosition() {
    if (!target) return 0;
    const position = target.position + (target.playing ? (performance.now() - target.at) / 1000 : 0);
    return player.duration > 0 ? Math.min(position, player.duration) : position;
  }

  function playerPosition() {
    const running = player.state === YT_PLAYING;
    return player.time + (running ? (performance.now() - player.at) / 1000 : 0);
  }

  // Brings the player to the room's state: seek if it drifted too far, then
  // play/pause if needed. A seek on a not yet started video starts it, so
  // play/pause is always re-sent after one.
  function sync() {
    if (!ready || !target) return;
    const expected = expectedPosition();
    const ended = player.state === YT_ENDED && player.duration > 0 && expected >= player.duration - VIDEO_DRIFT_PLAYING_S;
    if (ended) return;

    const drift = Math.abs(playerPosition() - expected);
    const seeked = drift > (target.playing ? VIDEO_DRIFT_PLAYING_S : VIDEO_DRIFT_PAUSED_S);
    if (seeked) {
      command('seekTo', [expected, true]);
      player = { ...player, time: expected, at: performance.now() };
    }
    const running = player.state === YT_PLAYING || player.state === YT_BUFFERING;
    if (target.playing && (seeked || !running)) command('playVideo');
    if (!target.playing && (seeked || running)) command('pauseVideo');
  }

  function applyVolume() {
    command('setVolume', [localVolume.level]);
    command(localVolume.muted ? 'mute' : 'unMute');
    muteBtn.textContent = localVolume.muted || localVolume.level === 0 ? '🔇' : '🔊';
    try {
      localStorage.setItem(VIDEO_VOLUME_KEY, JSON.stringify(localVolume));
    } catch {
      // not persisted — fine
    }
  }

  function showStatus(message) {
    status.textContent = message;
    status.classList.toggle('hidden', !message);
  }

  function renderControls() {
    const allowed = canControl() && target !== null;
    for (const btn of [playBtn, backBtn, fwdBtn]) btn.disabled = !allowed;
    seek.disabled = !allowed || player.duration <= 0;
    playBtn.textContent = target?.playing ? '⏸' : '▶';
    closeBtn.classList.toggle('hidden', !isAdmin());
    if (seeking) return;
    const position = expectedPosition();
    seek.max = String(Math.floor(player.duration));
    seek.value = String(Math.floor(position));
    time.textContent = player.duration > 0
      ? `${formatVideoTime(position)} / ${formatVideoTime(player.duration)}`
      : formatVideoTime(position);
  }

  function emitState(playing, position) {
    const max = player.duration > 0 ? player.duration : Infinity;
    emit('video-state', { videoId: target.videoId, playing, position: Math.min(Math.max(position, 0), max) });
  }

  function sendState(playing, position) {
    if (target && canControl()) emitState(playing, position);
  }

  // The player paused or played without being told to: media keys, the
  // OS media controls or headphone buttons — they reach the iframe's media
  // session directly, not our page. Passed on to the room when allowed,
  // otherwise undone by the next sync. `position` is where it was.
  function onExternalPlayback(playing, position) {
    if (!target || target.playing === playing) return;
    if (performance.now() - lastCommandAt < VIDEO_OWN_COMMAND_MS) return;
    if (canUseMediaKeys()) emitState(playing, playing ? expectedPosition() : position);
    else sync();
  }

  function togglePlay() {
    if (!target) return;
    const position = expectedPosition();
    // Play at the end starts over.
    const atEnd = player.duration > 0 && position >= player.duration - 1;
    sendState(!target.playing, !target.playing && atEnd ? 0 : position);
  }

  function seekBy(seconds) {
    if (target) sendState(target.playing, expectedPosition() + seconds);
  }

  // Next/previous track keys (overlay only — main.js registers them while a
  // video is loaded): ±VIDEO_SKIP_S for the room. They can't be caught in the
  // page: Chromium hands them to the player iframe's media session, which
  // ignores them.
  function mediaKeySkip(direction) {
    if (target && canUseMediaKeys()) emitState(target.playing, expectedPosition() + direction * VIDEO_SKIP_S);
  }

  function toggleMute() {
    localVolume.muted = !localVolume.muted;
    applyVolume();
  }

  seek.addEventListener('input', () => {
    seeking = true;
    time.textContent = `${formatVideoTime(Number(seek.value))} / ${formatVideoTime(player.duration)}`;
  });
  seek.addEventListener('change', () => {
    seeking = false;
    if (target) sendState(target.playing, Number(seek.value));
  });
  volume.addEventListener('input', () => {
    localVolume = { level: Number(volume.value), muted: false };
    applyVolume();
  });

  // Player → page. Only from our iframe; data is checked field by field.
  window.addEventListener('message', (event) => {
    if (!iframe || event.source !== iframe.contentWindow || event.origin !== VIDEO_ORIGIN) return;
    if (typeof event.data !== 'string') return;
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (data?.event === 'onReady' || data?.event === 'initialDelivery') {
      if (!ready) {
        ready = true;
        applyVolume();
      }
    }
    if (data?.event === 'onStateChange' && Number.isInteger(data.info)) {
      const position = playerPosition();
      player.state = data.info;
      // Still loading what our command asked for: its play/pause is still ours.
      if (data.info === YT_BUFFERING && performance.now() - lastCommandAt < VIDEO_OWN_COMMAND_MS) lastCommandAt = performance.now();
      if (data.info === YT_PLAYING || data.info === YT_PAUSED) onExternalPlayback(data.info === YT_PLAYING, position);
      if (data.info === YT_PLAYING) startBtn.classList.add('hidden');
      // Subtitles off for everyone: there's no embed parameter that forces
      // them off (cc_load_policy=0 is ignored), and the player reloads its
      // captions module on every start and seek — so unload it each time.
      if (data.info === YT_PLAYING || data.info === YT_BUFFERING) {
        command('unloadModule', ['captions']);
        command('unloadModule', ['cc']);
      }
    }
    if (data?.event === 'onAutoplayBlocked') startBtn.classList.remove('hidden');
    if (data?.event === 'onError') showStatus(YT_ERRORS[data.info] ?? 'The video can’t be played.');
    const info = data?.info;
    if ((data?.event === 'infoDelivery' || data?.event === 'initialDelivery') && info && typeof info === 'object') {
      if (Number.isFinite(info.currentTime)) player = { ...player, time: info.currentTime, at: performance.now() };
      if (Number.isInteger(info.playerState)) player.state = info.playerState;
      if (Number.isFinite(info.duration) && info.duration > 0) player.duration = info.duration;
    }
    if (data?.event === 'onReady' || data?.event === 'initialDelivery') sync();
    renderControls();
  });

  function load(videoId, start) {
    teardown();
    // Only the server's (already validated) ID goes into the URL.
    if (!VIDEO_ID_RE.test(videoId)) return;
    const params = new URLSearchParams({
      enablejsapi: '1',
      controls: '0',
      disablekb: '1',
      rel: '0',
      iv_load_policy: '3',
      playsinline: '1',
      start: String(Math.floor(start)),
    });
    // The overlay page is file:// — no usable origin; main.js sends a
    // Referer for it instead (YouTube refuses embeds without one).
    if (location.protocol !== 'file:') params.set('origin', location.origin);

    iframe = document.createElement('iframe');
    iframe.className = 'video-iframe';
    iframe.title = 'YouTube video';
    iframe.allow = 'autoplay; encrypted-media; picture-in-picture';
    iframe.referrerPolicy = 'strict-origin-when-cross-origin';
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-presentation');
    iframe.addEventListener('load', () => {
      post({ event: 'listening' });
      for (const name of ['onReady', 'onStateChange', 'onError', 'onAutoplayBlocked']) command('addEventListener', [name]);
    });
    iframe.src = `${VIDEO_ORIGIN}/embed/${videoId}?${params}`;
    frameWrap.prepend(iframe);
    syncTimer = setInterval(() => {
      sync();
      renderControls();
    }, VIDEO_SYNC_INTERVAL_MS);
  }

  function teardown() {
    clearInterval(syncTimer);
    iframe?.remove();
    iframe = null;
    ready = false;
    player = { time: 0, at: 0, state: -1, duration: 0 };
    seeking = false;
    showStatus('');
    startBtn.classList.add('hidden');
  }

  function hide() {
    teardown();
    target = null;
    container.classList.add('hidden');
    host.classList.remove('video-replaces-board');
  }

  // payload: { videoId, playing, position } or null (no video).
  function apply(payload) {
    if (!payload) {
      hide();
      return;
    }
    const isNew = target?.videoId !== payload.videoId;
    target = { videoId: payload.videoId, playing: payload.playing === true, position: Number(payload.position) || 0, at: performance.now() };
    if (isNew) load(target.videoId, target.position);
    container.classList.remove('hidden');
    host.classList.add('video-replaces-board');
    sync();
    renderControls();
  }

  return { apply, hide, updateControls: renderControls, mediaKeySkip };
}

// ── Load dialog (admins) ──────────────────────────────────────────────────────

let videoDialog = null;

function closeVideoDialog() {
  videoDialog?.modal.classList.add('hidden');
}

/**
 * @param {object} opts
 * @param {boolean} opts.hasVideo  shows Close video
 * @param {(url: string) => void} opts.onLoad
 * @param {() => void} opts.onRemove
 * @returns {{ showError(message: string): void, close(): void }}
 */
// eslint-disable-next-line no-unused-vars
function openVideoDialog({ hasVideo, onLoad, onRemove }) {
  if (!videoDialog) videoDialog = buildVideoDialog();
  const { modal, input, status, loadBtn, removeBtn } = videoDialog;
  videoDialog.onLoad = onLoad;
  videoDialog.onRemove = onRemove;
  removeBtn.classList.toggle('hidden', !hasVideo);
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
    close: closeVideoDialog,
  };
}

// Same look as the picture dialog (shared/picture-dialog.js), so it reuses
// its CSS classes — only wider (.video-card), YouTube links are long.
function buildVideoDialog() {
  const modal = videoEl('div', 'picture-modal hidden');
  const card = videoEl('form', 'picture-card video-card');
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'picture-input';
  input.placeholder = 'https://www.youtube.com/watch?v=…';
  input.maxLength = 2048;
  input.spellcheck = false;
  input.setAttribute('aria-label', 'YouTube link');
  const hint = videoEl('div', 'picture-hint', 'YouTube link (video, shorts or live). It replaces the board for everyone, starting paused; everyone can play, pause and seek (only admins in guided mode).');
  const status = videoEl('div', 'picture-status');
  const buttons = videoEl('div', 'picture-buttons');
  const loadBtn = videoEl('button', 'picture-btn', 'Load');
  loadBtn.type = 'submit';
  const removeBtn = videoEl('button', 'picture-btn picture-remove', 'Close video');
  removeBtn.type = 'button';
  const closeBtn = videoEl('button', 'picture-btn', 'Cancel');
  closeBtn.type = 'button';
  buttons.append(loadBtn, removeBtn, closeBtn);
  card.append(videoEl('div', 'picture-title', 'Watch together'), input, hint, status, buttons);
  modal.appendChild(card);
  document.body.appendChild(modal);

  const dialog = { modal, input, status, loadBtn, removeBtn, onLoad: null, onRemove: null };
  card.addEventListener('submit', (event) => {
    event.preventDefault();
    const url = input.value.trim();
    if (!url) {
      input.focus();
      return;
    }
    loadBtn.disabled = true;
    dialog.onLoad?.(url);
  });
  removeBtn.addEventListener('click', () => {
    dialog.onRemove?.();
    closeVideoDialog();
  });
  closeBtn.addEventListener('click', closeVideoDialog);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) closeVideoDialog();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeVideoDialog();
  });
  return dialog;
}
