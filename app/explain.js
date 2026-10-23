/**
 * explain.js — 解释线程：SSE 流式（解释 / 整段翻译 / 框选区域）、缓存命中态、历史、术语表、
 * Markdown 渲染、转到对话。
 *
 * 接口契约见 CONTRACT.md：
 *   POST /api/explain        → SSE，事件 {type:'meta'|'delta'|'done'|'error'}（meta.kind='explain'）
 *   POST /api/translate      → 同上，meta.kind='translate'
 *   POST /api/explain-region → 同上，meta.kind='region'
 *   GET  /api/docs/:id/explanations[?index=1]
 *   GET  /api/docs/:id/terms          GET /api/docs/:id/terms.md
 *
 * 本文件顶层的纯函数可在 Node 里直接 import 做单测，不触碰 DOM。
 */

// ---------- 纯函数 ----------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const THREAD_KINDS = ['explain', 'translate', 'region'];

/** HTML 转义（Markdown 渲染第一步，必须先转义再拼标签）。 */
export function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/** 宿主会扣掉 `<!--terms:...-->` 注释；客户端再做一次防御性剥离（含流式中未闭合的情况）。 */
export function stripMachineComment(text) {
  let out = String(text == null ? '' : text);
  out = out.replace(/<!--\s*terms:[\s\S]*?-->/gi, '');
  out = out.replace(/<!--\s*terms:[\s\S]*$/i, '');
  return out.replace(/[ \t]+\n/g, '\n').trimEnd();
}

function renderInline(text) {
  let s = escapeHtml(text);
  s = s.replace(/`([^`\n]+)`/g, (_, code) => `<code>${code}</code>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(（])\*([^*\n]+)\*(?=$|[\s).,;:!?，。；：！？）])/g, '$1<em>$2</em>');
  s = s.replace(/(^|[\s(（])_([^_\n]+)_(?=$|[\s).,;:!?，。；：！？）])/g, '$1<em>$2</em>');
  return s.replace(/\n/g, '<br>');
}

/**
 * 约 60 行的 Markdown 子集渲染器。
 * 支持：### 标题、**粗体**、*斜体*、`行内代码`、- / * 无序列表、1. 有序列表、空行分段、段内换行。
 * 安全：整段文本先 HTML 转义，再应用标记；不会插入用户提供的原始 HTML。
 */
export function renderMarkdown(src) {
  const source = stripMachineComment(src);
  if (!source) return '';
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let listKind = null;
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${renderInline(para.join('\n'))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listKind) {
      out.push(`</${listKind}>`);
      listKind = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) {
      flushPara();
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      closeList();
      const level = Math.min(4, Math.max(3, heading[1].length + 1)); // #/## → h3，### → h4
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const kind = ul ? 'ul' : 'ol';
      if (listKind !== kind) {
        closeList();
        out.push(`<${kind}>`);
        listKind = kind;
      }
      out.push(`<li>${renderInline((ul || ol)[1])}</li>`);
      continue;
    }
    closeList();
    para.push(line);
  }
  flushPara();
  closeList();
  return out.join('\n');
}

/**
 * 手写 SSE 解析器：按 `\n\n` 切事件、取 `data: ` 行、JSON.parse 后回调。
 * 兼容 \r\n、跨 chunk 截断、注释行与多行 data。
 */
export function createSSEParser(onEvent, onParseError) {
  let buffer = '';
  const dispatch = (raw) => {
    const dataLines = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      // 'event:' / 'id:' / ':' 注释行按契约不需要
    }
    if (!dataLines.length) return;
    const payload = dataLines.join('\n');
    if (!payload.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (err) {
      if (onParseError) onParseError(err, payload);
      return;
    }
    if (parsed && typeof parsed === 'object') onEvent(parsed);
  };
  const consume = () => {
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      dispatch(raw);
    }
  };
  return {
    feed(chunk) {
      if (chunk == null || chunk === '') return;
      buffer += String(chunk).replace(/\r\n?/g, '\n');
      consume();
    },
    flush() {
      if (buffer.trim()) {
        const raw = buffer;
        buffer = '';
        dispatch(raw);
      }
    },
  };
}

/** 解析事件里的 kind：meta.kind 优先，其次 entry.kind，缺省 explain（兼容老条目）。 */
export function resolveKind(meta, entry, fallback = 'explain') {
  const raw = (meta && meta.kind) || (entry && entry.kind) || fallback;
  return THREAD_KINDS.includes(raw) ? raw : fallback;
}

/** kind → 中文徽标：解释 / 翻译 / 公式。老条目（无 kind）视为解释。 */
export function kindLabel(kind) {
  switch (kind) {
    case 'translate':
      return '翻译';
    case 'region':
      return '公式';
    default:
      return '解释';
  }
}

/** 旧配方判定（每种 kind 有自己的当前配方版本）。 */
export function isOldRecipe(recipe, kind) {
  if (!recipe) return false;
  const expected = kind === 'translate' ? 'translate-v1' : kind === 'region' ? 'region-v1' : 'v2';
  return recipe !== expected;
}

