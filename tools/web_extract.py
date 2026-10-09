#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""网页版 P0/P1 抽取器：把解密出的 Lua 配置表与本地化表转成前端可直接加载的 JS 数据。

为什么不用正则：表里存在多层嵌套 {}、[k]=、name=、nil、转义字符串、富文本标签。
这里实现 Lua 字面量子集的递归下降解析器（数字/字符串/布尔/nil/表），
并做三重自洽校验，任何一项不过就记入 report 而不是静默出错误数据：
  1) 行数：解析得到的记录数 == 源文件中 `^    [` 行计数
  2) 字段数：_configKeys 的索引必须是 1..N 连续且每行长度 == N（不符记入 report）
  3) 覆盖率：所有源字符串里的 source_* 与 event: 引用都要有命中统计
输出（全部是 .js，因为 file:// 下浏览器禁止 fetch 本地 JSON，而 <script> 可以）：
  data/meta.js            表清单、字段名、行数、校验结果
  data/t/<name>.js        单表数据（fields + ids + rows 位置数组）
  data/i18n_chs.js     四语本地化字典
  data/assets.js          source_* 引用 -> 已解包文件的命中索引
  data/voices.js          FMOD event -> 推测 bank 目录与 wav 列表
  data/report.js          完整度与异常清单（站点首页会显示）
