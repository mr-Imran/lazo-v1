/**
 * Removes location and other metadata from guest photos before storage
 * (PHOTO-1): EXIF/XMP/IPTC segments in JPEG, eXIf and text chunks in PNG,
 * EXIF/XMP chunks in WebP. Pixels are untouched. Also reads the pixel size.
 */
export interface Stripped {
  buffer: Buffer;
  width: number | null;
  height: number | null;
  stripped: boolean;
}

export function stripMetadata(input: Buffer, type: string): Stripped {
  if (type === 'image/jpeg') return jpeg(input);
  if (type === 'image/png') return png(input);
  if (type === 'image/webp') return webp(input);
  return { buffer: input, width: null, height: null, stripped: false };
}

function jpeg(buf: Buffer): Stripped {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return { buffer: buf, width: null, height: null, stripped: false };
  const parts: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  let width: number | null = null;
  let height: number | null = null;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(buf.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (marker === 0xda) {
      // Start of scan: the rest is image data.
      parts.push(buf.subarray(i));
      break;
    }
    const len = buf.readUInt16BE(i + 2);
    const segment = buf.subarray(i, i + 2 + len);
    // APP1 (EXIF, XMP), APP13 (IPTC) can carry GPS and names; drop them.
    const drop = marker === 0xe1 || marker === 0xed;
    if (!drop) parts.push(segment);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc && len >= 7) {
      height = buf.readUInt16BE(i + 5);
      width = buf.readUInt16BE(i + 7);
    }
    i += 2 + len;
  }
  return { buffer: Buffer.concat(parts), width, height, stripped: true };
}

function png(buf: Buffer): Stripped {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(sig)) return { buffer: buf, width: null, height: null, stripped: false };
  const parts: Buffer[] = [buf.subarray(0, 8)];
  let i = 8;
  let width: number | null = null;
  let height: number | null = null;
  while (i + 12 <= buf.length) {
    const len = buf.readUInt32BE(i);
    const name = buf.toString('latin1', i + 4, i + 8);
    const chunk = buf.subarray(i, i + 12 + len);
    if (name === 'IHDR' && len >= 8) {
      width = buf.readUInt32BE(i + 8);
      height = buf.readUInt32BE(i + 12);
    }
    if (!['eXIf', 'tEXt', 'zTXt', 'iTXt'].includes(name)) parts.push(chunk);
    i += 12 + len;
    if (name === 'IEND') break;
  }
  return { buffer: Buffer.concat(parts), width, height, stripped: true };
}

function webp(buf: Buffer): Stripped {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    return { buffer: buf, width: null, height: null, stripped: false };
  }
  const chunks: Buffer[] = [];
  let i = 12;
  let width: number | null = null;
  let height: number | null = null;
  let vp8x: Buffer | null = null;
  while (i + 8 <= buf.length) {
    const name = buf.toString('latin1', i, i + 4);
    const len = buf.readUInt32LE(i + 4);
    const padded = len + (len % 2);
    const chunk = Buffer.from(buf.subarray(i, i + 8 + padded));
    if (name === 'VP8X' && len >= 10) {
      width = 1 + buf.readUIntLE(i + 12, 3);
      height = 1 + buf.readUIntLE(i + 15, 3);
      // Clear the EXIF (bit 3) and XMP (bit 2) flags since those chunks go.
      chunk[8] &= ~0b0000_1100;
      vp8x = chunk;
      chunks.push(chunk);
    } else if (name !== 'EXIF' && name !== 'XMP ') {
      chunks.push(chunk);
    }
    i += 8 + padded;
  }
  void vp8x;
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return { buffer: Buffer.concat([header, body]), width, height, stripped: true };
}
