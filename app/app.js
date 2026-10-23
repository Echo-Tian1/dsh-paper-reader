/**
 * app.js — 阅读器页面启动与编排：API 客户端、顶栏、上传、空状态、窄态、ui-state、主题桥。
 *
 * 接口一律以 CONTRACT.md 为准；所有请求经 state.api，便于 ?fixture=1 时换成 fixture mock。
 */

import * as bridge from './bridge.js';
import * as paper from './paper.js';
import * as explain from './explain.js';

const params = new URLSearchParams(location.search);
const FIXTURE = params.get('fixture') === '1';

// 宿主把全部路由注册在 prefix /dsh-paper-reader 下（CONTRACT.md §2 的路径都是相对前缀的简写）。
// 正式模式下所有 HTTP 请求（含页图 <img>）都必须带上这个前缀。
const API_BASE = '/dsh-paper-reader';

const BUILD = '2026-10-23T13:20';
const els = {};
let appEl = null;
let uiTimer = null;
let toastTimer = null;
let errorRetry = null;
let dragDepth = 0;

const state = {
  api: null,
  fixture: FIXTURE,
  docs: [],
  doc: null,
  structure: null,
  ui: { lastDocId: null, perDoc: {} },
  sel: null,
  currentPage: 1,
  narrow: false,
  paneOpen: false,
  paneCollapsed: false,
};

let pendingRegion = null; // { page, rect }：框选完、等工具条确认的区域

// ---------- HTTP 客户端（正式模式） ----------

async function parseResponse(res) {
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    data = null;
  }
  if (!res.ok) {
    const error = new Error(data?.error?.message || `请求失败（HTTP ${res.status}）`);
    error.code = data?.error?.code;
    error.status = res.status;
    throw error;
  }
  if (data == null) throw new Error('接口返回了无法解析的内容');
  return data;
}

function postStream(path, body, signal) {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify(body),
    signal,
  });
}

const httpApi = {
  fixture: false,

  async health() {
    try {
      return await parseResponse(await fetch(`${API_BASE}/api/health`, { cache: 'no-store' }));
    } catch (err) {
      return null;
    }
  },

  async listDocs() {
    return parseResponse(await fetch(`${API_BASE}/api/docs`, { cache: 'no-store' }));
  },

  async upload(file) {
    return parseResponse(
      await fetch(`${API_BASE}/api/docs`, {
        method: 'POST',
        headers: { 'content-type': 'application/pdf' },
        body: file,
      })
    );
  },

  pageImageUrl(docId, n) {
    return `${API_BASE}/media/${encodeURIComponent(docId)}/page-${n}.png`;
  },

  async getStructure(docId) {
    return parseResponse(await fetch(`${API_BASE}/api/docs/${encodeURIComponent(docId)}/structure`, { cache: 'no-store' }));
  },

  async getPage(docId, n) {
    return parseResponse(
      await fetch(`${API_BASE}/api/docs/${encodeURIComponent(docId)}/pages/${n}`, { cache: 'no-store' })
    );
  },

  async getIndex(docId) {
    return parseResponse(
      await fetch(`${API_BASE}/api/docs/${encodeURIComponent(docId)}/explanations?index=1`, { cache: 'no-store' })
    );
  },

  async getExplanations(docId) {
    return parseResponse(
      await fetch(`${API_BASE}/api/docs/${encodeURIComponent(docId)}/explanations`, { cache: 'no-store' })
    );
  },

  explainStream(body, signal) {
    return postStream(`${API_BASE}/api/explain`, body, signal);
  },

  translateStream(body, signal) {
    return postStream(`${API_BASE}/api/translate`, body, signal);
  },

  explainRegionStream(body, signal) {
    return postStream(`${API_BASE}/api/explain-region`, body, signal);
  },

  async getTerms(docId) {
    return parseResponse(
      await fetch(`${API_BASE}/api/docs/${encodeURIComponent(docId)}/terms`, { cache: 'no-store' })
    );
  },

  termsMdUrl(docId) {
    return `${API_BASE}/api/docs/${encodeURIComponent(docId)}/terms.md`;
  },

  async postUiState(uiState) {
    try {
      return await parseResponse(
        await fetch(`${API_BASE}/api/ui-state`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(uiState),
        })
      );
    } catch (err) {
      return null;
    }
  },

  async getUiState() {
    try {
      return await parseResponse(await fetch(`${API_BASE}/api/ui-state`, { cache: 'no-store' }));
    } catch (err) {
      return null;
    }
  },
};

