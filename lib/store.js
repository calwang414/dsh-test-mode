/**
 * dsh-test-mode 存储层:工作区级共享 test-mode/ 目录的 JSON 文件存储。
 *
 * 目录结构:
 * ```text
 * <workspace>/test-mode/
 * ├── cases/              测试用例(每用例一个 JSON 文件)
 * ├── api/projects/       API 项目(每项目一个 JSON,含 collections/requests)
 * ├── api/environments/   环境变量(每环境一个 JSON)
 * ├── api/history.json    执行历史(追加式,截断到上限)
 * ├── results/            插件测试运行结果(每轮一个 JSON)
 * └── reports/            执行报告(每份一个 JSON)
 * ```
 *
 * 并发安全:每个文件路径一把操作锁(串行化读改写),写盘走原子写
 * (临时文件 + rename),失败不落盘。路径全部通过 verifiedWritePath
 * 校验,拒绝越界/符号链接逃逸。
 * @module @calwang414/dsh-test-mode/store
 */

import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

/** 执行历史保留条数上限。 */
const HISTORY_LIMIT = 200

/** 请求体大小上限(1 MiB)。 */
const MAX_TEXT_BYTES = 1024 * 1024

/** 每个路径的操作锁队列:path → 前一个操作的 Promise。 */
const locks = new Map()

function errorCode(error) {
  if (!error || typeof error !== 'object') return ''
  const code = error.code
  return typeof code === 'string' ? code : ''
}

/** 串行化同一路径的读改写操作。 */
async function withLock(key, operation) {
  const previous = locks.get(key) ?? Promise.resolve()
  let release
  const current = new Promise((resolvePromise) => { release = resolvePromise })
  locks.set(key, previous.then(() => current))
  await previous
  try {
    return await operation()
  } finally {
    release()
    if (locks.get(key) === previous.then(() => current)) locks.delete(key)
  }
}

/**
 * 校验并解析一个相对 test-mode/ 的文件路径,拒绝越界。
 * @param value - 请求里的相对路径。
 * @returns 归一化后的相对路径。
 * @throws 路径非法时抛错。
 */
export function safeRelativePath(value, prefix = '') {
  const normalized = String(value ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  if (!normalized || isAbsolute(normalized) || normalized.includes('\0')) {
    throw new Error('invalid test-mode path')
  }
  if (normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('invalid test-mode path')
  }
  const prefixRoot = prefix.replace(/\/+$/, '')
  if (prefixRoot && normalized !== prefixRoot && !normalized.startsWith(`${prefixRoot}/`)) {
    throw new Error(`test-mode path is outside ${prefixRoot}`)
  }
  return normalized
}

function inside(root, target) {
  const path = relative(root, target)
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

/**
 * 校验写入路径(逐段建目录,拒绝符号链接逃逸),返回绝对路径。
 * 根目录先 realpath 规范化,避免 macOS 上 /var → /private/var 之类的
 * 符号链接导致合法的 workspace 路径被误判越界。
 * @param root - test-mode 根目录。
 * @param requested - 相对路径。
 * @returns 可安全写入的绝对路径。
 */
export async function verifiedWritePath(root, requested) {
  // 根目录可能尚不存在(首次写入):先创建再 realpath,保证规范前缀一致。
  let canonicalRoot = await realpathSafe(root)
  if (canonicalRoot === root) {
    await mkdir(root, { recursive: true })
    canonicalRoot = await realpathSafe(root)
  }
  const relativePath = safeRelativePath(requested)
  const target = resolve(canonicalRoot, relativePath)
  if (!inside(canonicalRoot, target)) throw new Error('test-mode path escaped the workspace')
  let canonicalParent = canonicalRoot
  for (const segment of relativePath.split('/').slice(0, -1)) {
    const next = resolve(canonicalParent, segment)
    const existing = await lstatSafe(next)
    if (!existing) await mkdir(next, { recursive: true })
    else if (!existing.isDirectory() && !existing.isSymbolicLink()) throw new Error('a test-mode folder path is not a directory')
    canonicalParent = await realpathSafe(next)
    if (!inside(canonicalRoot, canonicalParent)) throw new Error('symbolic links outside the workspace are not allowed')
  }
  return resolve(canonicalParent, basename(target))
}

async function lstatSafe(path) {
  return lstat(path).catch((error) => {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  })
}

async function realpathSafe(path) {
  return realpath(path).catch((error) => {
    if (errorCode(error) === 'ENOENT') return path
    throw error
  })
}

/** 原子写文件(临时文件 + rename),失败不落盘。 */
async function atomicWrite(path, content) {
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' })
    await rename(temporary, path)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
}

/**
 * 读取一个 JSON 文件;不存在时返回 undefined。
 * @param root - test-mode 根目录。
 * @param rel - 相对路径。
 * @returns 解析后的值,或 undefined。
 */
export async function readJson(root, rel) {
  const path = await verifiedWritePath(root, rel)
  const text = await readFile(path, 'utf8').catch((error) => {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  })
  if (text === null) return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`test-mode file ${rel} is not valid JSON`)
  }
}

