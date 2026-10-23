/**
 * P1 测试：整篇结构化摘要。
 * 覆盖源材料拼装（长度/截断/兜底）、summary 缓存键、SSE 形状、
 * cached 零调用、force supersedes、失败不落盘、GET /summary 空/有值、
 * summary 不参与术语、重新抽取后 miss。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

import { createApp } from '../index.js'
import { SUMMARY_MATERIAL_LIMITS, buildSummaryMaterial } from '../explain.js'
import {
  docPaths,
  latestSummary,
  readJson,
  sha1,
  sha256,
  summaryKey,
  writeJsonAtomic,
} from '../store.js'

const FIXTURE = process.env.PR_FIXTURE || path.join(HERE, 'fixtures', '1706.03762v7.pdf')
const HAS_FIXTURE = existsSync(FIXTURE)
const SKIP_NO_FIXTURE = HAS_FIXTURE ? {} : { skip: '缺少夹具 PDF：把 1706.03762v7.pdf 放到 tests/fixtures/ 或设置 PR_FIXTURE' }
const PREFIX = '/dsh-paper-reader'
const DOC_ID = 'a1b2c3d4e5f60718'

const SUMMARY_ANSWER = [
  '## 一句话结论',
  '值得细读：用纯注意力替代循环/卷积，是序列建模的范式转折，方法可迁移到量化序列任务。',
  '## 研究问题',
  '- 如何在不用循环和卷积的前提下做序列转导？',
  '- 注意力机制能否在翻译质量与并行度上同时占优？',
  '## 数据与样本',
  '- WMT 2014 英德（约 450 万句对）与英法（约 3600 万句对）。',
  '- 英文成分句法分析（WSJ）。',
  '## 方法',
  '- 6 层编码器/解码器 + 多头自注意力 + 逐位置前馈网络。',
  '- 正弦位置编码，Adam + warmup 训练。',
  '## 主要结论',
  '- 英德 BLEU 28.4、英法 BLEU 41.8，超过此前最优。',
  '- 训练成本显著低于循环/卷积模型。',
  '## 局限与存疑',
  '- 长序列注意力复杂度 O(n^2)，作者列为未来工作。',
  '- 论文中未明确小数据场景下的稳健性。',
].join('\n')

function mockReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const buffer = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body))
  const stream = Readable.from(buffer ? [buffer] : [])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:18083', ...headers }
  return stream
}

function mockRes() {
  const chunks = []
  let ended = false
  const res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    writeHead(status, headers) {
      res.statusCode = status
      res.headersSent = true
      for (const [key, value] of Object.entries(headers ?? {})) res.headers[key.toLowerCase()] = value
      return res
    },
    write(chunk) {
      if (chunk !== null && chunk !== undefined) chunks.push(Buffer.from(chunk))
      return true
    },
    end(chunk) {
      if (chunk !== null && chunk !== undefined) chunks.push(Buffer.from(chunk))
      ended = true
      return res
    },
    on() { return res },
    once() { return res },
    removeListener() { return res },
    get writableEnded() { return ended },
  }
  Object.defineProperty(res, 'body', { get: () => Buffer.concat(chunks) })
  return res
}

function json(res) {
  return JSON.parse(res.body.toString('utf8'))
}

function parseSse(res) {
  return res.body
    .toString('utf8')
    .split('\n\n')
    .map(block => block.trim())
    .filter(Boolean)
    .map((block) => {
      assert.ok(block.startsWith('data: '), `SSE 事件应以 data: 开头：${block.slice(0, 40)}`)
      return JSON.parse(block.slice('data: '.length))
    })
}

function makeLlm() {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      const system = String(options?.system ?? '')
      const answer = system.includes('一句话结论') ? SUMMARY_ANSWER : '## 一句话结论\n其他链路答案'
      return (async function* generate() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        for (let at = 0; at < answer.length; at += 11) {
          yield { type: 'text-delta', index: 0, text: answer.slice(at, at + 11) }
        }
        yield { type: 'usage', usage: { inputTokens: 3000, outputTokens: 500 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

function makeFailingLlm() {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* generate() {
        yield { type: 'text-delta', index: 0, text: '## 一句话结论\n半截' }
        yield { type: 'finish', reason: { kind: 'error', failure: { message: '模拟摘要失败', code: 'SIMULATED' } } }
      })()
    },
  }
}

const baseCtx = llm => ({
  llm,
  webServer: { register: () => () => {} },
  effect: fn => fn(),
})

async function call(app, init) {
  const res = mockRes()
  await app.handle(mockReq(init), res)
  return res
}

function summarize(app, docId, force = false) {
  return call(app, {
    method: 'POST',
    url: `${PREFIX}/api/summarize`,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId, force }),
  })
}

// ---------------------------------------------------------------------------
// 源材料拼装 & 缓存键（纯函数）
// ---------------------------------------------------------------------------

describe('摘要源材料拼装', () => {
  function syntheticStructure() {
    const title = 'Attention Is All You Need'
    const paras = [
      { id: 'p1', page: 1, text: 'Abstract', sectionId: 's1', sent: [] },
      { id: 'p2', page: 1, text: `摘要正文：${'A'.repeat(2000)}`, sectionId: 's1', sent: [] },
    ]
    const sections = [{ id: 's1', title, level: 1, page: 1, paraIds: ['p1', 'p2'] }]
    for (let index = 0; index < 20; index += 1) {
      const sectionId = `s${index + 2}`
      const paraId = `p${index + 3}`
      sections.push({ id: sectionId, title: `Section ${index + 1}`, level: 1, page: index + 2, paraIds: [paraId] })
      paras.push({
        id: paraId,
        page: index + 2,
        sectionId,
        text: `第 ${index + 1} 节首段：${'x'.repeat(600)}`,
        sent: [],
      })
    }
    return { title, paras, sections }
  }

  it('包含标题/摘要/目录/每节首段；总长 ≤6000、每节首段 ≤300、最多 12 节', () => {
    const material = buildSummaryMaterial(syntheticStructure())
    assert.ok(material.length <= SUMMARY_MATERIAL_LIMITS.total, `material=${material.length}`)
    assert.ok(material.includes('Attention Is All You Need'))
    assert.ok(material.includes('## 摘要 / 首页正文'))
    assert.ok(material.includes('## 目录'))
    assert.ok(material.includes('- Section 1'))
    assert.ok(material.includes('## 各节首段'))
    // 摘要截断到 1200 字：不出现 1201 个连续 A
    assert.equal(material.includes('A'.repeat(1201)), false)
    // 每节首段截断到 300 字：不出现 301 个连续 x
    assert.equal(material.includes('x'.repeat(301)), false)
    assert.ok(material.includes('x'.repeat(200)), '每节首段应被纳入材料')
    // 目录/首段最多 12 节（标题行 "### " 数量 ≤ 12）
    const headings = material.match(/^### /gm) ?? []
    assert.ok(headings.length <= 12, `节首段数量 ${headings.length}`)
    assert.ok(headings.length >= 1)
  })

  it('没有 Abstract 标题时用第 1 页最长正文段兜底', () => {
    const structure = {
      title: 'T',
      paras: [
        { id: 'p1', page: 1, text: '短作者信息', sectionId: 's1' },
        { id: 'p2', page: 1, text: 'B'.repeat(500), sectionId: 's1' },
        { id: 'p3', page: 2, text: 'C'.repeat(900), sectionId: 's2' },
      ],
      sections: [
        { id: 's1', title: 'T', level: 1, page: 1, paraIds: ['p1', 'p2'] },
        { id: 's2', title: 'Body', level: 1, page: 2, paraIds: ['p3'] },
      ],
    }
    const material = buildSummaryMaterial(structure)
    assert.ok(material.includes('B'.repeat(400)), '应取第 1 页最长正文段作为摘要')
    assert.equal(material.includes('C'.repeat(400)), false, '不应跨页取摘要')
  })
})

describe('summary 缓存键与最新条目', () => {
  it('summaryKey 与契约公式一致，源材料不变则稳定', () => {
    const key = summaryKey(DOC_ID, 'material-a')
    assert.match(key, /^[0-9a-f]{64}$/)
    assert.equal(key, sha256(`${DOC_ID}|summary-v1|${sha1('material-a')}`))
    assert.equal(key, summaryKey(DOC_ID, 'material-a'))
    assert.notEqual(key, summaryKey(DOC_ID, 'material-b'))
    assert.notEqual(key, summaryKey('ffffffffffffffff', 'material-a'))
  })

  it('latestSummary：只认 kind=summary，没有则 null', () => {
    const entries = [
      { id: 'e_2', kind: 'summary', createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 'e_1', kind: 'summary', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'e_0', kind: 'explain', createdAt: '2026-01-03T00:00:00.000Z' },
      { id: 'old', recipe: 'v1', createdAt: '2026-01-04T00:00:00.000Z' },
    ]
    assert.equal(latestSummary(entries).id, 'e_2')
    assert.equal(latestSummary([]), null)
    assert.equal(latestSummary([{ id: 'x', kind: 'explain' }]), null)
  })
})

// ---------------------------------------------------------------------------
// 路由（真实抽取 + 假 llm）
// ---------------------------------------------------------------------------

describe('P1 结构化摘要（真实抽取 + 假 llm）', SKIP_NO_FIXTURE, () => {
  let home
  let env
  let app
  let llm
  let doc
  let structure

  before(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'pr-p1-'))
    env = { DSH_HOME: home }
    const staticDir = path.join(home, 'app')
    await mkdir(staticDir, { recursive: true })
    await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>p1</title>', 'utf8')
    llm = makeLlm()
    app = createApp({ ctx: baseCtx(llm), config: { pythonPath: 'python3', appDir: staticDir }, env })
    await app.ready
    const fixture = await readFile(FIXTURE)
    const uploaded = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/docs`,
      headers: { 'content-type': 'application/pdf' },
      body: fixture,
    })
    assert.equal(uploaded.statusCode, 200)
    doc = json(uploaded).doc
    structure = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/structure` }))
  })

  after(async () => {
    if (home) await rm(home, { recursive: true, force: true })
  })

  it('GET /summary：还没生成时返回 {entry:null}', async () => {
    const res = await call(app, { url: `${PREFIX}/api/docs/${doc.id}/summary` })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(json(res), { entry: null })
  })

  it('POST /api/summarize：SSE 六节输出、entry 字段符合契约、不写术语', async () => {
    const before = llm.calls.length
    const res = await summarize(app, doc.id)
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /text\/event-stream/)
    const events = parseSse(res)
    assert.equal(events[0].type, 'meta')
    assert.equal(events[0].kind, 'summary')
    assert.equal(events[0].cached, false)
    assert.match(events[0].id, /^e_[0-9a-f]{16}$/)
    assert.match(events[0].key, /^[0-9a-f]{64}$/)

    const deltas = events.filter(event => event.type === 'delta')
    assert.ok(deltas.length > 1)
    assert.equal(deltas.map(event => event.text).join(''), SUMMARY_ANSWER)
    // 六节齐全
    for (const heading of ['## 一句话结论', '## 研究问题', '## 数据与样本', '## 方法', '## 主要结论', '## 局限与存疑']) {
      assert.ok(deltas.map(event => event.text).join('').includes(heading), `缺少 ${heading}`)
    }

    const done = events.at(-1)
    assert.equal(done.type, 'done')
    const entry = done.entry
    assert.equal(entry.kind, 'summary')
    assert.equal(entry.recipe, 'summary-v1')
    assert.equal(entry.page, 1)
    assert.equal(entry.paraId, '')
    assert.equal(entry.selText, '')
    assert.equal(entry.answer, SUMMARY_ANSWER)
    assert.equal(entry.supersedes, null)
    assert.equal(entry.hitCount, 0)
    assert.match(entry.contextHash, /^[0-9a-f]{64}$/)

    assert.equal(llm.calls.length, before + 1)
    const request = llm.calls.at(-1)
    assert.match(request.system, /## 一句话结论/)
    assert.match(request.system, /## 局限与存疑/)
    assert.match(request.system, /不要引入材料之外的文献/)
    const userText = request.messages[0].content[0].text
    assert.equal(userText.length <= 6000, true, `源材料 ${userText.length} 字超过 6000`)
    assert.ok(userText.includes('Attention Is All You Need'))
    for (const marker of ['## 摘要 / 首页正文', '## 目录', '## 各节首段']) {
      assert.ok(userText.includes(marker), `源材料缺少 ${marker}`)
    }

    // summary 不参与术语表
    const terms = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/terms` }))
    assert.deepEqual(terms, { terms: [] })

    // 历史里 kind=summary；index=1 不带 sent（不参与原文标记）
    const explanations = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/explanations` }))
    const saved = explanations.entries.find(item => item.id === entry.id)
    assert.equal(saved.kind, 'summary')
    const index = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/explanations?index=1` })).index
    const projected = index.find(item => item.id === entry.id)
    assert.equal(projected.kind, 'summary')
    assert.equal('sent' in projected, false)
  })

  it('GET /summary：返回最新 summary 条目（kind/recipe/answer）', async () => {
    const res = await call(app, { url: `${PREFIX}/api/docs/${doc.id}/summary` })
    assert.equal(res.statusCode, 200)
    const entry = json(res).entry
    assert.ok(entry)
    assert.equal(entry.kind, 'summary')
    assert.equal(entry.recipe, 'summary-v1')
    assert.equal(entry.page, 1)
    assert.equal(entry.answer, SUMMARY_ANSWER)
    assert.ok(entry.answer.length > 100)
  })

  it('第二次 POST：命中缓存 → 只 meta(cached)+done，hitCount+1，零模型调用', async () => {
    const before = llm.calls.length
    const started = Date.now()
    const events = parseSse(await summarize(app, doc.id))
    const elapsed = Date.now() - started
    assert.deepEqual(events.map(event => event.type), ['meta', 'done'])
    assert.equal(events[0].cached, true)
    assert.equal(events[0].kind, 'summary')
    assert.equal(events[0].hitCount, 1)
    assert.equal(events[1].entry.hitCount, 1)
    assert.equal(events[1].entry.answer, SUMMARY_ANSWER)
    assert.equal(llm.calls.length, before, '缓存命中不得调模型')
    assert.ok(elapsed < 1000, `缓存回放耗时 ${elapsed}ms`)
  })

  it('force:true：新增条目并 supersedes 同 key 最新', async () => {
    const before = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/summary` })).entry
    const events = parseSse(await summarize(app, doc.id, true))
    assert.equal(events[0].cached, false)
    const entry = events.at(-1).entry
    assert.equal(entry.supersedes, before.id)
    assert.notEqual(entry.id, before.id)
    const latest = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/summary` })).entry
    assert.equal(latest.id, entry.id)
  })

  it('模型失败：SSE error 且不落盘', async () => {
    const failing = makeFailingLlm()
    const badApp = createApp({ ctx: baseCtx(failing), config: { pythonPath: 'python3' }, env })
    await badApp.ready
    const before = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/summary` })).entry
    const events = parseSse(await summarize(badApp, doc.id, true))
    assert.equal(events[0].type, 'meta')
    assert.equal(events[0].cached, false)
    assert.equal(events.at(-1).type, 'error')
    assert.equal(events.at(-1).code, 'llm-failed')
    assert.match(events.at(-1).message, /模拟摘要失败/)
    const after = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/summary` })).entry
    assert.equal(after.id, before.id, '失败不得覆盖/新增 summary')
  })

  it('重新抽取（源材料变化）后 miss；老数据兼容返回 entry:null', async () => {
    const legacyId = 'dddddddddddddddd'
    await writeJsonAtomic(docPaths(legacyId, env).structure, {
      version: 1,
      id: legacyId,
      title: 'Legacy Paper',
      pageCount: 1,
      pages: [{ n: 1, w: 612, h: 792, hasText: false }],
      sections: [],
      paras: [],
    })
    const legacy = await call(app, { url: `${PREFIX}/api/docs/${legacyId}/summary` })
    assert.equal(legacy.statusCode, 200)
    assert.deepEqual(json(legacy), { entry: null })

    // 模拟重新抽取：改论文标题（标题在源材料里）→ 源材料变化 → 缓存键变化 → miss
    const structurePath = docPaths(doc.id, env).structure
    const current = await readJson(structurePath, null)
    current.title = `${current.title}（重新抽取标记）`
    await writeJsonAtomic(structurePath, current)
    const before = llm.calls.length
    const events = parseSse(await summarize(app, doc.id))
    assert.equal(events[0].cached, false, '源材料变化后应 miss')
    assert.equal(llm.calls.length, before + 1)
    assert.equal(events.at(-1).type, 'done')
    const latest = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/summary` })).entry
    assert.equal(latest.id, events.at(-1).entry.id)
  })

  it('参数错误：缺 docId → 400；未知文档 → 404', async () => {
    const missing = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/summarize`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(missing.statusCode, 400)
    assert.equal(json(missing).error.code, 'bad-request')

    const ghost = await summarize(app, 'ffffffffffffffff')
    assert.equal(ghost.statusCode, 404)
    assert.equal(json(ghost).error.code, 'not-found')

    const ghostGet = await call(app, { url: `${PREFIX}/api/docs/ffffffffffffffff/summary` })
    assert.equal(ghostGet.statusCode, 404)
  })
})
