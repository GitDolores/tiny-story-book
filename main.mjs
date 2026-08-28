#!/usr/bin/env node
// tiny-story-book：儿童科普绘本生成器 CLI（零依赖，Node 18+）
// 输入科普主题 -> AI 生成 12-16 页 markdown 绘本 -> kids_book/<主题>.md

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_TOPIC_LEN = 50;

function sanitizeTopic(raw) {
  const t = raw.trim().replace(/[\\/:*?"<>|]/g, "").replace(/\s+/g, " ");
  if (!t || t.length > MAX_TOPIC_LEN) return null;
  // 含 UTF-8 替换符或控制字符的行多半是编码损坏产物，直接丢弃
  if (/[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(t)) return null;
  return t;
}

// ---------- CLI 解析 ----------

function parseArgs(argv) {
  const opts = {
    topics: [],
    pages: null,
    provider: null,
    model: null,
    apiKey: null,
    baseUrl: null,
    batchFile: null,
    watch: false,
    interval: 15,
    resume: false,
    outDir: path.join(__dirname, "kids_book"),
    help: false,
  };
  const flagMap = {
    "--pages": "pages", "-n": "pages",
    "--provider": "provider", "-p": "provider",
    "--model": "model", "-m": "model",
    "--api-key": "apiKey",
    "--base-url": "baseUrl",
    "--batch": "batchFile", "-b": "batchFile",
    "--interval": "interval",
    "--out": "outDir", "-o": "outDir",
  };
  const boolFlags = new Set(["--add", "--watch", "-w", "--resume", "-r", "--help", "-h"]);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (boolFlags.has(a)) {
      if (a === "--add") opts.add = true;
      else if (a === "--watch" || a === "-w") opts.watch = true;
      else if (a === "--resume" || a === "-r") opts.resume = true;
      else opts.help = true;
      continue;
    }
    if (flagMap[a]) {
      const key = flagMap[a];
      const v = argv[++i];
      if (v === undefined) { console.error(`错误：${a} 缺少参数值`); process.exit(1); }
      if (key === "pages") {
        const n = parseInt(v, 10);
        if (!Number.isInteger(n) || n < 4 || n > 40) { console.error("错误：--pages 需为 4-40 的整数"); process.exit(1); }
        opts.pages = n;
      } else if (key === "interval") {
        const n = parseInt(v, 10);
        if (!Number.isInteger(n) || n < 1) { console.error("错误：--interval 需为正整数（秒）"); process.exit(1); }
        opts.interval = n;
      } else {
        opts[key] = v;
      }
      continue;
    }
    if (a.startsWith("-")) { console.error(`未知参数：${a}（用 --help 查看用法）`); process.exit(1); }
    opts.topics.push(sanitizeTopic(a) ?? a);
  }
  return opts;
}

const HELP = `tiny-story-book 儿童科普绘本生成器

用法：
  node main.mjs <主题> [主题2 ...] [选项]
  node main.mjs --batch topics.txt [--watch] [--resume]

主题示例：牙齿保护、食物消化、种子发芽、电从哪里来

选项：
  --pages, -n N       指定页数（默认 12-16 页）
  --provider, -p X    LLM 提供商：dashscope | openai | mock
  --model, -m X       模型名（如 qwen-max、gpt-4o-mini）
  --api-key KEY       临时 API Key（优先于环境变量）
  --base-url URL      临时 API 地址（OpenAI 兼容服务）
  --batch, -b FILE    主题清单文件（每行一个主题，# 为注释）
  --add               向清单安全追加主题（UTF-8，配合 --batch 使用）
  --watch, -w         常驻模式：持续扫描清单文件，新增主题自动生成
  --interval SEC      watch 扫描间隔秒数（默认 15）
  --resume, -r        断点续跑：跳过已完成主题，重试失败主题
  --out, -o DIR       输出目录（默认 ./kids_book）
  --help, -h          显示本帮助

环境变量：
  DASHSCOPE_API_KEY / OPENAI_API_KEY / LLM_BASE_URL + LLM_API_KEY
  LLM_MODEL / LLM_PROVIDER

示例：
  node main.mjs 牙齿保护
  node main.mjs --provider mock 食物消化
  node main.mjs --batch topics.txt --watch --interval 10
  node main.mjs --batch topics.txt --add 睡眠的秘密
`;

// ---------- 进度管理（断点续跑） ----------

function loadProgress(outDir) {
  const file = path.join(outDir, ".progress.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function saveProgress(outDir, progress) {
  const file = path.join(outDir, ".progress.json");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(progress, null, 2), "utf8");
}

function topicFile(outDir, topic) {
  return path.join(outDir, `${topic}.md`);
}

// ---------- 主题清单 ----------

function readTopicsFile(file) {
  const buf = fs.readFileSync(file);
  // 中文 Windows 上 cmd echo 追加的行是 GBK 编码；UTF-8 严格解码失败则按 GBK 转码
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder("gbk").decode(buf);
    console.warn(`⚠ ${file} 含非 UTF-8 字节（可能是 cmd echo 追加导致），已按 GBK 自动转码读取。建议改用 --add 追加主题。`);
  }
  let dropped = 0;
  const topics = text
    .split(/\r?\n/)
    .map((l) => {
      const t = sanitizeTopic(l);
      if (l.trim() && !l.trim().startsWith("#") && !t) dropped++;
      return t;
    })
    .filter((t) => t && !t.startsWith("#"));
  if (dropped) console.warn(`⚠ 已丢弃 ${dropped} 行无法识别的主题（空行、过长或编码损坏）`);
  return topics;
}

// ---------- LLM 调用（自动重试 + 指数退避） ----------

function resolveProvider(opts) {
  if (opts.provider) return opts.provider;
  const env = process.env.LLM_PROVIDER;
  if (env) return env.toLowerCase();
  if (opts.apiKey || process.env.DASHSCOPE_API_KEY) return "dashscope";
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.LLM_API_KEY || opts.baseUrl) return "custom";
  return "mock";
}

