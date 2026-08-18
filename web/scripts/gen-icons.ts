/**
 * Generates the PWA icons as PNGs with no image dependency and no network:
 * the app ships a strict CSP and a tailnet-only box has no CDN reachability, so
 * every byte the phone loads has to come out of the Go binary.
 *
 * Run with: bun run icons
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

type RGBA = [number, number, number, number];

const BG: RGBA = [11, 15, 20, 255]; // --color-chrome
const FG: RGBA = [74, 168, 255, 255]; // --color-accent (dark)

function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function encodePNG(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const png = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    png.set(p, off);
    off += p.length;
  }
  return png;
}

/** A dark rounded square with an "h" — the same two colours as the header. */
function drawIcon(size: number, maskable: boolean): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const radius = maskable ? size / 2 : size * 0.22;
  const pad = maskable ? size * 0.18 : size * 0.24; // maskable art stays inside the safe zone

  const set = (x: number, y: number, c: RGBA) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = c[0];
    px[i + 1] = c[1];
    px[i + 2] = c[2];
    px[i + 3] = c[3];
  };

  const insideRounded = (x: number, y: number) => {
    const min = 0;
    const max = size - 1;
    const cx0 = min + radius;
    const cx1 = max - radius;
    const cy0 = min + radius;
    const cy1 = max - radius;
    if (x >= cx0 && x <= cx1) return y >= min && y <= max;
    if (y >= cy0 && y <= cy1) return x >= min && x <= max;
    const nx = Math.min(Math.max(x, cx0), cx1);
    const ny = Math.min(Math.max(y, cy0), cy1);
    return (x - nx) ** 2 + (y - ny) ** 2 <= radius ** 2;
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      set(x, y, insideRounded(x, y) ? BG : [0, 0, 0, 0]);
    }
  }

  // The glyph: a stem, an arch, and a shoulder — an "h" built from rectangles.
  const left = Math.round(pad);
  const right = Math.round(size - pad);
  const top = Math.round(pad);
  const bottom = Math.round(size - pad);
  const stroke = Math.max(2, Math.round(size * 0.1));
  const shoulder = Math.round(top + (bottom - top) * 0.42);

  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y, FG);
  };

  rect(left, top, left + stroke, bottom); // stem
  rect(right - stroke, shoulder, right, bottom); // right leg
  rect(left, shoulder, right, shoulder + stroke); // shoulder

  return encodePNG(size, size, px);
}

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "icons");
mkdirSync(out, { recursive: true });

writeFileSync(join(out, "icon-192.png"), drawIcon(192, false));
writeFileSync(join(out, "icon-512.png"), drawIcon(512, false));
writeFileSync(join(out, "icon-512-maskable.png"), drawIcon(512, true));
// iOS reads the link tag, and a maskable-only set gets a squashed home-screen icon.
writeFileSync(join(out, "apple-touch-icon.png"), drawIcon(180, false));

console.log("wrote icons to", out);
