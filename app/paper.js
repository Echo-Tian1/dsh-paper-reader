/**
 * paper.js — 论文渲染：页卡（1.5x PNG + 透明文字层）、选区→段落、已解释标记、跳页/闪高亮。
 *
 * 渲染方案（与 CONTRACT.md §2 对齐）：
 *   - 每页 .page 固定 width:pageW; height:pageH（PDF 点），整体 transform: scale(显示宽/pageW)，
 *     transform-origin: top left；<img> 与文字层都在 .page 内。
 *   - 文字层 span 的 left/top/width/height 直接写 PDF 点坐标，随容器一起缩放，不做逐词换算。
 *   - span: color:transparent; white-space:pre; font-size:(y1-y0)*0.92px; line-height:1；
 *     非 CJK 词后补一个空格（段尾除外），保证原生选区/复制文本可读。
 *
 * 本文件导出的 locateRange / alignWordOffsets / markBoxes 是纯函数，可在 Node 里单测。
 */

// ---------- 纯函数 ----------

const CJK_RE = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af\uf900-\ufaff]/;

export function isCJKText(text) {
  return CJK_RE.test(String(text || ''));
}

/**
 * 文字层每个 span 的文本内容。
 * 规则（与 CONTRACT §2 对齐）：
 *   - 非 CJK 词一律在词尾补一个空格（跨行/跨列/段尾都补，复制时多一个空格无害，
 *     但能避免跨段复制出 "noam@google.comNiki" 这种粘连）；
 *   - 例外一：词以连字符结尾（`-\n` 断行）不补，保证拼回 "transformer"；
 *   - 例外二：下一个词是 CJK 时不补（CJK 不用空格分隔）。
 * 纯函数，便于单测。
 */
export function wordTextFor(words, index) {
  const word = words?.[index];
  if (!Array.isArray(word)) return '';
  const rawText = String(word[4] ?? '');
  if (!rawText) return '';
  if (isCJKText(rawText)) return rawText;
  const nextText = Array.isArray(words?.[index + 1]) ? String(words[index + 1][4] ?? '') : '';
  const endsHyphen = /-$/.test(rawText);
  const nextCJK = !!nextText && isCJKText(nextText);
  return rawText + (endsHyphen || nextCJK ? '' : ' ');
}

export function normalizeSelectedText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 选区工具条状态机：决定「解释 / 译本段 / 复制 / 取消」是否可用。 */
export function selectionActionState(info) {
  const hasText = !!(info && info.text);
  const hasPara = !!(info && info.paraId);
  return {
    explain: hasText,
    translate: hasText && hasPara,
    copy: hasText,
    cancel: true,
  };
}

/** 在段落原文里定位选句的字符区间 [start,end)；找不到返回 null。 */
export function locateRange(paraText, sentRanges, selText) {
  const text = String(paraText || '');
  const raw = String(selText || '');
  if (!text || !raw.trim()) return null;
  let start = -1;
  let end = -1;

  // 1) 原文精确出现
  const exact = text.indexOf(raw);
  if (raw.trim() && exact >= 0) {
    start = exact;
    end = exact + raw.length;
  }

  // 2) 折叠空白后搜索，并用字符映射回原文位置
  if (start < 0) {
    let collapsed = '';
    const map = [];
    let lastSpace = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (/\s/.test(ch)) {
        if (!lastSpace) {
          collapsed += ' ';
          map.push(i);
          lastSpace = true;
        }
      } else {
        collapsed += ch;
        map.push(i);
        lastSpace = false;
      }
    }
    const target = normalizeSelectedText(raw);
    const at = collapsed.indexOf(target);
    if (at >= 0 && target) {
      start = map[at];
      end = map[at + target.length - 1] + 1;
    }
  }

  // 3) 退化为按句区间匹配（选句可能跨句 / 边界有空格差异）
  if (start < 0) {
    const target = normalizeSelectedText(raw);
    for (const sent of sentRanges || []) {
      if (!Array.isArray(sent)) continue;
      const seg = normalizeSelectedText(text.slice(sent[0], sent[1]));
      if (!seg) continue;
      if (seg === target || seg.includes(target) || target.includes(seg)) {
        start = sent[0];
        end = sent[1];
        break;
      }
    }
  }

  if (start < 0 || end <= start) return null;

  // 4) 吸附到完整句区间：契约按“paraId + sent 区间”标记
  if (Array.isArray(sentRanges) && sentRanges.length) {
    const hit = sentRanges.filter(([a, b]) => a < end && b > start);
    if (hit.length) {
      start = Math.min(start, hit[0][0]);
      end = Math.max(end, hit[hit.length - 1][1]);
    }
  }
  return [start, end];
}

/**
 * 把页内词序列对齐到段落原文的字符区间。
 * 返回与 words 等长的数组，元素为 [charStart, charEnd) 或 null（对不上）。
 */
