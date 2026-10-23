# 文献阅读坞（Paper Reader）· DSH 插件

在 DSH 窗口左侧开一条可拖宽的阅读坞：

- **左边读论文**：PDF 按原版面渲染（公式、双栏、图、表不重排），**每个字都能选中、能复制**。
- **选中就解释**：选中读不懂的句子 → 点「解释」→ 右侧解释栏流式给出「中译 / 难点 / 在论证中的位置」三段式，自动带上「论文题目 + 章节 + 页码 + 所在段落 + 前后段」。
- **按句缓存**：同一句再点一次直接秒出，**不调模型、不花钱**；面板上明示「缓存命中 · 已解释 N 次」。
- **按论文留历史**：解释过的句子在原文上留淡色标记，点开即旧解释；历史 tab 可回看、点条目跳回原文定位。
- **转到对话**：一键把「原句 + 上下文 + 已有解释」填进当前 DSH 对话输入框，接着追问。
- **译本段**：选中段内任意文字 → 工具条「译本段」→ 整段译文（自动判中英方向，公式符号保留）。
- **框选公式/图**：Shift + 拖动框住一块区域 → 「解释这块」→ 公式逐符号解释（见下方能力边界）。
- **术语表**：解释时自动累积（同一句模型调用里产出，不额外花钱）→ 第三 tab 可查、可点回原文、可导出 Markdown。

## 它长什么样

阅读坞（左：论文；坞内右：解释栏；再往右是 DSH 自己的导航与对话）：

![左坞布局](../docs/screenshots/dock-layout.png)

选中一句 → 解释带上下文，三段式：

![解释带上下文](../docs/screenshots/explain-with-context.png)

同一句再点一次，命中缓存（0 token）：

![缓存命中](../docs/screenshots/cache-hit.png)

历史与原文标记：

![历史](../docs/screenshots/history.png)

v2 三件套 —— 整段翻译：

![整段翻译](../docs/screenshots/translate.png)

Shift 框选公式 → 缩略图 + 逐符号解释：

![框选公式解释](../docs/screenshots/region-formula.png)

术语表（自动累积，可导出）：

![术语表](../docs/screenshots/glossary.png)

> 截图 1 是布局验收脚本（`scripts/dock-harness.mjs`）在同构的 DSH 框架上跑出来的，中间的导航与对话是占位块；截图 2–4 是真实预览服务器 + 真实模型。

---

## 安装（本机）

插件从本地目录软链进 `desktop` profile，重启一次 DSH 生效：

```bash
cd /Users/echo/Downloads/插件
./dsh-paper-reader/install.sh          # 写入软链 + 在 profile 里登记，幂等，可重复跑
```

然后 **Cmd+Q 退出 DSH 再打开**。装上后输入框工具行里会出现一个「文献」按钮，点它开坞。

卸载：

```bash
./dsh-paper-reader/install.sh --remove
```

（数据目录不会自动删，见下。）

## 不想装也能先看

预览服务器用同一套宿主代码 + 真实模型，直接在浏览器打开阅读器页面：

```bash
cd /Users/echo/Downloads/插件/dsh-paper-reader
REAL_LLM=1 PORT=18080 node tests/serve.mjs
# 打开 http://127.0.0.1:18080/dsh-paper-reader/app/
```

区别：预览页面没有 DSH 主题与「转到对话」桥（那两项要装在 DSH 里），其余（渲染、选区、解释、缓存、历史）完全一致。

## 用法