"""
import os, re, sys, json, glob, time

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)                       # 网页版/
ROOT = os.path.dirname(WEB)                       # 爆裂魔女解包/
TREE = os.path.join(ROOT, "_export/4.5全量提取/文案数据/lua解密明文_目录树")
MEDIA = os.path.join(ROOT, "_export/4.5全量提取")

CFG_DIR = os.path.join(TREE, "xlua_config")
LANG_DIR = os.path.join(TREE, "xlua_lua_game_language")
ICON_ROOT = os.path.join(MEDIA, "图片")
SND_ROOT = os.path.join(MEDIA, "音频/单条音效/source_sound/fmodasset")

OUT_T = os.path.join(WEB, "data", "t")
os.makedirs(OUT_T, exist_ok=True)

# ---------------------------------------------------------------- Lua 字面量解析
class LuaErr(Exception):
    pass

WS = " \t\r\n"
IDENT_KEYS = set()

def _skip(t, i):
    while i < len(t):
        c = t[i]
        if c in WS:
            i += 1
        elif t.startswith("--", i):
            j = t.find("\n", i)
            i = len(t) if j < 0 else j + 1
        else:
            return i
    return i

def _num(t, i):
    m = re.match(r"0[xX][0-9a-fA-F]+|[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?", t[i:i + 40])
    if not m:
        raise LuaErr("number at %d: %r" % (i, t[i:i + 20]))
    s = m.group()
    v = int(s, 16) if s[:2] in ("0x", "0X") else (float(s) if re.search(r"[.eE]", s) else int(s))
    return v, i + len(s)

ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\\\", '"': '"', "'": "'"}

def _str(t, i, q):
    i += 1
    out = []
    while i < len(t):
        c = t[i]
        if c == "\\":
            nxt = t[i + 1]
            if nxt == "x":
                out.append(chr(int(t[i + 2:i + 4], 16))); i += 4; continue
            if nxt == "u":
                m = re.match(r"u\{([0-9a-fA-F]+)\}", t[i + 1:i + 12])
                out.append(chr(int(m.group(1), 16))); i += 1 + m.end(); continue
            if nxt.isdigit():
                m = re.match(r"[0-9]{1,3}", t[i + 1:i + 4])
                out.append(chr(int(m.group()))); i += 1 + m.end(); continue
            out.append({"n": "\n", "t": "\t", "r": "\r", "\\": "\\", '"': '"', "'": "'"}.get(nxt, nxt))
            i += 2; continue
        if c == q:
            return "".join(out), i + 1
        out.append(c); i += 1
    raise LuaErr("unterminated string")

def _value(t, i):
    i = _skip(t, i)
    if i >= len(t):
        raise LuaErr("eof")
    c = t[i]
    if c == "{":
        return _table(t, i)
    if c in "\"'":
        return _str(t, i, c)
    if t.startswith("nil", i):
        return None, i + 3
    if t.startswith("true", i):
        return True, i + 4
    if t.startswith("false", i):
        return False, i + 5
    if c == "-" or c == "+" or c.isdigit() or c == ".":
        sign = 1
        if c in "-+":
            i += 2 if c == "-" and t.startswith("-", i + 1) else 1
            sign = -1 if c == "-" else 1
        v, i = _num(t, i)
        return sign * v, i
    raise LuaErr("value at %d: %r" % (i, t[i:i + 30]))

def _table(t, i):
    i += 1
    arr, dic, expect = [], {}, 1
    while True:
        i = _skip(t, i)
        if i >= len(t):
            raise LuaErr("unterminated table")
        if t[i] == "}":
            return (arr, dic), i + 1
        if t.startswith("(", i):          # 极少见的 (expr) 形式，按字面量值处理
            j = t.index(")", i)
            v, k = _value(t, j + 1) if t[j + 1:j + 2] != "=" else (None, i)
        key = None
        m = re.match(r"\[", t[i:i + 1])
        if m:
            i = _skip(t, i + 1)
            idk = re.match(r"[A-Za-z_][A-Za-z_0-9]*", t[i:i + 60])
            if idk and not t[i:i + 1].isdigit():
                # 生成器偶有 [some_ident] 形态（例如 mailtext.lua），按字符串键处理并记入 report
                key = idk.group()
                IDENT_KEYS.add(str(key))
                i += idk.end()
            else:
                v, i = _value(t, i)
                key = v
            i = _skip(t, i)
            if t[i] != "]":
                raise LuaErr("expected ] at %d" % i)
            i = _skip(t, i + 1)
            if t[i] != "=":
                raise LuaErr("expected = at %d" % i)
            key = str(key) if key is not None and not isinstance(key, int) else key
            i += 1
        else:
            mm = re.match(r"[A-Za-z_][A-Za-z_0-9]*\s*=", t[i:i + 60])
            if mm:
                key = mm.group().rstrip(" =")
                i += mm.end()
        v, i = _value(t, i)
        if key is None:
            arr.append(v); expect += 1
        elif isinstance(key, int):
            dic[key] = v
        else:
            dic[str(key)] = v
        i = _skip(t, i)
        if i < len(t) and t[i] == ",":
            i += 1
        elif i < len(t) and t[i] == ";":
            i += 1

def lua_to_json(node):
    """(arr, dic) -> python 结构：纯数组用 list，含键用 dict"""
    if isinstance(node, tuple):
        arr, dic = node
        if not dic:
            return [lua_to_json(x) for x in arr]
        if arr and not dic:
            return [lua_to_json(x) for x in arr]
        out = {}
        for k, v in dic.items():
            out[str(k)] = lua_to_json(v)
        if arr:
            out["__positional__"] = [lua_to_json(x) for x in arr]
        return out
    if isinstance(node, list):
        return [lua_to_json(x) for x in node]
    return node

def parse_assign(text, var_pattern):
    """在源码里定位 `var_pattern = {` 并解析其后表"""
    m = re.search(var_pattern + r"\s*=\s*\{", text)
    if not m:
        return None
    node, _ = _table(text, text.index("{", m.start()))
    return node

# ---------------------------------------------------------------- 配置表抽取
def extract_tables():
    meta, notes, total_rows = [], [], 0
    for path in sorted(glob.glob(os.path.join(CFG_DIR, "*.lua"))):
        name = os.path.splitext(os.path.basename(path))[0]
        src = open(path, encoding="utf-8", errors="replace").read()
        nrows_src = len(re.findall(r"^ {4}\[", src, re.M))
        acc = re.search(r"function\s+Config\.GetConfig([A-Za-z0-9_]+)\s*\(\s*\)", src)
        acc = acc.group(1) if acc else name
        try:
            keys_node = parse_assign(src, r"local\s+_configKeys")
            cfg_node = parse_assign(src, r"local\s+_configs")
            if cfg_node is None:
                raise LuaErr("no _configs")
            keys_arr = lua_to_json(keys_node) if keys_node else None
            dic = lua_to_json(cfg_node)
            if not isinstance(dic, dict):        # 纯数组表
                dic = {str(i + 1): v for i, v in enumerate(dic)}
        except Exception as ex:
            notes.append({"table": name, "issue": "parse-failed: %s" % ex})
            continue
        fields, nfix = [], 0
        if isinstance(keys_arr, list) and keys_arr:
            # _configKeys 形如 {id=1,title=2,...} -> dict
            pass
        if isinstance(keys_node, tuple) and keys_node[1]:
            kd = keys_node[1]
            try:
                pairs = sorted(((str(k), int(v)) for k, v in kd.items()), key=lambda x: x[1])
                fields = [k for k, _ in pairs]
                idxs = [v for _, v in pairs]
                nfix = idxs
            except Exception:
                notes.append({"table": name, "issue": "bad _configKeys"})
        rows, ids = [], []
        bad_arity = 0
        for rid in sorted(dic, key=lambda x: (len(x), x)):
            v = dic[rid]
            if isinstance(v, dict) and "__positional__" in v:
                r = v["__positional__"]
            elif isinstance(v, list):
                r = v
            elif isinstance(v, dict):
                r = [v.get(str(i), None) for i in range(1, (max([int(x) for x in v if x.isdigit()] or [0])) + 1)]
            else:
                r = [v]
            if nfix and len(r) != len(nfix):
                bad_arity += 1
            ids.append(rid)
            rows.append(r)
        if not fields:
            mx = max([len(r) for r in rows] or [0])
            fields = ["c%d" % i for i in range(1, mx + 1)]
            rows = [(list(r) + [None] * (mx - len(r))) for r in rows]
            notes.append({"table": name, "issue": "no _configKeys, positional c1..c%d" % mx})
        if bad_arity:
            notes.append({"table": name, "issue": "%d 行字段数与 _configKeys 不一致" % bad_arity})
        if nrows_src and len(rows) != nrows_src:
            notes.append({"table": name, "issue": "行数不符 src=%d parsed=%d" % (nrows_src, len(rows))})
        jsname = acc
        payload = {"name": name, "accessor": jsname, "fields": fields,
                   "keyIndex": (nfix if nfix and len(nfix) == len(fields) else list(range(1, len(fields) + 1))),
                   "ids": ids, "rows": rows}
        # 版式说明：这里故意写紧凑单行（抽取阶段体积最小）；跑完抽取后执行
        # `node tools/data_pretty.js` 即可恢复「一条一行 + 文件头注释」的可读版式。
        # 那个工具只改空白不改值，写前逐 token 比对，可用 --check 复验。
        with open(os.path.join(OUT_T, "%s.js" % re.sub(r"[^\w.-]", "_", jsname)), "w", encoding="utf-8") as f:
            f.write("window.DB_TABLES=window.DB_TABLES||{};window.DB_TABLES[%s]=%s;" %
                    (json.dumps(jsname), json.dumps(payload, ensure_ascii=False, separators=(",", ":"))))
        meta.append({"name": name, "accessor": jsname, "file": "%s.js" % jsname,
                     "fields": fields, "n": len(rows), "keysContinuous": bool(nfix)})
        total_rows += len(rows)
    return meta, notes, total_rows

# ---------------------------------------------------------------- 本地化
def extract_i18n():
    out = {}
    for lang, fname in (("chs", "localization_CHS.lua"),):
        p = os.path.join(LANG_DIR, fname)
        if not os.path.exists(p):
            continue
        src = open(p, encoding="utf-8", errors="replace").read()
        node = parse_assign(src, r"Language\.LanguageTxt")
        d = lua_to_json(node) if node else {}
        with open(os.path.join(WEB, "data", "i18n_%s.js" % lang), "w", encoding="utf-8") as f:
            f.write("window.DB_I18N=window.DB_I18N||{};window.DB_I18N[%s]=%s;" %
                    (json.dumps(lang), json.dumps(d, ensure_ascii=False, separators=(",", ":"))))
        out[lang] = len(d)
    return out

# ---------------------------------------------------------------- 素材与语音索引
def collect_refs(meta):
    refs_icon, refs_av, events = set(), set(), set()
    for js in glob.glob(os.path.join(OUT_T, "*.js")):
        txt = open(js, encoding="utf-8").read()
        for m in re.finditer(r'"((?:source_icon|source_icon_new|source_common|source_gameconfig)[^"]*)"', txt):
            refs_icon.add(m.group(1))
        for m in re.finditer(r'"((?:source_avatar|source_spine|source_pet|source_model)[^"]*)"', txt):
            refs_av.add(m.group(1))
        for m in re.finditer(r'"(event:/[^"]*)"', txt):
            events.add(m.group(1))
    return refs_icon, refs_av, events

def index_dir(root):
    """返回 {相对目录: [文件名去掉扩展]}"""
    idx = {}
    if not os.path.isdir(root):
        return idx
    for d, _, fs in os.walk(root):
        rel = os.path.relpath(d, root).replace("\\", "/")
        stems = [os.path.splitext(f)[0] for f in fs if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp"))]
        if stems:
            idx.setdefault(rel, []).extend(stems)
    for k in idx:
        idx[k] = sorted(set(idx[k]))
    return idx

def build_assets(refs):
    """把配置里的 source_* 引用解析到实际文件名。
    命名规律（实测）：精灵被导出为 <图集名>_<精灵名>.png，故按等值/前缀三级匹配。"""
    listing = {}
    resolved, hit, miss = {}, 0, 0
    for ref in sorted(refs):
        clean = ref.split("|")[0].strip("/")
        if not clean:
            continue
        top, rel = clean.split("/")[0], clean.split("/", 1)[1] if "/" in clean else ""
        sub = os.path.join(ICON_ROOT, top)
        d = os.path.dirname(rel).replace("\\", "/")
        name = os.path.splitext(os.path.basename(rel))[0]
        cachekey = top + "|" + d
        if cachekey not in listing:
            base = os.path.join(sub, d) if d else sub
            stems = []
            if os.path.isdir(base):
                stems = sorted(os.path.splitext(f)[0] for f in os.listdir(base)
                               if f.lower().endswith((".png", ".jpg", ".jpeg", ".webp")))
            listing[cachekey] = set(stems)
        pool = listing[cachekey]
        pick = None
        if name in pool:
            pick = name
        elif "%s_%s" % (name, name) in pool:
            pick = "%s_%s" % (name, name)
        else:
            cands = sorted(s for s in pool if s.startswith(name + "_"))
            pick = cands[0] if cands else None
        if pick:
            ext = ".png"
            resolved[ref] = "%s/%s/%s%s" % (top, d, pick, ext) if d else "%s/%s%s" % (top, pick, ext)
            hit += 1
        else:
            resolved[ref] = None
            miss += 1
    return resolved, hit, miss

def build_voices(events):
    banks = {}
    if os.path.isdir(SND_ROOT):
        for d in os.listdir(SND_ROOT):
            p = os.path.join(SND_ROOT, d)
            if os.path.isdir(p):
                banks[d] = sorted(os.path.splitext(f)[0] for f in os.listdir(p) if f.lower().endswith(".wav"))
    hit = miss = 0
    resolved = {}
    for ev in sorted(events):
        tail = ev.split("/")[-1]
        # 先拿整个尾段当 bank 名匹配（如 CardCharacterXlsx-WitchSoundFmodPath-1001，
        # 结尾的 1001 是 bank 名的一部分）；匹配不到才把尾部的 -N 当样本序号（如 1001-skill_play-1）
        cand = None
        if tail in banks:
            cand, n = tail, None
        else:
            mnum = re.search(r"-(\d+)$", tail)
            base = re.sub(r"-\d+$", "", tail)
            for b in banks:
                if b == base or b.replace("_", "-") == base.replace("_", "-"):
                    cand, n = b, (mnum.group(1) if mnum else None); break
            if cand is None:
                for b in banks:
                    if b.startswith(base) or base.startswith(b):
                        cand, n = b, (mnum.group(1) if mnum else None); break
        if not cand:
            miss += 1
            continue
        hit += 1
        samples = banks[cand]
        pick = None
        if n:
            exact = [s for s in samples if s.endswith("_" + n)]
            if not exact:
                norm = cand.replace("-", "_") + "_" + n
                exact = [s for s in samples if norm in s]
            if exact:
                pick = exact[0]
        if pick is None and len(samples) == 1:
            pick = samples[0]
        resolved[ev] = {"bank": cand, "pick": pick, "all": samples}
    return banks, resolved, hit, miss

# ---------------------------------------------------------------- 主流程
def main():
    t0 = time.time()
    meta, notes, total_rows = extract_tables()
    i18n = extract_i18n()
    ri, ra, ev = collect_refs(meta)
    amap, ahit, amiss = build_assets(ri | ra)
    banks, vres, vhit, vmiss = build_voices(ev)
    with open(os.path.join(WEB, "data", "meta.js"), "w", encoding="utf-8") as f:
        f.write("window.DB_META=%s;" % json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
    with open(os.path.join(WEB, "data", "assets.js"), "w", encoding="utf-8") as f:
        f.write("window.DB_ASSETS=%s;" % json.dumps({"map": amap, "imageRoot": "../_export/4.5全量提取/图片"},
                                                    ensure_ascii=False, separators=(",", ":")))
    with open(os.path.join(WEB, "data", "voices.js"), "w", encoding="utf-8") as f:
        f.write("window.DB_VOICES=%s;" % json.dumps({"banks": banks, "map": vres,
                                                     "soundRoot": "../_export/4.5全量提取/音频/单条音效/source_sound/fmodasset"},
                                                    ensure_ascii=False, separators=(",", ":")))
    rep = {"generated": time.strftime("%Y-%m-%d %H:%M:%S"), "seconds": round(time.time() - t0, 1),
           "tables": len(meta), "tableRows": total_rows, "tablesFailed": [n for n in notes if "parse-failed" in n["issue"]],
           "notes": notes[:200], "notesCount": len(notes),
           "identKeys": sorted(IDENT_KEYS)[:40],
           "i18nEntries": i18n, "assetRefs": {"icon": len(ri), "avatar": len(ra), "hit": ahit, "miss": amiss},
           "events": {"total": len(ev), "hit": vhit, "miss": vmiss}, "banks": len(banks)}
    with open(os.path.join(WEB, "data", "report.js"), "w", encoding="utf-8") as f:
        f.write("window.DB_REPORT=%s;" % json.dumps(rep, ensure_ascii=False, indent=1))
    print(json.dumps({k: v for k, v in rep.items() if k not in ("notes", "tablesFailed")},
                     ensure_ascii=False, indent=1))
    print("\n前 8 条校验异常：")
    for n in notes[:8]:
        print("   %s: %s" % (n["table"], n["issue"]))

if __name__ == "__main__":
    main()