export function alignWordOffsets(paraText, words) {
  const text = String(paraText || '');
  const out = [];
  let pos = 0;
  for (const word of words || []) {
    const raw = String(word?.[4] ?? '');
    const needle = raw.replace(/\s+/g, '');
    if (!needle) {
      out.push(null);
      continue;
    }
    while (pos < text.length && /\s/.test(text[pos])) pos++;
    if (text.startsWith(needle, pos)) {
      out.push([pos, pos + needle.length]);
      pos += needle.length;
      continue;
    }
    const found = text.indexOf(needle, pos);
    if (found >= 0 && found - pos <= 80) {
      out.push([found, found + needle.length]);
      pos = found + needle.length;
      continue;
    }
    out.push(null);
  }
  return out;
}

function bboxBox(bbox) {
  const [x0, y0, x1, y1] = bbox || [];
  if (![x0, y0, x1, y1].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
  return { left: x0, top: y0, width: Math.max(1, x1 - x0), height: Math.max(1, y1 - y0) };
}

/** 计算选句在页上的高亮矩形（PDF 点坐标，按行分组）；定位失败时退回整段 bbox。
 *  forcedRange: 契约 ?index=1 里可选的 `sent:[start,end]`，有则优先用（比 selText 搜索精确）。
 */
export function markBoxes(para, words, selText, forcedRange) {
  const forced =
    Array.isArray(forcedRange) && forcedRange.length === 2 && forcedRange[0] < forcedRange[1]
      ? [Number(forcedRange[0]), Number(forcedRange[1])]
      : null;
  const range = forced || locateRange(para?.text, para?.sent, selText);
  const list = Array.isArray(words) ? words : [];
  if (!range) return para?.bbox ? [bboxBox(para.bbox)].filter(Boolean) : [];

  const aligned = alignWordOffsets(para.text, list);
  const groups = [];
  let last = null;
  let hitCount = 0;
  for (let i = 0; i < list.length; i++) {
    const a = aligned[i];
    const word = list[i];
    const x0 = word?.[0];
    const y0 = word?.[1];
    const x1 = word?.[2];
    const y1 = word?.[3];
    if (!a || !(a[0] < range[1] && a[1] > range[0])) {
      last = null;
      continue;
    }
    if (![x0, y0, x1, y1].every((n) => typeof n === 'number' && Number.isFinite(n))) {
      last = null;
      continue;
    }
    const height = Math.max(1, y1 - y0);
    const sameLine = last && Math.abs(y0 - last.y0) <= Math.max(2, height * 0.4) && x0 >= last.x1 - 1.5;
    if (sameLine) {
      const g = groups[groups.length - 1];
      g.left = Math.min(g.left, x0);
      g.top = Math.min(g.top, y0);
      g.width = Math.max(g.left + g.width, x1) - g.left;
      g.height = Math.max(g.top + g.height, y1) - g.top;
    } else {
      groups.push({ left: x0, top: y0, width: Math.max(1, x1 - x0), height });
    }
    last = { y0, x1 };
    hitCount += 1;
  }

  if (!groups.length && para?.bbox) {
    const box = bboxBox(para.bbox);
    return box ? [box] : [];
  }
  return groups;
}

// ---------- v2 纯函数：框选坐标 / 缩略图裁剪 ----------

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

/**
 * 屏幕坐标 → PDF 点坐标。
 * .page 是固定 pageW×pageH 再 transform: scale(s) 的容器，所以用 getBoundingClientRect()
 * 拿屏幕矩形反算：pdfX = (clientX - rect.left) * pageW / rect.width。
 * 滚动只影响 rect，因此公式天然含滚动偏移；窗口缩放改变 rect 也同样成立。
 * 纯函数（pageEl 只需要提供 getBoundingClientRect），可在 Node 里用桩对象单测。
 */
export function clientToPdf(pageEl, clientX, clientY, pageW, pageH) {
  const w = Number(pageW) || 612;
  const h = Number(pageH) || 792;
  const rect = pageEl && typeof pageEl.getBoundingClientRect === 'function' ? pageEl.getBoundingClientRect() : null;
  if (!rect || !rect.width || !rect.height) return { x: 0, y: 0 };
  const x = ((Number(clientX) - rect.left) * w) / rect.width;
  const y = ((Number(clientY) - rect.top) * h) / rect.height;
  return { x: clamp(x, 0, w), y: clamp(y, 0, h) };
}

/** 把 rect 归一化成左上→右下、保留 1 位小数的 [x0,y0,x1,y1]；非法返回 null。 */
export function normalizeRegionRect(rect) {
  if (!Array.isArray(rect) || rect.length !== 4) return null;
  const nums = rect.map(Number);
  if (!nums.every((n) => Number.isFinite(n))) return null;
  const x0 = Math.min(nums[0], nums[2]);
  const y0 = Math.min(nums[1], nums[3]);
  const x1 = Math.max(nums[0], nums[2]);
  const y1 = Math.max(nums[1], nums[3]);
  return [round1(x0), round1(y0), round1(x1), round1(y1)];
}

/**
 * 两点 → 归一化区域 + 是否太小（宽或高 < minSize PDF 点）。
 * 太小直接取消，避免误框烧 token。
 */
export function rectFromPoints(start, end, options = {}) {
  const minSize = Number.isFinite(options.minSize) ? options.minSize : 8;
  const rect = normalizeRegionRect([start?.x, start?.y, end?.x, end?.y]);
  if (!rect) return { rect: [0, 0, 0, 0], tooSmall: true };
  const tooSmall = rect[2] - rect[0] < minSize || rect[3] - rect[1] < minSize;
  return { rect, tooSmall };
}

/** 从 1.5x 页图里裁剪 rect 区域时，页图自然像素上的 source 矩形。 */
export function thumbnailCrop(rect, pageW, pageH, naturalW, naturalH) {
  const r = normalizeRegionRect(rect);
  if (!r || !(pageW > 0) || !(pageH > 0) || !(naturalW > 0) || !(naturalH > 0)) return null;
  const kx = naturalW / pageW;
  const ky = naturalH / pageH;
  return {
    sx: r[0] * kx,
    sy: r[1] * ky,
    sw: Math.max(1, (r[2] - r[0]) * kx),
    sh: Math.max(1, (r[3] - r[1]) * ky),
  };
}

/** 「宽×高 pt」的人类可读尺寸。 */
export function regionSizeLabel(rect) {
  const r = normalizeRegionRect(rect);
  if (!r) return '';
  return `${Math.round(r[2] - r[0])}×${Math.round(r[3] - r[1])} pt`;
}

// ---------- 模块状态 ----------

let deps = {
  api: null,
  onSelectionChange: null,
  onExplainSelection: null,
  onOpenEntry: null,
  onPageChange: null,
  onRegionChange: null,
  toast: null,
};

let scrollEl = null;
let contentEl = null;
let docId = null;
let structure = null;
let paraById = new Map();
let sectionById = new Map();
let pages = [];
let explanations = [];
let scaleTargetWidth = 0;
let resizeObserver = null;
let intersectionObserver = null;
let selectListenerAdded = false;
let scrollRaf = 0;
let lastPage = 0;
let pendingFlash = null;
let pendingTerm = null;
let region = null; // { page, pageEntry, rect, client }
let regionDrag = null; // { pageEntry, start, lastRect, tooSmall }

const scaleQueued = { value: false };

// ---------- 初始化 ----------

export function init(options = {}) {
  deps = { ...deps, ...options };
  scrollEl = options.scrollEl;
  contentEl = options.contentEl || options.scrollEl;
  if (contentEl) {
    contentEl.addEventListener('dblclick', onDoubleClick);
  }
  if (scrollEl) {
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    scrollEl.addEventListener('pointerdown', onPointerDown);
  }
  if (!selectListenerAdded && typeof document !== 'undefined') {
    document.addEventListener('mouseup', onDocumentMouseUp);
    selectListenerAdded = true;
  }
  if (typeof ResizeObserver !== 'undefined' && scrollEl) {
    resizeObserver = new ResizeObserver(() => scheduleScale());
    resizeObserver.observe(scrollEl);
  }
  window.addEventListener('resize', scheduleScale);
}

/** 加载/切换文档。restore: {lastPage, scrollTop} */
export async function load({ docId: id, structure: data, restore } = {}) {
  destroyObservers();
  docId = id;
  structure = data || { pages: [], paras: [], sections: [] };
  paraById = new Map((structure.paras || []).map((p) => [p.id, p]));
  sectionById = new Map((structure.sections || []).map((s) => [s.id, s]));
  explanations = [];
  pages = [];
  pendingFlash = null;
  pendingTerm = null;
  if (regionDrag) endRegionDrag();
  region = null;
  lastPage = 0;
  contentEl.innerHTML = '';

  const fragment = document.createDocumentFragment();
  for (const pageMeta of structure.pages || []) {
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    wrap.dataset.page = String(pageMeta.n);

    const page = document.createElement('div');
    page.className = 'page';
    page.style.width = `${pageMeta.w}px`;
    page.style.height = `${pageMeta.h}px`;

    const img = document.createElement('img');
    img.className = 'page-img';
    img.alt = `第 ${pageMeta.n} 页`;
    img.decoding = 'async';
    img.loading = 'lazy';
    img.draggable = false;
    img.src = deps.api ? deps.api.pageImageUrl(docId, pageMeta.n) : '';
    img.addEventListener('error', () => setNote(entry, `第 ${pageMeta.n} 页图片加载失败`));

    const textLayer = document.createElement('div');
    textLayer.className = 'text-layer';

    const marksLayer = document.createElement('div');
    marksLayer.className = 'marks-layer';

    page.append(img, textLayer, marksLayer);

    const entry = {
      n: pageMeta.n,
      w: pageMeta.w,
      h: pageMeta.h,
      hasText: pageMeta.hasText !== false,
      wrap,
      page,
      img,
      textLayer,
      marksLayer,
      note: null,
      data: null,
      loadState: 'idle',
    };

    if (!entry.hasText) setNote(entry, '本页没有文字层，无法选中');

    wrap.appendChild(page);
    fragment.appendChild(wrap);
    pages.push(entry);
  }
  contentEl.appendChild(fragment);

  scheduleScale();
  applyScaleNow();

  observePages();

  // 恢复位置：优先 scrollTop，其次 lastPage
  const restored = restore || {};
  if (restored.scrollTop > 0) {
    scrollEl.scrollTop = restored.scrollTop;
  } else if (restored.lastPage && restored.lastPage > 1) {
    scrollToPage(restored.lastPage);
  }
  updateCurrentPage(true);
  return { pageCount: pages.length };
}

/** 设置已解释索引（用于原文标记）。index 可以是 {index:[...]} 或数组。 */
export function setExplanations(indexOrPayload) {
  const list = Array.isArray(indexOrPayload) ? indexOrPayload : indexOrPayload?.index;
  explanations = Array.isArray(list) ? list : [];
  for (const page of pages) renderMarks(page);
}

/** 新解释落盘后增量更新标记。 */
export function addExplanation(entry) {
  if (!entry) return;
  const idx = explanations.findIndex((e) => e.id === entry.id);
  if (idx >= 0) explanations[idx] = { ...explanations[idx], ...entry };
  else explanations.push(entry);
  const para = paraById.get(entry.paraId);
  const page = pages.find((p) => p.n === (entry.page || para?.page));
  if (page) renderMarks(page);
}

export function destroy() {
  destroyObservers();
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  if (selectListenerAdded && typeof document !== 'undefined') {
    document.removeEventListener('mouseup', onDocumentMouseUp);
    selectListenerAdded = false;
  }
  window.removeEventListener('resize', scheduleScale);
}

function destroyObservers() {
  if (intersectionObserver) {
    intersectionObserver.disconnect();
    intersectionObserver = null;
  }
}

// ---------- 页卡 / 缩放 ----------

function setNote(page, text, onRetry) {
  if (page.note) page.note.remove();
  page.note = document.createElement('div');
  page.note.className = 'page-note';
  page.note.textContent = text;
  if (onRetry) {
    page.note.style.pointerEvents = 'auto';
    page.note.style.cursor = 'pointer';
    page.note.addEventListener('click', () => {
      if (page.note) page.note.remove();
      page.note = null;
      onRetry();
    });
  }
  page.wrap.appendChild(page.note);
}

function measureTargetWidth() {
  if (!scrollEl) return 0;
  const cs = getComputedStyle(contentEl);
  const padding = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const available = Math.max(240, scrollEl.clientWidth - padding);
  return Math.min(available, 980);
}

function scheduleScale() {
  if (scaleQueued.value) return;
  scaleQueued.value = true;
  requestAnimationFrame(() => {
    scaleQueued.value = false;
    applyScaleNow();
  });
}

function applyScaleNow() {
  if (!scrollEl || !contentEl || !structure) return;
  scaleTargetWidth = measureTargetWidth();
  for (const page of pages) {
    const s = scaleTargetWidth / (page.w || 612);
    page.page.style.transform = `scale(${s})`;
    page.wrap.style.width = `${Math.round(scaleTargetWidth)}px`;
    page.wrap.style.height = `${Math.round((page.h || 792) * s)}px`;
  }
  updateCurrentPage(true);
}

function observePages() {
  if (typeof IntersectionObserver === 'undefined') {
    // 退化为全部加载
    for (const page of pages) loadPage(page);
    return;
  }
  intersectionObserver = new IntersectionObserver(
    (entries) => {
      for (const ioEntry of entries) {
        if (!ioEntry.isIntersecting) continue;
        const page = pages.find((p) => p.wrap === ioEntry.target);
        if (page) loadPage(page);
      }
    },
    { root: scrollEl, rootMargin: '1200px 0px', threshold: 0 }
  );
  for (const page of pages) intersectionObserver.observe(page.wrap);
}

async function loadPage(page) {
  if (!page || page.loadState === 'loading' || page.loadState === 'loaded') return;
  if (!page.hasText) {
    page.loadState = 'loaded';
    return;
  }
  page.loadState = 'loading';
  try {
    const data = await deps.api.getPage(docId, page.n);
    page.data = data || { n: page.n, words: [] };
    buildTextLayer(page);
    renderMarks(page);
    page.loadState = 'loaded';
    if (pendingFlash) {
      const para = paraById.get(pendingFlash);
      if (para && para.page === page.n) {
        const paraId = pendingFlash;
        pendingFlash = null;
        flashPara(paraId);
      }
    }
  } catch (err) {
    page.loadState = 'idle';
    setNote(page, `第 ${page.n} 页文字层加载失败（点击重试）`, () => loadPage(page));
  }
}

function buildTextLayer(page) {
  page.textLayer.innerHTML = '';
  const words = page.data?.words || [];
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!Array.isArray(word) || word.length < 6) continue;
    const [x0, y0, x1, y1, text, paraId] = word;
    if (![x0, y0, x1, y1].every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    const content = wordTextFor(words, i);
    if (!content) continue;
    const span = document.createElement('span');
    span.textContent = content;
    span.style.left = `${x0}px`;
    span.style.top = `${y0}px`;
    span.style.width = `${Math.max(0.5, x1 - x0)}px`;
    span.style.height = `${Math.max(0.5, y1 - y0)}px`;
    span.style.fontSize = `${Math.max(1, (y1 - y0) * 0.92)}px`;
    span.dataset.para = paraId || '';
    span.dataset.page = String(page.n);
    span.dataset.wi = String(i);
    fragment.appendChild(span);
  }
  page.textLayer.appendChild(fragment);
}

