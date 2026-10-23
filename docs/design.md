# 文献阅读坞（Paper Reader）— 设计文档

日期：2026-10-23
状态：设计已与用户确认（本轮四问：解释落在哪 = C 两者都要；论文放哪 = A 嵌在左侧把布局右推；文件范围 = A 仅带文字层 PDF；解释配方 = A 选区即单位 + 三段式）

## 背景与调研（已查证，非推测）

用户要读外文文献：论文进对话框 → 左侧打开可选中文字的原文 → 选中读不懂的句子 → 右侧解释，且解释带上下文、有缓存、有历史。

调研结论：

1. **DSH 附件管线只收图片**（`dsh-attachment` README 明确 v1 仅 PNG/JPEG/WebP/GIF），PDF 拖进输入框会被拒。所以「论文进对话框」不能复用现有附件，必须由插件自己的上传通道承担。
2. **主布局固定三栏**：`dsh-client-ui-layout` 的 `AppFrame` 是 CSS Grid，`gridTemplateColumns: sidebar | minmax(0,1fr) | details`，几何常量 `CENTER_MIN 640 / SIDEBAR 264–420 / DETAILS 300–520`。没有给「左侧论文区」留位。
3. **可以安全地"借"出一条左列**：`AppFrame` 渲染 `<div className=frame>`，其内是 `[data-shell-overlay]`（`position:absolute; inset:0; pointer-events:none; z-index:20`，子元素自动恢复 `pointer-events`）。给 frame 加 `padding-left`，列会整体右移；overlay 层的 `left:0` 正好落在让出来的那条空档里，浮层内再放面板即视觉上"新开了一列"，不覆盖聊天。
4. **客户端插件能拿到的服务**：`slots`、`locale`、`theme`、`sessions`（`ISessions`）、`layout`（`ILayout`）、`conversation`（`IConversation`）。`sessions.list.getSnapshot().current` 给出当前会话 id；`sessions.scope(id)` 返回 Agent 作用域 ctx；`conversation.input.for(actx).setDraft(text)` 可预填输入框、`.submit()` 可发送，`conversation.send(text)` 直接发送。**"转到对话"不需要任何私有接口。**
5. **宿主插件可以注册 HTTP 路由**：`ctx.webServer.register({ kind: 'prefix', path, handler })`，可返回任意 JSON / SSE / 静态字节；还能 `ctx.llm.stream({ provider, model, messages, system, ... })` 直接调本 profile 已配好的 DeepSeek 适配器（`deepseek-official`，默认模型 `deepseek-v4-flash`）。
6. **本机 PDF 处理能力实测**（python3 + PyMuPDF 1.27.2，用 `~/Downloads/1706.03762v7.pdf` 15 页双栏论文）：
   - `page.get_text('words')` 全篇 6095 词，**0.09 秒**；
   - `page.get_text('dict')` 给出 block→line→span→bbox，标题/正文/双栏结构可直接用；
   - `page.get_toc()` 有 22 条带层级目录；
   - 页图 `get_pixmap(Matrix(1.5,1.5))` 918×1188 PNG ≈ 179KB，全 15 页 **0.33 秒 / 共约 2.7MB**。
   结论：PDF 理解与渲染都放在宿主半一次做完，阅读器只负责拼装，**不需要 pdf.js**。
7. **客户端模块加载器只保证 `require('react')` 可用**（上一个插件 `dsh-deepseek-usage` 已验证）。因此阅读器主体不写成 React 组件，而是一个**普通网页**，由 DSH 内的薄壳用 iframe 装入：阅读器可脱离 DSH 独立调试，且不受 CJS 加载器与 UI 框架约束。

## 需求（与用户确认）