/** 术语列表项的次要信息（出现次数 / 首次出现页）。纯函数，便于单测。 */
export function termMetaParts(term) {
  const parts = [];
  if (Number(term?.count) > 0) parts.push(`出现 ${Number(term.count)} 次`);
  if (Number(term?.page) > 0) parts.push(`首次出现 · 第 ${Number(term.page)} 页`);
  return parts;
}

/**
 * 线程操作区状态机：给定 thread 状态，算出「重新解释/复制/转到对话」的文案与禁用态。
 * 纯函数，便于单测（Modal/按钮的三类 kind 文案都在这里）。
 */
export function threadActionState({ status, kind = 'explain', embedded = false, hasAnswer = false } = {}) {
  const streaming = status === 'waiting' || status === 'streaming';
  const retryLabel = streaming
    ? kind === 'translate'
      ? '翻译中…'
      : '解释中…'
    : kind === 'translate'
      ? '重新翻译'
      : '重新解释';
  let hint = '';
  if (!embedded) hint = '「转到对话」需在 DSH 窗口内使用';
  else if (!streaming) hint = '会填入当前对话输入框，不自动发送';
  return {
    retry: { label: retryLabel, disabled: streaming, force: !streaming },
    copyDisabled: !hasAnswer,
    chat: { disabled: streaming || !embedded, label: '转到对话' },
    hint,
  };
}

/** 按 CONTRACT.md §3 的固定格式拼「转到对话」文本。 */
export function buildChatPayload({ title, page, section, selText, paraText, answer }) {
  const lines = [];
  lines.push(`【论文】${title || '未命名论文'}（第 ${page || 1} 页${section ? ` · ${section}` : ''}）`);
  lines.push(`【原文】"${selText || ''}"`);
  lines.push(`【上下文】${paraText || '（无）'}`);
  if (answer && answer.trim()) lines.push(`【已有解释】${answer.trim()}`);
  lines.push('【我的问题】这句话我还是没读懂，结合上下文再讲一遍');
  return lines.join('\n');
}

