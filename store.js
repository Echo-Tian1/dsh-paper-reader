/**
 * 文献阅读坞 · 宿主半存储层
 *
 * 职责：
 *  - 计算数据目录（$DSH_HOME/plugin-data/paper-reader），并保证所有路径都落在这个目录内；
 *  - 原子读写（tmp + rename），避免半个 JSON 文件被读到；
 *  - 文档索引 index.json、UI 状态 ui-state.json、解释历史 explanations.json；
 *  - 缓存键归一化（CONTRACT §5，宿主半唯一实现）。
 *
 * 这里只做纯文件与纯函数，不碰 HTTP、不碰模型；方便单测。
 */
import { createHash, randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 解释配方版本（v2 起输出 terms trailer）；改提示词必须同时升版本（CONTRACT §5）。 */
export const RECIPE = 'v2'
/** 整段翻译配方版本。 */
export const TRANSLATE_RECIPE = 'translate-v1'
/** 框选区域解释配方版本。 */
export const REGION_RECIPE = 'region-v1'

/** 文档 id 形如 sha256(pdf 字节).slice(0,16)，小写十六进制。 */
const DOC_ID_RE = /^[0-9a-f]{16}$/

/** 带错误码与 HTTP 状态的宿主错误，路由层可直接映射成 {ok:false,error:{code,message}}。 */
export class PaperError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'PaperError'
    this.code = code
    this.status = status
  }
}

/** 数据根目录：$DSH_HOME/plugin-data/paper-reader（默认 ~/.dsh/...）。 */
export function storeDir(env = process.env) {
  const home = env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'plugin-data', 'paper-reader')
}

export function docsDir(env = process.env) {
  return path.join(storeDir(env), 'docs')
}

/** 上传 / 抽取中间产物目录。 */
export function tmpDir(env = process.env) {
  return path.join(storeDir(env), 'tmp')
}

export function isDocId(id) {
  return typeof id === 'string' && DOC_ID_RE.test(id)
}

/** 单篇论文目录；id 非法直接抛错，杜绝 ../ 穿越。 */
export function docDir(id, env = process.env) {
  if (!isDocId(id)) throw new PaperError('bad-id', `文档 id 非法：${String(id)}`)
  return path.join(docsDir(env), id)
}

/** 契约 §1 的固定磁盘布局。 */
export function docPaths(id, env = process.env) {
  const dir = docDir(id, env)
  const pagesDir = path.join(dir, 'pages')
  return {
    dir,
    source: path.join(dir, 'source.pdf'),
    structure: path.join(dir, 'structure.json'),
    pagesDir,
    explanations: path.join(dir, 'explanations.json'),
    pageJson: n => path.join(pagesDir, `${Number(n)}.json`),
    pagePng: n => path.join(pagesDir, `${Number(n)}.png`),
    pageMirror: n => path.join(dir, `page-${Number(n)}.png`),
  }
}

export async function readJson(file, fallback = null) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    return JSON.parse(text)
  } catch {
    // 文件缺失或 JSON 损坏都退回 fallback：不能让脏文件把插件打挂
    return fallback
  }
}

/** 原子写 JSON：同目录唯一临时文件 → rename；任何一步失败都清掉临时文件。 */
export async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await fsp.rename(temp, file)
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {})
    throw error
  }
}

