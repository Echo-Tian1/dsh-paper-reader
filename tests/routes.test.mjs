/**
 * 宿主 HTTP 路由的契约测试。
 *
 * 不依赖真实 DSH：用假的 ctx（webServer.register / llm.stream）+ 内存 req/res 直调 handler。
 * 上传与抽取走真实 python3 + 夹具 PDF；explain 用假 llm 桩验证 SSE 事件形状。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'

import { apply, createApp } from '../index.js'

const FIXTURE = '/Users/echo/Downloads/1706.03762v7.pdf'
const ANSWER = '### 1. 中译\n这是译文。\n### 2. 难点\n- 术语：attention\n### 3. 在论证中的位置\n承上启下。'
const PREFIX = '/dsh-paper-reader'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function mockReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const buffer = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body))
  const stream = Readable.from(buffer ? [buffer] : [])
  stream.method = method
  stream.url = url
  stream.headers = { host: '127.0.0.1:18080', ...headers }
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
  const text = res.body.toString('utf8')
  return text
    .split('\n\n')
    .map(block => block.trim())
    .filter(Boolean)
    .map((block) => {
      assert.ok(block.startsWith('data: '), `SSE 事件必须以 data: 开头：${block.slice(0, 40)}`)
      return JSON.parse(block.slice('data: '.length))
    })
}

function fakeCtx(llm) {
  const routes = []
  return {
    routes,
    llm,
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
  }
}

function makeLlm(answer = ANSWER) {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* generate() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        for (let at = 0; at < answer.length; at += 7) {
          yield { type: 'text-delta', index: 0, text: answer.slice(at, at + 7) }
        }
        yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 40 } }
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
        yield { type: 'text-delta', index: 0, text: '半截回答' }
        yield { type: 'finish', reason: { kind: 'error', failure: { message: '模型未配置', code: 'NO_ADAPTER' } } }
      })()
    },
  }
}

async function call(app, init) {
  const res = mockRes()
  await app.handle(mockReq(init), res)
  return res
}

describe('宿主路由（真实抽取 + 假 llm）', () => {
  let home
  let env
  let staticDir
  let llm
  let app
  let fixture
  let doc
  let structure
  let sel

  before(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'pr-routes-'))
    env = { DSH_HOME: home }
    staticDir = path.join(home, 'app')
    await mkdir(staticDir, { recursive: true })
    await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>文献阅读坞</title>', 'utf8')
    await writeFile(path.join(staticDir, 'app.js'), 'console.log("app")', 'utf8')
    await writeFile(path.join(staticDir, 'styles.css'), 'body{}', 'utf8')
    fixture = await readFile(FIXTURE)
    llm = makeLlm()
    app = createApp({
      ctx: fakeCtx(llm),
      config: { pythonPath: 'python3', appDir: staticDir, provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      env,
    })
    await app.ready
    const res = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/docs`,
      headers: { 'content-type': 'application/pdf' },
      body: fixture,
    })
    const body = json(res)
    assert.equal(res.statusCode, 200, JSON.stringify(body))
    assert.equal(body.ok, true)
    assert.equal(body.reused, false)
    doc = body.doc
    const structureRes = await call(app, { url: `${PREFIX}/api/docs/${doc.id}/structure` })
    assert.equal(structureRes.statusCode, 200)
    structure = json(structureRes)
    const para = structure.paras.find(item => item.text.length > 40 && item.sent.length > 0)
    assert.ok(para, '夹具里应有可解释的段落')
    const range = para.sent[0]
    sel = { page: para.page, paraId: para.id, text: para.text.slice(range[0], range[1]) }
  })

  after(async () => {
    if (home) await rm(home, { recursive: true, force: true })
  })

  it('GET /api/health 返回 python/fitz/provider/model/storeDir', async () => {
    const res = await call(app, { url: `${PREFIX}/api/health` })
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /application\/json/)
    const body = json(res)
    assert.equal(body.ok, true)
    assert.equal(body.python, true)
    assert.match(String(body.fitz), /^1\.\d+/)
    assert.equal(body.provider, 'deepseek-official')
    assert.equal(body.model, 'deepseek-v4-flash')
    assert.equal(body.storeDir, path.join(home, 'plugin-data', 'paper-reader'))
  })

  it('POST /api/docs 上传原始字节：id 为 sha256 前 16 位，doc 字段齐全', async () => {
    assert.match(doc.id, /^[0-9a-f]{16}$/)
    assert.equal(doc.pageCount, 15)
    assert.ok(doc.title.includes('Attention'))
    assert.equal(doc.lastPage, 1)
    assert.equal(doc.explained, 0)
    for (const key of ['addedAt', 'lastOpenedAt']) assert.ok(!Number.isNaN(Date.parse(doc[key])), `${key}=${doc[key]}`)
  })

  it('POST /api/docs 相同 PDF 返回 reused:true，不重复抽取', async () => {
    const started = Date.now()
    const res = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/docs`,
      headers: { 'content-type': 'application/pdf' },
      body: fixture,
    })
    const body = json(res)
    assert.equal(res.statusCode, 200)
    assert.equal(body.reused, true)
    assert.equal(body.doc.id, doc.id)
    assert.ok(Date.now() - started < 2000, '复用时不应再跑抽取')
  })

  it('POST /api/docs 支持 JSON 路径上传（绝对路径 / .pdf / 存在）', async () => {
    const res = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/docs`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: FIXTURE }),
    })
    const body = json(res)
    assert.equal(res.statusCode, 200)
    assert.equal(body.reused, true)
    assert.equal(body.doc.id, doc.id)
  })

  it('POST /api/docs 拒绝非 PDF 魔数、非法路径', async () => {
    const notPdf = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/docs`,
      headers: { 'content-type': 'application/pdf' },
      body: 'hello, not a pdf',
    })
    assert.equal(notPdf.statusCode, 400)
    assert.equal(json(notPdf).error.code, 'not-pdf')
    assert.ok(json(notPdf).error.message.length > 0)

    for (const badPath of ['relative/file.pdf', '/tmp/definitely-missing-pr.pdf']) {
      const res = await call(app, {
        method: 'POST',
        url: `${PREFIX}/api/docs`,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: badPath }),
      })
      assert.equal(res.statusCode, 400, badPath)
      assert.equal(json(res).error.code, 'bad-path')
    }
  })

  it('GET /api/docs 返回文档列表与 ui.lastDocId', async () => {
    const res = await call(app, { url: `${PREFIX}/api/docs` })
    const body = json(res)
    assert.equal(res.statusCode, 200)
    assert.equal(body.docs.length, 1)
    assert.equal(body.docs[0].id, doc.id)
    assert.equal(body.ui.lastDocId, doc.id)
  })

  it('GET /api/docs/<id>/structure 结构完整', async () => {
    assert.equal(structure.version, 1)
    assert.equal(structure.id, doc.id)
    assert.equal(structure.pageCount, 15)
    assert.equal(structure.pages.length, 15)
    assert.ok(structure.sections.length >= 20)
    assert.ok(structure.paras.length > 0)
    assert.ok(structure.paras.every(para => Array.isArray(para.sent) && para.sent.length > 0))
  })

  it('GET /api/docs/<id>/pages/<n> 返回逐词坐标与 paraId', async () => {
    const res = await call(app, { url: `${PREFIX}/api/docs/${doc.id}/pages/1` })
    const body = json(res)
    assert.equal(res.statusCode, 200)
    assert.equal(body.n, 1)
    assert.ok(body.columns === 'one' || body.columns === 'two')
    assert.ok(body.words.length > 0)
    const paraIds = new Set(structure.paras.filter(para => para.page === 1).map(para => para.id))
    for (const word of body.words.slice(0, 200)) {
      assert.equal(word.length, 6)
      if (paraIds.size > 0) assert.ok(paraIds.has(word[5]) || word[5] === '', `paraId=${word[5]}`)
    }
  })

  it('GET /media/<id>/page-<n>.png 返回 PNG 并带 1 小时缓存头', async () => {
    const res = await call(app, { url: `${PREFIX}/media/${doc.id}/page-1.png` })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'image/png')
    assert.equal(res.headers['cache-control'], 'max-age=3600')
    assert.ok(res.body.length > 20 * 1024)
    assert.deepEqual([...res.body.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  })

  it('GET /api/docs/<id>/explanations：全量与 index=1 精简版', async () => {
    const res = await call(app, { url: `${PREFIX}/api/docs/${doc.id}/explanations` })
    assert.deepEqual(json(res), { entries: [] })
    const indexRes = await call(app, { url: `${PREFIX}/api/docs/${doc.id}/explanations?index=1` })
    assert.deepEqual(json(indexRes), { index: [] })
  })

  it('POST /api/explain 首次：meta(cached:false) → delta* → done，并落盘', async () => {
    const res = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/explain`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: doc.id, sel, force: false }),
    })
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /text\/event-stream/)
    const events = parseSse(res)
    assert.equal(events[0].type, 'meta')
    assert.equal(events[0].cached, false)
    assert.match(events[0].id, /^e_[0-9a-f]{16}$/)
    assert.match(events[0].key, /^[0-9a-f]{64}$/)
    const deltas = events.filter(event => event.type === 'delta')
    assert.ok(deltas.length > 1, '流式应有多个 delta 事件')
    assert.equal(deltas.map(event => event.text).join(''), ANSWER)
    const done = events.at(-1)
    assert.equal(done.type, 'done')
    assert.equal(done.entry.answer, ANSWER)
    assert.equal(done.entry.docId, doc.id)
    assert.equal(done.entry.page, sel.page)
    assert.equal(done.entry.paraId, sel.paraId)
    assert.equal(done.entry.recipe, 'v1')
    assert.equal(done.entry.provider, 'deepseek-official')
    assert.equal(done.entry.model, 'deepseek-v4-flash')
    assert.equal(done.entry.hitCount, 0)
    assert.equal(done.entry.lastHitAt, null)
    assert.equal(done.entry.supersedes, null)
    assert.match(done.entry.contextHash, /^[0-9a-f]{64}$/)
    // sent：按 paraId + 选句定位到的段内字符区间（客户端画「已解释」标记用）
    const para = structure.paras.find(item => item.id === sel.paraId)
    assert.deepEqual(done.entry.sent, para.sent[0])
    assert.equal(llm.calls.length, 1)
    assert.equal(llm.calls[0].provider, 'deepseek-official')
    assert.equal(llm.calls[0].model, 'deepseek-v4-flash')
    assert.equal(llm.calls[0].temperature, 0.3)
    assert.equal(llm.calls[0].maxTokens, 1600)
    assert.match(llm.calls[0].system, /学术论文阅读助教/)
    assert.match(llm.calls[0].system, /### 1\. 中译/)
    assert.equal(llm.calls[0].messages[0].role, 'user')
    assert.equal(llm.calls[0].messages[0].content[0].type, 'text')
    assert.match(llm.calls[0].messages[0].content[0].text, /论文：/)
    assert.match(llm.calls[0].messages[0].content[0].text, /选句：<<</)
    assert.match(llm.calls[0].messages[0].content[0].text, /所在段落：/)
    assert.match(llm.calls[0].messages[0].content[0].text, /前一段：/)
    assert.match(llm.calls[0].messages[0].content[0].text, /后一段：/)
  })

  it('相同句子第二次命中缓存：只发 meta(cached:true)+done，不再调模型', async () => {
    const messy = { ...sel, text: `  ${sel.text.replace(/ /g, '   ')}  ` }
    const res = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/explain`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: doc.id, sel: messy, force: false }),
    })
    const events = parseSse(res)
    assert.equal(events.length, 2)
    assert.equal(events[0].type, 'meta')
    assert.equal(events[0].cached, true)
    assert.equal(events[0].hitCount, 1)
    assert.equal(events[1].type, 'done')
    assert.equal(events[1].entry.hitCount, 1)
    assert.ok(events[1].entry.lastHitAt)
    const cachedPara = structure.paras.find(item => item.id === sel.paraId)
    assert.deepEqual(events[1].entry.sent, cachedPara.sent[0])
    assert.equal(llm.calls.length, 1, '缓存命中不得再调模型')
  })

  it('force:true 重新解释：新条目 supersedes，旧条目保留', async () => {
    const before = await call(app, { url: `${PREFIX}/api/docs/${doc.id}/explanations` })
    const oldId = json(before).entries[0].id
    const res = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/explain`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: doc.id, sel, force: true }),
    })
    const events = parseSse(res)
    assert.equal(events[0].cached, false)
    assert.equal(events.at(-1).entry.supersedes, oldId)
    assert.equal(llm.calls.length, 2)
    const after = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/explanations` }))
    assert.equal(after.entries.length, 2)
    assert.equal(after.entries[0].id, events.at(-1).entry.id)
  })

  it('GET explanations?index=1 精简索引字段符合契约（含 sent 区间）', async () => {
    const res = await call(app, { url: `${PREFIX}/api/docs/${doc.id}/explanations?index=1` })
    const body = json(res)
    assert.equal(body.index.length, 2)
    const sentRange = structure.paras.find(item => item.id === sel.paraId).sent[0]
    for (const item of body.index) {
      assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'hitCount', 'id', 'key', 'page', 'paraId', 'recipe', 'selText', 'sent'])
      assert.deepEqual(item.sent, sentRange)
    }
  })

  it('缺 sel.page 时按 paraId 反查页码；选句定位不到则不写 sent', async () => {
    const para = structure.paras.find(item => item.id === 'p17')
    assert.ok(para, '夹具应存在 p17')
    const res = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/explain`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: doc.id, sel: { paraId: para.id, text: '这段文字不在该段落里（用于验证定位失败）' } }),
    })
    const events = parseSse(res)
    const done = events.at(-1)
    assert.equal(done.type, 'done')
    // 调用方漏传 page：用 paraId 反查段落页码兜底，历史里不出现 undefined
    assert.equal(done.entry.page, para.page)
    // 定位不到（不在段落文本里）：不写可选字段 sent
    assert.equal('sent' in done.entry, false)
    const indexRes = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/explanations?index=1` }))
    const item = indexRes.index.find(entry => entry.id === done.entry.id)
    assert.ok(item)
    assert.equal('sent' in item, false)
  })

  it('模型失败：SSE error 事件且不落盘', async () => {
    const failing = makeFailingLlm()
    const badApp = createApp({ ctx: fakeCtx(failing), config: { pythonPath: 'python3', appDir: staticDir }, env })
    await badApp.ready
    const before = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/explanations` })).entries.length
    const res = await call(badApp, {
      method: 'POST',
      url: `${PREFIX}/api/explain`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: doc.id, sel: { ...sel, text: `${sel.text} 另起一句` } }),
    })
    const events = parseSse(res)
    assert.equal(events[0].type, 'meta')
    assert.equal(events.at(-1).type, 'error')
    assert.equal(events.at(-1).code, 'llm-failed')
    assert.match(events.at(-1).message, /模型未配置/)
    const after = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/explanations` })).entries.length
    assert.equal(after, before, '失败不得写缓存')
  })

  it('GET/POST /api/ui-state 读写与合并', async () => {
    const initial = json(await call(app, { url: `${PREFIX}/api/ui-state` }))
    assert.equal(initial.lastDocId, doc.id)
    assert.equal(typeof initial.perDoc, 'object')
    const post = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/ui-state`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ perDoc: { [doc.id]: { lastPage: 4, scrollTop: 300 } } }),
    })
    assert.equal(post.statusCode, 200)
    assert.deepEqual(json(post).perDoc[doc.id], { lastPage: 4, scrollTop: 300 })
    const after = json(await call(app, { url: `${PREFIX}/api/ui-state` }))
    assert.deepEqual(after.perDoc[doc.id], { lastPage: 4, scrollTop: 300 })
  })

  it('GET /app/* 静态页：正确 MIME、no-store、未知文件 404', async () => {
    const index = await call(app, { url: `${PREFIX}/app/` })
    assert.equal(index.statusCode, 200)
    assert.equal(index.headers['content-type'], 'text/html; charset=utf-8')
    assert.equal(index.headers['cache-control'], 'no-store')
    assert.match(index.body.toString('utf8'), /文献阅读坞/)

    const js = await call(app, { url: `${PREFIX}/app/app.js` })
    assert.equal(js.statusCode, 200)
    assert.equal(js.headers['content-type'], 'text/javascript; charset=utf-8')

    const css = await call(app, { url: `${PREFIX}/app/styles.css` })
    assert.equal(css.statusCode, 200)
    assert.equal(css.headers['content-type'], 'text/css; charset=utf-8')

    const missing = await call(app, { url: `${PREFIX}/app/nope.js` })
    assert.equal(missing.statusCode, 404)
  })

  it('未知文档 / 未知路由 / 非法方法', async () => {
    const ghost = 'ffffffffffffffff'
    for (const url of [
      `${PREFIX}/api/docs/${ghost}/structure`,
      `${PREFIX}/api/docs/${ghost}/pages/1`,
      `${PREFIX}/api/docs/${ghost}/explanations`,
      `${PREFIX}/media/${ghost}/page-1.png`,
    ]) {
      const res = await call(app, { url })
      assert.equal(res.statusCode, 404, url)
      assert.equal(json(res).error.code, 'not-found')
    }
    const unknown = await call(app, { url: `${PREFIX}/api/nope` })
    assert.equal(unknown.statusCode, 404)
    const wrongMethod = await call(app, { method: 'POST', url: `${PREFIX}/api/health` })
    assert.equal(wrongMethod.statusCode, 405)
  })
})

describe('宿主路由：不可用场景', () => {
  let home
  let env
  let fixture
  before(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'pr-routes-err-'))
    env = { DSH_HOME: home }
    fixture = await readFile(FIXTURE)
  })
  after(async () => {
    if (home) await rm(home, { recursive: true, force: true })
  })

  it('python 不可用：health python:false / fitz:null，上传 503 py-missing', async () => {
    const ctx = fakeCtx(makeLlm('x'))
    const app = createApp({ ctx, config: { pythonPath: '/nonexistent/python3-for-pr-test' }, env })
    await app.ready
    const health = json(await call(app, { url: `${PREFIX}/api/health` }))
    assert.equal(health.ok, true)
    assert.equal(health.python, false)
    assert.equal(health.fitz, null)
    const res = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/docs`,
      headers: { 'content-type': 'application/pdf' },
      body: fixture,
    })
    assert.equal(res.statusCode, 503)
    assert.equal(json(res).error.code, 'py-missing')
  })

  it('超过 maxUploadMB 返回 413 too-big', async () => {
    const app = createApp({ ctx: fakeCtx(makeLlm('x')), config: { pythonPath: 'python3', maxUploadMB: 0.1 }, env })
    await app.ready
    const res = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/docs`,
      headers: { 'content-type': 'application/pdf' },
      body: fixture,
    })
    assert.equal(res.statusCode, 413)
    assert.equal(json(res).error.code, 'too-big')
  })

  it('非法 JSON / 缺 docId 的 explain 请求返回 400', async () => {
    const app = createApp({ ctx: fakeCtx(makeLlm('x')), config: { pythonPath: 'python3' }, env })
    await app.ready
    const broken = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/explain`,
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    })
    assert.equal(broken.statusCode, 400)
    assert.equal(json(broken).error.code, 'bad-request')
    const missing = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/explain`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sel: { text: 'x' } }),
    })
    assert.equal(missing.statusCode, 400)
  })
})

describe('apply 与 DSH 装配', () => {
  it('注册唯一 prefix 路由 /dsh-paper-reader，health 可经该路由命中', async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'pr-apply-'))
    t.after(() => rm(home, { recursive: true, force: true }))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const ctx = fakeCtx(makeLlm('x'))
      apply(ctx, { pythonPath: 'python3' })
      assert.equal(ctx.routes.length, 1)
      assert.equal(ctx.routes[0].kind, 'prefix')
      assert.equal(ctx.routes[0].path, PREFIX)
      const res = mockRes()
      await ctx.routes[0].handler(mockReq({ url: `${PREFIX}/api/health` }), res)
      assert.equal(res.statusCode, 200)
      assert.equal(json(res).storeDir, path.join(home, 'plugin-data', 'paper-reader'))
      await sleep(1)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
