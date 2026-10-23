/**
 * extract.py 的契约测试。
 *
 * 夹具：<fixture>/1706.03762v7.pdf（15 页、22 条 TOC、6095 词）。
 * 另外用 PyMuPDF 现场生成三份小 PDF，覆盖加密、无文字层、双栏三种边界。
 *
 * 这些测试只依赖系统 python3 + PyMuPDF，不 import 任何 npm 依赖。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// 夹具 PDF（arXiv:1706.03762v7）不随仓库分发：放到 tests/fixtures/ 或用 PR_FIXTURE 指定；
// 没有夹具时，依赖真实论文的用例自动 skip，其余用例照常跑。
const FIXTURE = process.env.PR_FIXTURE || path.join(HERE, 'fixtures', '1706.03762v7.pdf')
const HAS_FIXTURE = existsSync(FIXTURE)
const SKIP_NO_FIXTURE = HAS_FIXTURE ? {} : { skip: '缺少夹具 PDF：把 1706.03762v7.pdf 放到 tests/fixtures/ 或设置 PR_FIXTURE' }
const EXTRACT = path.join(HERE, '..', 'extract.py')


function runExtract(pdfPath, outDir) {
  const started = Date.now()
  const proc = spawnSync('python3', [EXTRACT, pdfPath, outDir], {
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  })
  return { ...proc, durationMs: Date.now() - started }
}

async function tmpDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

async function python(code, workDir) {
  const dir = workDir ?? (await tmpDir('pr-gen-'))
  const script = path.join(dir, 'gen.py')
  await writeFile(script, code, 'utf8')
  const proc = spawnSync('python3', [script], { encoding: 'utf8', timeout: 60_000 })
  assert.equal(proc.status, 0, `生成夹具失败：${proc.stderr}`)
  return dir
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

describe('extract.py 真实论文（1706.03762v7.pdf）', SKIP_NO_FIXTURE, () => {
  let outDir
  let run
  let summary
  let structure
  let page1
  let pagesDirFiles

  before(async () => {
    assert.ok(existsSync(EXTRACT), `缺少抽取脚本：${EXTRACT}`)
    assert.ok(existsSync(FIXTURE), `缺少夹具：${FIXTURE}`)
    outDir = await tmpDir('pr-extract-')
    run = runExtract(FIXTURE, outDir)
    const lines = String(run.stdout || '').trim().split('\n')
    assert.equal(run.status, 0, `extract.py 非零退出（${run.status}）：${run.stderr}\nstdout=${run.stdout}`)
    assert.equal(lines.length, 1, `stdout 必须是且只能是一行 JSON，实际 ${lines.length} 行`)
    summary = JSON.parse(lines[0])
    structure = JSON.parse(await readFile(path.join(outDir, 'structure.json'), 'utf8'))
    page1 = JSON.parse(await readFile(path.join(outDir, 'pages', '1.json'), 'utf8'))
    pagesDirFiles = await readdir(path.join(outDir, 'pages'))
    if (globalThis.gc) globalThis.gc()
    await sleep(1)
  })

  after(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true })
  })

  it('stdout 一行 JSON 摘要符合约定', () => {
    assert.equal(summary.ok, true)
    assert.equal(summary.pageCount, 15)
    assert.ok(summary.sections >= 20, `sections=${summary.sections} 应 ≥ 20`)
    assert.ok(summary.paras > 0, `paras=${summary.paras} 应 > 0`)
    assert.ok(summary.words > 5000, `words=${summary.words} 应 > 5000`)
    assert.ok(Array.isArray(summary.warnings))
  })

  it('structure.json 顶层字段与页元数据完整', () => {
    assert.equal(structure.version, 1)
    assert.match(structure.id, /^[0-9a-f]{16}$/)
    assert.ok(structure.title.includes('Attention'), `标题异常：${structure.title}`)
    assert.equal(structure.pageCount, 15)
    assert.equal(structure.pages.length, 15)
    structure.pages.forEach((page, index) => {
      assert.equal(page.n, index + 1)
      assert.ok(page.w > 0 && page.h > 0)
      assert.equal(typeof page.hasText, 'boolean')
    })
    assert.equal(structure.sections.length, summary.sections)
    assert.equal(structure.paras.length, summary.paras)
  })

  it('sections 字段合法且标题来自 TOC', () => {
    const sectionIds = new Set(structure.sections.map(section => section.id))
    assert.equal(sectionIds.size, structure.sections.length, 'section id 必须唯一')
    structure.sections.forEach((section, index) => {
      assert.equal(section.id, `s${index + 1}`)
      assert.equal(typeof section.title, 'string')
      assert.ok(section.title.length > 0)
      assert.ok(Number.isInteger(section.level) && section.level >= 1)
      assert.ok(Number.isInteger(section.page) && section.page >= 1 && section.page <= 15)
      assert.ok(Array.isArray(section.paraIds))
      section.paraIds.forEach(paraId => assert.ok(typeof paraId === 'string' && paraId.length > 0))
    })
    const titles = structure.sections.map(section => section.title.toLowerCase())
    for (const expected of ['introduction', 'background', 'model architecture', 'conclusion']) {
      assert.ok(titles.includes(expected), `缺少章节 ${expected}，实际：${titles.join(' / ')}`)
    }
    assert.equal(structure.sections.filter(section => section.level === 2).length >= 8, true)
  })

  it('paras：阅读顺序、bbox 页内、sectionId 有效、text 非空', () => {
    const sectionIds = new Set(structure.sections.map(section => section.id))
    const paraIds = new Set()
    let lastPage = 0
    for (const para of structure.paras) {
      assert.match(para.id, /^p\d+$/)
      assert.ok(!paraIds.has(para.id), `para id 重复：${para.id}`)
      paraIds.add(para.id)
      assert.ok(Number.isInteger(para.page) && para.page >= 1 && para.page <= 15)
      assert.ok(para.page >= lastPage, `段落页序倒退：${para.id} p${para.page} < p${lastPage}`)
      lastPage = para.page
      assert.ok(sectionIds.has(para.sectionId), `para ${para.id} 的 sectionId 无效：${para.sectionId}`)
      assert.equal(typeof para.text, 'string')
      assert.ok(para.text.trim().length > 0, `para ${para.id} 文本为空`)
      const page = structure.pages[para.page - 1]
      assert.equal(para.bbox.length, 4)
      const [x0, y0, x1, y1] = para.bbox
      assert.ok(x0 >= -1 && y0 >= -1, `para ${para.id} bbox 起点越界：${para.bbox}`)
      assert.ok(x1 <= page.w + 1 && y1 <= page.h + 1, `para ${para.id} bbox 终点越界：${para.bbox} page=${page.w}x${page.h}`)
      assert.ok(x1 > x0 && y1 > y0, `para ${para.id} bbox 非正面积`)
    }
    const referenced = structure.sections.flatMap(section => section.paraIds)
    for (const paraId of referenced) assert.ok(paraIds.has(paraId), `section 引用了不存在的 para：${paraId}`)
    const covered = new Set(referenced)
    for (const para of structure.paras) assert.ok(covered.has(para.id), `para ${para.id} 未被任何 section 引用`)
  })

  it('paras[].sent 首尾相接且完整覆盖 text', () => {
    for (const para of structure.paras) {
      assert.ok(Array.isArray(para.sent) && para.sent.length > 0, `para ${para.id} 没有句区间`)
      let cursor = 0
      for (const range of para.sent) {
        assert.equal(range.length, 2)
        const [start, end] = range
        assert.equal(start, cursor, `para ${para.id} 句区间空洞：期望 ${cursor} 实际 ${start}`)
        assert.ok(end > start, `para ${para.id} 句区间为空：[${start},${end})`)
        assert.ok(end <= para.text.length)
        assert.ok(para.text.slice(start, end).trim().length > 0, `para ${para.id} 句区间 [${start},${end}) 为空白`)
        cursor = end
      }
      assert.equal(cursor, para.text.length, `para ${para.id} 句区间未覆盖全文（${cursor}/${para.text.length}）`)
    }
  })

  it('pages/<n>.json：逐词坐标、paraId 有效、阅读顺序', async () => {
    const paraById = new Map(structure.paras.map(para => [para.id, para]))
    const dir = path.join(outDir, 'pages')
    const jsonFiles = pagesDirFiles.filter(name => /^\d+\.json$/.test(name))
    assert.equal(jsonFiles.length, 15)
    let wordTotal = 0
    for (const name of jsonFiles) {
      const n = Number(name.replace('.json', ''))
      const page = JSON.parse(await readFile(path.join(dir, name), 'utf8'))
      const meta = structure.pages[n - 1]
      assert.equal(page.n, n)
      assert.ok(page.columns === 'one' || page.columns === 'two')
      assert.ok(Array.isArray(page.words))
      wordTotal += page.words.length
      const hasParas = structure.paras.some(para => para.page === n)
      for (const word of page.words) {
        assert.equal(word.length, 6, `第 ${n} 页词元组应为 6 项：${JSON.stringify(word)}`)
        const [x0, y0, x1, y1, text, paraId] = word
        assert.ok(typeof text === 'string' && text.length > 0)
        assert.ok(x0 >= -1 && y0 >= -1 && x1 <= meta.w + 1 && y1 <= meta.h + 1, `第 ${n} 页词越界：${JSON.stringify(word)}`)
        assert.ok(x1 >= x0 && y1 >= y0)
        if (hasParas) assert.ok(paraById.has(paraId), `第 ${n} 页词 ${text} 的 paraId 无效：${paraId}`)
      }
    }
    assert.equal(wordTotal, summary.words, '摘要 words 应等于所有页词数之和')
  })

  it('页图：pages/ 下 15 张 PNG，doc 根目录不再有镜像', async () => {
    const pngs = pagesDirFiles.filter(name => /^\d+\.png$/.test(name))
    assert.equal(pngs.length, 15)
    let totalBytes = 0
    for (const name of pngs) {
      const info = await stat(path.join(outDir, 'pages', name))
      assert.ok(info.size > 20 * 1024, `${name} 只有 ${info.size} 字节，应 > 20KB`)
      const head = (await readFile(path.join(outDir, 'pages', name))).subarray(0, 8)
      assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${name} 不是 PNG`)
      totalBytes += info.size
    }
    // 镜像页图已按 lead 决策删除：/media 路由直接读 pages/<n>.png
    const mirrors = (await readdir(outDir)).filter(name => /^page-\d+\.png$/.test(name))
    assert.equal(mirrors.length, 0, `不应再生成 doc 根镜像，实际：${mirrors.join(',')}`)
    assert.ok(totalBytes > 1.5 * 1024 * 1024, `页图总字节异常偏小：${totalBytes}`)
  })

  it('体积预算：structure.json < 2MB，pages/*.json 合计 < 1.5MB', async () => {
    const structureSize = (await stat(path.join(outDir, 'structure.json'))).size
    assert.ok(structureSize < 2 * 1024 * 1024, `structure.json ${structureSize} 字节`)
    let pagesTotal = 0
    for (const name of pagesDirFiles.filter(name => /^\d+\.json$/.test(name))) {
      pagesTotal += (await stat(path.join(outDir, 'pages', name))).size
    }
    assert.ok(pagesTotal < 1.5 * 1024 * 1024, `pages/*.json 合计 ${pagesTotal} 字节`)
    console.log(`[extract] 耗时=${run.durationMs}ms structure=${(structureSize / 1024).toFixed(1)}KB pages-json=${(pagesTotal / 1024).toFixed(1)}KB paras=${summary.paras} sections=${summary.sections} words=${summary.words}`)
  })
})

describe('extract.py 边界：加密 PDF', () => {
  let dir
  before(async () => {
    dir = await tmpDir('pr-enc-')
    await python(`
import fitz
doc = fitz.open()
page = doc.new_page()
page.insert_text((72, 72), 'Secret document')
doc.save(${JSON.stringify(path.join(dir, 'enc.pdf'))}, encryption=fitz.PDF_ENCRYPT_AES_256, owner_pw='owner', user_pw='user')
print('ok')
`, dir)
  })
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('返回 code=encrypted 且非零退出', async () => {
    const out = await tmpDir('pr-enc-out-')
    try {
      const run = runExtract(path.join(dir, 'enc.pdf'), out)
      assert.notEqual(run.status, 0)
      const summary = JSON.parse(String(run.stdout).trim())
      assert.equal(summary.ok, false)
      assert.equal(summary.code, 'encrypted')
      assert.ok(typeof summary.message === 'string' && summary.message.length > 0)
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
})

describe('extract.py 边界：无文字层 PDF', () => {
  let dir
  before(async () => {
    dir = await tmpDir('pr-empty-')
    await python(`
import fitz
doc = fitz.open()
doc.new_page(width=612, height=792)
doc.save(${JSON.stringify(path.join(dir, 'blank.pdf'))})
print('ok')
`, dir)
  })
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('ok:true、hasText:false、paras 为空', async () => {
    const out = await tmpDir('pr-empty-out-')
    try {
      const run = runExtract(path.join(dir, 'blank.pdf'), out)
      assert.equal(run.status, 0, String(run.stderr))
      const summary = JSON.parse(String(run.stdout).trim())
      assert.equal(summary.ok, true)
      assert.equal(summary.pageCount, 1)
      assert.equal(summary.paras, 0)
      const structure = JSON.parse(await readFile(path.join(out, 'structure.json'), 'utf8'))
      assert.equal(structure.pages[0].hasText, false)
      const page = JSON.parse(await readFile(path.join(out, 'pages', '1.json'), 'utf8'))
      assert.equal(page.words.length, 0)
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
})

describe('extract.py 边界：双栏 PDF', () => {
  let dir
  before(async () => {
    dir = await tmpDir('pr-two-')
    const pdf = path.join(dir, 'two.pdf')
    await python(`
import fitz
doc = fitz.open()
page = doc.new_page(width=612, height=792)
left_top = fitz.Rect(50, 72, 270, 220)
left_bottom = fitz.Rect(50, 240, 270, 400)
right_top = fitz.Rect(330, 72, 560, 220)
right_bottom = fitz.Rect(330, 240, 560, 400)
page.insert_textbox(left_top, ' '.join(['LEFTCOL'] + ['alpha'] * 40), fontsize=10)
page.insert_textbox(left_bottom, ' '.join(['LEFTBOTTOM'] + ['beta'] * 40), fontsize=10)
page.insert_textbox(right_top, ' '.join(['RIGHTCOL'] + ['omega'] * 40), fontsize=10)
page.insert_textbox(right_bottom, ' '.join(['RIGHTBOTTOM'] + ['zeta'] * 40), fontsize=10)
doc.save(${JSON.stringify(pdf)})
print('ok')
`, dir)
  })
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  it('判定 columns=two 且左栏词全部排在右栏之前', async () => {
    const out = await tmpDir('pr-two-out-')
    try {
      const run = runExtract(path.join(dir, 'two.pdf'), out)
      assert.equal(run.status, 0, String(run.stderr))
      const page = JSON.parse(await readFile(path.join(out, 'pages', '1.json'), 'utf8'))
      assert.equal(page.columns, 'two')
      const texts = page.words.map(word => word[4])
      const leftAt = texts.indexOf('LEFTCOL')
      const rightAt = texts.indexOf('RIGHTCOL')
      assert.ok(leftAt >= 0 && rightAt >= 0)
      assert.ok(leftAt < rightAt, '双栏阅读顺序应为左栏全部词先于右栏')
      const xs = page.words.map(word => word[0])
      const firstRight = xs.findIndex(x => x >= 300)
      assert.ok(firstRight > 0, '应存在左栏词先出现')
      assert.ok(xs.slice(firstRight).every(x => x >= 300), '右栏词不得与左栏交错')
      assert.ok(texts.indexOf('LEFTBOTTOM') < texts.indexOf('RIGHTBOTTOM'))
    } finally {
      await rm(out, { recursive: true, force: true })
    }
  })
})

describe('extract.py 边界：非 PDF 文件', () => {
  it('返回 code=bad-pdf 且非零退出', async () => {
    const dir = await tmpDir('pr-bad-')
    const out = await tmpDir('pr-bad-out-')
    try {
      const bad = path.join(dir, 'note.txt')
      await writeFile(bad, 'this is not a pdf at all', 'utf8')
      const run = runExtract(bad, out)
      assert.notEqual(run.status, 0)
      const summary = JSON.parse(String(run.stdout).trim())
      assert.equal(summary.ok, false)
      assert.equal(summary.code, 'bad-pdf')
      assert.ok(summary.message.length > 0)
    } finally {
      await rm(dir, { recursive: true, force: true })
      await rm(out, { recursive: true, force: true })
    }
  })
})