// ---------- 启动 ----------

/* ------------------------------------------------------------------ *
 * 客户端诊断：把初始化/运行期异常直接显示在页面上，并把构建号暴露出来
 * （用户点左上角「文献阅读坞」可看到构建号与缺失节点，便于远程定位）
 * ------------------------------------------------------------------ */
const reportedErrors = new Set();
function reportClientError(label, detail) {
  const text = `${label}：${detail || '未知错误'}`;
  if (reportedErrors.has(text)) return;
  reportedErrors.add(text);
  try { console.error('[paper-reader]', text); } catch (err) { /* ignore */ }
  try { showError(`${text}（构建 ${BUILD}）`); } catch (err) { /* 页面还没准备好就只进 console */ }
}

const EXPECTED_NODES = [
  'topbar', 'paper-area', 'paper-content', 'explain-pane',
  'tab-current', 'tab-history', 'tab-terms',
  'pane-current', 'pane-history', 'pane-terms',
  'thread', 'history-list', 'terms-list',
];
function missingNodes() {
  return EXPECTED_NODES.filter((id) => !document.getElementById(id));
}
function wireDiagnostics() {
  window.addEventListener('error', (event) => {
    reportClientError('脚本错误', event.message || String(event.error || ''));
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    reportClientError('异步错误', reason && reason.message ? reason.message : String(reason || ''));
  });
  const brand = document.querySelector('.brand');
  if (brand) {
    brand.style.cursor = 'pointer';
    brand.title = '点击查看构建号与自检信息';
    brand.addEventListener('click', () => {
      const missing = missingNodes();
      const activeTab = document.querySelector('.tab.active')?.id || 'none';
      toast(`构建 ${BUILD}｜当前页签 ${activeTab}｜缺失节点：${missing.length ? missing.join('、') : '无'}`);
    });
  }
}

async function main() {
  cacheEls();
  wireEvents();
  wireDiagnostics();
  updateNarrow();

  bridge.initBridge({ onTheme: handleHostTheme, onChatAck: handleChatAck });
  bridge.postReady();
  bridge.notifyHeight(true);

  if (FIXTURE) {
    const module = await import('./fixture/mock.js');
    state.api = module.createApi();
  } else {
    state.api = httpApi;
  }

  try {
  explain.init({
    api: state.api,
    embedded: bridge.embedded,
    getDocMeta: () => ({ title: state.structure?.title || state.doc?.title || '' }),
    getParaContext: paper.getParaContext,
    getRegionThumbnail: (page, rect) => paper.regionThumbnail(page, rect),
    ensurePageImage: (page) => paper.ensurePageImage(page),
    onTermJump: (term) => paper.jumpToTerm(term),
    onJumpEntry: (entry) => {
      paper.scrollToPage(entry.page);
      if (entry.kind === 'region') paper.flashRegion(entry.page, entry.rect);
      else paper.flashPara(entry.paraId);
    },
    onEntrySaved: (entry) => {
      paper.addExplanation(entry);
      explain.invalidateHistory();
    },
    sendToChat: (payload) => requestChatRoute(payload),
    toast,
  });
  } catch (err) {
    reportClientError('解释栏初始化失败', err && err.message ? err.message : String(err));
  }

  try {
  paper.init({
    api: state.api,
    scrollEl: els.paperScroll,
    contentEl: els.paperContent,
    onSelectionChange: handleSelectionChange,
    onExplainSelection: (info) => runExplain(info),
    onOpenEntry: async (entry) => {
      // 原文标记来自 ?index=1 精简索引（没有 answer），点开时补全为完整条目
      let full = entry;
      if (!full?.answer && state.doc) {
        try {
          const data = await state.api.getExplanations(state.doc.id);
          full = (data?.entries || []).find((item) => item.id === entry.id) || entry;
        } catch (err) {
          full = entry;
        }
      }
      explain.openEntry(full);
      if (state.narrow) openPane();
      else setCollapsed(false);
    },
    onPageChange: handlePageChange,
    onRegionChange: handleRegionChange,
    toast,
  });
  } catch (err) {
    reportClientError('论文区初始化失败', err && err.message ? err.message : String(err));
  }

  explain.setEmbedded(bridge.embedded);

  await refreshDocs();

  // /api/docs 只带 lastDocId；每篇上次页码 / scrollTop 在 /api/ui-state
  try {
    const uiState = await state.api.getUiState();
    if (uiState && typeof uiState === 'object') {
      state.ui = { ...state.ui, ...uiState };
      if (uiState.perDoc && typeof uiState.perDoc === 'object') {
        state.ui.perDoc = { ...(state.ui.perDoc || {}), ...uiState.perDoc };
      }
    }
  } catch (err) {
    /* 拿不到 ui-state 就退回 lastPage */
  }

  const wanted = params.get('doc') || state.ui.lastDocId;
  const doc = state.docs.find((d) => d.id === wanted) || state.docs[0] || null;
  if (doc) {
    await openDoc(doc.id);
  } else {
    showEmptyState();
  }

  if (!FIXTURE) probeHealth();
}

