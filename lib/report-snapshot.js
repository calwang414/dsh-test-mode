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

/** 资产的断言数(API 用 assertions,UI 用 assert_* 步骤)。 */
function assertionCountOf(asset) {
  if (asset?.kind === 'ui') {
    return (asset.steps ?? []).filter((step) => String(step?.kind ?? '').startsWith('assert')).length
  }
  return Array.isArray(asset?.request?.assertions) ? asset.request.assertions.length : 0
}

/** 模块/集合维度的覆盖键。 */
function scopeKeyOf(asset) {
  return `${asset?.module || '未分组'}/${asset?.source?.collectionName || '未分组集合'}`
}

/** 是否负向/安全资产。 */
function isNegativeAsset(asset) {
  if (!asset) return false
  const tags = Array.isArray(asset.tags) ? asset.tags : []
  return Boolean(asset.security) || tags.includes('负向用例') || tags.includes('安全') || tags.includes('security')
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
  const tagLibrary = Array.isArray(options.tagLibrary) ? options.tagLibrary : []
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

  let assertionTotal = 0
  let assetsWithNoAssertions = 0
  let negativeAssets = 0
  let rerunAssets = 0
  let historicalFailureAssets = 0
  let durationTotalMs = 0
  let lastRunTotalMs = 0
  let lastRunCount = 0
  const lastRunDurations = []
  const slowestAssets = []
  const usedTags = new Set()
  const scopes = new Map()
  for (const asset of list) {
    assertionTotal += assertionCountOf(asset)
    if (assertionCountOf(asset) === 0) assetsWithNoAssertions += 1
    if (isNegativeAsset(asset)) negativeAssets += 1
    if ((asset.stats?.runs ?? 0) > 1) rerunAssets += 1
    if ((asset.stats?.failed ?? 0) > 0) historicalFailureAssets += 1
    const lastRunMs = Number(asset.lastRun?.durationMs)
    const hasDuration = Number.isFinite(lastRunMs) && lastRunMs >= 0
    if (hasDuration) {
      lastRunTotalMs += lastRunMs
      lastRunCount += 1
      lastRunDurations.push(lastRunMs)
      slowestAssets.push({ assetId: asset.id, name: asset.name || asset.id, module: asset.module || '未分组', durationMs: lastRunMs })
    }
    durationTotalMs += Math.max(Number(asset.stats?.totalDurationMs) || 0, 0)
    for (const tag of asset.tags ?? []) usedTags.add(tag)
    const scopeKey = scopeKeyOf(asset)
    const scope = scopes.get(scopeKey) ?? {
      scope: scopeKey, module: asset.module || '未分组',
      collection: asset.source?.collectionName || '未分组集合',
      totalAssets: 0, coveredAssets: 0, coveredAssetIds: new Set(),
      workItems: 0, functional: 0, e2e: 0, performance: 0, security: 0,
    }
    scope.totalAssets += 1
    scopes.set(scopeKey, scope)
    const moduleName = asset.module || '未分组'
    const entry = byModule.get(moduleName) ?? {
      module: moduleName, total: 0, passed: 0, failed: 0, stale: 0, untested: 0,
      lastRunMs: 0, totalMs: 0,
    }
    entry.total += 1
    entry.lastRunMs += hasDuration ? lastRunMs : 0
    entry.totalMs += Math.max(Number(asset.stats?.totalDurationMs) || 0, 0)
    const typeKey = asset.kind === 'api' ? 'api' : isUiComponent(asset) ? 'uiComponent' : 'uiFlow'
    const typeEntry = byType[typeKey]
    typeEntry.total += 1
    typeEntry.lastRunMs = (typeEntry.lastRunMs ?? 0) + (hasDuration ? lastRunMs : 0)
    typeEntry.totalMs = (typeEntry.totalMs ?? 0) + Math.max(Number(asset.stats?.totalDurationMs) || 0, 0)

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
    const scopesOfItem = new Set()
    let assertionCount = 0
    for (const binding of entries) {
      const asset = assetById.get(binding?.assetId)
      if (!asset) continue
      assertionCount += assertionCountOf(asset)
      const scope = scopes.get(scopeKeyOf(asset))
      if (scope) {
        scopesOfItem.add(scopeKeyOf(asset))
        scope.coveredAssetIds.add(asset.id)
      }
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
    for (const scopeKey of scopesOfItem) {
      const scope = scopes.get(scopeKey)
      if (!scope) continue
      scope.workItems += 1
      scope[type] += 1
    }
    for (const tag of item.tags ?? []) usedTags.add(tag)
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
      lastDurationMs: Math.max(Number(item.lastRun?.durationMs) || 0, 0),
      assets: resolvedAssets,
    })
  }
  const workItemTypeOrder = ['functional', 'e2e', 'performance', 'security']
  const workItemsByTypeList = workItemTypeOrder
    .filter((type) => workItemsByType.has(type))
    .map((type) => workItemsByType.get(type))

  // ── 广度 / 深度 / 质量 ────────────────────────────────────────────────
  const totalAssets = list.length
  const totalWorkItems = workItemList.length
  const scopeList = [...scopes.values()].map((scope) => ({
    scope: scope.scope,
    module: scope.module,
    collection: scope.collection,
    totalAssets: scope.totalAssets,
    coveredAssets: scope.coveredAssetIds.size,
    workItems: scope.workItems,
    functional: scope.functional,
    e2e: scope.e2e,
    performance: scope.performance,
    security: scope.security,
  })).sort((a, b) => b.totalAssets - a.totalAssets || a.scope.localeCompare(b.scope))
  const scopesCovered = scopeList.filter((scope) => scope.workItems > 0).length
  const scopeCoverage = ratio(scopesCovered, scopeList.length)
  const moduleSet = new Set(list.map((asset) => asset.module || '未分组'))
  const typesCovered = workItemsByTypeList.length
  const typeCoverage = ratio(typesCovered, 4)
  const requirementLinked = workItemItems.filter((item) => String(item.requirement ?? '').trim()).length
  const requirementCoverage = ratio(requirementLinked, totalWorkItems)
  const tagLibrarySize = tagLibrary.length
  const tagsUsed = usedTags.size
  const tagLibrarySet = new Set(tagLibrary)
  const tagsUsedInLibrary = tagLibrarySize > 0 ? [...usedTags].filter((tag) => tagLibrarySet.has(tag)).length : tagsUsed
  const tagCoverage = tagLibrarySize > 0 ? ratio(tagsUsedInLibrary, tagLibrarySize) : 0
  const assertionPerAsset = ratio(assertionTotal, totalAssets)
  const assertionPerWorkItem = ratio(assertionTotal, totalWorkItems)
  const negativeRatio = ratio(negativeAssets, totalAssets)
  const e2eWorkItems = workItemsByType.get('e2e')?.total ?? 0
  const bindingsTotal = workItemItems.reduce((sum, item) => sum + item.assetCount, 0)
  const avgAssetsPerWorkItem = ratio(bindingsTotal, totalWorkItems)
  const defectsTotal = workItemItems.reduce((sum, item) => sum + item.defects.length, 0)
  const workItemsWithDefects = workItemItems.filter((item) => item.defects.length > 0).length
  const defectsPerWorkItem = ratio(defectsTotal, totalWorkItems)
  const rerunRatio = ratio(rerunAssets, totalAssets)
  const automationTotal = workItemItems.filter((item) => item.automation === 'auto').length
  const automationRate = ratio(automationTotal, totalWorkItems)
  const highPriorityFailed = workItemItems.filter((item) => item.priority === 'high' && item.result === 'failed').length
  const historicalFailureRate = ratio(historicalFailureAssets, totalAssets)
  const freshnessRate = ratio(passed, totalAssets)
  const securityRate = ratio(workItemsByType.get('security')?.passed ?? 0, workItemsByType.get('security')?.total ?? 0)
  const performanceRate = ratio(workItemsByType.get('performance')?.passed ?? 0, workItemsByType.get('performance')?.total ?? 0)
  const health = [
    {
      key: 'scopeBreadth', label: '模块广度', value: Math.round(scopeCoverage * 100),
      raw: `${scopesCovered}/${scopeList.length}`, formula: '有工作项覆盖的模块/集合 ÷ 全部模块/集合',
    },
    {
      key: 'typeBreadth', label: '类型广度', value: Math.round(typeCoverage * 100),
      raw: `${typesCovered}/4`, formula: '有工作项的测试类型数 ÷ 4',
    },
    {
      key: 'assertionDepth', label: '断言深度', value: Math.round(Math.min(assertionPerAsset / 4, 1) * 100),
      raw: `${assertionPerAsset} 条/资产`, formula: '断言总数 ÷ 资产数,4 条/资产视为满分',
    },
    {
      key: 'negativeDepth', label: '负向深度', value: Math.round(Math.min(negativeRatio / 0.2, 1) * 100),
      raw: `${Math.round(negativeRatio * 1000) / 10}%`, formula: '负向/安全资产占比,20% 视为满分',
    },
    {
      key: 'regressionHealth', label: '回归健康', value: Math.round((1 - historicalFailureRate) * 100),
      raw: `历史失败 ${historicalFailureAssets}`, formula: '1 - 曾失败资产 ÷ 总资产',
    },
    {
      key: 'freshness', label: '新鲜度', value: Math.round(freshnessRate * 100),
      raw: `${passed}/${totalAssets}`, formula: '当前通过(未过期) ÷ 总资产',
    },
  ]
  const dimensions = {
    breadth: {
      modulesTotal: moduleSet.size,
      scopesTotal: scopeList.length,
      scopesCovered,
      scopeCoverage,
      typesCovered,
      typeCoverage,
      requirementLinked,
      requirementTotal: totalWorkItems,
      requirementCoverage,
      tagsUsed,
      tagsUsedInLibrary,
      tagsUnknown: tagsUsed - tagsUsedInLibrary,
      tagLibrarySize,
      tagCoverage,
    },
    depth: {
      assertionsTotal: assertionTotal,
      assertionPerAsset,
      assertionPerWorkItem,
      assetsWithNoAssertions,
      negativeAssets,
      negativeRatio,
      e2eWorkItems,
      avgAssetsPerWorkItem,
      uiFlowAssets: byType.uiFlow.total,
      defectsTotal,
      workItemsWithDefects,
      defectsPerWorkItem,
      rerunAssets,
      rerunRatio,
      automationRate,
    },
    quality: {
      passRate: ratio(passed, passed + stale + failed),
      coverageRate: ratio(passed + stale + failed, totalAssets),
      freshnessRate,
      staleRate: ratio(stale, totalAssets),
      untestedRate: ratio(untested, totalAssets),
      failedRate: ratio(failed, totalAssets),
      highPriorityFailed,
      securityRate,
      performanceRate,
      historicalFailureRate,
    },
    health,
    byScope: scopeList,
  }
  const sortedDurations = lastRunDurations.filter((value) => value > 0).sort((a, b) => a - b)
  const p95Index = sortedDurations.length > 0 ? Math.min(sortedDurations.length - 1, Math.ceil(sortedDurations.length * 0.95) - 1) : -1
  const timing = {
    totalMs: durationTotalMs,
    lastRunTotalMs,
    lastRunAvgMs: ratio(lastRunTotalMs, lastRunCount),
    lastRunP95Ms: p95Index >= 0 ? sortedDurations[p95Index] : 0,
    lastRunMaxMs: sortedDurations.length > 0 ? sortedDurations[sortedDurations.length - 1] : 0,
    assetsWithDuration: lastRunCount,
    slowestAssets: slowestAssets.sort((a, b) => b.durationMs - a.durationMs).slice(0, 8),
    byModule: modules.map((entry) => ({ module: entry.module, lastRunMs: entry.lastRunMs ?? 0, totalMs: entry.totalMs ?? 0 })),
    byType: Object.values(byType).map((entry) => ({ type: entry.type, lastRunMs: entry.lastRunMs ?? 0, totalMs: entry.totalMs ?? 0 })),
  }

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
    dimensions,
    timing,
    workItems: {
      total: workItemList.length,
      summary: {
        passed: workItemPassed,
        failed: workItemFailed,
        not_run: workItemNotRun,
        blocked: workItemBlocked,
        skipped: workItemSkipped,
        totalDurationMs: workItemItems.reduce((sum, item) => sum + (item.lastDurationMs ?? 0), 0),
        avgDurationMs: ratio(workItemItems.reduce((sum, item) => sum + (item.lastDurationMs ?? 0), 0), workItemList.length),
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
  const tagData = await readJson(root, 'tags.json').catch(() => undefined)
  const tagLibrary = Array.isArray(tagData?.categories)
    ? tagData.categories.flatMap((category) => category.tags ?? [])
    : (Array.isArray(tagData?.tags) ? tagData.tags : [])
  return buildReportStats(assets, cases, { ...options, tagLibrary })
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
    dimensions: report.dimensions,
    timing: report.timing,
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
      lastRunTotalMs: report.timing?.lastRunTotalMs ?? 0,
      lastRunAvgMs: report.timing?.lastRunAvgMs ?? 0,
    }))
}
