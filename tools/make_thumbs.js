#!/usr/bin/env node
/* 爆裂魔女 · PNG 缩略图生成器（零依赖 node 实现）
 *
 * 为什么要自己写：本机没有可用的 Python/PIL，PowerShell 的逐像素裁边在脚本里是解释级速度，
 * 583 张图要跑几小时。这里只处理解包产物的实际格式（8bit、非隔行、colorType 0/2/3/6），
 * 缩放用按 alpha 加权的面积平均，透明像素不会把边缘染黑。
 *
 * 任务清单是 TSV：源文件 \t 目标文件 \t 最长边 \t 是否裁透明边(1/0)
 * 用法：node tools/make_thumbs.js --jobs <tsv> [--force] [--report]
 */
const fs = require("fs"), path = require("path"), zlib = require("zlib");

/* ---------- PNG 解码 ---------- */
const CRC_TABLE = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; } return t; })();
function crc32(buf, start, end) { let c = -1; for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; }

function readPng(file) { return decodePng(fs.readFileSync(file)); }
function decodePng(b) {
  if (b.length < 8 || b.toString("hex", 0, 8) !== "89504e470d0a1a0a") return { error: "非 PNG" };
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = []; let plte = null, trns = null;
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p), type = b.toString("latin1", p + 4, p + 8), dataStart = p + 8;
    if (type === "IHDR") { w = b.readUInt32BE(dataStart); h = b.readUInt32BE(dataStart + 4); depth = b[dataStart + 8]; ctype = b[dataStart + 9]; interlace = b[dataStart + 12]; }
    else if (type === "PLTE") plte = b.slice(dataStart, dataStart + len);
    else if (type === "tRNS") trns = b.slice(dataStart, dataStart + len);
    else if (type === "IDAT") idat.push(b.slice(dataStart, dataStart + len));
    else if (type === "IEND") break;
    p = dataStart + len + 4;
  }
  if (depth !== 8) return { error: "位深 " + depth + " 不支持" };
  if (interlace !== 0) return { error: "隔行 PNG 不支持" };
  const ch = ({ 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 })[ctype];
  if (!ch) return { error: "colorType " + ctype + " 不支持" };
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const img = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.slice(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const out = img.slice(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[x - ch] : 0, bb = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += bb; else if (f === 3) v += (a + bb) >> 1;
      else if (f === 4) { const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c); }
      out[x] = v & 0xff;
    }
    out.copy(img, y * stride);
    prev = Buffer.from(out);
  }
  // 统一成 RGBA8
  const rgba = new Uint8Array(w * h * 4);
  if (ctype === 6) rgba.set(img);
  else if (ctype === 2) for (let i = 0, j = 0; i < w * h; i++, j += 3) { rgba[i * 4] = img[j]; rgba[i * 4 + 1] = img[j + 1]; rgba[i * 4 + 2] = img[j + 2]; rgba[i * 4 + 3] = 255; }
  else if (ctype === 0) for (let i = 0; i < w * h; i++) { const g = img[i]; rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = 255; }
  else if (ctype === 3) for (let i = 0; i < w * h; i++) { const p = img[i]; rgba[i * 4] = plte[p * 3]; rgba[i * 4 + 1] = plte[p * 3 + 1]; rgba[i * 4 + 2] = plte[p * 3 + 2]; rgba[i * 4 + 3] = trns ? (p < trns.length ? trns[p] : 0) : 255; }
  else if (ctype === 4) for (let i = 0; i < w * h; i++) { const g = img[i * 2], al = img[i * 2 + 1]; rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g; rgba[i * 4 + 3] = al; }
  return { w, h, data: rgba };
}

