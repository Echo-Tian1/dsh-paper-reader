/**
 * fixture/mock.js — 仅用于自测的假 API（页面以 ?fixture=1 打开时动态载入）。
 *
 * 不参与正式逻辑：正式模式（无 ?fixture=1）永远不会 import 本文件。
 * 数据在 fixture/ 下：structure.json / pages/{1,2,3}.json / page-{1,2,3}.png /
 * explanations.json / explanations-index.json / terms.json / terms.md。
 *
 * v2 在 v1 基础上补：/api/translate、/api/explain-region、terms / terms.md，
 * 并且新条目会进入本会话的 history / index / terms，方便验证三条新链路闭环。
 */

const DOC = {
  id: 'demo',
  title: 'Demo Paper — Attention Is All You Need（fixture）',
  pageCount: 3,
  addedAt: '2026-10-22T07:00:00.000Z',
  lastOpenedAt: '2026-10-22T08:10:00.000Z',
  lastPage: 1,
  explained: 2,
};

let lastDocId = 'demo';
const uploadedDocs = [];
// 本次会话里新生成的结果（解释 / 翻译 / 区域），让缓存 / 历史 / 标记 / 术语在 fixture 里闭环
const liveEntries = [];
const liveTerms = new Map();
let structureCache = null;
let annotationCache = null;
let summaryState = null;
let summaryLoaded = false;
let summaryAttempts = 0;
const SUMMARY_EMPTY = new URLSearchParams(location.search).get('nosummary') === '1';
const SUMMARY_ERROR_ONCE = new URLSearchParams(location.search).get('sumerr') === '1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalize(text) {
  return String(text || '')
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function getJSON(path) {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) throw new Error(`fixture 读取失败：${path}（HTTP ${res.status}）`);
  return res.json();
}

async function getStructureData() {
  if (!structureCache) structureCache = await getJSON('fixture/structure.json');
  return structureCache;
}