// ---------- 标记 ----------

function wordsForPara(page, paraId) {
  const words = page.data?.words || [];
  return words.filter((w) => w && w[5] === paraId);
}

function renderMarks(page) {
  if (!page.marksLayer) return;
  page.marksLayer.innerHTML = '';
  if (!explanations.length) return;
  for (const entry of explanations) {
    if (!entry) continue;
    const kind = entry.kind || 'explain';
    // 整段翻译不画原文标记（否则会把整段都染色）
    if (kind === 'translate') continue;

    // 框选区域：按 entry.rect 画淡色矩形框，不依赖文字层
    if (kind === 'region') {
      const rect = normalizeRegionRect(entry.rect);
      if (!rect || Number(entry.page) !== page.n) continue;
      const width = rect[2] - rect[0];
      const height = rect[3] - rect[1];
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.className = 'region-mark';
      mark.style.left = `${rect[0]}px`;
      mark.style.top = `${rect[1]}px`;
      mark.style.width = `${width}px`;
      mark.style.height = `${height}px`;
      mark.title = `点击回看框选区域解释（第 ${entry.page} 页 · ${Math.round(width)}×${Math.round(height)} pt）`;
      mark.dataset.entryId = entry.id;
      mark.addEventListener('click', (ev) => {
        ev.stopPropagation();
        deps.onOpenEntry?.(entry);
      });
      page.marksLayer.appendChild(mark);
      continue;
    }

    if (!entry.paraId || !page.data) continue;
    const para = paraById.get(entry.paraId);
    if (!para) continue;
    if ((para.page || entry.page) !== page.n) continue;
    const boxes = markBoxes(para, wordsForPara(page, entry.paraId), entry.selText, entry.sent);
    for (const box of boxes) {
      const mark = document.createElement('button');
      mark.type = 'button';
      mark.className = 'mark';
      if (box.width > (para.bbox ? Math.abs(para.bbox[2] - para.bbox[0]) * 0.9 : 1e9)) mark.classList.add('mark-wide');
      mark.style.left = `${box.left}px`;
      mark.style.top = `${box.top}px`;
      mark.style.width = `${box.width}px`;
      mark.style.height = `${box.height}px`;
      mark.title = `点击查看解释：${String(entry.selText || '').slice(0, 80)}`;
      mark.dataset.entryId = entry.id;
      mark.addEventListener('click', (ev) => {
        ev.stopPropagation();
        deps.onOpenEntry?.(entry);
      });
      page.marksLayer.appendChild(mark);
    }
  }
}

