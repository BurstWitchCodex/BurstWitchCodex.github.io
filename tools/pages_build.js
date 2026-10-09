#!/usr/bin/env node
/* 爆裂魔女 · 网站构建器（文案唯一来源：pages/*.md）
 *
 * 规则：文案只从 pages/ 取。本脚本只读 md 与它自己的清单，不读 data/t 表、不读 i18n、不写任何 md。
 *
 * 目录约定（决定侧栏三级分组的归属）：
 *   pages/主页.md                      → 一级「主页」：固定第一条，也是进站默认页
 *   pages/羁绊.md 等根级 md              → 一级「汇总」
 *   pages/角色/<id>_<名>.md              → 一级「角色」，二级按编号段与名称前缀分带（1043 单独归「未实装」）
 *   pages/归档/<分类>/<文章>/<篇>.md     → 一级「归档」，二级 <分类>，三级 <篇>
 *   pages/归档/<分类>/<篇>.md            → 同上（没有再套一层时也能收）
 * 标题取文件名：去掉 “NN-” / “NN_” 前缀与 .md 扩展。
 * thumb 先找约定路径 media/thumb/source_avatar/hero/body_<id>_body_<id>.png，
 * 再退到好感立绘位 media/thumb/source_avatar/haogan/haogan_<id>_…，两边都没有就 null，不编造。
 *
 * 同时生成 docs/<名>.md.js：把 md 原文只做 JSON 字符串转义（</ → <\/，处理 U+2028/29），一字不改；
 * file:// 下浏览器不能 fetch md，只能靠 <script src> 注入。docs/ 是扁平目录，故校验 basename 全局唯一。
 *
 * 自检：md 重名、缺正文、缺包装、孤儿包装、无头像角色、正文指向但不存在的素材（按各 md 自己的目录解析 ../ 路径）。
 *
 * 用法：node tools/pages_build.js            构建
 *       node tools/pages_build.js --check    只检查不写盘
 *       node tools/pages_build.js --json     机器可读
 */
const fs = require("fs"), path = require("path");
const WEB = path.resolve(__dirname, "..");
const ARGS = process.argv.slice(2);
const CHECK = ARGS.includes("--check");
const AS_JSON = ARGS.includes("--json");
const SL = String.fromCharCode(92);
const norm = p => p.split(path.sep).join("/");
const exists = rel => fs.existsSync(path.join(WEB, rel));

/* ---------- 1) 扫 md ---------- */
function walkMd(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(f, out); else if (e.name.endsWith(".md")) out.push(norm(path.relative(WEB, f)));
  }
  return out;
}
const titleOf = f => path.basename(f).replace(/\.md$/, "").replace(/^\d\d-/, "").replace(/^(\d{4})_/, "$1");
function bandOf(id, title) {
  if (id === "1043") return "未实装";                      // CardCharacter 无此行，不归入「后续追加」
  if (/^夏日/.test(title)) return "夏日系列";
  if (/^(梦魇|圣羽|净界)/.test(title) || title.includes("·")) return "特殊形态";
  return +id <= 1042 ? "初版角色" : "后续追加";
}
/* 头像按约定路径找，找不到再试好感立绘位（包内只有 body 或 haogan 之一很常见），两边都没就 null */
function heroThumb(id) {
  const cand = ["media/thumb/source_avatar/hero/body_" + id + "_body_" + id + ".png",
                "media/thumb/source_avatar/haogan/haogan_" + id + "_haogan_" + id + ".png"];
  return cand.find(exists) || null;
}
function classify(file) {
  const parts = file.split("/");                       // pages/...
  if (file === "pages/主页.md") return { id: "", title: "主页", sub: "主页", cat: "", thumb: null };
  if (parts[1] === "角色") {
    const m = /^(\d{4})_(.+)$/.exec(path.basename(file, ".md"));
    if (!m) return null;
    const thumb = heroThumb(m[1]);
    return { id: m[1], title: m[2], sub: "角色", cat: bandOf(m[1], m[2]), thumb: thumb };
  }
  if (parts[1] === "归档") {
    const cat = parts[2] || "归档";
    return { id: "", title: titleOf(file), sub: "归档", cat: cat, thumb: null };
  }
  return { id: "", title: path.basename(file, ".md"), sub: "汇总", cat: "", thumb: null };
}
const entries = [];
walkMd(path.join(WEB, "pages"), []).forEach(file => {
  const c = classify(file);
  if (c) entries.push(Object.assign({ file: file, words: 0, doc: "" }, c));
});
const rank = s => (s === "主页" ? -1 : s === "汇总" ? 0 : s === "角色" ? 1 : s === "归档" ? 2 : 3);
entries.sort((a, b) => rank(a.sub) - rank(b.sub) || (a.cat > b.cat ? 1 : a.cat < b.cat ? -1 : 0) ||
  (Number(a.id || 0) - Number(b.id || 0)) || (a.file > b.file ? 1 : -1));

