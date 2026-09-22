#!/usr/bin/env node
// 构建 GitHub Pages 静态站（零依赖，Node 18+）
//   node build-pages.mjs [--out DIR]
// 产物：index.html（web/ 原样拷贝）+ books.json + mp3s/*.mp3 + .nojekyll
// 静态站没有 Node 服务端：/api/books 自动回退到 books.json，豆包 TTS 回退到浏览器本地语音

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listBooks } from "./lib/kidsbook.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const outArgIdx = process.argv.indexOf("--out");
const OUT_DIR = path.resolve(
  __dirname,
  outArgIdx !== -1 && process.argv[outArgIdx + 1] ? process.argv[outArgIdx + 1] : "dist"
);
const WEB_DIR = path.join(__dirname, "web");
const BOOKS_DIR = path.join(__dirname, "kids_book");
const MP3S_DIR = path.join(__dirname, "mp3s");

if (OUT_DIR === __dirname || __dirname.startsWith(OUT_DIR)) {
  console.error(`✘ 输出目录不能是项目根目录或其上级：${OUT_DIR}`);
  process.exit(1);
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// 页面：原样拷贝，index.html 里的 /api/books 由前端自动回退到 books.json
fs.copyFileSync(path.join(WEB_DIR, "index.html"), path.join(OUT_DIR, "index.html"));

// 绘本数据：audio 用相对路径，静态站在子路径（如 /tiny-story-book/）下也能取到音频
const books = listBooks({ booksDir: BOOKS_DIR, mp3sDir: MP3S_DIR, audioPrefix: "mp3s" });
fs.writeFileSync(path.join(OUT_DIR, "books.json"), JSON.stringify(books), "utf8");

// 音频：只拷贝被绘本引用到的（mp3s/ 里可能有还没配对的书）
const narrated = books.filter((b) => b.audio);
if (narrated.length) fs.mkdirSync(path.join(OUT_DIR, "mp3s"), { recursive: true });
for (const book of narrated) {
  fs.copyFileSync(
    path.join(MP3S_DIR, `${book.name}.mp3`),
    path.join(OUT_DIR, "mp3s", `${book.name}.mp3`)
  );
}

// 让 GitHub Pages 跳过 Jekyll 处理
fs.writeFileSync(path.join(OUT_DIR, ".nojekyll"), "", "utf8");

const pages = books.reduce((n, b) => n + b.pages.length, 0);
console.log(`📦 静态站已生成：${OUT_DIR}`);
console.log(`   ${books.length} 本绘本 / ${pages} 页，${narrated.length} 本有声（含整本录音）`);
console.log(`   本地预览：node server.mjs 之外，任意静态服务器指向该目录即可`);
