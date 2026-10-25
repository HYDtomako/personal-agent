#!/usr/bin/env node
/**
 * 生成 app/pi-agent.ico —— 手写 PNG 再套 ICO 容器，不引任何依赖（这个项目本身就没有依赖）。
 *
 * 图标是"蓝底 + 白色 π"：圆角方块用 4x4 超采样做抗锯齿，多个尺寸一起塞进 ICO，
 * 这样任务栏、桌面大图标、列表小图标都不糊。
 *
 * 单独跑：node app/icon.ts     （install 时会自动调用）
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const here = path.dirname(fileURLToPath(import.meta.url));

// ── PNG 最小实现：只有 IHDR/IDAT/IEND 三个块 ──
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(buf: Buffer): number {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
  return Buffer.concat([head, data, crc]);
}

function png(size: number, rgba: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 每通道 8 位
  ihdr[9] = 6; // 真彩 + alpha
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // 过滤方式：none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ── 图形：归一化坐标（0..1）里判定"这个点是否在圆角矩形内" ──
function inRoundRect(x: number, y: number, x0: number, x1: number, y0: number, y1: number, r: number): boolean {
  const nx = Math.min(Math.max(x, x0 + r), x1 - r);
  const ny = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - nx;
  const dy = y - ny;
  return dx * dx + dy * dy <= r * r;
}

const MARGIN = 0.055; // 圆角方块离画布边缘
const RADIUS = 0.22; // 圆角半径
const BG_TOP = [0x4f, 0x8c, 0xff]; // 与页面 --accent 同色
const BG_BOTTOM = [0x2f, 0x6a, 0xe0];

/** 白色的 π：一横 + 两条腿（腿用胶囊形，底端自然圆角） */
function inGlyph(x: number, y: number): boolean {
  const bar = inRoundRect(x, y, 0.25, 0.75, 0.3, 0.4, 0.045);
  const left = inRoundRect(x, y, 0.335, 0.425, 0.3, 0.715, 0.045);
  const right = inRoundRect(x, y, 0.575, 0.665, 0.3, 0.715, 0.045);
  return bar || left || right;
}

function render(size: number): Buffer {
  const S = 4; // 每像素 4x4 次采样：省掉一整套抗锯齿算法
  const out = Buffer.alloc(size * size * 4);
  const total = size * S;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          const x = (px * S + sx + 0.5) / total;
          const y = (py * S + sy + 0.5) / total;
          if (inGlyph(x, y)) {
            sr += 255;
            sg += 255;
            sb += 255;
            sa += 255;
          } else if (inRoundRect(x, y, MARGIN, 1 - MARGIN, MARGIN, 1 - MARGIN, RADIUS)) {
            sr += BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * y;
            sg += BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * y;
            sb += BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * y;
            sa += 255;
          }
        }
      }
      const i = (py * size + px) * 4;
      // 采样累加的是预乘颜色：除以 alpha 还原，alpha 自身取平均
      out[i] = sa ? Math.round(sr / (sa / 255)) : 0;
      out[i + 1] = sa ? Math.round(sg / (sa / 255)) : 0;
      out[i + 2] = sa ? Math.round(sb / (sa / 255)) : 0;
      out[i + 3] = Math.round(sa / (S * S));
    }
  }
  return out;
}

// ── ICO 容器：目录 + 各尺寸的 PNG 数据 ──
export function buildIco(sizes: number[] = [16, 24, 32, 48, 64, 128, 256]): Buffer {
  const images = sizes.map((size) => ({ size, data: png(size, render(size)) }));
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0); // 保留
  dir.writeUInt16LE(1, 2); // 1 = 图标
  dir.writeUInt16LE(images.length, 4);

  let offset = 6 + 16 * images.length;
  const entries: Buffer[] = [];
  for (const img of images) {
    const e = Buffer.alloc(16);
    e[0] = img.size >= 256 ? 0 : img.size; // 256 用 0 表示
    e[1] = img.size >= 256 ? 0 : img.size;
    e.writeUInt16LE(1, 4); // 色彩平面
    e.writeUInt16LE(32, 6); // 位深
    e.writeUInt32LE(img.data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += img.data.length;
    entries.push(e);
  }
  return Buffer.concat([dir, ...entries, ...images.map((i) => i.data)]);
}

export function writeIco(file = path.join(here, "pi-agent.ico")): string {
  writeFileSync(file, buildIco());
  return file;
}

// 单独执行时才落盘（被 install 引用时不写）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`已写入 ${writeIco()}`);
}
