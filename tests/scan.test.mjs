/**
 * 扫描页公式识别测试：pageKind 检测、Vision OCR 注入/失败降级、
 * 扫描页对账 prompt、entry 的 pageKind/ocrText、缓存键随 ocrText 变化。
 *
 * 真实 OCR 用例默认跳过；设 PR_OCR_REAL=1 且本机有 swiftc + 用户扫描 PDF 时运行。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createApp } from '../index.js'
import { regionKey } from '../store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXTRACT = path.join(HERE, '..', 'extract.py')
const FIXTURE = process.env.PR_FIXTURE || path.join(HERE, 'fixtures', '1706.03762v7.pdf')
const HAS_FIXTURE = existsSync(FIXTURE)
const SKIP_NO_FIXTURE = HAS_FIXTURE ? {} : { skip: '缺少夹具 PDF：把 1706.03762v7.pdf 放到 tests/fixtures/ 或设置 PR_FIXTURE' }
const REAL_SCAN_PDF = process.env.PR_SCAN_PDF
  || '~/.dsh/plugin-data/paper-reader/docs/3dccdc8d615b3561/source.pdf'
const PREFIX = '/dsh-paper-reader'
const FAKE_OCR_TEXT = 'Ř=и(Š)+ẽ. (7)'

const REGION_ANSWER = [
  '### 1. 内容还原',
  '$$\\tilde{R} = \\mu(\\tilde{S}) + \\tilde{\\varepsilon}. \\tag{7}$$',
  '',
  '### 2. 符号与含义',
  '- $\\tilde{R}$：带扰动/波浪号的收益或残差项。',
  '- $\\mu(\\cdot)$：条件均值函数。',
  '',
  '### 3. 与上下文的关系',
  '公式定义了给定状态下的条件均值关系。',
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
    .map(block => JSON.parse(block.slice('data: '.length)))
}

function makeLlm() {
  const calls = []
  return {
    calls,
    stream(options) {
      calls.push(options)
      return (async function* generate() {
        for (let at = 0; at < REGION_ANSWER.length; at += 13) {
          yield { type: 'text-delta', index: 0, text: REGION_ANSWER.slice(at, at + 13) }
        }
        yield { type: 'finish', reason: { kind: 'stop' } }
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

const cleanEnv = () => {
  const env = { ...process.env }
  delete env.PR_OCR_TEXT
  delete env.PR_OCR_BIN
  delete env.PR_OCR_ENABLED
  delete env.PR_OCR_TIMEOUT_MS
  delete env.PR_SWIFTC
  return env
}

/** 现场生成一个“扫描页”PDF：整页位图 + 不可见 OCR 文字层（texttrace type=3）。 */
async function createScanPdf(dir) {
  const scriptPath = path.join(dir, 'gen-scan.py')
  const pdfPath = path.join(dir, 'scan.pdf')
  const pngPath = path.join(dir, 'page.png')
  await writeFile(scriptPath, `
import fitz
doc = fitz.open()
page = doc.new_page(width=612, height=792)
pix = fitz.Pixmap(fitz.csRGB, fitz.IRect(0, 0, 800, 1200))
pix.clear_with(255)
pix.save(${JSON.stringify(pngPath)})
page.insert_image(page.rect, filename=${JSON.stringify(pngPath)})
page.insert_text((120, 300), "R = I_t(S) + 9.", fontsize=15, render_mode=3)
page.insert_text((120, 330), "sumed to have conditional mean of zero given S, and", fontsize=9, render_mode=3)
doc.save(${JSON.stringify(pdfPath)})
print('ok')
`, 'utf8')
  const proc = spawnSync('python3', [scriptPath], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(proc.status, 0, `生成扫描夹具失败：${proc.stderr}`)
  return pdfPath
}

function runRegionCli(pdfPath, page, rect, env) {
  return spawnSync('python3', [EXTRACT, '--region', pdfPath, String(page), rect], {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    env,
  })
}

describe('扫描页 OCR（CLI）', SKIP_NO_FIXTURE, () => {
  let dir
  let scanPdf
  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'pr-scan-cli-'))
    scanPdf = await createScanPdf(dir)
  })
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('扫描页：pageKind=scan、注入的视觉 OCR 结果 + 隐藏文字层', () => {
    const env = { ...cleanEnv(), PR_OCR_TEXT: FAKE_OCR_TEXT }
    const run = runRegionCli(scanPdf, 1, '100,280,430,320', env)
    assert.equal(run.status, 0, String(run.stderr))
    const result = JSON.parse(String(run.stdout).trim())
    assert.equal(result.ok, true)
    assert.equal(result.pageKind, 'scan')
    assert.match(result.text, /R = I_t\(S\) \+ 9\./)
    assert.ok(Array.isArray(result.lines) && result.lines.length > 0)
    assert.equal(result.ocr.engine, 'vision')
    assert.equal(result.ocr.text, FAKE_OCR_TEXT)
    assert.equal(typeof result.ocr.ms, 'number')
    assert.equal(result.ocr.error, undefined)
  })

  it('矢量页：pageKind=vector、ocr=null', () => {
    const run = runRegionCli(FIXTURE, 4, '205,450,515,505', cleanEnv())
    assert.equal(run.status, 0, String(run.stderr))
    const result = JSON.parse(String(run.stdout).trim())
    assert.equal(result.pageKind, 'vector')
    assert.equal(result.ocr, null)
  })

  it('OCR 不可用：不报错，ocr.error + warning，主流程仍返回文字层', () => {
    const env = { ...cleanEnv(), PR_OCR_BIN: '/nonexistent/ocr-for-pr-test' }
    const run = runRegionCli(scanPdf, 1, '100,280,430,320', env)
    assert.equal(run.status, 0, String(run.stderr))
    const result = JSON.parse(String(run.stdout).trim())
    assert.equal(result.ok, true)
    assert.equal(result.pageKind, 'scan')
    assert.equal(result.ocr.text, '')
    assert.match(result.ocr.error, /PR_OCR_BIN/)
    assert.ok(result.warnings.some(warning => /视觉 OCR 不可用/.test(warning)))
    assert.match(result.text, /R = I_t\(S\)/)
  })
})

