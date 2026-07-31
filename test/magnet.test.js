import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMagnet, contentTypeFor, isStreamable } from '../src/lib/magnet.js';

const HEX = 'c9e15763f722f23e98a29decdfae341b98d53056';
// The same hash in base32, which is how some trackers still publish magnets.
const B32 = 'ZHQVOY7XELZD5GFCTXWN7LRUDOMNKMCW';

test('a 40-char hex infohash is read whole', () => {
  assert.equal(parseMagnet(`magnet:?xt=urn:btih:${HEX}`).infoHash, HEX);
});

/* The v3 bug this guards: with the 32-char alternative listed first, the regex matched the
 * first 32 hex characters of a 40-character hash and silently truncated it. Every lookup
 * then missed the cache, webtorrent reported "duplicate torrent", and the torrent was
 * removed mid-download. Cheap to keep, expensive to rediscover. */
test('a 40-char hash is never truncated to 32', () => {
  const parsed = parseMagnet(`magnet:?xt=urn:btih:${HEX}&dn=whatever`);
  assert.equal(parsed.infoHash.length, 40);
  assert.equal(parsed.infoHash, HEX);
});

test('a 32-char base32 infohash converts to hex', () => {
  const parsed = parseMagnet(`magnet:?xt=urn:btih:${B32}`);
  assert.equal(parsed.infoHash.length, 40);
  assert.match(parsed.infoHash, /^[a-f0-9]{40}$/);
});

test('case and surrounding parameters do not matter', () => {
  assert.equal(parseMagnet(`magnet:?xt=urn:btih:${HEX.toUpperCase()}&tr=udp://x:1/announce`).infoHash, HEX);
  assert.equal(parseMagnet(`  magnet:?xt=urn:btih:${HEX}  `).infoHash, HEX);
});

test('non-magnets are refused', () => {
  for (const bad of [
    'https://example.com/file.torrent',
    'magnet:?dn=no-hash-here',
    `magnet:?xt=urn:btih:${HEX.slice(0, 39)}`,
    `magnet:?xt=urn:sha1:${HEX}`,
    '',
    undefined,
    'magnet:?xt=urn:btih:' + 'z'.repeat(40),
  ]) {
    assert.equal(parseMagnet(bad), null, `should refuse: ${bad}`);
  }
});

test('an over-long input is refused before any regex runs on it', () => {
  assert.equal(parseMagnet(`magnet:?xt=urn:btih:${HEX}&dn=${'a'.repeat(9000)}`), null);
});

test('content types cover what the player and the probe rely on', () => {
  assert.equal(contentTypeFor('a.mp4'), 'video/mp4');
  assert.equal(contentTypeFor('a.MKV'), 'video/x-matroska');
  assert.equal(contentTypeFor('a.flac'), 'audio/flac');
  assert.equal(contentTypeFor('a.srt'), 'application/x-subrip');
  assert.equal(contentTypeFor('no-extension'), 'application/octet-stream');
  assert.equal(contentTypeFor('archive.tar.zst'), 'application/octet-stream');
});

test('streamable means audio or video, nothing else', () => {
  assert.equal(isStreamable('a.mkv'), true);
  assert.equal(isStreamable('a.mp3'), true);
  assert.equal(isStreamable('a.pdf'), false);
  assert.equal(isStreamable('a.zip'), false);
});
