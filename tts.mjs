#!/usr/bin/env node
// tiny-story-book 有声书生成器（零依赖，Node 18+）
// 读取 kids_book/<主题>.md，调用阶跃星辰 StepAudio TTS 逐页合成，拼接为整本 mp3
// 产物：mp3s/<主题>.mp3（网页端「听整本」自动配对）+ mp3s/<主题>.json（每页精确时长，自动翻页对齐）

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { parseBook } from "./lib/kidsbook.mjs";
import { mp3Duration, stripTags } from "./lib/mp3.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- StepAudio TTS API ----------
// 文档：https://platform.stepfun.com/docs/zh/api-reference/audio/create-audio
const API_BASE = process.env.STEP_TTS_BASE_URL || "https://api.stepfun.com";
const API_PATH = "/v1/audio/speech";
const MAX_INPUT_CHARS = 1000; // API 单次请求输入上限

// instruction（全局语气指导）仅这两个模型支持，其余模型传入可能报错
const INSTRUCTION_MODELS = new Set(["stepaudio-3-tts", "stepaudio-2.5-tts"]);

const DEFAULT_MODEL = "stepaudio-3-tts";
const DEFAULT_INSTRUCTION =
  "用温柔亲切的语气，像妈妈在床边讲故事一样，给3到6岁的小朋友讲绘本。语速平缓，情绪随剧情起伏，对白按角色演绎。";

// 讲故事场景推荐音色（--voice 可填 ID、中文名或克隆音色 ID）
const VOICES = {
  "wenrounvsheng": "温柔女声（有声书推荐·默认）",
  "tianmeinvsheng": "甜美女声",
  "ruanmengnvsheng": "软萌女声",
  "linjiajiejie": "邻家姐姐",
  "zhixingjiejie": "知性姐姐",
  "yuanqishaonv": "元气少女",
  "qingchunshaonv": "清纯少女",
  "wenrounansheng": "温柔男声",
  "cixingnansheng": "磁性男声",
};

function resolveVoice(raw) {
  if (!raw) return "wenrounvsheng";
  if (VOICES[raw]) return raw;
  const hit = Object.entries(VOICES).find(([, label]) => label.startsWith(raw));
  return hit ? hit[0] : raw; // 找不到就当自定义/克隆音色 ID 原样传给 API
}

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = {
    books: [],
    voice: process.env.STEP_TTS_VOICE || "",
    model: process.env.STEP_TTS_MODEL || DEFAULT_MODEL,
    instruction: process.env.STEP_TTS_INSTRUCTION ?? DEFAULT_INSTRUCTION,
    speed: 0.9,
    apiKey: "",
    booksDir: path.join(__dirname, "kids_book"),
    mp3sDir: path.join(__dirname, "mp3s"),
    force: false,
    mock: false,
    list: false,
    help: false,
  };
  const flagMap = {
    "--voice": "voice", "-v": "voice",
    "--model": "model", "-m": "model",
    "--instruction": "instruction",
    "--speed": "speed",
    "--api-key": "apiKey",
    "--books-dir": "booksDir",
    "--mp3s-dir": "mp3sDir",
  };
  const boolFlags = new Set(["--force", "-f", "--mock", "--list", "-l", "--help", "-h"]);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (boolFlags.has(a)) {
      if (a === "--force" || a === "-f") opts.force = true;
      else if (a === "--mock") opts.mock = true;
      else if (a === "--list" || a === "-l") opts.list = true;
      else opts.help = true;
      continue;
    }
    if (flagMap[a]) {
      const v = argv[++i];
      if (v === undefined) { console.error(`错误：${a} 缺少参数值`); process.exit(1); }
      const key = flagMap[a];
      if (key === "speed") {
        const n = parseFloat(v);
        if (!Number.isFinite(n) || n < 0.5 || n > 2) { console.error("错误：--speed 需为 0.5-2 之间的数值"); process.exit(1); }
        opts.speed = n;
      } else {
        opts[key] = v;
      }
      continue;
    }
    if (a.startsWith("-")) { console.error(`未知参数：${a}（用 --help 查看用法）`); process.exit(1); }
    opts.books.push(a);
  }
  opts.voice = resolveVoice(opts.voice);
  if (opts.instruction && opts.instruction.length > 500) {
    console.warn(`⚠ instruction 超过 500 字符（当前 ${opts.instruction.length}），可能被 API 拒绝`);
  }
  return opts;
}