- 支持带文字层的 PDF（中/英），暂不做扫描版 OCR。
- 左侧阅读坞：论文按原版面渲染（公式、双栏、图、表不重排），**每个字可选中**，有真实选区高亮与复制。
- 选中句子 → 解释默认进右侧「解释线程」（优先缓存命中，0 token）；一键可「转到对话」深聊。
- 解释必须带上下文：所在段落 + 章节标题 + 页码 + 论文题目（+ 相邻段）。
- 解释按句缓存、按论文留历史、历史可回跳原文；解释过的句子在原文上留淡色标记，点开即旧解释。
- 选中后**不自动**解释：弹小工具条，点「解释」才请求；双击句子 = 直接解释。
- 解释线程默认宽 420px，可在坞内收起；收起时论文占满整坞。
- 不做：扫描版 OCR、EPUB/DOCX、全文翻译、朗读。

## 架构

```
Host 进程（index.js；路由全部挂在 prefix /dsh-paper-reader 下）
  POST /api/docs                     收 PDF（原始字节 / {"path":...}）
       ├─ 落盘 docs/<id>/source.pdf
       ├─ spawn python3 extract.py → structure.json + pages/<n>.json
       └─ 渲染 pages/<n>.png（1.5x）
  GET  /api/docs                     最近论文列表 + UI 状态
  GET  /api/docs/<id>/structure      章节 / 段落 / 句子 / 页元数据
  GET  /api/docs/<id>/pages/<n>      该页逐词坐标（带 paraId）
  GET  /media/<id>/page-<n>.png      页图
  GET  /api/docs/<id>/explanations   历史（含精简索引给标记用）
  POST /api/explain                  {docId, sel, force?} → SSE 流式回答，完成才落盘
  GET/POST /api/ui-state             最近打开的论文、每篇最后页码
  GET  /app/*                        阅读器页面（HTML/JS/CSS，纯静态）
  ctx.llm.stream                     调模型；写入 plugin-data/paper-reader/
        │  同源 fetch / SSE / <img>
        ▼
阅读器页面 /dsh-paper-reader/app/（iframe 内，可独立在浏览器打开）
  [ 论文：页图 + 透明文字层 ]  [ 解释线程：当前句 / 历史 ]
  选中 → 小工具条 → 查缓存 → 命中秒出 / 未命中流式解释 → 标记与历史
        │  postMessage({type:'toChat', payload, mode})
        ▼
DSH 界面里的薄壳 client.js
  左坞 + 拖宽 + 收起 + 布局适配（paddingLeft） + 会话桥
  → conversation.input.for(scope).setDraft(payload) / .submit()
```

### 为什么阅读器是 iframe 而不是 React 组件

- 客户端模块表只保证 `react`；Markdown 渲染、选区几何、虚拟滚动、流式 SSE 用原生 DOM 写更快也更可控。
- 阅读器可独立在浏览器打开（`http://127.0.0.1:<port>/dsh-paper-reader/app/`），开发与验证不依赖 DSH 重启。
- 失败面收窄：布局适配、会话桥接都在薄壳里；阅读器本身是普通网页。
- 同源（同一 loopback 端口），无跨域问题；父窗口与 iframe 用 `postMessage` 通信。

## 三个部件

### 1. 宿主半 `index.js`（Node）

职责：收件、抽取、渲染、路由、缓存、调模型。不写密钥，不越出 `plugin-data/paper-reader/` 读文件。

- 抽取：`spawn(cfg.pythonPath, [extract.py, sourcePath, outDir])`，超时 120s，stdout 只输出一行 JSON 摘要，失败把 stderr 尾部带回接口。
- 页图：抽取脚本内一次性输出，`Matrix(1.5,1.5)`，PNG（CSS 侧再按容器宽缩放；2560 宽的坞里论文约 760px，等于 1.5 倍下采样，文字不糊；放大到 2x 时图像仍够用）。
- 解释：`ctx.llm.stream({ provider, model, system, messages, temperature, maxTokens })`，逐块转成 SSE 给前端；**只在完整结束时落盘**（中途断开不写缓存）。
- 缓存与历史：见下节。
- 宿主半配置（profile `cordis.patch.yml` 覆盖，缺省写在 `index.js` 的 `DEFAULTS`）：

