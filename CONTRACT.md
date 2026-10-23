# 文献阅读坞 — 内部接口契约（v1）

> 这份文件是宿主半（Node/Python）与阅读器页面（`app/`）之间**唯一**的约定。
> 两侧并行开发，任何一方要改字段，先改这里，再改代码。

插件 ID：`@local/paper-reader`。目录：`dsh-paper-reader/`。
所有 HTTP 路由注册在 DSH webServer 的 **prefix** 路由 `/dsh-paper-reader` 之下（loopback、无鉴权、只读 + 本机写）。

## 1. 磁盘布局

```
$DSH_HOME/plugin-data/paper-reader/      # 默认 ~/.dsh/plugin-data/paper-reader
├── index.json                 # 文档索引
├── ui-state.json              # 最近打开的论文 / 每篇最后页码
├── tmp/                       # 上传中 / 抽取中的中间产物
└── docs/<id>/
    ├── source.pdf
    ├── structure.json
    ├── pages/<n>.json
    ├── pages/<n>.png
    ├── page-<n>.png           # 镜像到 pages/ 下，供静态路由直接读
    └── explanations.json
```

`id = sha256(pdf 字节).slice(0,16)`。同一个 PDF 重复上传 → `reused:true`，不重复抽取。

## 2. HTTP 路由

### `GET /api/health`
```json
{ "ok": true, "python": true, "fitz": "1.27.2.2", "provider": "deepseek-official", "model": "deepseek-v4-flash", "storeDir": "..." }
```
`python:false` 或 `fitz:null` 表示抽取不可用（上传接口返回 503）。

### `GET /api/docs`
```json
{ "docs": [ { "id": "a1b2...", "title": "Attention Is All You Need",
              "pageCount": 15, "addedAt": "ISO", "lastOpenedAt": "ISO",
              "lastPage": 3, "explained": 12 } ],
  "ui": { "lastDocId": "a1b2..." } }
```

### `POST /api/docs`
两种请求体，二选一：

- `Content-Type: application/pdf`，body = PDF 字节（上限 `config.maxUploadMB`）。
- `Content-Type: application/json`，body = `{"path":"/Users/echo/Downloads/x.pdf"}`（只接受绝对路径、`.pdf`、存在于本机）。

成功 200：
```json
{ "ok": true, "reused": false, "doc": { "id": "...", "title": "...", "pageCount": 15,
  "addedAt": "ISO", "lastOpenedAt": "ISO", "lastPage": 1, "explained": 0 } }
```
失败（统一形状）：`{ "ok": false, "error": { "code": "...", "message": "中文可读原因" } }`

| HTTP | code | 场景 |
|---|---|---|
| 400 | `not-pdf` | 魔数不是 `%PDF-` |
| 400 | `bad-path` | 路径非法 / 不存在 / 非 .pdf |
| 413 | `too-big` | 超过 `maxUploadMB` |
| 422 | `encrypted` | 加密 PDF（`doc.needs_pass`） |
| 503 | `py-missing` | 找不到 python3 或 `import fitz` 失败 |
| 500 | `extract-failed` | 抽取脚本非零退出（`message` 带 stderr 尾部） |

### `GET /api/docs/<id>/structure`
```json
{ "version": 1, "id": "a1b2", "title": "Attention Is All You Need", "pageCount": 15,
  "pages": [ { "n": 1, "w": 612, "h": 792, "hasText": true } ],
  "sections": [ { "id": "s1", "title": "Introduction", "level": 1, "page": 2,
                  "paraIds": ["p1","p2"] } ],
  "paras": [ { "id": "p1", "page": 2, "bbox": [x0,y0,x1,y1],
               "sectionId": "s1", "text": "原文……", "sent": [[0,120],[121,240]] } ] }
```
- `paras` 按阅读顺序（双栏：左栏上→下，再右栏上→下）。
- `sent` 是**段内字符区间** `[start,end)`，用 `text.slice(start,end)` 取句子。
- `bbox` 是 PDF 点坐标，原点左上。
- 没有文字层的页 `hasText:false`，其 paras 为空。

### `GET /api/docs/<id>/pages/<n>`
```json
{ "n": 2, "columns": "two", "words": [ [x0,y0,x1,y1,"word","p1"], ... ] }
```
- 坐标同 PDF 点、原点左上；`words` 按阅读顺序。
- 非 CJK 页的单词之间**没有**额外空格元素，客户端自己补空格。
- `p1` 是 `structure.paras[].id`，用于选区反查段落。

### `GET /media/<id>/page-<n>.png`
`image/png`，1.5x 渲染（918×1188 量级）。带 `cache-control: max-age=3600`。

