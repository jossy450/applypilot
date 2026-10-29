// Draws the ApplyPilot icon (a check mark on a rounded blue square) at each
// size the manifest needs. No dependencies: writes PNGs with node:zlib.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const SIZES = [16, 32, 48, 128];
const SUPERSAMPLE = 4;
const BLUE = [37, 99, 235];
const WHITE = [255, 255, 255];

function insideRoundedSquare(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 1 - radius);
  const cy = Math.min(Math.max(y, radius), 1 - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function distanceToSegment(px, py, [ax, ay], [bx, by]) {
  const t = Math.max(0, Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)));
  return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)));
}

const CHECK = [[0.27, 0.52], [0.44, 0.69], [0.74, 0.34]];
const STROKE = 0.065;

function pixel(size, x, y) {
  let r = 0, g = 0, b = 0, a = 0;
  for (let sy = 0; sy < SUPERSAMPLE; sy++) {
    for (let sx = 0; sx < SUPERSAMPLE; sx++) {
      const u = (x + (sx + 0.5) / SUPERSAMPLE) / size;
      const v = (y + (sy + 0.5) / SUPERSAMPLE) / size;
      if (!insideRoundedSquare(u, v, 0.22)) continue;
      const onCheck = distanceToSegment(u, v, CHECK[0], CHECK[1]) < STROKE || distanceToSegment(u, v, CHECK[1], CHECK[2]) < STROKE;
      const [cr, cg, cb] = onCheck ? WHITE : BLUE;
      r += cr; g += cg; b += cb; a += 255;
    }
  }
  const n = SUPERSAMPLE * SUPERSAMPLE;
  const coverage = a / 255;
  return coverage ? [r / coverage, g / coverage, b / coverage, a / n].map(Math.round) : [0, 0, 0, 0];
}

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

function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // no filter
    for (let x = 0; x < size; x++) {
      Buffer.from(pixel(size, x, y)).copy(raw, y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png(size));
  console.log(`icons/icon${size}.png`);
}
