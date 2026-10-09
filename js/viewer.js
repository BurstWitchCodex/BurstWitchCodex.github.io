/* 爆裂魔女 · 本地 md 查看器
 *
 * 职责很窄：只读 data/pagelist.js 里的 window.DB_PAGES（每项给一个 .md 路径与它的 js 包装路径），
 * 取回正文后渲染进 <main id="doc">。没有构建步骤、没有第三方依赖、没有后端。
 *
 * 路由：#/              → 清单第一篇（主页）
 *       #/<encodeURIComponent(file)> → 指定 md
 *
 * 取正文不用 fetch：页面经常是双击 file:// 打开的，那里 fetch/XHR 读同目录文件会被
 * 浏览器拦掉，而动态 <script src> 注入本地文件是允许的。所以清单里每一项除了 file（给人看的
 * md 路径）还带 doc（docs/*.md.js，由 tools/web_pages.py 把 md 原文直接包一层字符串）。
 */
(function () {
  "use strict";

  var PAGES = window.DB_PAGES || [];
  var RAW_OK = /<\/?(?:a|audio|source|video|img|br|hr|span|small|sub|sup|p|div|b|i|em|strong|code|u|mark)\b[^>]*>/g;
  var TOKEN = /\u0001(\d+)\u0001/g;

  /* ---------- 小工具 ---------- */

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }

  function escAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  }

  function safeHref(h) {
    return /^\s*(?:javascript|data|vbscript):/i.test(String(h)) ? "#" : h;
  }

  function escRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function humanSize(bytes) {
    return bytes > 1024 * 1024 ? (bytes / 1048576).toFixed(2) + " MB" : (bytes / 1024).toFixed(1) + " KB";
  }

  function byteLen(s) {
    try { return new TextEncoder().encode(s).length; } catch (e) { return s.length * 2; }
  }

  /* ---------- Markdown → HTML ----------
   * 覆盖这份 md 里真正用到的语法：标题、段落、无序/有序列表（可缩进一层）、
   * 表格、引用块、分割线、围栏代码、图片、链接、粗斜体、行内代码。
   * 原文里的 <audio>、<a id=...> 属于有意保留的裸 HTML，先藏成占位符，
   * 转义完再放回来；其余尖括号一律转义，避免正文里的 < 破坏结构。
   */

  /* 允许正文里有意保留的裸 HTML（音频、锚点、图片），但先洗掉事件属性与 javascript: 协议，
     不然白名单就是个注入入口。其余尖括号一律转义。 */
  function sanitizeTag(tag) {
    return tag
      .replace(/\s+on[a-zA-Z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/g, "")
      .replace(/(\bhref|\bsrc)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s>]+)/gi, '$1="#"')
      .replace(/\s+/g, " ");
  }

  function protectRaw(src) {
    var keep = [];
    return {
      text: src.replace(RAW_OK, function (m) {
        keep.push(sanitizeTag(m));
        return "\u0001" + (keep.length - 1) + "\u0001";
      }),
      keep: keep
    };
  }

  function escapeText(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function restoreRaw(s, keep) {
    return s.replace(TOKEN, function (m, i) { return keep[+i] || ""; });
  }

  function inline(src, keep) {
    var s = escapeText(src);
    s = s.replace(/`([^`]+)`/g, '<code class="inline">$1</code>');
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (m, alt, href) {
      return '<img src="' + escAttr(safeHref(href)) + '" alt="' + alt + '" loading="lazy">';
    });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, function (m, txt, href) {
      // 外链与图片/音频直链都开新标签页（ASSET_RE 在模块顶部定义，渲染时已就绪）
      var blank = /^(https?:|mailto:)/i.test(href) || ASSET_RE.test(href);
      return '<a href="' + escAttr(safeHref(href)) + '"' + (blank ? ' target="_blank" rel="noopener"' : "") + ">" + txt + "</a>";
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    return restoreRaw(s, keep);
  }

  function isTableSep(line) {
    return /^\s*\|?[\s:|-]{3,}\|?\s*$/.test(line) && line.indexOf("-") >= 0;
  }

  function splitRow(line) {
    var s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    var out = [], buf = "";
    for (var i = 0; i < s.length; i++) {
      var c = s.charAt(i);
      if (c === "\\" && s.charAt(i + 1) === "|") { buf += "|"; i++; continue; }
      if (c === "|") { out.push(buf); buf = ""; continue; }
      buf += c;
    }
    out.push(buf);
    return out.map(function (x) { return x.trim(); });
  }

  function md2html(src) {
    var raw = protectRaw(src.replace(/\r\n?/g, "\n"));
    var lines = raw.text.split("\n");
    var keep = raw.keep;
    var out = [];
    var toc = [];
    var para = [];
    var hIndex = 0;
    var i = 0;

    function flushPara(buf) {
      if (!buf.length) return;
      out.push('<p class="para">' + inline(buf.join("\n"), keep).replace(/\n/g, "<br>") + "</p>");
    }

    while (i < lines.length) {
      var line = lines[i];

      if (/^\s*```/.test(line)) {                       // 围栏代码
        var code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        out.push('<pre class="code"><code>' + escapeText(restoreRaw(code.join("\n"), keep)) + "</code></pre>");
        continue;
      }

      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { // 分割线
        out.push("<hr>");
        i++;
        continue;
      }

      var hm = /^(#{1,6})\s+(.*)$/.exec(line);
      if (hm) {                                          // 标题
        var lvl = hm[1].length;
        var txt = inline(hm[2].trim(), keep);
        var id = "h" + (hIndex++);
        out.push('<h' + lvl + ' id="' + id + '">' + txt + "</h" + lvl + ">");
        if (lvl >= 2 && lvl <= 3) toc.push({ lvl: lvl, id: id, txt: hm[2].trim() });
        i++;
        continue;
      }

      if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) { // 表格
        var head = splitRow(line);
        i += 2;
        var body = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { body.push(splitRow(lines[i])); i++; }
        var t = ['<div class="tblwrap"><table class="tbl"><thead><tr>'];
        head.forEach(function (c) { t.push("<th>" + inline(c, keep) + "</th>"); });
        t.push("</tr></thead><tbody>");
        body.forEach(function (r) {
          t.push("<tr>");
          for (var c = 0; c < head.length; c++) t.push("<td>" + inline(r[c] == null ? "" : r[c], keep) + "</td>");
          t.push("</tr>");
        });
        t.push("</tbody></table></div>");
        out.push(t.join(""));
        continue;
      }

      if (/^\s*>\s?/.test(line)) {                       // 引用块
        var q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, "")); i++; }
        out.push('<blockquote class="quote">' + inline(q.join(" "), keep) + "</blockquote>");
        continue;
      }

      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {       // 列表（支持两级缩进）
        var items = [];
        while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
          var indent = /^\s*/.exec(lines[i])[0].length;
          var ordered = /^\s*\d+[.)]/.test(lines[i]);
          var body2 = lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
          i++;
          while (i < lines.length && lines[i].trim() && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])
                 && !/^(#{1,6})\s+/.test(lines[i]) && /^\s{2,}/.test(lines[i])) {
            body2 += " " + lines[i].trim();              // 续行
            i++;
          }
          items.push({ indent: indent >= 2 ? 1 : 0, ordered: ordered, html: inline(body2, keep) });
        }
        out.push(renderList(items));
        continue;
      }

      if (!line.trim()) { flushPara(para); para = []; i++; continue; }

      para = [line];                                     // 普通段落
      i++;
      while (i < lines.length && lines[i].trim() && !/^(#{1,6})\s+|^\s*[-*+]\s|^\s*\d+[.)]\s|^\s*\||^\s*>|^\s*```/.test(lines[i])
             && !/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      flushPara(para);
      para = [];
    }

    return { html: out.join("\n"), toc: toc };
  }

  function renderList(items) {
    var pos = 0;
    function group(indent) {
      var html = "", open = null;
      while (pos < items.length && items[pos].indent === indent) {
        var tag = items[pos].ordered ? "ol" : "ul";
        if (open !== tag) {
          if (open) html += "</" + open + ">";
          html += "<" + tag + ' class="md-list">';
          open = tag;
        }
        html += "<li>" + items[pos].html;
        pos++;
        if (pos < items.length && items[pos].indent > indent) html += group(items[pos].indent);
        html += "</li>";
      }
      if (open) html += "</" + open + ">";
      return html;
    }
    return group(0);
  }

  /* ---------- 站点装配 ---------- */

  var docEl, listEl, countEl, inputEl;
  var cache = Object.create(null);
  var state = { page: null, hits: [], hitAt: -1, html: "" };

  function pageHref(p) { return "#/" + encodeURIComponent(p.file); }

  function currentPage() {
    var m = /^#\/(.*)$/.exec(location.hash || "");
    if (!m) return PAGES[0];
    var want;
    try { want = decodeURIComponent(m[1]); } catch (e) { want = m[1]; }
    for (var i = 0; i < PAGES.length; i++) if (PAGES[i].file === want) return PAGES[i];
    return PAGES[0];
  }

  function loadDoc(p) {
    /* 用 <script src> 注入 docs/*.md.js，避开 fetch 在 file:// 下的限制。 */
    var file = p.file;
    if (cache[file]) return Promise.resolve(cache[file]);
    if (!p.doc) return Promise.reject(new Error("清单里没有这一项的 doc 包装路径：" + file));
    return new Promise(function (res, rej) {
      var s = document.createElement("script");
      s.src = p.doc;
      s.async = true;
      s.onload = function () {
        if (s.parentNode) s.parentNode.removeChild(s);
        var t = window.DB_DOC && window.DB_DOC[file];
        if (typeof t !== "string") rej(new Error("包装里没有 “" + file + "” 这一键"));
        else { cache[file] = t; res(t); }
      };
      s.onerror = function () {
        if (s.parentNode) s.parentNode.removeChild(s);
        rej(new Error("无法注入 " + p.doc));
      };
      (document.head || document.body || document.documentElement).appendChild(s);
    });
  }

  /* 侧栏没有“资料目录”这层包裹了：直接是 「主页」条目 + 三层分组（一级分组 sub → 二级分组 cat → 条目）。
     二级 cat 为空时（汇总），条目直挂一级，不强行多套一层。 */
  var openGrp = Object.create(null);   // 一级展开状态
  var openSub = Object.create(null);   // 二级展开状态，键为「一级/二级」

  function groupOf(p) { return p && p.sub ? p.sub : "其他"; }
  function catOf(p) { return p && p.cat ? p.cat : ""; }

  function itemNode(p, extra) {
    var on = state.page && p.file === state.page.file;
    var a = el("a", "item" + (on ? " on" : "") + (extra ? " " + extra : ""));
    a.href = pageHref(p);
    a.title = p.file;
    if (p.thumb) {
      var av = el("img", "avatar");
      av.src = p.thumb;
      av.alt = "";
      av.loading = "lazy";
      av.addEventListener("error", function () { av.style.display = "none"; });
      a.appendChild(av);
    }
    var box = el("div", "meta");
    box.appendChild(el("div", "nm", escapeText(p.title)));   // 侧栏只显名字；编号仍参与上方 hay 的筛选
    box.appendChild(el("div", "sub", (p.words ? p.words.toLocaleString() + " 字" : "")));
    a.appendChild(box);
    return a;
  }

  function fold(cls, headCls, label, count, open) {
    var d = el("details", cls);
    d.open = !!open;
    d.appendChild(el("summary", headCls,
      '<span class="car">\u25be</span><span class="ttl">' + escapeText(label) + "</span><i>" + count + "</i>"));
    var body = el("div", cls === "grp" ? "grp-body" : "sub-body");
    d.appendChild(body);
    return { node: d, body: body };
  }

  function sidebar(q) {
    var tree = {}, order = [], shown = 0;
    PAGES.forEach(function (p) {
      var hay = ((p.title || "") + " " + (p.id || "") + " " + (p.sub || "") + " " + (p.cat || "")).toLowerCase();
      if (q && hay.indexOf(q) < 0) return;
      var k1 = groupOf(p), k2 = catOf(p);
      if (!tree[k1]) { tree[k1] = { items: [], cats: {}, catOrder: [], n: 0 }; order.push(k1); }
      var g = tree[k1];
      g.n++;
      if (k2) {
        if (!g.cats[k2]) { g.cats[k2] = []; g.catOrder.push(k2); }
        g.cats[k2].push(p);
      } else g.items.push(p);
      shown++;
    });

    // 当前正文所在的一/二级：被筛掉了也认，保证正在看的那篇一定在展开的组里
    var act1 = state.page ? groupOf(state.page) : null;
    var act2 = state.page ? catOf(state.page) : "";

    listEl.innerHTML = "";
    var shown0 = 0;

    if (!shown) {
      listEl.appendChild(el("p", "empty", "没有匹配项。索引里共有 " + PAGES.length + " 篇。"));
    }

    // 「主页」不放进分组：它是进站默认页，当作列表顶上的一条普通条目
    (tree["主页"] ? tree["主页"].items.concat(tree["主页"].catOrder.reduce(function (acc, k) { return acc.concat(tree["主页"].cats[k]); }, [])) : [])
      .forEach(function (p) { listEl.appendChild(itemNode(p, "top")); });

    order.forEach(function (k1) {
      if (k1 === "主页") return;
      var g = tree[k1];
      var open1 = q ? true : (k1 === act1 || openGrp[k1] === true);
      if (!q) openGrp[k1] = open1;
      var f1 = fold("grp", "ghead", k1, g.n, open1);
      f1.node.addEventListener("toggle", function () { openGrp[k1] = f1.node.open; });

      g.items.forEach(function (p) { f1.body.appendChild(itemNode(p)); });

      g.catOrder.forEach(function (k2) {
        var list = g.cats[k2];
        var key = k1 + "/" + k2;
        var open2 = q ? true : (k2 === act2 || openSub[key] === true);
        if (!q) openSub[key] = open2;
        var f2 = fold("subgrp", "chead", k2, list.length, open2);
        f2.node.addEventListener("toggle", function () { openSub[key] = f2.node.open; });
        list.forEach(function (p) { f2.body.appendChild(itemNode(p)); });
        f1.body.appendChild(f2.node);
      });

      listEl.appendChild(f1.node);
    });

    countEl.textContent = "共 " + PAGES.length + " 篇" + (q ? "，匹配 " + shown + " 篇" : "") +
      "（已载入 " + Object.keys(cache).length + "）";
  }

  function tocHtml(toc) {
    if (toc.length < 6) return "";
    var li = toc.map(function (h) {
      return '<li class="t' + h.lvl + '"><a href="#' + h.id + '">' + escapeText(h.txt) + "</a></li>";
    }).join("");
    return '<details class="toc"><summary>本页目录（' + toc.length +
      " 项，仅列二三级标题）</summary><ul>" + li + "</ul></details>";
  }

  function pagerHtml(p) {
    var i = PAGES.indexOf(p);
    var prev = i > 0 ? PAGES[i - 1] : null;
    var next = i >= 0 && i < PAGES.length - 1 ? PAGES[i + 1] : null;
    return '<div class="pager">' +
      (prev ? '<a href="' + pageHref(prev) + '">← ' + escapeText(prev.title) + "</a>" : "<span>无上一页</span>") +
      "<span> / </span>" +
      (next ? '<a href="' + pageHref(next) + '">' + escapeText(next.title) + " →</a>" : "<span>无下一页</span>") +
      "</div>";
  }

  function failHtml(err) {
    var why = err && err.message ? err.message : String(err);
    return '<div class="card fail"><h3>取正文失败</h3><p class="lead">' + escapeText(why) + "</p>" +
      '<p class="dim">正文本身是纯 .md，可以直接用编辑器打开 ' +
      '<code class="inline">网页版/pages/</code> 下的同名文件，内容一致。</p>' +
      '<p class="dim">包装文件由生成器从 md 原文直接转写，丢了或陈旧了就重跑一次：</p>' +
      '<pre class="code"><code>Python/bin/python.exe 网页版/tools/web_pages.py</code></pre>' +
      '<p class="dim">若仍失败，确认 index.html 与 pages/、docs/、data/ 保持在同一目录里。</p></div>';
  }

  var ASSET_RE = /\.(png|jpe?g|gif|webp|svg|bmp|wav|mp3|ogg)([?#].*)?$/i;

  function bindImages() {
    Array.prototype.forEach.call(docEl.querySelectorAll("img"), function (img) {
      img.addEventListener("error", function () {
        var bad = el("span", "miss", "缺文件 " + (img.getAttribute("src") || ""));
        if (img.parentNode) img.parentNode.replaceChild(bad, img);
      });
    });
    /* 图片/音频类直链一律开新标签页：本站正文靠 hash 路由，在当前页打开会顶掉阅读位置。
     * 写在渲染层而不是 md 里：md 是手改的文案唯一来源，跳转行为属于展示层。 */
    Array.prototype.forEach.call(docEl.querySelectorAll("a"), function (a) {
      var href = a.getAttribute("href") || "";
      if (!ASSET_RE.test(href)) return;
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    });
  }

  function show(p) {
    state.page = p;
    document.title = p.title + " · 爆裂魔女资料";
    sidebar(inputEl.value.trim().toLowerCase());
    docEl.innerHTML = '<p class="load">正在读取 ' + escapeText(p.file) + " …</p>";
    window.scrollTo(0, 0);
    loadDoc(p).then(function (text) {
      var r = md2html(text);
      var bar = '<div class="docbar"><span class="path">' + escapeText(p.file) + "</span>" +
        '<span class="sz">' + humanSize(byteLen(text)) + "　" + text.split("\n").length + " 行</span>" +
        '<span class="find" id="find"></span></div>';
      docEl.innerHTML = bar + tocHtml(r.toc) + r.html + pagerHtml(p);
      state.html = docEl.innerHTML;
      state.hits = [];
      state.hitAt = -1;
      bindImages();
    }, function (err) {
      docEl.innerHTML = failHtml(err);
    });
  }

  function onHash() {
    // 页内锚点（目录用的 #hN）不是路由，不能被当成换页
    var h = location.hash || "";
    if (h && h.indexOf("#/") !== 0) return;
    show(currentPage());
  }

  /* ---------- 正文内关键词命中 ---------- */

  function clearHits() {
    if (state.html) docEl.innerHTML = state.html;
    state.hits = [];
    state.hitAt = -1;
    bindImages();
    var f = document.getElementById("find");
    if (f) f.innerHTML = "";
  }

  function applyHits(q) {
    clearHits();
    if (!q || q.length < 1 || !state.html) return;
    var re = new RegExp(escRe(q), "ig");
    var walker = document.createTreeWalker(docEl, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (!n.nodeValue || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var tag = (n.parentNode && n.parentNode.tagName) || "";
        return tag === "SCRIPT" || tag === "STYLE" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [];
    while (walker.nextNode()) {
      re.lastIndex = 0;
      if (re.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
    }
    nodes.forEach(function (n) {
      var frag = document.createDocumentFragment();
      var last = 0;
      var m;
      var rx = new RegExp(escRe(q), "ig");
      while ((m = rx.exec(n.nodeValue))) {
        frag.appendChild(document.createTextNode(n.nodeValue.slice(last, m.index)));
        var mk = el("mark", "hit");
        mk.textContent = m[0];
        frag.appendChild(mk);
        last = m.index + m[0].length;
        if (m[0].length === 0) rx.lastIndex++;
      }
      frag.appendChild(document.createTextNode(n.nodeValue.slice(last)));
      n.parentNode.replaceChild(frag, n);
    });
    state.hits = Array.prototype.slice.call(docEl.querySelectorAll("mark.hit"));
    var f = document.getElementById("find");
    if (!f) return;
    if (!state.hits.length) { f.innerHTML = '<span class="none">本页无匹配</span>'; return; }
    f.innerHTML = '<span>本页命中 ' + state.hits.length + " 处</span>" +
      '<button type="button" id="fhPrev">↑</button><button type="button" id="fhNext">↓</button>';
    document.getElementById("fhPrev").addEventListener("click", function () { jump(-1); });
    document.getElementById("fhNext").addEventListener("click", function () { jump(1); });
    jump(1);
  }

  function jump(step) {
    if (!state.hits.length) return;
    state.hitAt = (state.hitAt + step + state.hits.length) % state.hits.length;
    state.hits.forEach(function (h) { h.className = "hit"; });
    var at = state.hits[state.hitAt];
    at.className = "hit now";
    at.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /* ---------- 启动 ---------- */

  function init() {
    docEl = document.getElementById("doc");
    listEl = document.getElementById("list");
    countEl = document.getElementById("count");
    inputEl = document.getElementById("q");
    if (!docEl || !listEl) return;
    if (!PAGES.length) {
      docEl.innerHTML = '<p class="load">清单为空：没读到 data/pagelist.js 里的 window.DB_PAGES。</p>';
      return;
    }
    inputEl.addEventListener("input", function () {
      sidebar(inputEl.value.trim().toLowerCase());
    });
    inputEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") applyHits(inputEl.value.trim());
      else if (e.key === "Escape") { inputEl.value = ""; sidebar(""); clearHits(); }
    });
    window.addEventListener("hashchange", onHash);
    onHash();
  }

  window.VIEWER_MD = { md2html: md2html, inline: inline, protectRaw: protectRaw };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