### `GET /api/docs/<id>/explanations`
```json
{ "entries": [ { "id": "e_ab12", "key": "<sha256>", "recipe": "v1",
  "selText": "原句", "normText": "归一化原句", "docId": "a1b2", "page": 3, "paraId": "p12",
  "sectionId": "s2", "contextHash": "<sha256>", "provider": "deepseek-official",
  "model": "deepseek-v4-flash", "answer": "markdown", "createdAt": "ISO",
  "hitCount": 3, "lastHitAt": "ISO|null", "supersedes": "e_xxxx|null" } ] }
```
查询参数 `?index=1` 时返回精简版（供原文标记用）：
```json
{ "index": [ { "id":"e_ab12","key":"...","paraId":"p12","page":3,"selText":"原句",
               "sent":[120,260],"kind":"explain","createdAt":"ISO","hitCount":3,"recipe":"v2" } ] }
```
- `sent` 可选：该解释在段落文本里的字符区间 `[start,end)`，用于原文标记精确定位；跨句/跨段等定位不到时不出现，客户端回退为 `selText` 搜索。

### `POST /api/explain`
请求：`{ "docId": "a1b2", "sel": { "page": 3, "paraId": "p12", "text": "选中的句子" }, "force": false }`

响应：`Content-Type: text/event-stream`，每行 `data: <json>\n\n`：

```
data: {"type":"meta","cached":true,"id":"e_ab12","hitCount":3}
data: {"type":"done","entry":{...完整条目...}}

data: {"type":"meta","cached":false,"id":"e_ab13","key":"..."}
data: {"type":"delta","text":"### 1. 中译\n"}
data: {"type":"delta","text":"..."}
data: {"type":"done","entry":{...}}
```
失败：
```
data: {"type":"error","code":"llm-failed","message":"..."}
```
规则：**只有完整成功才落盘**；中途断开不写缓存；`force:true` 时新增一条 `supersedes`。

### `POST /api/translate`
整段翻译。请求：`{ "docId": "...", "paraId": "p16", "force": false }`
响应与 `/api/explain` 完全相同的 SSE 事件形状；`meta` 里 `kind:"translate"`，
`done.entry.kind = "translate"`、`done.entry.paraId` 为目标段落。
目标语言自动判定：段落 CJK 占比 < 0.5 → 译成中文；≥ 0.5 → 译成英文。
输出为纯 Markdown 译文（无三段式、无解说），公式符号按原文保留。

### `POST /api/explain-region`
框选区域（公式/图）解释。请求：
`{ "docId": "...", "page": 4, "rect": [x0,y0,x1,y1], "force": false }`（rect 为 PDF 点坐标，原点左上）
响应同上 SSE；`meta.kind = "region"`；`done.entry.kind = "region"`，并带 `rect` 与 `regionText`。
宿主用 PyMuPDF 的 `clip` 抽取该区域文字层，并用与区域相交最多的段落作为上下文。
区域没有文字层时不报错，模型只能依据上下文推测（回答里会说明）。

### `GET /api/docs/<id>/terms`
术语表（由解释结果自动累积）。
```json
{ "terms": [ { "key":"transduction","term":"Transduction","zh":"转导","note":"把输入序列映射为另一序列的任务",
               "count":2,"page":2,"paraId":"p16","firstEntryId":"e_ab12","updatedAt":"ISO" } ] }
```
`count` 是该术语在本论文解释里出现的次数；按 `count` 降序、`updatedAt` 降序。

### `GET /api/docs/<id>/terms.md`
`text/markdown; charset=utf-8`，术语表导出（标题 = 论文名，表格：术语 / 中文 / 说明 / 出现次数）。

### `GET/POST /api/ui-state`
```json
{ "lastDocId": "a1b2", "perDoc": { "a1b2": { "lastPage": 3, "scrollTop": 812 } } }
```
POST 同样的形状（浅合并写入）。

### `GET /app/*`
静态文件：`index.html`、`styles.css`、`app.js`、`paper.js`、`explain.js`、`bridge.js`。
MIME：`.html→text/html; charset=utf-8`、`.css→text/css; charset=utf-8`、`.js→text/javascript; charset=utf-8`。
未知文件 404。全部 `cache-control: no-store`（开发期优先正确性）。

## 3. 父子窗口消息（iframe ↔ DSH 薄壳）

全部通过 `window.postMessage(message, location.origin)`，每条消息带 `source` 字段。

阅读器 → 宿主薄壳：
```js
{ source: 'pr-app', type: 'ready' }                                  // iframe 启动，请求主题与状态
{ source: 'pr-app', type: 'toChat', payload: '<完整中文文本>', mode: 'draft' | 'send' }
{ source: 'pr-app', type: 'height', opened: true }                   // 坞已开（薄壳据此收侧栏）
```

薄壳 → 阅读器：
```js
{ source: 'pr-host', type: 'init', theme: { mode:'dark'|'light', bg:'#..', fg:'#..',
    muted:'#..', border:'#..', brand:'#..', hover:'#..' } }
{ source: 'pr-host', type: 'theme', theme: {...} }                    // 主题变化时重发
{ source: 'pr-host', type: 'chat-ack', ok: true, mode: 'draft'|'send' }
{ source: 'pr-host', type: 'chat-ack', ok: false, reason: 'no-session' }
{ source: 'pr-host', type: 'ping' }                                   // 薄壳探活，阅读器回 'ready'
```

`toChat.payload` 的固定格式（阅读器负责拼）：

