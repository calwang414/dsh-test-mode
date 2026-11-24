/**
 * 报告体积治理:写入时截断超大字段、用侧车索引支撑列表/对比/统计,
 * 旧报告(无侧车索引)按需在子进程中裁剪后缓存。
 *
 * 背景:一次集合/计划执行可能包含大量 `json` 断言,其 `actual` 是完整响应体
 * (可能是几十万条记录的数组);原实现原样写盘,单份报告可达数百 MB,而
 * `GET /api/reports` 会逐个读取完整报告 —— 打开报告页即把宿主内存打爆。
 *
 * 约定:
 * - `reports/<id>.json`      报告正文(写入时已截断大字段);
 * - `reports/index/<id>.json` 侧车索引(列表/对比/统计/失败重跑所需的紧凑信息);
 * - `reports/trimmed/<id>.json` 旧大报告的裁剪缓存(按需生成)。
 * @module @calwang414/dsh-test-mode/reports
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listJsonFiles, readJson, writeJson } from './store.js'

/** 报告正文超过此大小时,单份详情改为读取裁剪缓存。 */
export const REPORT_VIEW_LIMIT_BYTES = 8 * 1024 * 1024
/** 字符串字段截断长度。 */
const TEXT_CAP = 2000
/** 旧报告裁剪子进程的内存上限(旧报告可能数百 MB,JSON.parse 需要大堆)。 */
const TRIM_CHILD_HEAP_MB = 8192
/** 裁剪子进程超时。 */
const TRIM_TIMEOUT_MS = 300_000

/**
 * 截断单个值:短字符串/小对象原样保留;超长字符串截断;超大对象/数组改为
 * `{ truncated, size, preview }` 摘要。
 * @param value - 任意 JSON 值。
 * @returns 截断后的值。
 */
export function capValue(value) {
  if (typeof value === 'string') {
    if (value.length <= TEXT_CAP) return value
    return `${value.slice(0, TEXT_CAP)}…[truncated ${value.length - TEXT_CAP} chars]`
  }
  if (value === null || value === undefined || typeof value !== 'object') return value
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
  if (serialized === undefined || serialized.length <= TEXT_CAP) return value
  return { truncated: true, size: serialized.length, preview: serialized.slice(0, TEXT_CAP) }
}

/**
 * 截断报告正文里的超大字段(断言 actual、error、detail、uiSteps、diagnostics、exports)。
 * @param record - 报告记录。
 * @returns 截断后的新记录。
 */
export function trimReport(record) {
  if (record === null || typeof record !== 'object') return record
  const next = { ...record }
  if (Array.isArray(next.results)) {
    next.results = next.results.map((result) => {
      if (result === null || typeof result !== 'object') return result
      const trimmed = { ...result }
      if (Array.isArray(trimmed.assertions)) {
        trimmed.assertions = trimmed.assertions.map((assertion) =>
          assertion !== null && typeof assertion === 'object'
            ? { ...assertion, actual: capValue(assertion.actual) }
            : assertion)
      }
      for (const field of ['error', 'detail', 'value', 'uiSteps', 'diagnostics']) {
        if (field in trimmed) trimmed[field] = capValue(trimmed[field])
      }
      return trimmed
    })
  }
  if (next.exports !== null && typeof next.exports === 'object') {
    next.exports = Object.fromEntries(Object.entries(next.exports).map(([key, value]) => [key, capValue(value)]))
  }
  return next
}

/**
 * 生成侧车索引:列表/对比/统计/失败重跑所需的紧凑信息(不含大字段)。
 * @param record - 已截断的报告记录。
 * @returns 侧车索引对象。
 */
