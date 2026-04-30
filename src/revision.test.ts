/**
 * Revision-hash tests (Phase 8c.2).
 *
 * `computeRevisionHash` is small enough that a single round-trip
 * input → known SHA-256 anchor + format-shape coverage is sufficient.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { computeRevisionHash, isWellFormedRevision, REVISION_PREFIX } from './revision.js';

describe('revision — computeRevisionHash', () => {
  it('emits sha256:<64-hex> for any utf-8 string', () => {
    const out = computeRevisionHash('hello\n');
    assert.match(out, /^sha256:[0-9a-f]{64}$/);
  });

  it('matches a hand-computed SHA-256 (anchor: empty string)', () => {
    // Anchor: well-known SHA-256 of the empty string —
    // e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    assert.equal(
      computeRevisionHash(''),
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('matches createHash() directly for a non-trivial input', () => {
    const text = '---\nplanId: x\n---\n\n# body\n';
    const expected = `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
    assert.equal(computeRevisionHash(text), expected);
  });

  it('is collision-free for tiny edits (a vs A)', () => {
    assert.notEqual(computeRevisionHash('a'), computeRevisionHash('A'));
  });

  it('is byte-sensitive (LF vs CRLF differs)', () => {
    // Round-trip canonical form is LF-only — the divergence detector
    // should treat a CRLF version as a different revision so that
    // someone editing on Windows surfaces immediately.
    assert.notEqual(computeRevisionHash('a\nb\n'), computeRevisionHash('a\r\nb\r\n'));
  });
});

describe('revision — isWellFormedRevision', () => {
  it('accepts a valid sha256:<64-hex>', () => {
    assert.equal(
      isWellFormedRevision('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
      true,
    );
  });

  it('rejects wrong prefix (md5:..., blake3:...)', () => {
    assert.equal(isWellFormedRevision('md5:abc'), false);
    assert.equal(
      isWellFormedRevision('blake3:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
      false,
    );
  });

  it('rejects wrong length (too short, too long)', () => {
    assert.equal(isWellFormedRevision('sha256:abc'), false);
    assert.equal(
      isWellFormedRevision('sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b8550'),
      false,
    );
  });

  it('rejects uppercase hex (canonical form is lowercase)', () => {
    assert.equal(
      isWellFormedRevision('sha256:E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855'),
      false,
    );
  });

  it('REVISION_PREFIX export matches what computeRevisionHash emits', () => {
    assert.ok(computeRevisionHash('any').startsWith(REVISION_PREFIX));
  });
});
