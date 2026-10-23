/**
 * 文献阅读坞 · 宿主半解释（v2）
 *
 * 三条链路共用同一套 SSE 写出/校验逻辑：
 *  - POST /api/explain        选句解释（recipe v2，输出末尾带 terms trailer）
 *  - POST /api/translate      整段翻译（translate-v1，纯译文）
 *  - POST /api/explain-region 框选区域解释（region-v1，区域文字层 + 上下文）
 *
 * 缓存规则（CONTRACT §5）：
 *  explain   : sha256(docId|v2|norm(selection)|paraId)
 *  translate : sha256(docId|translate-v1|paraId|sha1(paraText))
 *  region    : sha256(docId|region-v1|page|rect 取整 0.1pt|sha1(regionText))
 * 命中且非 force → hitCount+1 后零 token 回放；只有完整成功（finish:stop）才落盘。
 *
 * terms trailer 的流式扣住见 {@link TermsHoldback}：`<!--terms:` 可能跨 chunk
 * （甚至 `<!--` 本身跨 chunk），所以缓冲区末尾若恰好是 marker 的前缀也必须扣住。
 */
import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'

import {
  PaperError,
  RECIPE,
  REGION_RECIPE,
  TRANSLATE_RECIPE,
  appendExplanation,
  cacheKey,
  docPaths,
  hashContext,
  latestByKey,
  mergeTerms,
  neighborParas,
  norm,
  readExplanations,
  readStructure,
  regionKey,
  targetLanguage,
  translateKey,
  updateExplanation,
} from './store.js'
import { extractRegion, readJsonBody } from './ingest.js'

/** 解释配方 v2 的 system（CONTRACT §6，末尾带机器可读 terms trailer）。 */
export const SYSTEM_PROMPT = `你是一位耐心的学术论文阅读助教，帮助中文母语读者读懂英文/中文学术论文。
只依据给出的论文片段作答，不要引入片段之外的文献或事实。不确定的地方明确写「不确定」。
输出 Markdown，必须且只能包含三节：
### 1. 中译
（把「选句」整句译成通顺中文；专业术语保留英文原词，格式：中文（English））
### 2. 难点
（逐条列出：术语含义 / 句法结构 / 指代关系 / 隐含前提。每条 1-3 行，不要空话）
### 3. 在论证中的位置
（2-4 行：这句话在所在段落和章节里承担什么作用，和上下文怎么衔接）
不要输出开场白、总结、免责声明。

正文结束后，另起一行输出且仅输出这一行机器可读注释（供术语表累积，用户看不到）：
<!--terms:{"terms":[{"term":"英文原词或符号","zh":"中文译名","note":"一句话说明"}]}-->
术语取本节解释里真正影响理解的 1-4 个；没有就给 {"terms":[]}。`

/** 整段翻译 system 模板（目标语言运行时填入）。 */
export const TRANSLATE_SYSTEM_TEMPLATE = `你是一位严谨的学术翻译，把下面这段论文原文完整译成{target}。
只输出译文本身：不要解释、不要总结、不要开场白、不要输出原文。
保留公式、数学符号、变量名与引用编号原样（如 $...$、\\alpha、[13]），不要翻译代码、URL。
术语用领域惯用译法；保持原文的段落结构与 Markdown 格式。`

/** 框选区域解释 system。 */
export const REGION_SYSTEM_PROMPT = `你是一位耐心的学术论文阅读助教，正在帮助中文母语读者理解论文版面里框选出来的一块区域（可能是公式、图、表或正文片段）。
只依据给出的区域文字与上下文作答，不要编造区域之外的事实；不确定的地方明确写「不确定」。
输出 Markdown，必须且只能包含三节：
### 1. 这是什么
（判断区域是公式/图/表/正文片段，概括它表达的内容；如果区域没有文字层，明确说明只能依据上下文与版面位置推测）
### 2. 符号与含义
（逐条解释区域内的符号、变量、箭头、缩写；没有则写「无」）
### 3. 与上下文的关系
（2-4 行：这块内容在所在段落/章节里承担什么作用，与前后文怎么衔接）
不要输出开场白、总结、免责声明。`

const TERMS_MARKER = '<!--terms:'
const TERMS_CLOSE = '-->'
const PARA_TEXT_LIMIT = 2000
const NEIGHBOR_LIMIT = 600
const EXPLAIN_BODY_LIMIT = 1024 * 1024

