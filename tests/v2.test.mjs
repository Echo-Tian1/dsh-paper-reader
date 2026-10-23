/**
 * v2 能力单测：terms trailer 流式扣住、术语表合并、目标语言判定、
 * translate/region 缓存键、extract.py --region 子命令、区域段落匹配。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  TermsHoldback,
  buildTranslateSystem,
  extractTermsTrailer,
  findParaByRect,
} from '../explain.js'
import {
  cjkRatio,
  mergeTerms,
  readTerms,
  regionKey,
  renderTermsMarkdown,
  roundRect1,
  sha1,
  sha256,
  targetLanguage,
  translateKey,
} from '../store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const EXTRACT = path.join(HERE, '..', 'extract.py')
const FIXTURE = '/Users/echo/Downloads/1706.03762v7.pdf'
const DOC_ID = 'a1b2c3d4e5f60718'

const BODY = '### 1. 中译\n这是译文正文。'
const TERMS = [{ term: 'Attention', zh: '注意力', note: '按相关性加权求和的机制' }]
const TRAILER = `<!--terms:${JSON.stringify({ terms: TERMS })}-->`

describe('TermsHoldback：terms trailer 流式扣住', () => {
  it('整块到达：正文立刻发，trailer 全部扣住', () => {
    const holdback = new TermsHoldback()
    const emitted = holdback.push(`${BODY}\n${TRAILER}`)
    assert.equal(emitted, `${BODY}\n`)
    assert.equal(emitted.includes('<!--terms:'), false)
    const tail = holdback.finish()
    assert.equal(tail.text, '')
    assert.equal(tail.answer, BODY)
    assert.deepEqual(tail.terms, TERMS)
  })

  it('逐字符到达：marker 跨 chunk 也不会漏发/漏扣', () => {
    const full = `${BODY}\n${TRAILER}`
    const holdback = new TermsHoldback()
    let streamed = ''
    for (const char of full) streamed += holdback.push(char)
    const tail = holdback.finish()
    assert.equal(`${streamed}${tail.text}`.includes('<!--terms:'), false, '客户端不应看到 trailer 任何片段')
    assert.equal(tail.answer, BODY)
    assert.deepEqual(tail.terms, TERMS)
  })

  it('marker 前缀跨 chunk（<!--te + rms:…）也被扣住', () => {
    const holdback = new TermsHoldback()
    assert.equal(holdback.push('答案 A<!--te'), '答案 A')
    assert.equal(holdback.push('rms:{"terms":[]}-->'), '')
    const tail = holdback.finish()
    assert.equal(tail.answer, '答案 A')
    assert.deepEqual(tail.terms, [])
  })

  it('无 trailer：全部按正文发出，terms 为空', () => {
    const text = '这是一段普通的译文，没有术语注释。'
    const holdback = new TermsHoldback()
    let streamed = ''
    for (let at = 0; at < text.length; at += 4) streamed += holdback.push(text.slice(at, at + 4))
    const tail = holdback.finish()
    assert.equal(`${streamed}${tail.text}`, text)
    assert.equal(tail.answer, text)
    assert.deepEqual(tail.terms, [])
  })

  it('畸形 trailer（JSON 坏 / 未闭合）：剥离但不抛错，terms 为空', () => {
    const brokenJson = new TermsHoldback()
    const emitted = brokenJson.push(`${BODY}\n<!--terms:{不是 JSON}-->`)
    assert.equal(emitted, `${BODY}\n`)
    const badTail = brokenJson.finish()
    assert.equal(badTail.answer, BODY)
    assert.deepEqual(badTail.terms, [])

    const unclosed = new TermsHoldback()
    unclosed.push(`${BODY}\n<!--terms:{"terms":[`)
    const unclosedTail = unclosed.finish()
    assert.equal(unclosedTail.answer, BODY)
    assert.deepEqual(unclosedTail.terms, [])
  })

  it('extractTermsTrailer：整段文本剥离口径与流式一致', () => {
    const parsed = extractTermsTrailer(`${BODY}\n${TRAILER}`)
    assert.equal(parsed.answer, BODY)
    assert.deepEqual(parsed.terms, TERMS)
    assert.deepEqual(extractTermsTrailer('没有 trailer').terms, [])
  })
})

describe('术语表合并', () => {
  it('按 key 合并、count 累加、保留首次出现位置、刷新 updatedAt', async t => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'pr-v2-terms-'))
    t.after(() => rm(home, { recursive: true, force: true }))
    const env = { DSH_HOME: home }
    const first = await mergeTerms(DOC_ID, [
      { term: 'Attention', zh: '注意力', note: '机制' },
      { term: 'transduction', zh: '转导', note: '' },
    ], { entryId: 'e_1', page: 2, paraId: 'p16' }, env)
    assert.equal(first.length, 2)
    const attention = first.find(item => item.key === 'attention')
    assert.equal(attention.count, 1)
    assert.equal(attention.page, 2)
    assert.equal(attention.paraId, 'p16')
    assert.equal(attention.firstEntryId, 'e_1')

    const second = await mergeTerms(DOC_ID, [
      { term: 'attention', zh: '注意力机制', note: '更新说明' },
      { term: 'encoder', zh: '编码器', note: '' },
    ], { entryId: 'e_2', page: 3, paraId: 'p20' }, env)
    const merged = second.find(item => item.key === 'attention')
    assert.equal(merged.count, 2)
    assert.equal(merged.term, 'Attention', '保留首次出现的写法')
    assert.equal(merged.page, 2, '保留首次出现位置')
    assert.equal(merged.paraId, 'p16')
    assert.equal(merged.firstEntryId, 'e_1')
    assert.equal(merged.zh, '注意力', '已有中文名不被覆盖')
    assert.equal(merged.count, 2)
    assert.ok(merged.updatedAt)
    assert.equal(second.find(item => item.key === 'encoder').count, 1)
    // 排序：count 降序
    assert.equal(second[0].key, 'attention')
    assert.deepEqual((await readTerms(DOC_ID, env)).map(item => item.key).sort(), ['attention', 'encoder', 'transduction'])
  })

  it('renderTermsMarkdown：标题、表格、转义', () => {
    const markdown = renderTermsMarkdown({ title: 'Attention Is All You Need' }, [
      { key: 'attention', term: 'Attention', zh: '注意力', note: 'a|b', count: 2 },
    ])
    assert.match(markdown, /^# Attention Is All You Need · 术语表/)
    assert.match(markdown, /\| 术语 \| 中文 \| 说明 \| 出现次数 \|/)
    assert.match(markdown, /\| Attention \| 注意力 \| a\\\|b \| 2 \|/)
  })
})

describe('目标语言判定（CJK 占比）', () => {
  it('英文段落 → 译成中文；中文段落 → 译成英文；0.5 归英文', () => {
    assert.equal(targetLanguage('Recurrent neural networks are established as state of the art.'), 'zh')
    assert.equal(targetLanguage('循环神经网络已被确立为该领域的常用方法。'), 'en')
    assert.equal(cjkRatio('中a'), 0.5)
    assert.equal(targetLanguage('中a'), 'en')
    assert.equal(cjkRatio(''), 0)
    assert.equal(targetLanguage('  \n\t '), 'zh')
  })

  it('buildTranslateSystem 按目标语言填文案', () => {
    assert.match(buildTranslateSystem('zh'), /译成中文/)
    assert.match(buildTranslateSystem('en'), /译成英文/)
    assert.equal(buildTranslateSystem('en').includes('{target}'), false)
  })
})

describe('三类缓存键', () => {
  it('translateKey 与契约公式一致且对段落文本敏感', () => {
    const key = translateKey(DOC_ID, 'p16', 'hello world')
    assert.match(key, /^[0-9a-f]{64}$/)
    assert.equal(key, sha256(`${DOC_ID}|translate-v1|p16|${sha1('hello world')}`))
    assert.notEqual(key, translateKey(DOC_ID, 'p17', 'hello world'))
    assert.notEqual(key, translateKey(DOC_ID, 'p16', 'hello worlds'))
    assert.notEqual(key, translateKey('ffffffffffffffff', 'p16', 'hello world'))
  })

  it('regionKey 与契约公式一致；rect 只取到 0.1pt', () => {
    const key = regionKey(DOC_ID, 4, [100.04, 200.06, 300, 400.02], 'softmax text')
    assert.match(key, /^[0-9a-f]{64}$/)
    assert.equal(
      key,
      sha256(`${DOC_ID}|region-v1|4|100,200.1,300,400|${sha1('softmax text')}`),
    )
    assert.equal(
      regionKey(DOC_ID, 4, [100.0, 200.1, 300, 400], 'softmax text'),
      key,
    )
    assert.notEqual(regionKey(DOC_ID, 5, [100, 200.1, 300, 400], 'softmax text'), key)
    assert.notEqual(regionKey(DOC_ID, 4, [100, 200.1, 300, 400], 'other text'), key)
    assert.equal(roundRect1([1.234, 2.345, 3.456, 4.567]), '1.2,2.3,3.5,4.6')
  })
})

describe('findParaByRect：相交面积最大的段落', () => {
  const paras = [
    { id: 'p1', page: 4, bbox: [100, 100, 200, 200] },
    { id: 'p2', page: 4, bbox: [150, 150, 260, 260] },
    { id: 'p3', page: 5, bbox: [100, 100, 300, 300] },
  ]
  it('选同页相交面积最大者；无相交返回 null', () => {
    assert.equal(findParaByRect(paras, 4, [140, 140, 240, 240])?.id, 'p2')
    assert.equal(findParaByRect(paras, 4, [0, 0, 50, 50]), null)
    assert.equal(findParaByRect(paras, 4, [180, 180, 260, 260])?.id, 'p2')
  })
})

describe('extract.py --region 子命令', () => {
  function runRegion(args) {
    const started = Date.now()
    const proc = spawnSync('python3', [EXTRACT, '--region', ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { ...proc, durationMs: Date.now() - started }
  }

  before(() => {
    assert.ok(FIXTURE, '需要夹具 PDF 才能验证 region 抽取')
  })

  it('第 4 页公式区域：返回一行 JSON、文字层含 softmax、单次 <1s 量级', () => {
    const run = runRegion([FIXTURE, '4', '210,455,510,500'])
    assert.equal(run.status, 0, String(run.stderr))
    const lines = String(run.stdout).trim().split('\n')
    assert.equal(lines.length, 1, 'stdout 必须只有一行 JSON')
    const result = JSON.parse(lines[0])
    assert.equal(result.ok, true)
    assert.equal(result.page, 4)
    assert.equal(result.hasText, true)
    assert.match(result.text, /softmax/i)
    assert.deepEqual(result.rect.length, 4)
    assert.ok(run.durationMs < 5000, `区域抽取耗时 ${run.durationMs}ms 偏大`)
  })

  it('空白区域：ok:true、hasText:false、text 为空', () => {
    const run = runRegion([FIXTURE, '1', '2,2,30,30'])
    assert.equal(run.status, 0, String(run.stderr))
    const result = JSON.parse(String(run.stdout).trim())
    assert.equal(result.ok, true)
    assert.equal(result.hasText, false)
    assert.equal(result.text.trim(), '')
  })

  it('非法页码 / 非法 rect：code=bad-region 且非零退出', () => {
    for (const args of [[FIXTURE, '99', '10,10,100,100'], [FIXTURE, '4', '500,500,100,100']]) {
      const run = runRegion(args)
      assert.notEqual(run.status, 0)
      const result = JSON.parse(String(run.stdout).trim())
      assert.equal(result.ok, false)
      assert.equal(result.code, 'bad-region')
      assert.ok(result.message.length > 0)
    }
  })
})
