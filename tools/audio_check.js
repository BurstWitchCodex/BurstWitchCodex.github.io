#!/usr/bin/env node
/* MP3 体检（只读，不依赖任何 WAV 母本）
 * 逐个用 ffmpeg 解一遍：能不能解、时长是否 >0、文件是否过小（疑似截断）。
 * 用法：node tools/audio_check.js [--sample N]
 */
const fs = require("fs"), path = require("path"), cp = require("child_process");
const WEB = path.resolve(__dirname, "..");
const SND = path.join(WEB, "media", "sound");
function whichFF(){ if (process.env.FFMPEG) return process.env.FFMPEG;
  for (const p of ["C:/KujouShiori/oopz/ffmpeg.exe", "C:/KujouShiori/JianyingPro/10.8.0.14162/ffmpeg.exe"]) if (fs.existsSync(p)) return p;
  return "ffmpeg"; }   // 本机路径只是兜底，可用 env FFMPEG 覆盖
const FF = whichFF();
const args = process.argv.slice(2), SAMPLE = args.includes("--sample") ? +args[args.indexOf("--sample") + 1] : 0;

function probe(f) {
  let s = "";
  try { s = cp.execSync(`"${FF}" -hide_banner -i "${f}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
  catch (e) { s = String(e.stderr || ""); }
  const d = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(s);
  const br = /Audio:[^\n]*?,\s*(\d+)\s*kb\/s/.exec(s);
  return {
    sec: d ? +d[1] * 3600 + +d[2] * 60 + parseFloat(d[3]) : null,
    kbps: br ? +br[1] : null,
    err: /Invalid data|Output file is empty|error while decoding/i.test(s) ? "解码报错" : null,
  };
}
const files = fs.readdirSync(SND).filter(f => f.endsWith(".mp3")).sort();
const list = SAMPLE ? files.slice(0, SAMPLE) : files;
let bytes = 0; files.forEach(f => bytes += fs.statSync(path.join(SND, f)).size);
console.log(`mp3 ${files.length} 个 / ${(bytes / 1048576).toFixed(0)} MB｜本次检查 ${list.length} 个`);
let bad = 0, total = 0, checked = 0; const badList = [], rates = {};
for (let i = 0; i < list.length; i += 8) {
  list.slice(i, i + 8).forEach(f => {
    const p = path.join(SND, f), r = probe(p);
    checked++;
    if (r.sec) total += r.sec;
    if (r.kbps) rates[r.kbps] = (rates[r.kbps] || 0) + 1;
    const size = fs.statSync(p).size;
    if (!r.sec || r.sec <= 0 || r.err || size < 2048) {
      bad++; if (badList.length < 10) badList.push(f + " → " + JSON.stringify({ sec: r.sec, size, err: r.err }));
    }
  });
}
console.log(JSON.stringify({ 检查数: checked, 异常: bad, 总时长小时: +(total / 3600).toFixed(2), 码率分布: rates }, null, 1));
if (badList.length) console.log(badList.join("\n"));
