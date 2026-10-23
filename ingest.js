/**
 * 文献阅读坞 · 宿主半收件与抽取
 *
 * 职责：
 *  - 校验上传（魔数 %PDF-、大小上限、JSON 路径必须绝对/存在/.pdf）；
 *  - 按 sha256 前 16 位去重，同一 PDF 重复上传秒开（reused:true）；
 *  - 落临时 PDF → spawn python3 extract.py → 成功后移动 source.pdf、更新索引；
 *  - 失败清理 tmp 与半成品目录，抛带 code 的 PaperError（路由层映射成中文错误）。
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  PaperError,
  docPaths,
  readIndex,
  readStructure,
  readUiState,
  sha256Bytes,
  storeDir,
  tmpDir,
  updateUiState,
  upsertDoc,
} from './store.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** extract.py 与本文件同目录（插件包根）。 */
export const EXTRACT_SCRIPT = path.join(HERE, 'extract.py')

/** 抽取子进程 stderr 最多带回给用户的字节数（避免把整页日志塞进 HTTP）。 */
const STDERR_TAIL_BYTES = 8 * 1024

/** 读取请求体（不依赖任何中间件）；超过上限抛 too-big。 */
export function readRequestBody(req, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const cleanup = () => {
      req.off?.('data', onData)
      req.off?.('end', onEnd)
      req.off?.('error', onError)
    }
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }
    const onData = chunk => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > limitBytes) {
        const mb = Math.max(1, Math.round(limitBytes / (1024 * 1024)))
        settle(reject, new PaperError('too-big', `上传内容超过上限（${mb}MB）`, 413))
        // 不再读剩余字节，但把流排空，保证错误响应能正常写回
        req.resume?.()
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => settle(resolve, Buffer.concat(chunks))
    const onError = error => settle(reject, error)
    req.on('data', onData)
    req.on('end', onEnd)
    req.on('error', onError)
  })
}

/** 解析 JSON 请求体并做上限保护。 */
export async function readJsonBody(req, limitBytes = 1024 * 1024) {
  const buffer = await readRequestBody(req, limitBytes)
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new PaperError('bad-request', '请求体不是合法 JSON', 400)
  }
}

/**
 * 通用：跑一次 python 助手脚本，解析 stdout 最后一行的 JSON。
 * 超时 / 非零退出 / 加密 / python 缺失都映射成带 code 的 PaperError。
 * @param {{pythonPath:string,args:string[],timeoutMs:number,label:string}} options
 */
function runPythonJson({ pythonPath, args, timeoutMs = 120_000, label = '抽取' }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(pythonPath, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new PaperError('py-missing', `无法启动 Python（${pythonPath}）：${error.message}`, 503))
      return
    }
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, Math.max(1000, Number(timeoutMs) || 120_000))

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length
      if (stdoutBytes <= 64 * 1024) stdout.push(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr.push(chunk)
      while (stderr.length > 64) stderr.shift()
    })
    child.on('error', error => {
      const message = error && error.code === 'ENOENT'
        ? `找不到 Python 解释器：${pythonPath}`
        : `Python 进程启动失败：${error.message}`
      finish(reject, new PaperError('py-missing', message, 503))
    })
    child.on('close', code => {
      const stdoutText = Buffer.concat(stdout).toString('utf8').trim()
      const stderrText = Buffer.concat(stderr).toString('utf8').trim()
      if (timedOut) {
        finish(reject, new PaperError('extract-failed', `${label}超时（${timeoutMs}ms），已终止`, 500))
        return
      }
      let summary = null
      try {
        summary = JSON.parse(stdoutText.split('\n').filter(Boolean).pop() ?? '')
      } catch {
        summary = null
      }
      if (code === 0 && summary && summary.ok === true) {
        finish(resolve, summary)
        return
      }
      const tail = stderrText.split('\n').slice(-40).join('\n').slice(-STDERR_TAIL_BYTES)
      if (summary && summary.code === 'encrypted') {
        finish(reject, new PaperError('encrypted', summary.message || '这是加密 PDF，无法抽取文字', 422))
        return
      }
      const detail = summary?.message || tail || `脚本退出码 ${code}`
      finish(reject, new PaperError('extract-failed', `${label}失败：${detail}`, 500))
    })
  })
}

/**
 * 全量抽取：extract.py <pdf> <outDir>。
 * @returns {Promise<{pageCount:number,paras:number,sections:number,words:number,warnings:string[]}>}
 */
