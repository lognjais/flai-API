import test from 'node:test';
import assert from 'node:assert/strict';
import { contentDisposition, encodeRfc8187, asciiFallback } from '../src/lib/filename.js';

/* The bug this file exists for. Reported from real use: every episode of a series saved as a
 * file called "0". The name contains an apostrophe, encodeURIComponent does not escape it, and
 * RFC 8187 parses filename* as charset'language'bytes — so the apostrophe split the value into
 * a fourth field, Chrome discarded the malformed header, and fell back to the last segment of
 * /torrent/<hash>/0. */
const EPISODE = "From (2022) - S01E01 - Long Day's Journey Into Night (1080p AMZN WEB-DL x265 t3nzin).mkv";

/** Parses filename* the way a client does, so a malformed value cannot pass unnoticed. */
function readFilenameStar(header) {
  const raw = /filename\*=([^;]+)/.exec(header)?.[1];
  if (!raw) return null;
  const parts = raw.split("'");
  // charset 'lang' value — exactly three fields, or the header is broken.
  if (parts.length !== 3) return { broken: true, fields: parts.length };
  return decodeURIComponent(parts[2]);
}

test('the apostrophe case round-trips', () => {
  const parsed = readFilenameStar(contentDisposition(EPISODE));
  assert.equal(parsed, EPISODE);
});

test('the old one-liner really was broken, so this test means something', () => {
  const old = `attachment; filename*=UTF-8''${encodeURIComponent(EPISODE)}`;
  assert.deepEqual(readFilenameStar(old), { broken: true, fields: 4 });
});

test('every character encodeURIComponent leaves behind is escaped here', () => {
  // ! is a valid attr-char; ' ( ) * are not, and were the whole bug.
  for (const c of "'()*") {
    assert.ok(!encodeRfc8187(c).includes(c), `${c} must be percent-encoded`);
  }
  assert.equal(encodeRfc8187('!'), '!', '! is a valid attr-char and need not be escaped');
});

test('non-ASCII survives as UTF-8 bytes', () => {
  for (const name of ['Amélie.mkv', '千と千尋.mkv', 'Ω.txt', 'emoji 🎬.mp4']) {
    assert.equal(readFilenameStar(contentDisposition(name)), name);
  }
});

test('the ASCII fallback is safe inside double quotes', () => {
  const nasty = 'we"ird\\name.mkv';
  const header = contentDisposition(nasty);
  const fallback = /filename="([^"]*)"/.exec(header)[1];
  assert.equal(fallback, 'weirdname.mkv');
  // …and the real name still arrives intact in filename*.
  assert.equal(readFilenameStar(header), nasty);
});

/* A newline in a filename is header injection, and torrent names are attacker-controlled. */
test('control characters cannot break out of the header', () => {
  const header = contentDisposition('evil\r\nX-Injected: yes\r\n.mkv');
  assert.ok(!header.includes('\r'), 'no carriage return');
  assert.ok(!header.includes('\n'), 'no newline');
  assert.ok(!header.includes('X-Injected: yes\r'), 'nothing that reads as a second header');
});

test('a name with nothing usable still yields a filename', () => {
  assert.equal(asciiFallback('🎬🎬'), '__');
  assert.equal(asciiFallback(''), 'download');
  assert.equal(asciiFallback('   '), 'download');
});

test('the header names the right disposition', () => {
  assert.ok(contentDisposition('a.mkv').startsWith('attachment;'));
  assert.ok(contentDisposition('a.mkv', 'inline').startsWith('inline;'));
});
