# 文献阅读坞（Paper Reader）— 实现计划

> **For agentic workers:** 逐任务执行，每个任务以「能跑 + 验证」为完成标准。任务之间按依赖顺序，但 A/B/C 三条线可并行（接口以 `dsh-paper-reader/CONTRACT.md` 为准）。

**Goal:** 在 DSH 左侧开一条可拖宽的阅读坞：PDF 原版渲染、文字可选、选中句子在坞内解释线程里带上下文解释、按句缓存、按论文留历史、一键转到 DSH 对话。

**Architecture:** 宿主插件（Node + Python/PyMuPDF）负责抽取、页图、静态页、缓存与 LLM 调用；阅读器是一个原生 HTML/JS 页面（iframe 装入）；DSH 客户端插件只做薄壳（布局适配 + iframe + 拖宽/收起 + 会话桥）。

**Tech Stack:** Node ESM（无构建）、Python 3 + PyMuPDF 1.27、原生 HTML/CSS/ES Modules、React（仅薄壳，无 JSX）、`node:test`、DSH 插件 API（`webServer` / `llm` / `slots` / `locale` / `sessions` / `conversation`）。

**契约：** `dsh-paper-reader/CONTRACT.md`（唯一接口真相，改字段先改它）。

---

## 文件结构

```
dsh-paper-reader/
├── package.json           # dsh.bundle.patch + dsh.client
├── cordis.patch.yml       # 插入 paper-reader 行
├── locale/{zh,en}.json    # 插件管理器里的名称/描述
├── icon.svg
├── README.md
├── CONTRACT.md            # 接口契约（已写）
├── index.js               # 宿主：apply、路由注册、静态服务、健康检查
├── ingest.js              # 宿主：收件、校验、落盘、spawn 抽取、更新索引
├── store.js               # 宿主：路径、原子读写、docs 索引、ui-state、explanations
├── explain.js             # 宿主：缓存键、上下文拼装、SSE 流式调模型、落盘
├── extract.py             # 抽取：structure.json + pages/*.json + *.png
├── client.js              # 客户端薄壳：两个 overlay 条目、iframe、主题、会话桥
├── layout-adapter.js      # 客户端：左坞布局适配（唯一依赖 DSH 内部 DOM 的文件）
├── app/
│   ├── index.html
│   ├── styles.css
│   ├── app.js             # 启动、状态、API 客户端、主题、坞内分栏
│   ├── paper.js           # 论文渲染、文字层、选区→段落、标记、跳页
│   ├── explain.js         # 解释线程、SSE、缓存命中态、历史
│   └── bridge.js          # postMessage：主题接收、toChat 发送、独立模式
└── tests/
    ├── extract.test.mjs   # 抽取产物结构（真跑 extract.py，夹具 1706.03762v7.pdf）
    ├── store.test.mjs     # 归一化/缓存键/追加 supersede/hitCount
    └── routes.test.mjs    # mock req/res 覆盖 400/404/503 与 content-type
```

---

## Task A — 抽取器（`extract.py`）

**Files:** Create `dsh-paper-reader/extract.py`, `dsh-paper-reader/tests/extract.test.mjs`

- [ ] A1. 写 `tests/extract.test.mjs`：临时目录跑 `python3 extract.py <fixture>/1706.03762v7.pdf <tmp>`，断言：
  - stdout 是一行 JSON 且 `ok:true`、`pageCount===15`、`sections>=20`、`paras>0`、`words>5000`；
  - `structure.json` 存在，`pages.length===15`，所有 `paras[].bbox` 落在该页 `[0,0,w,h]` 内，所有 `paras[].sent` 首尾相接覆盖 `text` 全长；
  - `pages/1.json` 的每个 word 坐标在页内；
  - `pages/*.png` 有 15 张且每张 > 20KB；
  - `structure.json` < 2MB，`pages/*.json` 之和 < 1.5MB。
- [ ] A2. 跑测试 → 失败（文件不存在）。
- [ ] A3. 实现 `extract.py`：
  - 读 PDF；`doc.needs_pass` → `{"ok":false,"code":"encrypted"}` 退出码 2。
  - 每页 `get_text('dict')` 取 block/line/span bbox 与文本；`get_text('words')` 拿词级 bbox（第 6 字段是 block、第 7 字段是 line、第 8 字段是 word 序号）——**段落归属用 block 号**。
  - 段落构造：同一 block 内按 line 拼文本；`paraId = p{递增}`；`sent` 用切句规则算段内区间。
  - 双栏判定：把块按 x0 聚类，若存在两簇、簇内宽度 < 0.6 页宽且两簇在水平上不相交，则按「左簇上→下，右簇上→下」，否则按 y 排序。
  - 章节：`doc.get_toc()` 有则用（title/page/level），无则按字号启发式，最差「第 N 页」。
  - 页图：`Matrix(1.5,1.5)` → `pages/<n>.png`。
  - 输出 `pages/<n>.json`：`{n, columns:'one'|'two', words:[[x0,y0,x1,y1,word,paraId],...]}`。
  - 写完了才写 `structure.json`（最后写，失败时不留半成品）。
