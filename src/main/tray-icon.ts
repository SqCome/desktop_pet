// Programmatically generate the system-tray icon as a PNG buffer.
//
// Why generate instead of shipping an asset?
//   - No asset file to ship, no bundler config to wrangle, no broken-path
//     bugs after electron-builder packaging.
//   - The icon scales cleanly (vector source → any size) and recolors are
//     free — we don't need to maintain parallel light/dark variants.
//
// Design: a 32×32 pink-to-orange gradient rounded square with a tiny white
// cat-face silhouette (two triangle ears + a circle face with two black dots
// for eyes). 32×32 is the sweet spot — small enough to fit Windows tray
// (~16px tall but doubles on HiDPI), big enough that the silhouette
// actually reads at 1× scale.
//
// Output: a complete PNG buffer ready for `nativeImage.createFromBuffer`.
import * as zlib from 'node:zlib';

const SIZE = 32;

// Pink-to-orange gradient stops (top → bottom). These match the bubble
// gradient in styles.css so the tray and the bubbles feel like the same
// app — the brand color is consistent.
const GRADIENT_TOP = [0xff, 0x9e, 0xc0] as const; // #ff9ec0
const GRADIENT_BOTTOM = [0xff, 0xb8, 0x73] as const; // warm peach
const BG = [0xff, 0xff, 0xff] as const; // transparent default

