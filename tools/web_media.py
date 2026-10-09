#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""网页版素材管线：把站点引用到的图片/语音**裁切并复制进 网页版/media/**。

做三件事：
  1) 图片：按 assets.js 的映射取原图 -> 裁掉全透明边（Unity 精灵四周常有大片透明）
     -> 输出原尺寸到 media/img/，另出 320px 缩略到 media/thumb/
  2) 语音：按 voices.js 的推测映射把 event 对应的 wav 复制为 media/sound/<bank>__<sample>.wav
     （默认总量上限 900 MB，超出即停并如实报告）
  3) 产出 media/media_map.js：引用 -> 本地路径 + 尺寸 + 是否整页图集 + 是否有分块页(_1)
之后 db.js 会优先用本地 media，找不到再回退 ../_export 原路径。

用法：
  python tools/web_media.py                # 图片+语音
  python tools/web_media.py --no-audio     # 只处理图片
  python tools/web_media.py --max-mb 1500
"""
import os, re, json, sys, shutil, argparse, time
from PIL import Image, ImageFile

ImageFile.LOAD_TRUNCATED_IMAGES = True
HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.dirname(HERE)
ROOT = os.path.dirname(WEB)
IMG_SRC = os.path.join(ROOT, "_export/4.5全量提取/图片")
SND_SRC = os.path.join(ROOT, "_export/4.5全量提取/音频/单条音效/source_sound/fmodasset")
MEDIA = os.path.join(WEB, "media")
I_OUT = os.path.join(MEDIA, "img")
T_OUT = os.path.join(MEDIA, "thumb")
S_OUT = os.path.join(MEDIA, "sound")


def read_js(path, var):
    s = open(path, encoding="utf-8").read()
    m = re.search(r"window\.%s=(.*);\s*$" % var, s, re.S)
    return json.loads(m.group(1))


def trim(im):
    """裁掉四周全透明/纯黑边；返回 (图, 裁掉量)"""
    if im.mode != "RGBA":
        im = im.convert("RGBA")
    bbox = im.getchannel("A").getbbox()
    if not bbox:
        return im, None
    return im.crop(bbox), bbox


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-audio", action="store_true")
    ap.add_argument("--max-mb", type=float, default=900.0)
    ap.add_argument("--thumb", type=int, default=320)
    a = ap.parse_args()
    os.makedirs(I_OUT, exist_ok=True); os.makedirs(T_OUT, exist_ok=True)
    if not a.no_audio:
        os.makedirs(S_OUT, exist_ok=True)

    amap = read_js(os.path.join(WEB, "data", "assets.js"), "DB_ASSETS")["map"]
    files = sorted({v for v in amap.values() if v})
    print("引用去重后需处理图片：%d 张" % len(files))

    # 分块页检测：同目录下 name_1.png 表示该精灵还有第二张贴图
    allnames = {}
    for top in os.listdir(IMG_SRC):
        p = os.path.join(IMG_SRC, top)
        if os.path.isdir(p):
            for d, _, fs in os.walk(p):
                allnames[d.replace(IMG_SRC + os.sep, "").replace("\\", "/")] = set(fs)

    info, done, skipped, t0 = {}, 0, 0, time.time()
    for i, rel in enumerate(files, 1):
        src = os.path.join(IMG_SRC, rel.replace("/", os.sep))
        if not os.path.exists(src):
            skipped += 1; continue
        try:
            im = Image.open(src); im.load()
        except Exception as ex:
            skipped += 1; continue
        w0, h0 = im.size
        cut, box = trim(im)
        base = os.path.splitext(os.path.basename(rel))[0]
        d = os.path.dirname(rel)
        pages = [f for f in allnames.get(d, ()) if re.match(re.escape(base) + r"_\d+\.png$", f)]
        out_rel = rel
        ipath = os.path.join(I_OUT, out_rel.replace("/", os.sep))
        tpath = os.path.join(T_OUT, out_rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(ipath), exist_ok=True)
        os.makedirs(os.path.dirname(tpath), exist_ok=True)
        cut.save(ipath, "PNG", optimize=False)
        th = cut.copy()
        if max(th.size) > a.thumb:
            r = a.thumb / float(max(th.size))
            th = th.resize((max(1, int(th.size[0] * r)), max(1, int(th.size[1] * r))), Image.LANCZOS)
        th.save(tpath, "PNG")
        info[rel] = {"w": cut.size[0], "h": cut.size[1], "src_w": w0, "src_h": h0,
                     "atlas": max(w0, h0) >= 2048, "pages": len(pages)}
        done += 1
        if i % 120 == 0:
            print("   图片 %d/%d  完成 %d  %.0fs" % (i, len(files), done, time.time() - t0))

    # 反向：ref -> 文件
    by_ref = {ref: v for ref, v in amap.items() if v}

    sound_map, bank_files, sb = {}, {}, 0
    if not a.no_audio:
        vj = read_js(os.path.join(WEB, "data", "voices.js"), "DB_VOICES")
        cap = a.max_mb * 1048576
        # 角色语音 bank 需要整组拷贝（一个 event 对应多条台词），其余只拷命中样本
        hero_banks = set()
        for ev, vinfo in vj["map"].items():
            if "CardCharacterXlsx" in ev:
                hero_banks.add(vinfo["bank"])

        def copy(bank, s):
            nonlocal sb
            src = os.path.join(SND_SRC, bank, s + ".wav")
            if not os.path.exists(src):
                return None
            name = ("%s__%s.wav" % (bank, s)).replace("/", "_")
            dst = os.path.join(S_OUT, name)
            if not os.path.exists(dst):
                sz = os.path.getsize(src)
                if sb + sz > cap:
                    return None
                shutil.copyfile(src, dst); sb += sz
            return "media/sound/" + name

        for ev, vinfo in sorted(vj["map"].items()):
            bank, pick, alls = vinfo["bank"], vinfo.get("pick"), vinfo.get("all") or []
            if pick:
                u = copy(bank, pick)
                if u:
                    sound_map[ev] = u
            if bank in hero_banks:
                got = bank_files[bank] = bank_files.get(bank) or []
                seen = set(got)
                for s in alls:
                    u = copy(bank, s)
                    if u and u not in seen:
                        got.append(u); seen.add(u)
        print("   语音映射 %d 条，角色语音 bank %d 个，新增 %.0f MB"
              % (len(sound_map), len(bank_files), sb / 1048576))

    with open(os.path.join(MEDIA, "media_map.js"), "w", encoding="utf-8") as f:
        f.write("window.DB_MEDIA=%s;" % json.dumps(
            {"img": info, "byRef": by_ref, "sound": sound_map, "bankFiles": bank_files,
             "fallbackImgRoot": "../_export/4.5全量提取/图片/",
             "stats": {"files": len(files), "done": done, "skipped": skipped,
                       "atlasPages": sum(1 for x in info.values() if x["atlas"]),
                       "multiPage": sum(1 for x in info.values() if x["pages"]),
                       "sound": len(sound_map), "soundMB": round(sb / 1048576, 1)}},
            ensure_ascii=False, separators=(",", ":")))
    mb = sum(os.path.getsize(os.path.join(d, x)) for d, _, fs in os.walk(MEDIA) for x in fs) / 1048576
    print("\n=== 完成 ===")
    print("  图片处理 %d / %d（跳过 %d）" % (done, len(files), skipped))
    print("  其中整页级(>=2048) %d，含分块页 %d" % (
        sum(1 for x in info.values() if x["atlas"]), sum(1 for x in info.values() if x["pages"])))
    print("  语音 %d 条，%.0f MB" % (len(sound_map), sb / 1048576))
    print("  media/ 总计 %.1f MB，用时 %.0fs" % (mb, time.time() - t0))
    print("  索引：media/media_map.js")


if __name__ == "__main__":
    main()
