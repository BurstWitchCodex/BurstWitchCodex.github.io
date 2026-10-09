#!/usr/bin/env node
/* 爆裂魔女 · data/*.js 排版器
 *
 * 干什么：把 data/ 与 data/t/ 下的 window.DB_* 数据文件从「一整行」排成「一条一行 + 文件头注释」。
 * 硬约束：只改空白与换行，不改任何值。做法是保序递归下降解析 JSON 值：
 *        数字与 true/false/null 原样保留源码文本；字符串按值重编码（中文保持原生 UTF-8，不转义成 uXXXX）；
 *        对象键与数组元素的顺序原样保留。写完用 --check 逐 token 比对排版前后，证明等价。
 *
 * 幂等：文件头注释每次按同一样式重写；顶层扫描会跳过块注释与行注释，
 *      所以对自己产出的文件再跑一遍是 0 改动。
 *
 * 用法：node tools/data_pretty.js            重排 data/*.js 与 data/t/*.js
 *       node tools/data_pretty.js --dry      只报告，不写盘
 *       node tools/data_pretty.js --check    校验「排版前后逐 token 等价」，不写盘
 *       node tools/data_pretty.js data/voices.js   只处理指定文件（可给多个）
 *
 * 谁在读这些文件：index.html → js/viewer.js 只读 data/pagelist.js（script 标签，注释无影响）；
 * tools/pages_archive_audio.js 与 pages_archive_media.js 用 eval 读 data/t/*.js（注释无影响）；
 * tools/css_census.js 与 tools/site_move_unused.js 用文本方式解析 pagelist.js，已改成容忍文件头注释。
 */
const fs = require("fs"), path = require("path");
const WEB = path.resolve(__dirname, "..");
const NL = String.fromCharCode(10);
const ARGS = process.argv.slice(2);
const CHECK = ARGS.indexOf("--check") >= 0, DRY = ARGS.indexOf("--dry") >= 0;
const LIMIT = 118, IND = " ";
const SLASH = String.fromCharCode(47), STAR = String.fromCharCode(42), QUOTE = String.fromCharCode(34);
const LBRA = String.fromCharCode(91), RBRA = String.fromCharCode(93);
const MARK = "data_pretty";
const MARK_PREFIX = SLASH + STAR + " " + MARK;

/* ---------- 1) 保序解析 ---------- */
function skipWs(s, i) { while (i < s.length && /\s/.test(s[i])) i++; return i }
function scanString(s, i) {                       // i 指向起始引号，返回引号之后的位置
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === String.fromCharCode(92)) { j += 2; continue }
    if (s[j] === QUOTE) return j + 1;
    j++;
  }
  throw new Error("字符串没闭合（第 " + i + " 字符起）");
}
function parseValue(s, i) {
  i = skipWs(s, i);
  const c = s[i];
  if (c === "{" || c === LBRA) return parseContainer(s, i, c);
  if (c === QUOTE) { const e = scanString(s, i); return { node: { t: "str", val: JSON.parse(s.slice(i, e)) }, end: e } }
  const m = /^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(s.slice(i));
  if (!m) throw new Error("第 " + i + " 字符处不是合法 JSON 值：" + JSON.stringify(s.slice(i, i + 30)));
  return { node: { t: "lit", raw: m[0] }, end: i + m[0].length };
}
function parseContainer(s, i, open) {
  const close = open === "{" ? "}" : RBRA;
  const node = open === "{" ? { t: "obj", items: [] } : { t: "arr", items: [] };
  let j = i + 1;
  for (;;) {
    j = skipWs(s, j);
    if (s[j] === close) return { node, end: j + 1 };
    if (open === "{") {
      if (s[j] !== QUOTE) throw new Error("对象键必须是带引号的字符串，第 " + j + " 字符");
      const e = scanString(s, j);
      const key = { t: "str", val: JSON.parse(s.slice(j, e)) };
      j = skipWs(s, e);
      if (s[j] !== ":") throw new Error("键后面缺冒号，第 " + j + " 字符");
      const v = parseValue(s, j + 1);
      node.items.push([key, v.node]); j = v.end;
    } else {
      const v = parseValue(s, j); node.items.push(v.node); j = v.end;
    }
    j = skipWs(s, j);
    if (s[j] === ",") { j++; continue }
    if (s[j] === close) return { node, end: j + 1 };
    throw new Error("容器结构异常，第 " + j + " 字符：" + JSON.stringify(s.slice(j, j + 24)));
  }
}

