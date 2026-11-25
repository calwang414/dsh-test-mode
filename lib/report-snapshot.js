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

/** 工作项类型与展示名。 */
const WORK_ITEM_TYPE_LABELS = {
  functional: '功能测试',
  e2e: 'e2e测试',
  performance: '性能测试',
  security: '安全测试',
}

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
export function buildReportStats(assets, cases = [], options = {}) {
  const list = Array.isArray(assets) ? assets : []
  const workItemList = Array.isArray(cases) ? cases : []
  const assetById = new Map(list.map((asset) => [asset.id, asset]))
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

  // 测试工作项明细:只保存名称/类型/结果/需求/标签/资产名与断言数,不保存请求/响应。
  const workItemsByType = new Map()
  const workItemItems = []
  let workItemPassed = 0
  let workItemFailed = 0
  let workItemNotRun = 0
  let workItemBlocked = 0
  let workItemSkipped = 0
  for (const item of workItemList) {
    const type = WORK_ITEM_TYPE_LABELS[item.type] ? item.type : 'functional'
    const entry = workItemsByType.get(type) ?? {
      type, label: WORK_ITEM_TYPE_LABELS[type], total: 0, passed: 0, failed: 0,
      not_run: 0, blocked: 0, skipped: 0,
    }
    entry.total += 1
    const result = item.result ?? 'not_run'
    if (result === 'passed') { entry.passed += 1; workItemPassed += 1 } else if (result === 'failed') { entry.failed += 1; workItemFailed += 1 } else if (result === 'blocked') { entry.blocked += 1; workItemBlocked += 1 } else if (result === 'skipped') { entry.skipped += 1; workItemSkipped += 1 } else { entry.not_run += 1; workItemNotRun += 1 }
    workItemsByType.set(type, entry)

    const entries = Array.isArray(item.assets) ? item.assets : []
    const resolvedAssets = []
    let assertionCount = 0
    for (const binding of entries) {
      const asset = assetById.get(binding?.assetId)
      if (!asset) continue
      assertionCount += Array.isArray(asset.request?.assertions) ? asset.request.assertions.length : 0
      if (resolvedAssets.length < 50) {
        resolvedAssets.push({
          id: asset.id,
          name: asset.name ?? asset.id,
          kind: asset.kind,
          status: asset.status,
          stale: asset.status === 'solid' && isAssetStale(asset),
        })
      }
    }
    workItemItems.push({
      id: item.id,
      name: item.name ?? item.id,
      type,
      typeLabel: WORK_ITEM_TYPE_LABELS[type],
      priority: item.priority ?? 'medium',
      automation: item.automation ?? 'auto',
      result,
      module: item.module,
      tags: Array.isArray(item.tags) ? item.tags : [],
      requirement: item.requirement ?? '',
      defects: Array.isArray(item.defects) ? item.defects : [],
      assetCount: entries.length,
      assertionCount,
      assets: resolvedAssets,
    })
  }
  const workItemTypeOrder = ['functional', 'e2e', 'performance', 'security']
  const workItemsByTypeList = workItemTypeOrder
    .filter((type) => workItemsByType.has(type))
    .map((type) => workItemsByType.get(type))

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
    workItems: {
      total: workItemList.length,
      summary: {
        passed: workItemPassed,
        failed: workItemFailed,
        not_run: workItemNotRun,
        blocked: workItemBlocked,
        skipped: workItemSkipped,
      },
      byType: workItemsByTypeList,
      items: workItemItems,
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
  const assets = await listAssets(root)
  const cases = []
  for (const caseId of await listJsonFiles(root, 'cases')) {
    const item = await readJson(root, `cases/${caseId}.json`).catch(() => undefined)
    if (item) cases.push({ id: caseId, ...item })
  }
  return buildReportStats(assets, cases, options)
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
    workItems: report.workItems,
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
