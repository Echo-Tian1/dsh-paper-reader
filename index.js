/**
 * 文献阅读坞 · 宿主半入口（DSH 插件 apply）
 *
 * 注册唯一 prefix 路由 /dsh-paper-reader，自行完成 URL 分发、请求体读取、
 * header 与响应体写入（不依赖任何中间件）：
 *
 *   GET  /api/health                   python / fitz / provider / model / storeDir
 *   GET  /api/docs                     文档列表 + ui.lastDocId
 *   POST /api/docs                     PDF 字节（application/pdf）或 {"path":"..."}
 *   GET  /api/docs/<id>/structure      章节 / 段落 / 句区间 / 页元数据
 *   GET  /api/docs/<id>/pages/<n>      该页逐词坐标
 *   GET  /api/docs/<id>/explanations   解释历史（?index=1 精简索引）
 *   POST /api/explain                  SSE 流式解释（缓存命中零 token）
 *   GET/POST /api/ui-state             最近打开的论文 / 每篇最后页码
 *   GET  /media/<id>/page-<n>.png      页图（1.5x，1 小时缓存）
 *   GET  /app/*                        阅读器静态页（no-store）
 *
 * 数据目录只落在 $DSH_HOME/plugin-data/paper-reader/ 下。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PaperError,
  countExplained,
  docPaths,
  isDocId,
  readExplanations,
  readIndex,
  readPage,
  readStructure,
  readTerms,
  readUiState,
  renderTermsMarkdown,
  storeDir,
  updateUiState,
} from './store.js'
import { ingestBytes, ingestPath, probePython, readJsonBody, readRequestBody } from './ingest.js'
import { serveExplain, serveRegion, serveTranslate } from './explain.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 插件注入的宿主服务：webServer 注册路由，llm 调模型。 */
export const inject = ['webServer', 'llm']

/** 所有 HTTP 路由挂在这个 prefix 下（CONTRACT §2）。 */
export const ROUTE_BASE = '/dsh-paper-reader'

/** 宿主半默认配置（profile 的 cordis.patch.yml 可覆盖）。 */
export const DEFAULTS = {
  provider: 'deepseek-official',
  model: 'deepseek-v4-flash',
  temperature: 0.3,
  maxTokens: 4096,
  reasoningEffort: 'off',
  pythonPath: 'python3',
  maxUploadMB: 80,
  extractTimeoutMs: 120_000,
}

/** 阅读器静态页默认目录（构建时与 index.js 同目录）。 */
export const DEFAULT_APP_DIR = path.join(HERE, 'app')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }

function respondJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function methodNotAllowed(res, method) {
  respondJson(res, 405, {
    ok: false,
    error: { code: 'method-not-allowed', message: `不支持的方法：${method}` },
  })
}

function sendError(res, error) {
  if (res.headersSent) {
    try { res.end() } catch { /* 客户端已断开 */ }
    return
  }
  if (error instanceof PaperError) {
    respondJson(res, error.status, { ok: false, error: { code: error.code, message: error.message } })
    return
  }
  const message = error instanceof Error ? error.message : String(error)
  console.error('[paper-reader] 宿主路由异常:', message)
  respondJson(res, 500, { ok: false, error: { code: 'internal', message: `宿主内部错误：${message}` } })
}

function maxBytesOf(config) {
  const mb = Number(config?.maxUploadMB)
  return Math.max(1, Number.isFinite(mb) ? mb : 80) * 1024 * 1024
}

