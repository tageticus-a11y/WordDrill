// Draws the app icons as PNGs, with no dependencies: a rotary card file (Rolodex-style wheel of cards)
// spun by a power drill, a play on "WordDrill". Run: node scripts/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BG = [15, 23, 36];
const CARD = [122, 174, 247], CARD_ALT = [160, 198, 250], CARD_EDGE = [40, 64, 104];
const HUB = [10, 20, 36], HUB_RING = [201, 190, 245];
const MOTION = [92, 130, 190];
const BODY = [242, 168, 72], BODY_DARK = [196, 120, 40], GRIP = [44, 40, 52], METAL = [196, 204, 216], CHUCK = [92, 100, 116];

function crc32(buf) {
  let c, crc = ~0;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return ~crc >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const inRoundRect = (x, y, x0, y0, x1, y1, r) => {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r), cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const distToSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
};

// The wheel of cards
const C = [0.6, 0.39], N = 12, R0 = 0.085, R1 = 0.305, HALF = 0.05;
// The drill: its bit tip at the hub, the body going down-left; s = distance back along the drill, t = across
const D = (() => { const dx = -0.46, dy = 0.44, l = Math.hypot(dx, dy); return [dx / l, dy / l]; })();
const P = [D[1], -D[0]];   // across, towards the lower right (the side the handle hangs on)

function drill(u, v) {
  const x = u - C[0], y = v - C[1];
  const s = (x * D[0] + y * D[1]) / 1.3, t = (x * P[0] + y * P[1]) / 1.3;   // drawn 1.3× larger
  if (s >= 0.02 && s <= 0.12 && Math.abs(t) < 0.013) return METAL;                       // bit
  if (s > 0.12 && s <= 0.19 && Math.abs(t) < 0.026 + (s - 0.12) * 0.25) return CHUCK;     // chuck, tapered
  if (inRoundRect(s, t, 0.19, -0.068, 0.47, 0.068, 0.05)) {                               // body
    if (s > 0.43) return BODY_DARK;                                                      // back cap
    return t < -0.03 ? CARD_ALT.map((c, k) => Math.round((c + BODY[k] * 3) / 4)) : BODY;  // a highlight on top
  }
  if (inRoundRect(s, t, 0.31, 0.215, 0.5, 0.285, 0.025)) return GRIP;                     // battery
  if (distToSeg(s, t, 0.36, 0.03, 0.4, 0.22) < 0.042) return BODY_DARK;                   // handle
  return null;
}
function wheel(u, v) {
  const x = u - C[0], y = v - C[1], r = Math.hypot(x, y);
  if (r < 0.06) return r < 0.03 ? HUB_RING : HUB;                                         // hub
  if (r < 0.068) return CARD_EDGE;
  // Cards drawn in order; a later card covers an earlier one where they overlap
  let hit = null;
  for (let k = 0; k < N; k++) {
    const a = (k / N) * 2 * Math.PI + 0.2;
    const along = x * Math.cos(a) + y * Math.sin(a), across = -x * Math.sin(a) + y * Math.cos(a);
    if (inRoundRect(along, across, R0, -HALF, R1, HALF, 0.022)) {
      const edge = !inRoundRect(along, across, R0 + 0.007, -HALF + 0.007, R1 - 0.007, HALF - 0.007, 0.016);
      // Two lines of "text" near the outer end make them read as index cards
      const line = Math.abs(across + 0.018) < 0.006 || Math.abs(across - 0.006) < 0.006;
      const text = line && along > R1 - 0.12 && along < R1 - 0.025 && !(Math.abs(across - 0.006) < 0.006 && along > R1 - 0.06);
      hit = edge ? CARD_EDGE : text ? CARD_EDGE : k % 2 ? CARD_ALT : CARD;
    }
  }
  if (hit) return hit;
  // Motion arcs around the wheel: it spins
  const ang = Math.atan2(y, x) * 180 / Math.PI;
  const inArc = (a0, a1) => ang >= a0 && ang <= a1;
  if (r > 0.345 && r < 0.372 && (inArc(-150, -95) || inArc(-60, -5))) return MOTION;
  return null;
}
function color(u, v) {   // u, v in 0..1
  // Everything a little smaller than the drawing, so the rounded icon corners cut nothing
  const Z = 0.84, O = [0.48, 0.565];
  u = O[0] + (u - 0.5) / Z; v = O[1] + (v - 0.5) / Z;
  return drill(u, v) || wheel(u, v) || BG;
}
function png(size) {
  const S = 4, raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
        const c = color((x + (sx + .5) / S) / size, (y + (sy + .5) / S) / size);
        acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2];
      }
      const o = y * (size * 3 + 1) + 1 + x * 3;
      for (let k = 0; k < 3; k++) raw[o + k] = Math.round(acc[k] / (S * S));
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const out = process.argv[2] ? new URL('file:///' + process.argv[2].replace(/\\/g, '/') + '/') : new URL('../', import.meta.url);
for (const s of [180, 192, 512]) writeFileSync(new URL('icon-' + s + '.png', out), png(s));
console.log('icons written');