function cacheEls() {
  appEl = document.getElementById('app');
  const ids = [
    'paper-scroll',
    'paper-content',
    'empty-state',
    'recent-list',
    'recent-empty',
    'empty-upload',
    'doc-title',
    'page-indicator',
    'docs-select',
    'upload-btn',
    'file-input',
    'errorbar',
    'error-text',
    'error-retry',
    'error-close',
    'pane-toggle',
    'pane-close',
    'drawer-backdrop',
    'selection-toolbar',
    'region-toolbar',
    'toast',
    'busy',
    'busy-text',
  ];
  for (const id of ids) {
    els[id.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase())] = document.getElementById(id);
  }
}

// ---------- 事件接线 ----------

function wireEvents() {
  els.uploadBtn.addEventListener('click', () => els.fileInput.click());
  els.emptyUpload.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files?.[0];
    els.fileInput.value = '';
    if (file) uploadFile(file);
  });

  els.docsSelect.addEventListener('change', () => {
    const id = els.docsSelect.value;
    if (id && id !== state.doc?.id) openDoc(id);
  });

  els.errorClose.addEventListener('click', hideError);
  els.errorRetry.addEventListener('click', () => {
    const retry = errorRetry;
    hideError();
    if (retry) retry();
  });

  els.paneToggle.addEventListener('click', togglePane);
  els.paneClose.addEventListener('click', () => {
    if (state.narrow) closePane();
    else setCollapsed(true);
  });
  els.drawerBackdrop.addEventListener('click', closePane);

  const toolbar = els.selectionToolbar;
  toolbar.addEventListener('mousedown', (event) => event.preventDefault()); // 保住选区
  toolbar.addEventListener('click', (event) => {
    const action = event.target.closest('[data-act]')?.dataset.act;
    if (!action) return;
    if (action === 'explain') {
      const info = state.sel;
      hideToolbar();
      if (info) runExplain(info);
    } else if (action === 'translate') {
      const info = state.sel;
      hideToolbar();
      if (info) runTranslate(info);
    } else if (action === 'copy') {
      const info = state.sel;
      hideToolbar();
      if (info) copyText(info.text);
    } else {
      hideToolbar();
      paper.clearSelection();
    }
  });

  els.paperScroll.addEventListener('scroll', () => {
    hideToolbar();
    if (pendingRegion) cancelRegion();
  }, { passive: true });

  wireRegionToolbar();

  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragover', onDragOver);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('drop', onDrop);

  window.addEventListener('resize', updateNarrow);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      hideToolbar();
      if (pendingRegion) cancelRegion();
      if (state.narrow && state.paneOpen) closePane();
    }
  });
}

// ---------- 文档列表 / 打开 ----------

async function refreshDocs() {
  try {
    const data = await state.api.listDocs();
    state.docs = Array.isArray(data?.docs) ? data.docs : [];
    state.ui = data?.ui || { lastDocId: null, perDoc: {} };
    renderDocsSelect();
    renderRecent();
  } catch (err) {
    if (!FIXTURE) {
      showError(`无法连接插件服务：${err.message || err}`, { retry: () => location.reload() });
    } else {
      showError(`fixture 加载失败：${err.message || err}`);
    }
  }
}

