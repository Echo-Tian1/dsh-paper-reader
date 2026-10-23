#!/usr/bin/env node
/**
 * 文献阅读坞 · 本地预览/冒烟服务器（不参与插件安装）
 *
 * 在 127.0.0.1:<port> 起一个最小 node:http 服务，挂载宿主半同一个 prefix
 * handler（/dsh-paper-reader/*），用真实 python3 + extract.py 做抽取，页面
 * 也就是正式 index.js 服务的 app/ 静态页。
 *
 * 两种 llm 模式：
 *   默认（不加 REAL_LLM）—— 假 llm 桩：固定三段式文本、不花钱、不需要 key，
 *                          可测 SSE 形状，选句里含 FAIL-LLM 时模拟模型失败。
 *   REAL_LLM=1          —— 真实 DeepSeek：向 <base>/chat/completions 发
 *                          stream:true 请求，把 SSE delta 映射成宿主半的
 *                          text-delta/usage/finish chunk；真模型、真缓存、真 SSE。
 *
 * 用法：
 *   node tests/serve.mjs                          # 默认 18080，假桩，临时数据目录
 *   REAL_LLM=1 node tests/serve.mjs               # 真实模型（需 API key）
 *   PORT=18081 node tests/serve.mjs               # 端口覆盖（兼容 PR_PORT）
 *   DSH_HOME=/tmp/pr-serve node tests/serve.mjs   # 固定数据目录（预览时建议固定）
 *
 * 真实模式的 API key 解析顺序（都不打印 key 本身）：
 *   1) 环境变量 DEEPSEEK_API_KEY
 *   2) DSH_HOME/.credentials.yaml 或 ~/.dsh/.credentials.yaml 里的
 *      DEEPSEEK_API_KEY: sk-...（refs 段的一行）
 *
 * 其它环境变量：
 *   DEEPSEEK_BASE_URL  覆盖 API base（默认 https://api.deepseek.com）
 *   LLM_TIMEOUT_MS     真实请求超时（默认 60000）
 *
 * 页面地址：http://127.0.0.1:<port>/dsh-paper-reader/app/
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createApp } from '../index.js'

const PORT = Number(process.env.PORT || process.env.PR_PORT) || 18080
const HOST = process.env.PR_HOST || '127.0.0.1'
const REAL_LLM = /^(1|true|yes|on)$/i.test(String(process.env.REAL_LLM ?? '').trim())
const API_BASE_URL = String(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 60_000

/** 全局 LLM 调用计数（缓存命中时宿主不会调 llm.stream，所以计数不增）。 */
let llmCalls = 0

/** 取出宿主拼好的 user 文本（content 是 [{type:'text',text}] 块数组）。 */
function userTextOf(options) {
  const content = options?.messages?.[0]?.content
  if (Array.isArray(content)) {
    return content.map(block => (block?.type === 'text' ? String(block.text ?? '') : '')).join('')
  }
  return typeof content === 'string' ? content : ''
}

/** 把宿主消息拍平成 OpenAI/DeepSeek wire 格式的一条消息。 */
function flattenMessage(message) {
  const content = message?.content
  if (Array.isArray(content)) {
    return content.map(block => (block?.type === 'text' ? String(block.text ?? '') : '')).join('')
  }
  return typeof content === 'string' ? content : ''
}

function locationOf(userText) {
  return /位置：([^\n]+)/.exec(userText)?.[1] ?? '?'
}