- [ ] A4. 跑测试通过；记录实测耗时与体积写进 README 的「实测」小节。
- [ ] A5. Commit。

## Task B — 宿主半（store / ingest / explain / index）

**Files:** Create `store.js`, `ingest.js`, `explain.js`, `index.js`, `tests/store.test.mjs`, `tests/routes.test.mjs`

- [ ] B1. `store.js`：`storeDir()`、`readJson/writeJsonAtomic`（tmp+rename）、`docsIndex`（读改写）、`uiState`、`explanations(id)`（读全量/追加）、`norm(text)` 与 `cacheKey(docId, recipe, normText, paraId)`、`latestByKey(entries)`。导出纯函数便于测试。
- [ ] B2. `tests/store.test.mjs`：归一化（`-\n`、弯引号、多空白）同键；不同 `paraId` 不同键；`force` 追加后 `supersedes` 正确、`latestByKey` 取最新；`hitCount` 递增。
- [ ] B3. `ingest.js`：`ingestBytes(buf)` / `ingestPath(path)`；校验魔数 `%PDF-`、大小、绝对路径；落 `tmp/<rand>.pdf`；`spawn(pythonPath, ['extract.py', tmpPdf, docDir])`，超时 `extractTimeoutMs`，解析 stdout 一行 JSON；成功则移动 source.pdf、更新 `index.json`；失败清 tmp 并抛出带 code 的错误。同 sha256 已存在 → 直接 `reused:true`。
- [ ] B4. `explain.js`：`buildContext(structure, sel)`、`buildMessages(...)`、`serveExplain(ctx, cfg, req, res)`：
  - 解析 body（上限 1MB）；
  - `norm` + `cacheKey`；
  - 命中且非 force → 写 SSE：`meta{cached:true}` + `done`，`hitCount+1` 落盘；
  - 未命中 → `ctx.llm.stream(...)` 逐块 `delta` 输出；完整结束后组装 entry、追加落盘、`done`；
  - 任何失败 → `error` 事件；**不落盘**。
- [ ] B5. `index.js`：`apply(ctx, config)`；启动探活 python+fitz（异步，不阻塞 apply）；注册 prefix 路由 `/dsh-paper-reader`；静态 `app/*` 服务（MIME + no-store）；`GET /api/health|docs|docs/:id/structure|docs/:id/pages/:n|docs/:id/explanations`、`POST /api/docs|/api/explain`、`GET/POST /api/ui-state`、`GET /media/:id/page-:n.png`；`inject = ['webServer','llm']`。
- [ ] B6. `tests/routes.test.mjs`：mock req/res 直调 handler；覆盖 `not-pdf` 400、未知 doc 404、py 缺失 503、png content-type。
- [ ] B7. 起一个独立脚本 `tests/serve.mjs`（可选）或在真实 DSH 里 `curl` 验证：`/api/health`、上传夹具、`structure`、`pages/1`、`media`、`explain`（用真 key）。
- [ ] B8. Commit。

## Task C — 阅读器页面（`app/`）

**Files:** Create `app/index.html`, `app/styles.css`, `app/app.js`, `app/paper.js`, `app/explain.js`, `app/bridge.js`

