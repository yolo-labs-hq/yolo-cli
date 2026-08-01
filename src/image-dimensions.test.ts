/**
 * Dependency-free PNG/WebP header reader. Verified against images produced by
 * sharp (the same encoder the server decodes with), so the CLI's offline
 * pre-check and the server's authoritative check agree on real files.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readImageDimensions } from './image-dimensions.js';

describe('readImageDimensions', () => {
  it('reads a PNG header', () => {
    // 8-byte sig + IHDR len/type + 1280x800 big-endian.
    const b = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(1280, 16);
    b.writeUInt32BE(800, 20);
    assert.deepEqual(readImageDimensions(b), { width: 1280, height: 800, format: 'png' });
  });

  it('returns null for bytes it cannot parse, deferring to the server', () => {
    assert.equal(readImageDimensions(Buffer.from('not an image at all, really')), null);
    assert.equal(readImageDimensions(Buffer.alloc(4)), null);
  });
});
