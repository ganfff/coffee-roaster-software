/**
 * 生成 Tauri 应用图标源文件 tools/icon-source.png (1024x1024)。
 * 纯 Node 标准库实现（zlib + 手写 CRC32），无需任何依赖。
 * 图案：深色圆角方底 + 咖啡豆（椭圆 + S 形中线）。
 * 用法: node tools/gen-icon.js   然后 npx tauri icon tools/icon-source.png -o src-tauri/icons
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const S = 1024;

// ---------- CRC32 ----------
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// ---------- 形状函数 ----------
const R = 224;                 // 圆角半径
const BEAN_A = 330, BEAN_B = 215;  // 豆长轴/短轴半径
const THETA = (-28 * Math.PI) / 180; // 豆旋转角
const COS_T = Math.cos(THETA), SIN_T = Math.sin(THETA);

function inRoundedRect(x, y) {
  const dx = Math.max(Math.abs(x - S / 2) - (S / 2 - R), 0);
  const dy = Math.max(Math.abs(y - S / 2) - (S / 2 - R), 0);
  return dx * dx + dy * dy <= R * R;
}
/** 返回 0=外, 1=豆身, 2=豆缝 */
function beanPart(x, y) {
  const px = x - S / 2, py = y - S / 2;
  const bx = px * COS_T + py * SIN_T;   // 豆坐标系
  const by = -px * SIN_T + py * COS_T;
  const e = (bx * bx) / (BEAN_A * BEAN_A) + (by * by) / (BEAN_B * BEAN_B);
  if (e > 1) return 0;
  const slitCenter = 55 * Math.sin((bx / BEAN_A) * Math.PI * 0.9);
  if (Math.abs(by - slitCenter) < 26) return 2;
  return 1;
}

// ---------- 渲染（2x2 超采样抗锯齿）----------
const raw = Buffer.alloc(S * (S * 4 + 1));
let o = 0;
for (let y = 0; y < S; y++) {
  raw[o++] = 0; // filter: none
  for (let x = 0; x < S; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < 2; sy++) {
      for (let sx = 0; sx < 2; sx++) {
        const fx = x + 0.25 + sx * 0.5, fy = y + 0.25 + sy * 0.5;
        if (!inRoundedRect(fx, fy)) continue; // 透明
        const part = beanPart(fx, fy);
        if (part === 1) { r += 200; g += 138; b += 84; }        // 豆身 #c88a54
        else if (part === 2) { r += 61; g += 36; b += 18; }     // 豆缝 #3d2412
        else {
          const t = fy / S; // 背景纵向渐变 #312016 -> #140d09
          r += 0x31 + (0x14 - 0x31) * t;
          g += 0x20 + (0x0d - 0x20) * t;
          b += 0x16 + (0x09 - 0x16) * t;
        }
        a += 255;
      }
    }
    raw[o++] = Math.round(r / 4);
    raw[o++] = Math.round(g / 4);
    raw[o++] = Math.round(b / 4);
    raw[o++] = Math.round(a / 4);
  }
}

// ---------- 写 PNG ----------
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, 'icon-source.png');
fs.writeFileSync(out, png);
console.log('written:', out, png.length, 'bytes');
