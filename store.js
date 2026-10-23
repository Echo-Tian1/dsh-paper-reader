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

/** 解释配方版本；改提示词必须同时升版本（CONTRACT §5）。 */
export const RECIPE = 'v1'

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