/* ---------- PNG 编码（逐行自适应选 filter 0/1/2/3/4，与原图一致量级） ---------- */
function writePng(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td, 0, td.length), 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[12] = 0;
  const bpp = 4, rowLen = w * bpp;
  const src = Buffer.from(rgba.buffer ? rgba.buffer : rgba);
  const out = Buffer.alloc(h * (rowLen + 1));
  const cur = Buffer.alloc(rowLen), prevRow = Buffer.alloc(rowLen), cand = Buffer.alloc(rowLen + 1);
  for (let y = 0; y < h; y++) {
    src.copy(cur, 0, y * rowLen, (y + 1) * rowLen);
    let bestF = 0, bestScore = Infinity, best = Buffer.alloc(rowLen + 1);
    for (let f = 0; f <= 4; f++) {
      let score = 0;
      for (let x = 0; x < rowLen; x++) {
        const a = x >= bpp ? cur[x - bpp] : 0, bb = prevRow[x], c = x >= bpp ? prevRow[x - bpp] : 0;
        let v = cur[x];
        if (f === 1) v -= a; else if (f === 2) v -= bb; else if (f === 3) v -= (a + bb) >> 1;
        else if (f === 4) { const pp = a + bb - c, pa = Math.abs(pp - a), pb = Math.abs(pp - bb), pc = Math.abs(pp - c); v -= (pa <= pb && pa <= pc) ? a : (pb <= pc ? bb : c); }
        const s = v & 0xff; cand[x + 1] = s;
        score += s < 128 ? s : 256 - s;                      // 常规启发：绝对值最小
      }
      if (score < bestScore) { bestScore = score; bestF = f; best = Buffer.from(cand); best[0] = f; }
    }
    best.copy(out, y * (rowLen + 1));
    cur.copy(prevRow);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(out, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/* ---------- 裁透明边 ---------- */
function alphaBox(img) {
  const { w, h, data } = img;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (data[(y * w + x) * 4 + 3] !== 0) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  if (x1 < 0) return { x: 0, y: 0, w, h };
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/* ---------- 按 alpha 加权的面积平均缩放 ---------- */
function scale(img, box, maxSide) {
  const sw = box.w, sh = box.h;
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const dw = Math.max(1, Math.round(sw * k)), dh = Math.max(1, Math.round(sh * k));
  const out = new Uint8Array(dw * dh * 4);
  const px = sw / dw, py = sh / dh;
  for (let oy = 0; oy < dh; oy++) {
    const y0 = oy * py, y1 = Math.min(sh, y0 + py);
    for (let ox = 0; ox < dw; ox++) {
      const x0 = ox * px, x1 = Math.min(sw, x0 + px);
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const fy = Math.min(y1, sy + 1) - Math.max(y0, sy); if (fy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const fx = Math.min(x1, sx + 1) - Math.max(x0, sx); if (fx <= 0) continue;
          const i = ((box.y + sy) * img.w + box.x + sx) * 4;
          const al = img.data[i + 3] / 255, wgt = fx * fy * al;
          r += img.data[i] * wgt; g += img.data[i + 1] * wgt; b += img.data[i + 2] * wgt; a += img.data[i + 3] * fx * fy; wsum += fx * fy;
        }
      }
      const o = (oy * dw + ox) * 4, al = wsum > 0 ? a / wsum : 0;
      if (al > 1) { out[o] = Math.min(255, Math.round(r / (a / 255))); out[o + 1] = Math.min(255, Math.round(g / (a / 255))); out[o + 2] = Math.min(255, Math.round(b / (a / 255))); }
      out[o + 3] = Math.round(al);
    }
  }
  return { w: dw, h: dh, data: out };
}

/* ---------- 自检：解码后重编码（filter 0），再解码应与原解码逐字节一致 ---------- */
function selfTest(file) {
  const a = readPng(file);
  if (a.error) return "跳过（" + a.error + "）";
  const re = decodePng(writePng(a.w, a.h, Buffer.from(a.data.buffer)));
  if (re.error) return "重编码解不开：" + re.error;
  if (re.w !== a.w || re.h !== a.h) return "尺寸变了";
  for (let i = 0; i < a.data.length; i++) if (re.data[i] !== a.data[i]) return "像素不一致 @" + i;
  return "OK";
}

/* ---------- 主流程 ---------- */
const argv = process.argv.slice(2);
const jf = argv[argv.indexOf("--jobs") + 1];
const FORCE = argv.includes("--force");
if (argv.includes("--selftest")) {
  const files = fs.readFileSync(jf, "utf8").split(/\r?\n/).filter(l => l.trim()).slice(0, 12).map(l => l.split("\t")[0]);
  files.forEach(f => console.log("  " + selfTest(f) + "  " + path.basename(f)));
  process.exit(0);
}
const lines = fs.readFileSync(jf, "utf8").split(/\r?\n/).filter(l => l.trim());
let ok = 0, skip = 0, fail = 0; const fails = [];
const t0 = Date.now();
for (let i = 0; i < lines.length; i++) {
  const [src, dst, maxSideS, trimS] = lines[i].split("\t");
  const maxSide = parseInt(maxSideS || "320", 10), trim = (trimS || "1") !== "0";
  if (fs.existsSync(dst) && !FORCE) { skip++; continue; }
  try {
    const img = readPng(src);
    if (img.error) throw new Error(img.error);
    const box = trim ? alphaBox(img) : { x: 0, y: 0, w: img.w, h: img.h };
    const r = scale(img, box, maxSide);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, writePng(r.w, r.h, Buffer.from(r.data.buffer)));
    ok++;
  } catch (e) { fail++; if (fails.length < 12) fails.push(path.basename(dst) + " :: " + e.message); }
  if ((i + 1) % 100 === 0) console.error("  … " + (i + 1) + "/" + lines.length + " 用时 " + ((Date.now() - t0) / 1000).toFixed(0) + "s");
}
console.log(JSON.stringify({ 任务: lines.length, 成功: ok, 已存在跳过: skip, 失败: fail, 秒: +((Date.now() - t0) / 1000).toFixed(1), 失败样例: fails }));
