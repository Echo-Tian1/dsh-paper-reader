/**
 * fixture/selfcheck.mjs — 阅读器页面的静态断言 + 纯函数单测（不启动浏览器）。
 *
 * 运行：
 *   node dsh-paper-reader/app/fixture/selfcheck.mjs
 *
 * 覆盖：
 *   1. index.html 结构 / 无外部依赖 / fixture 开关；
 *   2. styles.css 关键规则；
 *   3. Markdown 渲染（含 HTML 转义）、SSE 解析（跨 chunk / \r\n / 坏 JSON）、
 *      toChat payload 格式、选区定位 / 词对齐 / 标记框（纯函数）；
 *   4. fixture 数据自洽（词序列 join 等于段落原文、坐标在页内、PNG 魔数）；
 *   5. CONTRACT 端点字符串与 postMessage 契约字段。
 *
 * 不覆盖：真实 DOM 渲染、真实鼠标选区、真实 SSE 网络流（这些需要浏览器，见交付说明）。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

import {
  renderMarkdown,
  createSSEParser,
  buildChatPayload,
  sortHistory,
  resolveKind,
  kindLabel,
  isOldRecipe,
  stripMachineComment,
  termMetaParts,
  threadActionState,
} from '../explain.js';
import {
  locateRange,
  alignWordOffsets,
  markBoxes,
  isCJKText,
  wordTextFor,
  clientToPdf,
  normalizeRegionRect,
  rectFromPoints,
  thumbnailCrop,
  regionSizeLabel,
  selectionActionState,
} from '../paper.js';
import { embedded, post } from '../bridge.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const read = (rel) => readFileSync(path.join(APP, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (err) {
    results.push({ name, ok: false, error: err });
  }
}

const html = read('index.html');
const css = read('styles.css');
const appJs = read('app.js');
const paperJs = read('paper.js');
const explainJs = read('explain.js');
const bridgeJs = read('bridge.js');
const mockJs = read('fixture/mock.js');

// ---------- 1. index.html ----------

check('index.html 有模块入口与样式表', () => {
  assert.match(html, /<script type="module" src="app\.js"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="styles\.css">/);
});

check('index.html 具备全部必需挂载点', () => {
  const ids = [
    'topbar', 'doc-title', 'page-indicator', 'docs-select', 'upload-btn', 'file-input',
    'paper-scroll', 'paper-content', 'empty-state', 'recent-list',
    'explain-pane', 'tab-current', 'tab-history', 'pane-current', 'pane-history',
    'thread', 'history-list', 'selection-toolbar', 'errorbar', 'error-retry',
    'toast', 'busy', 'drawer-backdrop', 'pane-toggle', 'pane-close', 'drop-overlay',
  ];
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `缺少 #${id}`);
});

check('index.html 无任何 CDN / 外部资源；favicon 内联避免 404', () => {
  assert.ok(!/https?:\/\//.test(html), 'index.html 出现绝对 URL');
  assert.ok(!/\b(cdn|unpkg|jsdelivr)\b/i.test(html));
  assert.ok(html.includes('<link rel="icon" href="data:,">'), '缺少内联 favicon');
});

// ---------- 2. styles.css ----------

check('styles.css 有 --pr-* 主题变量与深色回退', () => {
  for (const token of ['--pr-bg', '--pr-fg', '--pr-muted', '--pr-border', '--pr-brand', '--pr-hover']) {
    assert.ok(css.includes(token), `缺少 ${token}`);
  }
  assert.match(css, /prefers-color-scheme:\s*dark/);
});

check('styles.css 有文字层 / 页卡 / 标记 / 窄态规则', () => {
  assert.match(css, /\.text-layer span\s*\{/);
  assert.match(css, /color:\s*transparent/);
  assert.match(css, /white-space:\s*pre/);
  assert.match(css, /transform-origin:\s*top left/);
  assert.match(css, /\.marks-layer\s*\{/);
  assert.match(css, /pointer-events:\s*auto/);
  assert.match(css, /\.app\.narrow \.explain-pane\s*\{/);
});

// ---------- 3. 前端契约字符串 ----------

check('app.js 的 HTTP 端点全部带 /dsh-paper-reader 前缀', () => {
  assert.ok(appJs.includes("const API_BASE = '/dsh-paper-reader'"), '缺少 API_BASE 常量');
  for (const endpoint of [
    '/api/health', '/api/docs', '/api/explain', '/api/ui-state',
    'explanations?index=1', 'application/pdf', '/media/',
  ]) {
    assert.ok(appJs.includes(endpoint), `app.js 缺少 ${endpoint}`);
  }
  // 不允许出现以站点根开头的 API 请求（会被宿主 404）
  assert.ok(!/fetch\('\/api\//.test(appJs), 'app.js 存在未加前缀的 fetch(\'/api/...\')');
  assert.ok(!/pageImageUrl[\s\S]{0,160}`\/media\//.test(appJs), '页图 URL 未加前缀');
  assert.ok(/pageImageUrl[\s\S]{0,200}API_BASE/.test(appJs), 'pageImageUrl 未使用 API_BASE');
});

check('app.js 有 fixture 开关（正式逻辑不硬编码 fixture）', () => {
  assert.match(appJs, /params\.get\('fixture'\)\s*===\s*'1'/);
  assert.match(appJs, /import\('\.\/fixture\/mock\.js'\)/);
  assert.ok(!/fixture\/structure\.json/.test(appJs), '正式逻辑不应直接引用 fixture 数据');
});

check('app.js 覆盖 v2 新端点（translate / explain-region / terms）', () => {
  for (const token of ['/api/translate', '/api/explain-region', '/terms', 'termsMdUrl', 'translateStream', 'explainRegionStream', 'getTerms']) {
    assert.ok(appJs.includes(token), `app.js 缺少 ${token}`);
  }
  assert.ok(!/fetch\('\/api\//.test(appJs));
});

check('index.html 有术语 tab / 框选工具条 / 缩略图容器', () => {
  for (const id of ['tab-terms', 'pane-terms', 'terms-list', 'terms-export', 'region-toolbar']) {
    assert.ok(html.includes(`id="${id}"`), `index.html 缺少 #${id}`);
  }
  assert.ok(html.includes('region-shortcut'), 'index.html 缺少 Shift+拖动 提示');
  assert.ok(html.includes('data-region-act="explain"'));
  assert.ok(html.includes('data-act="translate"'));
});

check('styles.css 有框选 / 区域标记 / 缩略图 / 术语样式', () => {
  for (const token of ['.region-layer', '.region-box', '.region-mark', '.thread-thumb', '.terms-item', '.region-dragging']) {
    assert.ok(css.includes(token), `styles.css 缺少 ${token}`);
  }
});

check('paper.js 实现 Shift 框选与坐标换算', () => {
  assert.ok(paperJs.includes('pointerdown'));
  assert.ok(paperJs.includes('event.shiftKey'));
  assert.ok(paperJs.includes('clientToPdf'));
  assert.ok(paperJs.includes('regionThumbnail'));
  assert.ok(paperJs.includes('flashRegion'));
});

check('paper.js 用 data-para + 容器 scale 渲染', () => {
  assert.ok(paperJs.includes('data-para'));
  assert.match(paperJs, /transform\s*=\s*`scale\(\$\{s\}\)`/);
  assert.ok(paperJs.includes('fontSize'));
});

check('bridge.js 实现 postMessage 契约与独立模式', () => {
  assert.ok(bridgeJs.includes("'pr-app'"));
  assert.ok(bridgeJs.includes("'pr-host'"));
  assert.ok(bridgeJs.includes('location.origin'));
  assert.ok(bridgeJs.includes("'toChat'"));
  assert.ok(bridgeJs.includes('chat-ack'));
  assert.ok(bridgeJs.includes('window.parent !== window'));
  assert.equal(embedded, false, 'Node 里应视作独立模式');
  assert.equal(post('ready'), false, '独立模式 post 应返回 false 而不抛错');
});

check('explain.js 实现 SSE 事件与缓存态文案', () => {
  for (const token of ["'meta'", "'delta'", "'done'", "'error'", '缓存命中 · 已解释', '重新解释', '转到对话']) {
    assert.ok(explainJs.includes(token), `explain.js 缺少 ${token}`);
  }
  assert.ok(explainJs.includes('getReader'));
});

check('无第三方 import / 构建依赖', () => {
  for (const source of [appJs, paperJs, explainJs, bridgeJs, mockJs]) {
    assert.ok(!/from\s+['"]https?:/.test(source));
    assert.ok(!/\brequire\(/.test(source));
  }
});

// ---------- 4. 纯函数：Markdown ----------

check('Markdown：先转义再渲染（防注入）', () => {
  const out = renderMarkdown('<img src=x onerror="alert(1)"> **粗**');
  assert.ok(out.includes('&lt;img'), out);
  assert.ok(!out.includes('<img'), out);
  assert.ok(out.includes('<strong>粗</strong>'), out);
});

check('Markdown：标题 / 斜体 / 代码 / 列表 / 段落 / 换行', () => {
  assert.match(renderMarkdown('### 1. 中译'), /<h4>1\. 中译<\/h4>/);
  assert.match(renderMarkdown('*斜体* 与 `code`'), /<em>斜体<\/em> 与 <code>code<\/code>/);
  assert.match(renderMarkdown('- a\n- b'), /<ul>\n<li>a<\/li>\n<li>b<\/li>\n<\/ul>/);
  assert.match(renderMarkdown('1. a\n2. b'), /<ol>\n<li>a<\/li>\n<li>b<\/li>\n<\/ol>/);
  assert.match(renderMarkdown('第一行\n第二行'), /<p>第一行<br>第二行<\/p>/);
  assert.match(renderMarkdown('段一\n\n段二'), /<\/p>\n<p>/);
  assert.equal(renderMarkdown(''), '');
});

// ---------- 5. 纯函数：SSE 解析 ----------

check('SSE：跨 chunk 截断 / 多事件 / \\r\\n / 坏 JSON / 注释行', () => {
  const events = [];
  const parser = createSSEParser((ev) => events.push(ev));
  parser.feed('data: {"type":"del');
  parser.feed('ta","text":"你好"}\r\n\r\n');
  parser.feed('data: {"type":"meta","cached":true}\n\ndata: {"type":"done","entry":{"id":"e1"}}\n\n');
  parser.feed(': keep-alive\n\n');
  parser.feed('data: {not json}\n\n');
  parser.feed('data: {"type":"error","code":"x","message":"y"}\n\n');
  parser.flush();
  assert.deepEqual(events, [
    { type: 'delta', text: '你好' },
    { type: 'meta', cached: true },
    { type: 'done', entry: { id: 'e1' } },
    { type: 'error', code: 'x', message: 'y' },
  ]);
});

check('SSE：flush 处理没有结尾空行的残片', () => {
  const events = [];
  const parser = createSSEParser((ev) => events.push(ev));
  parser.feed('data: {"type":"delta","text":"尾"}');
  assert.equal(events.length, 0);
  parser.flush();
  assert.deepEqual(events, [{ type: 'delta', text: '尾' }]);
});

// ---------- 6. 纯函数：toChat payload ----------

check('toChat payload 与 CONTRACT §3 固定格式一致', () => {
  const payload = buildChatPayload({
    title: 'Attention Is All You Need',
    page: 2,
    section: 'Introduction',
    selText: 'This is a sentence.',
    paraText: 'Para text here.',
    answer: '已解释内容',
  });
  assert.equal(
    payload,
    [
      '【论文】Attention Is All You Need（第 2 页 · Introduction）',
      '【原文】"This is a sentence."',
      '【上下文】Para text here.',
      '【已有解释】已解释内容',
      '【我的问题】这句话我还是没读懂，结合上下文再讲一遍',
    ].join('\n')
  );
  const noAnswer = buildChatPayload({ title: 'T', page: 1, selText: 'S', paraText: 'P' });
  assert.ok(!noAnswer.includes('【已有解释】'));
  assert.ok(noAnswer.startsWith('【论文】T（第 1 页）'));
});

check('历史排序：最新在前', () => {
  const sorted = sortHistory([
    { id: 'a', createdAt: '2026-01-01T00:00:00Z' },
    { id: 'b', createdAt: '2026-03-01T00:00:00Z' },
    { id: 'c', createdAt: '2026-02-01T00:00:00Z' },
  ]);
  assert.deepEqual(sorted.map((e) => e.id), ['b', 'c', 'a']);
});

// ---------- 7. 纯函数：选区 → 标记（用 fixture 数据） ----------

const structure = readJson('fixture/structure.json');
const page1 = readJson('fixture/pages/1.json');
const page2 = readJson('fixture/pages/2.json');
const indexPayload = readJson('fixture/explanations-index.json');
const paraById = new Map(structure.paras.map((p) => [p.id, p]));
const wordsOf = (page, paraId) => (page.words || []).filter((w) => w[5] === paraId);

check('fixture 自洽：同段词序列 join 等于段落原文', () => {
  for (const para of structure.paras) {
    const page = para.page === 1 ? page1 : page2;
    const words = wordsOf(page, para.id);
    assert.ok(words.length > 0, `${para.id} 没有词`);
    assert.equal(words.map((w) => w[4]).join(' '), para.text, `${para.id} 词序列与原文不一致`);
  }
});

check('fixture 自洽：坐标在页内、sent 无缝覆盖全文', () => {
  for (const para of structure.paras) {
    const pageMeta = structure.pages.find((p) => p.n === para.page);
    const page = para.page === 1 ? page1 : page2;
    for (const word of wordsOf(page, para.id)) {
      assert.ok(word[0] >= 0 && word[1] >= 0 && word[2] <= pageMeta.w && word[3] <= pageMeta.h);
    }
    let cursor = 0;
    for (const [start, end] of para.sent) {
      assert.equal(start, cursor, `${para.id} sent 有空洞`);
      assert.ok(end > start && end <= para.text.length);
      cursor = end;
    }
    assert.equal(cursor, para.text.length, `${para.id} sent 未覆盖全文`);
  }
});

check('locateRange：精确 / 折叠空白 / 句区间退化', () => {
  const para = paraById.get('p1');
  const sentence = para.text.slice(para.sent[0][0], para.sent[0][1]).trim();
  const exact = locateRange(para.text, para.sent, sentence);
  assert.ok(exact, '精确选句应能定位');
  assert.equal(exact[0], 0);
  assert.equal(para.text.slice(exact[0], exact[1]).trim(), sentence);

  const spaced = sentence.replace(/ /g, '   ');
  const collapsed = locateRange(para.text, para.sent, spaced);
  assert.ok(collapsed, '多空白选句应能定位');
  assert.equal(collapsed[0], 0);

  const partial = para.text.slice(10, 40);
  const viaSent = locateRange(para.text, para.sent, partial);
  assert.ok(viaSent, '局部选句应退化到句区间');
  assert.equal(viaSent[0], 0);
  assert.equal(viaSent[1], para.sent[0][1]);

  assert.equal(locateRange('abc', [], 'zzz'), null);
});

check('alignWordOffsets：fixture 每段全部词可对齐', () => {
  for (const para of structure.paras) {
    const page = para.page === 1 ? page1 : page2;
    const words = wordsOf(page, para.id);
    const aligned = alignWordOffsets(para.text, words);
    assert.equal(aligned.length, words.length);
    aligned.forEach((range, i) => {
      assert.ok(range, `${para.id} 第 ${i} 个词未对齐`);
      assert.equal(para.text.slice(range[0], range[1]), words[i][4]);
    });
  }
});

check('markBoxes：已解释句在页内产生标记框', () => {
  for (const entry of indexPayload.index) {
    const para = paraById.get(entry.paraId);
    const page = para.page === 1 ? page1 : page2;
    const boxes = markBoxes(para, wordsOf(page, para.id), entry.selText);
    assert.ok(boxes.length >= 1, `${entry.id} 没有标记框`);
    for (const box of boxes) {
      assert.ok(box.width > 0 && box.height > 0);
      assert.ok(box.left >= 0 && box.top >= 0);
      assert.ok(box.left + box.width <= 612 + 1 && box.top + box.height <= 792 + 1);
    }
  }
});

check('markBoxes：定位失败时退回整段 bbox（可点击）', () => {
  const para = paraById.get('p1');
  const boxes = markBoxes(para, wordsOf(page1, para.id), '这段话在原文里根本不存在');
  assert.ok(boxes.length >= 1);
});

check('文字层词尾空格：非 CJK 一律补，连字符 / 下一词 CJK 例外', () => {
  const w = (word, para = 'p1') => [0, 0, 10, 10, word, para];
  assert.equal(wordTextFor([w('Hello'), w('world')], 0), 'Hello ');
  // 跨段 / 段尾也补空格（防止复制时粘连）
  assert.equal(wordTextFor([w('end', 'p1'), w('Next', 'p2')], 0), 'end ');
  assert.equal(wordTextFor([w('last')], 0), 'last ');
  // 连字符断行不补
  assert.equal(wordTextFor([w('trans-'), w('former')], 0), 'trans-');
  // 下一个词是 CJK 不补
  assert.equal(wordTextFor([w('Hello'), w('中文')], 0), 'Hello');
  // CJK 词本身不补
  assert.equal(wordTextFor([w('中文'), w('模型')], 0), '中文');
  assert.equal(wordTextFor([], 0), '');
});

check('fixture 用 wordTextFor 拼回的选区文本等于段落原文', () => {
  for (const para of structure.paras) {
    const page = para.page === 1 ? page1 : page2;
    const words = wordsOf(page, para.id);
    const joined = words.map((_, i) => wordTextFor(words, i)).join('');
    assert.equal(normalizeJoined(joined), para.text, `${para.id} 选区文本与原文不一致`);
  }
  function normalizeJoined(text) {
    return String(text).replace(/\s+/g, ' ').trim();
  }
});

check('CJK 判定', () => {
  assert.equal(isCJKText('中文'), true);
  assert.equal(isCJKText('attention'), false);
  assert.equal(isCJKText('注意力 attention'), true);
});

// ---------- 8. fixture 资源 ----------

check('fixture 页面 PNG 存在且是 PNG（魔数）', () => {
  for (const n of [1, 2, 3]) {
    const file = path.join(APP, `fixture/page-${n}.png`);
    assert.ok(existsSync(file), `缺少 page-${n}.png`);
    const buf = readFileSync(file);
    assert.deepEqual([...buf.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], `page-${n}.png 不是 PNG`);
    assert.ok(statSync(file).size > 1000);
  }
});

check('fixture 无文字层页 hasText=false 且 words 为空', () => {
  const meta = structure.pages.find((p) => p.n === 3);
  assert.equal(meta.hasText, false);
  assert.equal(readJson('fixture/pages/3.json').words.length, 0);
});

check('fixture mock 覆盖全部客户端 API', () => {
  for (const method of [
    'listDocs', 'upload', 'getStructure', 'getPage', 'pageImageUrl',
    'getIndex', 'getExplanations', 'explainStream', 'translateStream', 'explainRegionStream',
    'getTerms', 'termsMdUrl', 'postUiState', 'getUiState', 'health',
  ]) {
    assert.ok(new RegExp(`\\b${method}\\s*\\(`).test(mockJs), `mock 缺少 ${method}`);
  }
  assert.ok(mockJs.includes("cached: true"));
});

// ---------- v2 纯函数：框选坐标 ----------

check('clientToPdf：屏幕坐标 → PDF 点（含滚动偏移 / 缩放 / 越界钳制）', () => {
  // 页 612×792 显示宽 306（scale 0.5），页面在视口 left=100 top=50
  const pageEl = {
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 306, height: 396 }),
  };
  const mid = clientToPdf(pageEl, 253, 248, 612, 792);
  assert.equal(mid.x, 306);
  assert.equal(mid.y, 396);

  // 滚动：页面往上滚了 250px（rect.top 变负），clientY 48 → (48+200)/0.5=496
  const scrolled = { getBoundingClientRect: () => ({ left: 100, top: -200, width: 306, height: 396 }) };
  const scrolledPoint = clientToPdf(scrolled, 253, 48, 612, 792);
  assert.equal(scrolledPoint.x, 306);
  assert.equal(scrolledPoint.y, 496);

  // 窗口放大：1.5x 显示（918 宽），同样 clientX 相对左边缘 459 → pdf 306
  const zoomed = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 918, height: 1188 }) };
  const zoomedPoint = clientToPdf(zoomed, 459, 594, 612, 792);
  assert.equal(zoomedPoint.x, 306);
  assert.equal(zoomedPoint.y, 396);

  // 越界钳制 + 尺寸为 0 的保护
  assert.deepEqual(clientToPdf(pageEl, 0, 0, 612, 792), { x: 0, y: 0 });
  assert.deepEqual(clientToPdf(pageEl, 9999, 9999, 612, 792), { x: 612, y: 792 });
  assert.deepEqual(clientToPdf({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) }, 10, 10, 612, 792), { x: 0, y: 0 });
});

check('rectFromPoints：反向拖动归一化 + 太小取消（<8pt）', () => {
  const normal = rectFromPoints({ x: 100, y: 120 }, { x: 40, y: 60 });
  assert.deepEqual(normal.rect, [40, 60, 100, 120]);
  assert.equal(normal.tooSmall, false);

  const tiny = rectFromPoints({ x: 100, y: 100 }, { x: 103, y: 130 });
  assert.equal(tiny.tooSmall, true);
  const thin = rectFromPoints({ x: 100, y: 100 }, { x: 160, y: 105 });
  assert.equal(thin.tooSmall, true);
  const edge = rectFromPoints({ x: 0, y: 0 }, { x: 8, y: 8 });
  assert.equal(edge.tooSmall, false);
});

check('normalizeRegionRect / regionSizeLabel', () => {
  assert.deepEqual(normalizeRegionRect([10.26, 20.24, 5, 8]), [5, 8, 10.3, 20.2]);
  assert.equal(normalizeRegionRect('[1,2,3,4]'), null);
  assert.equal(normalizeRegionRect([1, 2, 3]), null);
  assert.equal(normalizeRegionRect([1, NaN, 3, 4]), null);
  assert.equal(regionSizeLabel([10, 20, 110, 80]), '100×60 pt');
  assert.equal(regionSizeLabel(null), '');
});

check('thumbnailCrop：1.5x 页图裁剪 source 矩形', () => {
  // 612×792 PDF 点，页图 918×1188（1.5x）
  const crop = thumbnailCrop([0, 0, 306, 396], 612, 792, 918, 1188);
  assert.deepEqual(crop, { sx: 0, sy: 0, sw: 459, sh: 594 });
  const offset = thumbnailCrop([100, 200, 300, 400], 600, 800, 900, 1200);
  assert.equal(offset.sx, 150);
  assert.equal(offset.sy, 300);
  assert.equal(offset.sw, 300);
  assert.equal(offset.sh, 300);
  assert.equal(thumbnailCrop([0, 0, 0, 0], 612, 792, 918, 1188).sw >= 1, true);
  assert.equal(thumbnailCrop([0, 0, 1, 1], 0, 792, 918, 1188), null);
});

check('selectionActionState：选区工具条按钮启用态', () => {
  const none = selectionActionState(null);
  assert.deepEqual(none, { explain: false, translate: false, copy: false, cancel: true });
  const textOnly = selectionActionState({ text: 'hello', paraId: '' });
  assert.deepEqual(textOnly, { explain: true, translate: false, copy: true, cancel: true });
  const para = selectionActionState({ text: 'hello', paraId: 'p1' });
  assert.equal(para.translate, true);
});

// ---------- v2 纯函数：kind / 术语 / 状态机 ----------

check('resolveKind：meta 优先、entry 兜底、未知/缺失视为 explain', () => {
  assert.equal(resolveKind({ kind: 'translate' }, null), 'translate');
  assert.equal(resolveKind(null, { kind: 'region' }), 'region');
  assert.equal(resolveKind({ kind: 'translate' }, { kind: 'region' }), 'translate');
  assert.equal(resolveKind(null, null), 'explain');
  assert.equal(resolveKind({ kind: 'weird' }, null), 'explain');
  assert.equal(resolveKind(null, { kind: 'explain' }), 'explain');
});

check('kindLabel / isOldRecipe：历史徽标与旧配方', () => {
  assert.equal(kindLabel('explain'), '解释');
  assert.equal(kindLabel('translate'), '翻译');
  assert.equal(kindLabel('region'), '公式');
  assert.equal(kindLabel(undefined), '解释');
  assert.equal(isOldRecipe('v1', 'explain'), true);
  assert.equal(isOldRecipe('v2', 'explain'), false);
  assert.equal(isOldRecipe('translate-v1', 'translate'), false);
  assert.equal(isOldRecipe('v1', 'translate'), true);
  assert.equal(isOldRecipe('region-v1', 'region'), false);
  assert.equal(isOldRecipe(undefined, 'explain'), false);
});

check('threadActionState：三种 kind 的按钮文案与禁用态', () => {
  const streamingTranslate = threadActionState({ status: 'streaming', kind: 'translate', embedded: true });
  assert.equal(streamingTranslate.retry.label, '翻译中…');
  assert.equal(streamingTranslate.retry.disabled, true);
  assert.equal(streamingTranslate.chat.disabled, true);

  const doneTranslate = threadActionState({ status: 'done', kind: 'translate', embedded: true, hasAnswer: true });
  assert.equal(doneTranslate.retry.label, '重新翻译');
  assert.equal(doneTranslate.retry.force, true);
  assert.equal(doneTranslate.copyDisabled, false);
  assert.ok(doneTranslate.hint.includes('不自动发送'));

  const doneExplain = threadActionState({ status: 'done', kind: 'explain', embedded: false, hasAnswer: true });
  assert.equal(doneExplain.retry.label, '重新解释');
  assert.equal(doneExplain.chat.disabled, true);
  assert.ok(doneExplain.hint.includes('需在 DSH 窗口内使用'));

  const errorRegion = threadActionState({ status: 'error', kind: 'region', embedded: true, hasAnswer: false });
  assert.equal(errorRegion.copyDisabled, true);
  assert.equal(errorRegion.chat.disabled, false);
});

check('stripMachineComment / renderMarkdown 不显示 terms 注释', () => {
  const withComment = '正文内容\n<!--terms:{"terms":[{"term":"Transformer"}]}-->';
  assert.equal(stripMachineComment(withComment), '正文内容');
  assert.ok(!renderMarkdown(withComment).includes('terms:'));
  assert.ok(renderMarkdown(withComment).includes('正文内容'));
  // 流式中未闭合的注释也要先藏起来
  assert.equal(stripMachineComment('正文\n<!--terms:{"terms":['), '正文');
  assert.equal(stripMachineComment('普通文本'), '普通文本');
});

check('termMetaParts：出现次数 / 首次出现页', () => {
  assert.deepEqual(termMetaParts({ count: 3, page: 2 }), ['出现 3 次', '首次出现 · 第 2 页']);
  assert.deepEqual(termMetaParts({ count: 0, page: 0 }), []);
  assert.deepEqual(termMetaParts({}), []);
});

check('SSE kind 分发：translate / region 事件被正确解析', () => {
  const events = [];
  const parser = createSSEParser((ev) => events.push(ev));
  parser.feed('data: {"type":"meta","kind":"translate","cached":false,"id":"e1"}\n\n');
  parser.feed('data: {"type":"delta","text":"译文"}\n\n');
  parser.feed('data: {"type":"done","entry":{"id":"e1","kind":"translate","answer":"x"}}\n\n');
  parser.feed('data: {"type":"meta","kind":"region","cached":true,"id":"e2"}\n\n');
  parser.feed('data: {"type":"done","entry":{"id":"e2","kind":"region","rect":[1,2,3,4]}}\n\n');
  assert.equal(events.length, 5);
  assert.equal(resolveKind(events[0], null), 'translate');
  assert.equal(events[1].text, '译文');
  assert.equal(resolveKind(null, events[2].entry), 'translate');
  assert.equal(resolveKind(events[3], null), 'region');
  assert.deepEqual(events[4].entry.rect, [1, 2, 3, 4]);
});

// ---------- v2 fixture 数据 ----------

check('fixture v2 index/entries：kind 合法、region 带 rect、translate 带 peraId', () => {
  const indexEntries = readJson('fixture/explanations-index.json').index;
  const fullEntries = readJson('fixture/explanations.json').entries;
  assert.ok(indexEntries.length >= 5);
  for (const entry of indexEntries) {
    assert.ok(['explain', 'translate', 'region'].includes(entry.kind));
    if (entry.kind === 'region') {
      assert.equal(normalizeRegionRect(entry.rect) !== null, true, `${entry.id} 缺 rect`);
    }
    if (entry.kind === 'explain') {
      const para = paraById.get(entry.paraId);
      assert.ok(Array.isArray(entry.sent), `${entry.id} 缺 sent`);
      assert.ok(entry.sent[0] >= 0 && entry.sent[1] <= para.text.length, `${entry.id} sent 越界`);
    }
  }
  for (const entry of fullEntries) {
    assert.ok(entry.answer && entry.answer.length > 20, `${entry.id} 缺 answer`);
    if (entry.kind === 'translate') assert.ok(entry.paraId, `${entry.id} 缺 paraId`);
  }
});

check('fixture v2：sent 区间标记优先于 selText 搜索', () => {
  const para = paraById.get('p1');
  const entry = readJson('fixture/explanations-index.json').index.find((e) => e.id === 'e_fixture01');
  const words = wordsOf(page1, para.id);
  const bySent = markBoxes(para, words, '完全对不上的文本', entry.sent);
  assert.ok(bySent.length >= 1, 'sent 区间应能定位');
  const boxArea = bySent.reduce((sum, b) => sum + b.width * b.height, 0);
  assert.ok(boxArea > 0);
  // 不传 sent 且文本对不上时退回整段 bbox（仍可点）
  const fallback = markBoxes(para, words, '完全对不上的文本');
  assert.ok(fallback.length >= 1);
});

check('fixture v2：terms.json / terms.md 存在且结构正确', () => {
  assert.ok(existsSync(path.join(APP, 'fixture/terms.json')));
  const terms = readJson('fixture/terms.json').terms;
  assert.ok(terms.length >= 3);
  for (const term of terms) {
    assert.ok(term.key && term.term, '术语缺 key/term');
    assert.ok(Number(term.count) > 0);
    assert.ok(Number(term.page) > 0);
  }
  const md = readFileSync(path.join(APP, 'fixture/terms.md'), 'utf8');
  assert.ok(md.includes('| 术语 | 中文 | 说明 | 出现次数 |'));
  assert.ok(md.includes('Attention'));
});

check('fixture v2 mock 覆盖三个新接口', () => {
  for (const token of ['translateStream', 'explainRegionStream', 'getTerms', 'termsMdUrl', "kind: 'translate'", "kind: 'region'"]) {
    assert.ok(mockJs.includes(token), `mock 缺少 ${token}`);
  }
});

// ---------- 汇总 ----------

let failed = 0;
for (const item of results) {
  if (item.ok) {
    console.log(`  ok   ${item.name}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${item.name}`);
    console.error(`       ${item.error?.message || item.error}`);
  }
}
console.log(`\n${results.length - failed}/${results.length} 项通过`);
if (failed) process.exit(1);
