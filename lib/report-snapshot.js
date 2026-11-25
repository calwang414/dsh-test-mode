/**
 * 固定报告快照:只保存统计数字,不保存请求/响应/步骤明细。
 *
 * 存储:
 * - `reports/latest.json` — 永远只有一份,执行后覆盖写(智能体只写这里);
 * - `reports/history/<id>.json` — 用户点「保存为历史报告」时的不可变快照。
 *
 * 旧模型 `reports/report-*.json` 的大体积报告不在此模块处理。
 * @module @calwang414/dsh-test-mode/report-snapshot
 */

import { isAssetStale, listAssets } from './assets.js'
import { deleteJson, listJsonFiles, readJson, writeJson } from './store.js'

/** 最新报告路径(相对 test-mode/)。 */
export const LATEST_REPORT_PATH = 'reports/latest.json'

/** 历史报告目录(相对 test-mode/)。 */
export const HISTORY_REPORT_DIR = 'reports/history'

/** 失败明细最多保留条数。 */
const MAX_FAILURES = 50

/** 失败错误摘要最大长度。 */
const ERROR_LIMIT = 200

/** 判断资产是否 UI 组件。 */
function isUiComponent(asset) {
  return asset?.kind === 'ui' && (asset.type ?? 'flow') === 'component'
}

/** 百分比保留三位小数。 */
function ratio(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 1000) / 1000 : 0
}

/**
 * 由资产状态构建统计快照(纯函数)。
 * @param assets - 资产数组。
 * @param options - { environmentId?, trigger? }。
 * @returns 统计报告对象(不含请求/响应/步骤明细)。
 */
export function buildReportStats(assets, options = {}) {
  const list = Array.isArray(assets) ? assets : []
  const byModule = new Map()
  const byType = {
    api: { type: 'api', total: 0, passed: 0, failed: 0, stale: 0, untested: 0 },
    uiComponent: { type: 'uiComponent', total: 0, passed: 0, failed: 0, stale: 0, untested: 0 },
    uiFlow: { type: 'uiFlow', total: 0, passed: 0, failed: 0, stale: 0, untested: 0 },
  }
  const failures = []
  let passed = 0
  let failed = 0
  let stale = 0
  let untested = 0

  for (const asset of list) {
    const moduleName = asset.module || '未分组'
    const entry = byModule.get(moduleName) ?? {
      module: moduleName, total: 0, passed: 0, failed: 0, stale: 0, untested: 0,
    }
    entry.total += 1
    const typeKey = asset.kind === 'api' ? 'api' : isUiComponent(asset) ? 'uiComponent' : 'uiFlow'
    const typeEntry = byType[typeKey]
    typeEntry.total += 1

    const assetStale = asset.status === 'solid' && isAssetStale(asset)
    if (asset.status === 'solid' && !assetStale) {
      passed += 1
      entry.passed += 1
      typeEntry.passed += 1
    } else if (assetStale) {
      stale += 1
      entry.stale += 1
      typeEntry.stale += 1
    } else if (asset.status === 'failed') {
      failed += 1
      entry.failed += 1
      typeEntry.failed += 1
      if (failures.length < MAX_FAILURES) {
        const error = asset.lastRun?.error
        failures.push({
          assetId: asset.id,
          name: asset.name || asset.id,
          module: moduleName,
          error: typeof error === 'string' && error ? error.slice(0, ERROR_LIMIT) : undefined,
          lastRunAt: asset.lastRun?.at,
        })
      }
    } else {
      untested += 1
      entry.untested += 1
      typeEntry.untested += 1
    }
    byModule.set(moduleName, entry)
  }

  const total = list.length
  const executed = passed + stale + failed
  const status = total === 0 ? 'empty'
    : failed > 0 ? 'failed'
      : (untested > 0 || stale > 0) ? 'partial'
        : 'passed'
  const modules = [...byModule.values()]
    .map((entry) => ({
      ...entry,
      passRate: ratio(entry.passed, entry.passed + entry.stale + entry.failed),
    }))
    .sort((a, b) => b.total - a.total || a.module.localeCompare(b.module))

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    environmentId: typeof options.environmentId === 'string' && options.environmentId ? options.environmentId : undefined,
    trigger: options.trigger ?? 'manual',
    status,
    coverage: {
      assetsTotal: total,
      executed,
      passed,
      failed,
      stale,
      untested,
      coverageRate: ratio(executed, total),
      passRate: ratio(passed, executed),
    },
    summary: { total, passed, failed, skipped: 0 },
    byModule: modules,
    byType: Object.values(byType),
    failures: {
      count: failed,
      shown: failures.length,
      items: failures,
    },
  }
}