// ---------- Shift + 拖动框选区域 ----------

function pageEntryFromElement(el) {
  const pageEl = el?.closest?.('.page');
  if (!pageEl) return null;
  return pages.find((p) => p.page === pageEl) || null;
}

function regionLayerFor(pageEntry) {
  let layer = pageEntry.page.querySelector('.region-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'region-layer';
    pageEntry.page.appendChild(layer);
  }
  return layer;
}

function drawRegionBox(pageEntry, rect, { tooSmall = false, active = false } = {}) {
  const layer = regionLayerFor(pageEntry);
  let box = layer.querySelector('.region-box');
  if (!box) {
    box = document.createElement('div');
    box.className = 'region-box';
    layer.appendChild(box);
  }
  box.style.left = `${rect[0]}px`;
  box.style.top = `${rect[1]}px`;
  box.style.width = `${Math.max(1, rect[2] - rect[0])}px`;
  box.style.height = `${Math.max(1, rect[3] - rect[1])}px`;
  box.classList.toggle('too-small', !!tooSmall);
  box.classList.toggle('active', !!active);
  return box;
}

function removeRegionLayer(pageEntry) {
  const layer = pageEntry?.page?.querySelector('.region-layer');
  if (layer) layer.remove();
}

function onPointerDown(event) {
  // 只有 Shift + 左键才进入框选；普通拖动留给原生文字选择
  if (!event.shiftKey || event.button !== 0) return;
  const pageEntry = pageEntryFromElement(event.target);
  if (!pageEntry) return;
  event.preventDefault();
  clearSelection();
  if (region?.pageEntry) removeRegionLayer(region.pageEntry);
  region = null;
  deps.onRegionChange?.(null);
  const start = clientToPdf(pageEntry.page, event.clientX, event.clientY, pageEntry.w, pageEntry.h);
  regionDrag = { pageEntry, start, rect: [start.x, start.y, start.x, start.y], tooSmall: true };
  drawRegionBox(pageEntry, regionDrag.rect, { tooSmall: true });
  document.body.classList.add('region-dragging');
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', onPointerUp, true);
  window.addEventListener('pointercancel', onPointerCancel, true);
}

