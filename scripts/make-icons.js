'use strict';
// Generates the app icon (.png/.ico) and the tray state icons.
// Pure Node: rasterises with 4x supersampling, encodes PNG via zlib, wraps PNGs in an ICO.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ASSETS = path.join(__dirname, '..', 'assets');

// ---------------------------------------------------------------- PNG encoding

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** @param {Uint8Array} rgba row-major RGBA, size*size*4 */
function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  // 10..12 = compression / filter / interlace, all 0

  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Windows accepts PNG-compressed ICO entries (Vista+). */
function encodeIco(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);

  const dir = Buffer.alloc(16 * pngs.length);
  let offset = header.length + dir.length;
  pngs.forEach(({ size, data }, i) => {
    const o = i * 16;
    dir[o] = size >= 256 ? 0 : size;
    dir[o + 1] = size >= 256 ? 0 : size;
    dir[o + 2] = 0; // palette colours
    dir[o + 3] = 0; // reserved
    dir.writeUInt16LE(1, o + 4); // colour planes
    dir.writeUInt16LE(32, o + 6); // bits per pixel
    dir.writeUInt32LE(data.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });

  return Buffer.concat([header, dir, ...pngs.map((p) => p.data)]);
}

// ------------------------------------------------------------------ rasteriser

const SS = 4; // supersampling factor

/** Signed distance to a rounded rectangle, negative inside. */
function sdRoundRect(px, py, cx, cy, halfW, halfH, r) {
  const qx = Math.abs(px - cx) - (halfW - r);
  const qy = Math.abs(py - cy) - (halfH - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - r;
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * Draws the waveform mark: a rounded square, five rounded bars on top.
 * @param {number} size output pixel size
 * @param {{from:number[], to:number[], bar:number[], plate:boolean}} theme
 */
function render(size, theme) {
  const S = size * SS;
  const acc = new Float32Array(size * size * 4);

  const plateHalf = S * 0.5;
  const plateR = S * 0.235;

  // Bar geometry, as fractions of the full canvas.
  const heights = [0.34, 0.6, 1.0, 0.66, 0.42];
  const barW = S * 0.108;
  const gap = S * 0.072;
  const maxBarH = S * 0.46;
  const totalW = heights.length * barW + (heights.length - 1) * gap;
  const startX = (S - totalW) / 2;

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      if (theme.plate) {
        const d = sdRoundRect(px, py, S / 2, S / 2, plateHalf, plateHalf, plateR);
        const cov = Math.min(Math.max(0.5 - d, 0), 1);
        if (cov > 0) {
          // Diagonal gradient across the plate.
          const t = Math.min(Math.max((px + py) / (2 * S), 0), 1);
          const c = mix(theme.from, theme.to, t);
          r = c[0];
          g = c[1];
          b = c[2];
          a = cov;
        }
      }

      // Bars composited over the plate.
      let barCov = 0;
      for (let i = 0; i < heights.length; i++) {
        const h = maxBarH * heights[i];
        const cx = startX + i * (barW + gap) + barW / 2;
        const d = sdRoundRect(px, py, cx, S / 2, barW / 2, h / 2, barW / 2);
        barCov = Math.max(barCov, Math.min(Math.max(0.5 - d, 0), 1));
      }
      if (barCov > 0) {
        const outA = barCov + a * (1 - barCov);
        r = (theme.bar[0] * barCov + r * a * (1 - barCov)) / outA;
        g = (theme.bar[1] * barCov + g * a * (1 - barCov)) / outA;
        b = (theme.bar[2] * barCov + b * a * (1 - barCov)) / outA;
        a = outA;
      }

      // Box-downsample into the output grid, premultiplied so edges stay clean.
      const o = (Math.floor(y / SS) * size + Math.floor(x / SS)) * 4;
      acc[o] += r * a;
      acc[o + 1] += g * a;
      acc[o + 2] += b * a;
      acc[o + 3] += a;
    }
  }

  const n = SS * SS;
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const a = acc[i * 4 + 3] / n;
    if (a > 0) {
      out[i * 4] = Math.round(Math.min(acc[i * 4] / n / a, 255));
      out[i * 4 + 1] = Math.round(Math.min(acc[i * 4 + 1] / n / a, 255));
      out[i * 4 + 2] = Math.round(Math.min(acc[i * 4 + 2] / n / a, 255));
    }
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

// ---------------------------------------------------------------------- output

const THEMES = {
  idle: { from: [99, 102, 241], to: [67, 56, 202], bar: [255, 255, 255], plate: true },
  recording: { from: [239, 68, 68], to: [153, 27, 27], bar: [255, 255, 255], plate: true },
  processing: { from: [245, 158, 11], to: [180, 83, 9], bar: [255, 255, 255], plate: true },
};

fs.mkdirSync(ASSETS, { recursive: true });

// App icon: multi-resolution ICO plus a 512px PNG for non-Windows tooling.
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoEntries = icoSizes.map((size) => ({ size, data: encodePng(render(size, THEMES.idle), size) }));
fs.writeFileSync(path.join(ASSETS, 'icon.ico'), encodeIco(icoEntries));
fs.writeFileSync(path.join(ASSETS, 'icon.png'), encodePng(render(512, THEMES.idle), 512));

// Tray icons: 16 and 32 px (Windows picks by DPI). Keep the plate so the mark
// stays legible on both light and dark taskbars.
for (const [state, theme] of Object.entries(THEMES)) {
  for (const size of [16, 32]) {
    const name = size === 16 ? `tray-${state}.png` : `tray-${state}@2x.png`;
    fs.writeFileSync(path.join(ASSETS, name), encodePng(render(size, theme), size));
  }
}

console.log(`Wrote icons to ${ASSETS}`);
for (const f of fs.readdirSync(ASSETS).sort()) {
  console.log(`  ${f}  ${fs.statSync(path.join(ASSETS, f)).size} bytes`);
}
