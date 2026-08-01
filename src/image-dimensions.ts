/**
 * Dependency-free PNG/WebP dimension reader.
 *
 * The yolo-cli ships no image library (and shouldn't — it's a single-binary CLI),
 * but `publish --personal` needs to know an image's shape BEFORE it mutates
 * anything server-side. The publish flow is two calls: register the manifest,
 * then upload the bundle. If the server rejects a screenshot during the upload,
 * the manifest is already registered — a first publish is left with no bundle,
 * or a republish leaves a new manifest over the old bundle, while the command
 * reports failure. Catching a bad screenshot locally, before the first call,
 * keeps that state consistent for the realistic case (wrong aspect ratio).
 *
 * The server remains authoritative — `services/tileapp/screenshot-image.ts`
 * fully decodes the pixel stream, which this deliberately does not attempt.
 * This reads headers only: enough to reject the common mistakes offline, cheap
 * enough to have no dependencies. Same "faithful mirror, narrower scope" stance
 * as `tileapp-validator.ts`.
 */

export interface ImageDimensions { width: number; height: number; format: 'png' | 'webp' }

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Read an image's dimensions from its header, or null if the bytes aren't a
 * PNG/WebP we can parse. Null means "don't know" — callers must treat it as
 * "let the server decide", never as a failure.
 */
export function readImageDimensions(buf: Buffer): ImageDimensions | null {
  // ── PNG: 8-byte signature, then a 25-byte IHDR whose width/height are
  //    big-endian u32 at offsets 16 and 20.
  if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIG)) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
  }

  // ── WebP: 'RIFF' <u32 size> 'WEBP' <chunk fourcc> …
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);

    // VP8X (extended): 24-bit little-endian (width-1, height-1) at offset 24.
    if (chunk === 'VP8X') {
      const w = buf.readUIntLE(24, 3) + 1;
      const h = buf.readUIntLE(27, 3) + 1;
      return { width: w, height: h, format: 'webp' };
    }

    // VP8 (lossy): keyframe start code 9d 01 2a at offset 23, then two
    // little-endian u16 whose low 14 bits are the dimensions.
    if (chunk === 'VP8 ' && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: 'webp' };
    }

    // VP8L (lossless): signature 0x2f at offset 20, then 14 bits of (width-1)
    // and 14 bits of (height-1) packed across the following 4 bytes.
    if (chunk === 'VP8L' && buf[20] === 0x2f) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'webp' };
    }
  }

  return null;
}