function onPointerMove(event) {
  if (!regionDrag) return;
  event.preventDefault();
  const { pageEntry, start } = regionDrag;
  const current = clientToPdf(pageEntry.page, event.clientX, event.clientY, pageEntry.w, pageEntry.h);
  const result = rectFromPoints(start, current);
  regionDrag.rect = result.rect;
  regionDrag.tooSmall = result.tooSmall;
  drawRegionBox(pageEntry, result.rect, { tooSmall: result.tooSmall });
}

function onPointerUp(event) {
  if (!regionDrag) return;
  const { pageEntry, rect, tooSmall } = regionDrag;
  const client = { x: event.clientX, y: event.clientY };
  endRegionDrag();
  if (tooSmall) {
    removeRegionLayer(pageEntry);
    region = null;
    deps.onRegionChange?.(null);
    return;
  }
  drawRegionBox(pageEntry, rect, { active: true });
  region = { page: pageEntry.n, pageEntry, rect, client };
  deps.onRegionChange?.(region);
}

function onPointerCancel() {
  if (!regionDrag) return;
  const pageEntry = regionDrag.pageEntry;
  endRegionDrag();
  removeRegionLayer(pageEntry);
  region = null;
  deps.onRegionChange?.(null);
}

function endRegionDrag() {
  regionDrag = null;
  if (typeof document !== 'undefined') document.body.classList.remove('region-dragging');
  window.removeEventListener('pointermove', onPointerMove, true);
  window.removeEventListener('pointerup', onPointerUp, true);
  window.removeEventListener('pointercancel', onPointerCancel, true);
}

