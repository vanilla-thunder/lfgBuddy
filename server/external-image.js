'use strict';

// Downloads a picture from an arbitrary URL for a room ("external picture",
// roadmap #6). The server fetches it — so members' IPs never reach the
// external site and the overlay's CSP stays limited to trusted servers —
// which makes this an SSRF surface. Hardening:
//   - https only, default port, no credentials in the URL;
//   - the host is resolved first and *every* address must be public (no
//     private, loopback, link-local, CGNAT, multicast, documentation, NAT64,
//     6to4 … ranges, IPv4 and IPv6); the connection is then pinned to that
//     checked address, so DNS rebinding can't swap in an internal one
//     (TLS still verifies the certificate for the real hostname);
//   - no redirects, 10 s timeout, max 5 MB (aborted while streaming);
//   - only PNG / JPEG / GIF / WebP, identified by their magic bytes — the
//     remote Content-Type is ignored, SVG (scriptable) is never accepted.

const dns = require('dns').promises;
const https = require('https');
const net = require('net');

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10000;
const MAX_URL_LENGTH = 2048;

// Separate lists per family: a single BlockList also checks IPv4 addresses
// against IPv6 rules in IPv4-mapped form, so the ::ffff:0:0/96 rule would
// block every IPv4 address.
const BLOCKED_V4 = new net.BlockList();
const BLOCKED_V6 = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED_V4.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 127], // unspecified + loopback
  ['::ffff:0:0', 96], // IPv4-mapped
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], // NAT64
  ['100::', 64], ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], // discard, IETF/Teredo, docs, 6to4
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], // unique local, link-local, multicast
]) BLOCKED_V6.addSubnet(address, prefix, 'ipv6');

function isPublicAddress(address, family) {
  return family === 6 ? !BLOCKED_V6.check(address, 'ipv6') : !BLOCKED_V4.check(address, 'ipv4');
}

const SIGNATURES = [
  { type: 'image/png', test: (b) => b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: 'image/jpeg', test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: 'image/gif', test: (b) => b.length >= 6 && ['GIF87a', 'GIF89a'].includes(b.subarray(0, 6).toString('latin1')) },
  { type: 'image/webp', test: (b) => b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
];

function detectImageType(buffer) {
  return SIGNATURES.find((s) => s.test(buffer))?.type ?? null;
}

// Errors meant for the user who asked (no internals).
class PictureError extends Error {}

function parsePictureUrl(raw) {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) throw new PictureError('Invalid URL.');
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new PictureError('Invalid URL.');
  }
  if (url.protocol !== 'https:') throw new PictureError('Only https:// URLs are allowed.');
  if (url.username || url.password) throw new PictureError('URLs with credentials are not allowed.');
  if (url.port !== '') throw new PictureError('Only the standard https port is allowed.');
  return url;
}

async function resolvePublicAddress(hostname) {
  // IP literals ([::1], 10.0.0.1 …) go through the same check.
  const literal = hostname.replace(/^\[|\]$/g, '');
  const family = net.isIP(literal);
  const addresses = family
    ? [{ address: literal, family }]
    : await dns.lookup(hostname, { all: true, verbatim: true }).catch(() => {
      throw new PictureError('Host not found.');
    });
  if (addresses.length === 0) throw new PictureError('Host not found.');
  if (!addresses.every((a) => isPublicAddress(a.address, a.family))) {
    throw new PictureError('This address is not allowed (internal or reserved network).');
  }
  return addresses[0];
}

function download(url, pinned) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        req.destroy();
        reject(err);
      } else {
        resolve(value);
      }
    };
    const timer = setTimeout(() => finish(new PictureError('The download timed out.')), TIMEOUT_MS);

    const req = https.get({
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      path: `${url.pathname}${url.search}`,
      agent: false,
      headers: { 'user-agent': 'LFG-Buddy', accept: 'image/png,image/jpeg,image/gif,image/webp' },
      // Pin the connection to the address checked above (also when Node
      // asks for all addresses, as it does with autoSelectFamily).
      lookup: (_host, options, callback) => {
        if (options?.all) callback(null, [pinned]);
        else callback(null, pinned.address, pinned.family);
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        finish(new PictureError('Redirects are not followed — use the direct picture URL.'));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        finish(new PictureError(`The server answered ${res.statusCode}.`));
        return;
      }
      if (Number(res.headers['content-length']) > MAX_BYTES) {
        res.resume();
        finish(new PictureError('The picture is larger than 5 MB.'));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) finish(new PictureError('The picture is larger than 5 MB.'));
        else chunks.push(chunk);
      });
      res.on('end', () => finish(null, Buffer.concat(chunks)));
      res.on('error', () => finish(new PictureError('The download failed.')));
    });
    req.on('error', () => finish(new PictureError('The download failed.')));
  });
}

/**
 * @param {string} rawUrl
 * @returns {Promise<{ buffer: Buffer, contentType: string, host: string }>}
 * @throws {PictureError} with a message for the user
 */
async function fetchExternalImage(rawUrl) {
  const url = parsePictureUrl(rawUrl);
  const pinned = await resolvePublicAddress(url.hostname);
  const buffer = await download(url, pinned);
  const contentType = detectImageType(buffer);
  if (!contentType) throw new PictureError('Not a PNG, JPEG, GIF or WebP picture.');
  return { buffer, contentType, host: url.hostname };
}

module.exports = { fetchExternalImage, PictureError, MAX_BYTES, isPublicAddress, detectImageType };