function contentLength(req) {
  const raw = req.headers?.['content-length']
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/** 把请求 URL 归一化成 prefix 之后的路径（/api/...、/media/...、/app/...）。 */
function routePathOf(url) {
  let pathname
  try {
    pathname = new URL(url ?? '/', 'http://localhost').pathname
  } catch {
    return null
  }
  if (pathname === ROUTE_BASE) return '/'
  if (pathname.startsWith(`${ROUTE_BASE}/`)) return pathname.slice(ROUTE_BASE.length)
  return pathname
}

/**
 * 创建宿主半应用（不注册路由；apply 负责注册）。
 * 测试可以传假的 ctx / env / appDir 直接驱动 handler。
 *
 * @param {{ctx:object, config?:object, env?:object}} options
 * @returns {{handle:(req:object,res:object)=>Promise<void>, ready:Promise<object>, state:object, config:object}}
 */
export function createApp({ ctx, config = {}, env = process.env }) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const appDir = cfg.appDir ? path.resolve(cfg.appDir) : DEFAULT_APP_DIR
  const state = {
    probe: { ok: false, fitz: null, path: cfg.pythonPath, error: '探活尚未完成' },
  }
  const ready = probePython(cfg.pythonPath)
    .then(result => {
      state.probe = result
      if (!result.ok) {
        console.error(`[paper-reader] Python 不可用：${result.error ?? result.path}`)
      }
      return result
    })
    .catch(error => {
      state.probe = { ok: false, fitz: null, path: cfg.pythonPath, error: String(error?.message ?? error) }
      return state.probe
    })

  async function handleHealthGet(req, res) {
    await ready
    respondJson(res, 200, {
      ok: true,
      python: state.probe.ok === true,
      fitz: state.probe.ok ? state.probe.fitz : null,
      provider: cfg.provider,
      model: cfg.model,
      storeDir: storeDir(env),
    })
  }

  async function handleDocsGet(req, res) {
    const docs = await readIndex(env)
    const ui = await readUiState(env)
    const list = []
    for (const doc of docs) {
      const perDoc = ui.perDoc[doc.id] ?? {}
      list.push({
        ...doc,
        lastPage: Number.isInteger(perDoc.lastPage) ? perDoc.lastPage : (Number.isInteger(doc.lastPage) ? doc.lastPage : 1),
        lastOpenedAt: doc.lastOpenedAt ?? doc.addedAt ?? null,
        explained: await countExplained(doc.id, env),
      })
    }
    respondJson(res, 200, { docs: list, ui: { lastDocId: ui.lastDocId } })
  }

  async function handleDocsPost(req, res) {
    await ready
    if (!state.probe.ok) {
      throw new PaperError(
        'py-missing',
        `Python 或 PyMuPDF 不可用：${state.probe.error ?? '未知原因'}；请安装（pip3 install PyMuPDF）后重启 DSH`,
        503,
      )
    }
    const contentType = String(req.headers?.['content-type'] ?? '').toLowerCase()
    const limit = maxBytesOf(cfg)
    const declared = contentLength(req)
    if (declared !== null && declared > limit) {
      const mb = Math.max(1, Math.round(limit / (1024 * 1024)))
      throw new PaperError('too-big', `PDF 超过上传上限（${mb}MB）`, 413)
    }
    if (contentType.includes('application/pdf')) {
      const buffer = await readRequestBody(req, limit)
      const result = await ingestBytes(buffer, { env, config: cfg })
      respondJson(res, 200, { ok: true, reused: result.reused, doc: result.doc })
      return
    }
    if (contentType.includes('application/json')) {
      const body = await readJsonBody(req, 1024 * 1024)
      const result = await ingestPath(body?.path, { env, config: cfg })
      respondJson(res, 200, { ok: true, reused: result.reused, doc: result.doc })
      return
    }
    throw new PaperError('not-pdf', '只接受 PDF 文件（Content-Type: application/pdf）或 {"path":"..."}', 400)
  }

  async function handleStructure(req, res, id) {
    const structure = await readStructure(id, env)
    if (!structure) throw new PaperError('not-found', `找不到文档：${id}`, 404)
    respondJson(res, 200, structure)
  }

  async function handlePage(req, res, id, n) {
    const page = await readPage(id, n, env)
    if (!page) throw new PaperError('not-found', `找不到第 ${n} 页`, 404)
    respondJson(res, 200, page)
  }

  async function handleExplanations(req, res, id) {
    const structure = await readStructure(id, env)
    if (!structure) throw new PaperError('not-found', `找不到文档：${id}`, 404)
    const entries = (await readExplanations(id, env)).map(entry => ({
      // 兼容老数据：v1 条目没有 kind，读的时候一律按 explain 处理（不迁移、不报错）
      ...entry,
      kind: entry.kind ?? 'explain',
    }))
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.searchParams.get('index') === '1') {
      respondJson(res, 200, {
        index: entries.map(entry => ({
          id: entry.id,
          key: entry.key,
          paraId: entry.paraId,
          page: entry.page,
          selText: entry.selText,
          createdAt: entry.createdAt,
          hitCount: entry.hitCount,
          recipe: entry.recipe,
          kind: entry.kind,
          // 可选：段内字符区间（定位不到的解释条目没有这个字段）
          sent: entry.sent,
          // 可选：框选区域（kind=region 时用于在原文上画区域框）
          rect: entry.rect,
        })),
      })
      return
    }
    respondJson(res, 200, { entries })
  }

  /** GET /api/docs/<id>/terms：术语表（按 count 降序、updatedAt 降序）。 */
  async function handleTerms(req, res, id) {
    const structure = await readStructure(id, env)
    if (!structure) throw new PaperError('not-found', `找不到文档：${id}`, 404)
    respondJson(res, 200, { terms: await readTerms(id, env) })
  }

  /** GET /api/docs/<id>/terms.md：术语表 Markdown 导出。 */
  async function handleTermsMarkdown(req, res, id) {
    const structure = await readStructure(id, env)
    if (!structure) throw new PaperError('not-found', `找不到文档：${id}`, 404)
    const markdown = renderTermsMarkdown({ title: structure.title }, await readTerms(id, env))
    const buffer = Buffer.from(markdown, 'utf8')
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': buffer.length,
    })
    res.end(buffer)
  }

  async function handleMedia(req, res, id, n) {
    // doc 根镜像已按决策移除：页图统一读 pages/<n>.png
    const file = docPaths(id, env).pagePng(n)
    let buffer
    try {
      buffer = await fsp.readFile(file)
    } catch {
      throw new PaperError('not-found', `找不到第 ${n} 页图片`, 404)
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'cache-control': 'max-age=3600',
      'content-length': buffer.length,
    })
    res.end(buffer)
  }

  async function handleApp(req, res, pathname) {
    let relative = pathname.slice('/app'.length)
    if (relative === '' || relative === '/') relative = '/index.html'
    let decoded
    try {
      decoded = decodeURIComponent(relative)
    } catch {
      throw new PaperError('not-found', '静态资源路径非法', 404)
    }
    const name = decoded.replace(/^\/+/, '')
    if (!name || name.includes('..') || !/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new PaperError('not-found', '静态资源不存在', 404)
    }
    const extension = path.extname(name).toLowerCase()
    const mime = MIME[extension]
    if (!mime) throw new PaperError('not-found', '静态资源不存在', 404)
    const file = path.join(appDir, name)
    if (path.dirname(file) !== appDir) throw new PaperError('not-found', '静态资源不存在', 404)
    let buffer
    try {
      buffer = await fsp.readFile(file)
    } catch {
      throw new PaperError('not-found', '静态资源不存在', 404)
    }
    res.writeHead(200, {
      'content-type': mime,
      'cache-control': 'no-store',
      'content-length': buffer.length,
    })
    res.end(buffer)
  }

  async function route(req, res) {
    const pathname = routePathOf(req.url)
    if (pathname === null) throw new PaperError('bad-request', '请求路径非法', 400)
    const method = String(req.method ?? 'GET').toUpperCase()

    if (pathname === '/api/health') {
      if (method !== 'GET') return methodNotAllowed(res, method)
      await handleHealthGet(req, res)
      return
    }
    if (pathname === '/api/docs') {
      if (method === 'GET') return handleDocsGet(req, res)
      if (method === 'POST') return handleDocsPost(req, res)
      return methodNotAllowed(res, method)
    }
    if (pathname === '/api/explain') {
      if (method !== 'POST') return methodNotAllowed(res, method)
      await serveExplain({ ctx, config: cfg, env, req, res })
      return
    }
    if (pathname === '/api/translate') {
      if (method !== 'POST') return methodNotAllowed(res, method)
      await serveTranslate({ ctx, config: cfg, env, req, res })
      return
    }
    if (pathname === '/api/explain-region') {
      if (method !== 'POST') return methodNotAllowed(res, method)
      await serveRegion({ ctx, config: cfg, env, req, res })
      return
    }
    if (pathname === '/api/ui-state') {
      if (method === 'GET') {
        respondJson(res, 200, await readUiState(env))
        return
      }
      if (method === 'POST') {
        const patch = await readJsonBody(req, 1024 * 1024)
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          throw new PaperError('bad-request', 'ui-state 请求体必须是 JSON 对象', 400)
        }
        respondJson(res, 200, await updateUiState(patch, env))
        return
      }
      return methodNotAllowed(res, method)
    }

    const media = /^\/media\/([0-9a-f]{16})\/page-(\d+)\.png$/.exec(pathname)
    if (media) {
      if (method !== 'GET') return methodNotAllowed(res, method)
      return handleMedia(req, res, media[1], Number(media[2]))
    }
    const termsMd = /^\/api\/docs\/([0-9a-f]{16})\/terms\.md$/.exec(pathname)
    if (termsMd) {
      if (method !== 'GET') return methodNotAllowed(res, method)
      return handleTermsMarkdown(req, res, termsMd[1])
    }
    const terms = /^\/api\/docs\/([0-9a-f]{16})\/terms$/.exec(pathname)
    if (terms) {
      if (method !== 'GET') return methodNotAllowed(res, method)
      return handleTerms(req, res, terms[1])
    }
    const structure = /^\/api\/docs\/([0-9a-f]{16})\/structure$/.exec(pathname)
    if (structure) {
      if (method !== 'GET') return methodNotAllowed(res, method)
      return handleStructure(req, res, structure[1])
    }
    const page = /^\/api\/docs\/([0-9a-f]{16})\/pages\/(\d+)$/.exec(pathname)
    if (page) {
      if (method !== 'GET') return methodNotAllowed(res, method)
      return handlePage(req, res, page[1], Number(page[2]))
    }
    const explanations = /^\/api\/docs\/([0-9a-f]{16})\/explanations$/.exec(pathname)
    if (explanations) {
      if (method !== 'GET') return methodNotAllowed(res, method)
      return handleExplanations(req, res, explanations[1])
    }
    if (pathname === '/app' || pathname.startsWith('/app/')) {
      if (method !== 'GET') return methodNotAllowed(res, method)
      return handleApp(req, res, pathname)
    }

    // 形如 /api/docs/<非法 id>/... 的请求同样按 404 处理，避免信息泄露
    if (pathname.startsWith('/api/docs/') || pathname.startsWith('/media/')) {
      const maybeId = pathname.split('/')[3] ?? ''
      if (!isDocId(maybeId)) throw new PaperError('not-found', '文档不存在', 404)
    }
    throw new PaperError('not-found', `未知接口：${pathname}`, 404)
  }

  async function handle(req, res) {
    try {
      await route(req, res)
    } catch (error) {
      sendError(res, error)
    }
  }

  return { handle, ready, state, config: cfg, appDir }
}

/**
 * 插件入口：注册 prefix 路由。
 * @param {object} ctx DSH 宿主上下文
 * @param {object} config profile 配置（覆盖 DEFAULTS）
 */
export function apply(ctx, config) {
  const app = createApp({ ctx, config, env: process.env })
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_BASE,
    handler: app.handle,
  }))
  return app
}
