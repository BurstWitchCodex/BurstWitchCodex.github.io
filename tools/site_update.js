#!/usr/bin/env node
/* 已退役：site_update.js 的功能并入 tools/pages_build.js。
 * 本文件只做转发，保证旧命令与旧 .bat 不报错；新代码请直接调用 pages_build.js。
 */
const path = require("path");
console.log("[deprecated] site_update.js 已并入 pages_build.js，正在转发…");
require(path.join(__dirname, "pages_build.js"));