```
【论文】<title>（第 <page> 页 · <section>）
【原文】"<selText>"
【上下文】<所在段落全文>
【已有解释】<answer 或省略此行>
【我的问题】这句话我还是没读懂，结合上下文再讲一遍
```

## 4. 主题色

薄壳从 DSH 的 `--dsw-alias-*` 变量取色（`getComputedStyle(document.documentElement)`），下发给 iframe：

| 字段 | DSH 变量（取不到时的回退） |
|---|---|
| `bg` | `--dsw-alias-bg-base` / `#ffffff` |
| `fg` | `--dsw-alias-label-primary` / `#1a1a1a` |
| `muted` | `--dsw-alias-label-secondary` / `#6b6b6b` |
| `border` | `--dsw-alias-border-l1` / `rgba(0,0,0,.1)` |
| `brand` | `--dsw-alias-brand-primary` / `#4d6bfe` |
| `hover` | `--dsw-alias-bg-layer-2` / `rgba(0,0,0,.04)` |

阅读器把值写进 `document.documentElement.style` 的 `--pr-*` 自定义属性。

## 5. 归一化与缓存键（宿主半唯一实现）

```
norm(text) = text
  .replace(/-\s*\n\s*/g, '')      // 行尾连字符断行还原
  .replace(/[\u2018\u2019\u201C\u201D]/g, "'")   // 弯引号统一（双引号统一为 '）
  .replace(/\s+/g, ' ')
  .trim()
key = sha256(docId + '|' + recipe + '|' + norm(text) + '|' + paraId)
```
`recipe = 'v2'`（解释）、`translate-v1`（整段翻译）、`region-v1`（框选区域）。改提示词必须同时升版本号。

三类缓存键：
```
explain   : sha256(docId + '|v2|' + norm(selection) + '|' + paraId)
translate : sha256(docId + '|translate-v1|' + paraId + '|' + sha1(paraText))
region    : sha256(docId + '|region-v1|' + page + '|' + rectRound1pt + '|' + sha1(regionText))
```

## 6. 解释提示词（recipe v1）

system：
```
你是一位耐心的学术论文阅读助教，帮助中文母语读者读懂英文/中文学术论文。
只依据给出的论文片段作答，不要引入片段之外的文献或事实。不确定的地方明确写「不确定」。
输出 Markdown，必须且只能包含三节：
### 1. 中译
（把「选句」整句译成通顺中文；专业术语保留英文原词，格式：中文（English））
### 2. 难点
（逐条列出：术语含义 / 句法结构 / 指代关系 / 隐含前提。每条 1-3 行，不要空话）
### 3. 在论证中的位置
（2-4 行：这句话在所在段落和章节里承担什么作用，和上下文怎么衔接）
不要输出开场白、总结、免责声明。

正文结束后，另起一行输出且仅输出这一行机器可读注释（供术语表累积，用户看不到）：
<!--terms:{"terms":[{"term":"英文原词或符号","zh":"中文译名","note":"一句话说明"}]}-->
术语取本节解释里真正影响理解的 1-4 个；没有就给 {"terms":[]}。
```
> 版本：`recipe = "v2"`。宿主会在流式输出里扣住 `<!--terms:` 起点到 `-->` 结束的片段，
> 不把它发给客户端；完整结束后解析、从 `answer` 里剔除，并把术语并入 `terms.json`。
> 解析失败不影响解释落盘（`terms` 视为空）。

user：
```
论文：{title}
位置：第 {page} 页 · {section}
选句：<<<{selection}>>>
所在段落：{paraText}
前一段：{prevPara or "（无）"}
后一段：{nextPara or "（无）"}
```
长度控制：`paraText` 原样（超 2000 字截断），前后段各截断 600 字。

调用：`ctx.llm.stream({ provider, model, system, messages:[{role:'user', content:[{type:'text',text:userText}]}], temperature, maxTokens })`。

## 7. 抽取脚本 CLI

```
python3 extract.py <source.pdf> <outDir>
```
- stdout：**一行** JSON 摘要
  `{"ok":true,"pageCount":15,"paras":123,"sections":22,"words":6095,"warnings":[]}`
- 失败：`{"ok":false,"code":"encrypted|bad-pdf|no-text|py-error","message":"..."}` 并以非零码退出。
- 写出：`<outDir>/structure.json`、`<outDir>/pages/<n>.json`、`<outDir>/pages/<n>.png`。
- 页图：`page.get_pixmap(matrix=fitz.Matrix(1.5,1.5))` → PNG。
- 加密 PDF：`doc.needs_pass` → `code:"encrypted"`。

## 8. 客户端薄壳与宿主半的约定

- 薄壳不直接读写 `plugin-data`，一切经 HTTP。
- 薄壳只做：布局适配、iframe、拖宽/收起、专注模式（铺满整窗 + Esc 退出）、主题下发、`toChat` 桥接。
- 专注模式只改薄壳自己的面板几何（`padding-left` 归零、面板 `left/right:0`），不改 DSH 列宽状态；退出即恢复原宽度。
- 阅读器不假设自己嵌在 DSH 里：独立打开时 `window.parent === window`，此时禁用「转到对话」并提示「需在 DSH 窗口中使用」。