export function runExtract({ pythonPath, pdfPath, outDir, timeoutMs = 120_000 }) {
  return runPythonJson({
    pythonPath,
    args: [EXTRACT_SCRIPT, pdfPath, outDir],
    timeoutMs,
    label: '抽取',
  })
}

/**
 * 链接回填：extract.py --links-only <pdf> <outDir>，只重建 links.json（不重跑页图/切句）。
 * 老文档惰性回填用；实测夹具约 0.14s。
 * @returns {Promise<{pageCount:number,links:number}>}
 */
export function extractLinksOnly({ pythonPath, pdfPath, outDir, timeoutMs = 120_000 }) {
  return runPythonJson({
    pythonPath: pythonPath || 'python3',
    args: [EXTRACT_SCRIPT, '--links-only', pdfPath, outDir],
    timeoutMs,
    label: '链接回填',
  })
}

/**
 * 框选区域文字层：extract.py --region <pdf> <page> <x0,y0,x1,y1>（一次性子进程，无守护）。
 * @returns {Promise<{page:number,rect:number[],hasText:boolean,text:string}>}
 */
export function extractRegion({ pythonPath, pdfPath, page, rect, timeoutMs = 120_000 }) {
  const rectArg = (Array.isArray(rect) ? rect : []).map(value => Number(value)).join(',')
  return runPythonJson({
    pythonPath: pythonPath || 'python3',
    args: [EXTRACT_SCRIPT, '--region', pdfPath, String(page), rectArg],
    timeoutMs,
    label: '区域抽取',
  })
}

/** 探活 python3 + PyMuPDF；不抛错，失败也返回结构化结果。 */
export function probePython(pythonPath) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(pythonPath, ['-c', 'import fitz; print(fitz.VersionBind)'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, fitz: null, path: pythonPath, error: `无法启动 Python：${error.message}` })
      return
    }
    const stdout = []
    const stderr = []
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    child.stdout.on('data', chunk => stdout.push(chunk))
    child.stderr.on('data', chunk => stderr.push(chunk))
    child.on('error', error => {
      finish({
        ok: false,
        fitz: null,
        path: pythonPath,
        error: error && error.code === 'ENOENT'
          ? `找不到 Python 解释器：${pythonPath}`
          : `Python 启动失败：${error.message}`,
      })
    })
    child.on('close', code => {
      const version = Buffer.concat(stdout).toString('utf8').trim()
      if (code === 0 && version) {
        finish({ ok: true, fitz: version, path: pythonPath, error: null })
        return
      }
      const tail = Buffer.concat(stderr).toString('utf8').trim().split('\n').slice(-3).join('\n')
      finish({
        ok: false,
        fitz: null,
        path: pythonPath,
        error: tail || `Python 退出码 ${code}；请确认已安装 PyMuPDF（pip3 install PyMuPDF）`,
      })
    })
  })
}

function isPdfMagic(buffer) {
  return buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-'
}

function maxBytesOf(config) {
  const mb = Number(config?.maxUploadMB)
  return Math.max(1, Number.isFinite(mb) ? mb : 80) * 1024 * 1024
}

/** 文档目录是否已有完整抽取产物（structure.json + source.pdf）。 */
async function isComplete(id, env) {
  const paths = docPaths(id, env)
  const structure = await readStructure(id, env)
  if (!structure) return false
  try {
    await fsp.stat(paths.source)
    return true
  } catch {
    return false
  }
}

/** 已存在的文档：更新最近打开时间与 UI 状态，返回索引条目。 */
async function reuseDoc(id, env) {
  const docs = await readIndex(env)
  const now = new Date().toISOString()
  let doc = docs.find(item => item.id === id)
  if (!doc) {
    const structure = await readStructure(id, env)
    doc = {
      id,
      title: structure?.title ?? '',
      pageCount: structure?.pageCount ?? structure?.pages?.length ?? 0,
      addedAt: now,
      lastOpenedAt: now,
      lastPage: 1,
      explained: 0,
    }
  }
  doc = { ...doc, lastOpenedAt: now }
  await upsertDoc(doc, env)
  const ui = await readUiState(env)
  const perDoc = { ...(ui.perDoc[id] ?? {}) }
  if (!Number.isInteger(perDoc.lastPage)) perDoc.lastPage = Number.isInteger(doc.lastPage) ? doc.lastPage : 1
  await updateUiState({ lastDocId: id, perDoc: { [id]: perDoc } }, env)
  return doc
}

