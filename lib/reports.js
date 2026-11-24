/**
 * 报告存储:只保存**统计信息 + 失败结果**,不保存执行过程明细
 * (逐请求断言、响应体、UI 步骤、诊断日志等一律不落盘)。
 *
 * 存储格式(`reports/<id>.json`,通常几 KB):
 * - 标识/时间/耗时: id、kind、name、planId/caseId/scriptId/projectId/collectionId、
 *   startedAt、finishedAt、durationMs、createdAt;
 * - `summary`: { total, passed, failed, skipped? };
 * - `driver`: UI 执行的引擎信息(小对象);
 * - `failedEntries`: 失败项列表(≤200 条,每项仅 label/identity/status/error 摘要),
 *   供报告页失败清单、对比(新失败)与「重跑上次失败」使用;
 * - `failuresTruncated`: 失败项超出上限时的条数。
 *
 * 旧报告(体积过大或旧格式)在列表里只给 stub 不解析正文;查看/导出时在子进程中
 * 压缩为上述格式并缓存,避免宿主解析超大 JSON。
 * @module @calwang414/dsh-test-mode/reports
 */

import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listJsonFiles, readJson, writeJson } from './store.js'

/** 报告正文超过此大小时,列表只给 stub、详情改走子进程压缩缓存。 */
export const REPORT_VIEW_LIMIT_BYTES = 1024 * 1024
/** 失败项列表上限。 */
const FAILED_ENTRY_LIMIT = 200
/** 失败项文字(名称/错误/URL)截断长度。 */
const LABEL_CAP = 120
const ERROR_CAP = 300
const URL_CAP = 300
/** 旧报告压缩子进程的内存上限(旧文件可能数百 MB)。 */
const TRIM_CHILD_HEAP_MB = 8192
/** 子进程超时。 */
const TRIM_TIMEOUT_MS = 300_000

/** 截断文本。 */
function capText(value, limit) {
  const text = String(value ?? '')
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * 把执行结果压缩为存储用报告:丢弃全部过程明细,只保留统计与失败项。
 * @param record - 内存中的完整报告记录。
 * @returns 存储用报告对象。
 */
export function compactReport(record) {
  const failedEntries = []
  let failuresTruncated = 0
  for (const result of record.results ?? []) {
    if (result?.pass !== false) continue
    if (failedEntries.length >= FAILED_ENTRY_LIMIT) {
      failuresTruncated += 1
      continue
    }
    const label = result.name ?? result.caseName ?? result.collectionName ?? result.scriptName
      ?? result.step?.action ?? result.url ?? '失败项'
    const kind = result.kind === 'case' || result.kind === 'collection' || result.kind === 'ui'
      ? result.kind
      : (result.kind === 'request' ? 'request' : 'step')
    failedEntries.push({
      kind,
      label: capText(label, LABEL_CAP),
      ...(result.stepIndex !== undefined ? { stepIndex: result.stepIndex } : {}),
      ...(result.caseId !== undefined ? { caseId: result.caseId } : {}),
      ...(result.projectId !== undefined ? { projectId: result.projectId } : {}),
      ...(result.scriptId !== undefined ? { scriptId: result.scriptId } : {}),
      ...(result.requestId !== undefined ? { requestId: result.requestId } : {}),
      ...(result.method ? { method: String(result.method).toUpperCase() } : {}),
      ...(result.url ? { url: capText(result.url, URL_CAP) } : {}),
      ...(typeof result.status === 'number' ? { status: result.status } : {}),
      ...(result.error ? { error: capText(result.error, ERROR_CAP) } : {}),
    })
  }
  return {
    id: record.id,
    kind: record.kind,
    name: record.name ?? record.kind,
    planId: record.planId,
    caseId: record.caseId,
    scriptId: record.scriptId,
    projectId: record.projectId,
    collectionId: record.collectionId,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    durationMs: record.durationMs ?? 0,
    createdAt: record.createdAt ?? '',
    summary: record.summary ?? { total: 0, passed: 0, failed: 0 },
    driver: record.driver,
    failedEntries,
    ...(failuresTruncated > 0 ? { failuresTruncated } : {}),
  }
}

/**
 * 压缩执行结果列表(供 HTTP 响应里的即时展示,不落盘)。
 * @param results - 完整结果数组。
 * @returns 仅含步骤结果的紧凑数组。
 */
export function compactRunResults(results) {
  return (results ?? []).map((result) => ({
    stepIndex: result.stepIndex,
    kind: result.kind ?? (result.method ? 'request' : undefined),
    name: result.name ?? result.step?.action,
    method: result.method ? String(result.method).toUpperCase() : undefined,
    url: result.url,
    pass: result.pass,
    skipped: result.skipped === true ? true : undefined,
    status: result.status,
    durationMs: result.durationMs,
    caseId: result.caseId,
    projectId: result.projectId,
    scriptId: result.scriptId,
    requestId: result.requestId,
    error: result.error ? capText(result.error, ERROR_CAP) : undefined,
  }))
}

/**
 * 保存报告(只落盘统计 + 失败项)。
 * @param root - test-mode 根目录。
 * @param record - 完整报告记录。
 * @returns 实际落盘的报告对象。
 */
export async function saveReport(root, record) {
  const stored = compactReport(record)
  await writeJson(root, `reports/${record.id}.json`, stored)
  return stored
}

/**
 * 报告列表(摘要):小文件直接读(通常几 KB);旧大文件只返回 stub,不解析正文。
 * @param root - test-mode 根目录。
 * @returns 报告摘要数组(按 createdAt 倒序)。
 */
export async function listReportSummaries(root) {
  const summaries = []
  for (const id of await listJsonFiles(root, 'reports')) {
    const path = resolve(root, `reports/${id}.json`)
    let info
    try {
      info = await stat(path)
    } catch {
      continue
    }
    if (info.size > REPORT_VIEW_LIMIT_BYTES) {
      summaries.push({
        id,
        kind: 'legacy',
        name: '旧报告(待整理)',
        createdAt: info.mtime.toISOString(),
        durationMs: 0,
        summary: null,
        legacy: true,
        size: info.size,
      })
      continue
    }
    const item = await readJson(root, `reports/${id}.json`).catch(() => undefined)
    if (!item) continue
    summaries.push({
      id: item.id ?? id,
      kind: item.kind,
      name: item.name,
      planId: item.planId,
      caseId: item.caseId,
      scriptId: item.scriptId,
      projectId: item.projectId,
      collectionId: item.collectionId,
      createdAt: item.createdAt ?? info.mtime.toISOString(),
      startedAt: item.startedAt,
      finishedAt: item.finishedAt,
      durationMs: item.durationMs ?? 0,
      summary: item.summary,
      driver: item.driver,
      failedCount: Array.isArray(item.failedEntries) ? item.failedEntries.length : 0,
      size: info.size,
    })
  }
  return summaries.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
}

/**
 * 在子进程(大堆)中把旧报告压缩为存储格式并写缓存。
 * @param inputPath - 原始报告路径。
 * @param outputPath - 缓存路径。
 * @returns 压缩后的报告。
 */
async function compactReportInChild(inputPath, outputPath) {
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
      reject(new Error(`report compact timed out after ${TRIM_TIMEOUT_MS}ms`))
    }, TRIM_TIMEOUT_MS)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolvePromise()
      else reject(new Error(`report compact failed (exit ${code}): ${stderr.slice(0, 500)}`))
    })
  })
  return JSON.parse(await readFile(outputPath, 'utf8'))
}

