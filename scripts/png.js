// Minimal PNG chunk helpers shared by the icon and demo-animation scripts.
const zlib = require('node:zlib');

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Splits a PNG file into [{ type, data }] chunks.
function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('Not a PNG file');
  const chunks = [];
  for (let at = 8; at < buf.length; ) {
    const length = buf.readUInt32BE(at);
    chunks.push({ type: buf.toString('ascii', at + 4, at + 8), data: buf.subarray(at + 8, at + 8 + length) });
    at += 12 + length;
  }
  return chunks;
}

// Encodes raw RGBA rows (width * height * 4 bytes) as a PNG.
function encodeRgba(width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// Joins same-sized PNG frames into an animated PNG without re-encoding them:
// each frame's compressed IDAT stream is reused as-is.
function animate(frames) {
  const parsed = frames.map(({ png }) => readChunks(png));
  const ihdr = parsed[0].find((c) => c.type === 'IHDR').data;
  for (const chunks of parsed) {
    if (!chunks.find((c) => c.type === 'IHDR').data.equals(ihdr)) throw new Error('All frames must share size and color type');
  }

  let sequence = 0;
  const frameControl = (delayMs) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence++, 0);
    data.writeUInt32BE(ihdr.readUInt32BE(0), 4); // width
    data.writeUInt32BE(ihdr.readUInt32BE(4), 8); // height
    data.writeUInt16BE(delayMs, 20);
    data.writeUInt16BE(1000, 22);
    return chunk('fcTL', data);
  };

  const control = Buffer.alloc(8);
  control.writeUInt32BE(frames.length, 0); // frame count; play count 0 = loop forever
  const out = [SIGNATURE, chunk('IHDR', ihdr), chunk('acTL', control)];

  parsed.forEach((chunks, i) => {
    out.push(frameControl(frames[i].delayMs));
    const image = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
    if (i === 0) {
      out.push(chunk('IDAT', image));
    } else {
      const seq = Buffer.alloc(4);
      seq.writeUInt32BE(sequence++);
      out.push(chunk('fdAT', Buffer.concat([seq, image])));
    }
  });
  out.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(out);
}

module.exports = { encodeRgba, animate };