const HELP = `tiny-story-book 有声书生成器（StepAudio TTS）

把 kids_book/ 里的绘本 md 合成为整本有声书：mp3s/<书名>.mp3
网页端打开该书即显示「🔊 听整本」，按 mp3s/<书名>.json 里记录的每页时长精确自动翻页。

用法：
  node tts.mjs                    为 kids_book/ 里所有绘本生成（已有录音的跳过）
  node tts.mjs 牙齿保护 电从哪里来   只生成指定绘本
  node tts.mjs --list             查看绘本录音状态与推荐音色
  node tts.mjs --mock 牙齿保护     演示模式：不调 API，生成占位音频验证流程

选项：
  --voice, -v ID      音色：ID / 中文名 / 克隆音色 ID（默认 wenrounvsheng 温柔女声）
  --model, -m NAME    模型（默认 stepaudio-3-tts，可选 stepaudio-2.5-tts / step-tts-2 / step-tts-mini）
  --speed X           语速 0.5-2，默认 0.9（讲故事稍慢）
  --instruction TXT   全局语气指导，仅 stepaudio-3-tts / stepaudio-2.5-tts 生效
  --api-key KEY       临时 API Key（优先于环境变量）
  --books-dir DIR     绘本目录（默认 ./kids_book）
  --mp3s-dir DIR      音频输出目录（默认 ./mp3s）
  --force, -f         已有整本录音也重新生成
  --mock              演示模式（不调 API，音频为占位静音）
  --list, -l          列出绘本录音状态与推荐音色
  --help, -h          显示本帮助

环境变量：
  STEP_API_KEY              阶跃星辰 API Key（必填，https://platform.stepfun.com 获取）
  STEP_TTS_MODEL / STEP_TTS_VOICE / STEP_TTS_INSTRUCTION   设默认模型/音色/语气指导

计费：stepaudio-3-tts 约 2.5 元 / 万字符（以阶跃星辰定价页为准）。
`;

// ---------- 绘本加载 ----------

function loadBooks(opts) {
  if (!fs.existsSync(opts.booksDir)) return [];
  return fs.readdirSync(opts.booksDir)
    .filter((f) => f.endsWith(".md"))
    .sort((a, b) => a.localeCompare(b, "zh-CN"))
    .map((f) => {
      const name = f.replace(/\.md$/, "");
      try {
        return parseBook(fs.readFileSync(path.join(opts.booksDir, f), "utf8"), name);
      } catch {
        return { name, title: name, pages: [] };
      }
    });
}

// ---------- 文本准备 ----------

// 组装每页的朗读文本：页面标题 + 正文（多行对白保留换行，TTS 会自然停顿）
// stepaudio-3-tts / 2.5 约定半角 () 内为表演指令、不朗读——把「（温柔）」这类
// 全角情绪标注转成半角，让语气提示生效而不是被念出来；其他模型会念出括号内容，改为剔除
function prepareText(page, model) {
  const lines = (page.text || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const utterance = [page.title, ...lines].filter(Boolean).join("\n");
  if (INSTRUCTION_MODELS.has(model)) {
    return utterance.replace(/（/g, "(").replace(/）/g, ")");
  }
  return utterance.replace(/（[^（）]{1,20}）/g, "");
}

// 防御：超长页按句读切成多段（API 单次输入上限 1000 字符）
function splitChunks(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = 0;
    for (const d of ["\n", "。", "！", "？", "；", "，", " "]) {
      const i = rest.slice(0, maxLen).lastIndexOf(d);
      if (i > 200) { cut = i + 1; break; }
    }
    if (!cut) cut = maxLen;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) chunks.push(rest.trim());
  return chunks;
}

function buildSegments(book, model) {
  const segments = [];
  book.pages.forEach((page, pageIndex) => {
    for (const text of splitChunks(prepareText(page, model), MAX_INPUT_CHARS)) {
      segments.push({ pageIndex, text });
    }
  });
  return segments;
}

