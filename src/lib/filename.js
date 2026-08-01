/* Building a Content-Disposition header that browsers actually honour.
 *
 * This existed as one line —
 *
 *   `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`
 *
 * — and it silently mis-named real downloads. encodeURIComponent leaves ! ' ( ) * unescaped,
 * and RFC 8187 allows only the first of those. So an episode called
 *
 *   From (2022) - S01E01 - Long Day's Journey Into Night ....mkv
 *
 * produced `filename*=UTF-8''...Long%20Day's%20Journey...`, and since RFC 8187 parses that
 * value as charset'language'bytes, the apostrophe split it into a fourth field. The header was
 * malformed, Chrome threw it away, and fell back to the last segment of the URL — which for
 * /torrent/<hash>/0 is the string "0". Every episode of a series saved as a file called 0.
 *
 * Two parameters are emitted, which is the long-standing recommendation: `filename` as a plain
 * ASCII fallback for anything that does not implement RFC 8187, and `filename*` for everything
 * that does. Browsers that understand both prefer filename*.
 */

/* RFC 8187 attr-char: ALPHA / DIGIT / ! # $ & + - . ^ _ ` | ~
 * Deliberately narrow. Anything outside it gets percent-encoded, byte by byte, from UTF-8. */
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

export function encodeRfc8187(name) {
  let out = '';
  for (const byte of Buffer.from(name, 'utf8')) {
    const char = String.fromCharCode(byte);
    out += ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/* The fallback has to survive being inside double quotes, so quotes and backslashes go. Control
 * characters go because a newline here is header injection. Non-ASCII goes because that is the
 * whole reason filename* exists. */
export function asciiFallback(name) {
  const cleaned = [...name]
    .map((c) => {
      const code = c.codePointAt(0);
      if (code < 0x20 || code === 0x7f) return '';
      if (code > 0x7e) return '_';
      if (c === '"' || c === '\\') return '';
      return c;
    })
    .join('')
    .trim();
  return cleaned || 'download';
}

/** @returns a full Content-Disposition value. */
export function contentDisposition(name, type = 'attachment') {
  return `${type}; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeRfc8187(name)}`;
}