export function buildReportSidecar(record) {
  const results = (record.results ?? []).map((result) => {
    const failedAssertions = Array.isArray(result.assertions)
      ? result.assertions
        .filter((assertion) => assertion?.pass === false)
        .map((assertion) => ({
          type: assertion.type,
          operator: assertion.operator,
          expected: capValue(assertion.expected),
          actual: capValue(assertion.actual),
          path: assertion.path,
          header: assertion.header,
        }))
      : []
    return {
      method: typeof result.method === 'string' ? result.method.toUpperCase() : undefined,
      url: result.url,
      name: result.name,
      pass: typeof result.pass === 'boolean' ? result.pass : null,
      status: result.status,
      durationMs: result.durationMs ?? 0,
      caseId: result.caseId,
      projectId: result.projectId,
      scriptId: result.scriptId,
      collectionId: result.collectionId,
      failedAssertions,
    }
  })
  return {
    id: record.id,
    kind: record.kind,
    name: record.name ?? record.kind,
    planId: record.planId,
    caseId: record.caseId,
    scriptId: record.scriptId,
    projectId: record.projectId,
    collectionId: record.collectionId,
    createdAt: record.createdAt ?? '',
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs ?? 0,
    summary: record.summary ?? { total: 0, passed: 0, failed: 0 },
    results,
    failedResults: results.filter((item) => item.pass === false),
    entriesSnapshot: Array.isArray(record.entriesSnapshot) ? record.entriesSnapshot : undefined,
    driver: record.driver,
  }
}

/**
 * 保存报告:截断大字段后写正文 + 写侧车索引。
 * @param root - test-mode 根目录。
 * @param record - 报告记录。
 * @returns 实际落盘的(已截断)报告记录。
 */
export async function saveReport(root, record) {
  const trimmed = trimReport(record)
  await writeJson(root, `reports/${record.id}.json`, trimmed)
  await writeJson(root, `reports/index/${record.id}.json`, buildReportSidecar(trimmed))
  return trimmed
}

/**
 * 读取全部侧车索引(内部用:列表/基线/失败重跑/统计);无侧车的旧报告补一条
 * 仅含 id/时间/大小的 stub,不解析正文。
 * @param root - test-mode 根目录。
 * @returns 侧车索引数组(按 createdAt 倒序)。
 */
export async function listReportSidecars(root) {
  const sidecars = []
  const indexed = new Set()
  try {
    const names = await readdir(resolve(root, 'reports/index'))
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const item = JSON.parse(await readFile(join(root, 'reports/index', name), 'utf8'))
        if (item?.id) {
          sidecars.push(item)
          indexed.add(item.id)
        }
      } catch {
        // 侧车损坏时跳过,正文仍在
      }
    }
  } catch {
    // 还没有索引目录
  }
  for (const id of await listJsonFiles(root, 'reports')) {
    if (indexed.has(id)) continue
    let createdAt = ''
    let size = 0
    try {
      const info = await stat(resolve(root, `reports/${id}.json`))
      createdAt = info.mtime.toISOString()
      size = info.size
    } catch {
      continue
    }
    sidecars.push({
      id,
      kind: 'legacy',
      name: '旧报告(未建索引)',
      createdAt,
      durationMs: 0,
      summary: null,
      results: [],
      failedResults: [],
      legacy: true,
      size,
    })
  }
  return sidecars.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
}

/**
 * 列表接口用的摘要:去掉 results/failedResults 等大字段。
 * @param root - test-mode 根目录。
 * @returns 报告摘要数组。
 */
export async function listReportSummaries(root) {
  const sidecars = await listReportSidecars(root)
  return sidecars.map((item) => ({
    id: item.id,
    kind: item.kind,
    name: item.name,
    createdAt: item.createdAt,
    startedAt: item.startedAt,
    finishedAt: item.finishedAt,
    durationMs: item.durationMs,
    summary: item.summary,
    driver: item.driver,
    legacy: item.legacy === true,
    size: item.size,
  }))
}

/**
 * 读取单个侧车索引。
 * @param root - test-mode 根目录。
 * @param id - 报告 id。
 * @returns 侧车索引或 undefined。
 */
export async function readReportSidecar(root, id) {
  return readJson(root, `reports/index/${id}.json`).catch(() => undefined)
}