/** 取消当前框选（移除橡皮筋）。 */
export function clearRegion() {
  if (regionDrag) {
    const pageEntry = regionDrag.pageEntry;
    endRegionDrag();
    removeRegionLayer(pageEntry);
  }
  if (region?.pageEntry) removeRegionLayer(region.pageEntry);
  const had = !!region;
  region = null;
  if (had) deps.onRegionChange?.(null);
}

export function getRegion() {
  return region ? { page: region.page, rect: [...region.rect], client: { ...region.client } } : null;
}

/** 画一个临时矩形并闪一下（历史回跳用）。 */
export function flashRegion(pageN, rect) {
  const pageEntry = pages.find((p) => p.n === Number(pageN));
  const r = normalizeRegionRect(rect);
  if (!pageEntry || !r) return false;
  const box = drawRegionBox(pageEntry, r, { active: true });
  box.classList.remove('pr-region-flash');
  void box.offsetWidth;
  box.classList.add('pr-region-flash');
  setTimeout(() => {
    box.remove();
    const layer = pageEntry.page.querySelector('.region-layer');
    if (layer && !layer.querySelector('.region-box')) layer.remove();
  }, 1500);
  return true;
}

/** 从页图裁剪框选区域生成 dataURL 缩略图（不上传图片）。 */
export function regionThumbnail(pageN, rect) {
  const pageEntry = pages.find((p) => p.n === Number(pageN));
  const pageMeta = structure?.pages?.find((p) => p.n === Number(pageN));
  const r = normalizeRegionRect(rect);
  if (!pageEntry || !pageMeta || !r) return '';
  const img = pageEntry.img;
  if (!img || !img.naturalWidth || !img.naturalHeight) return '';
  const crop = thumbnailCrop(r, pageMeta.w, pageMeta.h, img.naturalWidth, img.naturalHeight);
  if (!crop) return '';
  const maxWidth = 640;
  const scale = Math.min(1, maxWidth / crop.sw);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(crop.sw * scale));
  canvas.height = Math.max(1, Math.round(crop.sh * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, canvas.width, canvas.height);
  try {
    return canvas.toDataURL('image/png');
  } catch (err) {
    return '';
  }
}

/** 等页图加载完（历史回看其它页的区域缩略图时用）。 */
export function ensurePageImage(pageN) {
  const pageEntry = pages.find((p) => p.n === Number(pageN));
  if (!pageEntry?.img) return Promise.resolve(false);
  if (pageEntry.img.complete && pageEntry.img.naturalWidth) return Promise.resolve(true);
  return new Promise((resolve) => {
    pageEntry.img.addEventListener('load', () => resolve(true), { once: true });
    pageEntry.img.addEventListener('error', () => resolve(false), { once: true });
  });
}

// ---------- 选区 → 段落 ----------

function spanFromNode(node) {
  if (!node) return null;
  const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  if (!el) return null;
  return el.closest('span[data-para]');
}