```yaml
- id: paper-reader
  name: '@local/paper-reader'
  config:
    provider: deepseek-official
    model: deepseek-v4-flash        # 难句可切 deepseek-v4-pro
    temperature: 0.3
    maxTokens: 1600
    pythonPath: python3             # 需能 import fitz
    maxUploadMB: 80
    extractTimeoutMs: 120000
```

- 客户端半配置（同一条 patch 行的 `config` 里一并写，`apply(ctx, config)` 读同一份）：

```yaml
# 接上一条 config:
    dockWidthRatio: 0.46            # 坞宽 = clamp(ratio*vw, 720, 1280)
    explanationPaneWidth: 420       # 解释线程默认宽，可在坞内收起
    autoCollapseSidebar: true       # 开坞时收起 DSH 左导航，多出 224px 给聊天
    hideSidebarHandleWhileDocked: true
```

### 2. 阅读器页面 `/app/`（原生 HTML/CSS/JS，零构建）

- `index.html` + `app.js` + `app.css` + `renderer.js`，宿主按路径直接吐出字节（`readFile` 后缓存，`content-type` 明确）。
- 左：论文滚动区。每页一个 `.page`：`<img>` + `.text-layer`（绝对定位的透明 span）。
- 右：解释线程。顶部 tab「当前句 / 历史」；流式时逐字追加；完成后显示模型与时间；按钮「重新解释 / 转到对话 / 复制」。
- 顶栏：论文标题、页码指示、最近论文下拉、拖入区、收起解释栏。
- 空状态：没有论文时显示整块拖入区 + 「最近论文」列表 + 一行提示「也可以把 PDF 路径发给我，我帮你打开」（P3 由工具补齐，P1 先给路径上传接口）。
- 窄态：坞内宽 < 980 时解释线程自动收起为右侧竖条，选中句子后展开为覆盖式抽屉（默认仍保留 420px 分栏，只在窄窗退化）。
- 主题：父窗口 postMessage 下发 `{mode, bg, fg, border, brand}`，阅读器写入 CSS 变量；收不到就用 `prefers-color-scheme`。

### 3. 客户端薄壳 `client.js`（React，无 JSX）

- 注册两个 `shell.overlay` 条目（同 id 前缀）：
  - `paper-reader/dock`：坞本体（iframe + 右侧拖宽把手 + 收起按钮）。
  - `paper-reader/tab`：收起后左边缘的竖排小标签（点开坞）。
- 挂载时找 `document.querySelector('[data-shell-overlay]').parentElement` → 记下原 `paddingLeft` → 写 `paddingLeft = W`。卸载/收起时还原。
- 注入一段作用域限定的 CSS：`[data-side="sidebar"]{display:none}`（左拖拽把手会被 padding 顶到坞正中，坐标错位，故在开坞期间隐藏；关闭即恢复）。右把手坐标不受影响。
- 拖宽：Pointer Events，clamp 到 `[720, min(1280, 0.62*vw)]`，存 `localStorage['dsh.paper-reader.dockWidth']`。
- 会话桥：`postMessage` 收到 `{type:'toChat', payload, mode:'draft'|'send'}` →
  - `const id = ctx.sessions.list.getSnapshot().current`；
  - 无会话：`navigator.clipboard.writeText(payload)` + 提示「已复制，先开一个会话」；
  - `const actx = ctx.sessions.scope(id)`；`ctx.conversation.input.for(actx).setDraft(payload)`；`mode==='send'` 时再 `.submit()`。
  - 桥接 API 若在运行时抛错，退化为 `ctx.conversation.send(payload)`（直接发送），不静默失败。
- 兜底：找不到 `[data-shell-overlay]` 或其父元素时，改为「固定浮层」模式并在坞顶显示一行提示；同时提供「在独立窗口打开」（`window.open('/dsh-paper-reader/app/','paper-reader')`，被拦截则复制链接）。

## 数据模型与文件布局

