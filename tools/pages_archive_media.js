#!/usr/bin/env node
/* 爆裂魔女 · pages 归档搬运器
 *
 * 把「文案归档」正文里点到的条目，与其在解包结果里对应的图片/音频，按分类复制进
 *   网页版/pages/归档/<NN_分类>/图片/（或 音频/）
 * 不写清单 csv（按要求不留）：命中/缺失只在终端打印，缺失项给前 6 条引用名。
 *
 * 用法：
 *   node 网页版/tools/pages_archive_media.js --dry   items      # 只统计，不复制
 *   node 网页版/tools/pages_archive_media.js        items      # 复制
 *   stage: items | enemy | pets | maps | bgm
 *
 * 说明：
 *   - 图片一律从 _export/4.5全量提取/图片 原样复制（不裁边、不转码），保持与解包一致；
 *     网页版/media 里那份是 web_media.py 裁切过的展示图，两处不是同一批文件。
 *   - 命中规则来自解包命名约定：配置引用 source_x/y/z 对应 图片/source_x/y/<z>_<z>.png，
 *     图集分块再附 <z>_<z>_1.png。找不到就记 missing，不猜、不用近似图顶替。
 */
const fs = require("fs");
const path = require("path");

const WEB = path.resolve(__dirname, "..");
const ROOT = path.resolve(WEB, "..");
const IMG_SRC = path.join(ROOT, "_export/4.5全量提取/图片");
const SND_SRC = path.join(ROOT, "_export/4.5全量提取/音频/单条音效/source_sound/fmodasset");
const DST = path.join(WEB, "pages/归档");
const TBL = path.join(WEB, "data/t");


/* ---------- 数据表 ---------- */
const tableCache = Object.create(null);
function table(name) {
  if (tableCache[name]) return tableCache[name];
  const files = fs.readdirSync(TBL);
  const f = files.find(x => x.toLowerCase() === name.toLowerCase() + ".js");
  if (!f) throw new Error("没有这张表：" + name);
  const w = {};
  const orig = global.window;
  global.window = w;
  eval(fs.readFileSync(path.join(TBL, f), "utf8"));
  const t = w.DB_TABLES[name] || Object.values(w.DB_TABLES)[0];
  global.window = orig;
  const F = t.fields;
  tableCache[name] = {
    name,
    fields: F,
    rows: (t.rows || []).map(r => {
      const o = { __i: [] };
      F.forEach((k, i) => (o[k] = r[i], o.__i.push(r[i])));
      return o;
    }),
  };
  return tableCache[name];
}
const S = v => (v === undefined || v === null ? "" : String(v).trim());

/* ---------- 图片索引（一次扫描，按目录分组） ---------- */
let imgIndex = null;
function images() {
  if (imgIndex) return imgIndex;
  const idx = new Map(); // 相对目录(小写) -> [文件名]
  const walk = rel => {
    const abs = rel ? path.join(IMG_SRC, rel) : IMG_SRC;
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch (e) { return; }
    const dirFiles = [];
    for (const e of ents) {
      if (e.isDirectory()) walk(rel ? rel + "/" + e.name : e.name);
      else if (/\.(png|jpg|jpeg|webp)$/i.test(e.name)) dirFiles.push(e.name);
    }
    if (dirFiles.length) idx.set(rel.toLowerCase(), dirFiles.sort());
  };
  walk("");
  imgIndex = idx;
  return idx;
}

/** 配置引用 -> 实际文件名数组（含 _1 分块页） */
function resolveImg(ref) {
  const r = S(ref).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!r || r === "-1" || r === "0") return { ref: r, hit: [], miss: true };
  const i = r.lastIndexOf("/");
  if (i < 0) return { ref: r, hit: [], miss: true };
  const dir = r.slice(0, i).toLowerCase(), stem = r.slice(i + 1);
  const files = images().get(dir);
  if (!files) return { ref: r, dir: r.slice(0, i), hit: [], miss: true };
  const low = stem.toLowerCase();
  const want = [low + "_" + low, low, low + "_" + low + "_1", low + "_1"];
  const found = [];
  for (const w of want) {
    const f = files.find(x => x.toLowerCase().replace(/\.[a-z]+$/i, "") === w);
    if (f && found.indexOf(f) < 0) found.push(f);
  }
  if (!found.length) {                       // 退化：目录里以 stem_ 开头的第一个
    const f = files.find(x => new RegExp("^" + low.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "_", "i").test(x));
    if (f) found.push(f);
  }
  return { ref: r, dir: r.slice(0, i), hit: found, miss: !found.length };
}

/* ---------- 复制 ---------- */
const bytes = p => { try { return fs.statSync(p).size; } catch (e) { return 0; } };
const mb = n => (n / 1048576).toFixed(1) + " MB";
function ensure(d) { fs.mkdirSync(d, { recursive: true }); }