function renderDocsSelect() {
  const select = els.docsSelect;
  select.innerHTML = '';
  if (!state.docs.length) {
    select.hidden = true;
    return;
  }
  select.hidden = false;
  for (const doc of state.docs) {
    const option = document.createElement('option');
    option.value = doc.id;
    option.textContent = `${doc.title || '未命名论文'}${doc.pageCount ? ` · ${doc.pageCount} 页` : ''}`;
    select.appendChild(option);
  }
  select.value = state.doc?.id || state.ui.lastDocId || '';
}

function renderRecent() {
  const list = els.recentList;
  list.innerHTML = '';
  const docs = [...state.docs].sort((a, b) =>
    String(b.lastOpenedAt || b.addedAt || '').localeCompare(String(a.lastOpenedAt || a.addedAt || ''))
  );
  els.recentEmpty.hidden = docs.length > 0;
  for (const doc of docs) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'recent-item';
    const title = document.createElement('span');
    title.className = 'recent-item-title';
    title.textContent = doc.title || '未命名论文';
    const meta = document.createElement('span');
    meta.className = 'recent-item-meta';
    meta.textContent = [doc.pageCount ? `${doc.pageCount} 页` : '', doc.explained ? `已解释 ${doc.explained}` : '']
      .filter(Boolean)
      .join(' · ');
    item.append(title, meta);
    item.addEventListener('click', () => openDoc(doc.id));
    list.appendChild(item);
  }
}

function showEmptyState() {
  els.emptyState.hidden = false;
  els.docTitle.textContent = '未打开论文';
  els.pageIndicator.hidden = true;
  els.docsSelect.hidden = state.docs.length === 0;
  state.doc = null;
  state.structure = null;
  renderRecent();
}

function hideEmptyState() {
  els.emptyState.hidden = true;
}

async function openDoc(docId, { restoreScrollTop = null } = {}) {
  if (!docId || !state.api) return;
  hideToolbar();
  cancelRegion();
  setBusy(true, '正在打开论文…');
  try {
    const structure = await state.api.getStructure(docId);
    const doc =
      state.docs.find((d) => d.id === docId) || {
        id: docId,
        title: structure.title,
        pageCount: structure.pageCount,
        lastPage: 1,
      };
    state.doc = doc;
    state.structure = structure;
    hideEmptyState();

    els.docTitle.textContent = structure.title || doc.title || '未命名论文';
    els.pageIndicator.hidden = false;
    els.pageIndicator.textContent = `1 / ${structure.pageCount || structure.pages?.length || 1}`;

    renderDocsSelect();

    const persisted = state.ui.perDoc?.[docId] || {};
    const scrollTop = restoreScrollTop != null ? restoreScrollTop : persisted.scrollTop || 0;
    await paper.load({
      docId,
      structure,
      restore: { lastPage: doc.lastPage || persisted.lastPage || 1, scrollTop },
    });

    explain.reset(docId, structure);
    explain.setEmbedded(bridge.embedded);
    state.currentPage = paper.getCurrentPage();
    updatePageIndicator();

    let indexPayload = null;
    try {
      indexPayload = await state.api.getIndex(docId);
    } catch (err) {
      indexPayload = null;
    }
    paper.setExplanations(indexPayload || []);

    state.ui = { ...state.ui, lastDocId: docId };
    persistUi();
    closePane();
  } catch (err) {
    showError(`打开论文失败：${err.message || err}`, { retry: () => openDoc(docId) });
  } finally {
    setBusy(false);
  }
}

function handlePageChange(n) {
  state.currentPage = n;
  updatePageIndicator();
  schedulePersist();
  hideToolbar();
  if (pendingRegion) cancelRegion();
}

function updatePageIndicator() {
  const total = state.structure?.pageCount || paper.getPageCount() || 1;
  els.pageIndicator.textContent = `${paper.getCurrentPage() || state.currentPage} / ${total}`;
}

// ---------- ui-state 持久化 ----------

function schedulePersist() {
  clearTimeout(uiTimer);
  uiTimer = setTimeout(() => persistUi(), 500);
}