/** 历史条目排序：最新在前。 */
export function sortHistory(entries) {
  return [...(entries || [])].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

export function formatTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 复制文本；优先 Clipboard API，退化到 execCommand。 */
export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    /* 走退化路径 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (err) {
    return false;
  }
}

// ---------- 模块状态 ----------

let deps = {
  api: null,
  getDocMeta: () => ({ title: '' }),
  getParaContext: () => ({}),
  getRegionThumbnail: () => '',
  ensurePageImage: () => Promise.resolve(false),
  onTermJump: null,
  onJumpEntry: null,
  onEntrySaved: null,
  toast: () => {},
  embedded: false,
};

let dom = null;
let docId = null;
let structure = null;
let paraById = new Map();
let sectionById = new Map();
let current = null;
let historyEntries = null;
let historyLoading = false;
let terms = null;
let termsLoading = false;
let activeTab = 'current';
let abortController = null;
let answerRenderQueued = false;

// ---------- DOM 小工具 ----------

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const btn = h('button', className, label);
  btn.type = 'button';
  btn.addEventListener('click', onClick);
  return btn;
}

function sectionTitleFor(paraId) {
  const para = paraById.get(paraId);
  if (!para) return '';
  const byId = sectionById.get(para.sectionId);
  if (byId) return byId.title || '';
  for (const s of structure?.sections || []) {
    if (Array.isArray(s.paraIds) && s.paraIds.includes(paraId)) return s.title || '';
  }
  return '';
}

// ---------- 对外 API ----------

export function init(options = {}) {
  deps = { ...deps, ...options };
  dom = {
    thread: document.getElementById('thread'),
    historyList: document.getElementById('history-list'),
    paneCurrent: document.getElementById('pane-current'),
    paneHistory: document.getElementById('pane-history'),
    paneTerms: document.getElementById('pane-terms'),
    tabCurrent: document.getElementById('tab-current'),
    tabHistory: document.getElementById('tab-history'),
    tabTerms: document.getElementById('tab-terms'),
    paneDocs: document.getElementById('pane-docs'),
    tabDocs: document.getElementById('tab-docs'),
    docsList: document.getElementById('docs-list'),
    termsList: document.getElementById('terms-list'),
    termsExport: document.getElementById('terms-export'),
  };
  // 页签用事件委托：即使某个按钮的独立监听没挂上、或按钮被重新渲染，点击仍然生效。
  const tabRow = dom.tabCurrent?.parentElement;
  if (tabRow) {
    tabRow.addEventListener('click', (event) => {
      const tab = event.target && event.target.closest ? event.target.closest('.tab') : null;
      if (!tab) return;
      if (tab.id === 'tab-history') showTab('history');
      else if (tab.id === 'tab-terms') showTab('terms');
      else if (tab.id === 'tab-docs') showTab('docs');
      else if (tab.id === 'tab-current') showTab('current');
    });
  } else {
    dom.tabCurrent?.addEventListener('click', () => showTab('current'));
    dom.tabHistory?.addEventListener('click', () => showTab('history'));
    dom.tabTerms?.addEventListener('click', () => showTab('terms'));
  }
  if (!dom.paneTerms) deps.toast?.('术语页签缺失：页面与脚本版本不一致，请刷新', 'error');
  renderThread();
  renderTerms();
}

/** 切换文档：清空线程、历史缓存与术语缓存。 */
export function reset(id, structureData) {
  abortCurrentRequest();
  docId = id || null;
  structure = structureData || null;
  paraById = new Map((structure?.paras || []).map((p) => [p.id, p]));
  sectionById = new Map((structure?.sections || []).map((s) => [s.id, s]));
  current = null;
  historyEntries = null;
  historyLoading = false;
  terms = null;
  termsLoading = false;
  renderThread();
  updateTermsExport();
  if (docId) loadTerms(true);
  showTab('current', { force: true });
}

export function setEmbedded(flag) {
  deps.embedded = !!flag;
  if (current) renderThread();
}

/** 当前是否正在生成。 */
export function isStreaming() {
  return current?.status === 'streaming' || current?.status === 'waiting';
}

/** 选中一个句子并请求解释（force=true 为重新解释）。 */
export async function explainSelection(sel, { force = false } = {}) {
  if (!docId || !sel) return;
  showTab('current', { force: true });
  const ctx = buildSelectionContext(sel);
  startRequest({
    kind: 'explain',
    sel,
    ctx,
    force,
    send: (signal) =>
      deps.api.explainStream(
        { docId, sel: { page: sel.page, paraId: sel.paraId, text: sel.text }, force: !!force },
        signal
      ),
  });
}

/** 整段翻译（paraId 必填；原文取 structure.paras[].text，不是选区文本）。 */
export async function translatePara({ page, paraId, paraText, sectionTitle, force = false } = {}) {
  if (!docId || !paraId) return;
  showTab('current', { force: true });
  const ctx = buildSelectionContext({ page, paraId, text: paraText || '' });
  const sourceText = paraText || ctx.paraText || '';
  const sel = { page: ctx.page || page || 1, paraId, text: sourceText };
  startRequest({
    kind: 'translate',
    sel,
    ctx: { ...ctx, sectionTitle: sectionTitle || ctx.sectionTitle },
    translateText: sourceText,
    force,
    send: (signal) => deps.api.translateStream({ docId, paraId, force: !!force }, signal),
  });
}

/** 框选区域解释（rect 为 PDF 点坐标）。 */
export async function explainRegion({ page, rect, force = false } = {}) {
  if (!docId || !Array.isArray(rect)) return;
  showTab('current', { force: true });
  const normalized = rect.map(Number);
  startRequest({
    kind: 'region',
    sel: { page: Number(page), paraId: '', text: '' },
    ctx: {},
    region: { page: Number(page), rect: normalized, regionText: '' },
    force,
    send: (signal) => deps.api.explainRegionStream({ docId, page: Number(page), rect: normalized, force: !!force }, signal),
  });
}

/** 直接打开一条已有条目（历史 / 原文标记），不发请求。 */
export function openEntry(entry) {
  if (!entry) return;
  abortCurrentRequest();
  const kind = resolveKind(null, entry, 'explain');
  const sel = {
    page: entry.page || 1,
    paraId: entry.paraId || '',
    text: entry.selText || '',
  };
  const ctx = buildSelectionContext(sel);
  const translateText = kind === 'translate' ? ctx.paraText || entry.selText || '' : '';
  const region =
    kind === 'region'
      ? { page: Number(entry.page) || 1, rect: Array.isArray(entry.rect) ? entry.rect.map(Number) : null, regionText: entry.regionText || '' }
      : null;
  current = {
    kind,
    req: { kind, sel, entryId: entry.id },
    sel: { ...sel, text: translateText || sel.text },
    ctx,
    region,
    translateText,
    status: 'done',
    meta: { cached: (entry.hitCount || 0) > 0, hitCount: entry.hitCount || 0, kind },
    cached: (entry.hitCount || 0) > 0,
    metaHitCount: entry.hitCount || 0,
    answer: entry.answer || '',
    entry,
    error: null,
    force: false,
    fromHistory: true,
  };
  showTab('current', { force: true });
  renderThread();
  markActiveHistory(entry.id);
}

/** 历史 tab 数据刷新（新解释落盘后调用）。 */
export function invalidateHistory() {
  historyEntries = null;
  if (activeTab === 'history') renderHistory();
}

/** 术语表数据失效；若当前在术语 tab 则原地刷新。 */
export function invalidateTerms() {
  terms = null;
  if (activeTab === 'terms') loadTerms(true);
}

export function showTab(tab, { force = false } = {}) {
  const known = ['current', 'history', 'terms', 'docs'];
  activeTab = known.includes(tab) ? tab : 'current';
  const isCurrent = activeTab === 'current';
  const isHistory = activeTab === 'history';
  const isTerms = activeTab === 'terms';
  const isDocs = activeTab === 'docs';
  dom.paneCurrent.hidden = !isCurrent;
  dom.paneHistory.hidden = !isHistory;
  if (dom.paneTerms) dom.paneTerms.hidden = !isTerms;
  if (dom.paneDocs) dom.paneDocs.hidden = !isDocs;
  dom.tabCurrent.classList.toggle('active', isCurrent);
  dom.tabHistory.classList.toggle('active', isHistory);
  if (dom.tabTerms) dom.tabTerms.classList.toggle('active', isTerms);
  if (dom.tabDocs) dom.tabDocs.classList.toggle('active', isDocs);
  dom.tabCurrent.setAttribute('aria-selected', String(isCurrent));
  dom.tabHistory.setAttribute('aria-selected', String(isHistory));
  if (dom.tabTerms) dom.tabTerms.setAttribute('aria-selected', String(isTerms));
  if (dom.tabDocs) dom.tabDocs.setAttribute('aria-selected', String(isDocs));
  if (isHistory) renderHistory();
  if (isTerms) {
    renderTerms();
    loadTerms(false);
  }
  if (isDocs && typeof deps.renderDocs === 'function') deps.renderDocs();
  if (force && !isCurrent) {
    // 保持一致的 hidden 状态（force 只用于确保 DOM 状态已更新）
    dom.paneCurrent.hidden = !isCurrent;
  }
}

export function activeTabName() {
  return activeTab;
}

// ---------- 请求 ----------

function buildSelectionContext(sel) {
  const ctx = deps.getParaContext ? deps.getParaContext(sel.paraId) || {} : {};
  return {
    paraText: ctx.paraText || '',
    prevPara: ctx.prevPara || '',
    nextPara: ctx.nextPara || '',
    page: ctx.page || sel.page,
    sectionTitle: ctx.sectionTitle || sectionTitleFor(sel.paraId || ''),
  };
}

function abortCurrentRequest() {
  if (abortController) {
    try {
      abortController.abort();
    } catch (err) {
      /* ignore */
    }
    abortController = null;
  }
  answerRenderQueued = false;
}

function makeError(message, code) {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}

async function readJsonSafe(res) {
  try {
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch (err) {
    return null;
  }
}

function failureLabel(kind) {
  if (kind === 'translate') return '翻译失败';
  if (kind === 'region') return '区域解释失败';
  return '解释失败';
}

async function startRequest(req, { force = false } = {}) {
  if (!deps.api) return;
  abortCurrentRequest();
  const controller = new AbortController();
  abortController = controller;
  const { kind } = req;
  current = {
    kind,
    req,
    sel: req.sel,
    ctx: req.ctx || {},
    region: req.region || null,
    translateText: req.translateText || '',
    status: 'waiting',
    meta: null,
    cached: false,
    metaHitCount: null,
    answer: '',
    entry: null,
    error: null,
    force,
    fromHistory: false,
    token: Symbol('request'),
  };
  renderThread();
  const token = current.token;

  try {
    const res = await req.send(controller.signal);
    if (!res || !res.ok) {
      const info = res ? await readJsonSafe(res) : null;
      throw makeError(info?.error?.message || `请求失败（HTTP ${res?.status ?? '网络错误'}）`, info?.error?.code);
    }
    if (!res.body) throw makeError('当前环境不支持流式响应');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSSEParser(
      (ev) => {
        if (current?.token === token) handleEvent(ev);
      },
      (err, payload) => {
        console.warn('[paper-reader] SSE 解析失败', err, payload);
      }
    );

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
    parser.flush();

    if (controller.signal.aborted) return;
    if (current?.status === 'streaming' || current?.status === 'waiting') {
      // 流结束了却没有 done 事件：保留已收到内容，标为未完成，可重试。
      current.status = 'error';
      current.error = {
        code: 'incomplete',
        message: `${failureLabel(current.kind)}：连接中断，结果未完成（不会写入缓存）。可以重试。`,
      };
      renderThread();
    }
  } catch (err) {
    if (err?.name === 'AbortError' || controller.signal.aborted) return;
    if (!current) return;
    current.status = 'error';
    current.error = { code: err?.code || 'request-failed', message: err?.message || `${failureLabel(current.kind)}，请重试` };
    renderThread();
  } finally {
    if (abortController === controller) abortController = null;
  }
}

function handleEvent(ev) {
  if (!current) return;
  switch (ev.type) {
    case 'meta': {
      current.meta = ev;
      current.kind = resolveKind(ev, null, current.kind);
      if (ev.cached) {
        current.cached = true;
        current.metaHitCount = ev.hitCount;
      }
      if (current.status === 'waiting') current.status = 'streaming';
      updateStatus();
      break;
    }
    case 'delta': {
      if (typeof ev.text !== 'string' || !ev.text) break;
      current.status = 'streaming';
      current.answer += ev.text;
      scheduleAnswerRender();
      updateStatus();
      break;
    }
    case 'done': {
      current.entry = ev.entry || null;
      current.kind = resolveKind(current.meta, current.entry, current.kind);
      current.status = 'done';
      if (!current.answer && current.entry?.answer) current.answer = current.entry.answer;
      if (current.kind === 'region') {
        const rect = Array.isArray(current.entry?.rect) ? current.entry.rect : current.region?.rect;
        current.region = {
          page: current.entry?.page || current.region?.page || current.sel.page,
          rect: rect ? rect.map(Number) : null,
          regionText: current.entry?.regionText || current.region?.regionText || '',
        };
      }
      if (current.kind === 'translate' && !current.translateText) {
        current.translateText = current.entry?.selText || current.ctx?.paraText || '';
      }
      if (current.entry) deps.onEntrySaved?.(current.entry, current.sel);
      invalidateTerms();
      renderThread();
      break;
    }
    case 'error': {
      current.status = 'error';
      current.error = { code: ev.code || 'llm-failed', message: ev.message || '模型调用失败' };
      renderThread();
      break;
    }
    default:
      break;
  }
}

function scheduleAnswerRender() {
  if (answerRenderQueued) return;
  answerRenderQueued = true;
  requestAnimationFrame(() => {
    answerRenderQueued = false;
    updateAnswer();
  });
}

// ---------- 线程渲染 ----------

function renderThread() {
  if (!dom?.thread) return;
  const root = dom.thread;
  const scrollTop = root.scrollTop;
  root.innerHTML = '';

  if (!current) {
    const empty = h('div', 'thread-empty');
    empty.innerHTML =
      '在左侧论文里选中一个句子，点工具条的「解释」。<br>' +
      '也可以<b>双击</b>句子直接解释；选中后点「译本段」可整段翻译。<br>' +
      '<b>Shift + 拖动</b>可框选公式 / 图区域（没有文字层也能框）。';
    root.appendChild(empty);
    dom.statusEl = null;
    dom.answerEl = null;
    dom.actionsEl = null;
    return;
  }

  // 1. 头部卡片（按 kind 不同）
  root.appendChild(renderHeadCard());

  // 2. 状态行
  dom.statusEl = h('div', 'thread-status');
  root.appendChild(dom.statusEl);

  // 3. 错误块 / 答案
  if (current.status === 'error') {
    const errBox = h('div', 'thread-error');
    errBox.appendChild(h('div', '', `${failureLabel(current.kind)}：${current.error?.message || '未知错误'}`));
    const errActions = h('div', 'thread-actions');
    errActions.appendChild(button('重试', 'btn', () => retry()));
    if (current.answer) errActions.appendChild(button('复制已收到的内容', 'btn', () => copyAnswer()));
    errBox.appendChild(errActions);
    root.appendChild(errBox);
    if (current.answer) {
      dom.answerEl = h('div', 'thread-answer');
      dom.answerEl.innerHTML = renderMarkdown(current.answer);
      root.appendChild(dom.answerEl);
    } else {
      dom.answerEl = null;
    }
  } else {
    dom.answerEl = h('div', 'thread-answer');
    if (current.status === 'waiting' || current.status === 'streaming') {
      dom.answerEl.classList.add('pr-md-streaming');
    }
    dom.answerEl.innerHTML =
      renderMarkdown(current.answer) ||
      (current.status === 'done' ? '<p class="thread-hint">这条历史记录没有正文。</p>' : '');
    root.appendChild(dom.answerEl);
  }

  // 4. 操作区
  dom.actionsEl = h('div', 'thread-actions');
  root.appendChild(dom.actionsEl);
  renderActions();
  updateStatus();
  root.scrollTop = scrollTop;
}

function renderHeadCard() {
  const card = h('div', 'thread-sel');
  const page = current.ctx?.page || current.sel.page || current.region?.page;
  const section = current.ctx?.sectionTitle || '';

  if (current.kind === 'translate') {
    const label = h('div', 'thread-sel-label');
    label.appendChild(h('span', '', '整段翻译'));
    label.appendChild(h('span', 'badge', kindLabel('translate')));
    if (section) label.appendChild(h('span', 'badge', section));
    card.appendChild(label);
    const detail = document.createElement('details');
    detail.className = 'thread-source';
    detail.open = false;
    const summary = document.createElement('summary');
    summary.textContent = `段落原文 · 第 ${page || '?'} 页${current.sel.paraId ? ` · ${current.sel.paraId}` : ''}`;
    const body = document.createElement('div');
    body.textContent = current.translateText || current.ctx?.paraText || '（段落原文不可用）';
    detail.append(summary, body);
    card.appendChild(detail);
    return card;
  }

  if (current.kind === 'region') {
    const region = current.region || {};
    const rect = Array.isArray(region.rect) ? region.rect : null;
    const label = h('div', 'thread-sel-label');
    label.appendChild(h('span', '', '框选区域'));
    label.appendChild(h('span', 'badge badge-region', kindLabel('region')));
    card.appendChild(label);
    appendRegionThumbnail(card, region);
    const sizeText = rect
      ? `${Math.round(rect[2] - rect[0])}×${Math.round(rect[3] - rect[1])} pt`
      : '';
    const metaRow = h('div', 'thread-sel-meta');
    metaRow.appendChild(h('span', '', `第 ${region.page || page || '?'} 页${sizeText ? ` · ${sizeText}` : ''}`));
    if (section) metaRow.appendChild(h('span', '', section));
    card.appendChild(metaRow);
    if (region.regionText) {
      const detail = document.createElement('details');
      detail.className = 'thread-source';
      const summary = document.createElement('summary');
      summary.textContent = '区域文字层';
      const body = document.createElement('div');
      body.textContent = region.regionText;
      detail.append(summary, body);
      card.appendChild(detail);
    } else {
      card.appendChild(h('div', 'thread-extra-meta', '该区域没有文字层，回答只能依据上下文推测。'));
    }
    return card;
  }

  // explain（默认，含老条目）
  const quote = h('div', 'thread-sel-quote', current.sel.text || '（空选句）');
  const metaRow = h('div', 'thread-sel-meta');
  metaRow.appendChild(h('span', '', `第 ${page || '?'} 页${section ? ` · ${section}` : ''}`));
  if (current.sel.paraId) metaRow.appendChild(h('span', '', current.sel.paraId));
  if (current.fromHistory) metaRow.appendChild(h('span', 'badge', '来自历史'));
  else metaRow.appendChild(h('span', 'badge', kindLabel('explain')));
  card.append(quote, metaRow);
  return card;
}

function appendRegionThumbnail(card, region) {
  const rect = Array.isArray(region?.rect) ? region.rect : null;
  if (!rect) return;
  const thumb = h('div', 'thread-thumb');
  thumb.appendChild(h('span', 'thread-thumb-label', '框选区域'));
  const url = deps.getRegionThumbnail?.(region.page, rect) || '';
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '框选区域缩略图';
    thumb.appendChild(img);
    card.appendChild(thumb);
    return;
  }
  const fallback = h('div', 'thread-thumb-fallback', '区域预览加载中…');
  thumb.appendChild(fallback);
  card.appendChild(thumb);
  Promise.resolve(deps.ensurePageImage?.(region.page))
    .then((ok) => {
      if (!ok || !thumb.isConnected) return;
      const late = deps.getRegionThumbnail?.(region.page, rect) || '';
      if (!late) {
        fallback.textContent = '区域预览不可用';
        return;
      }
      const img = document.createElement('img');
      img.src = late;
      img.alt = '框选区域缩略图';
      fallback.remove();
      thumb.appendChild(img);
    })
    .catch(() => {
      fallback.textContent = '区域预览不可用';
    });
}

function renderActions() {
  const box = dom?.actionsEl;
  if (!box) return;
  box.innerHTML = '';
  if (!current) return;

  const state = threadActionState({
    status: current.status,
    kind: current.kind,
    embedded: deps.embedded,
    hasAnswer: !!(current.answer || current.entry?.answer),
  });

  const reBtn = button(state.retry.label, 'btn', () => retry(state.retry.force));
  reBtn.disabled = state.retry.disabled;
  if (!state.retry.disabled) reBtn.title = '重新调用模型（会消耗一次调用，并新增一条 supersedes 记录）';
  box.appendChild(reBtn);

  const copyBtn = button('复制', 'btn', () => copyAnswer());
  copyBtn.disabled = state.copyDisabled;
  box.appendChild(copyBtn);

  const chatBtn = button(state.chat.label, 'btn btn-primary', () => sendToChat());
  chatBtn.disabled = state.chat.disabled;
  if (!deps.embedded) chatBtn.title = '需在 DSH 窗口内使用';
  box.appendChild(chatBtn);

  if (state.hint) box.appendChild(h('span', 'thread-hint', state.hint));
}

function cacheLabel(kind, hit) {
  if (kind === 'translate') return `缓存命中 · 已翻译 ${hit} 次`;
  return `缓存命中 · 已解释 ${hit} 次`;
}

function updateStatus() {
  const el = dom?.statusEl;
  if (!el || !current) return;
  el.innerHTML = '';
  const status = current.status;
  const kind = current.kind || 'explain';
  const kindBadge = badgeForKind(kind);
  el.appendChild(kindBadge);

  if (status === 'waiting') {
    el.appendChild(h('span', 'badge badge-live', '准备中…'));
    return;
  }
  if (status === 'streaming') {
    const hit = current.metaHitCount ?? current.meta?.hitCount ?? 0;
    if (current.cached) {
      el.appendChild(h('span', 'badge badge-cache', cacheLabel(kind, hit)));
    } else {
      el.appendChild(h('span', 'badge badge-live', kind === 'translate' ? '翻译中…' : '生成中…'));
    }
    return;
  }
  if (status === 'done') {
    const entry = current.entry;
    const hit = current.meta?.hitCount ?? entry?.hitCount ?? 0;
    if (current.fromHistory) {
      // 从历史/标记打开：不调模型，固定 0 token；命中次数作为附加信息
      el.appendChild(h('span', 'badge', '历史记录 · 0 token'));
      if (hit > 0) el.appendChild(h('span', '', kind === 'translate' ? `已翻译 ${hit} 次` : `已解释 ${hit} 次`));
    } else if (current.cached) {
      el.appendChild(h('span', 'badge badge-cache', cacheLabel(kind, hit)));
    } else {
      el.appendChild(h('span', 'badge', '已保存到历史'));
    }
    if (entry?.model) el.appendChild(h('span', '', `模型 ${entry.model}`));
    if (entry?.createdAt) el.appendChild(h('span', '', formatTime(entry.createdAt)));
    if (isOldRecipe(entry?.recipe, kind)) el.appendChild(h('span', 'badge', `旧配方 ${entry.recipe}`));
    return;
  }
  if (status === 'error') {
    el.appendChild(h('span', 'badge', current.error?.code === 'incomplete' ? '未完成' : '失败'));
  }
}

function badgeForKind(kind) {
  const label = kindLabel(kind);
  const cls = kind === 'translate' ? 'badge badge-translate' : kind === 'region' ? 'badge badge-region' : 'badge';
  return h('span', cls, label);
}

function updateAnswer() {
  if (!dom?.answerEl || !current) return;
  if (current.status === 'waiting' || current.status === 'streaming') {
    dom.answerEl.classList.add('pr-md-streaming');
  }
  dom.answerEl.innerHTML = renderMarkdown(current.answer);
}

function retry(force = false) {
  if (!current?.req) return;
  const base = current.req;
  const nextForce = force === true ? true : current.force;
  const ctx = current.ctx || {};
  if (base.kind === 'translate') {
    translatePara({
      page: current.sel.page,
      paraId: current.sel.paraId || base.sel?.paraId,
      paraText: current.translateText || ctx.paraText,
      sectionTitle: ctx.sectionTitle,
      force: nextForce,
    });
    return;
  }
  if (base.kind === 'region') {
    explainRegion({ page: current.region?.page || current.sel.page, rect: current.region?.rect || [], force: nextForce });
    return;
  }
  if (base.entryId && current.fromHistory) {
    // 从历史打开且要求重新解释：回到原文请求
    explainSelection(current.sel, { force: nextForce });
    return;
  }
  explainSelection(current.sel, { force: nextForce });
}

async function copyAnswer() {
  const text = stripMachineComment(current?.answer || current?.entry?.answer || '');
  if (!text) return;
  const ok = await copyText(text);
  deps.toast?.(ok ? '已复制' : '复制失败，请手动选择复制', ok ? 'info' : 'error');
}

function sendToChat() {
  if (!current) return;
  if (!deps.embedded) {
    deps.toast?.('需在 DSH 窗口内使用', 'error');
    return;
  }
  const meta = deps.getDocMeta ? deps.getDocMeta() : {};
  const ctx = current.ctx || {};
  const kind = current.kind || 'explain';
  const page = current.sel.page || ctx.page || current.region?.page || 1;
  let selText = current.sel.text || '';
  let paraText = ctx.paraText || '';
  if (kind === 'translate') {
    selText = current.translateText || ctx.paraText || '';
    paraText = ctx.paraText || selText;
  } else if (kind === 'region') {
    const regionText = current.region?.regionText || '';
    const rect = current.region?.rect;
    selText =
      regionText ||
      (rect ? `第 ${page} 页框选区域（${Math.round(rect[2] - rect[0])}×${Math.round(rect[3] - rect[1])} pt）` : '');
    paraText = regionText;
  }
  const answer =
    current.status === 'done' || current.fromHistory ? stripMachineComment(current.entry?.answer || current.answer || '') : '';
  const payload = buildChatPayload({
    title: meta.title || '未命名论文',
    page,
    section: ctx.sectionTitle || '',
    selText,
    paraText,
    answer,
  });
  if (typeof deps.sendToChat !== 'function') {
    deps.toast?.('需在 DSH 窗口内使用', 'error');
    return;
  }
  if (!deps.sendToChat(payload)) deps.toast?.('需在 DSH 窗口内使用', 'error');
}

// ---------- 历史 ----------

function historyQuote(entry) {
  const kind = resolveKind(null, entry, 'explain');
  if (kind === 'region') {
    const rect = Array.isArray(entry.rect) ? entry.rect.map(Number) : null;
    if (entry.regionText) return entry.regionText;
    return rect
      ? `第 ${entry.page || '?'} 页框选区域（${Math.round(rect[2] - rect[0])}×${Math.round(rect[3] - rect[1])} pt）`
      : '框选区域';
  }
  return entry.selText || entry.normText || '（无原文）';
}

function renderHistory() {
  const list = dom?.historyList;
  if (!list) return;
  list.innerHTML = '';
  if (!docId) {
    list.appendChild(h('div', 'history-empty', '打开一篇论文后，这里会列出它的历史。'));
    return;
  }
  if (historyLoading) {
    list.appendChild(h('div', 'history-empty', '正在加载历史…'));
    return;
  }
  if (historyEntries === null) {
    list.appendChild(h('div', 'history-empty', '正在加载历史…'));
    loadHistory();
    return;
  }
  if (!historyEntries.length) {
    list.appendChild(h('div', 'history-empty', '还没有记录。解释、翻译、框选解释后都会保存在这里。'));
    return;
  }
  const currentId = current?.entry?.id;
  for (const entry of sortHistory(historyEntries)) {
    const kind = resolveKind(null, entry, 'explain');
    const item = h('button', 'history-item');
    item.type = 'button';
    item.dataset.id = entry.id;
    item.dataset.kind = kind;
    if (entry.id === currentId) item.classList.add('active');
    item.appendChild(h('div', 'history-quote', historyQuote(entry)));
    const meta = h('div', 'history-meta');
    const label = h('span', clsForKind(kind), kindLabel(kind));
    meta.appendChild(label);
    meta.appendChild(h('span', '', `第 ${entry.page || '?'} 页`));
    meta.appendChild(h('span', '', formatTime(entry.createdAt)));
    if (Number(entry.hitCount) > 0) {
      meta.appendChild(h('span', '', kind === 'translate' ? `已翻译 ${entry.hitCount} 次` : `已解释 ${entry.hitCount} 次`));
    }
    if (isOldRecipe(entry.recipe, kind)) meta.appendChild(h('span', 'badge', `旧配方 ${entry.recipe}`));
    item.appendChild(meta);
    item.addEventListener('click', () => openHistoryEntry(entry));
    list.appendChild(item);
  }
}

function clsForKind(kind) {
  if (kind === 'translate') return 'badge badge-translate';
  if (kind === 'region') return 'badge badge-region';
  return 'badge';
}

async function loadHistory() {
  if (historyLoading || !docId || !deps.api) return;
  if (historyEntries !== null) return;
  historyLoading = true;
  renderHistory();
  try {
    const res = await deps.api.getExplanations(docId);
    historyEntries = Array.isArray(res?.entries) ? res.entries : [];
  } catch (err) {
    historyEntries = [];
    deps.toast?.(`历史加载失败：${err.message || err}`, 'error');
  } finally {
    historyLoading = false;
    renderHistory();
  }
}

function openHistoryEntry(entry) {
  markActiveHistory(entry.id);
  if (deps.onJumpEntry) deps.onJumpEntry(entry);
  openEntry(entry);
}

function markActiveHistory(id) {
  if (!dom?.historyList) return;
  for (const node of dom.historyList.querySelectorAll('.history-item')) {
    node.classList.toggle('active', node.dataset.id === id);
  }
}

// ---------- 术语表 ----------

function updateTermsExport() {
  const link = dom?.termsExport;
  if (!link) return;
  if (!docId || typeof deps.api?.termsMdUrl !== 'function') {
    link.hidden = true;
    link.removeAttribute('href');
    return;
  }
  const meta = deps.getDocMeta ? deps.getDocMeta() : {};
  const safeTitle = String(meta.title || '术语表')
    .replace(/[\\/:*?"<>|\n\r]/g, '_')
    .slice(0, 80);
  link.hidden = false;
  link.href = deps.api.termsMdUrl(docId);
  link.setAttribute('download', `${safeTitle}-术语表.md`);
  link.title = '下载本论文术语表（Markdown 表格）';
}

function renderTerms() {
  const list = dom?.termsList;
  if (!list) return;
  list.innerHTML = '';
  updateTermsExport();
  if (!docId) {
    list.appendChild(h('div', 'terms-empty', '打开一篇论文后，这里会累积它解释过的术语。'));
    return;
  }
  if (termsLoading || terms === null) {
    list.appendChild(h('div', 'terms-empty', '正在加载术语…'));
    loadTerms(false);
    return;
  }
  if (!terms.length) {
    list.appendChild(
      h('div', 'terms-empty', '还没有术语。解释完成后会自动累积（不需要额外调用模型）。')
    );
    return;
  }
  for (const term of terms) {
    const item = h('button', 'terms-item');
    item.type = 'button';
    item.dataset.key = term.key || term.term || '';
    const top = h('div', 'terms-item-top');
    top.appendChild(h('span', 'terms-term', term.term || term.key || '（未命名术语）'));
    if (term.zh) top.appendChild(h('span', 'terms-zh', term.zh));
    if (Number(term.count) > 0) top.appendChild(h('span', 'terms-count', `×${Number(term.count)}`));
    item.appendChild(top);
    if (term.note) item.appendChild(h('div', 'terms-note', term.note));
    const metaParts = termMetaParts(term);
    if (metaParts.length) {
      const meta = h('div', 'terms-meta');
      for (const part of metaParts) meta.appendChild(h('span', '', part));
      item.appendChild(meta);
    }
    item.addEventListener('click', () => jumpToTerm(term));
    list.appendChild(item);
  }
}

function jumpToTerm(term) {
  const ok = deps.onTermJump ? deps.onTermJump(term.term, term) : false;
  if (ok === false) deps.toast?.(`原文里没有找到「${term.term || ''}」`, 'error');
}

async function loadTerms(force) {
  if (!docId || !deps.api || typeof deps.api.getTerms !== 'function') return;
  if (termsLoading) return;
  if (terms !== null && !force) {
    renderTerms();
    return;
  }
  termsLoading = true;
  terms = null;
  renderTerms();
  try {
    const res = await deps.api.getTerms(docId);
    terms = Array.isArray(res?.terms) ? res.terms : [];
  } catch (err) {
    terms = [];
    deps.toast?.(`术语加载失败：${err.message || err}`, 'error');
  } finally {
    termsLoading = false;
    if (activeTab === 'terms') renderTerms();
  }
}

/** 供外部（app.js）在窄态切换/窗口变化时重绘动作区。 */
export function refreshActions() {
  renderActions();
}
