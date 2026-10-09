#!/usr/bin/env node
/* 爆裂魔女 · 把没被网站调用的素材移到单独目录
 *
 * 口径：浏览器加载的只有 index.html、css/app.css、js/viewer.js、data/pagelist.js、
 * docs/*.md.js，以及正文里 src/href 指到的 media/* 与 pagelist 的 thumb。
 * 凡是不在这个引用集里的素材文件，按原相对路径移动到 网页版/_未引用资源/ 下面，
 * 目录层级完整保留 —— 要放回去就整目录反向 move 即可，不需要额外清单文件。
 *
 * data/ 下除 pagelist.js 之外的东西（t/*.js、i18n_*、assets.js、voices.js、media_map.js、meta.js、report.js）
 * 虽然不被浏览器加载，但它们是 web_pages.py / 本仓 node 工具的输入，不在这次移动范围内。
 *
 * 用法：node 网页版/tools/site_move_unused.js --dry   # 只看会移走什么
 *       node 网页版/tools/site_move_unused.js        # 实际移动
 */
const fs = require("fs"), path = require("path");
const WEB = path.resolve(__dirname, "..");
const DRY = process.argv.indexOf("--dry") >= 0;
const OUT = "_未引用资源";
const norm = p => p.split(path.sep).join("/");
const A_IMG = "media/img", A_TH = "media/thumb", A_SD = "media/sound", A_AR = "pages/归档";

/* pagelist.js 带文件头注释且一条一行：取第一个 [ 到最后一个 ] 的区间，不依赖行首前缀 */
const PL_TEXT = fs.readFileSync(path.join(WEB, "data/pagelist.js"), "utf8");
const P = JSON.parse(PL_TEXT.slice(PL_TEXT.indexOf("["), PL_TEXT.lastIndexOf("]") + 1));

const refs = new Set();
P.forEach(p => {
  const t = fs.readFileSync(path.join(WEB, p.file), "utf8");
  for (const m of t.matchAll(/(?:src|href)="([^"]+)"/g)) refs.add(m[1]);
  for (const m of t.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) refs.add(m[1]);
  for (const m of t.matchAll(/<source[^>]+src="([^"]+)"/g)) refs.add(m[1]);
  if (p.thumb) refs.add(p.thumb);
});

function list(dir, ext) {
  const out = [];
  const base = path.join(WEB, dir);
  if (!fs.existsSync(base)) return out;
  (function w(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = norm(path.relative(WEB, path.join(d, e.name)));
      if (e.isDirectory()) w(path.join(d, e.name)); else if (ext.test(e.name)) out.push(f);
    }
  })(base);
  return out;
}
const ASSET = /\.(png|jpg|jpeg|webp|wav|mp3|ogg)$/i;
const groups = [[A_IMG], [A_TH], [A_SD], [A_AR]];
let moved = 0, bytes = 0;
const report = [];
groups.forEach(([dir]) => {
  const all = list(dir, ASSET).filter(f => !f.startsWith(OUT + "/"));
  const un = all.filter(f => !refs.has(f));
  let b = 0;
  un.forEach(f => {
    b += fs.statSync(path.join(WEB, f)).size;
    if (!DRY) {
      const to = path.join(WEB, OUT, f);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(path.join(WEB, f), to);
    }
  });
  moved += un.length; bytes += b;
  report.push({ 目录: dir, 素材总数: all.length, 被引用: all.length - un.length, 移走: un.length, 移走MB: +(b / 1048576).toFixed(0) });
});
// 空目录收掉（只收 media/ 与 pages/归档/ 里因为搬空而剩下的空壳）
function pruneEmpty(dir) {
  let n = 0;
  (function w(d) {
    for (const e of fs.readdirSync(path.join(WEB, d), { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const sub = norm(path.join(d, e.name));
      w(sub);
      const abs = path.join(WEB, sub);
      if (fs.existsSync(abs) && fs.readdirSync(abs).length === 0 && !DRY) { fs.rmdirSync(abs); n++; }
    }
  })(dir);
  return n;
}
const pruned = DRY ? 0 : pruneEmpty(A_IMG) + pruneEmpty(A_TH) + pruneEmpty(A_AR);
console.log(JSON.stringify({ dry: DRY, 合计移走: moved, 合计MB: +(bytes / 1048576).toFixed(0), 清空壳目录: pruned, 目标: OUT + "/" }, null, 0));
report.forEach(r => console.log("  " + JSON.stringify(r, null, 0)));
