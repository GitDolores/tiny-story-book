#!/usr/bin/env node
// tiny-story-book 展示服务器（零依赖，Node 18+）
// 功能：静态托管 web/index.html + API 列出 kids_book/ 下的绘本

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "5177", 10);
const WEB_DIR = path.join(__dirname, "web");
const BOOKS_DIR = path.join(__dirname, "kids_book");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

// 与前端 parseBook 相同的解析逻辑：拆出每页的标题/画面/文字
function parseBook(md, name) {
  const pages = [];
  const lines = md.split(/\r?\n/);
  let title = name;
  let cur = null;
  for (const line of lines) {
    const hm = line.match(/^#\s+(.+)$/);
    if (hm && !cur && pages.length === 0 && !hm[1].startsWith("#")) {
      // 第一个一级标题 = 绘本标题（跳过可能的渲染说明行）
      title = hm[1].trim();
      continue;
    }
    const pm = line.match(/^##\s*第\s*(\d+)\s*页[：:]?\s*(.*)$/);
    if (pm) {
      if (cur) pages.push(cur);
      cur = { no: parseInt(pm[1], 10), title: pm[2].trim() || `第 ${pm[1]} 页`, pic: "", text: "" };
      continue;
    }
    if (!cur) continue;
    const pic = line.match(/^>\s*🖼️?\s*画面[：:]\s*(.+)$/);
    if (pic) { cur.pic = pic[1].trim(); continue; }
    const txt = line.match(/^>\s*📖?\s*文字[：:]\s*(.+)$/);
    if (txt) { cur.text = txt[1].trim(); continue; }
  }
  if (cur) pages.push(cur);
  return { name, title, pages };
}

function listBooks() {
  if (!fs.existsSync(BOOKS_DIR)) return [];
  return fs.readdirSync(BOOKS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((f) => {
      const name = f.replace(/\.md$/, "");
      try {
        const md = fs.readFileSync(path.join(BOOKS_DIR, f), "utf8");
        return parseBook(md, name);
      } catch {
        return { name, title: name, pages: [] };
      }
    });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/books") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(listBooks()));
      return;
    }
    let filePath = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const full = path.normalize(path.join(WEB_DIR, filePath));
    if (!full.startsWith(WEB_DIR)) {
      res.writeHead(403); res.end("Forbidden"); return;
    }
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found"); return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(full).pipe(res);
  } catch (err) {
    res.writeHead(500); res.end("Internal Server Error");
  }
});

server.listen(PORT, () => {
  console.log(`📖 tiny-story-book 小书架已开启`);
  console.log(`   地址：http://localhost:${PORT}`);
  console.log(`   绘本目录：${BOOKS_DIR}（新增绘本后刷新页面即可看到）`);
});