| 动作 | 结果 |
|---|---|
| 拖 PDF 进页面 / 点「上传 PDF」 | 抽取约 0.7 秒，打开第一页 |
| 拖选中一句 → 工具条「解释」 | 解释栏流式输出；命中缓存则秒出 |
| 双击句子 | 直接解释（跳过工具条） |
| 点原文上的淡色标记 | 打开该句的历史解释（不调模型） |
| 解释栏「重新解释」 | 强制重新调模型，新条目 `supersedes` 旧条目，两条都留在历史 |
| 解释栏「转到对话」 | 文本填进当前 DSH 会话输入框（可改完再发） |
| 顶部「最近论文」 | 切换论文，恢复上次页码 |
| 拖坞的右边界 | 调宽；宽度记在浏览器 localStorage（专注模式下不显示拖拽条） |
| 坞右侧竖条上的 ⤢ | **专注阅读**：坞铺满整窗、主对话被盖住；再点 ⤡ 或按 **Esc** 退出并原样恢复 |
| 坞右侧竖条上的 » | 收起；输入框工具行的「文献」按钮再打开 |

## 配置

宿主半配置写在 `~/.dsh/profiles/desktop/cordis.patch.yml` 的 `paper-reader` 行（缺省值在 `index.js`）：

```yaml
- id: paper-reader
  name: '@local/paper-reader'
  config:
    provider: deepseek-official
    model: deepseek-v4-flash     # 难句可改 deepseek-v4-pro
    temperature: 0.3
    maxTokens: 4096              # 解释/翻译/区域解释的输出上限
    reasoningEffort: 'off'       # 按调用关思考（原因见下）
    pythonPath: python3          # 需能 import fitz（PyMuPDF）
    maxUploadMB: 80
    extractTimeoutMs: 120000
```

客户端半同一条目里还可配：`dockWidthRatio`（0.46）、`dockMinWidth`（720）、`dockMaxWidth`（1280）、`autoCollapseSidebar`（true）。

## 数据

```
~/.dsh/plugin-data/paper-reader/
├── index.json                 # 论文列表
├── ui-state.json              # 上次打开的论文、每篇最后页码
└── docs/<sha256 前 16 位>/
    ├── source.pdf
    ├── structure.json         # 章节 / 段落 / 切句
    ├── pages/<n>.json         # 逐词坐标
    ├── pages/<n>.png          # 1.5x 页图
    └── explanations.json      # 解释与历史（追加式）
```

单篇 15 页论文约 **5.1 MB**（源 PDF 2.1 + 页图 2.7 + 结构 0.3）。清空：`rm -rf ~/.dsh/plugin-data/paper-reader`。

## 实测（本机，夹具 `1706.03762v7.pdf`，15 页）

| 项 | 数字 |
|---|---|
| 抽取（含 15 张 1.5x 页图） | **0.70 s** |
| 段落 / 章节 / 词 | 168 / 23 / 6095 |
| structure.json | 59.5 KB |
| 单篇完整 doc 目录 | 5.09 MB |
| 重复上传同一 PDF | 0.005 s（sha256 命中，不重抽） |
| 第二次解释同一句 | 0 次模型调用（缓存命中 0.019s） |
| 整段翻译一段（真模型） | **0.97–1.3 s**，128 字中文译文 |
| 框选公式（真模型） | **2.5 s**，抽取区域文字层并逐符号解释 |
| 术语表 | 两次解释自动累积 4–6 条，无额外调用 |
| 真实模型解释一句（`deepseek-v4-flash`） | **3.15s**，1085 字，865 tokens（prompt 460 / completion 407） |
| 宿主自动化测试 | `node --test` **77/77** |
| 阅读器纯函数自测 | `node app/fixture/selfcheck.mjs` **48/48** |
| 浏览器端到端（Playwright + 系统 Chrome） | 阅读器主链路 + 左坞布局适配 + 会话桥，**0 console error** |

## 验收状态