describe('扫描页对账 prompt 与缓存（合成扫描 PDF + 假 llm）', SKIP_NO_FIXTURE, () => {
  let home
  let env
  let app
  let llm
  let doc
  let originalOcrText
  let originalOcrBin

  before(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'pr-scan-app-'))
    env = { DSH_HOME: home }
    const scanDir = path.join(home, 'fixtures')
    await mkdir(scanDir, { recursive: true })
    const pdfPath = await createScanPdf(scanDir)
    originalOcrText = process.env.PR_OCR_TEXT
    originalOcrBin = process.env.PR_OCR_BIN
    process.env.PR_OCR_TEXT = FAKE_OCR_TEXT
    delete process.env.PR_OCR_BIN

    llm = makeLlm()
    app = createApp({
      ctx: baseCtx(llm),
      config: { pythonPath: 'python3', appDir: path.join(home, 'app') },
      env,
    })
    await app.ready
    const pdf = await readFile(pdfPath)
    const uploaded = await call(app, {
      method: 'POST',
      url: `${PREFIX}/api/docs`,
      headers: { 'content-type': 'application/pdf' },
      body: pdf,
    })
    assert.equal(uploaded.statusCode, 200, uploaded.body.toString())
    doc = json(uploaded).doc
  })

  after(async () => {
    if (originalOcrText === undefined) delete process.env.PR_OCR_TEXT
    else process.env.PR_OCR_TEXT = originalOcrText
    if (originalOcrBin === undefined) delete process.env.PR_OCR_BIN
    else process.env.PR_OCR_BIN = originalOcrBin
    if (home) await rm(home, { recursive: true, force: true })
  })

  function regionCall(force = false) {
    return call(app, {
      method: 'POST',
      url: `${PREFIX}/api/explain-region`,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docId: doc.id, page: 1, rect: [100, 280, 430, 320], force }),
    })
  }

  it('扫描页 prompt：隐藏文字层 + 视觉 OCR + 上下文 + 常见混淆；entry 带 pageKind/ocrText', async () => {
    const res = await regionCall()
    assert.equal(res.statusCode, 200)
    const events = parseSse(res)
    assert.equal(events[0].kind, 'region')
    const done = events.at(-1)
    assert.equal(done.type, 'done')
    const entry = done.entry
    assert.equal(entry.kind, 'region')
    assert.equal(entry.pageKind, 'scan')
    assert.equal(entry.ocrText, FAKE_OCR_TEXT)
    assert.match(entry.regionText, /R = I_t\(S\)/)

    const request = llm.calls.at(-1)
    const system = request.system
    const userText = request.messages[0].content[0].text
    assert.match(system, /扫描页/)
    assert.match(system, /视觉 OCR/)
    for (const marker of ['隐藏文字层', '视觉 OCR', '常见混淆', 'Ř→R̃', '所在段落', '前一段', '后一段']) {
      assert.ok(userText.includes(marker), `prompt 缺少「${marker}」`)
    }
    assert.ok(userText.includes('R = I_t(S) + 9.'), 'prompt 应包含隐藏文字层原文')
    assert.ok(userText.includes(FAKE_OCR_TEXT), 'prompt 应包含视觉 OCR 结果')
    assert.ok(userText.includes('第 1 页'), 'prompt 应包含页码上下文')
  })

  it('扫描页同区域第二次：缓存命中（hitCount+1、零模型调用）', async () => {
    const before = llm.calls.length
    const events = parseSse(await regionCall())
    assert.deepEqual(events.map(event => event.type), ['meta', 'done'])
    assert.equal(events[0].cached, true)
    assert.equal(events[0].kind, 'region')
    assert.equal(events[0].hitCount, 1)
    assert.equal(events[1].entry.pageKind, 'scan')
    assert.equal(llm.calls.length, before)
  })

  it('缓存键随 ocrText 变化：视觉 OCR 结果变了必须 miss', async () => {
    const before = llm.calls.length
    const keyA = regionKey(doc.id, 1, [100, 280, 430, 320], 'R = I_t(S) + 9.', FAKE_OCR_TEXT)
    const keyB = regionKey(doc.id, 1, [100, 280, 430, 320], 'R = I_t(S) + 9.', 'Ř=u(Š)+Ẽ. (7)')
    assert.notEqual(keyA, keyB)

    process.env.PR_OCR_TEXT = 'Ř=u(Š)+Ẽ. (7)'
    const events = parseSse(await regionCall())
    assert.equal(events[0].cached, false, 'OCR 变化后应 miss')
    assert.equal(llm.calls.length, before + 1)
    assert.equal(events.at(-1).entry.ocrText, 'Ř=u(Š)+Ẽ. (7)')
    process.env.PR_OCR_TEXT = FAKE_OCR_TEXT
  })

  it('视觉 OCR 失败：prompt 只给文字层 + 警告，仍能落盘', async () => {
    delete process.env.PR_OCR_TEXT
    process.env.PR_OCR_BIN = '/nonexistent/ocr-for-pr-test'
    try {
      const events = parseSse(await regionCall(true))
      assert.equal(events[0].cached, false)
      const entry = events.at(-1).entry
      assert.equal(entry.pageKind, 'scan')
      assert.equal(entry.ocrText, '')
      const userText = llm.calls.at(-1).messages[0].content[0].text
      assert.match(userText, /视觉 OCR 不可用/)
      assert.match(userText, /PR_OCR_BIN/)
      assert.ok(userText.includes('R = I_t(S) + 9.'))
      assert.match(userText, /标注不确定/)
    } finally {
      process.env.PR_OCR_TEXT = FAKE_OCR_TEXT
      delete process.env.PR_OCR_BIN
    }
  })
})