/* ---------- 2) 重名校验 + docs 包装 ---------- */
const baseNames = entries.map(e => path.basename(e.file));
const dupes = [...new Set(baseNames.filter((f, i) => baseNames.indexOf(f) !== i))];
function wrap(e) {
  const body = fs.readFileSync(path.join(WEB, e.file), "utf8");
  e.doc = "docs/" + path.basename(e.file) + ".js";
  e.words = body.length;
  if (CHECK) return;
  let lit = JSON.stringify(body).split("</").join("<" + SL + "/").split("\u2028").join(SL + "u2028").split("\u2029").join(SL + "u2029");
  fs.mkdirSync(path.join(WEB, "docs"), { recursive: true });
  fs.writeFileSync(path.join(WEB, e.doc), "/* " + e.file + " 的原样包装，由 tools/pages_build.js 生成；" +
    "文案唯一来源是 pages 下的 md，要改正文改 md，不要改本文件。 */\n" +
    "window.DB_DOC=window.DB_DOC||{};window.DB_DOC[" + JSON.stringify(e.file) + "]=" + lit + ";\n");
}
entries.forEach(wrap);

const keep = new Set(entries.map(e => e.doc));
const orphans = fs.existsSync(path.join(WEB, "docs"))
  ? fs.readdirSync(path.join(WEB, "docs")).filter(f => f.endsWith(".md.js") && !keep.has("docs/" + f)) : [];
if (!CHECK) orphans.forEach(f => fs.unlinkSync(path.join(WEB, "docs", f)));
if (!CHECK) {
  /* 清单用 tools/data_pretty.js 的同一套排版产出（一条一行 + 文件头注释），
   * 否则下次构建又会把 data/pagelist.js 压回一整行。 */
  const pretty = require("./data_pretty.js");
  const raw = "window.DB_PAGES=" + JSON.stringify(entries) + ";";
  fs.writeFileSync(path.join(WEB, "data/pagelist.js"),
    pretty.headerFor("data/pagelist.js") + pretty.reformat(raw).replace(/\s+$/, "") + String.fromCharCode(10));
}

/* ---------- 3) 自检 ----------
 * 路径一律按【站点根】解析：正文被注入 网页版/index.html，浏览器解析相对路径的基准是 index.html 所在目录，
 * 不是 md 文件所在目录；md 里出现 ../ 前缀就是错的，直接报问题。 */
const badRefs = new Map();
entries.forEach(e => {
  const t = fs.readFileSync(path.join(WEB, e.file), "utf8");
  const add = raw => {
    const ref = norm(String(raw || ""));
    if (!ref || /^(https?:|data:|#|mailto:)/i.test(ref)) return;
    if (ref.startsWith("..")) { record("[../ 前缀] " + ref, e.file); return; }
    if (!/^(media|pages|docs|data)\//.test(ref)) return;
    if (!exists(ref)) record(ref, e.file);
  };
  const record = (rel, from) => { if (!badRefs.has(rel)) badRefs.set(rel, new Set()); badRefs.get(rel).add(from); };
  for (const m of t.matchAll(/(?:src|href)="([^"]+)"/g)) add(m[1]);
  for (const m of t.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) add(m[1]);
});
const noThumb = entries.filter(e => e.sub === "角色" && !e.thumb).length;
const missBody = entries.filter(e => !exists(e.file)).length;
const missDoc = CHECK ? 0 : entries.filter(e => !exists(e.doc)).length;
const subCount = s => entries.filter(e => e.sub === s).length;
const catCount = new Set(entries.map(e => e.sub + "/" + e.cat)).size;

const out = {
  check: CHECK, 条目: entries.length, 主页: subCount("主页"), 汇总: subCount("汇总"), 角色: subCount("角色"), 归档: subCount("归档"),
  分组数: catCount, 正文字符合计: entries.reduce((s, e) => s + e.words, 0),
  docs包装: entries.length, 清掉孤儿包装: orphans.length,
  问题: { md重名: dupes.length, 缺正文: missBody, 缺包装: missDoc, 无头像角色: noThumb, 指向不存在的素材: badRefs.size },
};
if (AS_JSON) console.log(JSON.stringify(out, null, 1));
else {
  console.log("构建" + (CHECK ? "检查" : "完成") + "：" + out.条目 + " 条（主页 " + out.主页 + " / 汇总 " + out.汇总 +
    " / 角色 " + out.角色 + " / 归档 " + out.归档 + "）｜分组 " + out.分组数 + " 个｜正文字符 " + out.正文字符合计.toLocaleString("zh") +
    "｜docs " + out.docs包装 + " 份，清掉孤儿 " + out.清掉孤儿包装 + " 份");
  console.log("自检：md 重名 " + dupes.length + "｜缺正文 " + missBody + "｜缺包装 " + missDoc +
    "｜无头像角色 " + noThumb + "｜指向但不存在的素材 " + badRefs.size + " 个");
  [...badRefs].slice(0, 8).forEach(([rel, from]) => console.log("   " + rel + "   ← " + [...from].slice(0, 2).join(", ")));
  if (dupes.length) console.log("   重名：" + dupes.join("、"));
  if (dupes.length) process.exitCode = 1;
}