export function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** 对二进制取 sha256（PDF 字节 → 文档 id）。 */
export function sha256Bytes(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** sha1 十六进制（translate/region 缓存键里对长文本取摘要，契约指定）。 */
export function sha1(text) {
  return createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex')
}

/**
 * 选句归一化（CONTRACT §5）：
 *  - 行尾连字符断行还原（"transduc-\ntion" -> "transduction"）；
 *  - 弯引号统一为直单引号（双引号也统一成 '，契约如此）；
 *  - 折叠所有空白并去首尾。
 */
export function norm(text) {
  return String(text ?? '')
    .replace(/-\s*\n\s*/g, '')
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** 按句缓存键：sha256(docId + '|' + recipe + '|' + normText + '|' + paraId)。 */
export function cacheKey(docId, recipe, normText, paraId) {
  return sha256(`${docId}|${recipe}|${normText}|${paraId}`)
}

/** 整段翻译缓存键：sha256(docId|translate-v1|paraId|sha1(paraText))。 */
export function translateKey(docId, paraId, paraText) {
  return sha256(`${docId}|${TRANSLATE_RECIPE}|${paraId}|${sha1(paraText)}`)
}

/** rect 取整到 0.1pt，拼成稳定的字符串（region 缓存键的一部分）。 */
export function roundRect1(rect) {
  if (!Array.isArray(rect) || rect.length !== 4) return String(rect)
  return rect
    .map(value => {
      const number = Number(value)
      return String(Number.isFinite(number) ? Math.round(number * 10) / 10 : value)
    })
    .join(',')
}

/** 框选区域缓存键：sha256(docId|region-v1|page|rect 取整 0.1pt|sha1(regionText))。 */
export function regionKey(docId, page, rect, regionText) {
  return sha256(`${docId}|${REGION_RECIPE}|${page}|${roundRect1(rect)}|${sha1(regionText)}`)
}

/** 单个字符是否算 CJK（汉字 / 中文标点 / 全角）。 */
export function isCjkChar(char) {
  if (!char) return false
  const code = char.codePointAt(0)
  return (
    (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x3000 && code <= 0x303f)
    || (code >= 0xff00 && code <= 0xffef)
    || (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0xac00 && code <= 0xd7af)
  )
}

/** CJK 字符占比（忽略空白；无内容返回 0）。翻译目标语言判定用。 */
export function cjkRatio(text) {
  const value = String(text ?? '')
  let cjk = 0
  let other = 0
  for (const char of value) {
    if (/\s/.test(char)) continue
    if (isCjkChar(char)) cjk += 1
    else other += 1
  }
  const total = cjk + other
  return total === 0 ? 0 : cjk / total
}

/** 目标语言：CJK 占比 < 0.5 → 译成中文（zh）；≥ 0.5 → 译成英文（en）。 */
export function targetLanguage(text) {
  return cjkRatio(text) < 0.5 ? 'zh' : 'en'
}

/** 上下文哈希：配方 + system + user 文本，用于历史里判断上下文是否变过。 */
export function hashContext(recipe, system, userText) {
  return sha256(`${recipe}\n${system}\n${userText}`)
}

/** 同 key 取 createdAt 最新的一条（entries 通常最新在前，时间相同则保留靠前那条）。 */
export function latestByKey(entries) {
  const map = new Map()
  const times = new Map()
  for (const entry of entries ?? []) {
    if (!entry || typeof entry.key !== 'string') continue
    const time = Date.parse(entry.createdAt ?? '') || 0
    if (!map.has(entry.key) || time > (times.get(entry.key) ?? -Infinity)) {
      map.set(entry.key, entry)
      times.set(entry.key, time)
    }
  }
  return map
}

// ---------------------------------------------------------------------------
// 文档索引 index.json（按设计文档存为数组，最新加入的在前）
// ---------------------------------------------------------------------------

export async function readIndex(env = process.env) {
  const raw = await readJson(path.join(storeDir(env), 'index.json'), [])
  if (Array.isArray(raw)) return raw.filter(doc => doc && isDocId(doc.id))
  if (raw && Array.isArray(raw.docs)) return raw.docs.filter(doc => doc && isDocId(doc.id))
  return []
}

export async function writeIndex(docs, env = process.env) {
  await writeJsonAtomic(path.join(storeDir(env), 'index.json'), docs)
  return docs
}

/** 读-改-写索引；mutate 返回新数组（或原地改后返回 undefined）。 */
export async function updateIndex(env, mutate) {
  const docs = await readIndex(env)
  const next = (await mutate(docs)) ?? docs
  await writeIndex(next, env)
  return next
}

/** 按 id 插入或更新索引条目（保留原 addedAt）。 */
export async function upsertDoc(doc, env = process.env) {
  return updateIndex(env, docs => {
    const index = docs.findIndex(item => item.id === doc.id)
    if (index === -1) return [doc, ...docs]
    const merged = { ...docs[index], ...doc }
    const next = docs.slice()
    next[index] = merged
    return next
  })
}

// ---------------------------------------------------------------------------
// UI 状态 ui-state.json
// ---------------------------------------------------------------------------

export async function readUiState(env = process.env) {
  const raw = await readJson(path.join(storeDir(env), 'ui-state.json'), null)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { lastDocId: null, perDoc: {} }
  const perDoc = raw.perDoc && typeof raw.perDoc === 'object' && !Array.isArray(raw.perDoc) ? raw.perDoc : {}
  const cleaned = {}
  for (const [id, value] of Object.entries(perDoc)) {
    if (isDocId(id) && value && typeof value === 'object') cleaned[id] = value
  }
  return {
    lastDocId: isDocId(raw.lastDocId) ? raw.lastDocId : null,
    perDoc: cleaned,
  }
}

/** 浅合并写 UI 状态；perDoc 按论文 id 做一层合并（lastPage/scrollTop 可分别更新）。 */
export async function updateUiState(patch, env = process.env) {
  const state = await readUiState(env)
  if (patch && 'lastDocId' in patch) {
    state.lastDocId = isDocId(patch.lastDocId) ? patch.lastDocId : null
  }
  if (patch && patch.perDoc && typeof patch.perDoc === 'object') {
    for (const [id, value] of Object.entries(patch.perDoc)) {
      if (!isDocId(id)) continue
      if (value === null) {
        delete state.perDoc[id]
      } else if (value && typeof value === 'object') {
        state.perDoc[id] = { ...(state.perDoc[id] ?? {}), ...value }
      }
    }
  }
  await writeJsonAtomic(path.join(storeDir(env), 'ui-state.json'), state)
  return state
}

// ---------------------------------------------------------------------------
// 解释历史 explanations.json（追加式，最新在前）
// ---------------------------------------------------------------------------

export async function readExplanations(docId, env = process.env) {
  const raw = await readJson(docPaths(docId, env).explanations, null)
  if (Array.isArray(raw)) return raw
  if (raw && Array.isArray(raw.entries)) return raw.entries
  return []
}

export async function writeExplanations(docId, entries, env = process.env) {
  await writeJsonAtomic(docPaths(docId, env).explanations, { version: 1, entries })
  return entries
}

export async function appendExplanation(docId, entry, env = process.env) {
  const entries = await readExplanations(docId, env)
  entries.unshift(entry)
  await writeExplanations(docId, entries, env)
  return entries
}

/** 原地更新一条解释（缓存命中时递增 hitCount）；找不到抛 not-found。 */
export async function updateExplanation(docId, id, patch, env = process.env) {
  const entries = await readExplanations(docId, env)
  const index = entries.findIndex(entry => entry && entry.id === id)
  if (index === -1) throw new PaperError('not-found', `解释条目不存在：${String(id)}`, 404)
  entries[index] = { ...entries[index], ...patch }
  await writeExplanations(docId, entries, env)
  return entries[index]
}

export async function countExplained(docId, env = process.env) {
  const entries = await readExplanations(docId, env)
  return entries.length
}

// ---------------------------------------------------------------------------
// 术语表 terms.json（由解释结果的 terms trailer 自动累积）
// ---------------------------------------------------------------------------

export function termsPath(docId, env = process.env) {
  return path.join(docDir(docId, env), 'terms.json')
}

/** 读术语表；按 count 降序、updatedAt 降序（CONTRACT §2 GET /terms）。 */
export async function readTerms(docId, env = process.env) {
  const raw = await readJson(termsPath(docId, env), null)
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.terms) ? raw.terms : [])
  return list
    .filter(item => item && typeof item.key === 'string' && item.key)
    .sort((left, right) => {
      const byCount = (Number(right.count) || 0) - (Number(left.count) || 0)
      if (byCount !== 0) return byCount
      return (Date.parse(right.updatedAt ?? '') || 0) - (Date.parse(left.updatedAt ?? '') || 0)
    })
}

