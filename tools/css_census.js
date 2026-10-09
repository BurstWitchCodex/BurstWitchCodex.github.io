#!/usr/bin/env node
/* 爆裂魔女 · CSS 类名实渲染普查
 *
 * 不用浏览器、不靠字符串猜：直接跑 网页版/js/viewer.js 自己的 md2html()，把 75 篇正文全部渲染一遍，
 * 从产出的 HTML 里取 class；再补上 viewer.js 里 el(tag,"cls") 与模板串里写死的类名、index.html 的类名。
 * 输出一份「app.css 每条规则 → 在用 / 未用」的判定表。
 *
 * 用法：node 网页版/tools/css_census.js          # 打印判定
 *       node 网页版/tools/css_census.js --json   # 机器可读
 */
const fs = require("fs"), path = require("path"), vm = require("vm");
const WEB = path.resolve(__dirname, "..");
const AS_JSON = process.argv.indexOf("--json") >= 0;

/* 1) 载入 viewer.js，拿到它导出的 md2html */
const stub = {
  createElement: () => ({ style: {}, classList: { add() { } }, appendChild() { }, addEventListener() { }, setAttribute() { } }),
  createDocumentFragment: () => ({ appendChild() { } }),
  createTextNode: t => ({ nodeValue: t }),
  getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
  addEventListener() { }, documentElement: {}, head: { appendChild() { } }, body: { appendChild() { } },
  readyState: "loading", createTreeWalker: () => ({ nextNode: () => null }),
};
const ctx = vm.createContext({ window: { DB_PAGES: [] }, document: stub, location: { hash: "" },
  console, setTimeout, Promise, Object, Array, String, Number, Math, RegExp, JSON, Error, NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 } });
ctx.global = ctx;
vm.runInContext(fs.readFileSync(path.join(WEB, "js/viewer.js"), "utf8"), ctx);
const md2html = ctx.window.VIEWER_MD && ctx.window.VIEWER_MD.md2html;
if (!md2html) { console.error("拿不到 window.VIEWER_MD.md2html"); process.exit(1); }

/* 2) 渲染全部正文，收集产出的 class */
const used = new Map();                       // class -> 出现次数
const bump = (c) => used.set(c, (used.get(c) || 0) + 1);
const takeFromHtml = (html) => {
  for (const m of String(html).matchAll(/class="([^"]*)"/g))
    m[1].split(/\s+/).filter(Boolean).forEach(c => bump(c));
};
let files = 0;
/* pagelist.js 现在带文件头注释且一条一行，所以取第一个 [ 到最后一个 ] 的区间，不再靠 ^window.DB_PAGES= 前缀 */
const PL_TEXT = fs.readFileSync(path.join(WEB, "data/pagelist.js"), "utf8");
const P = JSON.parse(PL_TEXT.slice(PL_TEXT.indexOf("["), PL_TEXT.lastIndexOf("]") + 1));
P.forEach(p => {
  const body = fs.readFileSync(path.join(WEB, p.file), "utf8");
  takeFromHtml(md2html(body).html);
  files++;
});

/* 3) viewer.js 自己拼的类名：el(tag,"cls")、模板里的 class="…"、以及 fold(cls, headCls, …) 的实参。
     类名现在常通过变量传入，只看 el() 会把在用样式误判成死规则，所以再加一条宽松兼容：
     viewer.js 里任何“类名形状”的字符串字面量也算在用（宁可少报死规则，不能误删样式）。 */
const vsrc = fs.readFileSync(path.join(WEB, "js/viewer.js"), "utf8");
for (const m of vsrc.matchAll(/el\(\s*"[a-zA-Z]+"\s*,\s*"([^"]*)"/g)) m[1].split(/\s+/).filter(Boolean).forEach(c => bump(c, "viewer.js el()"));
for (const m of vsrc.matchAll(/fold\(\s*"([^"]*)"\s*,\s*"([^"]*)"/g)) [m[1], m[2]].forEach(s => String(s).split(/\s+/).filter(Boolean).forEach(c => bump(c, "viewer.js fold()")));
for (const m of vsrc.matchAll(/class="([^"]*)"/g)) m[1].split(/\s+/).filter(Boolean).forEach(c => bump(c, "viewer.js 模板"));
for (const m of vsrc.matchAll(/"([a-z][a-z0-9]*(?:-[a-z0-9]+)*)"/g)) { if (m[1].length <= 18) bump(m[1], "viewer.js 字面量"); }
/* 4) index.html 的类名 */
const html = fs.readFileSync(path.join(WEB, "index.html"), "utf8");
for (const m of html.matchAll(/class="([^"]*)"/g)) m[1].split(/\s+/).filter(Boolean).forEach(c => bump(c, "index.html"));
/* 5) 运行时动态拼的类（"hit"/"now"/"on"/"miss" 这类），从源码里按字符串字面量挑出来 */
["hit", "now", "on", "miss", "none", "md-list", "load", "empty", "inner"].forEach(c => {
  if (new RegExp("[\"'` ]" + c + "[\"'` ]").test(vsrc)) bump(c, "viewer.js 动态类名");
});

/* 6) 与 app.css 对表 */
const css = fs.readFileSync(path.join(WEB, "css/app.css"), "utf8");
const rules = [];
const re = /([^{}]+)\{([^{}]*)\}/g; let m;
while ((m = re.exec(css))) {
  let sel = m[1].replace(/\/\*[\s\S]*?\*\//g, "").trim().replace(/\s+/g, " ");
  if (!sel || /^@/.test(sel)) continue;
  const names = [...new Set([...sel.matchAll(/\.([A-Za-z][\w-]*)/g)].map(x => x[1]))];
  const ids = [...new Set([...sel.matchAll(/#([\w-]+)/g)].map(x => x[1]))];
  const okTagOnly = !names.length && !ids.length;
  const hit = okTagOnly || names.some(c => used.has(c)) || ids.some(i => html.includes('id="' + i + '"'));
  rules.push({ sel, 声明: m[2].trim().length, 类: names, 判定: hit ? "在用" : "未用" });
}
const dead = rules.filter(r => r.判定 === "未用");
if (AS_JSON) { console.log(JSON.stringify({ 渲染篇数: files, 实渲染类名数: used.size, 规则: rules }, null, 1)); }
else {
  console.log("渲染了 " + files + " 篇正文，产出 + 代码内类名共 " + used.size + " 个");
  console.log("app.css " + rules.length + " 条规则：在用 " + (rules.length - dead.length) + "，未用 " + dead.length +
    "（未用规则声明体合计 " + dead.reduce((s, r) => s + r.声明, 0) + " 字节）");
  console.log("\n【实渲染证明未用】");
  dead.forEach(r => console.log("  " + r.sel.padEnd(28).slice(0, 28) + "  声明 " + r.声明 + "B   类名：" + r.类.join(",")));
  const names = [...used.keys()].sort();
  console.log("\n【在用类名清单】\n  " + names.join(" "));
  const orphan = names.filter(c => !rules.some(r => r.类.includes(c)));
  console.log("\n【渲染用到但 app.css 里没有对应规则】（不是问题，只是无样式）：" + (orphan.join(" ") || "无"));
}
