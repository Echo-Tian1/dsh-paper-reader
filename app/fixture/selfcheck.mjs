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

import { renderMarkdown, createSSEParser, buildChatPayload, sortHistory } from '../explain.js';
import { locateRange, alignWordOffsets, markBoxes, isCJKText, wordTextFor } from '../paper.js';
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
    'getIndex', 'getExplanations', 'explainStream', 'postUiState', 'getUiState', 'health',
  ]) {
    assert.ok(new RegExp(`\\b${method}\\s*\\(`).test(mockJs), `mock 缺少 ${method}`);
  }
  assert.ok(mockJs.includes("cached: true"));
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