describe('真实 Vision OCR（PR_OCR_REAL=1 才跑）', () => {
  const realEnabled = process.env.PR_OCR_REAL === '1'
  const hasSwiftc = spawnSync('swiftc', ['--version'], { encoding: 'utf8' }).status === 0
  const fixtureExists = existsSync(REAL_SCAN_PDF)
  const skip = !realEnabled || !hasSwiftc || !fixtureExists
    ? '需要 PR_OCR_REAL=1 + swiftc + 用户扫描 PDF'
    : false

  it('用户扫描 PDF 第 10 页公式：真实 OCR 结果非空、二进制懒编译缓存', { skip }, async () => {
    const binDir = await mkdtemp(path.join(os.tmpdir(), 'pr-scan-bin-'))
    try {
      const env = { ...cleanEnv(), PR_PLUGIN_DATA: binDir }
      const started = Date.now()
      const first = runRegionCli(REAL_SCAN_PDF, 10, '168,292,405,315', env)
      const firstMs = Date.now() - started
      assert.equal(first.status, 0, String(first.stderr))
      const result = JSON.parse(String(first.stdout).trim())
      assert.equal(result.pageKind, 'scan')
      assert.equal(result.ocr.engine, 'vision')
      assert.equal(result.ocr.error, undefined)
      assert.ok(result.ocr.text.length > 0, '真实 OCR 文本不应为空')
      assert.match(result.ocr.text, /[ŘRŠS]/)
      assert.match(result.text, /R = I_t\(S\)/)

      // 懒编译产物缓存到 <plugin-data>/bin/ocr-<sha12>
      const bins = await readdir(path.join(binDir, 'bin'))
      assert.equal(bins.filter(name => /^ocr-[0-9a-f]{12}$/.test(name)).length, 1)

      // 第二次不再编译，直接复用缓存
      const second = runRegionCli(REAL_SCAN_PDF, 10, '168,292,405,315', env)
      assert.equal(second.status, 0)
      const secondResult = JSON.parse(String(second.stdout).trim())
      assert.equal(secondResult.ocr.engine, 'vision')
      assert.ok(secondResult.ocr.text.length > 0)
      console.log(`[scan] 真实 OCR：首次 ${firstMs}ms（含编译）、ocr.ms=${result.ocr.ms}，text=${JSON.stringify(result.ocr.text)}`)
    } finally {
      await rm(binDir, { recursive: true, force: true })
    }
  })
})
