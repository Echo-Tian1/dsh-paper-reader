/**
 * P0 宿主半测试：链接抽取（真实夹具）、批注存储 CRUD/校验/并发、笔记导出、
 * 以及老文档（无 links.json / annotations.json）的兼容。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 夹具 PDF（arXiv:1706.03762v7）不随仓库分发：放到 tests/fixtures/ 或用 PR_FIXTURE 指定；
// 没有夹具时，依赖真实论文的用例自动 skip，其余用例照常跑。
const FIXTURE = process.env.PR_FIXTURE || path.join(HERE, 'fixtures', '1706.03762v7.pdf')
const HAS_FIXTURE = existsSync(FIXTURE)
const SKIP_NO_FIXTURE = HAS_FIXTURE ? {} : { skip: '缺少夹具 PDF：把 1706.03762v7.pdf 放到 tests/fixtures/ 或设置 PR_FIXTURE' }

import { createApp } from '../index.js'
import {
  appendExplanation,
  docPaths,
  linksPath,
  mergeTerms,
  writeJsonAtomic,
} from '../store.js'


const PREFIX = '/dsh-paper-reader'
const LEGACY_ID = 'eeeeeeeeeeeeeeee'

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

const fakeCtx = {
  llm: {
    stream() {
      throw new Error('p0 测试不应调用模型')
    },
  },
  webServer: { register: () => () => {} },
  effect: fn => fn(),
}

async function call(app, init) {
  const res = mockRes()
  await app.handle(mockReq(init), res)
  return res
}

function jsonPost(app, url, body) {
  return call(app, {
    method: 'POST',
    url,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('P0 宿主半（真实抽取 + 批注/笔记）', SKIP_NO_FIXTURE, () => {
  let home
  let env
  let app
  let doc
  let structure
  let links

  before(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'pr-p0-'))
    env = { DSH_HOME: home }
    const staticDir = path.join(home, 'app')
    await mkdir(staticDir, { recursive: true })
    await writeFile(path.join(staticDir, 'index.html'), '<!doctype html><title>p0</title>', 'utf8')
    app = createApp({ ctx: fakeCtx, config: { pythonPath: 'python3', appDir: staticDir }, env })
    await app.ready
    const fixture = await readFile(FIXTURE)
    const uploaded = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/docs`,
      headers: { 'content-type': 'application/pdf' },
      body: fixture,
    })
    const body = json(uploaded)
    assert.equal(uploaded.statusCode, 200, JSON.stringify(body))
    doc = body.doc
    structure = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/structure` }))
    links = JSON.parse(await readFile(linksPath(doc.id, env), 'utf8'))
  })

  after(async () => {
    if (home) await rm(home, { recursive: true, force: true })
  })

  it('links.json：113 条（goto 95 / uri 18），第 2 页 cite goto、第 4 页 figure.2', () => {
    assert.equal(links.version, 1)
    assert.equal(links.pages.length, 15)
    const all = links.pages.flatMap(page => page.links)
    const gotos = all.filter(link => link.kind === 'goto')
    const uris = all.filter(link => link.kind === 'uri')
    assert.equal(all.length, 113)
    assert.equal(gotos.length, 95)
    assert.equal(uris.length, 18)

    for (const link of all) {
      assert.equal(link.kind === 'goto' || link.kind === 'uri', true, `未知 kind：${link.kind}`)
      assert.equal(link.rect.length, 4)
      assert.ok(link.rect.every(value => Number.isFinite(value)))
      assert.equal(typeof link.text, 'string')
      assert.ok(link.text.length <= 120)
    }
    for (const link of gotos) {
      assert.ok(Number.isInteger(link.page) && link.page >= 1 && link.page <= 15, JSON.stringify(link))
      assert.equal('uri' in link, false)
    }
    for (const link of uris) {
      assert.match(link.uri, /^https?:\/\//)
      assert.equal('page' in link, false)
    }

    // 夹具第 2 页：30 条 goto 指向参考文献/章节；至少 3 条 named 以 cite. 开头、目标在第 10..12 页
    const page2 = links.pages.find(page => page.n === 2).links
    assert.equal(page2.length, 30)
    const citeGotos = page2.filter(link => link.kind === 'goto' && String(link.named ?? '').startsWith('cite.'))
    assert.ok(citeGotos.length >= 3, `第 2 页 cite goto 只有 ${citeGotos.length} 条`)
    for (const link of citeGotos.slice(0, 3)) {
      assert.ok(link.page >= 10 && link.page <= 12, `cite goto 目标页异常：${link.page}`)
      assert.ok(link.text.length > 0, 'cite goto 应能取到区域文字')
    }

    // 夹具第 4 页：指向 Figure 2 的 goto（0-based page 3 → 1-based 4，图 2 在第 4 页）
    const figure = links.pages.find(page => page.n === 4).links.find(link => link.named === 'figure.2')
    assert.ok(figure, '第 4 页应有 figure.2 链接')
    assert.equal(figure.kind, 'goto')
    assert.equal(figure.page, 4)
    assert.deepEqual(figure.rect.length, 4)

    // 同页按面积从大到小排序
    const page2Areas = page2.map(link => (link.rect[2] - link.rect[0]) * (link.rect[3] - link.rect[1]))
    for (let index = 1; index < page2Areas.length; index += 1) {
      assert.ok(page2Areas[index - 1] >= page2Areas[index] - 1e-6, '同页链接应按面积降序')
    }
  })

  it('GET /links：返回同构数据；老文档无 links.json → 空 pages 不报错（不重抽）', async () => {
    const res = await call(app, { url: `${PREFIX}/api/docs/${doc.id}/links` })
    assert.equal(res.statusCode, 200)
    assert.match(res.headers['content-type'], /application\/json/)
    const body = json(res)
    assert.equal(body.version, 1)
    assert.equal(body.pages.length, 15)
    assert.equal(body.pages.flatMap(page => page.links).length, 113)

    // 模拟老文档：只有 structure，没有 links.json
    await writeJsonAtomic(docPaths(LEGACY_ID, env).structure, {
      version: 1,
      id: LEGACY_ID,
      title: 'Legacy Paper',
      pageCount: 1,
      pages: [{ n: 1, w: 612, h: 792, hasText: false }],
      sections: [],
      paras: [],
    })
    const legacy = await call(app, { url: `${PREFIX}/api/docs/${LEGACY_ID}/links` })
    assert.equal(legacy.statusCode, 200)
    assert.deepEqual(json(legacy), { version: 1, pages: [] })

    const ghost = await call(app, { url: `${PREFIX}/api/docs/ffffffffffffffff/links` })
    assert.equal(ghost.statusCode, 404)
    assert.equal(json(ghost).error.code, 'not-found')
  })

  it('links 惰性回填：删除 links.json 后 /links 现场重建（backfilled:true），之后走文件缓存', async () => {
    const file = linksPath(doc.id, env)
    await rm(file, { force: true })
    const started = Date.now()
    const res = await call(app, { url: `${PREFIX}/api/docs/${doc.id}/links` })
    const elapsed = Date.now() - started
    assert.equal(res.statusCode, 200)
    const body = json(res)
    assert.equal(body.backfilled, true)
    assert.equal(body.version, 1)
    assert.equal(body.pages.length, 15)
    const gotos = body.pages.flatMap(page => page.links).filter(link => link.kind === 'goto')
    assert.equal(gotos.length, 95, '回填后 goto 条数应与整篇抽取一致')
    assert.equal(body.pages.flatMap(page => page.links).length, 113)

    // links.json 被重新写出、内容可用
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.version, 1)
    assert.equal(saved.pages.length, 15)
    const firstStat = await stat(file)
    assert.ok(firstStat.size > 1000)
    assert.ok(elapsed < 5000, `回填耗时 ${elapsed}ms 偏大`)
    console.log(`[p0] links 惰性回填耗时=${elapsed}ms，links.json=${firstStat.size}B，goto=95`)

    // 第二次请求：文件已存在 → 不再跑 python，也不重写文件
    await new Promise(resolve => setTimeout(resolve, 25))
    const second = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/links` }))
    assert.equal(second.backfilled, undefined, '缓存命中的响应不应带 backfilled')
    assert.equal(second.pages.flatMap(page => page.links).length, 113)
    const secondStat = await stat(file)
    assert.equal(secondStat.mtimeMs, firstStat.mtimeMs, '第二次请求不应重写 links.json（说明未跑 python）')
  })

  it('links 回填并发：两个请求同时到达只回填一次、不互相覆盖', async () => {
    const file = linksPath(doc.id, env)
    await rm(file, { force: true })
    const [left, right] = await Promise.all([
      call(app, { url: `${PREFIX}/api/docs/${doc.id}/links` }),
      call(app, { url: `${PREFIX}/api/docs/${doc.id}/links` }),
    ])
    for (const res of [left, right]) {
      assert.equal(res.statusCode, 200)
      const body = json(res)
      assert.equal(body.pages.length, 15)
      assert.equal(body.pages.flatMap(page => page.links).length, 113)
    }
    const saved = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(saved.pages.length, 15, '并发回填后 links.json 必须是完整结果')
    const backfilledCount = [left, right].filter(res => json(res).backfilled === true).length
    assert.ok(backfilledCount >= 1, '至少一个请求应触发回填')
  })

  it('links 回填失败：200 + warning（不 500），恢复后仍可回填', async () => {
    const badApp = createApp({
      ctx: fakeCtx,
      config: { pythonPath: '/nonexistent/python3-for-links', appDir: path.join(home, 'app') },
      env,
    })
    await badApp.ready
    const file = linksPath(doc.id, env)
    await rm(file, { force: true })
    const res = await call(badApp, { url: `${PREFIX}/api/docs/${doc.id}/links` })
    assert.equal(res.statusCode, 200, '回填失败不应 500')
    const body = json(res)
    assert.equal(body.version, 1)
    assert.deepEqual(body.pages, [])
    assert.match(body.warning, /回填失败/)

    // 正常 app 再请求一次 → 回填成功，恢复后续测试前提
    const restored = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/links` }))
    assert.equal(restored.backfilled, true)
    assert.equal(restored.pages.flatMap(page => page.links).length, 113)
  })

  it('GET /annotations：初始为空', async () => {
    const res = await call(app, { url: `${PREFIX}/api/docs/${doc.id}/annotations` })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(json(res), { items: [] })
  })

  it('批注 CRUD：POST 生成 id → PATCH note/color → GET → DELETE', async () => {
    const created = await jsonPost(app, `${PREFIX}/api/docs/${doc.id}/annotations`, {
      kind: 'highlight',
      page: 2,
      rects: [[100.123, 200.456, 300.789, 320.001]],
      text: 'Recurrent neural networks',
      note: '第一次批注',
      paraId: 'p16',
    })
    assert.equal(created.statusCode, 200, JSON.stringify(json(created)))
    const item = json(created).item
    assert.match(item.id, /^a_[0-9a-f]{12}$/)
    assert.equal(item.kind, 'highlight')
    assert.equal(item.page, 2)
    assert.deepEqual(item.rects, [[100.12, 200.46, 300.79, 320]])
    assert.equal(item.text, 'Recurrent neural networks')
    assert.equal(item.note, '第一次批注')
    assert.equal(item.color, 'yellow', '未传 color 时默认 yellow')
    assert.equal(item.paraId, 'p16')
    assert.ok(item.createdAt && item.updatedAt)
    assert.equal(item.createdAt, item.updatedAt)

    const patched = await call(app, {
      method: 'PATCH',
      url: `${PREFIX}/api/docs/${doc.id}/annotations/${item.id}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: '改过的备注', color: 'green' }),
    })
    assert.equal(patched.statusCode, 200)
    const updated = json(patched).item
    assert.equal(updated.id, item.id)
    assert.equal(updated.note, '改过的备注')
    assert.equal(updated.color, 'green')
    assert.equal(updated.text, item.text, 'PATCH 不允许改 text')
    assert.equal(updated.page, item.page, 'PATCH 不允许改 page')

    const listed = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/annotations` }))
    assert.equal(listed.items.length, 1)
    assert.deepEqual(listed.items[0], updated)

    const deleted = await call(app, {
      method: 'DELETE',
      url: `${PREFIX}/api/docs/${doc.id}/annotations/${item.id}`,
    })
    assert.equal(deleted.statusCode, 200)
    assert.deepEqual(json(deleted), { ok: true })
    const afterDelete = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/annotations` }))
    assert.deepEqual(afterDelete.items, [])

    const deleteAgain = await call(app, {
      method: 'DELETE',
      url: `${PREFIX}/api/docs/${doc.id}/annotations/${item.id}`,
    })
    assert.equal(deleteAgain.statusCode, 404)
    assert.equal(json(deleteAgain).error.code, 'not-found')
  })

  it('批注校验：rects/页码/color/长度/kind 非法 → 400；未知文档 → 404', async () => {
    const base = {
      kind: 'highlight',
      page: 2,
      rects: [[100, 100, 200, 200]],
      text: 'x',
    }
    const cases = [
      [{ ...base, rects: [] }, 'rects 不能为空'],
      [{ ...base, rects: [[1, 2, 3]] }, '四元组'],
      [{ ...base, rects: [[1, 2, 'a', 4]] }, '四元组'],
      [{ ...base, rects: [[200, 200, 100, 100]] }, 'x1 > x0'],
      [{ ...base, page: 0 }, '页码'],
      [{ ...base, page: 99 }, '页码'],
      [{ ...base, page: 1.5 }, '页码'],
      [{ ...base, color: 'red' }, 'color'],
      [{ ...base, kind: 'sticker' }, 'kind'],
      [{ ...base, note: 'x'.repeat(4001) }, 'note 过长'],
      [{ ...base, text: 'x'.repeat(4001) }, 'text 过长'],
      [{ ...base, rects: undefined }, 'rects'],
    ]
    for (const [body, label] of cases) {
      const res = await jsonPost(app, `${PREFIX}/api/docs/${doc.id}/annotations`, body)
      assert.equal(res.statusCode, 400, `${label} 应 400，实际 ${res.statusCode}：${res.body}`)
      assert.equal(json(res).error.code, 'bad-request')
    }

    const ghost = await jsonPost(app, `${PREFIX}/api/docs/ffffffffffffffff/annotations`, base)
    assert.equal(ghost.statusCode, 404)

    // PATCH 校验
    const created = json(await jsonPost(app, `${PREFIX}/api/docs/${doc.id}/annotations`, base)).item
    const badColor = await call(app, {
      method: 'PATCH',
      url: `${PREFIX}/api/docs/${doc.id}/annotations/${created.id}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ color: 'purple' }),
    })
    assert.equal(badColor.statusCode, 400)
    const badField = await call(app, {
      method: 'PATCH',
      url: `${PREFIX}/api/docs/${doc.id}/annotations/${created.id}`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: 3 }),
    })
    assert.equal(badField.statusCode, 400)
    const missing = await call(app, {
      method: 'PATCH',
      url: `${PREFIX}/api/docs/${doc.id}/annotations/a_000000000000`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: 'x' }),
    })
    assert.equal(missing.statusCode, 404)
    await call(app, { method: 'DELETE', url: `${PREFIX}/api/docs/${doc.id}/annotations/${created.id}` })
  })

  it('并发追加 20 条不丢：全部落盘且 id 唯一', async () => {
    const before = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/annotations` })).items.length
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => jsonPost(
      app,
      `${PREFIX}/api/docs/${doc.id}/annotations`,
      {
        kind: 'note',
        page: 2,
        rects: [[100 + index, 100, 200 + index, 200]],
        text: `并发原文 ${index}`,
        note: `并发备注 ${index}`,
      },
    )))
    for (const result of results) assert.equal(result.statusCode, 200)
    const items = json(await call(app, { url: `${PREFIX}/api/docs/${doc.id}/annotations` })).items
    assert.equal(items.length, before + 20)
    const ids = new Set(items.map(item => item.id))
    assert.equal(ids.size, items.length, '批注 id 必须唯一')
    const notes = new Set(items.map(item => item.note))
    for (let index = 0; index < 20; index += 1) assert.ok(notes.has(`并发备注 ${index}`), `丢失并发备注 ${index}`)
  })

  it('GET /notes.md：标题/元信息/按页分组批注/术语表，header 正确，且无 markdown 注入', async () => {
    // 造两条会尝试注入的批注
    const injection = await jsonPost(app, `${PREFIX}/api/docs/${doc.id}/annotations`, {
      kind: 'highlight',
      page: 2,
      rects: [[120, 300, 320, 320]],
      text: '# 注入标题\n> 嵌套引用\n| a | b |',
      note: '## 备注注入\n正常第二行',
      color: 'pink',
    })
    assert.equal(injection.statusCode, 200)
    await jsonPost(app, `${PREFIX}/api/docs/${doc.id}/annotations`, {
      kind: 'note',
      page: 1,
      rects: [[10, 10, 20, 20]],
      text: '第一页的原文',
      note: '第一页备注',
      color: 'blue',
    })
    // 造解释数与术语表（terms 的 note 里带竖线，验证表格转义）
    await appendExplanation(doc.id, {
      id: 'e_0000000000000001',
      key: 'seed-key',
      recipe: 'v2',
      kind: 'explain',
      selText: 'seed',
      normText: 'seed',
      docId: doc.id,
      page: 2,
      paraId: 'p16',
      sectionId: 's2',
      contextHash: 'seed-context',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      answer: 'seed answer',
      createdAt: '2026-01-01T00:00:00.000Z',
      hitCount: 0,
      lastHitAt: null,
      supersedes: null,
    }, env)
    await mergeTerms(doc.id, [
      { term: 'Attention', zh: '注意力', note: 'a|b' },
      { term: 'softmax', zh: 'softmax', note: '' },
    ], { entryId: 'e_0000000000000001', page: 2, paraId: 'p16' }, env)

    const res = await call(app, { url: `${PREFIX}/api/docs/${doc.id}/notes.md` })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'text/markdown; charset=utf-8')
    assert.match(res.headers['content-disposition'], /^attachment;/)
    assert.match(res.headers['content-disposition'], /filename\*=UTF-8''/)
    assert.match(res.headers['content-disposition'], /-notes\.md/)
    const text = res.body.toString('utf8')
    assert.match(text, /^# Attention Is All You Need · 阅读笔记/)
    assert.match(text, /- 页数：15/)
    assert.match(text, /- 导入时间：/)
    assert.match(text, /- 解释数：1/)
    assert.match(text, /- 术语数：2/)
    assert.match(text, /## 批注/)
    assert.match(text, /### 第 1 页/)
    assert.match(text, /### 第 2 页/)
    assert.match(text, /> 颜色：pink/)
    assert.match(text, /## 术语表/)
    assert.match(text, /\| Attention \| 注意力 \| a\\\\?\|b \| 1 \|/)

    // 注入防护：原文的 # / > / | 都进了引用块，不会变成标题/嵌套引用/表格行
    const lines = text.split('\n')
    assert.equal(lines.some(line => line.startsWith('# 注入标题')), false)
    assert.equal(lines.some(line => line.startsWith('## 备注注入')), false)
    assert.equal(lines.some(line => line.startsWith('| a | b |')), false)
    assert.ok(text.includes('> \\# 注入标题'), '标题行应以引用块 + 转义形式出现')
    assert.ok(text.includes('> \\> 嵌套引用'))
    assert.ok(text.includes('> \\| a \\| b \\|'))
    assert.ok(text.includes('> 备注：\\## 备注注入'))
  })

  it('GET /file：原样回传 PDF；未知 id 404', async () => {
    const res = await call(app, { url: `${PREFIX}/api/docs/${doc.id}/file` })
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'application/pdf')
    assert.match(res.headers['content-disposition'], /^inline;/)
    assert.match(res.headers['content-disposition'], /filename\*=UTF-8''/)
    const source = await stat(docPaths(doc.id, env).source)
    assert.equal(res.body.length, source.size)
    assert.equal(res.body.subarray(0, 5).toString('latin1'), '%PDF-')

    const ghost = await call(app, { url: `${PREFIX}/api/docs/ffffffffffffffff/file` })
    assert.equal(ghost.statusCode, 404)
  })

  it('老文档兼容：annotations 空、notes.md 可导出、不报错', async () => {
    const annotations = await call(app, { url: `${PREFIX}/api/docs/${LEGACY_ID}/annotations` })
    assert.equal(annotations.statusCode, 200)
    assert.deepEqual(json(annotations), { items: [] })

    const notes = await call(app, { url: `${PREFIX}/api/docs/${LEGACY_ID}/notes.md` })
    assert.equal(notes.statusCode, 200)
    assert.equal(notes.headers['content-type'], 'text/markdown; charset=utf-8')
    const text = notes.body.toString('utf8')
    assert.match(text, /^# Legacy Paper · 阅读笔记/)
    assert.match(text, /- 页数：1/)
    assert.match(text, /暂无批注。/)
    assert.match(text, /暂无术语。/)
  })
})
