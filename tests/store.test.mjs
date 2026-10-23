/**
 * store.js 的契约测试：归一化、缓存键、原子落盘、索引、UI 状态、解释历史。
 *
 * 全部在临时 DSH_HOME 下跑，不碰真实 ~/.dsh。
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  RECIPE,
  appendExplanation,
  cacheKey,
  countExplained,
  docDir,
  docPaths,
  hashContext,
  isDocId,
  latestByKey,
  norm,
  readExplanations,
  readIndex,
  readJson,
  readUiState,
  storeDir,
  updateExplanation,
  updateIndex,
  updateUiState,
  writeIndex,
  writeJsonAtomic,
} from '../store.js'

const DOC_ID = 'a1b2c3d4e5f60718'

async function tempHome(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'pr-store-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

describe('路径', () => {
  it('storeDir 跟随 DSH_HOME，缺省落在 ~/.dsh', () => {
    assert.equal(storeDir({ DSH_HOME: '/tmp/dsh-home' }), path.join('/tmp/dsh-home', 'plugin-data', 'paper-reader'))
    assert.equal(storeDir({}), path.join(os.homedir(), '.dsh', 'plugin-data', 'paper-reader'))
  })

  it('docDir 只接受 16 位小写十六进制 id，拒绝路径穿越', () => {
    assert.equal(docDir(DOC_ID, { DSH_HOME: '/tmp/x' }), path.join('/tmp/x', 'plugin-data', 'paper-reader', 'docs', DOC_ID))
    assert.equal(isDocId(DOC_ID), true)
    for (const bad of ['', 'abc', '../evil', 'A1B2C3D4E5F60718', 'a1b2c3d4e5f607189', 'a1b2c3d4e5f6071g']) {
      assert.equal(isDocId(bad), false, `应拒绝非法 id：${bad}`)
      assert.throws(() => docDir(bad, { DSH_HOME: '/tmp/x' }), /文档 id/)
    }
  })

  it('docPaths 给出契约里的固定布局', () => {
    const env = { DSH_HOME: '/tmp/x' }
    const paths = docPaths(DOC_ID, env)
    const root = path.join('/tmp/x', 'plugin-data', 'paper-reader', 'docs', DOC_ID)
    assert.equal(paths.dir, root)
    assert.equal(paths.source, path.join(root, 'source.pdf'))
    assert.equal(paths.structure, path.join(root, 'structure.json'))
    assert.equal(paths.pagesDir, path.join(root, 'pages'))
    assert.equal(paths.explanations, path.join(root, 'explanations.json'))
    assert.equal(paths.pageJson(3), path.join(root, 'pages', '3.json'))
    assert.equal(paths.pagePng(3), path.join(root, 'pages', '3.png'))
    assert.equal(paths.pageMirror(3), path.join(root, 'page-3.png'))
  })
})

describe('归一化 norm()', () => {
  it('还原行尾连字符断行', () => {
    assert.equal(norm('transduc-\ntion models'), 'transduction models')
    assert.equal(norm('transduc-  \n  tion'), 'transduction')
  })

  it('弯引号统一为直单引号（双引号也变单引号，契约如此）', () => {
    assert.equal(norm('“hello” ‘world’'), "'hello' 'world'")
    assert.equal(norm('it’s'), "it's")
  })

  it('折叠空白并去首尾空白', () => {
    assert.equal(norm('  a \n\t  b   c  '), 'a b c')
    assert.equal(norm(''), '')
  })

  it('相同的归一化结果落到同一个缓存键', () => {
    const a = cacheKey(DOC_ID, RECIPE, norm('The  model archi-\ntecture'), 'p12')
    const b = cacheKey(DOC_ID, RECIPE, norm('The model architecture'), 'p12')
    assert.equal(a, b)
  })

  it('缓存键是 64 位十六进制，docId/paraId/recipe 任一变化都不同', () => {
    const base = cacheKey(DOC_ID, RECIPE, 'hello world', 'p12')
    assert.match(base, /^[0-9a-f]{64}$/)
    assert.notEqual(base, cacheKey('ffffffffffffffff', RECIPE, 'hello world', 'p12'))
    assert.notEqual(base, cacheKey(DOC_ID, 'v2', 'hello world', 'p12'))
    assert.notEqual(base, cacheKey(DOC_ID, RECIPE, 'hello world', 'p13'))
    assert.notEqual(base, cacheKey(DOC_ID, RECIPE, 'hello worlds', 'p12'))
  })

  it('上下文哈希稳定且随配方变化', () => {
    const a = hashContext('v1', 'sys', 'user text')
    assert.match(a, /^[0-9a-f]{64}$/)
    assert.equal(a, hashContext('v1', 'sys', 'user text'))
    assert.notEqual(a, hashContext('v2', 'sys', 'user text'))
  })
})

describe('latestByKey()', () => {
  it('同一 key 取 createdAt 最新的一条，不同 key 互不影响', () => {
    const entries = [
      { id: 'e3', key: 'k1', createdAt: '2026-01-03T00:00:00.000Z', supersedes: 'e2' },
      { id: 'e2', key: 'k1', createdAt: '2026-01-02T00:00:00.000Z', supersedes: 'e1' },
      { id: 'e1', key: 'k1', createdAt: '2026-01-01T00:00:00.000Z', supersedes: null },
      { id: 'e9', key: 'k2', createdAt: '2025-12-31T00:00:00.000Z', supersedes: null },
    ]
    const latest = latestByKey(entries)
    assert.equal(latest.size, 2)
    assert.equal(latest.get('k1').id, 'e3')
    assert.equal(latest.get('k1').supersedes, 'e2')
    assert.equal(latest.get('k2').id, 'e9')
  })

  it('createdAt 相同时保留数组中靠前的一条', () => {
    const entries = [
      { id: 'newer-first', key: 'k', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'older-second', key: 'k', createdAt: '2026-01-01T00:00:00.000Z' },
    ]
    assert.equal(latestByKey(entries).get('k').id, 'newer-first')
  })
})

describe('原子读写（tmp + rename）', () => {
  let home
  beforeEach(async t => {
    home = await tempHome(t)
  })

  it('writeJsonAtomic 落盘后可读回，且目录里不残留 .tmp', async () => {
    const file = path.join(home, 'nested', 'state.json')
    await writeJsonAtomic(file, { hello: '世界', n: 2 })
    assert.deepEqual(await readJson(file, null), { hello: '世界', n: 2 })
    const names = await readdir(path.join(home, 'nested'))
    assert.deepEqual(names, ['state.json'])
    const raw = await readFile(file, 'utf8')
    assert.ok(raw.endsWith('\n'), '落盘 JSON 应以换行结尾')
  })

  it('覆盖写是原子的：旧文件先不在，rename 后完整替换', async () => {
    const file = path.join(home, 'a.json')
    await writeJsonAtomic(file, { v: 1 })
    await writeJsonAtomic(file, { v: 2, padding: 'x'.repeat(1024) })
    assert.deepEqual(await readJson(file, null), { v: 2, padding: 'x'.repeat(1024) })
  })

  it('readJson 对缺失文件和损坏 JSON 返回 fallback', async () => {
    assert.deepEqual(await readJson(path.join(home, 'nope.json'), { fallback: true }), { fallback: true })
    const broken = path.join(home, 'broken.json')
    await writeFile(broken, '{ not json', 'utf8')
    assert.deepEqual(await readJson(broken, []), [])
  })
})

describe('文档索引 index.json', () => {
  it('updateIndex 追加、按 id 去重，readIndex 返回数组', async t => {
    const env = { DSH_HOME: await tempHome(t) }
    assert.deepEqual(await readIndex(env), [])
    await updateIndex(env, docs => [
      { id: DOC_ID, title: 'A', pageCount: 15, addedAt: 't1', lastOpenedAt: 't1', lastPage: 1, explained: 0 },
    ])
    await updateIndex(env, docs => [
      { id: DOC_ID, title: 'A2', pageCount: 15, addedAt: 't1', lastOpenedAt: 't2', lastPage: 3, explained: 2 },
      { id: 'ffffffffffffffff', title: 'B', pageCount: 1, addedAt: 't2', lastOpenedAt: 't2', lastPage: 1, explained: 0 },
    ])
    const docs = await readIndex(env)
    assert.equal(docs.length, 2)
    assert.equal(docs.find(doc => doc.id === DOC_ID).title, 'A2')
    assert.equal(docs.find(doc => doc.id === DOC_ID).lastPage, 3)
    const raw = JSON.parse(await readFile(path.join(storeDir(env), 'index.json'), 'utf8'))
    assert.ok(Array.isArray(raw), 'index.json 按设计文档存为数组')
  })

  it('writeIndex 整体替换，顺序保留', async t => {
    const env = { DSH_HOME: await tempHome(t) }
    await writeIndex([
      { id: 'aaaaaaaaaaaaaaaa', title: '1' },
      { id: 'bbbbbbbbbbbbbbbb', title: '2' },
    ], env)
    assert.deepEqual((await readIndex(env)).map(doc => doc.title), ['1', '2'])
  })
})

describe('UI 状态 ui-state.json', () => {
  it('缺省形状与浅合并写入', async t => {
    const env = { DSH_HOME: await tempHome(t) }
    assert.deepEqual(await readUiState(env), { lastDocId: null, perDoc: {} })
    await updateUiState({ lastDocId: DOC_ID, perDoc: { [DOC_ID]: { lastPage: 3, scrollTop: 812 } } }, env)
    await updateUiState({ perDoc: { [DOC_ID]: { lastPage: 4 } } }, env)
    const state = await readUiState(env)
    assert.equal(state.lastDocId, DOC_ID)
    assert.deepEqual(state.perDoc[DOC_ID], { lastPage: 4, scrollTop: 812 })
  })
})

describe('解释历史 explanations.json', () => {
  function entry(id, key, createdAt, extra = {}) {
    return {
      id,
      key,
      recipe: RECIPE,
      selText: 'sel',
      normText: 'sel',
      docId: DOC_ID,
      page: 1,
      paraId: 'p1',
      sectionId: 's1',
      contextHash: 'c',
      provider: 'p',
      model: 'm',
      answer: 'answer',
      createdAt,
      hitCount: 0,
      lastHitAt: null,
      supersedes: null,
      ...extra,
    }
  }

  it('追加式：最新在前，重复追加不覆盖旧条目', async t => {
    const env = { DSH_HOME: await tempHome(t) }
    assert.deepEqual(await readExplanations(DOC_ID, env), [])
    await appendExplanation(DOC_ID, entry('e_1', 'k1', '2026-01-01T00:00:00.000Z'), env)
    await appendExplanation(DOC_ID, entry('e_2', 'k2', '2026-01-02T00:00:00.000Z'), env)
    const entries = await readExplanations(DOC_ID, env)
    assert.deepEqual(entries.map(item => item.id), ['e_2', 'e_1'])
    assert.equal(await countExplained(DOC_ID, env), 2)
  })

  it('updateExplanation 可递增 hitCount 并写 lastHitAt', async t => {
    const env = { DSH_HOME: await tempHome(t) }
    await appendExplanation(DOC_ID, entry('e_1', 'k1', '2026-01-01T00:00:00.000Z'), env)
    const updated = await updateExplanation(DOC_ID, 'e_1', { hitCount: 1, lastHitAt: '2026-01-03T00:00:00.000Z' }, env)
    assert.equal(updated.hitCount, 1)
    const [saved] = await readExplanations(DOC_ID, env)
    assert.equal(saved.hitCount, 1)
    assert.equal(saved.lastHitAt, '2026-01-03T00:00:00.000Z')
    await assert.rejects(() => updateExplanation(DOC_ID, 'e_missing', { hitCount: 9 }, env), /解释条目/)
  })

  it('force 重新解释：新条目 supersedes 旧条目，latestByKey 取新', async t => {
    const env = { DSH_HOME: await tempHome(t) }
    await appendExplanation(DOC_ID, entry('e_1', 'k1', '2026-01-01T00:00:00.000Z'), env)
    await appendExplanation(DOC_ID, entry('e_2', 'k1', '2026-01-02T00:00:00.000Z', { supersedes: 'e_1' }), env)
    const entries = await readExplanations(DOC_ID, env)
    assert.equal(entries.length, 2)
    assert.equal(latestByKey(entries).get('k1').id, 'e_2')
    assert.equal(latestByKey(entries).get('k1').supersedes, 'e_1')
  })
})
