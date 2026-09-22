// 绘本 markdown 解析与目录扫描
// server.mjs（小书架 API）与 build-pages.mjs（GitHub Pages 静态构建）共用同一份逻辑
// 前端 web/index.html 内嵌了一份等价的 parseBook（浏览器无法直接 import，改动需同步）

import fs from "node:fs";
import path from "node:path";

// 拆出每页的标题/画面/文字
// 文字既支持同一行（> 📖文字：……），也支持跨行引用块（> 📖文字： 后跟多行 `>` 对白）
export function parseBook(md, name) {
  const pages = [];
  const lines = md.split(/\r?\n/);
  let title = name;
  let sprite = "";
  let cur = null;
  let inText = false;
  for (const line of lines) {
    const hm = line.match(/^#\s+(.+)$/);
    if (hm && !cur && pages.length === 0) {
      // 第一个一级标题 = 绘本标题（跳过可能的渲染说明行）
      title = hm[1].trim();
      continue;
    }
    const pm = line.match(/^##\s*第\s*(\d+)\s*页[：:]?\s*(.*)$/);
    if (pm) {
      if (cur) pages.push(cur);
      cur = { no: parseInt(pm[1], 10), title: pm[2].trim() || `第 ${pm[1]} 页`, pic: "", text: "" };
      inText = false;
      continue;
    }
    if (!cur) {
      // 封面信息行：> 适读年龄 3-6 岁 · 拟人角色：牙婆婆（在第一页之前出现）
      const sm = line.match(/^>\s*适读年龄[^·]*·\s*拟人角色[：:]\s*(.+)$/);
      if (sm) sprite = sm[1].trim();
      continue;
    }
    const pic = line.match(/^>\s*🖼️?\s*画面[：:]\s*(.+)$/);
    if (pic) { cur.pic = pic[1].trim(); inText = false; continue; }
    const txt = line.match(/^>\s*📖?\s*文字[：:]\s*(.*)$/);
    if (txt) { cur.text = txt[1].trim(); inText = true; continue; }
    const cont = inText && line.match(/^>\s*(.+)$/);
    if (cont) { cur.text = cur.text ? `${cur.text}\n${cont[1].trim()}` : cont[1].trim(); continue; }
    inText = false;
  }
  if (cur) pages.push(cur);
  return { name, title, sprite, pages };
}

// 主题 → 卡片图标（按书名/标题关键词命中，未命中回退 📖）
const ICON_RULES = [
  [/牙/, "🦷"],
  [/消化|肚子|肚肚|吃饭|食物|饭/, "🍚"],
  [/睡|梦|晚安/, "🌙"],
  [/雨|云|天气/, "🌧️"],
  [/雪|冬天/, "❄️"],
  [/风/, "🍃"],
  [/彩虹/, "🌈"],
  [/种子|芽|植物|花|树|树叶/, "🌱"],
  [/电|闪电/, "⚡"],
  [/太阳|光/, "☀️"],
  [/月亮|星星|夜空|宇宙|太空/, "⭐"],
  [/恐龙/, "🦕"],
  [/动物|森林|昆虫|蜜蜂|蝴蝶/, "🐝"],
  [/海|海洋|鱼/, "🌊"],
  [/火|火山/, "🔥"],
  [/感冒|生病|医生|病毒/, "🤒"],
  [/心|情绪|朋友/, "💛"],
];

function bookIcon(book) {
  const s = `${book.name}${book.title}`;
  for (const [re, icon] of ICON_RULES) if (re.test(s)) return icon;
  return "📖";
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// 扫描绘本目录；audioPrefix 让同一份数据在 Node 服务（/mp3s/…）与静态站（mp3s/…）下都成立
export function listBooks({ booksDir, mp3sDir, audioPrefix = "/mp3s" }) {
  if (!fs.existsSync(booksDir)) return [];
  return fs.readdirSync(booksDir)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((f) => {
      const name = f.replace(/\.md$/, "");
      let book;
      try {
        book = parseBook(fs.readFileSync(path.join(booksDir, f), "utf8"), name);
      } catch {
        book = { name, title: name, pages: [] };
      }
      book.icon = bookIcon(book);
      // 绘本音频 = mp3s/<书名>.mp3（同名即视为这本书的有声版）
      if (isFile(path.join(mp3sDir, `${name}.mp3`))) {
        book.audio = `${audioPrefix}/${encodeURIComponent(name)}.mp3`;
        // tts.mjs 生成的每页时长清单：前端据此精确对齐自动翻页；页数对不上则忽略
        try {
          const m = JSON.parse(fs.readFileSync(path.join(mp3sDir, `${name}.json`), "utf8"));
          if (
            Array.isArray(m.durations) && m.durations.length === book.pages.length &&
            m.durations.every((n) => Number.isFinite(n) && n >= 0) && m.durations.some((n) => n > 0)
          ) {
            book.audioPages = m.durations;
          }
        } catch {
          /* 无清单则回退为按文字长度估算 */
        }
      }
      return book;
    });
}