- [ ] C1. `index.html`：三块骨架（顶栏 / 左论文区 / 右解释栏），`<script type="module" src="app.js">`，CSS 变量占位。
- [ ] C2. `styles.css`：`--pr-*` 变量、坞内两栏 grid、页卡（`transform: scale()` 容器）、文字层（透明、可选中）、选区工具条、标记、解释线程（Markdown 子集样式）、空状态、窄态。
- [ ] C3. `app.js`：读 `?doc=`/`?embed=`、加载 `/api/docs`、最近论文下拉、拖入与文件选择上传（`POST /api/docs`，原始字节）、错误条、`ui-state` 持久化（防抖 500ms）、窄态切换、启动时 `bridge.post('ready')`。
- [ ] C4. `paper.js`：拉 `structure` + 按页懒加载 `pages/n.json` 与 png；构建 `.page`（图 + 文字层 span，`data-para`）；`ResizeObserver` 重算 `scale`；`selectionchange`/`mouseup` → 工具条（解释 / 复制 / 取消）；`selection → {page,paraId,text}`；标记层（读 `explanations?index=1`，按 `paraId + sent` 高亮）；`scrollToPage(page)`、`flash(paraId)`。
- [ ] C5. `explain.js`：tab「当前句 / 历史」；`POST /api/explain` 用 `fetch` + `ReadableStream` 解析 SSE；流式追加；`cached:true` 显示「缓存命中 · 已解释 N 次」；失败显示错误 + 重试；历史点击 → `paper.scrollToPage` + 打开该条；「重新解释」`force:true`；「复制」；「转到对话」→ `bridge.toChat(payload)`。
- [ ] C6. `bridge.js`：`post(type, data)` 带 `source:'pr-app'`；监听 `message` 校验 `source==='pr-host'`；`init/theme` → 写 CSS 变量；`chat-ack` → toast；独立模式（`window.parent===window`）禁用转到对话。
- [ ] C7. 自测：`python3 -m http.server` 无法代理 API，改用宿主路由（B 完成后）；无宿主时页面显示「插件服务未响应」。用浏览器手动走一遍：上传→翻页→选中→解释→缓存→历史。
- [ ] C8. Commit。

## Task D — 客户端薄壳（`client.js` + `layout-adapter.js`）

**Files:** Create `client.js`, `layout-adapter.js`

- [ ] D1. `layout-adapter.js`：`attach(width)` → 找 `[data-shell-overlay]` 的父元素 `frame`；记原 `paddingLeft`；写 `paddingLeft:W`；注入 `<style id="pr-adapter">`（`[data-side="sidebar"]{display:none}`）；`restore()` 还原并移除 style；找不到元素返回 `null`（调用方退化）。
- [ ] D2. `client.js`：`inject:['slots','locale','sessions','conversation','theme']`；两个 `shell.overlay` 条目（`paper-reader/tab`、`paper-reader/dock`）；dock = iframe + 拖宽把手 + 收起；宽度 `clamp(ratio*vw, 720, min(1280, .62*vw))` 存 localStorage；`autoCollapseSidebar` 时 `ctx.layout.toggleSidebar()`（仅当原本展开，收起时还原）。
- [ ] D3. 主题：`getComputedStyle` 读 6 个变量 → iframe `postMessage init/theme`；`ctx.theme.subscribe` 变化重发（若 API 不适用则退化 MutationObserver on `data-theme`）。
- [ ] D4. 会话桥：`message` 监听校验 `source==='pr-app'`；`toChat` → `sessions.list.getSnapshot().current` → `sessions.scope(id)` → `conversation.input.for(actx).setDraft(payload)` / `mode==='send'` 再 `.submit()`；异常降级 `conversation.send`；再失败 `clipboard` + 回 `chat-ack{ok:false}`。
- [ ] D5. `node --check` + 安装到 profile 后目视验证（左坞出现、不覆盖、拖宽、收起、切会话）。
- [ ] D6. Commit。

## Task E — 打包、安装、验收

**Files:** Create `package.json`, `cordis.patch.yml`, `locale/{zh,en}.json`, `icon.svg`, `README.md`

- [ ] E1. 按 `dsh-deepseek-usage` 的形状写 `package.json`（`exports` 含 `./client`、`./locale/*.json`、`./icon`；`dsh.bundle.patch` + `dsh.client{platform:'web',immediately:true}`）与 `cordis.patch.yml`（`id: paper-reader`，`name:@local/paper-reader`）。
- [ ] E2. locale 两份；icon 沿用现有风格。
- [ ] E3. `README.md`：安装/卸载、配置、数据目录、能力边界（无 OCR、公式选不中、布局适配风险）、实测数字、快捷键（双击解释）。
- [ ] E4. 安装到 `desktop` profile（`plugin_manager install_bundle` 或手工 link + 重启），确认 `application: applied` 无 warnings。
- [ ] E5. 跑全部自动化测试 + `curl` 冒烟（health/docs/structure/media/explain）。
- [ ] E6. 目视验收清单（来自设计文档第 8 节 1–8 条），逐条记录结果；未验证项显式标注。
- [ ] E7. Commit + 交付说明。

---

## 验收标准

1. `node --test dsh-paper-reader/tests` 全绿。
2. `curl /dsh-paper-reader/api/health` 返回 python/fitz 可用。
3. 上传 `1706.03762v7.pdf` → `structure` 15 页、`media` 出图。
4. 同一句解释两次 → 第二次 `meta.cached=true` 且无 `delta`（不调模型）。
5. 重启 DSH 后缓存与历史仍在。
6. 左坞：聊天整体右移不重叠、拖宽/收起正常、窗口缩到 1280 无横向溢出。
7. 会话桥：预填当前会话输入框；切会话后仍指向新会话。