export async function writeTerms(docId, terms, env = process.env) {
  await writeJsonAtomic(termsPath(docId, env), { version: 1, terms })
  return terms
}

/**
 * 合并一批术语：按 key 累加 count，保留首次出现位置（page/paraId/firstEntryId），
 * 已有中文/说明为空时用新的补上，updatedAt 每次刷新。
 * @param {string} docId 文档 id
 * @param {{term:string,zh?:string,note?:string}[]} terms 本轮解释解析出的术语
 * @param {{entryId?:string,page?:number,paraId?:string}} meta 来源条目信息
 */
export async function mergeTerms(docId, terms, meta = {}, env = process.env) {
  const existing = await readTerms(docId, env)
  const byKey = new Map(existing.map(item => [item.key, item]))
  const now = new Date().toISOString()
  for (const raw of Array.isArray(terms) ? terms : []) {
    const term = String(raw?.term ?? '').trim()
    if (!term) continue
    const key = term.toLowerCase()
    const zh = String(raw?.zh ?? '').trim()
    const note = String(raw?.note ?? '').trim()
    const previous = byKey.get(key)
    if (previous) {
      previous.count = (Number(previous.count) || 0) + 1
      if (!previous.zh && zh) previous.zh = zh
      if (!previous.note && note) previous.note = note
      previous.updatedAt = now
      continue
    }
    const entry = {
      key,
      term,
      zh,
      note,
      count: 1,
      page: Number.isInteger(meta.page) ? meta.page : null,
      paraId: typeof meta.paraId === 'string' ? meta.paraId : '',
      firstEntryId: typeof meta.entryId === 'string' ? meta.entryId : '',
      updatedAt: now,
    }
    byKey.set(key, entry)
  }
  const merged = Array.from(byKey.values())
  await writeTerms(docId, merged, env)
  return readTerms(docId, env)
}