function planCopy(def, entries) {
  const dest = path.join(DST, def.cat, def.sub);
  ensure(dest);
  let n = 0, size = 0, miss = 0;
  const seen = new Set(), missRef = [];
  for (const e of entries) {
    if (!e.files.length) { miss++; if (missRef.length < 6) missRef.push(e.ref); continue; }
    for (const f of e.files) {
      const rel = f.dir + "/" + f.name;
      if (seen.has(rel)) continue;
      const srcAbs = path.join(IMG_SRC, f.dir, f.name);
      if (!fs.existsSync(srcAbs)) continue;
      if (APPLY) { ensure(dest); fs.copyFileSync(srcAbs, path.join(dest, f.name)); }
      seen.add(rel); n++; size += bytes(srcAbs);
    }
  }
  return { dest: path.relative(ROOT, dest), 复制文件: n, 体积: mb(size), 未命中条目: miss, 未命中样例: missRef };
}

function mkLine(row, table) {
  return (file, st, b) => [table, row.id, (row.Name || row.name || "").slice(0, 40).replace(/"/g, "'"),
    file === "（未解包）" ? "" : "", file, st, b].join(",");
}

/* ---------- 各类条目 ---------- */
function collect(sub) {
  const out = [];
  const push = (tbl, row, ref) => {
    const r = resolveImg(ref);
    out.push({
      key: String(row.id), label: S(row.Name || row.name), ref: r.ref,
      files: r.hit.map(n => ({ dir: r.dir, name: n })),
      line(file, st, b) {
        const esc = s => '"' + String(s).replace(/"/g, "'") + '"';
        return [tbl, esc(row.id), esc(S(row.Name || row.name).slice(0, 60)), esc(r.ref), esc(file), st, b].join(",");
      },
    });
  };

  if (sub === "items") {
    table("item").rows.forEach(r => { if (S(r.itemPath)) push("item", r, "source_icon/item/" + S(r.itemPath)); });
    table("treasure").rows.forEach(r => { if (S(r.icon_route)) push("treasure", r, r.icon_route); });
    table("DoveCardEquip").rows.forEach(r => { if (S(r.Icon)) push("DoveCardEquip", r, r.Icon); });
  } else if (sub === "enemy") {
    const seen = new Set();
    ["Element", "Element_new"].forEach(t => table(t).rows.forEach(r => {
      [r.Avatar, r.BodyAvatar].forEach(a => {
        const s = S(a);
        if (!s || s === "-1" || seen.has(s)) return;
        seen.add(s);
        push(t, { id: r.id, Name: S(r.Name) }, s);
      });
    }));
    table("MidNightBoss").rows.forEach(r => { if (S(r.avatar)) push("MidNightBoss", { id: r.boss_id, Name: r.des }, r.avatar); });
  } else if (sub === "pets") {
    table("Pets").rows.forEach(r => {
      const id = S(r.avatarPets) || S(r.itemPath);
      if (id) push("Pets", r, "source_avatar/pets/petbody_" + id);
    });
    table("BuildDot").rows.forEach(r => { if (S(r.icon)) push("BuildDot", r, "source_icon/build/" + S(r.icon)); });
  } else if (sub === "maps") {
    const seen = new Set();
    table("DungeonMap").rows.forEach(r => {
      const s = S(r.MapImage);
      if (!s || seen.has(s)) return; seen.add(s);
      push("DungeonMap", { id: r.id, Name: S(r.MapName) }, s);
    });
  } else if (sub === "setting") {
    const seen = new Set();
    table("LoadingPicture").rows.forEach(r => {
      const s = S(r.Picture);
      if (!s || seen.has(s)) return; seen.add(s);
      push("LoadingPicture", { id: r.id, Name: S(r.Name) }, s);
    });
  }
  return out;
}

const argv = process.argv.slice(2);
const APPLY = argv.indexOf("--dry") < 0;
const stages = argv.filter(a => a !== "--dry");
const DEF = {
  items: { stage: "items", cat: "04_道具与装备", sub: "图片/道具图标" },
  enemy: { stage: "enemy", cat: "06_敌人与Boss", sub: "图片/敌人立绘" },
  pets: { stage: "pets", cat: "05_宠物与召唤物", sub: "图片/宠物与召唤物" },
  maps: { stage: "maps", cat: "03_关卡与任务", sub: "图片/章节地图" },
  setting: { stage: "setting", cat: "02_世界观与设定", sub: "图片/加载图" },
};

if (!stages.length) { console.error("给个 stage：" + Object.keys(DEF).join("|")); process.exit(2); }
for (const s of stages) {
  const def = DEF[s];
  if (!def) { console.log(s + "：未知 stage"); continue; }
  const entries = collect(s);
  const hitN = entries.filter(e => e.files.length).length;
  console.log(JSON.stringify({
    stage: s, 分类: def.cat, 条目: entries.length, 命中: hitN, 缺失: entries.length - hitN,
    dry: !APPLY, ...(APPLY ? planCopy(def, entries) : { 将复制到: path.relative(ROOT, path.join(DST, def.cat, def.sub)) }),
  }));
}
