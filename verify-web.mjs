// 小书架页面 CDP 验证脚本：卡片渲染、打开绘本、翻页、TTS 可用性
const targets = await (await fetch("http://127.0.0.1:9222/json")).json();
const page = targets.find((t) => t.type === "page" && t.url.includes("localhost:5177"));
if (!page) { console.error("FAIL: 未找到小书架页面"); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.addEventListener("open", r); ws.addEventListener("error", j); });

let msgId = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id !== undefined && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
  }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++msgId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("JS error: " + JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  return r.result?.value;
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✔" : "✘"} ${name}${detail ? " — " + detail : ""}`);
};

// 1. 书架卡片
const cardTitles = await evaluate("Array.from(document.querySelectorAll('.book-card .title')).map(e => e.textContent)");
check("书架渲染 6 张卡片", cardTitles.length === 6, cardTitles.join("、"));
check("卡片显示主题名（非重复的「小小科普」", new Set(cardTitles).size === 6, "");

// 2. 打开第一本书
const opened = await evaluate(`(() => {
  document.querySelectorAll('.book-card')[0].click();
  const reader = document.getElementById('reader');
  return {
    readerVisible: !reader.classList.contains('hidden'),
    bookName: document.getElementById('bookName').textContent,
    pageNo: document.getElementById('pageNo').textContent,
    pageTitle: document.getElementById('pageTitle').textContent,
    pageText: document.getElementById('pageText').textContent,
    prevDisabled: document.getElementById('btnPrev').disabled,
    nextDisabled: document.getElementById('btnNext').disabled,
    dots: document.querySelectorAll('.dot').length,
  };
})()`);
check("点击卡片打开阅读器", opened.readerVisible, "");
check("第 1 页渲染（页码/标题/文字）", opened.pageNo.includes("第 1 页") && opened.pageTitle.length > 0 && opened.pageText.length > 0, `${opened.pageNo} | ${opened.pageTitle}`);
check("上一页按钮禁用 / 下一页可用", opened.prevDisabled === true && opened.nextDisabled === false, "");
check("页码圆点数量 = 页数", opened.dots === 12, `dots=${opened.dots}`);

// 3. 翻到第 2 页
const page2 = await evaluate(`(() => {
  document.getElementById('btnNext').click();
  return {
    pageNo: document.getElementById('pageNo').textContent,
    pageText: document.getElementById('pageText').textContent,
    dotsOn: Array.from(document.querySelectorAll('.dot')).findIndex(d => d.classList.contains('on')),
  };
})()`);
check("翻到第 2 页", page2.pageNo.includes("第 2 页"), `${page2.pageNo} | 文字前20字: ${page2.pageText.slice(0, 20)}`);
check("圆点高亮跟随（第 2 个）", page2.dotsOn === 1, "");

// 4. 键盘翻页 + 最后一页状态
const lastPage = await evaluate(`(() => {
  for (let i = 0; i < 20; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
  return {
    pageNo: document.getElementById('pageNo').textContent,
    nextDisabled: document.getElementById('btnNext').disabled,
  };
})()`);
check("连续右方向键翻到最后一页（第 12 页）", lastPage.pageNo.includes("第 12 页") && lastPage.nextDisabled === true, lastPage.pageNo);

// 5. 返回书架
const backOk = await evaluate(`(() => {
  document.getElementById('btnBack').click();
  const readerHidden = document.getElementById('reader').classList.contains('hidden');
  const shelfVisible = document.getElementById('shelf').style.display !== 'none';
  return readerHidden && shelfVisible;
})()`);
check("返回书架", backOk, "");

// 6. TTS：配置端点 + 讲述人选择器渲染（无 Key 时降级为本地语音）
const tts = await evaluate(`(() => {
  const sel = document.getElementById('voiceSelect');
  return {
    configEnabled: window.ttsConfig ? ttsConfig.enabled : null,
    selVisible: sel.style.display !== 'none' && sel.options.length > 0,
    selValue: sel.value,
    optionCount: sel.options.length,
    firstOption: sel.options[0] ? sel.options[0].textContent : '',
    hasSpeech: "speechSynthesis" in window,
  };
})()`);
check("TTS 配置端点可达且选择器渲染", tts.selVisible && (tts.configEnabled === true ? tts.optionCount >= 4 : tts.firstOption.includes("本地语音")), JSON.stringify(tts));
check("浏览器本地语音可用（降级路径）", tts.hasSpeech, "");

// 7. 截图留档
const shot = await send("Page.captureScreenshot", { format: "png" });
const fs = await import("node:fs");
fs.writeFileSync("F:/SomeProjects/AI-projects-learning/tiny-story-book/.verify-shelf.png", Buffer.from(shot.data, "base64"));
check("截图保存", fs.existsSync("F:/SomeProjects/AI-projects-learning/tiny-story-book/.verify-shelf.png"), "");

ws.close();
const failed = results.filter(r => !r.ok);
console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