function markdownCell(value) {
  return String(value ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim()
}

/** 术语表导出 Markdown（标题 = 论文名；表格：术语 / 中文 / 说明 / 出现次数）。 */
export function renderTermsMarkdown(doc, terms) {
  const title = String(doc?.title ?? '').trim() || '论文'
  const list = Array.isArray(terms) ? terms : []
  const lines = [
    `# ${title} · 术语表`,
    '',
    `共 ${list.length} 条术语（按出现次数排序）。`,
    '',
    '| 术语 | 中文 | 说明 | 出现次数 |',
    '| --- | --- | --- | --- |',
  ]
  for (const item of list) {
    lines.push(`| ${markdownCell(item.term)} | ${markdownCell(item.zh)} | ${markdownCell(item.note)} | ${Number(item.count) || 0} |`)
  }
  lines.push('')
  lines.push('> 由文献阅读坞在解释过程中自动累积。')
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 批注 annotations.json（追加式，原子写；读-改-写按文档串行，避免并发丢写）
// ---------------------------------------------------------------------------

export const ANNOTATION_COLORS = ['yellow', 'green', 'blue', 'pink']
export const ANNOTATION_KINDS = ['highlight', 'note']
export const ANNOTATION_TEXT_LIMIT = 4000

/** 同一篇论文的批注串行队列：POST/PATCH/DELETE 并发时不会互相覆盖。 */
const annotationQueues = new Map()

function withAnnotationQueue(docId, task) {
  const previous = annotationQueues.get(docId) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  annotationQueues.set(docId, next)
  next.finally(() => {
    if (annotationQueues.get(docId) === next) annotationQueues.delete(docId)
  }).catch(() => {})
  return next
}

export function linksPath(docId, env = process.env) {
  return path.join(docDir(docId, env), 'links.json')
}

export function annotationsPath(docId, env = process.env) {
  return path.join(docDir(docId, env), 'annotations.json')
}

/** 新批注 id：a_<12 位十六进制>（CONTRACT）。 */
export function newAnnotationId() {
  return `a_${randomBytes(6).toString('hex')}`
}

/** 读批注列表（保持落盘顺序；缺失文件返回 []，老文档兼容）。 */
export async function readAnnotations(docId, env = process.env) {
  const raw = await readJson(annotationsPath(docId, env), null)
  if (Array.isArray(raw)) return raw
  if (raw && Array.isArray(raw.items)) return raw.items
  return []
}

export async function writeAnnotations(docId, items, env = process.env) {
  await writeJsonAtomic(annotationsPath(docId, env), { version: 1, items })
  return items
}

/** 追加一条批注（串行读改写 + 原子写）。 */
export async function appendAnnotation(docId, item, env = process.env) {
  return withAnnotationQueue(docId, async () => {
    const items = await readAnnotations(docId, env)
    items.push(item)
    await writeAnnotations(docId, items, env)
    return item
  })
}

/** 按 id 更新批注（PATCH 只允许 note/color，路由层已校验）；找不到抛 not-found。 */
export async function updateAnnotation(docId, id, patch, env = process.env) {
  return withAnnotationQueue(docId, async () => {
    const items = await readAnnotations(docId, env)
    const index = items.findIndex(item => item && item.id === id)
    if (index === -1) throw new PaperError('not-found', `批注不存在：${String(id)}`, 404)
    items[index] = { ...items[index], ...patch, updatedAt: new Date().toISOString() }
    await writeAnnotations(docId, items, env)
    return items[index]
  })
}

/** 按 id 删除批注；不存在抛 not-found（CONTRACT：DELETE 不存在返回 404）。 */
export async function deleteAnnotation(docId, id, env = process.env) {
  return withAnnotationQueue(docId, async () => {
    const items = await readAnnotations(docId, env)
    const index = items.findIndex(item => item && item.id === id)
    if (index === -1) throw new PaperError('not-found', `批注不存在：${String(id)}`, 404)
    items.splice(index, 1)
    await writeAnnotations(docId, items, env)
    return true
  })
}

// ---------------------------------------------------------------------------
// 阅读笔记 Markdown 导出（避免 markdown 注入：引用块逐行加 "> "，表格单元格转义）
// ---------------------------------------------------------------------------

/** 表格单元格：转义反斜杠与竖线，折叠换行。 */
function notesTableCell(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim()
}

/** 引用块单行：每行前缀 "> "；同时转义会破坏结构的行首标记（标题/嵌套引用/列表/代码块）。 */
function notesBlockquoteLine(line) {
  let escaped = String(line ?? '').replace(/\|/g, '\\|')
  escaped = escaped.replace(/^(\s*)([#>`\-+*])/, (match, space, char) => `${space}\\${char}`)
  escaped = escaped.replace(/^(\s*)(\d+)\./, (match, space, number) => `${space}${number}\\.`)
  return `> ${escaped}`
}

function notesBlockquote(text) {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length === 1 && lines[0] === '') return ['>']
  return lines.map(line => notesBlockquoteLine(line))
}

/**
 * 生成阅读笔记 Markdown：
 * 标题 + 元信息（页数/导入时间/解释数/术语数）+ `## 批注`（按页分组）+ `## 术语表`。
 * @param {{doc?:object,structure?:object,annotations?:object[],terms?:object[],explanationCount?:number}} input
 */
export function renderNotesMarkdown({ doc = {}, structure = {}, annotations = [], terms = [], explanationCount = 0 } = {}) {
  const title = String(doc?.title ?? structure?.title ?? '').replace(/\r?\n/g, ' ').trim() || '论文'
  const pageCount = Number(structure?.pageCount) || (Array.isArray(structure?.pages) ? structure.pages.length : 0)
  const items = Array.isArray(annotations) ? annotations : []
  const termList = Array.isArray(terms) ? terms : []
  const lines = [
    `# ${title} · 阅读笔记`,
    '',
    `- 页数：${pageCount}`,
    `- 导入时间：${doc?.addedAt ?? '（未知）'}`,
    `- 解释数：${Number(explanationCount) || 0}`,
    `- 术语数：${termList.length}`,
    '',
    '## 批注',
    '',
  ]

  if (items.length === 0) {
    lines.push('暂无批注。', '')
  } else {
    const byPage = new Map()
    for (const item of items) {
      const page = Number(item?.page) || 1
      if (!byPage.has(page)) byPage.set(page, [])
      byPage.get(page).push(item)
    }
    for (const page of [...byPage.keys()].sort((left, right) => left - right)) {
      lines.push(`### 第 ${page} 页`, '')
      const entries = byPage.get(page).slice().sort((left, right) => (Date.parse(left.createdAt ?? '') || 0) - (Date.parse(right.createdAt ?? '') || 0))
      for (const item of entries) {
        lines.push(...notesBlockquote(item.text ?? ''))
        if (item.note) {
          lines.push('>')
          const noteLines = notesBlockquote(item.note)
          noteLines.forEach((line, index) => {
            lines.push(index === 0 ? line.replace(/^> /, '> 备注：') : line)
          })
        }
        lines.push('>')
        lines.push(`> 颜色：${String(item.color ?? 'yellow')}`)
        lines.push('')
      }
    }
  }

  lines.push('## 术语表', '')
  if (termList.length === 0) {
    lines.push('暂无术语。', '')
  } else {
    lines.push('| 术语 | 中文 | 说明 | 出现次数 |', '| --- | --- | --- | --- |')
    for (const item of termList) {
      lines.push(
        `| ${notesTableCell(item.term)} | ${notesTableCell(item.zh)} | ${notesTableCell(item.note)} | ${Number(item.count) || 0} |`,
      )
    }
    lines.push('')
  }
  lines.push('> 由文献阅读坞导出。', '')
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// 读取抽取产物（结构 / 页词坐标）
// ---------------------------------------------------------------------------

export async function readStructure(docId, env = process.env) {
  return readJson(docPaths(docId, env).structure, null)
}

export async function readPage(docId, n, env = process.env) {
  return readJson(docPaths(docId, env).pageJson(n), null)
}

/** 在段落数组里按 id 找相邻段（前/后一段）。 */
export function neighborParas(paras, paraId) {
  const index = (paras ?? []).findIndex(para => para && para.id === paraId)
  if (index === -1) return { prev: null, next: null, para: null }
  return {
    para: paras[index],
    prev: index > 0 ? paras[index - 1] : null,
    next: index < paras.length - 1 ? paras[index + 1] : null,
  }
}