/* ---------- 2) 排版输出 ---------- */
function text(node) {                              // 单行紧凑形式
  if (node.t === "str") return JSON.stringify(node.val);
  if (node.t === "lit") return node.raw;
  if (node.t === "arr") return LBRA + node.items.map(text).join(",") + RBRA;
  return "{" + node.items.map(kv => JSON.stringify(kv[0].val) + ":" + text(kv[1])).join(",") + "}";
}
function layout(node, depth) {
  const one = text(node);
  if (depth + one.length <= LIMIT) return one;
  const pad = IND.repeat(depth + 1);
  if (node.t === "arr") {
    if (!node.items.length) return LBRA + RBRA;
    /* 表行与记录列表（元素全是数组，或全是只含标量的对象）：一行一条记录，行内绝不换行，
     * 否则一字段一行既难读又胀体积（pagelist 与 data/t 的 rows 都是这种形状） */
    const flat = x => x.t === "arr" || (x.t === "obj" && x.items.length && x.items.every(kv => kv[1].t === "str" || kv[1].t === "lit"));
    if (node.items.every(flat)) {
      return LBRA + NL + node.items.map(x => pad + text(x)).join("," + NL) + NL + IND.repeat(depth) + RBRA;
    }
    return LBRA + NL + node.items.map(x => pad + layout(x, depth + 1)).join("," + NL) + NL + IND.repeat(depth) + RBRA;
  }
  if (node.t !== "obj") return one;
  if (!node.items.length) return "{}";
  return "{" + NL + node.items.map(kv => pad + JSON.stringify(kv[0].val) + ": " + layout(kv[1], depth + 1)).join("," + NL) + NL + IND.repeat(depth) + "}";
}

/* ---------- 3) 整文件重排：跳过注释与顶层字符串，只对 JSON 值排版 ---------- */
function reformat(body) {
  let out = "", i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === SLASH && body[i + 1] === STAR) { const e = body.indexOf(STAR + SLASH, i + 2); const stop = e < 0 ? body.length : e + 2; out += body.slice(i, stop); i = stop; continue }
    if (c === SLASH && body[i + 1] === SLASH) { const e = body.indexOf(NL, i); const stop = e < 0 ? body.length : e; out += body.slice(i, stop); i = stop; continue }
    if (c === QUOTE) { const e = scanString(body, i); out += body.slice(i, e); i = e; continue }
    if (c === "{" || c === LBRA) { const r = parseValue(body, i); out += layout(r.node, 0); i = r.end; continue }
    out += c; i++;
  }
  return out;
}

/* ---------- 4) 逐 token 规范化（等价校验用；数字按数值比，字符串按值比） ---------- */
function canon(node) {
  if (node.t === "str") return "S" + JSON.stringify(node.val);
  if (node.t === "lit") return "L" + (/^-?\d/.test(node.raw) ? String(Number(node.raw)) : node.raw);
  if (node.t === "arr") return LBRA + node.items.map(canon).join(",") + RBRA;
  return "{" + node.items.map(kv => canon(kv[0]) + ":" + canon(kv[1])).join(",") + "}";
}
function canonOf(src) {
  let out = "", i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === SLASH && src[i + 1] === STAR) { const e = src.indexOf(STAR + SLASH, i + 2); i = e < 0 ? src.length : e + 2; continue }
    if (c === SLASH && src[i + 1] === SLASH) { const e = src.indexOf(NL, i); i = e < 0 ? src.length : e; continue }
    if (/\s/.test(c)) { i++; continue }
    if (c === QUOTE) { const e = scanString(src, i); out += "T" + JSON.stringify(JSON.parse(src.slice(i, e))); i = e; continue }
    if (c === "{" || c === LBRA) { const r = parseValue(src, i); out += canon(r.node); i = r.end; continue }
    out += c; i++;
  }
  return out;
}