function truncate(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…`
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// ---------------------------------------------------------------------------
// terms trailer 解析 / 流式扣住
// ---------------------------------------------------------------------------

/** 解析 `<!--terms:` 与 `-->` 之间的 JSON；失败返回 []（解析失败不影响解释落盘）。 */
export function parseTermsPayload(raw) {
  try {
    const data = JSON.parse(String(raw ?? '').trim())
    const list = Array.isArray(data?.terms) ? data.terms : []
    return list
      .filter(item => item && typeof item.term === 'string' && item.term.trim())
      .map(item => ({
        term: item.term.trim(),
        zh: typeof item.zh === 'string' ? item.zh.trim() : '',
        note: typeof item.note === 'string' ? item.note.trim() : '',
      }))
  } catch {
    return []
  }
}

/** 从完整文本里剥离 terms trailer（返回 answer 与 terms）。 */
export function extractTermsTrailer(text) {
  const raw = String(text ?? '')
  const markerAt = raw.indexOf(TERMS_MARKER)
  if (markerAt === -1) return { answer: raw.trimEnd(), terms: [] }
  const closeAt = raw.indexOf(TERMS_CLOSE, markerAt + TERMS_MARKER.length)
  if (closeAt === -1) return { answer: raw.slice(0, markerAt).trimEnd(), terms: [] }
  const payload = raw.slice(markerAt + TERMS_MARKER.length, closeAt)
  return { answer: raw.slice(0, markerAt).trimEnd(), terms: parseTermsPayload(payload) }
}

/**
 * 流式 terms trailer 缓冲器。
 *
 * push(delta) 返回“现在可以安全发给客户端的文本”：
 *  - 缓冲区里出现完整 marker（`<!--terms:`）→ 只发 marker 之前的部分，之后全部扣住；
 *  - 没出现完整 marker、但缓冲区末尾恰好是 marker 的前缀（如 `<` / `<!--` / `<!--te`）
 *    → 把这截前缀扣住，等下一个 chunk 再判断（避免 `<!--` 自身跨 chunk 时漏发）；
 *  - 其余情况全部直接发。
 * finish() 解析扣住的部分、把它从 answer 里剔除，返回剩余正文与 terms。
 */
export class TermsHoldback {
  constructor(marker = TERMS_MARKER, close = TERMS_CLOSE) {
    this.marker = marker
    this.close = close
    this.buffer = ''
    this.answer = ''
    this.terms = []
  }

  push(chunk) {
    this.buffer += String(chunk ?? '')
    let emit
    const markerAt = this.buffer.indexOf(this.marker)
    if (markerAt !== -1) {
      emit = this.buffer.slice(0, markerAt)
      this.buffer = this.buffer.slice(markerAt)
    } else {
      let hold = 0
      const maxHold = Math.min(this.marker.length - 1, this.buffer.length)
      for (let length = maxHold; length > 0; length -= 1) {
        if (this.marker.startsWith(this.buffer.slice(-length))) {
          hold = length
          break
        }
      }
      emit = this.buffer.slice(0, this.buffer.length - hold)
      this.buffer = this.buffer.slice(this.buffer.length - hold)
    }
    this.answer += emit
    return emit
  }

  finish() {
    let text = ''
    const markerAt = this.buffer.indexOf(this.marker)
    if (markerAt === -1) {
      // 没有完整 marker：扣住的只是正文尾部（可能是个孤立的 "<"），照常发出
      text = this.buffer
    } else {
      text = this.buffer.slice(0, markerAt)
      const closeAt = this.buffer.indexOf(this.close, markerAt + this.marker.length)
      if (closeAt !== -1) {
        this.terms = parseTermsPayload(this.buffer.slice(markerAt + this.marker.length, closeAt))
      }
      // marker 之后（含未闭合的畸形 trailer）一律丢弃，不发给客户端也不落盘
    }
    this.answer += text
    this.buffer = ''
    this.answer = this.answer.trimEnd()
    return { text, answer: this.answer, terms: this.terms }
  }
}

// ---------------------------------------------------------------------------
// 上下文 / 语言 / 区域
// ---------------------------------------------------------------------------

/**
 * 拼装选句解释的上下文（CONTRACT §6 user 模板）。
 * @param {object} structure structure.json
 * @param {{page:number,paraId:string,text:string}} sel 选句
 */
export function buildContext(structure, sel) {
  const paras = structure?.paras ?? []
  const sections = structure?.sections ?? []
  const paraId = typeof sel?.paraId === 'string' ? sel.paraId : ''
  const { para, prev, next } = neighborParas(paras, paraId)
  const section = sections.find(item => item && item.id === (para?.sectionId))
    ?? sections.find(item => Array.isArray(item?.paraIds) && item.paraIds.includes(paraId))
    ?? null
  const page = Number.isInteger(Number(sel?.page)) && Number(sel.page) > 0
    ? Number(sel.page)
    : (para?.page ?? 1)
  const selection = String(sel?.text ?? '').trim()
  const paraText = truncate(para?.text ?? '', PARA_TEXT_LIMIT)
  const prevText = truncate(prev?.text ?? '', NEIGHBOR_LIMIT)
  const nextText = truncate(next?.text ?? '', NEIGHBOR_LIMIT)
  const title = String(structure?.title ?? '')
  const sectionTitle = section?.title ?? ''
  const userText = [
    `论文：${title}`,
    `位置：第 ${page} 页 · ${sectionTitle || '（未知章节）'}`,
    `选句：<<<${selection}>>>`,
    `所在段落：${paraText || '（未找到所在段落）'}`,
    `前一段：${prevText || '（无）'}`,
    `后一段：${nextText || '（无）'}`,
  ].join('\n')
  return {
    title,
    page,
    section: sectionTitle,
    sectionId: section?.id ?? para?.sectionId ?? '',
    paraId,
    para,
    paraText,
    prevText,
    nextText,
    selection,
    userText,
  }
}

/** 组 ctx.llm.stream 的参数（CONTRACT §6）。 */
export function buildLlmRequest(config, context) {
  return {
    provider: config.provider,
    model: config.model,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: [{ type: 'text', text: context.userText }] },
    ],
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  }
}

/** 整段翻译 system（目标语言：zh → 中文；en → 英文）。 */
export function buildTranslateSystem(language) {
  return TRANSLATE_SYSTEM_TEMPLATE.replace('{target}', language === 'en' ? '英文' : '中文')
}

/**
 * 在段落内定位选句的字符区间 [start, end)，定位不到返回 null。
 * 优先与 structure 的句区间重合（忽略首尾空白）；其次原文 indexOf；最后空白不敏感正则兜底。
 */
export function locateSelectionRange(para, selection) {
  const text = typeof para?.text === 'string' ? para.text : ''
  const needle = String(selection ?? '').trim()
  if (!text || !needle) return null
  const ranges = Array.isArray(para?.sent) ? para.sent : []
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2) continue
    const [start, end] = range
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue
    if (start < 0 || end > text.length || end <= start) continue
    if (text.slice(start, end).trim() === needle) return [start, end]
  }
  const direct = text.indexOf(needle)
  if (direct !== -1) return [direct, direct + needle.length]
  let pattern
  try {
    pattern = new RegExp(needle.split(/\s+/).map(escapeRegExp).join('\\s+'))
  } catch {
    return null
  }
  const match = pattern.exec(text)
  if (match) return [match.index, match.index + match[0].length]
  return null
}

/** 找与 rect 相交面积最大的段落（同页）；没有相交返回 null。 */
export function findParaByRect(paras, page, rect) {
  let best = null
  for (const para of paras ?? []) {
    if (!para || para.page !== page) continue
    const bbox = para.bbox
    if (!Array.isArray(bbox) || bbox.length !== 4) continue
    const x0 = Math.max(bbox[0], rect[0])
    const y0 = Math.max(bbox[1], rect[1])
    const x1 = Math.min(bbox[2], rect[2])
    const y1 = Math.min(bbox[3], rect[3])
    if (x1 <= x0 || y1 <= y0) continue
    const area = (x1 - x0) * (y1 - y0)
    if (!best || area > best.area) best = { area, para }
  }
  return best?.para ?? null
}

function sectionOf(structure, para) {
  const sections = structure?.sections ?? []
  return sections.find(item => item && item.id === para?.sectionId) ?? null
}

// ---------------------------------------------------------------------------
// SSE 基础设施
// ---------------------------------------------------------------------------

function respondJson(res, status, payload) {
  if (res.writableEnded || res.headersSent) {
    try { res.end() } catch { /* 客户端已断开 */ }
    return
  }
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

function respondError(res, error) {
  if (error instanceof PaperError) {
    respondJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  respondJson(res, 500, { ok: false, error: { code: 'internal', message: `宿主内部错误：${message}` } })
}

function startSse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  res.flushHeaders?.()
}

function writeEvent(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
    return true
  } catch {
    return false
  }
}

/** 缓存命中：meta{cached:true,kind} + done。 */
function serveCached(res, kind, entry) {
  startSse(res)
  writeEvent(res, { type: 'meta', cached: true, kind, id: entry.id, hitCount: entry.hitCount })
  writeEvent(res, { type: 'done', entry })
  res.end()
}

/**
 * 共用：调用 ctx.llm.stream 并把 text-delta 写进 SSE（explain 额外经过 terms holdback）。
 * @returns {{answer:string,terms:Array,finishKind:string|null,failure:string|null,clientGone:boolean}}
 */
async function consumeCompletion({ ctx, config, req, res, request, holdback = null }) {
  const controller = new AbortController()
  let clientGone = false
  const onClose = () => {
    if (!res.writableFinished) {
      clientGone = true
      controller.abort()
    }
  }
  res.on?.('close', onClose)

  const emit = text => {
    if (!text) return
    if (!writeEvent(res, { type: 'delta', text })) clientGone = true
  }

  let answer = ''
  let finishKind = null
  let failure = null
  try {
    const stream = ctx.llm.stream({ ...request, signal: controller.signal })
    for await (const chunk of stream) {
      if (clientGone) break
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') {
        if (typeof chunk.text !== 'string' || !chunk.text) continue
        if (holdback) emit(holdback.push(chunk.text))
        else {
          answer += chunk.text
          emit(chunk.text)
        }
      } else if (chunk.type === 'finish') {
        finishKind = chunk.reason?.kind ?? null
        if (finishKind === 'error' || finishKind === 'aborted') {
          failure = chunk.reason?.failure?.message
            || (finishKind === 'aborted' ? '模型调用已中止' : '模型调用失败')
        }
      }
      // usage / block-start / block-end 对页面无用，忽略
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    res.off?.('close', onClose)
  }

  let terms = []
  if (holdback && !clientGone) {
    const tail = holdback.finish()
    if (tail.text) emit(tail.text)
    answer = tail.answer
    terms = tail.terms
  }
  return { answer, terms, finishKind, failure, clientGone }
}

/** 校验一次完整回答；返回 null 表示成功，否则返回给客户端的错误文案。 */
function completionError(result) {
  if (result.clientGone) return null
  if (result.failure) return `解释失败：${result.failure}`
  if (result.finishKind === 'max-tokens') return '回答达到长度上限（maxTokens），未写入缓存；可调高 maxTokens 后重试'
  if (result.finishKind !== 'stop') return '模型流没有正常结束，未写入缓存'
  if (!result.answer.trim()) return '模型没有返回内容，未写入缓存'
  return null
}

/** 只发 error 事件并结束（不写缓存）。 */
function finishWithError(res, message) {
  writeEvent(res, { type: 'error', code: 'llm-failed', message })
  res.end()
}

// ---------------------------------------------------------------------------
// 三条链路
// ---------------------------------------------------------------------------

/**
 * 处理 POST /api/explain（选句解释，recipe v2）。
 */
export async function serveExplain({ ctx, config, env = process.env, req, res }) {
  let body
  try {
    body = await readJsonBody(req, EXPLAIN_BODY_LIMIT)
  } catch (error) {
    respondError(res, error)
    return
  }
  const docId = body?.docId
  const sel = body?.sel
  if (typeof docId !== 'string' || !/^[0-9a-f]{16}$/.test(docId)) {
    respondError(res, new PaperError('bad-request', '缺少或非法的 docId', 400))
    return
  }
  if (!sel || typeof sel.text !== 'string' || !sel.text.trim()) {
    respondError(res, new PaperError('bad-request', '缺少选句文本 sel.text', 400))
    return
  }

  let structure
  try {
    structure = await readStructure(docId, env)
  } catch (error) {
    respondError(res, error)
    return
  }
  if (!structure) {
    respondError(res, new PaperError('not-found', `找不到文档：${docId}`, 404))
    return
  }

  const kind = 'explain'
  const force = body.force === true
  const recipe = RECIPE
  const selection = String(sel.text).trim()
  const normText = norm(selection)
  const paraId = typeof sel.paraId === 'string' ? sel.paraId : ''
  const key = cacheKey(docId, recipe, normText, paraId)
  const entries = await readExplanations(docId, env)
  const latest = latestByKey(entries).get(key) ?? null

  if (latest && typeof latest.answer === 'string' && latest.answer.trim() && !force) {
    let entry = latest
    try {
      entry = await updateExplanation(docId, latest.id, {
        hitCount: (Number(latest.hitCount) || 0) + 1,
        lastHitAt: new Date().toISOString(),
      }, env)
    } catch {
      // 统计失败不影响回放
    }
    serveCached(res, kind, entry)
    return
  }

  const context = buildContext(structure, { ...sel, text: selection })
  const request = buildLlmRequest(config, context)
  const contextHash = hashContext(recipe, request.system, context.userText)
  const id = `e_${randomBytes(8).toString('hex')}`
  const provider = config.provider
  const model = config.model
  const sent = locateSelectionRange(context.para, selection)
  const entry = {
    id,
    key,
    recipe,
    kind,
    selText: selection,
    normText,
    docId,
    page: context.page,
    paraId,
    sectionId: context.sectionId,
    contextHash,
    provider,
    model,
    answer: '',
    createdAt: new Date().toISOString(),
    hitCount: 0,
    lastHitAt: null,
    supersedes: latest?.id ?? null,
    ...(sent ? { sent } : {}),
  }

  startSse(res)
  writeEvent(res, { type: 'meta', cached: false, kind, id, key })

  const holdback = new TermsHoldback()
  const result = await consumeCompletion({ ctx, config, req, res, request, holdback })
  if (result.clientGone) {
    try { res.end() } catch { /* 已断开 */ }
    return
  }
  const errorMessage = completionError(result)
  if (errorMessage) {
    finishWithError(res, errorMessage)
    return
  }

  entry.answer = result.answer
  try {
    await appendExplanation(docId, entry, env)
  } catch (error) {
    finishWithError(res, `解释已生成但写入缓存失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (result.terms.length > 0) {
    try {
      await mergeTerms(docId, result.terms, { entryId: id, page: entry.page, paraId }, env)
    } catch (error) {
      // 术语表是增强功能：合并失败不影响解释落盘
      console.error('[paper-reader] 术语表合并失败:', error instanceof Error ? error.message : error)
    }
  }
  writeEvent(res, { type: 'done', entry })
  res.end()
}

