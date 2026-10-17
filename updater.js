'use strict';

// Silent auto-update for packaged production builds, from this repo's GitHub
// Releases via electron-updater: checks on start and every few hours,
// downloads in the background, installs silently when the app quits —
// never a restart or prompt mid-game.
//
// Installers aren't Authenticode-signed. Instead every release is signed by
// the repo's release workflow with Sigstore (a GitHub artifact attestation,
// see .github/workflows/release.yml), and an update is only accepted if
//   - the signature verifies against Sigstore's public trust root,
//   - it was made by <owner>/<repo>'s release workflow for exactly this
//     version's tag (identity in the short-lived signing certificate), and
//   - the signed statement's SHA-256 matches the downloaded installer.
// The check runs inside electron-updater's download step (its
// verifyUpdateCodeSignature hook), so a failing update is discarded before
// it's ever marked for install. Everything fails closed: no verification
// possible → no update.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, net } = require('electron');
const { autoUpdater } = require('electron-updater');
const sigstore = require('sigstore');

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const RELEASE_WORKFLOW = '.github/workflows/release.yml';
// Release asset holding the attestation bundle (see release.yml).
const BUNDLE_ASSET = 'update.sigstore.json';
const MAX_BUNDLE_BYTES = 1024 * 1024;
const NAME_RE = /^[A-Za-z0-9_.-]{1,100}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

// Silent updates still leave a trace: appended to updater.log in the app's
// data folder (reset once it grows past MAX_LOG_BYTES), and to the console.
const MAX_LOG_BYTES = 256 * 1024;
let logFile = null;

function log(...args) {
  const line = `${new Date().toISOString()} ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`;
  console.log('[updater]', line);
  if (!logFile) return;
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) fs.writeFileSync(logFile, '');
    fs.appendFileSync(logFile, `${line}
`);
  } catch {
    // logging must never break updating
  }
}

const fileLogger = {
  info: (...a) => log('info', ...a),
  warn: (...a) => log('warn', ...a),
  error: (...a) => log('error', ...a),
  debug: () => {},
};

// owner/repo from app-update.yml, which electron-builder writes from
// package.json → build.publish: the same source electron-updater downloads
// from, so forks only change it there. Also confirms `publisherName` is set
// — without it electron-updater would skip the verification hook entirely.
function readUpdateConfig() {
  let text;
  try {
    text = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
  } catch {
    return null;
  }
  const field = (name) => text.match(new RegExp(`^${name}:\\s*(\\S+)\\s*$`, 'm'))?.[1];
  const owner = field('owner');
  const repo = field('repo');
  const hasPublisherName = /^publisherName:/m.test(text);
  if (!NAME_RE.test(owner ?? '') || !NAME_RE.test(repo ?? '') || !hasPublisherName) return null;
  return { owner, repo };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// The attestation file is a Sigstore bundle; tolerate the JSON-lines form
// (one bundle per line) by taking the first one.
function parseBundle(text) {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.split('\n').find((line) => line.trim()));
  }
}

async function fetchBundle(url) {
  const response = await net.fetch(url);
  if (!response.ok) throw new Error(`signature bundle not available (HTTP ${response.status})`);
  const text = await response.text();
  if (text.length > MAX_BUNDLE_BYTES) throw new Error('signature bundle too large');
  return parseBundle(text);
}

// Electron's BoringSSL rejects crypto.verify(null/undefined, …) for EC keys,
// where OpenSSL (plain Node) defaults to SHA-256. tuf-js — which sigstore
// uses to load Sigstore's trust root — relies on that default for its P-256
// keys, so in Electron every check failed ("root was signed by 0/3 keys").
// This maps exactly that case to OpenSSL's default and passes everything
// else through unchanged, so it can't make any check weaker.
let cryptoPatched = false;
function patchCryptoVerifyForBoringSSL() {
  if (cryptoPatched || !process.versions.electron) return;
  cryptoPatched = true;
  const originalVerify = crypto.verify;
  // Keys arrive as a KeyObject, wrapped as { key: KeyObject } (tuf-js), or
  // as PEM/DER input createPublicKey understands.
  const keyType = (key) => {
    if (key instanceof crypto.KeyObject) return key.asymmetricKeyType;
    if (key?.key instanceof crypto.KeyObject) return key.key.asymmetricKeyType;
    try {
      return crypto.createPublicKey(key).asymmetricKeyType;
    } catch {
      return null;
    }
  };
  crypto.verify = function verify(algorithm, data, key, signature, callback) {
    const digest = algorithm == null && keyType(key) === 'ec' ? 'sha256' : algorithm;
    return originalVerify.call(this, digest, data, key, signature, callback);
  };
}

// Throws unless `bundle` is a valid Sigstore attestation made by
// `identityURI` (a GitHub Actions workflow ref) whose subject is `file`.
async function verifyAttestation(bundle, file, identityURI, tufCachePath) {
  patchCryptoVerifyForBoringSSL();
  // Signature, transparency log entry and signer identity.
  await sigstore.verify(bundle, {
    certificateIssuer: GITHUB_OIDC_ISSUER,
    certificateIdentityURI: identityURI,
    tufCachePath,
  });

  // The signed in-toto statement must name exactly the downloaded file.
  const envelope = bundle.dsseEnvelope;
  if (envelope?.payloadType !== 'application/vnd.in-toto+json') throw new Error('bundle is not an attestation');
  const statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
  const digest = await sha256File(file);
  if (!Array.isArray(statement.subject) || !statement.subject.some((s) => s?.digest?.sha256 === digest)) {
    throw new Error('signature does not cover the downloaded installer');
  }
}

async function verifyRelease(file, version, { owner, repo }) {
  if (!VERSION_RE.test(version ?? '')) throw new Error(`unexpected version "${version}"`);
  const tag = `v${version}`;
  const bundle = await fetchBundle(`https://github.com/${owner}/${repo}/releases/download/${tag}/${BUNDLE_ASSET}`);
  await verifyAttestation(
    bundle,
    file,
    `https://github.com/${owner}/${repo}/${RELEASE_WORKFLOW}@refs/tags/${tag}`,
    path.join(app.getPath('userData'), 'sigstore-tuf'),
  );
}

function startAutoUpdate() {
  logFile = path.join(app.getPath('userData'), 'updater.log');
  const source = readUpdateConfig();
  if (!source) {
    log('disabled: app-update.yml missing, or without owner/repo/publisherName — no verifiable update source');
    return;
  }

  // Version of the update being downloaded, for the expected signer tag.
  let pendingVersion = null;

  autoUpdater.logger = fileLogger;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.verifyUpdateCodeSignature = async (_publisherNames, file) => {
    try {
      await verifyRelease(file, pendingVersion, source);
      log(`verified ${pendingVersion}: signed by ${source.owner}/${source.repo} release workflow`);
      return null;
    } catch (err) {
      return `Sigstore verification failed: ${err.message}`;
    }
  };

  autoUpdater.on('update-available', (info) => {
    pendingVersion = info.version;
    log(`update ${info.version} available, downloading`);
  });
  autoUpdater.on('update-downloaded', (info) => log(`update ${info.version} ready — installs when the app quits`));
  autoUpdater.on('error', (err) => log('error:', err?.message ?? err));

  const check = () => autoUpdater.checkForUpdates().catch((err) => log('check failed:', err?.message ?? err));
  check();
  setInterval(check, CHECK_INTERVAL_MS).unref?.();
}

module.exports = { startAutoUpdate, verifyAttestation };