/* ---------- 5) 文件头注释 ---------- */
const LEGEND = {
  "data/pagelist.js": ["站点清单：每项指向一篇 pages 下的 md 与它的 docs 包装，侧栏与路由全靠它。",
    "字段：file=md 路径｜doc=包装路径｜id=角色编号（非角色为空串）｜title=侧栏标题｜sub=一级分组（主页/汇总/角色/归档）｜cat=二级分组｜thumb=头像路径或 null｜words=md 字符数",
    "生成者：tools/pages_build.js（每次构建整体重写，手改会被覆盖；要改文案改 pages 下的 md）"],
  "data/meta.js": ["抽取层的表清单：name=Lua 表名｜accessor=window.DB_TABLES 上的键名｜file=对应的 data/t 文件名｜其余为该表统计。",
    "生成者：tools/web_extract.py（跑完执行 node tools/data_pretty.js 恢复排版）"],
  "data/assets.js": ["素材定位表：map=解包内相对路径 → 站点 media 路径｜imageRoot=图片源目录。正文不读它，只有搬图脚本用。",
    "生成者：tools/web_extract.py"],
  "data/voices.js": ["语音定位表：banks=FMOD bank 名 → 样本文件列表｜map=语音键 → bank。只在核对「场景 ↔ 语音文件」结构时用。",
    "生成者：tools/web_extract.py"],
  "data/i18n_chs.js": ["多语言词条：外层键是语言码（chs/cht/en…），内层是「词条键 → 文本」。正文不再从这里取字——文案唯一来源是 pages 下的 md。",
    "生成者：tools/web_extract.py"],
  "data/report.js": ["抽取体检报告：解析成功/失败的表数、异常清单等。",
    "生成者：tools/web_extract.py"],
};
function legendFor(rel) {
  if (LEGEND[rel]) return LEGEND[rel];
  if (/^data\/t\//.test(rel)) return [
    "Lua 配置表 " + path.basename(rel, ".js") + " 的抽取结果：name/accessor/file 是表身份；fields 是字段名顺序；rows 是数据行，每行是按 fields 顺序排列的数组。",
    "读取方：tools/pages_archive_audio.js、tools/pages_archive_media.js（eval 载入 window.DB_TABLES）。",
    "生成者：tools/web_extract.py（跑完执行 node tools/data_pretty.js 恢复排版）"];
  return ["数据产物。"];
}
function headerFor(rel) {
  const lines = [" " + MARK + " · " + rel + " —— 工具生成的数据文件，请勿手改。",
    ...legendFor(rel),
    "版式由 tools/data_pretty.js 维护（只动空白不动值，可用 --check 复验）。"];
  return SLASH + STAR + lines.join(NL + " * ") + " " + STAR + SLASH + NL;
}

/* ---------- 6) 驱动 ---------- */
function targets() {
  const given = ARGS.filter(a => !a.startsWith("--")).map(a => a.split("\\").join("/"));
  if (given.length) return given;
  const out = [];
  for (const e of fs.readdirSync(path.join(WEB, "data"))) {
    const p = "data/" + e;
    if (fs.statSync(path.join(WEB, p)).isDirectory()) {
      for (const f of fs.readdirSync(path.join(WEB, p))) if (f.endsWith(".js")) out.push(p + "/" + f);
    } else if (e.endsWith(".js")) out.push(p);
  }
  return out.sort();
}
function runOnce() {
  let changed = 0, same = 0, bad = 0;
  const rows = [];
  const list = targets();
  for (const rel of list) {
    let src, want, abs;
    try {
      abs = path.join(WEB, rel);
      src = fs.readFileSync(abs, "utf8");
      let stripped = src;
      if (src.startsWith(MARK_PREFIX)) {                     // 去掉旧文件头再重建，保证幂等
        const e = src.indexOf(STAR + SLASH);
        stripped = src.slice(src.indexOf(NL, e) + 1);
      }
      want = headerFor(rel) + reformat(stripped).replace(/\s+$/, "") + NL;
      if (canonOf(src) !== canonOf(want)) { console.log("!! 逐 token 不等价，拒写：" + rel); bad++; continue }
    } catch (err) { console.log("!! 解析失败，跳过：" + rel + " —— " + err.message); bad++; continue }
    if (want === src) { same++; continue }
    changed++;
    rows.push({ rel, 前字节: src.length, 后字节: want.length, 前行: src.split(NL).length, 后行: want.split(NL).length });
    if (!CHECK && !DRY) fs.writeFileSync(abs, want);
  }
  const pad = (s, n) => String(s).padEnd(n);
  rows.slice(0, 12).forEach(r => console.log(" " + pad(r.rel, 24) + "行数 " + pad(r.前行, 5) + "→ " + pad(r.后行, 7) +
    "字节 " + (r.前字节 / 1024).toFixed(1) + "KB → " + (r.后字节 / 1024).toFixed(1) + "KB"));
  if (rows.length > 12) console.log(" （另有 " + (rows.length - 12) + " 个文件同类处理）");
  console.log((CHECK ? "校验" : DRY ? "预演" : "完成") + "：" + list.length + " 个文件｜需改动 " + changed +
    "｜已是要排版式 " + same + "｜等价性失败 " + bad);
  const t = rows.reduce((a, r) => a + r.后字节 - r.前字节, 0);
  if (rows.length) console.log("体积合计变化：" + (t / 1024).toFixed(1) + "KB");
  if (bad) process.exitCode = 1;
  return { changed, same, bad };
}

module.exports = { reformat, layout, parseValue, canonOf, headerFor, runOnce, MARK_PREFIX };
if (require.main === module) runOnce();
