/**
 * explain.js — 解释线程：SSE 流式解释、缓存命中态、历史、Markdown 渲染、转到对话。
 *
 * 接口契约见 CONTRACT.md：
 *   POST /api/explain → text/event-stream，事件 {type:'meta'|'delta'|'done'|'error'}
 *   GET  /api/docs/:id/explanations[?index=1]
 *
 * 本文件顶层的纯函数（renderMarkdown / createSSEParser / buildChatPayload）可在 Node 里
 * 直接 import 做单测，不触碰 DOM。
 */

// ---------- 纯函数 ----------

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** HTML 转义（Markdown 渲染第一步，必须先转义再拼标签）。 */
export function escapeHtml(text) {
  return String(text == null ? '' : text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
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
  if (!src) return '';
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
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
  onJump: null,
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
    tabCurrent: document.getElementById('tab-current'),
    tabHistory: document.getElementById('tab-history'),
  };
  dom.tabCurrent.addEventListener('click', () => showTab('current'));
  dom.tabHistory.addEventListener('click', () => showTab('history'));
  renderThread();
}

/** 切换文档：清空线程与历史缓存。 */
export function reset(id, structureData) {
  abortCurrentRequest();
  docId = id || null;
  structure = structureData || null;
  paraById = new Map((structure?.paras || []).map((p) => [p.id, p]));
  sectionById = new Map((structure?.sections || []).map((s) => [s.id, s]));
  current = null;
  historyEntries = null;
  historyLoading = false;
  renderThread();
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
  requestExplain(sel, { force });
}