async function persistUi() {
  clearTimeout(uiTimer);
  uiTimer = null;
  if (!state.api || !state.doc) return;
  const perDoc = { ...(state.ui.perDoc || {}) };
  perDoc[state.doc.id] = {
    lastPage: paper.getCurrentPage() || 1,
    scrollTop: paper.getScrollTop() || 0,
  };
  state.ui = { ...state.ui, lastDocId: state.doc.id, perDoc };
  await state.api.postUiState({ lastDocId: state.doc.id, perDoc });
}

// ---------- 上传 ----------

function hasFiles(event) {
  const types = event.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes('Files');
}

function onDragEnter(event) {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  showDrop(true);
}

function onDragOver(event) {
  if (!hasFiles(event)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
}

function onDragLeave(event) {
  if (!hasFiles(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) showDrop(false);
}

function onDrop(event) {
  if (!hasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  showDrop(false);
  const file = event.dataTransfer?.files?.[0];
  if (file) uploadFile(file);
}

function showDrop(visible) {
  const overlay = document.getElementById('drop-overlay');
  if (overlay) overlay.hidden = !visible;
}

async function uploadFile(file) {
  if (!file) return;
  const isPdf = /\.pdf$/i.test(file.name || '') || file.type === 'application/pdf';
  if (!isPdf) {
    showError('只能打开 PDF 文件。');
    return;
  }
  hideError();
  setBusy(true, '正在上传并抽取文字层…');
  try {
    const res = await state.api.upload(file);
    if (!res || res.ok === false) {
      const error = new Error(res?.error?.message || '上传失败');
      error.code = res?.error?.code;
      throw error;
    }
    toast(res.reused ? '这篇论文已在列表中，直接打开' : `已导入：${res.doc?.title || file.name}`);
    await refreshDocs();
    await openDoc(res.doc?.id);
  } catch (err) {
    showError(`打开 PDF 失败：${err.message || err}`, { retry: () => uploadFile(file) });
  } finally {
    setBusy(false);
  }
}

// ---------- 选区工具条 ----------

function handleSelectionChange(info) {
  state.sel = info;
  if (!info || !info.text) {
    hideToolbar();
    return;
  }
  if (pendingRegion) cancelRegion();
  showToolbar(info.rect);
}

function showToolbar(rect) {
  const bar = els.selectionToolbar;
  bar.hidden = false;
  const barWidth = bar.offsetWidth || 150;
  const barHeight = bar.offsetHeight || 30;
  let left = (rect?.left || 0) + (rect?.width || 0) / 2;
  left = Math.min(Math.max(left, barWidth / 2 + 8), window.innerWidth - barWidth / 2 - 8);
  let top = (rect?.top || 0) - barHeight - 8;
  if (top < 56) top = (rect?.bottom || 0) + 8;
  top = Math.min(Math.max(top, 8), window.innerHeight - barHeight - 8);
  bar.style.left = `${Math.round(left)}px`;
  bar.style.top = `${Math.round(top)}px`;
  const actions = paper.selectionActionState(state.sel);
  for (const btn of bar.querySelectorAll('[data-act]')) {
    const act = btn.dataset.act;
    if (act in actions) btn.disabled = !actions[act];
  }
  const translateBtn = bar.querySelector('[data-act="translate"]');
  if (translateBtn) {
    translateBtn.title = actions.translate ? '把所在段落整段翻译' : '选区没有落到段落上，无法整段翻译';
  }
}

function hideToolbar() {
  if (els.selectionToolbar) els.selectionToolbar.hidden = true;
}

function runExplain(info) {
  if (!info || !info.text || !state.doc) return;
  hideToolbar();
  explain.explainSelection({ page: info.page, paraId: info.paraId, text: info.text });
  if (state.narrow) openPane();
  else setCollapsed(false);
}

function runTranslate(info) {
  if (!info?.paraId || !state.doc) {
    toast('这个选区没有落到段落上，无法整段翻译', 'error');
    return;
  }
  const ctx = paper.getParaContext(info.paraId);
  explain.translatePara({
    page: info.page,
    paraId: info.paraId,
    paraText: ctx.paraText,
    sectionTitle: ctx.sectionTitle,
  });
  if (state.narrow) openPane();
  else setCollapsed(false);
}

async function copyText(text) {
  const ok = await explain.copyText(text);
  toast(ok ? '已复制选句' : '复制失败，请手动复制', ok ? 'info' : 'error');
}

// ---------- Shift 框选区域 ----------

function wireRegionToolbar() {
  const bar = els.regionToolbar;
  if (!bar) return;
  bar.addEventListener('mousedown', (event) => event.preventDefault());
  bar.addEventListener('click', (event) => {
    const act = event.target.closest('[data-region-act]')?.dataset.regionAct;
    if (!act) return;
    if (act === 'explain') {
      const region = pendingRegion;
      hideRegionToolbar();
      paper.clearRegion();
      if (region) runRegionExplain(region);
    } else {
      cancelRegion();
    }
  });
}

function handleRegionChange(region) {
  pendingRegion = region ? { page: region.page, rect: [...region.rect] } : null;
  if (!region) {
    hideRegionToolbar();
    return;
  }
  hideToolbar();
  showRegionToolbar(region.client);
}

function showRegionToolbar(client) {
  const bar = els.regionToolbar;
  if (!bar) return;
  bar.hidden = false;
  const barWidth = bar.offsetWidth || 210;
  const barHeight = bar.offsetHeight || 32;
  const anchorX = Number.isFinite(client?.x) ? client.x : window.innerWidth / 2;
  const anchorY = Number.isFinite(client?.y) ? client.y : 120;
  let left = anchorX;
  left = Math.min(Math.max(left, barWidth / 2 + 8), window.innerWidth - barWidth / 2 - 8);
  let top = anchorY - barHeight - 10;
  if (top < 56) top = anchorY + 14;
  top = Math.min(Math.max(top, 8), window.innerHeight - barHeight - 8);
  bar.style.left = `${Math.round(left)}px`;
  bar.style.top = `${Math.round(top)}px`;
}

function hideRegionToolbar() {
  if (els.regionToolbar) els.regionToolbar.hidden = true;
}

function cancelRegion() {
  pendingRegion = null;
  hideRegionToolbar();
  paper.clearRegion();
}

function runRegionExplain(region) {
  if (!state.doc) return;
  explain.explainRegion({ page: region.page, rect: region.rect });
  if (state.narrow) openPane();
  else setCollapsed(false);
}

// ---------- 窄态抽屉 ----------

function updateNarrow() {
  const narrow = window.innerWidth < 980;
  state.narrow = narrow;
  appEl.classList.toggle('narrow', narrow);
  if (narrow) setCollapsed(false);
  if (!narrow) closePane();
  syncPaneButtons();
  updatePageIndicator();
}

/** 宽态下收起/展开解释栏（窄态用覆盖抽屉）。 */
function setCollapsed(collapsed) {
  state.paneCollapsed = !!collapsed;
  appEl.classList.toggle('pane-collapsed', state.paneCollapsed);
  syncPaneButtons();
}

function syncPaneButtons() {
  if (els.paneToggle) {
    els.paneToggle.hidden = !(state.narrow || state.paneCollapsed);
    els.paneToggle.title = '打开解释栏';
  }
  if (els.paneClose) {
    els.paneClose.hidden = false;
    els.paneClose.title = state.narrow ? '收起解释栏' : '收起解释栏';
  }
}

function openPane() {
  if (!state.narrow) return;
  state.paneOpen = true;
  appEl.classList.add('pane-open');
  els.drawerBackdrop.hidden = false;
}

function closePane() {
  state.paneOpen = false;
  appEl.classList.remove('pane-open');
  if (els.drawerBackdrop) els.drawerBackdrop.hidden = true;
}

function togglePane() {
  if (state.narrow) {
    if (state.paneOpen) closePane();
    else openPane();
    return;
  }
  setCollapsed(!state.paneCollapsed);
}

// ---------- 宿主消息 ----------

function handleHostTheme(theme) {
  // bridge.applyTheme 已把颜色写进 --pr-*；布局只需在窗口尺寸变化时调整
  if (theme?.mode) updateNarrow();
}

/** 「转到对话」进行中的一次请求（等待宿主的 chat-ack）。 */
let pendingChat = null;

/**
 * 把文本直接写进父窗口（DSH）的编辑器。
 * 兼容兜底通道：当薄壳的会话服务桥接失败时，同源 iframe 仍可直接操作父页面 DOM。
 * React 受控 textarea 必须用原型上的 value setter 写值，再派发 input 事件。
 */
function injectIntoParentComposer(text) {
  try {
    const doc = window.parent && window.parent !== window ? window.parent.document : null;
    if (!doc) return false;
    const boxes = [...doc.querySelectorAll('textarea')].filter((el) => {
      if (el.disabled || el.readOnly) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 40 && rect.height > 10;
    });
    // 输入框在窗口底部：取最靠下的那个（避开设置页/搜索框等其他 textarea）
    boxes.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top);
    const target = boxes[0];
    if (!target) return false;
    target.focus();
    const proto = Object.getPrototypeOf(target);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(target, text);
    else target.value = text;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  } catch (err) {
    console.warn('[paper-reader] parent composer fallback failed:', err);
    return false;
  }
}

/** 宿主桥接失败时的统一兜底：先试兼容写入，再退剪贴板，并把真实原因说清楚。 */
function fallbackChatRoute(payload, reason, detail) {
  if (injectIntoParentComposer(payload)) {
    toast('已填入对话输入框', 'info');
    return;
  }
  void copyText(payload).then((ok) => {
    const why = detail ? `：${detail}` : reason ? `（${reason}）` : '';
    toast(ok ? `会话桥接失败，已复制到剪贴板${why}` : `会话桥接失败${why}`, 'error');
  });
}

/** 发起「转到对话」：发消息给薄壳，等 ack；超时或失败就走兜底。 */
function requestChatRoute(payload) {
  const sent = bridge.toChat(payload, 'draft');
  if (!sent) {
    toast('「转到对话」需在 DSH 窗口内使用', 'error');
    return false;
  }
  if (pendingChat) clearTimeout(pendingChat.timer);
  pendingChat = {
    payload,
    timer: setTimeout(() => {
      const current = pendingChat;
      pendingChat = null;
      if (current) fallbackChatRoute(current.payload, 'timeout');
    }, 2500),
  };
  return true;
}

function handleChatAck(data) {
  const pending = pendingChat;
  if (!pending) return; // 已经超时兜底过，或不是本次请求的回执
  clearTimeout(pending.timer);
  pendingChat = null;
  if (data?.ok) {
    toast(data.mode === 'send' ? '已发送到对话' : '已填入对话输入框');
    return;
  }
  // 不管是「没找到会话」还是「桥接失败」，都先试兼容写入：
  // 只要 DSH 窗口里有可见的输入框，就说明有会话，直接写进去最可靠。
  fallbackChatRoute(pending.payload, data?.reason, data?.detail);
}

// ---------- 错误条 / toast / busy ----------

function showError(message, { retry } = {}) {
  if (!els.errorbar) return;
  els.errorText.textContent = message;
  els.errorbar.hidden = false;
  errorRetry = typeof retry === 'function' ? retry : null;
  els.errorRetry.hidden = !errorRetry;
}

function hideError() {
  if (els.errorbar) els.errorbar.hidden = true;
  errorRetry = null;
}

function toast(message, kind = 'info') {
  if (!els.toast) return;
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.toggle('error', kind === 'error');
  els.toast.hidden = false;
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 3600);
}

function setBusy(flag, text) {
  if (!els.busy) return;
  els.busy.hidden = !flag;
  if (text) els.busyText.textContent = text;
}

async function probeHealth() {
  const health = await state.api.health();
  if (!health) {
    showError('插件服务未响应（/api/health 不可达）。请确认文献阅读坞插件已安装并重启 DSH。', {
      retry: () => location.reload(),
    });
    return;
  }
  if (health.ok && (health.python === false || health.fitz == null)) {
    showError('PDF 抽取不可用：找不到 python3 或 PyMuPDF（import fitz 失败）。安装：python3 -m pip install PyMuPDF', {
      retry: () => location.reload(),
    });
  }
}

// ---------- 启动 ----------

main().catch((err) => {
  reportClientError('启动失败', err && err.message ? err.message : String(err));
  console.error('[paper-reader] 启动失败', err);
  if (els.errorbar) {
    showError(`阅读器启动失败：${err?.message || err}`, { retry: () => location.reload() });
  }
});
