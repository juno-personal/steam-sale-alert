/* PWA 아이콘 생성기 (외부 의존성 없음)
 *   node tools/make-icons.mjs
 *
 * PNG를 직접 인코딩한다. GitHub Pages용 정적 아이콘이며,
 * 마크업은 다시 생성할 일이 거의 없으므로 빌드 파이프라인에는 넣지 않는다.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "icons");
mkdirSync(OUT, { recursive: true });

/* ---------- PNG 인코딩 ---------- */
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
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // adaptive filtering
  ihdr[12] = 0;  // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- 모양 ---------- */
const BG = [0x1b, 0x28, 0x38];
const CIRCLE = [0x66, 0xc0, 0xf4];
const ARROW = [0xff, 0xff, 0xff];

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inArrow(x, y, cx, cy, barHalf, barTop, headHalf, headBottom) {
  if (x >= cx - barHalf && x <= cx + barHalf && y >= barTop && y <= cy) return true;
  if (y > cy && y <= headBottom) {
    const t = (y - cy) / (headBottom - cy);
    const half = headHalf * (1 - t);
    return Math.abs(x - cx) <= half;
  }
  return false;
}

function render(size, maskable) {
  const buf = Buffer.alloc(size * size * 4);
  const SS = 4; // 4x4 슈퍼샘플링

  // maskable은 안전 영역(중앙 80%) 안에 마크를 넣고 배경으로 전체를 채운다
  const scale = maskable ? 0.62 : 1;
  const cx = size / 2;
  const cy = size / 2;
  const r = 0.36 * size * scale;
  const barHalf = 0.052 * size * scale;
  const barTop = cy - 0.20 * size * scale;
  const headHalf = 0.175 * size * scale;
  const headBottom = cy + 0.235 * size * scale;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let acc = [0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;
          let c = BG;
          if (inCircle(x, y, cx, cy, r)) {
            c = inArrow(x, y, cx, cy, barHalf, barTop, headHalf, headBottom) ? ARROW : CIRCLE;
          }
          acc[0] += c[0];
          acc[1] += c[1];
          acc[2] += c[2];
        }
      }
      const n = SS * SS;
      const o = (py * size + px) * 4;
      buf[o] = Math.round(acc[0] / n);
      buf[o + 1] = Math.round(acc[1] / n);
      buf[o + 2] = Math.round(acc[2] / n);
      buf[o + 3] = 255;
    }
  }
  return encodePng(size, size, buf);
}

const targets = [
  ["icon-192.png", 192, false],
  ["icon-512.png", 512, false],
  ["icon-maskable-512.png", 512, true],
];

for (const [name, size, maskable] of targets) {
  const png = render(size, maskable);
  writeFileSync(join(OUT, name), png);
  console.log(`${name.padEnd(26)} ${size}x${size}  ${png.length} bytes`);
}