/**
 * 原子写一个 JSON 文件(带操作锁)。
 * @param root - test-mode 根目录。
 * @param rel - 相对路径。
 * @param value - 要写入的值。
 */
export async function writeJson(root, rel, value) {
  const key = `${root}:${rel}`
  return withLock(key, async () => {
    const path = await verifiedWritePath(root, rel)
    await atomicWrite(path, JSON.stringify(value, null, 2))
  })
}

/**
 * 读改写一个 JSON 文件(带操作锁,串行化)。
 * @param root - test-mode 根目录。
 * @param rel - 相对路径。
 * @param mutate - 对当前值(可能 undefined)做修改,返回新值。
 * @param seed - 文件不存在时的初始值。
 * @returns 修改后的值。
 */
export async function mutateJson(root, rel, mutate, seed) {
  const key = `${root}:${rel}`
  return withLock(key, async () => {
    const path = await verifiedWritePath(root, rel)
    const text = await readFile(path, 'utf8').catch((error) => {
      if (errorCode(error) === 'ENOENT') return null
      throw error
    })
    let current = text === null ? seed : JSON.parse(text)
    const next = await mutate(current)
    await atomicWrite(path, JSON.stringify(next, null, 2))
    return next
  })
}

/**
 * 列出目录下的 JSON 文件(去扩展名),不存在时返回空数组。
 * @param root - test-mode 根目录。
 * @param rel - 相对目录。
 */
export async function listJsonFiles(root, rel) {
  const path = await verifiedWritePath(root, rel)
  const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  })
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.replace(/\.json$/, ''))
}

/**
 * 删除一个 JSON 文件(带操作锁);不存在时静默成功。
 * @param root - test-mode 根目录。
 * @param rel - 相对路径。
 */
export async function deleteJson(root, rel) {
  const key = `${root}:${rel}`
  return withLock(key, async () => {
    const path = await verifiedWritePath(root, rel)
    await unlink(path).catch((error) => {
      if (errorCode(error) !== 'ENOENT') throw error
    })
  })
}

/**
 * 追加一条执行历史(截断到 HISTORY_LIMIT)。
 * @param root - test-mode 根目录。
 * @param entry - 历史条目。
 */
export async function appendHistory(root, entry) {
  const next = await mutateJson(
    root,
    'api/history.json',
    (current) => [...(current ?? []), entry].slice(-HISTORY_LIMIT),
    [],
  )
  return next
}

/** 读取执行历史(不存在时返回空数组)。 */
export async function readHistory(root) {
  return (await readJson(root, 'api/history.json')) ?? []
}

/** 生成一个新的实体 id(如 case-xxx / proj-xxx)。 */
export function newId(prefix) {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

/** 生成时间戳(ISO)。 */
export function nowIso() {
  return new Date().toISOString()
}

/** 读取请求体并解析为 JSON;超限或非法抛错。 */
export async function requestJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_TEXT_BYTES) throw new Error('test-mode request is too large')
    chunks.push(buffer)
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object')
    return value
  } catch {
    throw new Error('invalid JSON request')
  }
}

/**
 * 定位工作区的 test-mode 根目录。
 * @param ctx - 插件上下文(workspaceRegistry 服务)。
 * @param workspaceId - 工作区 id。
 * @returns test-mode 目录绝对路径。
 * @throws 工作区不存在时抛错。
 */
export function testModeRoot(ctx, workspaceId) {
  const workspace = ctx.workspaceRegistry.get(workspaceId)
  if (!workspace) throw new Error(`workspace "${workspaceId}" was not found`)
  return resolve(workspace.path, 'test-mode')
}
