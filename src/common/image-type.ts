/**
 * The image type a file really is, from its first bytes, or null.
 *
 * Upload handlers must not trust the multipart Content-Type: it is whatever
 * the client says. Checking the signature keeps HTML, SVG or scripts labelled
 * "image/png" out of the public storage buckets.
 */
export function sniffImageType(buffer: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';

  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }

  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp';
  }

  return null;
}
