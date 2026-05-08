// Order matters: try the 40-char hex form before the 32-char base32 form, otherwise
// alternation matches the first 32 hex chars of a 40-char hash and silently truncates.
const MAGNET_BTIH_RE = /^magnet:\?.*xt=urn:btih:([a-fA-F0-9]{40}|[A-Za-z2-7]{32})(?:[^a-zA-Z0-9]|$)/;

function base32ToHex(b32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of b32.toUpperCase()) {
    const idx = alphabet.indexOf(c);
    if (idx < 0) return null;
    bits += idx.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex.toLowerCase();
}

export function parseMagnet(uri) {
  if (typeof uri !== 'string' || uri.length > 8192) return null;
  const trimmed = uri.trim();
  const m = MAGNET_BTIH_RE.exec(trimmed);
  if (!m) return null;
  const raw = m[1];
  const infoHash = raw.length === 40 ? raw.toLowerCase() : base32ToHex(raw);
  if (!infoHash || infoHash.length !== 40) return null;
  return { uri: trimmed, infoHash };
}

export function contentTypeFor(name) {
  const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
  switch (ext) {
    case '.mp4': return 'video/mp4';
    case '.m4v': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mkv': return 'video/x-matroska';
    case '.avi': return 'video/x-msvideo';
    case '.mov': return 'video/quicktime';
    case '.mp3': return 'audio/mpeg';
    case '.flac': return 'audio/flac';
    case '.ogg': return 'audio/ogg';
    case '.wav': return 'audio/wav';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.png': return 'image/png';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.pdf': return 'application/pdf';
    case '.zip': return 'application/zip';
    case '.txt': return 'text/plain; charset=utf-8';
    case '.srt': return 'application/x-subrip';
    case '.vtt': return 'text/vtt';
    default: return 'application/octet-stream';
  }
}

export function isStreamable(name) {
  const ct = contentTypeFor(name);
  return ct.startsWith('video/') || ct.startsWith('audio/');
}
