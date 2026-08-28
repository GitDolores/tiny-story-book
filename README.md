# tiny-story-book 📖

**儿童科普绘本生成器** —— 模仿《牙婆婆》《肚子里的小人》的经典日式科普绘本风格：输入一个科普主题，AI 生成一本 12-16 页、可直接打印的 Markdown 绘本，适合 3-6 岁小朋友。

把牙齿、肠胃、种子、电……这些身体和自然事物变成拟人化的小人 / 小精灵角色，用短句讲故事，不生硬说教，道理藏在故事里。

## ✨ 功能特性

- **主题输入**：牙齿保护、食物消化、种子发芽、电从哪里来……任何科普主题
- **一页一画面**：每页 = 页面标题 ｜ 🖼️画面描述（可直接拿去 AI 绘图）｜ 📖朗读文字
- **拟人化叙事**：像「牙婆婆」「肚子里的小人」一样，给主题安排一个可爱的小精灵角色
- **结构化故事**：开篇引入小角色 → 中间发生小冲突 → 结尾科普知识点 + 好习惯引导
- **自动保存**：生成结果写入 `./kids_book/<主题>.md`
- **批量 + 持续运行**：批量生成不断档，失败自动重试、断点续跑、`--watch` 常驻模式（见下文）

## 📂 目录结构

```plaintext
tiny-story-book/
├─ main.mjs          # CLI 入口（零依赖，Node 18+ 直接运行）
├─ agents.md         # 绘本风格指南 = AI 系统提示词（可自由定制）
├─ README.md
├─ topics.txt        # 批量主题清单（可选，自己创建，每行一个主题）
└─ kids_book/        # 输出目录（自动创建）
   ├─ 牙齿保护.md
   ├─ 食物消化.md
   └─ .progress.json # 生成进度（断点续跑用）
```

## 🚀 快速开始

环境要求：**Node.js 18+**，零第三方依赖，无需 `npm install`。

```bat
:: 1. 配置 API Key（三选一，当前会话有效；永久生效用 setx）
set DASHSCOPE_API_KEY=sk-xxx          & :: 推荐：通义千问 DashScope
set OPENAI_API_KEY=sk-xxx             & :: 或：OpenAI
:: 或任意 OpenAI 兼容服务：同时设置 LLM_BASE_URL 和 LLM_API_KEY

:: 2. 生成第一本绘本
node main.mjs 牙齿保护
```

没有 API Key？用内置演示模式（本地模板生成，验证整条流程）：

```bat
node main.mjs --provider mock 牙齿保护
```

## 📖 使用方法

| 命令 | 说明 |
|---|---|
| `node main.mjs 牙齿保护` | 单主题生成 |
| `node main.mjs 牙齿保护 食物消化` | 多主题依次生成 |
| `node main.mjs --batch topics.txt` | 从文件批量生成（每行一个主题，`#` 开头为注释） |
| `node main.mjs --batch topics.txt --watch` | **持续运行模式**：进程常驻，周期扫描清单文件，新增主题自动生成 |
| `node main.mjs --batch topics.txt --resume` | 断点续跑：跳过已完成主题，重试失败主题 |
| `node main.mjs --batch topics.txt --add 新主题` | 向清单安全追加主题（UTF-8 编码，推荐用这个而不是手动编辑） |
| `node main.mjs --pages 14 牙齿保护` | 指定页数（默认 12-16 页） |
| `node main.mjs --provider mock 牙齿保护` | 演示模式（无需 API Key） |

`topics.txt` 示例：

```plaintext
# 每行一个主题，# 开头的行是注释
牙齿保护
食物消化
种子发芽
电从哪里来
```

## 🔁 持续运行与容错（保证任务一直跑完）

批量 / 长任务的核心诉求：**中途任何环节出问题，任务不停止、不丢进度**。