function firstSpanIn(node) {
  if (!node) return null;
  if (node.nodeType === Node.ELEMENT_NODE) {
    if (node.matches?.('span[data-para]')) return node;
    return node.querySelector?.('span[data-para]') || null;
  }
  return spanFromNode(node);
}

function endpointSpan(container, offset, isStart) {
  const direct = spanFromNode(container);
  if (direct) return direct;
  if (container.nodeType === Node.ELEMENT_NODE) {
    const children = container.childNodes;
    if (isStart) {
      for (let i = offset; i < children.length; i++) {
        const span = firstSpanIn(children[i]);
        if (span) return span;
      }
      return null;
    }
    for (let i = Math.min(offset - 1, children.length - 1); i >= 0; i--) {
      const span = children[i].nodeType === Node.ELEMENT_NODE ? children[i].querySelectorAll?.('span[data-para]') : null;
      if (span && span.length) return span[span.length - 1];
      const found = firstSpanIn(children[i]);
      if (found) return found;
    }
    return null;
  }
  return spanFromNode(container);
}

/** 读取当前原生选区，映射为 {page, paraId, text, rect, startSpan, endSpan}。 */
export function readSelection(selection) {
  const sel = selection || (typeof window !== 'undefined' ? window.getSelection() : null);
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  if (contentEl && !contentEl.contains(range.commonAncestorContainer)) return null;
  const text = normalizeSelectedText(sel.toString());
  if (!text) return null;

  const startSpan = endpointSpan(range.startContainer, range.startOffset, true) || spanFromNode(range.startContainer);
  const endSpan = endpointSpan(range.endContainer, range.endOffset, false) || spanFromNode(range.endContainer);
  const first = startSpan || endSpan;
  if (!first) return null;

  const rect = range.getBoundingClientRect();
  const para = paraById.get(first.dataset.para || '') || null;
  return {
    page: Number(first.dataset.page) || para?.page || 1,
    paraId: first.dataset.para || '',
    text,
    rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
    // 跨段选择时以起点段为上下文（契约/设计如此）
    startParaId: first.dataset.para || '',
    endParaId: (endSpan || first).dataset.para || '',
    crossPara: !!(endSpan && endSpan.dataset.para !== first.dataset.para),
    startSpan: first,
    endSpan: endSpan || first,
  };
}

function onDocumentMouseUp(event) {
  if (!contentEl) return;
  const target = event.target;
  if (target instanceof Element && target.closest('#selection-toolbar')) return;
  // 等浏览器把选区定下来
  setTimeout(() => {
    const info = readSelection();
    deps.onSelectionChange?.(info);
  }, 0);
}

function onDoubleClick(event) {
  if (!contentEl || !contentEl.contains(event.target)) return;
  setTimeout(() => {
    const info = readSelection();
    if (!info) return;
    deps.onSelectionChange?.(null); // 先收工具条，直接解释
    const expanded = expandToSentence(info);
    deps.onExplainSelection?.(expanded);
  }, 0);
}

/** 双击词 → 扩成所在句（用于“双击句子 = 直接解释”）。 */
export function expandToSentence(info) {
  const para = paraById.get(info.paraId);
  if (!para) return info;
  const sentences = Array.isArray(para.sent) ? para.sent : [];
  // 估计选中词在段落中的位置：用同段 span 序号比例
  const paraSpans = contentEl.querySelectorAll(`span[data-para="${cssEscape(info.paraId)}"]`);
  let spanIndex = 0;
  for (let i = 0; i < paraSpans.length; i++) {
    if (paraSpans[i] === info.startSpan) {
      spanIndex = i;
      break;
    }
  }
  const approx = paraSpans.length ? Math.round((spanIndex / paraSpans.length) * (para.text?.length || 0)) : 0;
  const wanted = normalizeSelectedText(info.text);
  let best = null;
  if (wanted) {
    let from = 0;
    while (from <= para.text.length) {
      const at = para.text.indexOf(info.text, from);
      if (at < 0) break;
      if (!best || Math.abs(at - approx) < Math.abs(best - approx)) best = at;
      from = at + 1;
    }
    if (best == null) {
      // 忽略首尾空白再试一次
      const trimmed = String(info.text).trim();
      const at = para.text.indexOf(trimmed);
      if (at >= 0) best = at;
    }
  }
  if (best == null) {
    // 文本对不上时，按估计位置找所在句
    const near = sentences.filter(([a, b]) => a <= approx && approx < b);
    if (!near.length) return info;
    const [a, b] = near[0];
    const sentence = String(para.text.slice(a, b)).trim();
    return sentence ? { ...info, text: sentence, sentenceRange: [a, b] } : info;
  }
  const hits = sentences.filter(([a, b]) => a <= best && best < b);
  if (!hits.length) return info;
  const [a, b] = hits[0];
  const sentence = String(para.text.slice(a, b)).trim();
  if (!sentence) return info;
  // 若选区本来就跨句，保留原选句
  if (sentence.length < info.text.length) return info;
  return { ...info, text: sentence, sentenceRange: [a, b] };
}