/**
 * 构建当前统计快照(不写盘)。
 * @param root - test-mode 根目录。
 * @param options - { environmentId?, trigger? }。
 * @returns 统计报告对象。
 */
export async function buildLatestReport(root, options = {}) {
  return buildReportStats(await listAssets(root), options)
}

/**
 * 刷新并覆盖 `reports/latest.json`。
 * @param root - test-mode 根目录。
 * @param options - { environmentId?, trigger? }。
 * @returns 写入的统计报告对象。
 */
export async function refreshLatestReport(root, options = {}) {
  const report = await buildLatestReport(root, options)
  await writeJson(root, LATEST_REPORT_PATH, report)
  return report
}

/**
 * 读取最新报告;文件不存在时构建并写入。
 * @param root - test-mode 根目录。
 * @returns 统计报告对象。
 */
export async function readLatestReport(root) {
  const stored = await readJson(root, LATEST_REPORT_PATH).catch(() => undefined)
  if (stored && stored.schemaVersion === 1) return stored
  return refreshLatestReport(root, { trigger: 'first-read' })
}

/**
 * 保存当前统计为历史报告(任何状态都可保存)。
 * @param root - test-mode 根目录。
 * @param options - { name? }。
 * @returns { ok: true, report } 或 { ok: false, message }。
 */
export async function saveHistoryReport(root, options = {}) {
  const report = await buildLatestReport(root, { trigger: 'history-save' })
  const now = new Date().toISOString()
  const baseId = `report-${now.replace(/[^0-9]/g, '').slice(0, 14)}`
  let id = baseId
  let suffix = 1
  while ((await readJson(root, `${HISTORY_REPORT_DIR}/${id}.json`).catch(() => undefined)) !== undefined) {
    id = `${baseId}-${suffix}`
    suffix += 1
  }
  const name = String(options.name ?? '').trim() || `${new Date(now).toLocaleString()} 测试报告`
  const stored = {
    id,
    name,
    createdAt: now,
    status: report.status,
    environmentId: report.environmentId,
    coverage: report.coverage,
    summary: report.summary,
    byModule: report.byModule,
    byType: report.byType,
    failures: report.failures,
  }
  await writeJson(root, `${HISTORY_REPORT_DIR}/${id}.json`, stored)
  return { ok: true, report: stored }
}

/**
 * 列出历史报告(按创建时间倒序)。
 * @param root - test-mode 根目录。
 * @returns 历史报告数组。
 */
export async function listHistoryReports(root) {
  const reports = []
  for (const id of await listJsonFiles(root, HISTORY_REPORT_DIR)) {
    const report = await readJson(root, `${HISTORY_REPORT_DIR}/${id}.json`).catch(() => undefined)
    if (report?.id) reports.push(report)
  }
  return reports.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
}

/**
 * 读取一份历史报告。
 * @param root - test-mode 根目录。
 * @param id - 历史报告 id。
 * @returns 历史报告或 undefined。
 */
export async function readHistoryReport(root, id) {
  return readJson(root, `${HISTORY_REPORT_DIR}/${id}.json`).catch(() => undefined)
}

/**
 * 删除一份历史报告。
 * @param root - test-mode 根目录。
 * @param id - 历史报告 id。
 * @returns 是否删除了文件。
 */
export async function deleteHistoryReport(root, id) {
  const existing = await readHistoryReport(root, id)
  if (!existing) return false
  await deleteJson(root, `${HISTORY_REPORT_DIR}/${id}.json`)
  return true
}

/**
 * 历史报告趋势点(按时间升序),供看板画折线。
 * @param reports - 历史报告数组。
 * @returns [{ id, name, createdAt, coverageRate, passRate, failed, total }]。
 */
export function reportTrend(reports) {
  return (reports ?? [])
    .slice()
    .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')))
    .map((report) => ({
      id: report.id,
      name: report.name,
      createdAt: report.createdAt,
      coverageRate: report.coverage?.coverageRate ?? 0,
      passRate: report.coverage?.passRate ?? 0,
      failed: report.coverage?.failed ?? 0,
      total: report.coverage?.assetsTotal ?? 0,
    }))
}
