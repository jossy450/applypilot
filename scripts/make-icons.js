// Draws the ApplyPilot icon (a check mark on a rounded blue square) at each
// size the manifest needs. No dependencies.
const fs = require('node:fs');
const path = require('node:path');
const { encodeRgba } = require('./png');

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

function png(size) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) rgba.set(pixel(size, x, y), (y * size + x) * 4);
  }
  return encodeRgba(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of SIZES) {
  fs.writeFileSync(path.join(outDir, `icon${size}.png`), png(size));
  console.log(`icons/icon${size}.png`);
}
