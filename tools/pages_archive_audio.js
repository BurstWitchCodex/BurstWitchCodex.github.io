#!/usr/bin/env node
/* 爆裂魔女 · pages 归档音频搬运器
 *
 * 把归档正文点对到的声音，按「事件末段 == 已解包 bank 目录名」这条可核对的规则，
 * 从 _export/4.5全量提取/音频/单条音效/source_sound/fmodasset/<bank>/ 复制进
 *   网页版/pages/归档/<分类>/音频/<组名>/
 * 不写清单 csv（按要求不留）：命中与 missing/skipped 的事件名只在终端打印前几条。
 *
 * 用法：
 *   node 网页版/tools/pages_archive_audio.js --dry bgm_level bgm_music sfx_enemy sfx_item
 *   node 网页版/tools/pages_archive_audio.js        bgm_level bgm_music sfx_enemy sfx_item --max-mb 200
 *
 * 口径（重要）：只认两条能核对的规则，其余一律 missing（不拿近似名顶替）：
 *   1) 事件末段与 fmodasset 下某个 bank 目录同名，且该目录只有 1–2 个音频文件；
 *   2) 事件末段与某个样本文件名（去掉开头的 bank 序号）完全一致。
 *   FMOD 的 bank→event 是多对多（如 bank「Battle」一个目录就装了 978 个混合样本），
 *   不能用“路径中某一段与目录同名”反推，否则一个 event:/Music/xxx 就会把整库拖进来。
 *   - Element.behitSound_id / dieSound_id 是 BattleVoice 表的 id，先查表拿到中配事件再走上面的规则。
 *   - 角色配音（event:/GameEffect/WitchSound/*，约 1.8 GB）不在这里复制：
 *     网页版/media/sound 已经有一份，重复拷一遍没有意义，需要时按 event 名回查。
 */
const fs = require("fs");
const path = require("path");

const WEB = path.resolve(__dirname, "..");
const ROOT = path.resolve(WEB, "..");
const SND = path.join(ROOT, "_export/4.5全量提取/音频/单条音效/source_sound/fmodasset");
const DST = path.join(WEB, "pages/归档");
const TBL = path.join(WEB, "data/t");
const BVCSV = path.join(ROOT, "_export/4.5全量提取/文案与配置表/source_gameconfig/BattleVoice.csv");

const DEF = {
  /* BGM 两个源呷呷（MapLevel 与 MusicBook）指向同一批曲目，统一落在 07，不两边各拷一份 */
  bgm_level: { cat: "07_玩法模式", sub: "音频/关卡与乐曲BGM" },
  bgm_music: { cat: "07_玩法模式", sub: "音频/关卡与乐曲BGM" },
  sfx_enemy: { cat: "06_敌人与Boss", sub: "音频/敌人音效" },
  sfx_item: { cat: "04_道具与装备", sub: "音频/道具音效" },
};

/* ---------- 数据表 ---------- */
const cache = Object.create(null);
function table(name) {
  if (cache[name]) return cache[name];
  const f = fs.readdirSync(TBL).find(x => x.toLowerCase() === name.toLowerCase() + ".js");
  if (!f) throw new Error("没有这张表：" + name);
  const w = {}; const orig = global.window; global.window = w;
  eval(fs.readFileSync(path.join(TBL, f), "utf8"));
  global.window = orig;
  const t = w.DB_TABLES[name] || Object.values(w.DB_TABLES)[0];
  cache[name] = (t.rows || []).map(r => Object.fromEntries(t.fields.map((k, i) => [k, r[i]])));
  return cache[name];
}
const S = v => (v === undefined || v === null ? "" : String(v).trim());

let bvMap = null;
function battleVoice() {                     // id -> 中配事件
  if (bvMap) return bvMap;
  bvMap = new Map();
  fs.readFileSync(BVCSV, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).slice(3).forEach(l => {
    const a = l.split(",");
    if (a.length >= 2 && a[0] && /^\d+$/.test(a[0]) && a[1] && a[1] !== "-1") bvMap.set(a[0], a[1]);
  });
  return bvMap;
}

let dirs = null, nmap = null, stemIdx = null;
const norm = s => String(s).toLowerCase().replace(/[\s_\-—.·]+/g, "");
function bankList() {
  if (dirs) return dirs;
  dirs = new Set(fs.readdirSync(SND));
  nmap = new Map();
  stemIdx = new Map();                     // 样本名（去掉开头序号）归一化 -> 相对路径
  for (const d of dirs) {
    const k = norm(d); if (!nmap.has(k)) nmap.set(k, d);
    let fl; try { fl = fs.readdirSync(path.join(SND, d)); } catch (e) { continue; }
    for (const f of fl) {
      if (!/\.(wav|mp3|ogg)$/i.test(f)) continue;
      const stem = f.replace(/\.(wav|mp3|ogg)$/i, "").replace(/^\d+_?/, "");
      const kk = norm(stem);
      if (!stemIdx.has(kk)) stemIdx.set(kk, []);
      stemIdx.get(kk).push(d + "/" + f);
    }
  }
  return dirs;
}
/**
 * event -> {files:[{dir,name,bytes}], how} ，只承认两条可核对的规则：
 *   1) 事件末段与 bank 目录同名，呿该目录只有一两个音频文件（WitchSound/MusicBook 这类一事件一库）；
 *   2) 事件末段与某样本文件名完全一致（去开头序号后的归一化名）。
 * 其余一律 missing，不用“名字包含”“相邻目录”凑数。
 */