| 机制 | 说明 |
|---|---|
| 自动重试 | 单次 API 调用失败（网络抖动、限流、超时）自动指数退避重试 3 次 |
| 失败不中断 | 批量中某个主题最终失败，只记录到进度文件，继续生成后面的主题 |
| 断点续跑 | 进度实时落盘到 `kids_book/.progress.json`；`--resume` 跳过已完成、自动重试失败项 |
| 常驻模式 | `--watch` 让进程一直运行，每隔 `--interval`（默认 15 秒）扫描主题清单，发现新主题立即生成；挂着不管，往 `topics.txt` 里加主题即可 |
| 安全退出 | 任何时刻 `Ctrl+C` 退出，已完成的结果和进度全部保留 |

持续运行的典型用法：

```bat
:: 终端 1：启动常驻生成器
node main.mjs --batch topics.txt --watch --interval 10

:: 终端 2：随时追加主题（下一轮扫描自动生成）
node main.mjs --batch topics.txt --add 睡眠的秘密
```

> ⚠️ 中文 Windows 注意：不要用 `echo 主题>> topics.txt` 追加——cmd 会以 GBK 编码写入导致乱码。程序读取时已做 GBK 自动转码兜底，但推荐统一使用 `--add`，它保证写入的一定是 UTF-8。

## ⚙️ 配置

### 环境变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `DASHSCOPE_API_KEY` | 阿里云 DashScope（通义千问）API Key | — |
| `OPENAI_API_KEY` | OpenAI API Key | — |
| `LLM_BASE_URL` | 自定义 OpenAI 兼容服务地址 | — |
| `LLM_API_KEY` | 自定义服务的 API Key | — |
| `LLM_MODEL` | 模型名 | 按提供商推断 |
| `LLM_PROVIDER` | `dashscope` / `openai` / `mock` | 自动探测 |

**提供商自动探测顺序**：`--provider` 参数 > `LLM_PROVIDER` > `DASHSCOPE_API_KEY`（→ qwen-plus）> `OPENAI_API_KEY`（→ gpt-4o-mini）> `LLM_BASE_URL` + `LLM_API_KEY` > 都没有则降级为 mock 演示模式。

### CLI 参数

| 参数 | 缩写 | 说明 |
|---|---|---|
| `--pages N` | | 指定绘本页数（默认 12-16 页） |
| `--provider X` | `-p` | `dashscope` / `openai` / `mock` |
| `--model X` | `-m` | 模型名（如 `qwen-max`） |
| `--api-key X` | | 临时指定 API Key（优先于环境变量） |
| `--base-url X` | | 临时指定 API 地址 |
| `--batch FILE` | `-b` | 主题清单文件 |
| `--add` | | 向清单文件安全追加主题（需配合 `--batch`） |
| `--watch` | `-w` | 持续运行模式（需配合 `--batch`） |
| `--interval SEC` | | watch 扫描间隔，默认 15 秒 |
| `--resume` | `-r` | 断点续跑 |
| `--out DIR` | `-o` | 输出目录，默认 `./kids_book` |
| `--help` | `-h` | 帮助 |

## 📄 输出格式

每本绘本保存为 `kids_book/<主题>.md`，每页严格遵循以下格式（🖼️画面行可直接复制给 AI 绘图工具出插画）：

```markdown
## 第 1 页：嘴巴里住着牙婆婆

> 🖼️画面：温暖明亮的儿童卧室，小女孩张大嘴巴，嘴巴里站着一位系着头巾、拿着小扫帚的迷你老婆婆，卡通水彩风格，柔和粉色色调
> 📖文字：嘴巴里面住着牙婆婆。她每天拿着小扫帚，把牙齿扫得亮晶晶。
```

## 🎨 风格定制

绘本的文风、结构、每页格式全部由 `agents.md` 定义——它既是给人看的风格指南，也是运行时实际下发给 AI 的系统提示词。想调整口吻、页数结构或输出格式，直接编辑 `agents.md` 即可，不用改代码。

## 🗺️ 路线图

- **v1（当前）**：主题输入 → Markdown 绘本 ✅
- **v2**：对接文生图 API——把每页 🖼️画面描述直接生成为插画，输出图文并茂的绘本