/**
 * 在子进程(大堆)中裁剪旧报告并写缓存。
 * @param inputPath - 原始报告路径。
 * @param outputPath - 缓存路径。
 * @returns 裁剪后的报告记录。
 */
async function trimReportInChild(inputPath, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true })
  const script = fileURLToPath(new URL('./report-trim.js', import.meta.url))
  await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [`--max-old-space-size=${TRIM_CHILD_HEAP_MB}`, script, inputPath, outputPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`report trim timed out after ${TRIM_TIMEOUT_MS}ms`))
    }, TRIM_TIMEOUT_MS)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`report trim failed (exit ${code}): ${stderr.slice(0, 500)}`))
    })
  })
  return JSON.parse(await readFile(outputPath, 'utf8'))
}

/**
 * 读取报告详情:小报告直接读正文;超过阈值的旧大报告走裁剪缓存(子进程生成)。
 * @param root - test-mode 根目录。
 * @param id - 报告 id。
 * @returns { report, trimmed } 或 undefined(不存在)。
 */
export async function readReportView(root, id) {
  const reportPath = resolve(root, `reports/${id}.json`)
  let info
  try {
    info = await stat(reportPath)
  } catch {
    return undefined
  }
  if (info.size <= REPORT_VIEW_LIMIT_BYTES) {
    const report = await readJson(root, `reports/${id}.json`)
    return report === undefined ? undefined : { report, trimmed: false }
  }
  const cachePath = resolve(root, `reports/trimmed/${id}.json`)
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8'))
    if (cached?.id === id) return { report: cached, trimmed: true }
  } catch {
    // 无缓存,重新裁剪
  }
  const report = await trimReportInChild(reportPath, cachePath)
  return { report, trimmed: true }
}

/**
 * 删除报告(正文 + 侧车 + 裁剪缓存)。
 * @param root - test-mode 根目录。
 * @param id - 报告 id。
 */
export async function deleteReport(root, id) {
  for (const rel of [`reports/${id}.json`, `reports/index/${id}.json`, `reports/trimmed/${id}.json`]) {
    await rm(resolve(root, rel), { force: true })
  }
}

/**
 * 迁移旧报告:正文超过阈值的用子进程裁剪后覆盖正文,并为所有旧报告补侧车索引。
 * 调用方负责提示这是有损操作(断言 actual 只保留预览)。
 * @param root - test-mode 根目录。
 * @param options - { minSizeBytes? }。
 * @returns { processed, trimmed, failed, reclaimedBytes }。
 */
export async function migrateLegacyReports(root, options = {}) {
  const minSizeBytes = Number(options.minSizeBytes) > 0 ? Number(options.minSizeBytes) : REPORT_VIEW_LIMIT_BYTES
  const sidecars = await listReportSidecars(root)
  const legacy = sidecars.filter((item) => item.legacy === true)
  let processed = 0
  let trimmed = 0
  let failed = 0
  let reclaimedBytes = 0
  for (const item of legacy) {
    const reportPath = resolve(root, `reports/${item.id}.json`)
    try {
      const info = await stat(reportPath)
      processed += 1
      if (info.size > minSizeBytes) {
        const cachePath = resolve(root, `reports/trimmed/${item.id}.json`)
        const report = await trimReportInChild(reportPath, cachePath)
        const serialized = JSON.stringify(report, null, 2)
        await writeFile(reportPath, serialized)
        await writeJson(root, `reports/index/${item.id}.json`, buildReportSidecar(report))
        await rm(cachePath, { force: true })
        trimmed += 1
        reclaimedBytes += Math.max(info.size - Buffer.byteLength(serialized), 0)
      } else {
        const report = JSON.parse(await readFile(reportPath, 'utf8'))
        await writeJson(root, `reports/index/${item.id}.json`, buildReportSidecar(report))
      }
    } catch {
      failed += 1
    }
  }
  return { processed, trimmed, failed, reclaimedBytes }
}