/**
 * 处理 POST /api/translate（整段翻译，translate-v1）。
 * 用 structure 里的段落文本（不是选区文本）；目标语言按 CJK 占比自动判定。
 */
export async function serveTranslate({ ctx, config, env = process.env, req, res }) {
  let body
  try {
    body = await readJsonBody(req, EXPLAIN_BODY_LIMIT)
  } catch (error) {
    respondError(res, error)
    return
  }
  const docId = body?.docId
  const paraId = typeof body?.paraId === 'string' ? body.paraId : ''
  if (typeof docId !== 'string' || !/^[0-9a-f]{16}$/.test(docId)) {
    respondError(res, new PaperError('bad-request', '缺少或非法的 docId', 400))
    return
  }
  if (!paraId) {
    respondError(res, new PaperError('bad-request', '缺少段落 id paraId', 400))
    return
  }
  let structure
  try {
    structure = await readStructure(docId, env)
  } catch (error) {
    respondError(res, error)
    return
  }
  if (!structure) {
    respondError(res, new PaperError('not-found', `找不到文档：${docId}`, 404))
    return
  }
  const para = (structure.paras ?? []).find(item => item && item.id === paraId)
  if (!para || !String(para.text ?? '').trim()) {
    respondError(res, new PaperError('bad-request', `段落不存在或没有文字：${paraId}`, 400))
    return
  }

  const kind = 'translate'
  const force = body.force === true
  const recipe = TRANSLATE_RECIPE
  const paraText = String(para.text)
  const key = translateKey(docId, paraId, paraText)
  const entries = await readExplanations(docId, env)
  const latest = latestByKey(entries).get(key) ?? null
  if (latest && typeof latest.answer === 'string' && latest.answer.trim() && !force) {
    let entry = latest
    try {
      entry = await updateExplanation(docId, latest.id, {
        hitCount: (Number(latest.hitCount) || 0) + 1,
        lastHitAt: new Date().toISOString(),
      }, env)
    } catch {
      // 统计失败不影响回放
    }
    serveCached(res, kind, entry)
    return
  }

  const language = targetLanguage(paraText)
  const system = buildTranslateSystem(language)
  const section = sectionOf(structure, para)
  const userText = [
    `论文：${structure.title ?? ''}`,
    `位置：第 ${para.page} 页 · ${section?.title ?? '（未知章节）'}`,
    `目标语言：${language === 'en' ? '英文' : '中文'}`,
    '原文段落：',
    '<<<',
    paraText,
    '>>>',
  ].join('\n')
  const id = `e_${randomBytes(8).toString('hex')}`
  const provider = config.provider
  const model = config.model
  const entry = {
    id,
    key,
    recipe,
    kind,
    selText: paraText,
    normText: norm(paraText),
    docId,
    page: para.page,
    paraId,
    sectionId: section?.id ?? para.sectionId ?? '',
    contextHash: hashContext(recipe, system, userText),
    provider,
    model,
    answer: '',
    createdAt: new Date().toISOString(),
    hitCount: 0,
    lastHitAt: null,
    supersedes: latest?.id ?? null,
  }

  startSse(res)
  writeEvent(res, { type: 'meta', cached: false, kind, id, key })
  const request = {
    provider: config.provider,
    model: config.model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  }
  const result = await consumeCompletion({ ctx, config, req, res, request })
  if (result.clientGone) {
    try { res.end() } catch { /* 已断开 */ }
    return
  }
  const errorMessage = completionError(result)
  if (errorMessage) {
    finishWithError(res, errorMessage)
    return
  }
  entry.answer = result.answer
  try {
    await appendExplanation(docId, entry, env)
  } catch (error) {
    finishWithError(res, `译文已生成但写入缓存失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  writeEvent(res, { type: 'done', entry })
  res.end()
}

/**
 * 处理 POST /api/explain-region（框选区域解释，region-v1）。
 * 用 extract.py --region 抽区域文字层；相交面积最大的段落做上下文。
 */
export async function serveRegion({ ctx, config, env = process.env, req, res }) {
  let body
  try {
    body = await readJsonBody(req, EXPLAIN_BODY_LIMIT)
  } catch (error) {
    respondError(res, error)
    return
  }
  const docId = body?.docId
  const page = Number(body?.page)
  const rect = body?.rect
  if (typeof docId !== 'string' || !/^[0-9a-f]{16}$/.test(docId)) {
    respondError(res, new PaperError('bad-request', '缺少或非法的 docId', 400))
    return
  }
  if (!Number.isInteger(page) || page < 1) {
    respondError(res, new PaperError('bad-request', '缺少或非法的页码 page', 400))
    return
  }
  if (!Array.isArray(rect) || rect.length !== 4 || rect.some(value => !Number.isFinite(Number(value)))) {
    respondError(res, new PaperError('bad-request', 'rect 必须是 4 个数字 [x0,y0,x1,y1]', 400))
    return
  }
  const box = rect.map(value => Number(value))
  if (box[2] <= box[0] || box[3] <= box[1]) {
    respondError(res, new PaperError('bad-request', 'rect 必须满足 x1 > x0 且 y1 > y0', 400))
    return
  }

  let structure
  try {
    structure = await readStructure(docId, env)
  } catch (error) {
    respondError(res, error)
    return
  }
  if (!structure) {
    respondError(res, new PaperError('not-found', `找不到文档：${docId}`, 404))
    return
  }
  const pageMeta = (structure.pages ?? []).find(item => item && Number(item.n) === page)
  if (!pageMeta) {
    respondError(res, new PaperError('bad-request', `页码超出范围：第 ${page} 页不存在`, 400))
    return
  }
  if (box[0] < 0 || box[1] < 0 || box[2] > pageMeta.w + 0.5 || box[3] > pageMeta.h + 0.5) {
    respondError(res, new PaperError('bad-request', `rect 超出页面范围（页面 ${pageMeta.w}×${pageMeta.h}）`, 400))
    return
  }
  const clamped = [
    Math.max(0, box[0]),
    Math.max(0, box[1]),
    Math.min(pageMeta.w, box[2]),
    Math.min(pageMeta.h, box[3]),
  ]

  const paths = docPaths(docId, env)
  try {
    await fsp.access(paths.source)
  } catch {
    respondError(res, new PaperError('not-found', '找不到原始 PDF 文件', 404))
    return
  }

  let regionText = ''
  try {
    const result = await extractRegion({
      pythonPath: config.pythonPath,
      pdfPath: paths.source,
      page,
      rect: clamped,
      timeoutMs: config.extractTimeoutMs,
    })
    regionText = typeof result.text === 'string' ? result.text : ''
  } catch (error) {
    respondError(res, error)
    return
  }

  const kind = 'region'
  const force = body.force === true
  const recipe = REGION_RECIPE
  const rounded = clamped.map(value => Math.round(value * 100) / 100)
  const key = regionKey(docId, page, rounded, regionText)
  const entries = await readExplanations(docId, env)
  const latest = latestByKey(entries).get(key) ?? null
  if (latest && typeof latest.answer === 'string' && latest.answer.trim() && !force) {
    let entry = latest
    try {
      entry = await updateExplanation(docId, latest.id, {
        hitCount: (Number(latest.hitCount) || 0) + 1,
        lastHitAt: new Date().toISOString(),
      }, env)
    } catch {
      // 统计失败不影响回放
    }
    serveCached(res, kind, entry)
    return
  }

  const para = findParaByRect(structure.paras, page, rounded)
  const { prev, next } = neighborParas(structure.paras ?? [], para?.id ?? '')
  const section = sectionOf(structure, para)
  const paraText = truncate(para?.text ?? '', PARA_TEXT_LIMIT)
  const userText = [
    `论文：${structure.title ?? ''}`,
    `位置：第 ${page} 页 · ${section?.title ?? '（未知章节）'}`,
    `框选区域：第 ${page} 页 [${rounded.join(', ')}]（PDF 点坐标，原点左上）`,
    '区域文字层：',
    '<<<',
    regionText.trim() || '（这块区域没有文字层，只能依据上下文与版面位置推测）',
    '>>>',
    `所在段落：${paraText || '（无）'}`,
    `前一段：${truncate(prev?.text ?? '', NEIGHBOR_LIMIT) || '（无）'}`,
    `后一段：${truncate(next?.text ?? '', NEIGHBOR_LIMIT) || '（无）'}`,
  ].join('\n')
  const id = `e_${randomBytes(8).toString('hex')}`
  const provider = config.provider
  const model = config.model
  const entry = {
    id,
    key,
    recipe,
    kind,
    selText: regionText.trim() || `第 ${page} 页框选区域`,
    normText: norm(regionText),
    docId,
    page,
    paraId: para?.id ?? '',
    sectionId: section?.id ?? para?.sectionId ?? '',
    contextHash: hashContext(recipe, REGION_SYSTEM_PROMPT, userText),
    provider,
    model,
    answer: '',
    createdAt: new Date().toISOString(),
    hitCount: 0,
    lastHitAt: null,
    supersedes: latest?.id ?? null,
    rect: rounded,
    regionText,
  }

  startSse(res)
  writeEvent(res, { type: 'meta', cached: false, kind, id, key })
  const request = {
    provider: config.provider,
    model: config.model,
    system: REGION_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    temperature: config.temperature,
    maxTokens: config.maxTokens,
  }
  const result = await consumeCompletion({ ctx, config, req, res, request })
  if (result.clientGone) {
    try { res.end() } catch { /* 已断开 */ }
    return
  }
  const errorMessage = completionError(result)
  if (errorMessage) {
    finishWithError(res, errorMessage)
    return
  }
  entry.answer = result.answer
  try {
    await appendExplanation(docId, entry, env)
  } catch (error) {
    finishWithError(res, `区域解释已生成但写入缓存失败：${error instanceof Error ? error.message : String(error)}`)
    return
  }
  writeEvent(res, { type: 'done', entry })
  res.end()
}
