/* HTTP Range parsing, and the clamp that makes the memory bound real.
 *
 * Clamping matters more than parsing. webtorrent's FileIterator selects every piece a
 * createReadStream covers, so a request for the whole file selects the whole file and the
 * sliding window stops being a window. Every response is therefore capped at
 * MAX_CHUNK_BYTES, which a server is allowed to do: RFC 9110 lets a 206 carry fewer bytes
 * than the client asked for.
 *
 * The one case with no honest answer is a request with no Range header at all for a file
 * bigger than the cap — that asks for the whole thing, and lying about Content-Length to
 * serve less would break every client. So it is refused with 416 and a reason. Both real
 * clients always send Range: our download manager by construction, and <video> because
 * Chrome opens media with `bytes=0-`.
 */

const RANGE_RE = /^bytes=(\d*)-(\d*)$/;

/** @returns {{start:number,end:number}|null} null means unsatisfiable or unparseable. */
export function parseRange(header, totalSize) {
  if (!header) return null;
  const m = RANGE_RE.exec(header.trim());
  if (!m) return null;
  const [, startStr, endStr] = m;

  let start;
  let end;
  if (startStr === '') {
    // Suffix form: `bytes=-500` means the last 500 bytes.
    if (endStr === '') return null;
    const suffix = Number.parseInt(endStr, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, totalSize - suffix);
    end = totalSize - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    end = endStr === '' ? totalSize - 1 : Number.parseInt(endStr, 10);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= totalSize) return null;
  if (end >= totalSize) end = totalSize - 1;
  return { start, end };
}

/**
 * @returns {{status:206|200|416, start:number, end:number}}
 *   416 carries no body; the caller turns it into the error envelope.
 */
export function resolveRange(header, totalSize, maxChunk) {
  if (!header) {
    if (totalSize <= maxChunk) return { status: 200, start: 0, end: Math.max(0, totalSize - 1) };
    return { status: 416, start: 0, end: 0 };
  }
  const range = parseRange(header, totalSize);
  if (!range) return { status: 416, start: 0, end: 0 };
  const end = Math.min(range.end, range.start + maxChunk - 1);
  return { status: 206, start: range.start, end };
}