function resolveEvent(ev) {
  const e = S(ev);
  if (!e || e === "-1" || e.indexOf("event:") !== 0) return { ev: e, hit: null };
  bankList();
  const last = decodeURIComponent(e.replace(/^event:/, "").split("/").filter(Boolean).pop());
  let cand = null, how = "";
  if (dirs.has(last)) {
    const abs = path.join(SND, last);
    const fl = fs.readdirSync(abs).filter(f => /\.(wav|mp3|ogg)$/i.test(f));
    if (fl.length && fl.length <= 2) { cand = fl.map(f => ({ dir: last, name: f })); how = "bank目录同名"; }
  }
  if (!cand) {
    const k = norm(last);
    if (stemIdx.has(k)) { cand = stemIdx.get(k).slice(0, 3).map(p => ({ dir: p.split("/")[0], name: p.split("/").slice(1).join("/") })); how = "样本名精确"; }
  }
  if (!cand) return { ev: e, hit: null };
  const files = cand.map(c => {
    const abs = path.join(SND, c.dir, c.name);
    return { dir: c.dir, name: c.name, bytes: bytesOf(abs) };
  });
  return { ev: e, hit: { files, how } };
}
function bytesOf(p) { try { return fs.statSync(p).size; } catch (e) { return 0; } }

/* ---------- 收集事件 ---------- */
function events(group) {
  const out = [];               // {src, id, label, ev}
  const add = (src, id, label, ev) => { const e = S(ev); if (e && e !== "-1") out.push({ src, id, label: S(label), ev: e }); };

  if (group === "bgm_level") {
    table("MapLevel").forEach(r => add("MapLevel", r.id, r.LevelName, r.LevelBGMFmodPath || r.LevelBGM));
  } else if (group === "bgm_music") {
    table("MusicBook").forEach(r => add("MusicBook", r.id, r.Name2 || r.Name, r.MusicalBGM));
  } else if (group === "sfx_item") {
    table("item").forEach(r => add("item", r.id, r.Name, r.fmodpath));
    table("Equip").forEach(r => add("Equip", r.id, r.Name, r.fmodpath));
  } else if (group === "sfx_enemy") {
    const bv = battleVoice();
    ["Element", "Element_new"].forEach(t => table(t).forEach(r => {
      add(t + ".enterSound", r.id, r.Name, r.enterSound);
      add(t + ".CritBehitSound", r.id, r.Name, r.CritBehitSound);
      add(t + ".behitSound", r.id, r.Name, r.behitSound);
      add(t + ".dieSound", r.id, r.Name, r.dieSound);
      [r.behitSound_id, r.dieSound_id].forEach((id, k) => {
        const s = S(id);
        if (s && /^\d+$/.test(s) && bv.has(s)) add(t + (k ? ".dieSound_id" : ".behitSound_id"), r.id, r.Name, bv.get(s));
      });
    }));
  } else throw new Error("未知组：" + group);

  const seen = new Set();
  return out.filter(o => (seen.has(o.ev) ? false : (seen.add(o.ev), true)));
}

/* ---------- 复制 ---------- */
const argv = process.argv.slice(2);
const APPLY = argv.indexOf("--dry") < 0;
const mi = argv.indexOf("--max-mb");
const MAXMB = mi < 0 ? 150 : Number(argv[mi + 1]);
const cut = mi < 0 ? argv : argv.filter((a, i) => i < mi || i > mi + 1);
const groups = cut.filter(a => a !== "--dry");
const COPIED = new Set();                 // 全局去重：同一个样本只拷一份

for (const g of groups) {
  const def = DEF[g];
  if (!def) { console.log(g + "：未知组，可选 " + Object.keys(DEF).join("|")); continue; }
  const list = events(g);
  let files = 0, size = 0, hitN = 0, miss = 0, skip = 0;
  const dest = path.join(DST, def.cat, def.sub);
  const missEv = [], skipEv = [];
  for (const o of list) {
    const r = resolveEvent(o.ev);
    if (!r.hit) { miss++; if (missEv.length < 6) missEv.push(o.ev); continue; }
    const fresh = r.hit.files.filter(f => !COPIED.has(f.dir + "/" + f.name));
    const freshBytes = fresh.reduce((s, f) => s + f.bytes, 0);
    if (size + freshBytes > MAXMB * 1048576) { skip++; if (skipEv.length < 4) skipEv.push(o.ev); continue; }
    hitN++;
    if (APPLY) fs.mkdirSync(dest, { recursive: true });
    for (const f of fresh) {
      if (APPLY) fs.copyFileSync(path.join(SND, f.dir + "/" + f.name), path.join(dest, f.name));
      COPIED.add(f.dir + "/" + f.name); files++; size += f.bytes;
    }
  }
  console.log(JSON.stringify({
    组: g, 分类: def.cat, 事件去重: list.length, 命中: hitN, 映射不确定: miss,
    因体积上限跳过: skip, 本次新复制文件: APPLY ? files : "（dry，估算 " + files + "）",
    体积MB: +(size / 1048576).toFixed(1), 上限: "--max-mb " + MAXMB, dry: !APPLY,
    未命中事件样例: missEv, 超限跳过样例: skipEv,
  }));
}