function sseResponse(producer) {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream({
    async start(controller) {
      const push = (event) => {
        if (cancelled) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        await producer(push);
      } catch (err) {
        push({ type: 'error', code: 'fixture-error', message: String(err?.message || err) });
      } finally {
        if (!cancelled) {
          try {
            controller.close();
          } catch (err) {
            /* already closed */
          }
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function chunkText(text, size) {
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

// ---------- 假答案 ----------

function buildMockAnswer(selText) {
  const quote = String(selText || '').slice(0, 80);
  return `### 1. 中译
（fixture 模拟译文）这句话「${quote}」的大意是：演示用的模拟解释文本，用来验证流式输出。

### 2. 难点
- **fixture**：这是自测夹具生成的模拟解释，不是真实模型输出。
- 验证点：SSE 逐字追加、Markdown 渲染、缓存命中态、错误重试。

### 3. 在论证中的位置
（模拟）该句位于演示段落中，用于验证原文标记、历史列表与跳页高亮。

公式示例：$\\mathrm{softmax}(x)_i=\\frac{e^{x_i}}{\\sum_j e^{x_j}}$
`;
}

function buildMockTranslation(paraText) {
  return `**（fixture 模拟译文）整段译文：**

这一段（${String(paraText || '').slice(0, 48)}……）的中文大意是：该段介绍了模型的总体结构与设计动机。

> 说明：这是自测夹具生成的模拟译文，用于验证「整段翻译」链路（流式、缓存、历史徽标）。

保留公式 $\\mathrm{softmax}(QK^{T}/\\sqrt{d_k})V$。`;
}

function buildMockRegionAnswer(regionText, page, rect) {
  const size = rect ? `${Math.round(rect[2] - rect[0])}×${Math.round(rect[3] - rect[1])} pt` : '';
  const text = String(regionText || '').trim();
  return `### 1. 区域内容
（fixture）第 ${page} 页框选区域${size ? `（${size}）` : ''}${
    text ? `的文字层为：\n\n\`${text.slice(0, 160)}\`` : '没有文字层，只能依据上下文推测。'
  }

### 2. 难点
- **region**：本条目用于验证「框选区域 → 缩略图 → 历史回看」链路。
- 区域没有文字层时，模型只能依据上下文推测（真实宿主会说明这一点）。

$$
\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}\\left(\\frac{QK^{T}}{\\sqrt{d_k}}\\right)V
$$

### 3. 在论证中的位置
（模拟）演示用回答。`;
}

// ---------- 结构化摘要（fixture） ----------

const FIXTURE_SUMMARY_SECTIONS = [
  '## 一句话结论',
  '值得细读：这是 Transformer 的开山之作，若你研究序列建模或注意力机制属于必读；只做图像任务可略读。',
  '',
  '## 研究问题',
  '- 能否完全抛弃循环与卷积，只用注意力完成序列转导？',
  '- 纯注意力模型能否同时做到质量更高、并行度更好、训练更便宜？',
  '',
  '## 数据与样本',
  '- WMT 2014 英德（约 450 万句对）与英法（约 3600 万句对）。',
  '- 使用 BPE / word-piece 子词切分；8 张 P100 GPU 训练。',
  '',
  '## 方法',
  '- 编码器/解码器各 6 层，多头自注意力 + 前馈网络 + 残差连接 + 层归一化。',
  '- 缩放点积注意力 $\\mathrm{Attention}(Q,K,V)=\\mathrm{softmax}(QK^{T}/\\sqrt{d_k})V$ 与多头注意力；正弦位置编码。',
  '',
  '$$',
  '\\mathrm{MultiHead}(Q,K,V)=\\mathrm{Concat}(\\mathrm{head}_1,\\dots,\\mathrm{head}_h)W^{O}',
  '$$',
  '',
  '## 主要结论',
  '- 英德 BLEU 28.4、英法 BLEU 41.8，超过此前最佳结果。',
  '- 训练时间显著缩短（3.5 天 / 8 GPU）。',
  '',
  '## 局限与存疑',
  '- 自注意力对序列长度是 O(n²)，长文档场景受限。',
  '- 论文中未明确小数据任务上的超参可迁移性。',
  '',
  '> （fixture 生成）细节请以原文为准。',
].join('\n');

function buildMockSummary(force) {
  const suffix = force ? '（fixture 重新生成版本）' : '（fixture 摘要）';
  return FIXTURE_SUMMARY_SECTIONS.replace('值得细读：这是 Transformer 的开山之作', `值得细读${suffix}：这是 Transformer 的开山之作`);
}

async function ensureSummaryLoaded() {
  if (summaryLoaded) return;
  summaryLoaded = true;
  if (SUMMARY_EMPTY) {
    summaryState = null;
    return;
  }
  try {
    const payload = await getJSON('fixture/summary.json');
    summaryState = payload?.entry || null;
  } catch (err) {
    summaryState = null;
  }
}

async function mockSummarize(body) {
  await ensureSummaryLoaded();
  const force = !!body?.force;
  const docId = body?.docId || 'demo';
  if (SUMMARY_ERROR_ONCE && summaryAttempts++ === 0) {
    return sseResponse(async (push) => {
      await sleep(260);
      push({ type: 'error', kind: 'summary', code: 'llm-failed', message: '（fixture）模拟摘要生成失败，请重试' });
    });
  }
  if (!force && summaryState && summaryState.answer) {
    summaryState = {
      ...summaryState,
      hitCount: (summaryState.hitCount || 0) + 1,
      lastHitAt: new Date().toISOString(),
    };
    return sseResponse(async (push) => {
      push({ type: 'meta', kind: 'summary', cached: true, id: summaryState.id, hitCount: summaryState.hitCount });
      await sleep(120);
      push({ type: 'done', entry: summaryState });
    });
  }
  const answer = buildMockSummary(force);
  const entry = {
    id: `e_summary_${Date.now().toString(36)}`,
    key: 'mock-summary-key',
    recipe: 'summary-v1',
    kind: 'summary',
    docId,
    page: 1,
    paraId: '',
    selText: '',
    provider: 'fixture',
    model: 'fixture-mock',
    answer,
    createdAt: new Date().toISOString(),
    hitCount: 0,
    lastHitAt: null,
    supersedes: summaryState?.id || null,
  };
  return sseResponse(async (push) => {
    push({ type: 'meta', kind: 'summary', cached: false, id: entry.id, key: entry.key });
    await sleep(160);
    for (const chunk of chunkText(answer, 22)) {
      push({ type: 'delta', text: chunk });
      await sleep(28);
    }
    summaryState = entry;
    push({ type: 'done', entry });
  });
}

// ---------- 术语累积（模拟宿主从解释结果里解析 terms） ----------

function rememberTermFromText(text, entry) {
  const match = String(text || '').match(/[A-Za-z][A-Za-z-]{4,}/);
  if (!match) return;
  const raw = match[0];
  const key = raw.toLowerCase();
  const existing = liveTerms.get(key);
  if (existing) {
    existing.count = (existing.count || 1) + 1;
    existing.updatedAt = new Date().toISOString();
    return;
  }
  liveTerms.set(key, {
    key,
    term: raw[0].toUpperCase() + raw.slice(1),
    zh: `（fixture）${raw} 的中文`,
    note: '这是一条由 fixture 动态累积的术语，用于验证「解释完成后术语表自动刷新」。',
    count: 1,
    page: entry?.page || 1,
    paraId: entry?.paraId || '',
    firstEntryId: entry?.id || '',
    updatedAt: new Date().toISOString(),
  });
}

// ---------- 三个 SSE 接口 ----------

async function mockExplain(body) {
  const sel = body?.sel || {};
  const text = String(sel.text || '');
  const force = !!body?.force;

  // 方便手工验证错误 UI：选句里包含「失败」或 error 时返回 error 事件
  if (/失败|error/i.test(text)) {
    return sseResponse(async (push) => {
      await sleep(250);
      push({ type: 'error', code: 'llm-failed', message: '（fixture）模拟模型调用失败，请重试' });
    });
  }

  const [entriesPayload, indexPayload] = await Promise.all([
    getJSON('fixture/explanations.json').catch(() => ({ entries: [] })),
    getJSON('fixture/explanations-index.json').catch(() => ({ index: [] })),
  ]);
  const entries = [...liveEntries, ...(entriesPayload.entries || [])];
  const index = [
    ...liveEntries.map((item) => ({
      id: item.id,
      key: item.key,
      paraId: item.paraId,
      page: item.page,
      selText: item.selText,
      createdAt: item.createdAt,
      hitCount: item.hitCount,
      recipe: item.recipe,
      kind: item.kind || 'explain',
      ...(item.rect ? { rect: item.rect, regionText: item.regionText } : {}),
      ...(item.sent ? { sent: item.sent } : {}),
    })),
    ...(indexPayload.index || []),
  ];
  const hit = !force
    ? index.find(
        (item) =>
          (item.kind || 'explain') === 'explain' &&
          normalize(item.selText) === normalize(text) &&
          (!sel.paraId || !item.paraId || item.paraId === sel.paraId)
      )
    : null;

  if (hit) {
    const entry = entries.find((item) => item.id === hit.id) || {
      ...hit,
      docId: body?.docId || 'demo',
      provider: 'fixture',
      model: 'fixture-mock',
      answer: '（fixture）缓存条目没有 answer 字段。',
    };
    const nextHit = (entry.hitCount || 0) + 1;
    const live = liveEntries.find((item) => item.id === entry.id);
    if (live) live.hitCount = nextHit;
    return sseResponse(async (push) => {
      push({ type: 'meta', kind: 'explain', cached: true, id: entry.id, hitCount: nextHit });
      await sleep(140);
      push({ type: 'done', entry: { ...entry, kind: 'explain', hitCount: nextHit, lastHitAt: new Date().toISOString() } });
    });
  }

  const answer = buildMockAnswer(text);
  const entry = {
    id: `e_mock_${Date.now().toString(36)}`,
    key: 'mock-key',
    recipe: 'v2',
    kind: 'explain',
    selText: text,
    normText: normalize(text),
    docId: body?.docId || 'demo',
    page: sel.page || 1,
    paraId: sel.paraId || '',
    sectionId: 's2',
    contextHash: 'mock-context',
    provider: 'fixture',
    model: 'fixture-mock',
    answer,
    createdAt: new Date().toISOString(),
    hitCount: 0,
    lastHitAt: null,
    supersedes: null,
  };
  return sseResponse(async (push) => {
    push({ type: 'meta', kind: 'explain', cached: false, id: entry.id, key: entry.key });
    await sleep(160);
    for (const chunk of chunkText(answer, 16)) {
      push({ type: 'delta', text: chunk });
      await sleep(30);
    }
    liveEntries.unshift(entry);
    rememberTermFromText(text, entry);
    push({ type: 'done', entry });
  });
}

async function mockTranslate(body) {
  const paraId = String(body?.paraId || '');
  const force = !!body?.force;
  const structure = await getStructureData();
  const para = (structure.paras || []).find((p) => p.id === paraId);
  const sourceText = para?.text || '（fixture 找不到该段落）';
  const cachedEntry = !force ? liveEntries.find((e) => e.kind === 'translate' && e.paraId === paraId) : null;
  if (cachedEntry) {
    cachedEntry.hitCount = (cachedEntry.hitCount || 0) + 1;
    return sseResponse(async (push) => {
      push({ type: 'meta', kind: 'translate', cached: true, id: cachedEntry.id, hitCount: cachedEntry.hitCount });
      await sleep(120);
      push({ type: 'done', entry: { ...cachedEntry, lastHitAt: new Date().toISOString() } });
    });
  }
  const answer = buildMockTranslation(sourceText);
  const entry = {
    id: `e_translate_${Date.now().toString(36)}`,
    key: 'mock-translate-key',
    recipe: 'translate-v1',
    kind: 'translate',
    selText: sourceText,
    normText: normalize(sourceText),
    docId: body?.docId || 'demo',
    page: para?.page || 1,
    paraId,
    sectionId: para?.sectionId || '',
    contextHash: 'mock-translate-context',
    provider: 'fixture',
    model: 'fixture-mock',
    answer,
    createdAt: new Date().toISOString(),
    hitCount: 0,
    lastHitAt: null,
    supersedes: null,
  };
  return sseResponse(async (push) => {
    push({ type: 'meta', kind: 'translate', cached: false, id: entry.id, key: entry.key });
    await sleep(160);
    for (const chunk of chunkText(answer, 18)) {
      push({ type: 'delta', text: chunk });
      await sleep(30);
    }
    liveEntries.unshift(entry);
    rememberTermFromText(sourceText, entry);
    push({ type: 'done', entry });
  });
}

function snapRegionRect(rect, regionParas) {
  const boxes = regionParas.map((p) => p.bbox).filter((b) => Array.isArray(b) && b.length === 4);
  if (!boxes.length) return rect.map((n) => Math.round(Number(n) * 10) / 10);
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[2]));
  const y1 = Math.max(...boxes.map((b) => b[3]));
  return [x0, y0, x1, y1].map((n) => Math.round(n * 10) / 10);
}

function buildRegionLines(rect, regionParas, pageData) {
  const lines = [];
  const words = Array.isArray(pageData?.words) ? pageData.words : [];
  const inRect = words.filter(
    (w) =>
      Array.isArray(w) &&
      w[0] < rect[2] &&
      w[2] > rect[0] &&
      w[1] < rect[3] &&
      w[3] > rect[1]
  );
  const byLine = new Map();
  for (const word of inRect) {
    const key = Math.round(Number(word[1]) * 2) / 2;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(word);
  }
  for (const lineWords of [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([, list]) => list)) {
    lineWords.sort((a, b) => a[0] - b[0]);
    const text = lineWords.map((w) => String(w[4] ?? '')).join(' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const bbox = [
      Math.min(...lineWords.map((w) => w[0])),
      Math.min(...lineWords.map((w) => w[1])),
      Math.max(...lineWords.map((w) => w[2])),
      Math.max(...lineWords.map((w) => w[3])),
    ];
    lines.push({ text, kind: /[=^_√∑∫]|softmax|attention/i.test(text) ? 'math' : 'text', bbox });
  }
  if (!lines.length) {
    for (const para of regionParas) {
      lines.push({ text: para.text, kind: /[=^_√∑∫]|softmax|attention/i.test(para.text) ? 'math' : 'text', bbox: para.bbox });
    }
  }
  return lines;
}

async function mockExplainRegion(body) {
  const page = Number(body?.page) || 1;
  const requestRect = (Array.isArray(body?.rect) ? body.rect : []).map(Number);
  const force = !!body?.force;
  const structure = await getStructureData();
  const [x0, y0, x1, y1] = requestRect;
  const regionParas = (structure.paras || []).filter(
    (p) =>
      Number(p.page) === page &&
      Array.isArray(p.bbox) &&
      p.bbox[0] < x1 &&
      p.bbox[2] > x0 &&
      p.bbox[1] < y1 &&
      p.bbox[3] > y0
  );
  // 模拟宿主吸附：把矩形扩展成相交文本行的并集（这里是段落 bbox 的并集）
  const rect = snapRegionRect(requestRect, regionParas);
  const pageData = await getJSON(`fixture/pages/${page}.json`).catch(() => ({ words: [] }));
  const regionLines = buildRegionLines(rect, regionParas, pageData);
  const regionText = regionLines.map((line) => line.text).join('\n');
  const key = `${page}:${rect.join(',')}`;
  const cachedEntry = !force
    ? liveEntries.find((e) => e.kind === 'region' && `${e.page}:${(e.rect || []).join(',')}` === key)
    : null;
  if (cachedEntry) {
    cachedEntry.hitCount = (cachedEntry.hitCount || 0) + 1;
    return sseResponse(async (push) => {
      push({ type: 'meta', kind: 'region', cached: true, id: cachedEntry.id, hitCount: cachedEntry.hitCount });
      await sleep(120);
      push({ type: 'done', entry: { ...cachedEntry, lastHitAt: new Date().toISOString() } });
    });
  }
  const answer = buildMockRegionAnswer(regionText, page, rect);
  const entry = {
    id: `e_region_${Date.now().toString(36)}`,
    key: 'mock-region-key',
    recipe: 'region-v1',
    kind: 'region',
    selText: '',
    normText: regionText,
    docId: body?.docId || 'demo',
    page,
    paraId: regionParas[0]?.id || '',
    sectionId: regionParas[0]?.sectionId || '',
    rect,
    regionText,
    regionLines,
    contextHash: 'mock-region-context',
    provider: 'fixture',
    model: 'fixture-mock',
    answer,
    createdAt: new Date().toISOString(),
    hitCount: 0,
    lastHitAt: null,
    supersedes: null,
  };
  return sseResponse(async (push) => {
    push({ type: 'meta', kind: 'region', cached: false, id: entry.id, key: entry.key });
    await sleep(160);
    for (const chunk of chunkText(answer, 18)) {
      push({ type: 'delta', text: chunk });
      await sleep(30);
    }
    liveEntries.unshift(entry);
    rememberTermFromText(regionText, entry);
    push({ type: 'done', entry });
  });
}

// ---------- 对外 API ----------

export function createApi() {
  return {
    fixture: true,

    async health() {
      return {
        ok: true,
        python: true,
        fitz: 'fixture',
        provider: 'fixture',
        model: 'fixture-mock',
        storeDir: '(fixture)',
      };
    },

    async listDocs() {
      return { docs: [DOC, ...uploadedDocs], ui: { lastDocId } };
    },

    async getUiState() {
      return { lastDocId, perDoc: {} };
    },

    async upload(file) {
      await sleep(400);
      const name = String(file?.name || '上传的论文.pdf');
      const doc = {
        ...DOC,
        id: `demo-upload-${Date.now().toString(36)}`,
        title: name.replace(/\.pdf$/i, ''),
        addedAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
        lastPage: 1,
        explained: 0,
      };
      uploadedDocs.push(doc);
      lastDocId = doc.id;
      return { ok: true, reused: false, doc };
    },

    async getStructure(id) {
      const structure = await getStructureData();
      const doc = uploadedDocs.find((item) => item.id === id);
      return doc ? { ...structure, id: doc.id, title: doc.title, pageCount: doc.pageCount } : structure;
    },

    async getPage(id, n) {
      return getJSON(`fixture/pages/${n}.json`);
    },

    pageImageUrl(id, n) {
      return `fixture/page-${n}.png`;
    },

    async getIndex() {
      await ensureSummaryLoaded();
      const payload = await getJSON('fixture/explanations-index.json');
      const summaryIndex = summaryState
        ? [{
            id: summaryState.id,
            key: summaryState.key,
            paraId: '',
            page: 1,
            selText: '',
            createdAt: summaryState.createdAt,
            hitCount: summaryState.hitCount,
            recipe: summaryState.recipe,
            kind: 'summary',
          }]
        : [];
      return {
        index: [
          ...summaryIndex,
          ...liveEntries.map((item) => ({
            id: item.id,
            key: item.key,
            paraId: item.paraId,
            page: item.page,
            selText: item.selText,
            createdAt: item.createdAt,
            hitCount: item.hitCount,
            recipe: item.recipe,
            kind: item.kind || 'explain',
            ...(item.rect ? { rect: item.rect, regionText: item.regionText } : {}),
            ...(item.sent ? { sent: item.sent } : {}),
          })),
          ...(payload.index || []),
        ],
      };
    },

    async getExplanations() {
      await ensureSummaryLoaded();
      const payload = await getJSON('fixture/explanations.json');
      return {
        entries: [
          ...(summaryState ? [summaryState] : []),
          ...liveEntries,
          ...(payload.entries || []),
        ],
      };
    },

    async getSummary() {
      await ensureSummaryLoaded();
      return { entry: summaryState };
    },

    summarizeStream(body) {
      return mockSummarize(body);
    },

    async getLinks() {
      return getJSON('fixture/links.json');
    },

    async getAnnotations() {
      if (!annotationCache) {
        const payload = await getJSON('fixture/annotations.json').catch(() => ({ items: [] }));
        annotationCache = [...(payload.items || [])];
      }
      return { items: [...annotationCache] };
    },

    async createAnnotation(docId, body) {
      if (!annotationCache) {
        const payload = await getJSON('fixture/annotations.json').catch(() => ({ items: [] }));
        annotationCache = [...(payload.items || [])];
      }
      const rects = (Array.isArray(body?.rects) ? body.rects : []).filter(
        (r) => Array.isArray(r) && r.length === 4 && r.every((n) => Number.isFinite(Number(n)))
      );
      if (!rects.length) throw new Error('rects 为空或非法');
      const now = new Date().toISOString();
      const item = {
        id: `a_${Date.now().toString(16)}`,
        kind: body?.kind === 'note' ? 'note' : 'highlight',
        page: Number(body?.page) || 1,
        rects: rects.map((r) => r.map(Number)),
        text: String(body?.text || ''),
        note: String(body?.note || ''),
        color: ['yellow', 'green', 'blue', 'pink'].includes(body?.color) ? body.color : 'yellow',
        paraId: body?.paraId || '',
        createdAt: now,
        updatedAt: now,
      };
      annotationCache = [...annotationCache, item];
      return { item };
    },

    async patchAnnotation(docId, annotationId, body) {
      if (!annotationCache) annotationCache = [];
      const idx = annotationCache.findIndex((a) => a.id === annotationId);
      if (idx < 0) throw new Error('批注不存在');
      const updated = {
        ...annotationCache[idx],
        ...(typeof body?.note === 'string' ? { note: body.note } : {}),
        ...(['yellow', 'green', 'blue', 'pink'].includes(body?.color) ? { color: body.color } : {}),
        updatedAt: new Date().toISOString(),
      };
      annotationCache = annotationCache.map((a) => (a.id === annotationId ? updated : a));
      return { item: updated };
    },

    async deleteAnnotation(docId, annotationId) {
      if (!annotationCache) annotationCache = [];
      annotationCache = annotationCache.filter((a) => a.id !== annotationId);
      return { ok: true };
    },

    notesMdUrl() {
      return 'fixture/notes.md';
    },

    async getTerms() {
      const payload = await getJSON('fixture/terms.json').catch(() => ({ terms: [] }));
      const staticTerms = (payload.terms || []).filter((term) => !liveTerms.has(term.key));
      const dynamic = [...liveTerms.values()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
      return { terms: [...dynamic, ...staticTerms] };
    },

    termsMdUrl() {
      return 'fixture/terms.md';
    },

    async postUiState(ui) {
      if (ui?.lastDocId) lastDocId = ui.lastDocId;
      return { ok: true };
    },

    explainStream(body) {
      return mockExplain(body);
    },

    translateStream(body) {
      return mockTranslate(body);
    },

    explainRegionStream(body) {
      return mockExplainRegion(body);
    },
  };
}