function rgba(r: number, g: number, b: number, a = 0xff): number {
  // Pack a single RGBA pixel as a 32-bit little-endian integer. This is
  // the format expected by the PNG IDAT scanline filter type 0 (None).
  return (a << 24) | (b << 16) | (g << 8) | r;
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

/**
 * Generate the raw RGBA pixel buffer for the icon.
 *   - Rounded square with a vertical gradient.
 *   - Cat silhouette: two triangular ears + a round face + two dot eyes.
 *
 * The cat silhouette is laid out in "icon pixels" (SIZE × SIZE). At 32×32
 * we have enough resolution to draw ears that actually look like ears, not
 * blurry blobs.
 */
function rasterize(): Uint8Array {
  const buf = new Uint8Array(SIZE * SIZE * 4);
  const cornerR = 6; // rounded corner radius in icon pixels
  const faceR = 11; // face circle radius
  const faceCx = SIZE / 2 - 0.5;
  const faceCy = SIZE / 2 + 1.5; // nudge down so ears have room above
  // Ears: two right triangles whose apex points up and whose hypotenuse
  // meets the top of the face circle. Coordinates in icon pixels.
  // Left ear: tip at (faceCx - 5, 4), base across the top-left of the face.
  // Right ear: mirror.
  const earL = { tipX: faceCx - 5, tipY: 3, baseLX: faceCx - 9, baseLY: faceCy - 5, baseRX: faceCx - 1, baseRY: faceCy - 5 };
  const earR = { tipX: faceCx + 5, tipY: 3, baseLX: faceCx + 1, baseLY: faceCy - 5, baseRX: faceCx + 9, baseRY: faceCy - 5 };
  // Eye positions inside the face (offset slightly toward center).
  const eyeL = { x: faceCx - 3, y: faceCy - 1, r: 1.2 };
  const eyeR = { x: faceCx + 3, y: faceCy - 1, r: 1.2 };

  for (let y = 0; y < SIZE; y++) {
    const t = y / (SIZE - 1);
    const bgR = lerp(GRADIENT_TOP[0], GRADIENT_BOTTOM[0], t);
    const bgG = lerp(GRADIENT_TOP[1], GRADIENT_BOTTOM[1], t);
    const bgB = lerp(GRADIENT_TOP[2], GRADIENT_BOTTOM[2], t);
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;

      // --- Step 1: rounded square mask (alpha channel) ---
      // Inside the rounded rect? Treat the four corners as quarter circles
      // of radius `cornerR`; outside the corner circles, require the point
      // to be inside the inner rect.
      let inside = true;
      const cx = x < cornerR ? cornerR : x > SIZE - 1 - cornerR ? SIZE - 1 - cornerR : x;
      const cy = y < cornerR ? cornerR : y > SIZE - 1 - cornerR ? SIZE - 1 - cornerR : y;
      if ((x - cx) ** 2 + (y - cy) ** 2 > cornerR ** 2) inside = false;
      if (!inside) {
        buf[i] = BG[0]; buf[i + 1] = BG[1]; buf[i + 2] = BG[2]; buf[i + 3] = 0;
        continue;
      }

      // --- Step 2: determine base color (gradient under silhouette) ---
      let r = bgR, g = bgG, b = bgB, a = 0xff;

      // --- Step 3: ears (white) ---
      const inEarL = pointInTriangle(x, y, earL);
      const inEarR = pointInTriangle(x, y, earR);
      if (inEarL || inEarR) {
        r = 0xff; g = 0xff; b = 0xff;
      }

      // --- Step 4: face circle (white) ---
      const dx = x - faceCx;
      const dy = y - faceCy;
      const distSq = dx * dx + dy * dy;
      if (distSq <= faceR * faceR) {
        r = 0xff; g = 0xff; b = 0xff;
        // --- Step 5: eyes (black dots) ---
        const eDxL = x - eyeL.x;
        const eDyL = y - eyeL.y;
        if (eDxL * eDxL + eDyL * eDyL <= eyeL.r * eyeL.r) {
          r = 0x33; g = 0x33; b = 0x33;
        }
        const eDxR = x - eyeR.x;
        const eDyR = y - eyeR.y;
        if (eDxR * eDxR + eDyR * eDyR <= eyeR.r * eyeR.r) {
          r = 0x33; g = 0x33; b = 0x33;
        }
      }

      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }
  return buf;
}

/** Point-in-triangle test using barycentric sign-of-cross-product. */
function pointInTriangle(
  x: number,
  y: number,
  tri: { tipX: number; tipY: number; baseLX: number; baseLY: number; baseRX: number; baseRY: number },
): boolean {
  const d1 = sign(x, y, tri.tipX, tri.tipY, tri.baseLX, tri.baseLY);
  const d2 = sign(x, y, tri.baseLX, tri.baseLY, tri.baseRX, tri.baseRY);
  const d3 = sign(x, y, tri.baseRX, tri.baseRY, tri.tipX, tri.tipY);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function sign(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): number {
  return (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
}

// ---------------------------------------------------------------------------
// PNG encoder (PNG 8-bit RGBA, no external deps).
//
// We emit:
//   - 8-byte signature
//   - IHDR chunk (width, height, bit depth, color type, etc.)
//   - IDAT chunk (zlib-compressed scanlines, each prefixed with a filter
//     byte — we use filter type 0 / "None", which means raw scanlines)
//   - IEND chunk
//
// Every chunk is prefixed by a 4-byte big-endian length, followed by the
// 4-byte ASCII type code, the payload, and a 4-byte CRC32 over (type+payload).
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CRC-32 (polynomial 0xedb88320) — used for PNG chunk integrity. */
const CRC_TABLE: number[] = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/**
 * Build a complete PNG buffer (32×32 RGBA) for use as the tray icon.
 * Idempotent — safe to call multiple times; the output is deterministic.
 */
export function buildTrayIconPng(): Buffer {
  const px = rasterize();
  // Wrap each scanline with a filter byte (0 = None) — required by PNG
  // even though we have no inter-line prediction.
  const stride = SIZE * 4;
  const raw = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(px.buffer, px.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw);

  // IHDR: width(4) + height(4) + bitDepth(1) + colorType(1) + compression(1)
  // + filter(1) + interlace(1) = 13 bytes
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth: 8 bits per channel
  ihdr[9] = 6; // color type: 6 = RGBA (truecolor + alpha)
  ihdr[10] = 0; // compression: 0 = deflate
  ihdr[11] = 0; // filter: 0 = adaptive (we wrote explicit per-line filters)
  ihdr[12] = 0; // interlace: 0 = no interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}