function cssEscape(value) {
  const text = String(value || '');
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(text);
  return text.replace(/["\\]/g, '\\$&');
}

/** 清空当前选区。 */
export function clearSelection() {
  const sel = typeof window !== 'undefined' ? window.getSelection() : null;
  if (sel) sel.removeAllRanges();
}

// ---------- 跳页 / 闪高亮 ----------

export function scrollToPage(n) {
  const page = pages.find((p) => p.n === Number(n));
  if (!page || !scrollEl) return false;
  const top =
    page.wrap.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop - 12;
  scrollEl.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  return true;
}

export function flashPara(paraId) {
  if (!contentEl) return;
  const spans = contentEl.querySelectorAll(`span[data-para="${cssEscape(paraId)}"]`);
  if (!spans.length) {
    const para = paraById.get(paraId);
    const page = pages.find((p) => p.n === para?.page);
    if (page && page.loadState !== 'loaded') {
      pendingFlash = paraId;
      loadPage(page);
    }
    return;
  }
  for (const span of spans) {
    span.classList.remove('pr-flash');
    // 强制重排，保证连续两次跳转都能看到动画
    void span.offsetWidth;
    span.classList.add('pr-flash');
    setTimeout(() => span.classList.remove('pr-flash'), 1400);
  }
}

/** 在原文中查找术语首次出现：跳页 + 词级闪高亮（找不到词则闪整段）。 */
export function jumpToTerm(term) {
  const needle = String(term || '').trim().toLowerCase();
  if (!needle) return false;
  const paras = structure?.paras || [];
  for (const para of paras) {
    const at = String(para.text || '').toLowerCase().indexOf(needle);
    if (at < 0) continue;
    scrollToPage(para.page);
    const page = pages.find((p) => p.n === para.page);
    if (page && page.loadState !== 'loaded') {
      pendingTerm = { para, start: at, end: at + needle.length };
      loadPage(page).then(() => {
        const pending = pendingTerm;
        if (pending && pending.para.id === para.id) {
          pendingTerm = null;
          flashTermRange(pending.para, pending.start, pending.end);
        }
      });
    } else {
      flashTermRange(para, at, at + needle.length);
    }
    return true;
  }
  return false;
}

function flashTermRange(para, start, end) {
  const page = pages.find((p) => p.n === para.page);
  if (!page || page.loadState !== 'loaded') {
    flashPara(para.id);
    return;
  }
  const words = wordsForPara(page, para.id);
  const aligned = alignWordOffsets(para.text, words);
  const wanted = new Set();
  for (let i = 0; i < words.length; i++) {
    const range = aligned[i];
    if (range && range[0] < end && range[1] > start) wanted.add(i);
  }
  let flashed = 0;
  for (const span of page.textLayer.querySelectorAll('span[data-wi]')) {
    if (!wanted.has(Number(span.dataset.wi))) continue;
    span.classList.remove('pr-flash');
    void span.offsetWidth;
    span.classList.add('pr-flash');
    flashed += 1;
    setTimeout(() => span.classList.remove('pr-flash'), 1400);
  }
  if (!flashed) flashPara(para.id);
}

/** 当前滚动位置（供 ui-state 持久化）。 */
export function getScrollTop() {
  return scrollEl ? scrollEl.scrollTop : 0;
}

export function getCurrentPage() {
  return lastPage || 1;
}

function updateCurrentPage(force) {
  if (!scrollEl || !pages.length) return;
  const containerRect = scrollEl.getBoundingClientRect();
  const probe = containerRect.top + Math.min(containerRect.height * 0.35, 320);
  let currentN = pages[0].n;
  for (const page of pages) {
    currentN = page.n;
    const rect = page.wrap.getBoundingClientRect();
    if (rect.bottom > probe) break;
  }
  if (force || currentN !== lastPage) {
    lastPage = currentN;
    deps.onPageChange?.(currentN);
  }
}

function onScroll() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    updateCurrentPage(false);
  });
}

// ---------- 段落上下文（解释 / 转到对话用） ----------

export function getParaContext(paraId) {
  const paras = structure?.paras || [];
  const index = paras.findIndex((p) => p.id === paraId);
  const para = index >= 0 ? paras[index] : null;
  if (!para) return { paraText: '', page: lastPage || 1, sectionTitle: '', prevPara: '', nextPara: '' };
  const section = sectionById.get(para.sectionId) || (structure.sections || []).find((s) => s.paraIds?.includes(paraId));
  const prev = index > 0 ? paras[index - 1] : null;
  const next = index >= 0 && index < paras.length - 1 ? paras[index + 1] : null;
  return {
    para,
    paraText: para.text || '',
    page: para.page || lastPage || 1,
    sectionTitle: section?.title || '',
    prevPara: prev?.text || '',
    nextPara: next?.text || '',
  };
}

export function getPageCount() {
  return pages.length;
}

export function getStructure() {
  return structure;
}