// ---------- 合成：真实 API / 演示模式 ----------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function stepTts(text, opts, { maxRetries = 3 } = {}) {
  const body = {
    model: opts.model,
    input: text,
    voice: opts.voice,
    response_format: "mp3",
  };
  if (opts.speed !== 1) body.speed = opts.speed;
  if (opts.instruction && INSTRUCTION_MODELS.has(opts.model)) body.instruction = opts.instruction;

  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(`${API_BASE}${API_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = (await res.text().catch(() => "")).slice(0, 300);
        const err = new Error(`HTTP ${res.status} ${errText}`);
        // 参数/凭证类错误重试无意义，直接抛出
        if (res.status >= 400 && res.status < 500 && res.status !== 429) err.noRetry = true;
        throw err;
      }
      const contentType = res.headers.get("content-type") || "";
      const buf = Buffer.from(await res.arrayBuffer());
      if (!/audio|octet-stream/i.test(contentType)) {
        throw new Error(`非音频响应（${contentType}）：${buf.toString("utf8").slice(0, 200)}`);
      }
      if (buf.length < 200) throw new Error(`音频过短（${buf.length} 字节）`);
      return buf;
    } catch (err) {
      lastErr = err;
      if (err.noRetry || attempt === maxRetries) break;
      const delay = 2000 * 2 ** (attempt - 1); // 2s, 4s
      console.warn(`    ↻ 合成失败（第 ${attempt}/${maxRetries} 次）：${err.message}，${delay / 1000}s 后重试`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// 演示模式：生成帧头合法、载荷为零的占位 mp3——足够验证解析/拼接/配对全链路，
// 不是真实语音；浏览器若无法解码会自动回退逐页朗读
function mockMp3(text) {
  const seconds = Math.max(1, text.replace(/\s/g, "").length * 0.3);
  const sampleRate = 44100;
  const samplesPerFrame = 1152; // MPEG1 Layer III
  const bitrate = 64000;
  const frameLen = Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)); // 208
  const frameCount = Math.ceil((seconds * sampleRate) / samplesPerFrame);
  const frame = Buffer.alloc(frameLen, 0);
  Buffer.from([0xff, 0xfb, 0x50, 0xc0]).copy(frame, 0); // 64kbps / 44.1kHz / mono
  return Buffer.concat(Array.from({ length: frameCount }, () => frame));
}

// ---------- 单本生成 ----------

function fingerprintOf(opts) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ model: opts.model, voice: opts.voice, speed: opts.speed, instruction: opts.instruction }))
    .digest("hex")
    .slice(0, 16);
}

async function narrateBook(book, opts, fp) {
  const segments = buildSegments(book, opts.model);
  if (segments.length === 0) throw new Error("绘本没有可朗读的页面");

  // 每段缓存到 mp3s/.cache/<书名>/：中途失败重跑时已完成段落直接复用；
  // 音色/模型/语速/语气指导任一变化都会清空旧缓存
  const cacheDir = path.join(opts.mp3sDir, ".cache", book.name);
  fs.mkdirSync(cacheDir, { recursive: true });
  const metaFile = path.join(cacheDir, "meta.json");
  try {
    const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));
    if (meta.fingerprint !== fp) {
      console.log(`     ↻ 音色/模型等参数已变化，重新合成全部段落`);
      fs.rmSync(cacheDir, { recursive: true, force: true });
      fs.mkdirSync(cacheDir, { recursive: true });
    }
  } catch {
    /* 无缓存或缓存损坏，直接重建 */
  }
  fs.writeFileSync(metaFile, JSON.stringify({ fingerprint: fp, model: opts.model, voice: opts.voice, speed: opts.speed }, null, 2), "utf8");

  const buffers = [];
  for (let i = 0; i < segments.length; i++) {
    const segFile = path.join(cacheDir, `seg-${String(i + 1).padStart(3, "0")}.mp3`);
    let buf = null;
    if (!opts.force && fs.existsSync(segFile) && fs.statSync(segFile).size > 200) {
      buf = fs.readFileSync(segFile);
    } else {
      buf = opts.mock ? mockMp3(segments[i].text) : await stepTts(segments[i].text, opts);
      fs.writeFileSync(segFile, buf);
    }
    buffers.push(stripTags(buf));
    process.stdout.write(`     合成中 ${i + 1}/${segments.length} 段…\r`);
  }
  process.stdout.write("\r" + " ".repeat(40) + "\r");

  // 整本 mp3：先写临时文件再改名，避免半成品被网页端当成完整录音
  const out = path.join(opts.mp3sDir, `${book.name}.mp3`);
  const tmp = `${out}.tmp`;
  fs.writeFileSync(tmp, Buffer.concat(buffers));
  try {
    fs.renameSync(tmp, out);
  } catch {
    // Windows 上文件被占用（如浏览器正在播放）时改名会失败，退回直接写入
    fs.writeFileSync(out, fs.readFileSync(tmp));
    fs.rmSync(tmp, { force: true });
  }

  // 每页精确时长清单：前端据此对齐自动翻页的时间点
  const durations = book.pages.map(() => 0);
  buffers.forEach((buf, i) => { durations[segments[i].pageIndex] += mp3Duration(buf); });
  fs.writeFileSync(
    path.join(opts.mp3sDir, `${book.name}.json`),
    JSON.stringify({
      model: opts.model,
      voice: opts.voice,
      speed: opts.speed,
      pages: book.pages.length,
      durations: durations.map((d) => Math.round(d * 1000) / 1000),
      generatedAt: new Date().toISOString(),
    }, null, 2),
    "utf8"
  );
  return { out, seconds: durations.reduce((a, b) => a + b, 0) };
}

// ---------- 入口 ----------

function hasAudio(opts, name) {
  return fs.existsSync(path.join(opts.mp3sDir, `${name}.mp3`));
}

function printList(books, opts) {
  console.log(`绘本目录：${opts.booksDir}`);
  for (const b of books) {
    const state = hasAudio(opts, b.name)
      ? (opts.force ? "🎙️ 已有录音（--force 将重新生成）" : "🎙️ 已有录音，跳过")
      : "· 未生成";
    console.log(`  ${state}  ${b.name}（${b.pages.length} 页）`);
  }
  console.log(`\n推荐音色（--voice）：`);
  for (const [id, label] of Object.entries(VOICES)) console.log(`  ${id.padEnd(18)} ${label}`);
  console.log(`  也可传入克隆音色 ID。音色总表：https://platform.stepfun.com/docs/zh/guides/developer/tts`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }

  const allBooks = loadBooks(opts);
  if (opts.list) { printList(allBooks, opts); return; }

  opts.apiKey = opts.apiKey || process.env.STEP_API_KEY || "";
  if (!opts.mock && !opts.apiKey) {
    console.error(`✘ 未配置阶跃星辰 API Key。设置方法（当前会话有效；永久生效用 setx）：
    set STEP_API_KEY=sk-xxx
  获取地址：https://platform.stepfun.com 「API Key 管理」。
  仅想验证流程不消耗额度？加 --mock 用占位音频跑一遍。`);
    process.exit(1);
  }

  // 选择目标绘本：指定书名（校验存在）或全部
  let targets;
  if (opts.books.length > 0) {
    const byName = new Map(allBooks.map((b) => [b.name, b]));
    const missing = opts.books.filter((n) => !byName.has(n));
    if (missing.length) {
      console.error(`✘ kids_book/ 里找不到：${missing.join("、")}`);
      console.error(`  可用绘本：${allBooks.map((b) => b.name).join("、") || "（无）"}`);
      process.exit(1);
    }
    targets = opts.books.map((n) => byName.get(n));
  } else {
    targets = allBooks;
  }
  if (targets.length === 0) {
    console.error(`✘ 没有可处理的绘本（目录：${opts.booksDir}）。先用 node main.mjs <主题> 生成绘本。`);
    process.exit(1);
  }

  fs.mkdirSync(opts.mp3sDir, { recursive: true });
  const fp = fingerprintOf(opts);
  const voiceLabel = VOICES[opts.voice] || "自定义/克隆音色";
  console.log(`🎙️ tiny-story-book 有声书生成器`);
  console.log(`   模型：${opts.model}｜音色：${opts.voice} · ${voiceLabel}｜语速：${opts.speed}${opts.mock ? "｜演示模式（占位音频）" : ""}\n`);

  let ok = 0, skip = 0, fail = 0;
  for (const book of targets) {
    if (book.pages.length === 0) {
      console.error(`  ✘ 跳过：${book.name}（md 解析不到页面，格式需为「## 第 N 页：…」）`);
      fail++;
      continue;
    }
    if (hasAudio(opts, book.name) && !opts.force) {
      console.log(`  ↷ 已有录音，跳过：${book.name}（--force 重新生成）`);
      skip++;
      continue;
    }
    const chars = buildSegments(book, opts.model).reduce((n, s) => n + s.text.replace(/\s/g, "").length, 0);
    const cost = opts.model === DEFAULT_MODEL ? `（≈¥${((chars / 10000) * 2.5).toFixed(2)}）` : "";
    try {
      console.log(`  ⏳ 《${book.name}》：${book.pages.length} 页，约 ${chars} 字${cost}`);
      const r = await narrateBook(book, opts, fp);
      console.log(`     ✔ 完成：${r.out}（全本约 ${r.seconds.toFixed(1)} 秒）`);
      ok++;
    } catch (err) {
      console.error(`     ✘ 失败：${book.name} —— ${err.message}`);
      console.error(`       已合成的段落已缓存，修复问题后重跑即可断点续合成。`);
      fail++;
    }
  }
  console.log(`\n✔ ${ok} 本完成，↷ ${skip} 本跳过，✘ ${fail} 本失败`);
  if (ok > 0) console.log(`打开小书架即可「🔊 听整本」：node server.mjs → http://localhost:5177`);
  if (fail > 0) process.exitCode = 2;
}

process.on("SIGINT", () => {
  console.log("\n👋 已手动停止。已合成的段落缓存在 mp3s/.cache/，重跑同参数自动续上。");
  process.exit(130);
});

main();