**已自动验证**：抽取产物结构（15 页 / 168 段 / 23 章节）、逐词坐标落在页内、切句覆盖无空洞；缓存键归一化与 `supersedes`/`hitCount`；全部 HTTP 错误码与 MIME；上传/重复上传/持久化重启；阅读器渲染 15 页、选区工具条、SSE 流式、缓存命中、原文标记、历史回跳、跨行选词空格；左坞 `padding-left` 右推无覆盖、收起还原、`toChat` 预填会话输入框；真模型三段式回答与 0 调用缓存回放。
v2 追加验证：术语 trailer 在流式里零泄露（含跨 chunk 切分）、术语合并计数、译文目标语言判定、框选坐标反算（滚动/缩放/越界）、region 文字层抽取与缩略图、术语点击跳页、历史三种徽标；真模型下译文 1.3s、公式区域 2.5s、术语自动累积 4 条、同链路缓存重复 0 调用。

**未目视验证**：真实 DSH 窗口内的最终观感（需要重启装载插件）、真人鼠标拖选轨迹、触屏、深色主题下的配色细节。这几项请安装后看一眼，不对我改。

## 关于 maxTokens 与「思考」

DeepSeek 的思考（thinking）token 与正文**共享** `maxTokens`。解释/翻译/区域解释都是结构化输出，不需要思考预算，开着 thinking 时正文会被挤到上限（`finish:max-tokens` → 按设计不写缓存）。
所以三个链路默认按调用传 `reasoningEffort: 'off'`，并把默认上限提到 4096。要更深的分析可以改回：

```yaml
    reasoningEffort: 'high'
    maxTokens: 8000
```

## 能力边界（务必知道）

- **只支持带文字层的 PDF**：扫描件、图片页能显示但选不中，页面会提示「本页没有文字层」。
- **公式/图片区域选不中**：公式多为矢量字形，能看不能选。v2 的「Shift 框选」是**文字层方案**：宿主用 PyMuPDF 按框取该区域的文字层（矢量公式通常有字形文本，例如 `Attention(Q, K, V ) = softmax(QKT √dk )V (1)`）连同上下文交给模型。**模型看不到那张图本身**——本 profile 的 DeepSeek 适配器是纯文本的（会显式拒绝图片内容块）。区域没有文字层（纯图、扫描页）时，回答会明确写「只能按上下文推测」，不假装看见了图。
- **段落与切句是启发式**：绝大多数段落正常（夹具中位数 130 字），但少数 PDF 会把整栏并成一段；解释始终带整段+相邻段上下文，影响有限，可「重新解释」。
- **左坞依赖一层布局适配**：给 DSH 的三栏框架加 `padding-left` 把内容右推，并暂时隐藏错位的左侧拖拽把手。DSH 大改版可能失效——失效时会退化成浮层并给出提示，修复点集中在 `client.js` 的「布局适配」一节。
- **解释走本 profile 的 DeepSeek 路由**，与对话共用同一个 Key 与额度；默认 `deepseek-v4-flash`，缓存命中不花钱。
- **文字层不参与排版**：选中的是 Word 级 span，高亮框按原坐标绘制，因此跨行、跨栏选择都贴合原文。

## 结构

```
dsh-paper-reader/
├── index.js        # 宿主：apply / 路由 / 静态页 / 健康检查
├── ingest.js       # 收件校验、sha256 去重、spawn 抽取
├── store.js        # 路径护栏、原子读写、索引、历史
├── explain.js      # 上下文拼装、recipe v1 提示词、SSE、缓存
├── extract.py      # PyMuPDF 抽取（structure + 逐词坐标 + 页图）
├── client.js       # DSH 薄壳：左坞、拖宽、主题、转到对话
├── app/            # 阅读器页面（原生 HTML/CSS/ES Modules，零构建）
├── tests/          # node --test + 预览服务器 serve.mjs
├── install.sh      # 本地安装/卸载（软链进 profile）
├── CONTRACT.md     # 宿主 ↔ 阅读器的接口契约
└── locale/ icon.svg cordis.patch.yml package.json
```

设计文档：`docs/superpowers/specs/2026-10-23-paper-reader-design.md`
实现计划：`docs/superpowers/plans/2026-10-23-paper-reader.md`