```
$DSH_HOME/plugin-data/paper-reader/          # 默认 ~/.dsh/plugin-data/paper-reader
├── index.json                  # [{id,title,pageCount,addedAt,lastOpenedAt,lastPage,explained}]
├── docs/<id>/
│   ├── source.pdf
│   ├── structure.json          # {version,id,title,pageCount,pageSizes[],sections[],paras[]}
│   ├── pages/<n>.json          # {words:[[x0,y0,x1,y1,"word",paraId],...]}
│   ├── pages/<n>.png
│   └── explanations.json       # {version, entries:[...]}（追加式，最新在前）
└── tmp/                        # 上传与抽取中间产物，完成即清
```

- `id = sha256(pdf bytes)[:16]`；同文件重复上传直接复用（秒开）。
- `paras[]`：`{id,page,bbox,sectionId,text,sent:[{start,end}]}` —— `sent` 是段内字符区间，切句结果只存这一份，不重复存全局句子表（渲染与历史都用 `paraId + sent 区间` 定位）。
- `sections[]`：优先 `get_toc()`；无目录时按字号（大于正文中位数 1.15 倍）+ 行首编号/常见标题词启发式，最差退化为「第 N 页」。
- 段落合并启发式（v1）：block 内按 line 拼接；相邻 block 若同列、垂直间距 < 1.6 倍行高、上一段不以句末标点结束且下一段不以项目符号起始，则合并；CJK 拼接不加空格，拉丁文加空格。**这是启发式，边界可能偏**；解释时始终带整段与相邻段，降低影响。
- 双栏：若同页存在两组 x 区间互不相交且各自宽度 < 0.6 页宽的文本块，按「左栏自上而下 → 右栏自上而下」排序；否则按块 bbox 自上而下。
- 切句：拉丁文按 `[.!?]` + 后随空白/结尾，中文按 `[。！？；]`；对 `et al.`、`Fig.`、`Eq.`、`No.`、单字母缩写、小数、URL 做保护。同样是启发式，失败时退回整段解释。

## 论文渲染与"每个字可选"

- 宿主给出页尺寸（PDF 点）与逐词 bbox（同一坐标系，原点左上）。
- 客户端：`s = 容器宽 / pageW`；`.page` 固定 `pageW × pageH` 并 `transform: scale(s)`（`transform-origin: top left`），图片与文字层同尺度，因此 bbox 直接用 PDF 单位写 `left/top/width/height`，无需逐词换算。
- 文字层 span：`color: transparent; white-space: pre; font-size: (y1-y0)*0.92px（PDF 单位，随整层一起缩放）; line-height:1;`。不可见但可选、可复制；选区高亮矩形由浏览器按 span 盒绘制，天然贴合原词位置。
- 词间空格：非 CJK 页每个 span 文本为 `word + ' '`（末尾词不加），保证 `getSelection()` 拼回可读文本；CJK 页不加。
- 选区 → 段落：选中词 span 带 `data-para`；取选区两端所在的段落 id 与 `selection.toString()`。跨段落选择时，以**起点所在段落**为上下文，选句文本取完整选区。
- 缩放：坞变宽/拖宽后重算 `s`（ResizeObserver + rAF 节流）；文字层随同缩放。
- 公式/图片区域：PyMuPDF 只对文字块出词，公式若为矢量/位图则没有词——属于"选不中"，是原版面保真的代价，文档中明确标注。
- 已解释标记：段落内命中的句子用 `<span class="mark">` 叠加半透明底（同样按 bbox 定位），点击打开对应历史条目。

## 解释流程与缓存

**流程**：选中 → 「解释」→ `POST /api/explain {docId, sel:{page, paraId, text, sentenceIndex?}, force}` →

1. 归一化选句（折叠空白、连字符断行 `-\n` 还原、弯引号统一、去首尾标点差异）。
2. `key = sha256(docId + '|v1|' + normText + '|' + paraId)`。
3. 命中且非 `force` → 直接返回该条（`hitCount+1`，`lastHitAt` 更新），**不调模型**；响应带 `cached:true` 与 `hitCount`，解释线程顶部显示「缓存命中 · 已解释 N 次」，让"有缓存"是看得见的。
4. 未命中 → 组装上下文块 → `ctx.llm.stream` → SSE 流式回传 → 完整结束后 `explanations.json` 原子写入（tmp + rename）。