const PROVIDER_DEFAULTS = {
  dashscope: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
};

function buildClient(opts) {
  const provider = resolveProvider(opts);
  if (provider === "mock") return { provider, model: "mock" };

  let baseUrl, apiKey, model;
  if (provider === "custom") {
    baseUrl = opts.baseUrl || process.env.LLM_BASE_URL;
    apiKey = opts.apiKey || process.env.LLM_API_KEY;
    model = opts.model || process.env.LLM_MODEL || "gpt-4o-mini";
    if (!baseUrl || !apiKey) {
      console.warn("⚠ 自定义服务需要 LLM_BASE_URL 和 LLM_API_KEY（或 --base-url / --api-key），回退到 mock 演示模式");
      return { provider: "mock", model: "mock" };
    }
  } else {
    const def = PROVIDER_DEFAULTS[provider];
    if (!def) { console.error(`未知提供商：${provider}（可选 dashscope | openai | mock）`); process.exit(1); }
    baseUrl = opts.baseUrl || def.baseUrl;
    apiKey = opts.apiKey || (provider === "dashscope" ? process.env.DASHSCOPE_API_KEY : process.env.OPENAI_API_KEY);
    model = opts.model || process.env.LLM_MODEL || def.model;
    if (!apiKey) {
      console.warn(`⚠ 未配置 ${provider} 的 API Key，回退到 mock 演示模式`);
      return { provider: "mock", model: "mock" };
    }
  }
  return { provider, baseUrl, apiKey, model };
}

async function chat(client, messages, { maxRetries = 3 } = {}) {
  if (client.provider === "mock") return mockChat(messages);
  const url = `${client.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let lastErr;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${client.apiKey}` },
        body: JSON.stringify({ model: client.model, messages, temperature: 0.8 }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error("响应中缺少 choices[0].message.content");
      return content;
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = 2000 * 2 ** (attempt - 1); // 2s, 4s, 8s
        console.warn(`  ↻ 调用失败（第 ${attempt}/${maxRetries} 次）：${err.message}，${delay / 1000}s 后重试`);
        await sleep(delay);
      }
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------- mock 演示模式（无 API Key 时验证流程用） ----------

function mockChat(messages) {
  const system = messages.find((m) => m.role === "system")?.content || "";
  const user = messages.find((m) => m.role === "user")?.content || "";
  const topic = (user.match(/主题[：:]([^。\n]+)/) || [])[1]?.trim() || "小小科普";
  const agent = (user.match(/拟人角色[：:]([^。\n]+)/) || [])[1]?.trim() || "小点点";
  const pageMatch = user.match(/页数[：:]\s*(\d+)/);
  const pages = pageMatch ? parseInt(pageMatch[1], 10) : 12;

  const scenes = [
    { title: `${agent}来啦`, pic: `温暖明亮的卡通场景，主角小精灵「${agent}」挥手打招呼，水彩风格，柔和色调`, text: `${agent}住在这里。你好呀，我是${agent}！` },
    { title: `忙碌的一天`, pic: `${agent}在场景里努力干活，卡通水彩风格`, text: `${agent}每天都在忙碌。今天它要做点什么呢？` },
    { title: `出了小麻烦`, pic: `${agent}遇到困难，皱起眉头，画面依然温暖可爱`, text: `哎呀，出问题了！${agent}该怎么办呢？` },
    { title: `朋友来帮忙`, pic: `小朋友和${agent}一起想办法，温馨互助的画面`, text: `别怕别怕，我们来帮你！大家想出了好办法。` },
    { title: `问题解决啦`, pic: `${agent}开心地跳起来，画面明亮欢快`, text: `问题解决啦！${agent}又开心地笑了起来。` },
    { title: `悄悄告诉你`, pic: `${agent}竖起手指，神秘又可爱的样子`, text: `关于「${topic}」，你学会了吗？记住${agent}的话哦！` },
  ];

  const lines = [`# ${topic}`, "", `> 适读年龄 3-6 岁 · 拟人角色：${agent}`, ""];
  for (let i = 0; i < pages; i++) {
    const s = scenes[i % scenes.length];
    lines.push(`## 第 ${i + 1} 页：${s.title}`, "", `> 🖼️画面：${s.pic}`, `> 📖文字：${s.text}`, "");
  }
  return Promise.resolve(lines.join("\n"));
}

