/**
 * fixture/mock.js — 仅用于自测的假 API（页面以 ?fixture=1 打开时动态载入）。
 *
 * 不参与正式逻辑：正式模式（无 ?fixture=1）永远不会 import 本文件。
 * 数据在 fixture/ 下：structure.json / pages/{1,2,3}.json / page-{1,2,3}.png /
 * explanations.json / explanations-index.json。
 */

const DOC = {
  id: 'demo',
  title: 'Demo Paper — Attention Is All You Need（fixture）',
  pageCount: 3,
  addedAt: '2026-10-23T07:00:00.000Z',
  lastOpenedAt: '2026-10-23T08:10:00.000Z',
  lastPage: 1,
  explained: 2,
};

let lastDocId = 'demo';
const uploadedDocs = [];
// 本次会话里新生成的解释（让缓存 / 历史 / 标记在 fixture 里也能闭环）
const liveEntries = [];

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
    })),
    ...(indexPayload.index || []),
  ];
  const hit = !force ? index.find((item) => normalize(item.selText) === normalize(text)) : null;

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
      push({ type: 'meta', cached: true, id: entry.id, hitCount: nextHit });
      await sleep(140);
      push({ type: 'done', entry: { ...entry, hitCount: nextHit, lastHitAt: new Date().toISOString() } });
    });
  }

  const answer = buildMockAnswer(text);
  const entry = {
    id: `e_mock_${Date.now().toString(36)}`,
    key: 'mock-key',
    recipe: 'v1',
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
    push({ type: 'meta', cached: false, id: entry.id, key: entry.key });
    await sleep(160);
    for (const chunk of chunkText(answer, 16)) {
      push({ type: 'delta', text: chunk });
      await sleep(30);
    }
    liveEntries.unshift(entry);
    push({ type: 'done', entry });
  });
}

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
      const structure = await getJSON('fixture/structure.json');
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
      return { index: [...liveEntries, ...(payload.index || [])] };
    },

    async getExplanations() {
      const payload = await getJSON('fixture/explanations.json');
      return { entries: [...liveEntries, ...(payload.entries || [])] };
    },

    async postUiState(ui) {
      if (ui?.lastDocId) lastDocId = ui.lastDocId;
      return { ok: true };
    },

    explainStream(body) {
      return mockExplain(body);
    },
  };
}