**上下文块**（自动拼装，控制长度）：

```
论文：<title>
位置：第 <page> 页 · <section title>
选句：<<< <selected text> >>>
所在段落：<para text>
前一段（截断 400 字）：...
后一段（截断 400 字）：...
```

**配方 v1（system + 固定输出结构）**：输出 Markdown，恰好三节 ——
`### 1. 中译`（整句自然中文，术语保留英文原词）、`### 2. 难点`（术语 / 句法 / 指代关系 / 隐含前提，逐条）、`### 3. 在论证中的位置`（这句在段落与章节里承担什么）。要求：不确定处显式标注「不确定」，不得编造引用。

**条目结构**：

```json
{ "id":"e_<16hex>", "key":"<sha256>", "recipe":"v1",
  "selText":"...", "normText":"...", "docId":"...", "page":3, "paraId":"p12",
  "sectionId":"s2", "contextHash":"<sha256>",
  "provider":"deepseek-official", "model":"deepseek-v4-flash",
  "answer":"<markdown>", "createdAt":"ISO", "hitCount":0, "lastHitAt":null,
  "supersedes":null, "note":null }
```

- 追加式：`force` 重新解释会新增一条 `supersedes=<旧 id>`，取用时按 `createdAt` 取最新；历史里两条都保留（可对比"旧解释 vs 新解释"）。
- 配方升级到 v2 时 key 里 `v1` 变化 → 旧条目照常可读、不再命中，历史里标「旧配方」。

## 历史与回跳

- 解释线程 tab2「历史」：本论文按时间倒序列出 `原句（截断 60 字）· 第 N 页 · 时间`，点击 → 滚到该页、闪一下高亮、在 tab1 打开该条（0 token）。
- 顶栏「最近论文」下拉：切换论文，恢复上次页码。
- P2 可选：全局历史（跨论文）、导出 Markdown（原句 + 上下文 + 解释）、术语表累积。

## 转到对话

阅读器发出：

```
【论文】Attention Is All You Need（第 2 页 · Introduction）
【原文】"……"
【上下文】<所在段落>
【已有解释】<若缓存命中则附上，否则省略>
【我的问题】这句话我还是没读懂，结合上下文再讲一遍
```

薄壳收到后填进当前会话输入框（可编辑，Enter 发送）。P1 只做预填；「直接发送」按钮（`.submit()`）放 P2，避免误点直接烧一轮 token。两个动作都不经过阅读器自己发请求，因此对话里能看到完整上下文与后续追问链。

## 错误处理

| 情况 | 表现 |
|---|---|
| 不是 PDF / 加密 PDF / 超过 `maxUploadMB` | 接口 400，读阅读器顶部红条给出具体原因，不落盘 |
| 纯扫描页（无文字层） | 页图照显示，文字层为空；顶部提示「本页没有文字层，无法选中」；不阻止后续页 |
| python3 缺 PyMuPDF | 启动时探活 `python3 -c "import fitz"`，失败在阅读器里提示安装命令，上传接口直接 503 |
| 抽取超时 / 崩溃 | 500 + stderr 尾部 40 行；tmp 清理，不留半成品 |
| 模型未配置 / 401 / 超时 | 解释线程显示该条错误 + 「重试」；**不写缓存** |
| SSE 中途断开 | 保留已收到的部分文本并标「未完成」，不写缓存，重试覆盖显示 |
| 命中缓存但 `answer` 为空（历史脏数据） | 视为未命中重新解释 |
| `[data-shell-overlay]` 找不到（DSH 改版） | 退化为固定浮层模式，坞顶提示 + 独立窗口入口 |
| 无当前会话（新开窗口还没选会话） | 「转到对话」改为复制到剪贴板并提示 |
| 会话桥 API 抛错 | 退化为 `conversation.send`，仍失败则复制+提示 |

