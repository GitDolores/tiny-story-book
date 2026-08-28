#!/usr/bin/env node
// tiny-story-book 展示服务器（零依赖，Node 18+）
// 功能：静态托管 web/index.html + API 列出绘本 + Edge 神经网络 TTS 合成

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
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

// ---------- 豆包 TTS（火山引擎大模型语音合成，HTTP API） ----------
// 配置环境变量：TTS_APP_ID / TTS_ACCESS_KEY / TTS_SECRET_KEY（火山引擎控制台获取）
// 未配置时 /api/tts 返回 503，前端自动降级到浏览器本地语音

const TTS_APP_ID = process.env.TTS_APP_ID || "";
const TTS_ACCESS_KEY = process.env.TTS_ACCESS_KEY || "";
const TTS_SECRET_KEY = process.env.TTS_SECRET_KEY || "";
const TTS_API_HOST = process.env.TTS_API_HOST || "openspeech.bytedance.com";
const TTS_API_PATH = "/api/v1/tts";
const ttsEnabled = Boolean(TTS_APP_ID && TTS_ACCESS_KEY && TTS_SECRET_KEY);

// 服务端声音清单：voice_type 对应火山引擎「语音合成大模型」音色
const DOUBAO_VOICES = {
  "tongtong": { label: "彤彤（温柔童声·推荐）", voiceType: "BV700_V2_streaming", speedRatioDefault: 0.9 },
  "wanwan": { label: "湾湾（软萌女声）", voiceType: "BV701_streaming", speedRatioDefault: 0.9 },
  "xuanxuan": { label: "萱萱（甜美女声）", voiceType: "BV034_streaming", speedRatioDefault: 0.9 },
  "zhinv": { label: "知性姐姐（讲故事女声）", voiceType: "BV705_streaming", speedRatioDefault: 0.95 },
};

function hmacSha256(key, message) {
  return crypto.createHmac("sha256", key).update(message).digest("hex");
}

// 火山引擎 TTS v1 签名： Authorization: Bearer;<ak>;<date>;<region>;<service>;<hex(hmac(secret, date\region\service))>
function buildAuthHeader() {
  const date = new Date().toISOString().replace(/[-:]/g, "").slice(0, 8); // YYYYMMDD（UTC）
  const region = "cn-north-1";
  const service = "openspeech";
  const credential = `${date}/${region}/${service}`;
  const signed = hmacSha256(TTS_SECRET_KEY, credential);
  return `Bearer;${TTS_ACCESS_KEY};${date};${region};${service};${signed}`;
}

async function doubaoTts(text, voiceType, speedRatio) {
  const reqId = crypto.randomUUID();
  const body = JSON.stringify({
    app: { appid: TTS_APP_ID, token: "access_token", cluster: "volcano_tts" },
    user: { uid: "tiny-story-book" },
    audio: {
      voice_type: voiceType,
      encoding: "mp3",
      speed_ratio: speedRatio,
      volume_ratio: 1.0,
      pitch_ratio: 1.0,
    },
    request: {
      reqid: reqId,
      text,
      text_fmt: "plain",
      operation: "query",
      with_frontend: 1,
      frontend_type: "unitTts",
    },
  });

  let res;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await fetch(`https://${TTS_API_HOST}${TTS_API_PATH}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: buildAuthHeader(),
        },
        body,
      });
      if (res.ok) break;
      if (res.status >= 500 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      const errText = (await res.text()).slice(0, 300);
      throw new Error(`豆包 TTS HTTP ${res.status}: ${errText}`);
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("audio")) {
    return Buffer.from(await res.arrayBuffer());
  }
  // 错误响应是 JSON
  const data = await res.json().catch(() => ({}));
  throw new Error(`豆包 TTS 失败: ${data?.message || JSON.stringify(data).slice(0, 200)}`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/books") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(listBooks()));
      return;
    }
    if (url.pathname === "/api/tts/config") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        enabled: ttsEnabled,
        voices: Object.entries(DOUBAO_VOICES).map(([id, v]) => ({ id, label: v.label })),
      }));
      return;
    }
    if (url.pathname === "/api/tts") {
      const text = (url.searchParams.get("text") || "").slice(0, 600);
      const voiceId = url.searchParams.get("voice") || "tongtong";
      const speedParam = parseFloat(url.searchParams.get("speed") || "");
      if (!text) { res.writeHead(400); res.end("missing text"); return; }
      if (!ttsEnabled) {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("豆包 TTS 未配置（需 TTS_APP_ID / TTS_ACCESS_KEY / TTS_SECRET_KEY 环境变量）");
        return;
      }
      const voice = DOUBAO_VOICES[voiceId] || DOUBAO_VOICES.tongtong;
      try {
        const audio = await doubaoTts(text, voice.voiceType, Number.isFinite(speedParam) ? speedParam : voice.speedRatioDefault);
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
        res.end(audio);
      } catch (err) {
        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`TTS failed: ${err.message}`);
      }
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
  console.log(`   豆包 TTS：${ttsEnabled ? "已配置 ✅" : "未配置（浏览器将使用本地语音）。配置方法：设置 TTS_APP_ID / TTS_ACCESS_KEY / TTS_SECRET_KEY 环境变量"}`);
});
