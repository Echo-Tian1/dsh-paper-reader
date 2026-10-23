/**
 * 文献阅读坞 · 宿主半解释
 *
 * 流程（CONTRACT §5/§6）：
 *  1) 归一化选句 → cacheKey = sha256(docId|recipe|norm(text)|paraId)；
 *  2) 命中且非 force：hitCount+1、lastHitAt 更新后直接回放缓存，不调模型；
 *  3) 未命中：拼上下文 → ctx.llm.stream → SSE 逐块 delta → 完整结束后才落盘；
 *  4) 中途断开 / 模型报错 / 输出被截断：只发 error 事件，绝不写缓存。
 *
 * 缓存键归一化是宿主半唯一实现（store.norm），页面不做二次归一化。
 */
import { randomBytes } from 'node:crypto'

import {
  PaperError,
  RECIPE,
  appendExplanation,
  cacheKey,
  hashContext,
  latestByKey,
  neighborParas,
  norm,
  readExplanations,
  readStructure,
  updateExplanation,
} from './store.js'
import { readJsonBody } from './ingest.js'

/** 解释提示词（recipe v1）；改这里必须同时升 store.RECIPE。 */
export const SYSTEM_PROMPT = `你是一位耐心的学术论文阅读助教，帮助中文母语读者读懂英文/中文学术论文。
只依据给出的论文片段作答，不要引入片段之外的文献或事实。不确定的地方明确写「不确定」。
输出 Markdown，必须且只能包含三节：
### 1. 中译
（把「选句」整句译成通顺中文；专业术语保留英文原词，格式：中文（English））
### 2. 难点
（逐条列出：术语含义 / 句法结构 / 指代关系 / 隐含前提。每条 1-3 行，不要空话）
### 3. 在论证中的位置
（2-4 行：这句话在所在段落和章节里承担什么作用，和上下文怎么衔接）
不要输出开场白、总结、免责声明。`

/** 上下文长度控制（CONTRACT §6）。 */
const PARA_TEXT_LIMIT = 2000
const NEIGHBOR_LIMIT = 600
const EXPLAIN_BODY_LIMIT = 1024 * 1024

function truncate(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  return `${value.slice(0, limit)}…`
}

/**
 * 拼装解释上下文。
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 在段落内定位选句的字符区间 [start, end)，定位不到返回 null。
 * 优先与 structure 的句区间重合（忽略首尾空白，客户端按句选择时最准）；
 * 其次原文 indexOf 直接命中（选半句/跨句）；最后用空白不敏感正则兜底
 * （页面文字层与段落文本的空白可能不同）。跨段/定位不到时不写该字段。
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

/** 写一条 SSE 事件；客户端断开时返回 false。 */
function writeEvent(res, payload) {
  try {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
    return true
  } catch {
    return false
  }
}

/**
 * 处理 POST /api/explain：先做缓存命中判断，再决定是否调模型。
 * @param {{ctx:object, config:object, env:object, req:object, res:object}} options
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

  const force = body.force === true
  const recipe = RECIPE
  const selection = String(sel.text).trim()
  const normText = norm(selection)
  const paraId = typeof sel.paraId === 'string' ? sel.paraId : ''
  const key = cacheKey(docId, recipe, normText, paraId)
  const entries = await readExplanations(docId, env)
  const latest = latestByKey(entries).get(key) ?? null

  // 命中缓存（且不是强制重新解释）：零 token 直接回放
  if (latest && typeof latest.answer === 'string' && latest.answer.trim() && !force) {
    let entry = latest
    try {
      entry = await updateExplanation(docId, latest.id, {
        hitCount: (Number(latest.hitCount) || 0) + 1,
        lastHitAt: new Date().toISOString(),
      }, env)
    } catch {
      // 缓存条目刚被别的请求改掉：仍回放旧内容，不因统计失败而报错
    }
    startSse(res)
    writeEvent(res, { type: 'meta', cached: true, id: entry.id, hitCount: entry.hitCount })
    writeEvent(res, { type: 'done', entry })
    res.end()
    return
  }

  const context = buildContext(structure, { ...sel, text: selection })
  const request = buildLlmRequest(config, context)
  const contextHash = hashContext(recipe, request.system, context.userText)
  const id = `e_${randomBytes(8).toString('hex')}`
  const provider = config.provider
  const model = config.model
  // 段内字符区间：客户端据此在原文上精确画「已解释」标记；定位不到就不写（可选字段）
  const sent = locateSelectionRange(context.para, selection)
  const entry = {
    id,
    key,
    recipe,
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
  writeEvent(res, { type: 'meta', cached: false, id, key })

  const controller = new AbortController()
  let clientGone = false
  const onClose = () => {
    // res.end() 之后也会触发 close，只有“没写完就断”才是客户端离开
    if (!res.writableFinished) {
      clientGone = true
      controller.abort()
    }
  }
  res.on?.('close', onClose)

  let answer = ''
  let finishKind = null
  let failure = null
  try {
    const stream = ctx.llm.stream({ ...request, signal: controller.signal })
    for await (const chunk of stream) {
      if (clientGone) break
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta') {
        if (typeof chunk.text === 'string' && chunk.text) {
          answer += chunk.text
          if (!writeEvent(res, { type: 'delta', text: chunk.text })) break
        }
      } else if (chunk.type === 'finish') {
        finishKind = chunk.reason?.kind ?? null
        if (finishKind === 'error' || finishKind === 'aborted') {
          failure = chunk.reason?.failure?.message || (finishKind === 'aborted' ? '模型调用已中止' : '模型调用失败')
        }
      }
      // usage / block-start / block-end 等事件对解释线程无用，忽略
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    res.off?.('close', onClose)
  }

  if (clientGone) {
    // 中途断开：不落盘、不再写
    try { res.end() } catch { /* 已断开 */ }
    return
  }
  if (failure) {
    writeEvent(res, { type: 'error', code: 'llm-failed', message: `解释失败：${failure}` })
    res.end()
    return
  }
  if (finishKind === 'max-tokens') {
    writeEvent(res, { type: 'error', code: 'llm-failed', message: '解释达到长度上限（maxTokens），未写入缓存；可调高 maxTokens 后重试' })
    res.end()
    return
  }
  if (finishKind !== 'stop') {
    writeEvent(res, { type: 'error', code: 'llm-failed', message: '模型流没有正常结束，未写入缓存' })
    res.end()
    return
  }
  if (!answer.trim()) {
    writeEvent(res, { type: 'error', code: 'llm-failed', message: '模型没有返回内容，未写入缓存' })
    res.end()
    return
  }

  entry.answer = answer
  try {
    await appendExplanation(docId, entry, env)
  } catch (error) {
    writeEvent(res, {
      type: 'error',
      code: 'llm-failed',
      message: `解释已生成但写入缓存失败：${error instanceof Error ? error.message : String(error)}`,
    })
    res.end()
    return
  }
  writeEvent(res, { type: 'done', entry })
  res.end()
}