## 测试与验收

夹具：`<fixture>/1706.03762v7.pdf`（15 页、**单栏版式**、22 条 TOC、6095 词、含大量公式与图）。
补充双栏真论文验证：`~/Downloads/AQR JPM Fall 2017.pdf` 第 3/7/14/15 页被判定双栏，阅读顺序为「左栏上→下，再右栏上→下」，段落连贯。

自动化（`node --test`，无需浏览器）：

1. `extract.test.mjs`：跑 `extract.py` → 断言页数 15、sections ≥ 20、paras > 0、每词 bbox 落在页内、每段 `sent` 覆盖全文无空洞、`structure.json` < 2MB、`pages/*.json` 总大小 < 1.5MB、页图 15 张。
2. `cache.test.mjs`：归一化（换行连字符、弯引号、多余空白）落到同 key；`force` 产生 `supersedes` 且取用最新；`hitCount` 递增；配方版本变化不命中。
3. `routes.test.mjs`：用 mock req/res 直调 handler，覆盖 400/404/503 与 content-type。
4. `node --check` 三个 JS 文件、JSON 解析。

人工验收（本会话无浏览器控制能力，必须由用户目视）：

1. 安装到 `desktop` profile → 重启/重算后左边缘出现「论文」标签 → 点开坞，聊天整体右移、未被覆盖。
2. 拖入 `1706.03762v7.pdf` → 5 秒内出现第 1 页；字号、双栏、公式与原 PDF 一致。
3. 选一句 → 小工具条 → 解释 → 流式输出；**再点同一句 → 秒出（0 token）**。
4. 原文上出现淡色标记；点标记 → 弹出旧解释，不请求模型。
5. 历史 tab 点条目 → 跳回该页并高亮。
6. 「转到对话」→ 输入框出现带引文的文本 → Enter → 对话里正常回答。
7. 拖宽/收起坞、切换论文、切会话后桥接仍指向当前会话。
8. 2560 宽与窗口缩到约 1280 宽两档下无横向溢出、聊天仍可正常输入。

## v2 扩展（2026-10-23 第二轮，已实现）

用户在第一版跑通后追加三项：整段翻译、术语表、框选公式看图解释。

### 1. 术语表（零额外调用）

解释配方升到 **recipe v2**：正文三段式之后追加一行机器可读注释
`<!--terms:{"terms":[{"term","zh","note"}]}-->`。宿主在 SSE 流里**扣住**该片段（跨 chunk 安全），
完整结束后解析、从 `answer` 剔除、并入 `docs/<id>/terms.json`。
好处：不增加任何模型调用；坏处：依赖模型遵守格式，解析失败时静默跳过（不影响解释落盘）。
术语按 key 合并、`count` 累加，保留首次出现的页码/段落；`GET /terms` 给列表，
`GET /terms.md` 导出 Markdown 表。老 v1 条目照常可读，只是不产生术语。

### 2. 整段翻译

选中段内任意文字 → 工具条「译本段」→ `POST /api/translate {docId, paraId}`。
原文取 `structure.paras[].text`（不是选区文本），目标语言按 CJK 占比判定（<0.5 → 中文，否则英文）。
输出纯译文，公式符号按原文保留。缓存键与解释分开（`translate-v1`），同一段第二次命中缓存。

### 3. 框选公式 / 图区域解释

**能力边界先说清**：本 profile 的 DeepSeek 适配器是**纯文本**的（`dsh-llm-deepseek/serialize.ts`
会显式拒绝 image 内容块，`UNSUPPORTED_CONTENT`），所以模型**看不到你框的那张图**。

因此实现为「区域文字层 + 上下文」方案：
- Shift + 拖动框选（坐标按页卡 scale 反算回 PDF 点）→ 小工具条确认 → `POST /api/explain-region`；
- 宿主用 PyMuPDF `page.get_text('text', clip=rect)` 抽该区域文字层（矢量公式通常有字形文本，
  例如 `Attention(Q, K, V ) = softmax(QKT √dk )V (1)`）；
