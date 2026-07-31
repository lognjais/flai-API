import test from 'node:test';
import assert from 'node:assert/strict';

/* config.js reads process.env at import time and exits the process when PASS is missing, so
 * the env has to be set first. A static `import` will not do: ESM hoists and evaluates every
 * import declaration before the first statement in the body, so the assignments below would
 * land after config.js had already read a missing PASS and called process.exit(1). Hence a
 * dynamic import, which runs in statement order. */
process.env.PASS = 'test-password';
process.env.SESSION_TTL_HOURS = '12';

const { issueToken, verifyToken, checkPassword } = await import('../src/lib/token.js');

test('a fresh token verifies', () => {
  const { token, expiresAt } = issueToken();
  assert.equal(verifyToken(token).expiresAt, expiresAt);
});

test('the TTL is honoured', () => {
  const now = 1_000_000;
  const { expiresAt } = issueToken(now);
  assert.equal(expiresAt, now + 12 * 3600_000);
});

test('an expired token is refused', () => {
  const { token, expiresAt } = issueToken(0);
  assert.throws(() => verifyToken(token, expiresAt + 1), /expired/);
  // And is still good one millisecond before.
  assert.doesNotThrow(() => verifyToken(token, expiresAt - 1));
});

test('a tampered expiry is refused — the payload is signed, not just stored', () => {
  const { token } = issueToken();
  const [, sig] = token.split('.');
  const forged = `${Buffer.from(String(Date.now() + 1e12)).toString('base64url')}.${sig}`;
  assert.throws(() => verifyToken(forged), /signature/);
});

test('a token signed with another password is refused', () => {
  const { token } = issueToken();
  const other = token.slice(0, -4) + 'AAAA';
  assert.throws(() => verifyToken(other), /signature/);
});

test('junk is refused rather than throwing something unhandled', () => {
  for (const junk of [undefined, null, '', 'no-dot', '.', 'a.', 42, {}, 'x'.repeat(600)]) {
    assert.throws(() => verifyToken(junk), /unauthorized|token|credentials/i, `junk: ${junk}`);
  }
});

test('the password check accepts only the exact password', () => {
  assert.doesNotThrow(() => checkPassword('test-password'));
  for (const wrong of ['test-passwor', 'test-password2', 'TEST-PASSWORD', '', undefined, 12]) {
    assert.throws(() => checkPassword(wrong), /credentials/, `wrong: ${wrong}`);
  }
});
