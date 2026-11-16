import { randomFillSync, randomInt } from 'node:crypto';
import { deflateSync } from 'node:zlib';

/** No two of these look alike once distorted: 0/O/D/Q, 1/I/L, 2/Z, 5/S, 6/G, 8/B and U/V each keep at most one. */
export const ALPHABET = 'ACDEFGHJKLMNPRTUWXY34789';
/** How many characters of `ALPHABET` a challenge's answer has. */
export const ANSWER_LENGTH = 6;
/** How wide a challenge's image is, in pixels. */
export const WIDTH = 240;
/** How high a challenge's image is, in pixels. */
export const HEIGHT = 80;

/** The one stroke of the letter P, which R starts with too: a stem and a bowl, in the unit box of `GLYPHS`. */
const P: Pt[] = [[0.1, 1], [0.1, 0], [0.5, 0], ...arc(0.5, 0.27, 0.4, 0.27, 90, -90), [0.1, 0.54]];

/** Stroke outlines in a unit box, y downwards: drawn as thick lines, not from a font, so there is no text to extract. */
const GLYPHS: Record<string, Pt[][]> = {
  A: [[[0, 1], [0.5, 0], [1, 1]], [[0.22, 0.64], [0.78, 0.64]]],
  C: [arc(0.55, 0.5, 0.45, 0.5, 50, 310)],
  D: [[[0.1, 0], [0.1, 1]], [[0.1, 0], [0.45, 0], ...arc(0.45, 0.5, 0.45, 0.5, 90, -90), [0.1, 1]]],
  E: [[[0.9, 0], [0.1, 0], [0.1, 1], [0.9, 1]], [[0.1, 0.5], [0.7, 0.5]]],
  F: [[[0.9, 0], [0.1, 0], [0.1, 1]], [[0.1, 0.48], [0.7, 0.48]]],
  G: [[...arc(0.55, 0.5, 0.45, 0.5, 50, 360), [0.6, 0.5]]],
  H: [[[0.1, 0], [0.1, 1]], [[0.9, 0], [0.9, 1]], [[0.1, 0.5], [0.9, 0.5]]],
  J: [[[0.35, 0], [0.95, 0]], [[0.75, 0], [0.75, 0.68], ...arc(0.45, 0.68, 0.3, 0.32, 0, -170)]],
  K: [[[0.1, 0], [0.1, 1]], [[0.9, 0], [0.1, 0.62]], [[0.38, 0.42], [0.92, 1]]],
  L: [[[0.12, 0], [0.12, 1], [0.88, 1]]],
  M: [[[0.05, 1], [0.12, 0], [0.5, 0.62], [0.88, 0], [0.95, 1]]],
  N: [[[0.1, 1], [0.1, 0], [0.9, 1], [0.9, 0]]],
  P: [P],
  R: [P, [[0.42, 0.54], [0.92, 1]]],
  T: [[[0, 0], [1, 0]], [[0.5, 0], [0.5, 1]]],
  U: [[[0.1, 0], ...arc(0.5, 0.62, 0.4, 0.38, 180, 360), [0.9, 0]]],
  W: [[[0, 0], [0.24, 1], [0.5, 0.32], [0.76, 1], [1, 0]]],
  X: [[[0.08, 0], [0.92, 1]], [[0.92, 0], [0.08, 1]]],
  Y: [[[0.05, 0], [0.5, 0.5], [0.95, 0]], [[0.5, 0.5], [0.5, 1]]],
  3: [[...arc(0.5, 0.27, 0.38, 0.27, 150, -90), ...arc(0.5, 0.77, 0.42, 0.23, 90, -150)]],
  4: [[[0.72, 1], [0.72, 0], [0.05, 0.7], [0.95, 0.7]]],
  7: [[[0.05, 0], [0.95, 0], [0.38, 1]]],
  8: [arc(0.5, 0.26, 0.32, 0.26, 0, 360), arc(0.5, 0.74, 0.4, 0.26, 0, 360)],
  9: [arc(0.5, 0.32, 0.38, 0.32, 0, 360), arc(0.4, 0.32, 0.48, 0.68, 0, -90)],
};

/**
 * The lookup table of CRC-32, the checksum every PNG chunk ends with: for each value of a byte,
 * what eight shifts by the polynomial 0xedb88320 make of it, so `crc32` takes a byte at a time.
 */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

type Pt = [number, number];

/** Points on an ellipse from `from` to `to` degrees, counterclockwise for increasing angles (y grows downwards). */
function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number): Pt[] {
  const steps = Math.max(4, Math.ceil(Math.abs(to - from) / 15));
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    return [cx + rx * Math.cos(a), cy - ry * Math.sin(a)];
  });
}