// ---------- 绘本生成 ----------

function loadAgentPrompt() {
  const file = path.join(__dirname, "agents.md");
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    console.warn("⚠ 未找到 agents.md，使用内置默认风格规则");
    return DEFAULT_AGENT_PROMPT;
  }
}

const DEFAULT_AGENT_PROMPT = `你是儿童科普绘本作家，模仿《牙婆婆》《肚子里的小人》的日式科普绘本风格。
规则：
1. 开篇引入拟人小角色；中间发生小故事冲突；结尾科普知识点+好习惯引导。
2. 文字简短，每页朗读文字30-70字，不要长段落。
3. 禁止恐怖、惊悚内容，氛围温暖有趣。
4. 不要输出额外解释，直接输出分页绘本。
每一页严格格式：
## 第 N 页：页面标题

> 🖼️画面：【给AI绘图的画面描述】
> 📖文字：【绘本朗读文字，短句，适合小朋友听】`;

function extractContent(md) {
  // 去掉 markdown 代码围栏与开头多余说明，保留正文
  let text = md.trim();
  text = text.replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, "$1").trim();
  return text;
}

async function generateBook(client, topic, opts) {
  const agentPrompt = loadAgentPrompt();
  const pagesSpec = opts.pages ? `${opts.pages} 页` : "12-16 页";
  const userPrompt = `请以「${topic}」为科普主题，创作一本 ${pagesSpec} 的儿童科普绘本。

拟人角色建议（你可以自由设计更好的）：请为该主题设计一个类似「牙婆婆」「肚子里的小人」的拟人小角色。

输出格式要求：
1. 第一行是 "# 绘本标题"
2. 之后每一页严格遵循：
## 第 N 页：页面标题

> 🖼️画面：【给AI绘图的画面描述】
> 📖文字：【绘本朗读文字，短句，适合小朋友听】

3. 不要输出任何额外解释。`;

  console.log(`  ⏳ 正在生成《${topic}》…（${client.provider}/${client.model}，${pagesSpec}）`);
  const raw = await chat(client, [
    { role: "system", content: agentPrompt },
    { role: "user", content: userPrompt },
  ]);
  const content = extractContent(raw);
  if (!content || !content.includes("第 1 页") && !content.includes("第1页")) {
    throw new Error("AI 返回内容不像分页绘本（未找到「第 1 页」标记）");
  }
  const file = topicFile(opts.outDir, topic);
  fs.mkdirSync(opts.outDir, { recursive: true });
  fs.writeFileSync(file, content + "\n", "utf8");
  return file;
}

// ---------- 批量执行 ----------

async function runTopics(client, topics, opts) {
  const progress = loadProgress(opts.outDir);
  let ok = 0, fail = 0, skip = 0;

  for (const topic of topics) {
    const entry = progress[topic];
    const done = fs.existsSync(topicFile(opts.outDir, topic));
    const status = entry?.status;

    if (opts.resume && status === "done" && done) {
      console.log(`  ✔ 跳过已完成：${topic}`);
      skip++;
      continue;
    }

    try {
      const file = await generateBook(client, topic, opts);
      progress[topic] = { status: "done", file, time: new Date().toISOString() };
      saveProgress(opts.outDir, progress);
      console.log(`  ✔ 完成：${file}`);
      ok++;
    } catch (err) {
      progress[topic] = { status: "failed", error: String(err.message || err), time: new Date().toISOString() };
      saveProgress(opts.outDir, progress);
      console.error(`  ✘ 失败：${topic} —— ${err.message}`);
      fail++;
    }
  }
  return { ok, fail, skip };
}

// ---------- watch 常驻模式 ----------

