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
（模拟）该句位于演示段落中，用于验证原文标记、历史列表与跳页高亮。`;
}

function buildMockTranslation(paraText) {
  return `**（fixture 模拟译文）整段译文：**

这一段（${String(paraText || '').slice(0, 48)}……）的中文大意是：该段介绍了模型的总体结构与设计动机。

> 说明：这是自测夹具生成的模拟译文，用于验证「整段翻译」链路（流式、缓存、历史徽标）。`;
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

### 3. 在论证中的位置
（模拟）演示用回答。`;
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

async function mockExplainRegion(body) {
  const page = Number(body?.page) || 1;
  const rect = (Array.isArray(body?.rect) ? body.rect : []).map(Number);
  const force = !!body?.force;
  const key = `${page}:${rect.join(',')}`;
  const structure = await getStructureData();
  const [x0, y0, x1, y1] = rect;
  const regionParas = (structure.paras || []).filter(
    (p) =>
      Number(p.page) === page &&
      Array.isArray(p.bbox) &&
      p.bbox[0] < x1 &&
      p.bbox[2] > x0 &&
      p.bbox[1] < y1 &&
      p.bbox[3] > y0
  );
  const regionText = regionParas.map((p) => p.text).join('\n');
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
      const payload = await getJSON('fixture/explanations-index.json');
      return {
        index: [
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
      const payload = await getJSON('fixture/explanations.json');
      return { entries: [...liveEntries, ...(payload.entries || [])] };
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