function finishError(message, code) {
  return { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
}

/** fetch 失败的 message 常常只有 "fetch failed"，把 cause 里的真实原因（ECONNREFUSED 等）带出来。 */
function describeError(error) {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause
  let detail = ''
  if (cause instanceof Error) detail = cause.message || String(cause.code ?? '')
  else if (cause && typeof cause === 'object') detail = String(cause.message ?? cause.code ?? '')
  else if (cause) detail = String(cause)
  return detail && detail !== error.message ? `${error.message}（${detail}）` : error.message
}

/** DeepSeek usage → 宿主 TokenUsage（inputTokens 只算未命中缓存的输入）。 */
function mapUsage(raw) {
  const prompt = Number(raw?.prompt_tokens) || 0
  const cacheRead = Number(raw?.prompt_cache_hit_tokens) || 0
  const cacheMiss = Number(raw?.prompt_cache_miss_tokens)
  const usage = {
    inputTokens: Number.isFinite(cacheMiss) ? Math.max(0, cacheMiss) : Math.max(0, prompt - cacheRead),
    outputTokens: Number(raw?.completion_tokens) || 0,
  }
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead
  return usage
}

/** 三段式假答案：形状与 recipe v2 要求一致（末尾带 terms trailer），便于 grep 验证。 */
const FAKE_EXPLAIN_BODY = [
  '### 1. 中译',
  '我们提出 Transformer，一种完全基于注意力机制的模型架构（architecture），彻底摒弃了循环（recurrence）与卷积（convolution）。',
  '',
  '### 2. 难点',
  '- 术语：recurrence 指按时间步递推的循环结构；eschewing 意为「刻意避开」。',
  '- 句法：主句 we propose the Transformer，后接同位语 a model architecture，再跟两个并列的分词短语作定语。',
  '',
  '### 3. 在论证中的位置',
  '这句是全文的立论句：先指出此前最优模型仍依赖循环或卷积，再给出本工作的替代方案，为后文的编码器/解码器结构做铺垫。',
].join('\n')
const FAKE_EXPLAIN_ANSWER = `${FAKE_EXPLAIN_BODY}\n<!--terms:{"terms":[{"term":"recurrence","zh":"循环","note":"按时间步递推的序列建模结构"},{"term":"eschewing","zh":"避开","note":"刻意不使用某种结构"}]}-->`

/** 整段翻译假答案：纯译文（无三段式、无解说）。 */
const FAKE_TRANSLATE_ANSWER = '我们提出 Transformer，一种完全基于注意力机制的模型架构，彻底摒弃了循环与卷积。在序列建模与转导问题（如语言建模和机器翻译）中，循环神经网络、长短期记忆网络与门控循环神经网络一直被视为最优方法。'

/** 框选区域假答案：三段式，模拟公式/图区域解释。 */
const FAKE_REGION_ANSWER = [
  '### 1. 这是什么',
  '这是缩放点积注意力（scaled dot-product attention）的计算公式，对应论文第 4 页的公式 (1)。',
  '',
  '### 2. 符号与含义',
  '- Q、K、V：查询（query）、键（key）、值（value）矩阵。',
  '- dk：键向量的维度，用于缩放点积，避免内积过大导致 softmax 梯度消失。',
  '',
  '### 3. 与上下文的关系',
  '公式定义了注意力权重的计算方式，紧接其后的段落解释了为什么除以 √dk、以及常见的加性注意力与点积注意力有何差异。',
].join('\n')

/** 假 llm 桩：按固定答案切片产出 text-delta，最后 usage + finish(stop)。 */
function makeFakeLlm() {
  return {
    stream(options) {
      llmCalls += 1
      const call = llmCalls
      const userText = userTextOf(options)
      const system = String(options?.system ?? '')
      const kind = system.includes('框选') ? 'region' : system.includes('学术翻译') ? 'translate' : 'explain'
      const answer = kind === 'region' ? FAKE_REGION_ANSWER : kind === 'translate' ? FAKE_TRANSLATE_ANSWER : FAKE_EXPLAIN_ANSWER
      // 选句里带 FAIL-LLM 时模拟模型失败，用来验证 SSE error 事件（不写缓存）
      const failing = kind === 'explain' && /FAIL-LLM/i.test(userText)
      console.log(`[serve] LLM 调用 #${call}（假桩/${kind}）model=${options?.model} temperature=${options?.temperature} maxTokens=${options?.maxTokens} 位置=${locationOf(userText)}${failing ? ' [模拟失败]' : ''}`)
      return (async function* generate() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        if (failing) {
          yield { type: 'text-delta', index: 0, text: '半截回答（不会写入缓存）' }
          yield finishError('模拟模型失败：未配置 provider（serve.mjs 触发）', 'SIMULATED')
          return
        }
        for (let at = 0; at < answer.length; at += 6) {
          await new Promise(resolve => setTimeout(resolve, 15))
          yield { type: 'text-delta', index: 0, text: answer.slice(at, at + 6) }
        }
        yield { type: 'usage', usage: { inputTokens: 512, outputTokens: 128 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/**
 * 真实 llm：fetch DeepSeek chat/completions（stream:true），把 SSE delta 映射成宿主 chunk。
 * 关闭 thinking：实测 deepseek-v4-flash 默认会先产出 reasoning，reasoning token 与正文
 * 共享 maxTokens，预览时容易拿不到正文；预览服务器固定 thinking:{type:'disabled'}。
 */
function makeRealLlm(apiKey) {
  return {
    stream(options) {
      llmCalls += 1
      const call = llmCalls
      const startedAt = Date.now()
      const userText = userTextOf(options)
      console.log(`[serve] LLM 调用 #${call}（真实）model=${options?.model} temperature=${options?.temperature} maxTokens=${options?.maxTokens} 位置=${locationOf(userText)}`)
      return (async function* generate() {
        const controller = new AbortController()
        let timedOut = false
        let externallyAborted = false
        const timer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, LLM_TIMEOUT_MS)
        const externalSignal = options?.signal
        const onAbort = () => {
          externallyAborted = true
          controller.abort()
        }
        if (externalSignal) {
          if (externalSignal.aborted) onAbort()
          else externalSignal.addEventListener('abort', onAbort, { once: true })
        }

        let chunks = 0
        let chars = 0
        let usageRaw = null
        try {
          const messages = []
          if (typeof options?.system === 'string' && options.system) {
            messages.push({ role: 'system', content: options.system })
          }
          for (const message of options?.messages ?? []) {
            messages.push({ role: message.role, content: flattenMessage(message) })
          }
          const body = {
            model: options?.model,
            messages,
            stream: true,
            stream_options: { include_usage: true },
            thinking: { type: 'disabled' },
            ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options?.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
          }
          const response = await fetch(`${API_BASE_URL}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'text/event-stream',
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          if (!response.ok) {
            const detail = await response.text().catch(() => '')
            yield finishError(
              `DeepSeek HTTP ${response.status}${detail ? `：${detail.slice(0, 300)}` : ''}`,
              `http-${response.status}`,
            )
            return
          }

          const reader = response.body.getReader()
          const decoder = new TextDecoder()
          let buffer = ''
          let done = false
          while (!done) {
            const { value, done: streamDone } = await reader.read()
            if (streamDone) break
            buffer += decoder.decode(value, { stream: true })
            let newline = buffer.indexOf('\n')
            while (newline !== -1) {
              const line = buffer.slice(0, newline).trim()
              buffer = buffer.slice(newline + 1)
              newline = buffer.indexOf('\n')
              if (!line.startsWith('data:')) continue
              const data = line.slice(5).trim()
              if (data === '[DONE]') {
                done = true
                break
              }
              let payload
              try {
                payload = JSON.parse(data)
              } catch {
                continue
              }
              if (payload?.usage) {
                usageRaw = payload.usage
                yield { type: 'usage', usage: mapUsage(payload.usage) }
              }
              const delta = payload?.choices?.[0]?.delta?.content
              if (typeof delta === 'string' && delta) {
                chunks += 1
                chars += delta.length
                yield { type: 'text-delta', index: 0, text: delta }
              }
            }
          }

          if (!done && !timedOut && !externallyAborted) {
            yield finishError('SSE 流没有以 [DONE] 结束（可能被截断），未写入缓存', 'stream-truncated')
            return
          }
          if (timedOut) {
            yield finishError(`模型请求超时（${Math.round(LLM_TIMEOUT_MS / 1000)}s）`, 'timeout')
            return
          }
          if (externallyAborted) {
            yield finishError('模型请求被取消', 'aborted')
            return
          }
          const elapsed = Date.now() - startedAt
          if (usageRaw) {
            console.log(`[serve] LLM 调用 #${call} usage：${JSON.stringify(usageRaw)}`)
          }
          console.log(`[serve] LLM 调用 #${call} 完成：chunks=${chunks} chars=${chars} 耗时=${elapsed}ms`)
          yield { type: 'finish', reason: { kind: 'stop' } }
        } catch (error) {
          if (timedOut) {
            yield finishError(`模型请求超时（${Math.round(LLM_TIMEOUT_MS / 1000)}s）`, 'timeout')
          } else if (externallyAborted) {
            yield finishError('模型请求被取消', 'aborted')
          } else {
            yield finishError(`模型请求失败：${describeError(error)}`, 'network')
          }
        } finally {
          clearTimeout(timer)
          externalSignal?.removeEventListener?.('abort', onAbort)
        }
      })()
    },
  }
}

/** 解析 API key：环境变量优先，其次 DSH_HOME/.credentials.yaml 与 ~/.dsh/.credentials.yaml。 */
async function resolveApiKey() {
  const fromEnv = String(process.env.DEEPSEEK_API_KEY ?? '').trim()
  if (fromEnv) return { key: fromEnv, source: '环境变量 DEEPSEEK_API_KEY' }
  const candidates = []
  if (process.env.DSH_HOME) candidates.push(path.join(process.env.DSH_HOME, '.credentials.yaml'))
  candidates.push(path.join(os.homedir(), '.dsh', '.credentials.yaml'))
  for (const file of candidates) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    // 形如：  DEEPSEEK_API_KEY: sk-xxxxxxxx
    const match = /^\s*DEEPSEEK_API_KEY\s*:\s*['"]?([A-Za-z0-9_-]+)['"]?/m.exec(text)
    if (match) return { key: match[1], source: file }
  }
  return { key: null, source: null }
}

let llm
if (REAL_LLM) {
  const { key, source } = await resolveApiKey()
  if (!key) {
    console.error('[serve] REAL_LLM=1 但没有找到 DEEPSEEK_API_KEY：可设环境变量，或在 ~/.dsh/.credentials.yaml 里写 DEEPSEEK_API_KEY: sk-...')
    process.exit(1)
  }
  console.log(`[serve] 模式：真实模型（REAL_LLM=1），endpoint=${API_BASE_URL}，key 来源=${source}（长度 ${key.length}，不打印内容）`)
  llm = makeRealLlm(key)
} else {
  console.log('[serve] 模式：假 llm 桩（默认；真实模型请 REAL_LLM=1 node tests/serve.mjs）')
  llm = makeFakeLlm()
}

const tempHome = process.env.DSH_HOME ? null : await mkdtemp(path.join(os.tmpdir(), 'paper-reader-serve-'))
const env = { DSH_HOME: process.env.DSH_HOME || tempHome }
const ctx = {
  llm,
  webServer: { register: () => () => {} },
  effect: fn => fn(),
}

const app = createApp({ ctx, config: {}, env })
const probe = await app.ready
console.log(`[serve] python=${probe.ok} fitz=${probe.fitz} error=${probe.error ?? '无'}`)

const server = createServer((req, res) => {
  app.handle(req, res).catch(error => {
    console.error('[serve] handler 异常:', error)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ ok: false, error: { code: 'internal', message: String(error?.message ?? error) } }))
    } else {
      res.destroy()
    }
  })
})

server.listen(PORT, HOST, () => {
  console.log(`[serve] 数据目录：${path.join(env.DSH_HOME, 'plugin-data', 'paper-reader')}`)
  console.log(`[serve] 监听：http://${HOST}:${PORT}/dsh-paper-reader/api/health`)
  console.log(`preview: http://${HOST}:${PORT}/dsh-paper-reader/app/`)
})

server.on('error', error => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`[serve] 端口 ${PORT} 已被占用，请换一个：PORT=<其他端口> node tests/serve.mjs`)
  } else {
    console.error('[serve] HTTP 服务启动失败:', error)
  }
  process.exit(1)
})

async function shutdown() {
  console.log('[serve] 关闭…')
  server.close()
  if (tempHome) await rm(tempHome, { recursive: true, force: true }).catch(() => {})
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