async function watchLoop(client, opts) {
  const initialTopics = await collectTopics(opts);
  const first = await runTopics(client, initialTopics, opts);
  printSummary(first, `已处理本轮清单，进入常驻模式（每 ${opts.interval}s 扫描 ${opts.batchFile}）`);
  let known = new Set(initialTopics);
  while (true) {
    await sleep(opts.interval * 1000);
    let current;
    try {
      current = await collectTopics(opts);
    } catch (err) {
      console.warn(`⚠ 清单文件读取失败（${err.message}），继续等待`);
      continue;
    }
    const fresh = current.filter((t) => !known.has(t));
    if (fresh.length === 0) continue;
    console.log(`\n🆕 发现 ${fresh.length} 个新主题：${fresh.join("、")}`);
    known = new Set(current);
    const r = await runTopics(client, fresh, opts);
    printSummary(r, `已处理新增主题，继续监听…（Ctrl+C 退出）`);
  }
}

async function collectTopics(opts) {
  const topics = [...opts.topics];
  if (opts.batchFile) topics.push(...readTopicsFile(opts.batchFile));
  if (topics.length === 0) throw new Error("没有待处理的主题");
  return [...new Set(topics)];
}

// --add：UTF-8 安全地把主题追加进清单（替代 cmd echo，避免 GBK 乱码）
function addTopics(opts) {
  if (!opts.batchFile) {
    console.error("✘ --add 需要配合 --batch 指定清单文件");
    process.exitCode = 1;
    return;
  }
  const valid = opts.topics.map(sanitizeTopic).filter(Boolean);
  const invalid = opts.topics.filter((t) => !valid.includes(sanitizeTopic(t)));
  if (invalid.length) {
    console.warn(`⚠ 以下主题不合法（空、过长或含非法字符），已忽略：${invalid.join("、")}`);
  }
  if (valid.length === 0) {
    console.error("✘ 没有可追加的有效主题");
    process.exitCode = 1;
    return;
  }
  const existing = new Set(fs.existsSync(opts.batchFile) ? readTopicsFile(opts.batchFile) : []);
  const fresh = valid.filter((t) => !existing.has(t));
  const dup = valid.filter((t) => existing.has(t));
  if (dup.length) console.log(`↷ 已存在于清单，跳过：${dup.join("、")}`);
  if (fresh.length === 0) {
    console.log("✔ 清单没有变化");
    return;
  }
  // 统一以 UTF-8 无 BOM 追加，保持与读取逻辑兼容
  let body = fs.existsSync(opts.batchFile) ? fs.readFileSync(opts.batchFile) : null;
  let prefix = "";
  if (body) {
    // 源文件可能是 GBK（cmd echo 污染），先规范化为 UTF-8
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(body);
      prefix = body.toString("utf8");
      if (prefix.length > 0 && !prefix.endsWith("\n")) prefix += "\r\n";
    } catch {
      prefix = new TextDecoder("gbk").decode(body);
      if (prefix.length > 0 && !prefix.endsWith("\n")) prefix += "\r\n";
      console.warn(`⚠ ${opts.batchFile} 原为非 UTF-8 编码，已整体转为 UTF-8 保存`);
    }
  }
  fs.writeFileSync(opts.batchFile, prefix + fresh.join("\r\n") + "\r\n", "utf8");
  console.log(`✔ 已追加 ${fresh.length} 个主题：${fresh.join("、")}`);
  console.log(`  清单文件：${opts.batchFile}（若 --watch 正在运行，稍后会自动生成）`);
}

function printSummary({ ok, fail, skip = 0 }, note) {
  const parts = [`✔ ${ok} 本完成`];
  if (skip) parts.push(`↷ ${skip} 本跳过`);
  parts.push(`✘ ${fail} 本失败`);
  console.log(`\n${parts.join("，")}${note ? `。${note}` : ""}`);
}

// ---------- 入口 ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (opts.add) {
    addTopics(opts);
    return;
  }
  if (opts.topics.length === 0 && !opts.batchFile) {
    console.log(HELP);
    return;
  }
  const client = buildClient(opts);
  console.log(`📖 tiny-story-book 绘本生成器`);
  console.log(`   提供商：${client.provider}（模型：${client.model}）｜输出目录：${opts.outDir}\n`);

  try {
    if (opts.watch) {
      await watchLoop(client, opts);
    } else {
      const topics = await collectTopics(opts);
      const r = await runTopics(client, topics, opts);
      printSummary(r);
      if (r.fail > 0) process.exitCode = 2;
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(`✘ 找不到文件：${err.path || err.message}`);
    } else {
      console.error(`✘ ${err.message}`);
    }
    process.exitCode = 1;
  }
}

process.on("SIGINT", () => {
  console.log("\n👋 已手动停止。已生成的绘本与进度都已保存，可用 --resume 续跑。");
  process.exit(130);
});

main();