/** 直接打开一条已有解释（历史 / 原文标记），不发请求。 */
export function openEntry(entry) {
  if (!entry) return;
  abortCurrentRequest();
  const sel = { page: entry.page, paraId: entry.paraId, text: entry.selText || '' };
  current = {
    sel,
    ctx: buildSelectionContext(sel),
    status: 'done',
    meta: { cached: (entry.hitCount || 0) > 0, hitCount: entry.hitCount || 0 },
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

export function showTab(tab, { force = false } = {}) {
  activeTab = tab === 'history' ? 'history' : 'current';
  const isHistory = activeTab === 'history';
  dom.paneCurrent.hidden = isHistory;
  dom.paneHistory.hidden = !isHistory;
  dom.tabCurrent.classList.toggle('active', !isHistory);
  dom.tabHistory.classList.toggle('active', isHistory);
  dom.tabCurrent.setAttribute('aria-selected', String(!isHistory));
  dom.tabHistory.setAttribute('aria-selected', String(isHistory));
  if (isHistory) renderHistory();
  if (force) {
    dom.paneCurrent.hidden = isHistory;
    dom.paneHistory.hidden = !isHistory;
  }
}

export function activeTabName() {
  return activeTab;
}

// ---------- 解释请求 ----------

function buildSelectionContext(sel) {
  const ctx = deps.getParaContext ? deps.getParaContext(sel.paraId) || {} : {};
  return {
    paraText: ctx.paraText || '',
    prevPara: ctx.prevPara || '',
    nextPara: ctx.nextPara || '',
    page: ctx.page || sel.page,
    sectionTitle: ctx.sectionTitle || sectionTitleFor(sel.paraId),
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

async function requestExplain(sel, { force = false } = {}) {
  if (!deps.api) return;
  abortCurrentRequest();
  const controller = new AbortController();
  abortController = controller;

  current = {
    sel,
    ctx: buildSelectionContext(sel),
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
    const res = await deps.api.explainStream(
      {
        docId,
        sel: { page: sel.page, paraId: sel.paraId, text: sel.text },
        force: !!force,
      },
      controller.signal
    );
    if (!res || !res.ok) {
      const info = res ? await readJsonSafe(res) : null;
      throw makeError(info?.error?.message || `解释请求失败（HTTP ${res?.status ?? '网络错误'}）`, info?.error?.code);
    }
    if (!res.body) throw makeError('当前环境不支持流式响应');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const parser = createSSEParser((ev) => {
      if (current?.token === token) handleEvent(ev);
    }, (err, payload) => {
      console.warn('[paper-reader] SSE 解析失败', err, payload);
    });

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
        message: '连接中断，解释未完成（不会写入缓存）。可以重试。',
      };
      renderThread();
    }
  } catch (err) {
    if (err?.name === 'AbortError' || controller.signal.aborted) return;
    if (!current) return;
    current.status = 'error';
    current.error = { code: err?.code || 'explain-failed', message: err?.message || '解释失败，请重试' };
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
      current.status = 'done';
      if (!current.answer && current.entry?.answer) current.answer = current.entry.answer;
      if (current.entry) deps.onEntrySaved?.(current.entry, current.sel);
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
      '也可以<b>双击</b>句子直接解释；解释会带上下文，并自动缓存。';
    root.appendChild(empty);
    dom.statusEl = null;
    dom.answerEl = null;
    dom.actionsEl = null;
    return;
  }

  // 1. 选句卡片
  const selCard = h('div', 'thread-sel');
  const quote = h('div', 'thread-sel-quote', current.sel.text || '（空选句）');
  const metaRow = h('div', 'thread-sel-meta');
  const page = current.ctx?.page || current.sel.page;
  const section = current.ctx?.sectionTitle || '';
  metaRow.appendChild(h('span', '', `第 ${page || '?'} 页${section ? ` · ${section}` : ''}`));
  if (current.sel.paraId) metaRow.appendChild(h('span', '', current.sel.paraId));
  if (current.fromHistory) metaRow.appendChild(h('span', 'badge', '来自历史'));
  selCard.append(quote, metaRow);
  root.appendChild(selCard);

  // 2. 状态行
  dom.statusEl = h('div', 'thread-status');
  root.appendChild(dom.statusEl);

  // 3. 错误块 / 答案
  if (current.status === 'error') {
    const errBox = h('div', 'thread-error');
    errBox.appendChild(h('div', '', `解释失败：${current.error?.message || '未知错误'}`));
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
      (current.status === 'done' ? '<p class="thread-hint">这条历史记录没有解释正文。</p>' : '');
    root.appendChild(dom.answerEl);
  }

  // 4. 操作区
  dom.actionsEl = h('div', 'thread-actions');
  root.appendChild(dom.actionsEl);
  renderActions();
  updateStatus();
  root.scrollTop = scrollTop;
}

function renderActions() {
  const box = dom?.actionsEl;
  if (!box) return;
  box.innerHTML = '';
  if (!current) return;

  const streaming = current.status === 'waiting' || current.status === 'streaming';
  const done = current.status === 'done';
  const hasAnswer = !!(current.answer || current.entry?.answer);

  const reBtn = button(streaming ? '解释中…' : '重新解释', 'btn', () => retry(true));
  reBtn.disabled = streaming;
  if (!streaming) reBtn.title = '重新调用模型解释（会消耗一次调用）';
  box.appendChild(reBtn);

  const copyBtn = button('复制', 'btn', () => copyAnswer());
  copyBtn.disabled = !hasAnswer;
  box.appendChild(copyBtn);

  const chatBtn = button('转到对话', 'btn btn-primary', () => sendToChat());
  chatBtn.disabled = streaming || !deps.embedded;
  if (!deps.embedded) chatBtn.title = '需在 DSH 窗口内使用';
  box.appendChild(chatBtn);

  if (!deps.embedded) {
    box.appendChild(h('span', 'thread-hint', '「转到对话」需在 DSH 窗口内使用'));
  } else if (done) {
    box.appendChild(h('span', 'thread-hint', '会填入当前对话输入框，不自动发送'));
  }
}

function updateStatus() {
  const el = dom?.statusEl;
  if (!el || !current) return;
  el.innerHTML = '';
  const status = current.status;

  if (status === 'waiting') {
    el.appendChild(h('span', 'badge badge-live', '准备中…'));
    return;
  }
  if (status === 'streaming') {
    const hit = current.metaHitCount ?? current.meta?.hitCount;
    if (current.cached) {
      el.appendChild(h('span', 'badge badge-cache', `缓存命中 · 已解释 ${hit ?? 0} 次`));
    } else {
      el.appendChild(h('span', 'badge badge-live', '生成中…'));
    }
    return;
  }
  if (status === 'done') {
    const entry = current.entry;
    const hit = current.meta?.hitCount ?? entry?.hitCount ?? 0;
    if (current.cached) {
      el.appendChild(h('span', 'badge badge-cache', `缓存命中 · 已解释 ${hit} 次`));
    } else if (current.fromHistory) {
      el.appendChild(h('span', 'badge', '历史记录 · 0 token'));
    } else {
      el.appendChild(h('span', 'badge', '已保存到历史'));
    }
    if (entry?.model) el.appendChild(h('span', '', `模型 ${entry.model}`));
    if (entry?.createdAt) el.appendChild(h('span', '', formatTime(entry.createdAt)));
    if (entry?.recipe && entry.recipe !== 'v1') el.appendChild(h('span', 'badge', `旧配方 ${entry.recipe}`));
    return;
  }
  if (status === 'error') {
    el.appendChild(h('span', 'badge', current.error?.code === 'incomplete' ? '未完成' : '失败'));
  }
}

function updateAnswer() {
  if (!dom?.answerEl || !current) return;
  if (current.status === 'waiting' || current.status === 'streaming') {
    dom.answerEl.classList.add('pr-md-streaming');
  }
  dom.answerEl.innerHTML = renderMarkdown(current.answer);
}

function retry(force = false) {
  if (!current) return;
  const sel = current.sel;
  const nextForce = force === true ? true : current.force;
  requestExplain(sel, { force: nextForce });
}

async function copyAnswer() {
  const text = current?.answer || current?.entry?.answer || '';
  if (!text) return;
  const ok = await copyText(text);
  deps.toast?.(ok ? '已复制解释' : '复制失败，请手动选择复制', ok ? 'info' : 'error');
}

function sendToChat() {
  if (!current) return;
  if (!deps.embedded) {
    deps.toast?.('需在 DSH 窗口内使用', 'error');
    return;
  }
  const meta = deps.getDocMeta ? deps.getDocMeta() : {};
  const ctx = current.ctx || {};
  const answer =
    current.status === 'done' || current.fromHistory ? current.entry?.answer || current.answer : '';
  const payload = buildChatPayload({
    title: meta.title || '未命名论文',
    page: ctx.page || current.sel.page,
    section: ctx.sectionTitle || '',
    selText: current.sel.text,
    paraText: ctx.paraText || '',
    answer,
  });
  if (!deps.embedded || typeof deps.sendToChat !== 'function') {
    deps.toast?.('需在 DSH 窗口内使用', 'error');
    return;
  }
  if (!deps.sendToChat(payload)) deps.toast?.('需在 DSH 窗口内使用', 'error');
}

// ---------- 历史 ----------

function renderHistory() {
  const list = dom?.historyList;
  if (!list) return;
  list.innerHTML = '';
  if (!docId) {
    list.appendChild(h('div', 'history-empty', '打开一篇论文后，这里会列出它的解释历史。'));
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
    list.appendChild(h('div', 'history-empty', '还没有解释记录。选中句子解释后会自动保存在这里。'));
    return;
  }
  const currentId = current?.entry?.id;
  for (const entry of sortHistory(historyEntries)) {
    const item = h('button', 'history-item');
    item.type = 'button';
    item.dataset.id = entry.id;
    if (entry.id === currentId) item.classList.add('active');
    item.appendChild(h('div', 'history-quote', entry.selText || entry.normText || '（无原句）'));
    const meta = h('div', 'history-meta');
    meta.appendChild(h('span', '', `第 ${entry.page || '?'} 页`));
    meta.appendChild(h('span', '', formatTime(entry.createdAt)));
    if (entry.hitCount > 0) meta.appendChild(h('span', '', `已解释 ${entry.hitCount} 次`));
    if (entry.recipe && entry.recipe !== 'v1') meta.appendChild(h('span', 'badge', `旧配方 ${entry.recipe}`));
    item.appendChild(meta);
    item.addEventListener('click', () => openHistoryEntry(entry));
    list.appendChild(item);
  }
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
  if (deps.onJump) deps.onJump(entry.page, entry.paraId);
  openEntry(entry);
}

function markActiveHistory(id) {
  if (!dom?.historyList) return;
  for (const node of dom.historyList.querySelectorAll('.history-item')) {
    node.classList.toggle('active', node.dataset.id === id);
  }
}

/** 供外部（app.js）在窄态切换/窗口变化时重绘动作区。 */
export function refreshActions() {
  renderActions();
}
