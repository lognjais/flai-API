/* HTTP Range parsing. Ordinary, on purpose.
 *
 * v4.0 clamped every response to 16 MB and refused un-ranged requests with 416, so a plain
 * <a download> could not work and the browser had to be taught to stitch slices together. That
 * was the wrong place to solve it: the memory bound belongs inside the route, not in the
 * protocol. routes/stream.js now reads the file in bounded windows and writes them into one
 * long response, so this file can go back to doing what a Range parser should.
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
 * No Range header means the whole file, which is what a browser download and a plain curl both
 * send. A Range is honoured exactly as asked — Chrome's download manager uses `bytes=N-` to
 * resume an interrupted download, and truncating that would break the resume.
 *
 * @returns {{status:200|206|416, start:number, end:number}}
 */
export function resolveRange(header, totalSize) {
  if (!header) return { status: 200, start: 0, end: Math.max(0, totalSize - 1) };
  const range = parseRange(header, totalSize);
  if (!range) return { status: 416, start: 0, end: 0 };
  return { status: 206, start: range.start, end: range.end };
}
