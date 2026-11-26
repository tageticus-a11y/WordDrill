// Makes the app icons (icon-180/192/512.png) from scripts/icon-source.png, with no dependencies:
// decodes the PNG, scales it down by averaging (area resampling) and writes opaque RGB PNGs.
// The source is a Rolodex-style card file spun by a drill ("WordDrill"), made with ChatGPT for this app.
// Run: node scripts/make-icons.mjs [out-dir]
import { readFileSync, writeFileSync } from 'node:fs';
import { inflateSync, deflateSync } from 'node:zlib';

const SOURCE = new URL('./icon-source.png', import.meta.url);
const BG = [15, 23, 36];   // what transparent pixels become (the app's dark background)

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let at = 8, w, h, depth, type, interlace;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at), name = buf.toString('ascii', at + 4, at + 8), data = buf.subarray(at + 8, at + 8 + len);
    if (name === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    at += 12 + len;
  }
  const channels = { 2: 3, 6: 4, 0: 1, 4: 2 }[type];
  if (depth !== 8 || !channels || interlace) throw new Error('unsupported PNG: needs 8-bit grey/RGB(A), not interlaced');
  const raw = inflateSync(Buffer.concat(idat)), stride = w * channels, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? px[y * stride + x - channels] : 0, b = y ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y ? px[(y - 1) * stride + x - channels] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[y * stride + x] = v & 255;
    }
  }
  // → RGB over the background
  const rgb = new Float64Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const p = i * channels, grey = channels <= 2;
    const r = px[p], g = grey ? px[p] : px[p + 1], bl = grey ? px[p] : px[p + 2];
    const alpha = channels === 4 ? px[p + 3] / 255 : channels === 2 ? px[p + 1] / 255 : 1;
    rgb[i * 3] = r * alpha + BG[0] * (1 - alpha); rgb[i * 3 + 1] = g * alpha + BG[1] * (1 - alpha); rgb[i * 3 + 2] = bl * alpha + BG[2] * (1 - alpha);
  }
  return { w, h, rgb };
}

// Area resampling: each target pixel is the average of the source area it covers
function resize({ w, h, rgb }, size) {
  const out = Buffer.alloc(size * size * 3), sx = w / size, sy = h / size;
  for (let ty = 0; ty < size; ty++) for (let tx = 0; tx < size; tx++) {
    const x0 = tx * sx, x1 = x0 + sx, y0 = ty * sy, y1 = y0 + sy, acc = [0, 0, 0];
    let total = 0;
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
      const wy = Math.min(y + 1, y1) - Math.max(y, y0);
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        const wt = wy * (Math.min(x + 1, x1) - Math.max(x, x0)), i = (y * w + x) * 3;
        acc[0] += rgb[i] * wt; acc[1] += rgb[i + 1] * wt; acc[2] += rgb[i + 2] * wt; total += wt;
      }
    }
    for (let k = 0; k < 3; k++) out[(ty * size + tx) * 3 + k] = Math.round(acc[k] / total);
  }
  return out;
}

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
function encodePng(pixels, size) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) pixels.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// The WD Add icons: a "+" badge in the lower right (a blue disc with a white ring and a white plus), drawn
// with 4×4 supersampling so the edges are smooth
function withPlus(pixels, size) {
  const out = Buffer.from(pixels);
  const cx = size * 0.73, cy = size * 0.73, r = size * 0.23, ring = size * 0.025, arm = r * 0.55, bar = r * 0.15;
  const paint = (i, rgb, a) => { for (let k = 0; k < 3; k++) out[i + k] = Math.round(out[i + k] * (1 - a) + rgb[k] * a); };
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
    if (x < 0 || y < 0 || x >= size || y >= size) continue;
    let disc = 0, inner = 0, plus = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = x + (sx + 0.5) / 4 - cx, py = y + (sy + 0.5) / 4 - cy, d = Math.hypot(px, py);
      if (d <= r) disc++;
      if (d <= r - ring) inner++;
      if ((Math.abs(px) <= arm && Math.abs(py) <= bar) || (Math.abs(py) <= arm && Math.abs(px) <= bar)) plus++;
    }
    const i = (y * size + x) * 3;
    paint(i, [255, 255, 255], disc / 16);        // the white ring
    paint(i, [42, 98, 184], inner / 16);         // the blue disc (--accent)
    paint(i, [255, 255, 255], plus / 16);        // the plus
  }
  return out;
}

const src = decodePng(readFileSync(SOURCE));
const out = process.argv[2] ? new URL('file:///' + process.argv[2].replace(/\\/g, '/') + '/') : new URL('../', import.meta.url);
for (const s of [180, 192, 512]) {
  const px = resize(src, s);
  writeFileSync(new URL('icon-' + s + '.png', out), encodePng(px, s));
  writeFileSync(new URL('icon-add-' + s + '.png', out), encodePng(withPlus(px, s), s));
}
console.log('icons written from ' + src.w + '×' + src.h);