- 以与区域相交面积最大的段落作为上下文；
- 结果显示框选区域缩略图（客户端 canvas 从页图裁剪，不上传图片），原文上留淡色矩形框；
- 区域没有文字层（纯图）时，回答会明确说明「只能按上下文推测」，不假装看见了图。

**后续若接入视觉模型**（pi-ai 路由或未来 DeepSeek 多模态），只需把 region 请求从
「文字层」换成「图片块」，其余链路（缓存、历史、缩略图）不变。

## P0 体验层（2026-10-23 第三轮，已实现）

按「市面论文阅读器对照」补齐了阅读基本功，全部本地完成、不依赖外部服务：

- **全文搜索**：`structure.paras[].text` 前端检索，词 bbox 标黄，⌘F/Enter/Esc。
- **目录导航**：`get_toc()` 的章节层级，左侧滑出面板，点章跳转。
- **缩放与快捷键**：70–200% 叠加在自适应宽度上，⌘+/-/0、j/k/g/G/[/]。
- **引用/图表跳转**：抽取阶段用 `page.get_links()` 存 `links.json`（PyMuPDF 会把 named destination 解析成 page/to；
  Attention 一例 113 条，其中 goto 95）；顶栏「链接」开关或 ⌥+点击触发，带返回栈；⌥+点击弹 40% 双开对照。
  老文档首次请求 `/links` 时惰性回填（`extract.py --links-only`，~130ms）。
- **高亮批注 + 导出**：`annotations.json`（宿主原子写、per-doc 串行队列），4 色色块渲染在文字层下方（不挡选词），
  点击命中按坐标判定；`/notes.md` 导出（批注按页分组 + 术语表）。

**已知取舍**：跨页选区只高亮起始页；双开对照只显示目标页页图、不滚动到 `to` 坐标；剪贴板/系统快捷键与 DSH 冲突时以阅读器内快捷键为准。

## 已知取舍与风险

- **左坞依赖布局适配**（给 `AppFrame` 加 `paddingLeft` + 隐藏错位的左拖拽把手）。DSH 大改版可能失效；已设计为单一适配文件 `layout-adapter.js`，失效时只改这里，且有固定浮层 / 独立窗口两条退化路径。
- **不做 OCR**：扫描版可看不可选，明确提示，不假装支持。
- **切句与段落合并是启发式**：偶尔切错；因为解释永远带整段与相邻段上下文，错切的影响有限；历史里可手动「重新解释」。
- **公式选不中**：原版面里公式多为矢量/位图，无文字层。这是保真优先的代价；P2 可考虑「框选区域截图 → 看图解释」作为补充。
- **缓存以论文为域**：同一句话在两篇论文里分别缓存（上下文不同，这是特意的）；重复上传同一文件靠 sha256 复用文档与缓存。
- **iframe 双份 DOM**：内存占用略高，换来阅读器可独立调试与加载器解耦。
- **模型费用**：默认 `deepseek-v4-flash`；命中缓存不花钱；「重新解释」会花钱且明确标注。

## 分期

- **P1（MVP）**：上载→抽取→页图+文字层→选中→缓存优先解释（SSE）→历史与标记→左坞（拖宽/收起/退化）→「转到对话」预填输入框。
- **P2**：「直接发送」与追问链、全局历史、导出 Markdown、术语表累积、框选公式区截图解释。
- **P3**：宿主工具 `paper_reader_open(path)`，让你直接说「打开 ~/Downloads/xxx.pdf」；agent 侧改解释配方/追问链。

## 交付物

- `dsh-paper-reader/`：可安装插件包（host `index.js` + `extract.py` + `app/` 静态页 + `client.js` + `layout-adapter.js` + locale + icon + `cordis.patch.yml` + README）。
- 本文档。
- 自动化测试与结果记录。
- README 写清：安装/卸载、配置项、数据目录、能力边界（不做 OCR、公式选不中、布局适配风险）。