/** A random answer, from a cryptographic source. */
export function challengeText(): string {
  return Array.from({ length: ANSWER_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
}

/** Uniform in [0, 1), cryptographically random, so no rendering can be predicted from earlier ones. */
function randomSource() {
  const pool = new Uint32Array(512);
  let i = pool.length;
  const next = () => {
    if (i === pool.length) {
      randomFillSync(pool);
      i = 0;
    }
    return pool[i++]! / 2 ** 32;
  };
  return { next, range: (lo: number, hi: number) => lo + (hi - lo) * next() };
}

/**
 * A line to draw in the image: the points it goes through, and how thick it is, both in pixels.
 * `renderChallenge` makes one of each line of a character, and of each curve and arc it adds, and
 * draws them all.
 */
interface Stroke {
  pts: Pt[];
  width: number;
}

/**
 * Renders `text` as a grayscale PNG meant to be read by people and not by OCR. The characters overlap
 * and are each scaled, rotated and sheared; curves as thick as their strokes run through them, with
 * glyph fragments scattered around, so neither stroke width nor gaps separate the characters. A wave
 * bends the whole image, a band of it is inverted (so no single threshold separates ink from
 * background), and noise covers the rest. It's a raster, so its shapes can only be recovered by reading it.
 */
export function renderChallenge(text: string): Buffer {
  const { next, range } = randomSource();
  const strokes: Stroke[] = [];
  const place = (glyph: Pt[][], cx: number, cy: number, w: number, h: number, angle: number, shear: number, width: number) => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    for (const line of glyph) {
      strokes.push({
        width,
        pts: line.map(([gx, gy]) => {
          const y = (gy - 0.5) * h;
          const x = (gx - 0.5) * w + shear * y;
          return [cx + x * cos - y * sin, cy + x * sin + y * cos];
        }),
      });
    }
  };

  const chars = [...text].map((c) => {
    const h = range(40, 50);
    const w = h * range(0.62, 0.8);
    return { glyph: GLYPHS[c]!, h, w, step: w * range(0.8, 0.95) };
  });
  let x = (WIDTH - (chars.slice(0, -1).reduce((s, c) => s + c.step, 0) + chars.at(-1)!.w)) / 2 + range(-5, 5);
  for (const c of chars) {
    place(c.glyph, x + c.w / 2, HEIGHT / 2 + range(-5, 5), c.w, c.h, range(-0.3, 0.3), range(-0.25, 0.25), range(3.4, 4.4));
    x += c.step;
  }

  // One curve as thick as the characters' strokes, and one thinner.
  for (const width of [range(2.8, 3.6), range(1.6, 2.4)]) {
    const ys = [range(15, HEIGHT - 15), range(0, HEIGHT), range(0, HEIGHT), range(15, HEIGHT - 15)];
    const pts: Pt[] = [];
    for (let i = 0; i <= 48; i++) {
      const t = i / 48;
      const u = 1 - t;
      pts.push([-4 + t * (WIDTH + 8), u * u * u * ys[0]! + 3 * u * u * t * ys[1]! + 3 * u * t * t * ys[2]! + t * t * t * ys[3]!]);
    }
    strokes.push({ pts, width });
  }
  // Short arcs that run into the characters, and don't look like any themselves.
  for (let n = 3 + Math.floor(next() * 3); n > 0; n--) {
    const r = range(6, 14);
    const from = range(0, 360);
    strokes.push({ pts: arc(range(0, WIDTH), range(0, HEIGHT), r, r * range(0.6, 1), from, from + range(60, 140)), width: range(1.8, 3) });
  }

  const ax = range(2, 3.5);
  const ay = range(2.5, 4.5);
  const fx = range(0.035, 0.07);
  const fy = range(0.04, 0.09);
  const px = range(0, 2 * Math.PI);
  const py = range(0, 2 * Math.PI);

  const ink = new Float32Array(WIDTH * HEIGHT);
  for (const { pts, width } of strokes) {
    let prev: Pt | undefined;
    for (const p of subdivide(pts, 1.5).map(([x0, y0]: Pt): Pt => [x0 + ax * Math.sin(y0 * fy + px), y0 + ay * Math.sin(x0 * fx + py)])) {
      if (prev) drawSegment(ink, prev, p, width / 2);
      prev = p;
    }
  }

  const bg = range(205, 240);
  const fg = range(20, 70);
  const gx = range(-25, 25);
  const gy = range(-25, 25);
  const bandX = range(0.1, 0.65) * WIDTH;
  const bandW = range(0.14, 0.24) * WIDTH;
  const slope = range(-0.6, 0.6);
  const noise = range(8, 16);
  const gray = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    const shift = slope * (y - HEIGHT / 2);
    for (let x = 0; x < WIDTH; x++) {
      const i = y * WIDTH + x;
      const back = bg + gx * (x / WIDTH - 0.5) + gy * (y / HEIGHT - 0.5);
      let v = back + (fg - back) * ink[i]! + (next() + next() + next() - 1.5) * noise;
      if (x >= bandX + shift && x < bandX + bandW + shift) v = 255 - v;
      if (next() < 0.01) v = next() < 0.5 ? range(0, 60) : range(195, 255);
      gray[i] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return encodePng(WIDTH, HEIGHT, gray);
}

/** The polyline with no segment longer than `max`, so the wave bends straight strokes too. */
function subdivide(pts: Pt[], max: number): Pt[] {
  const out: Pt[] = [pts[0]!];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / max));
    for (let k = 1; k <= n; k++) out.push([x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n]);
  }
  return out;
}

/** Adds an anti-aliased segment `r` pixels either side of a-b to the coverage map. */
function drawSegment(ink: Float32Array, [ax, ay]: Pt, [bx, by]: Pt, r: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - r - 1));
  const x1 = Math.min(WIDTH - 1, Math.ceil(Math.max(ax, bx) + r + 1));
  const y1 = Math.min(HEIGHT - 1, Math.ceil(Math.max(ay, by) + r + 1));
  for (let y = Math.max(0, Math.floor(Math.min(ay, by) - r - 1)); y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const cx = x + 0.5 - ax;
      const cy = y + 0.5 - ay;
      const t = Math.max(0, Math.min(1, (cx * dx + cy * dy) / len2));
      const coverage = r + 0.5 - Math.hypot(cx - t * dx, cy - t * dy);
      if (coverage <= 0) continue;
      const i = y * WIDTH + x;
      ink[i] = Math.max(ink[i]!, Math.min(1, coverage));
    }
  }
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** An 8-bit grayscale PNG. */
export function encodePng(width: number, height: number, gray: Uint8Array): Buffer {
  const rows = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) rows.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