/**
 * 读取报告详情:小报告直接读;超过阈值的旧报告走子进程压缩缓存。
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
    // 无缓存,重新压缩
  }
  const report = await compactReportInChild(reportPath, cachePath)
  return { report, trimmed: true }
}

/**
 * 删除报告(正文 + 压缩缓存)。
 * @param root - test-mode 根目录。
 * @param id - 报告 id。
 */
export async function deleteReport(root, id) {
  for (const rel of [`reports/${id}.json`, `reports/trimmed/${id}.json`]) {
    await rm(resolve(root, rel), { force: true })
  }
}

/**
 * 整理旧报告:把超过阈值的正文压缩为统计格式后覆盖,小文件也统一规范化。
 * @param root - test-mode 根目录。
 * @param options - { minSizeBytes? }。
 * @returns { processed, trimmed, failed, reclaimedBytes }。
 */
export async function migrateLegacyReports(root, options = {}) {
  const minSizeBytes = Number(options.minSizeBytes) > 0 ? Number(options.minSizeBytes) : REPORT_VIEW_LIMIT_BYTES
  let processed = 0
  let trimmed = 0
  let failed = 0
  let reclaimedBytes = 0
  for (const id of await listJsonFiles(root, 'reports')) {
    const reportPath = resolve(root, `reports/${id}.json`)
    try {
      const info = await stat(reportPath)
      processed += 1
      let compacted
      if (info.size > minSizeBytes) {
        const cachePath = resolve(root, `reports/trimmed/${id}.json`)
        compacted = await compactReportInChild(reportPath, cachePath)
        await rm(cachePath, { force: true })
        trimmed += 1
      } else {
        compacted = compactReport(JSON.parse(await readFile(reportPath, 'utf8')))
      }
      const serialized = JSON.stringify(compacted, null, 2)
      await writeFile(reportPath, serialized)
      reclaimedBytes += Math.max(info.size - Buffer.byteLength(serialized), 0)
    } catch {
      failed += 1
    }
  }
  return { processed, trimmed, failed, reclaimedBytes }
}