/** 同一 id 的抽取串行化，避免两个上传同时写同一目录。 */
const locks = new Map()
function withLock(id, task) {
  const previous = locks.get(id) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  locks.set(id, next)
  next.finally(() => {
    if (locks.get(id) === next) locks.delete(id)
  }).catch(() => {})
  return next
}

/** 抽取一个全新文档：临时 PDF → extract.py 写入 docs/<id> → source.pdf → 索引。 */
async function ingestNew(buffer, id, { env, config }) {
  const paths = docPaths(id, env)
  const pythonPath = config.pythonPath || 'python3'
  // 目标目录不能有半成品：宁可删掉重抽
  await fsp.rm(paths.dir, { recursive: true, force: true })
  const tempPdf = path.join(tmpDir(env), `${id}-${randomBytes(4).toString('hex')}.pdf`)
  await fsp.mkdir(path.dirname(tempPdf), { recursive: true })
  await fsp.writeFile(tempPdf, buffer)
  let summary
  try {
    summary = await runExtract({ pythonPath, pdfPath: tempPdf, outDir: paths.dir, timeoutMs: config.extractTimeoutMs })
  } catch (error) {
    await fsp.rm(tempPdf, { force: true }).catch(() => {})
    await fsp.rm(paths.dir, { recursive: true, force: true }).catch(() => {})
    throw error
  }
  try {
    // rename 原子落成 source.pdf（tmp 与 docs 同在 storeDir 下，正常同设备）
    try {
      await fsp.rename(tempPdf, paths.source)
    } catch {
      await fsp.copyFile(tempPdf, paths.source)
    }
  } finally {
    await fsp.rm(tempPdf, { force: true }).catch(() => {})
  }

  const structure = await readStructure(id, env)
  const now = new Date().toISOString()
  const doc = {
    id,
    title: structure?.title ?? '',
    pageCount: structure?.pageCount ?? summary.pageCount,
    addedAt: now,
    lastOpenedAt: now,
    lastPage: 1,
    explained: 0,
  }
  await upsertDoc(doc, env)
  await updateUiState({ lastDocId: id, perDoc: { [id]: { lastPage: 1 } } }, env)
  return doc
}

/**
 * 收原始 PDF 字节。
 * @param {Buffer} buffer PDF 字节
 * @param {{env?:object, config?:object}} options
 * @returns {Promise<{reused:boolean, doc:object}>}
 */
export async function ingestBytes(buffer, { env = process.env, config = {} } = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new PaperError('not-pdf', '上传内容为空', 400)
  }
  if (!isPdfMagic(buffer)) {
    throw new PaperError('not-pdf', '不是 PDF 文件（缺少 %PDF- 魔数）', 400)
  }
  const limit = maxBytesOf(config)
  if (buffer.length > limit) {
    const mb = Math.max(1, Math.round(limit / (1024 * 1024)))
    throw new PaperError('too-big', `PDF 超过上传上限（${mb}MB）`, 413)
  }
  const id = sha256Bytes(buffer).slice(0, 16)

  return withLock(id, async () => {
    if (await isComplete(id, env)) {
      return { reused: true, doc: await reuseDoc(id, env) }
    }
    return { reused: false, doc: await ingestNew(buffer, id, { env, config }) }
  })
}

/**
 * 收本机绝对路径。
 * @param {string} filePath 绝对路径，必须是存在的 .pdf
 */
export async function ingestPath(filePath, { env = process.env, config = {} } = {}) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !/\.pdf$/i.test(filePath)) {
    throw new PaperError('bad-path', '路径必须是绝对路径且以 .pdf 结尾', 400)
  }
  let info
  try {
    info = await fsp.stat(filePath)
  } catch {
    throw new PaperError('bad-path', `文件不存在：${filePath}`, 400)
  }
  if (!info.isFile()) throw new PaperError('bad-path', `不是普通文件：${filePath}`, 400)
  const limit = maxBytesOf(config)
  if (info.size > limit) {
    const mb = Math.max(1, Math.round(limit / (1024 * 1024)))
    throw new PaperError('too-big', `PDF 超过上传上限（${mb}MB）`, 413)
  }
  const buffer = await fsp.readFile(filePath)
  return ingestBytes(buffer, { env, config })
}

/** 便于测试与 health：当前数据目录。 */
export function dataDir(env = process.env) {
  return storeDir(env)
}
