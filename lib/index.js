/**
 * dsh-test-mode Host 半:注册 /dsh-test-mode 前缀路由(JSON API)。「测试模式」
 * 预设由 cordis.patch.yml 以 @deepseek-ai/dsh-agent-preset 声明行随包发布,
 * 无需运行时写入用户预设目录。
 *
 * API 模块:
 * - **插件测试**:`POST /api/run` — 动态插件三阶段测试套件;
 * - **用例管理**:`GET/POST /api/cases`、`GET/PUT/DELETE /api/cases/:id`;
 * - **API 项目**:`GET/POST /api/projects`、`GET/PUT/DELETE /api/projects/:id`;
 * - **环境变量**:`GET/POST /api/environments`、`GET/PUT/DELETE /api/environments/:id`;
 * - **API 执行**:`POST /api/run-request`(单请求)、`POST /api/run-collection`(整个集合);
 * - **历史/报告**:`GET /api/history`、`GET/DELETE /api/reports`、`GET /api/reports/:id`。
 *
 * 所有请求体带 `workspaceId` 定位工作区 test-mode/ 目录(与 ui-design 的
 * workspace 定位一致);数据存取走 lib/store.js(路径校验 + 原子写 + 操作锁)。
 *
 * 与 ui-design 的差异:测试引擎观察的是真实 Cordis 语义(注册表副作用随
 * fiber 卸载),因此没有 token 鉴权与静态 studio——React 原生视图同源调用
 * API,无需独立前端产物。
 * @module @calwang414/dsh-test-mode
 */

import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runPluginSuite } from './plugin-test.js'
import { BUILTIN_FACTORY_ITEMS, executeCase, executeCollection, executeRequest, substitute } from './api-test.js'
import { executeUiScript } from './ui-test.js'
import { probeUiPage } from './browser-driver.js'
import {
  compactReport, compactRunResults, deleteReport, listReportSummaries, migrateLegacyReports, readReportView, saveReport,
} from './reports.js'
import { loadDbDataTables, parseCsvText, parseMdTableText } from './dbdata.js'
import {
  applyAssetOutcome, assetSummary, deleteAsset, isAssetStale, listAssets,
  pendingAssets, queryAssets, readAsset, uiAssetGranularity, uiGranularityReport, writeAsset,
} from './assets.js'
import { runAsset, withAssetData } from './asset-run.js'
import { migrateLegacyAssets } from './migrate-assets.js'
import { isSecurityAsset, planSecurityScaffold, securityAssetWarnings, securityGate } from './security.js'
import {
  deleteHistoryReport, listHistoryReports, readHistoryReport, readLatestReport,
  refreshLatestReport, saveHistoryReport,
} from './report-snapshot.js'
import { autoCommitTestMode } from './git.js'
import {
  appendHistory, deleteJson, listJsonFiles, mutateJson, newId, nowIso, readHistory, readJson, requestJson,
  testModeRoot, writeJson,
} from './store.js'

/** 预设 id:与 cordis.patch.yml 里 @deepseek-ai/dsh-agent-preset 行的 config.id 一致。 */
const TEST_MODE_PRESET_ID = 'dsh-test-mode'

/** 路由前缀。 */
const ROUTE_ROOT = '/dsh-test-mode'

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 取请求体里的 workspaceId,缺省抛错。 */
function requireWorkspaceId(body) {
  const id = body?.workspaceId
  if (typeof id !== 'string' || !id) throw new Error('workspaceId is required')
  return id
}

/** 取路径参数 :id。 */
function pathId(pathname, prefix) {
  const rest = pathname.slice(prefix.length).replace(/^\/+/, '')
  if (rest.includes('/')) return undefined
  if (!rest) return undefined
  try {
    return decodeURIComponent(rest)
  } catch {
    return rest
  }
}

/**
 * 用例管理 handler。
 * @param ctx - 插件上下文。
 * @param req - 入站请求。
 * @param res - 出站响应。
 * @param pathname - 请求路径。
 * @param method - HTTP 方法。
 */
async function handleCases(ctx, req, res, pathname, method) {
  const base = `${ROUTE_ROOT}/api/cases`
  // 子路由:POST /api/cases/:id/run — 执行用例(按步骤跑绑定请求)。
  const runMatch = /^\/dsh-test-mode\/api\/cases\/([^/]+)\/run$/.exec(pathname)
  if (runMatch && method === 'POST') {
    const body = await requestJson(req)
    const root = testModeRoot(ctx, requireWorkspaceId(body))
    const caseId = runMatch[1]
    const testCase = await readJson(root, `cases/${caseId}.json`)
    if (!testCase) { sendJson(res, 404, { ok: false, message: `case "${caseId}" was not found` }); return }
    const environmentId = await resolveEnvironmentId(root, body.environmentId)
    const variables = {
      ...(await loadEnvironment(root, body.environmentId)),
      ...(await loadSessionVariables(root, environmentId)),
    }
    const factories = await loadFactories(root)
    const startedAt = nowIso()
    const started = Date.now()
    // 新模型:用例 = 资产组合;执行只更新资产状态/统计,不生成报告。
    if (Array.isArray(testCase.assets) && testCase.assets.length > 0) {
      const elements = await loadUiElements(root)
      // 兼容已迁移用例:早期迁移会丢掉 steps[].data,而执行器只读 assets[].data。
      // 当 entry.data 缺失时,若 legacy steps 中该请求引用的 data 唯一,则只读回退;
      // 多条不同 data 视为歧义,不回退(避免选错数据)。
      const legacyDataByRef = new Map()
      for (const step of testCase.steps ?? []) {
        const ref = step?.requestRef
        if (!ref || step.data === undefined) continue
        const key = `${ref.projectId}|${ref.collectionId}|${ref.requestId}`
        legacyDataByRef.set(key, [...(legacyDataByRef.get(key) ?? []), step.data])
      }
      const legacyDataForAsset = (asset) => {
        const source = asset?.source
        if (!source) return undefined
        const values = legacyDataByRef.get(`${source.projectId}|${source.collectionId}|${source.requestId}`)
        if (!values || values.length === 0) return undefined
        const unique = new Set(values.map((value) => JSON.stringify(value)))
        return unique.size === 1 ? values[0] : undefined
      }
      const results = []
      const exports = {}
      let passed = 0
      let skipped = 0
      for (const [index, entry] of testCase.assets.entries()) {
        if (entry?.skip === true) { results.push({ index, assetId: entry.assetId, skipped: true }); skipped += 1; continue }
        const asset = await readAsset(root, entry.assetId)
        if (!asset) {
          results.push({ index, assetId: entry.assetId, pass: false, error: `资产 "${entry.assetId}" 不存在` })
          continue
        }
        const entryData = entry.data !== undefined ? entry.data : legacyDataForAsset(asset)
        const effective = withAssetData(asset, entryData)
        try {
          const outcome = await runAsset(effective, { variables, factories, elements, root })
          // extract 变量(不论是否 export)在用例内传给后续资产;只有 export:true 的写会话缓存。
          for (const [name, value] of Object.entries(outcome.extracted ?? {})) variables[name] = value
          for (const [name, value] of Object.entries(outcome.exports ?? {})) { exports[name] = value; variables[name] = value }
          await applyAssetOutcome(root, asset, {
            pass: outcome.pass,
            durationMs: outcome.durationMs,
            status: outcome.status,
            environmentId,
            error: outcome.error,
            snapshot: asset.kind === 'ui' ? { steps: asset.steps } : asset.request,
          })
          if (outcome.pass === true) passed += 1
          results.push({ index, assetId: asset.id, name: asset.name, module: asset.module, kind: asset.kind, pass: outcome.pass, durationMs: outcome.durationMs, status: outcome.status, error: outcome.error, assertions: outcome.assertions, steps: outcome.steps })
        } catch (error) {
          results.push({ index, assetId: asset.id, name: asset.name, module: asset.module, kind: asset.kind, pass: false, error: error instanceof Error ? error.message : String(error) })
        }
      }
      await saveSessionExports(root, environmentId, exports)
      const executed = results.filter((item) => item.skipped !== true)
      const caseResult = {
        caseId, name: testCase.name, startedAt, durationMs: Date.now() - started,
        summary: { total: executed.length, passed, failed: executed.length - passed, skipped },
        results, exports,
      }
      if (caseResult.summary.failed > 0) {
        await recordHistory(root, { kind: 'case', name: `用例: ${testCase.name}`, pass: false, durationMs: caseResult.durationMs })
      }
      // 工作项结果回写:更新 result/resultAt 与最近一次执行耗时(报告耗时聚合用)。
      const caseFinishedAt = nowIso()
      const caseOutcome = caseResult.summary.failed > 0 ? 'failed' : 'passed'
      await mutateJson(root, `cases/${caseId}.json`, (current) => (current
        ? {
          ...current,
          result: caseOutcome,
          resultAt: caseFinishedAt,
          updatedAt: caseFinishedAt,
          lastRun: {
            at: caseFinishedAt,
            durationMs: caseResult.durationMs,
            result: caseOutcome,
            assets: caseResult.summary.total,
            passed: caseResult.summary.passed,
            failed: caseResult.summary.failed,
          },
        }
        : current)).catch(() => {})
      await refreshLatestReport(root, { trigger: 'case', environmentId: body.environmentId }).catch(() => {})
      sendJson(res, 200, { ok: true, result: caseResult, mode: 'assets' })
      return
    }
    // 旧格式用例(无 assets):按步骤执行,同样不生成报告,只保留失败记录。
    const report = await executeCase(
      testCase,
      (ref) => resolveCaseRef(root, ref),
      variables,
      factories,
      makeRunUi(ctx, root, variables, factories),
    )
    const executed = report.results.filter((item) => item.skipped !== true).length
    const legacyResult = {
      caseId,
      name: testCase.name,
      startedAt,
      durationMs: report.durationMs,
      summary: { total: executed, passed: report.summary.passed, failed: report.summary.failed, skipped: report.summary.skipped ?? (report.results.length - executed) },
      results: compactRunResults(report.results),
      exports: report.exports,
    }
    if (legacyResult.summary.failed > 0) {
      await recordHistory(root, { kind: 'case', name: `用例: ${testCase.name}`, pass: false, durationMs: report.durationMs })
    }
    const legacyFinishedAt = nowIso()
    const legacyOutcome = legacyResult.summary.failed > 0 ? 'failed' : 'passed'
    await mutateJson(root, `cases/${caseId}.json`, (current) => (current
      ? {
        ...current,
        result: legacyOutcome,
        resultAt: legacyFinishedAt,
        updatedAt: legacyFinishedAt,
        lastRun: {
          at: legacyFinishedAt,
          durationMs: legacyResult.durationMs,
          result: legacyOutcome,
          assets: legacyResult.summary.total,
          passed: legacyResult.summary.passed,
          failed: legacyResult.summary.failed,
        },
      }
      : current)).catch(() => {})
    await refreshLatestReport(root, { trigger: 'case', environmentId: body.environmentId }).catch(() => {})
    sendJson(res, 200, { ok: true, result: legacyResult, mode: 'legacy' })
    return
  }
  const id = pathId(pathname, base)
  if (method === 'GET' && id === undefined) {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const ids = await listJsonFiles(root, 'cases')
    const params = new URL(req.url ?? '', 'http://localhost').searchParams
    const tagFilters = [...params.getAll('tag'), ...params.getAll('tags').flatMap((value) => value.split(','))]
      .map((tag) => tag.trim()).filter(Boolean)
    const cases = []
    for (const caseId of ids) {
      const item = await readJson(root, `cases/${caseId}.json`).catch(() => undefined)
      if (item) {
        // 智能体直接写盘的文件可能缺 id/时间戳:以文件名为 id,缺失字段兜底,
        // 保证页面 key 与编辑/删除请求可用。
        cases.push({
          id: caseId,
          createdAt: '',
          updatedAt: '',
          ...item,
        })
      }
    }
    const filteredCases = tagFilters.length === 0
      ? cases
      : cases.filter((item) => (item.tags ?? []).some((tag) => tagFilters.includes(String(tag))))
    sendJson(res, 200, { ok: true, cases: filteredCases.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))) })
    return
  }
  if (method === 'POST' && id === undefined) {
    const body = await requestJson(req)
    const root = testModeRoot(ctx, requireWorkspaceId(body))
    const validation = await validateCaseInput(body, root)
    if (validation !== null) { sendJson(res, 400, { ok: false, message: validation }); return }
    const caseId = newId('case')
    const now = nowIso()
    const item = {
      id: caseId,
      name: String(body.name ?? '未命名用例'),
      description: typeof body.description === 'string' ? body.description : '',
      priority: String(body.priority ?? 'medium'),
      type: CASE_TEST_TYPES.includes(body.type) ? body.type : 'functional',
      automation: CASE_AUTOMATION_STATES.includes(body.automation) ? body.automation : 'manual',
      result: CASE_RESULT_STATES.includes(body.result) ? body.result : 'not_run',
      requirement: typeof body.requirement === 'string' ? body.requirement : '',
      defects: Array.isArray(body.defects) ? body.defects.map((item) => item.trim()) : [],
      preconditions: typeof body.preconditions === 'string' ? body.preconditions : '',
      steps: Array.isArray(body.steps) ? body.steps : [],
      ...(typeof body.module === 'string' && body.module.trim() ? { module: body.module.trim() } : {}),
      ...(Array.isArray(body.assets) ? { assets: body.assets.filter((entry) => entry && typeof entry.assetId === 'string') } : {}),
      tags: Array.isArray(body.tags) ? body.tags : [],
      ...(Array.isArray(body.dependsOn) ? { dependsOn: body.dependsOn } : {}),
      status: String(body.status ?? 'draft'),
      createdAt: now,
      updatedAt: now,
    }
    await writeJson(root, `cases/${caseId}.json`, item)
    sendJson(res, 200, { ok: true, case: item })
    return
  }
  if (id !== undefined) {
    if (method === 'GET') {
      const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
      const item = await readJson(root, `cases/${id}.json`)
      if (!item) { sendJson(res, 404, { ok: false, message: `case "${id}" was not found` }); return }
      sendJson(res, 200, { ok: true, case: { id, createdAt: '', updatedAt: '', ...item } })
      return
    }
    if (method === 'PUT') {
      const body = await requestJson(req)
      const root = testModeRoot(ctx, requireWorkspaceId(body))
      const validation = await validateCaseInput(body, root)
      if (validation !== null) { sendJson(res, 400, { ok: false, message: validation }); return }
      const updated = await mutateJson(root, `cases/${id}.json`, (current) => {
        if (!current) throw new Error(`case "${id}" was not found`)
        const next = { ...current }
        if (typeof body.name === 'string') next.name = body.name
        if (typeof body.description === 'string') next.description = body.description
        if (typeof body.priority === 'string') next.priority = body.priority
        if (CASE_TEST_TYPES.includes(body.type)) next.type = body.type
        if (CASE_AUTOMATION_STATES.includes(body.automation)) next.automation = body.automation
        if (CASE_RESULT_STATES.includes(body.result)) next.result = body.result
        if (typeof body.requirement === 'string') next.requirement = body.requirement
        if (Array.isArray(body.defects)) next.defects = body.defects.map((item) => item.trim())
        if (typeof body.preconditions === 'string') next.preconditions = body.preconditions
        if (Array.isArray(body.steps)) next.steps = body.steps
        if (typeof body.module === 'string') next.module = body.module
        if (Array.isArray(body.assets)) next.assets = body.assets.filter((entry) => entry && typeof entry.assetId === 'string')
        if (Array.isArray(body.tags)) next.tags = body.tags
        if (Array.isArray(body.dependsOn)) next.dependsOn = body.dependsOn
        if (typeof body.status === 'string') next.status = body.status
        next.id = id
        next.createdAt = current.createdAt ?? nowIso()
        next.updatedAt = nowIso()
        return next
      })
      sendJson(res, 200, { ok: true, case: updated })
      return
    }
    if (method === 'DELETE') {
      const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
      await deleteJson(root, `cases/${id}.json`)
      sendJson(res, 200, { ok: true })
      return
    }
  }
  sendJson(res, 404, { ok: false, message: `${method} ${pathname} was not found` })
}

/**
 * 校验用例输入(创建/更新)。只校验请求体提供的字段(PUT 部分更新语义);
 * requestRef/uiRef 的引用必须真实存在(读磁盘核对),捏造的 id 会被拒绝。
 * @param body - 请求体。
 * @param root - test-mode 根目录。
 * @returns 错误信息字符串;合法时返回 null。
 */
/** 测试工作项类型(测试工作项内的四个标签页)。 */
const CASE_TEST_TYPES = ['functional', 'e2e', 'performance', 'security']
/** 自动化状态。 */
const CASE_AUTOMATION_STATES = ['manual', 'auto', 'partial']
/** 执行结果。 */
const CASE_RESULT_STATES = ['not_run', 'passed', 'failed', 'blocked', 'skipped']

async function validateCaseInput(body, root) {
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
    return 'case name is required'
  }
  if (body.priority !== undefined && !['high', 'medium', 'low'].includes(body.priority)) {
    return `invalid priority "${body.priority}" (must be high/medium/low)`
  }
  if (body.status !== undefined && !['draft', 'active', 'archived'].includes(body.status)) {
    return `invalid status "${body.status}" (must be draft/active/archived)`
  }
  if (body.type !== undefined && !CASE_TEST_TYPES.includes(body.type)) {
    return `invalid type "${body.type}" (must be ${CASE_TEST_TYPES.join('/')})`
  }
  if (body.automation !== undefined && !CASE_AUTOMATION_STATES.includes(body.automation)) {
    return `invalid automation "${body.automation}" (must be ${CASE_AUTOMATION_STATES.join('/')})`
  }
  if (body.result !== undefined && !CASE_RESULT_STATES.includes(body.result)) {
    return `invalid result "${body.result}" (must be ${CASE_RESULT_STATES.join('/')})`
  }
  if (body.requirement !== undefined && typeof body.requirement !== 'string') {
    return 'requirement must be a string (需求编号/链接/描述)'
  }
  if (body.defects !== undefined) {
    if (!Array.isArray(body.defects)) return 'defects must be an array of ticket refs'
    for (let i = 0; i < body.defects.length; i += 1) {
      if (typeof body.defects[i] !== 'string' || !body.defects[i].trim()) {
        return `defects[${i}] must be a non-empty string (ticket ref, e.g. #473 or issue URL)`
      }
    }
  }
  const tags = body.tags
  if (tags !== undefined) {
    if (!Array.isArray(tags)) return 'tags must be an array'
    const tagLibrary = await loadTags(root)
    if (tagLibrary.length > 0) {
      for (const tag of tags) {
        if (typeof tag !== 'string' || !tagLibrary.includes(tag)) {
          return `tag "${String(tag)}" is not in the tag library (test-mode/tags.json); use an existing tag or add it in the 基础配置 page first`
        }
      }
    }
  }
  // 依赖的数据库参考表(增量:表文件变更时自动纳入该用例)。
  const dependsOn = body.dependsOn
  if (dependsOn !== undefined) {
    if (!Array.isArray(dependsOn) || dependsOn.some((item) => typeof item !== 'string' || !item.trim())) {
      return 'dependsOn must be an array of table names (from test-mode/dbdata/)'
    }
  }
  const steps = body.steps
  if (steps !== undefined) {
    if (!Array.isArray(steps)) return 'steps must be an array'
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]
      if (typeof step !== 'object' || step === null) return `steps[${i}] must be an object`
      if (typeof step.action !== 'string' || !step.action.trim()) return `steps[${i}].action is required`
      if (step.expected !== undefined && typeof step.expected !== 'string') return `steps[${i}].expected must be a string`
      const requestRef = step.requestRef
      if (requestRef !== undefined && requestRef !== null) {
        if (typeof requestRef !== 'object') return `steps[${i}].requestRef must be an object`
        const { projectId, collectionId, requestId } = requestRef
        if (typeof projectId !== 'string' || !projectId || typeof collectionId !== 'string' || !collectionId || typeof requestId !== 'string' || !requestId) {
          return `steps[${i}].requestRef must have string projectId/collectionId/requestId`
        }
        const project = await readJson(root, `api/projects/${projectId}.json`).catch(() => undefined)
        const collection = (project?.collections ?? []).find((item) => (item.id ?? item.name) === collectionId)
        const request = (collection?.requests ?? []).find((item) => (item.id ?? item.name) === requestId)
        if (!project || !collection || !request) {
          return `steps[${i}].requestRef points to a missing resource: project "${projectId}" collection "${collectionId}" request "${requestId}"`
        }
      }
      const uiRef = step.uiRef
      if (uiRef !== undefined && uiRef !== null) {
        if (typeof uiRef !== 'object' || typeof uiRef.scriptId !== 'string' || !uiRef.scriptId) {
          return `steps[${i}].uiRef must have a string scriptId`
        }
        const script = await readJson(root, `ui/scripts/${uiRef.scriptId}.json`).catch(() => undefined)
        if (!script) return `steps[${i}].uiRef points to a missing script "${uiRef.scriptId}"`
      }
      // 步骤级数据覆盖:data = { url?, body?, query?, headers? },字段可省。
      const stepData = step.data
      if (stepData !== undefined && stepData !== null) {
        if (typeof stepData !== 'object' || Array.isArray(stepData)) return `steps[${i}].data must be an object`
        if (stepData.url !== undefined && typeof stepData.url !== 'string') return `steps[${i}].data.url must be a string`
        if (stepData.body !== undefined && typeof stepData.body !== 'string' && typeof stepData.body !== 'object') {
          return `steps[${i}].data.body must be a string or an object`
        }
        for (const field of ['query', 'headers']) {
          if (stepData[field] !== undefined && (typeof stepData[field] !== 'object' || stepData[field] === null || Array.isArray(stepData[field]))) {
            return `steps[${i}].data.${field} must be an object`
          }
        }
      }
    }
  }
  return null
}

/**
 * 校验项目输入(创建/更新):集合/请求的结构与枚举。
 * @param body - 请求体。
 * @returns 错误信息字符串;合法时返回 null。
 */
function validateProjectInput(body) {
  if (typeof body.name !== 'string' || !body.name.trim()) return 'project name is required'
  const collections = body.collections
  if (collections === undefined) return null
  if (!Array.isArray(collections)) return 'collections must be an array'
  for (let ci = 0; ci < collections.length; ci += 1) {
    const collection = collections[ci]
    if (typeof collection !== 'object' || collection === null) return `collections[${ci}] must be an object`
    if (typeof collection.name !== 'string' || !collection.name.trim()) return `collections[${ci}].name is required`
    const requests = collection.requests
    if (requests === undefined) continue
    if (!Array.isArray(requests)) return `collections[${ci}].requests must be an array`
    for (let ri = 0; ri < requests.length; ri += 1) {
      const request = requests[ri]
      if (typeof request !== 'object' || request === null) return `collections[${ci}].requests[${ri}] must be an object`
      if (typeof request.name !== 'string' || !request.name.trim()) return `collections[${ci}].requests[${ri}].name is required`
      const method = String(request.method ?? '').toUpperCase()
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
        return `collections[${ci}].requests[${ri}].method must be one of GET/POST/PUT/PATCH/DELETE/HEAD`
      }
      if (typeof request.url !== 'string' || !request.url.trim()) return `collections[${ci}].requests[${ri}].url is required`
      const assertions = request.assertions
      if (assertions !== undefined) {
        if (!Array.isArray(assertions)) return `collections[${ci}].requests[${ri}].assertions must be an array`
        for (let ai = 0; ai < assertions.length; ai += 1) {
          const assertion = assertions[ai]
          if (typeof assertion !== 'object' || assertion === null) return `collections[${ci}].requests[${ri}].assertions[${ai}] must be an object`
          if (!['status', 'header', 'body', 'json', 'duration'].includes(assertion.type)) {
            return `collections[${ci}].requests[${ri}].assertions[${ai}].type must be status/header/body/json/duration`
          }
          if (!['eq', 'ne', 'gt', 'ge', 'lt', 'le', 'contains', 'regex'].includes(assertion.operator)) {
            return `collections[${ci}].requests[${ri}].assertions[${ai}].operator must be eq/ne/gt/ge/lt/le/contains/regex`
          }
          if (assertion.expected === undefined) return `collections[${ci}].requests[${ri}].assertions[${ai}].expected is required`
        }
      }
      const extract = request.extract
      if (extract !== undefined) {
        if (!Array.isArray(extract)) return `collections[${ci}].requests[${ri}].extract must be an array`
        for (let ei = 0; ei < extract.length; ei += 1) {
          const item = extract[ei]
          // 两种键名都接受:{ name, path } 与 { key, value }
          const ruleName = item?.name ?? item?.key
          const rulePath = item?.path ?? item?.value
          if (typeof item !== 'object' || item === null || typeof ruleName !== 'string' || !ruleName) {
            return `collections[${ci}].requests[${ri}].extract[${ei}] must have a string name (or key)`
          }
          if (item.from !== undefined && item.from !== 'json' && item.from !== 'header') {
            return `collections[${ci}].requests[${ri}].extract[${ei}].from must be json or header`
          }
          if (item.export !== undefined && typeof item.export !== 'boolean') {
            return `collections[${ci}].requests[${ri}].extract[${ei}].export must be a boolean`
          }
          if (item.from === 'header') {
            if (typeof rulePath !== 'string' || !rulePath) {
              return `collections[${ci}].requests[${ri}].extract[${ei}].path (or value) must be a header name when from is header`
            }
          } else if (typeof rulePath !== 'string' || !rulePath.startsWith('$')) {
            return `collections[${ci}].requests[${ri}].extract[${ei}].path (or value) must be a JSON path starting with $`
          }
        }
      }
    }
  }
  return null
}

/**
 * 规范化接口路径用于用例-接口匹配:去掉协议/主机/查询/哈希,保留路径。
 * @param url - 原始 URL(可为相对路径)。
 * @returns 规范化后的路径(如 /api/users);无法解析时返回 null。
 */
function normalizeInterfacePath(url) {
  const text = String(url ?? '').trim()
  if (!text) return null
  let path = text
  try {
    if (/^https?:\/\//i.test(text)) path = new URL(text).pathname
    else path = text.split(/[?#]/)[0]
  } catch {
    path = text.split(/[?#]/)[0]
  }
  return path.replace(/\/+$/, '') || '/'
}

/**
 * 从用例步骤里提取涉及的接口(method + 规范化路径)集合。
 * 来源优先级:1) requestRef 指向的真实请求;2) step.data.url/step.data.method;
 * 3) 步骤描述开头的 "METHOD /path"(如 "GET /api/announcements")。
 * @param root - test-mode 根目录。
 * @param step - 用例步骤。
 * @returns [{ method, url, path }] 提取到的接口列表。
 */
async function stepInterfaceKeys(root, step) {
  const keys = []
  const push = (method, url) => {
    const path = normalizeInterfacePath(url)
    if (!path) return
    keys.push({ method: String(method ?? 'GET').toUpperCase(), url: String(url ?? ''), path })
  }
  if (step?.requestRef && typeof step.requestRef === 'object') {
    const resolved = await resolveRequestRef(root, step.requestRef).catch(() => null)
    if (resolved?.request) push(resolved.request.method, resolved.request.url)
  }
  if (step?.data && typeof step.data === 'object') {
    if (typeof step.data.url === 'string' && step.data.url) {
      const method = typeof step.data.method === 'string' ? step.data.method : undefined
      if (method || /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s/i.test(String(step.action ?? ''))) push(method, step.data.url)
    }
  }
  const actionMatch = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)/i.exec(String(step?.action ?? ''))
  if (actionMatch) push(actionMatch[1], actionMatch[2])
  return keys
}

/** 请求指纹:method + url(导入/保存时识别变更)。 */
function requestKey(request) {
  return `${String(request?.method ?? 'GET').toUpperCase()} ${String(request?.url ?? '')}`
}

/**
 * 对比新旧请求集合,识别 added/modified/removed,并按需给变更请求打 updatedAt 戳。
 * 内容比较忽略 id/updatedAt/lastRun(导入会重新生成 id)。
 * @param previous - 旧请求数组(可 undefined)。
 * @param next - 新请求数组。
 * @param now - ISO 时间戳;null 时不打戳。
 * @returns { requests, changes } requests 为打戳后的新请求;changes 为
 *   [{ method, url, change: 'added'|'modified'|'removed' }]。
 */
function diffRequests(previous, next, now) {
  const prevMap = new Map((previous ?? []).map((request) => [requestKey(request), request]))
  const nextMap = new Map((next ?? []).map((request) => [requestKey(request), request]))
  // extract 支持两种键名({ name, path } 与旧格式 { key, value }),比较前归一化,
  // 避免仅格式差异导致请求被误判为修改、错误打上 updatedAt。
  const normalizeExtract = (extract) => Array.isArray(extract)
    ? extract.map((rule) => ({
      name: rule?.name ?? rule?.key,
      path: rule?.path ?? rule?.value,
      from: rule?.from ?? 'json',
      export: rule?.export ?? false,
    }))
    : extract
  const shape = (request) => {
    const { id, updatedAt, lastRun, ...rest } = request ?? {}
    return JSON.stringify({ ...rest, extract: normalizeExtract(rest.extract) })
  }
  const changes = []
  for (const [key, request] of nextMap) {
    const prev = prevMap.get(key)
    if (!prev) changes.push({ method: String(request.method ?? 'GET').toUpperCase(), url: String(request.url ?? ''), change: 'added' })
    else if (shape(prev) !== shape(request)) changes.push({ method: String(request.method ?? 'GET').toUpperCase(), url: String(request.url ?? ''), change: 'modified' })
  }
  for (const [key, request] of prevMap) {
    if (!nextMap.has(key)) changes.push({ method: String(request.method ?? 'GET').toUpperCase(), url: String(request.url ?? ''), change: 'removed' })
  }
  const changedKeys = new Set(changes.filter((change) => change.change !== 'removed').map((change) => `${change.method} ${change.url}`))
  const requests = (next ?? []).map((request) => {
    const key = requestKey(request)
    const prev = prevMap.get(key)
    if (changedKeys.has(key)) return { ...request, updatedAt: now }
    return { ...request, ...(prev?.updatedAt ? { updatedAt: prev.updatedAt } : {}) }
  })
  return { requests, changes }
}

/**
 * 写一份变更清单到 test-mode/changelogs/<id>.json。
 * @param root - test-mode 根目录。
 * @param entry - { name, version?, source, changedRequests?, changedCases?,
 *   changedScripts?, changedElements?, changedTables?, modules?, note? }。
 * @returns 落盘的变更清单记录。
 */
async function writeChangelog(root, entry) {
  const id = `chg-${newId('').slice(4)}`
  const record = { id, createdAt: nowIso(), ...entry }
  await writeJson(root, `changelogs/${id}.json`, record)
  return record
}

/** 列出 dbdata 目录下的参考数据文件(去扩展名)。 */
async function listDbDataFiles(root) {
  const dir = resolve(root, 'dbdata')
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  return entries
    .filter((entry) => entry.isFile() && /\.(csv|md|xlsx)$/i.test(entry.name))
    .map((entry) => ({ name: entry.name.replace(/\.(csv|md|xlsx)$/i, ''), file: entry.name }))
}

/**
 * 为项目的集合/请求补齐稳定 id:旧数据(如早期创建或导入)的集合/请求可能
 * 没有 id 字段,导致前端 `collection.id === selectedCollectionId` 变成
 * `undefined === undefined`——所有集合同时匹配、接口清单全部展开。
 * 用名称派生 id(name 在同一项目内唯一,id 稳定不漂移)。
 * @param project - 项目对象(会被浅拷贝,原对象不变)。
 * @returns 补齐 id 后的项目对象。
 */
function normalizeProject(project) {
  const collections = (project.collections ?? []).map((collection, ci) => {
    const col = { ...collection }
    if (typeof col.id !== 'string' || !col.id) col.id = `col-${col.name ?? ci + 1}`
    col.requests = (col.requests ?? []).map((request, ri) => {
      const req = { ...request }
      if (typeof req.id !== 'string' || !req.id) req.id = `req-${req.name ?? ri + 1}`
      if (typeof req.method === 'string' && req.method) req.method = req.method.toUpperCase()
      return req
    })
    return col
  })
  return { ...project, collections }
}

/**
 * API 项目 handler(项目含 collections → requests)。
 */
async function handleProjects(ctx, req, res, pathname, method) {
  const base = `${ROUTE_ROOT}/api/projects`
  const id = pathId(pathname, base)
  if (method === 'GET' && id === undefined) {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const ids = await listJsonFiles(root, 'api/projects')
    const projects = []
    for (const projectId of ids) {
      const item = await readJson(root, `api/projects/${projectId}.json`)
      if (item) projects.push(normalizeProject(item))
    }
    sendJson(res, 200, { ok: true, projects: projects.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))) })
    return
  }
  if (method === 'POST' && id === undefined) {
    const body = await requestJson(req)
    const root = testModeRoot(ctx, requireWorkspaceId(body))
    const validation = validateProjectInput(body)
    if (validation !== null) { sendJson(res, 400, { ok: false, message: validation }); return }
    const projectId = newId('proj')
    const now = nowIso()
    const item = normalizeProject({
      id: projectId,
      name: String(body.name ?? '未命名项目'),
      baseUrl: typeof body.baseUrl === 'string' ? body.baseUrl : '',
      collections: Array.isArray(body.collections) ? body.collections : [],
      createdAt: now,
      updatedAt: now,
    })
    await writeJson(root, `api/projects/${projectId}.json`, item)
    sendJson(res, 200, { ok: true, project: item })
    return
  }
  if (id !== undefined) {
    if (method === 'GET') {
      const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
      const item = await readJson(root, `api/projects/${id}.json`)
      if (!item) { sendJson(res, 404, { ok: false, message: `project "${id}" was not found` }); return }
      sendJson(res, 200, { ok: true, project: normalizeProject(item) })
      return
    }
    if (method === 'PUT') {
      const body = await requestJson(req)
      const root = testModeRoot(ctx, requireWorkspaceId(body))
      const validation = validateProjectInput(body)
      if (validation !== null) { sendJson(res, 400, { ok: false, message: validation }); return }
      const now = nowIso()
      let stampChanges = []
      const updated = await mutateJson(root, `api/projects/${id}.json`, (current) => {
        if (!current) throw new Error(`project "${id}" was not found`)
        const next = { ...current }
        if (typeof body.name === 'string') next.name = body.name
        if (typeof body.baseUrl === 'string') next.baseUrl = body.baseUrl
        if (Array.isArray(body.collections)) {
          // 请求级变更打标:diff 出 added/modified/removed,变更请求写 updatedAt。
          const prevFlat = (current.collections ?? []).flatMap((c) => c.requests ?? [])
          const { requests, changes } = diffRequests(prevFlat, body.collections.flatMap((c) => c.requests ?? []), now)
          stampChanges = changes
          const byKey = new Map(requests.map((request) => [requestKey(request), request]))
          next.collections = body.collections.map((collection) => ({
            ...collection,
            requests: (collection.requests ?? []).map((request) => byKey.get(requestKey(request)) ?? request),
          }))
        }
        next.updatedAt = now
        return normalizeProject(next)
      })
      // 删除的接口只存在于变更清单里(文件里已消失),单独落一份清单供增量感知。
      if (stampChanges.some((change) => change.change === 'removed')) {
        await writeChangelog(root, {
          name: `${updated.name} 手动编辑`,
          source: 'manual',
          changedRequests: stampChanges.map((change) => ({ ...change, projectId: id })),
        })
      }
      sendJson(res, 200, { ok: true, project: updated })
      return
    }
    if (method === 'DELETE') {
      const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
      await deleteJson(root, `api/projects/${id}.json`)
      sendJson(res, 200, { ok: true })
      return
    }
  }
  sendJson(res, 404, { ok: false, message: `${method} ${pathname} was not found` })
}

/** 默认标签分类。 */
const DEFAULT_TAG_CATEGORIES = [
  { id: 'test-type', name: '测试类型' },
  { id: 'function', name: '功能/模块' },
  { id: 'uncategorized', name: '未分类' },
]

/** 测试类型标签的自动归类规则(旧平铺标签迁移用)。 */
const TEST_TYPE_TAG_PATTERN = /冒烟|回归|安全|性能|e2e|ui|接口|功能|兼容|边界|负向|异常|稳定|巡检/i

/** 标签分类 id(ascii slug)。 */
function tagCategoryId(name) {
  const slug = String(name ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug ? `cat-${slug}` : `cat-${Date.now().toString(36)}`
}

/**
 * 归一化标签库:兼容旧 `{ tags: string[] }` 与新版 `{ categories: [...] }`。
 * - 标签名全局唯一(重复时保留第一个);
 * - 分类 id/名称唯一;缺少默认「未分类」时补齐。
 * @param data - tags.json 内容(可 undefined)。
 * @returns { version: 2, categories }。
 */
function normalizeTagData(data) {
  const categories = []
  const seenTags = new Set()
  const seenIds = new Set()
  const seenNames = new Set()
  const pushCategory = (category) => {
    const name = String(category?.name ?? '').trim()
    if (!name || seenNames.has(name)) return
    let id = String(category?.id ?? '').trim() || tagCategoryId(name)
    if (seenIds.has(id)) id = `${id}-${categories.length + 1}`
    const tags = []
    for (const tag of category?.tags ?? []) {
      const value = String(tag ?? '').trim()
      if (!value || seenTags.has(value)) continue
      seenTags.add(value)
      tags.push(value)
    }
    seenIds.add(id)
    seenNames.add(name)
    categories.push({ id, name, tags })
  }
  if (data && Array.isArray(data.categories)) {
    for (const category of data.categories) pushCategory(category)
  } else if (data && Array.isArray(data.tags)) {
    // 旧平铺标签:测试类型相关进 test-type,其余进未分类。
    const testTypeTags = []
    const rest = []
    for (const tag of data.tags) {
      const value = String(tag ?? '').trim()
      if (!value) continue
      if (TEST_TYPE_TAG_PATTERN.test(value)) testTypeTags.push(value)
      else rest.push(value)
    }
    pushCategory({ id: 'test-type', name: '测试类型', tags: testTypeTags })
    pushCategory({ id: 'uncategorized', name: '未分类', tags: rest })
  }
  for (const category of DEFAULT_TAG_CATEGORIES) {
    if (!categories.some((item) => item.name === category.name)) {
      pushCategory({ id: category.id, name: category.name, tags: [] })
    }
  }
  // 默认分类排在前面(测试类型/功能/未分类),其余按名称排序。
  const order = new Map(DEFAULT_TAG_CATEGORIES.map((item, index) => [item.name, index]))
  categories.sort((a, b) => {
    const oa = order.has(a.name) ? order.get(a.name) : 100
    const ob = order.has(b.name) ? order.get(b.name) : 100
    return oa - ob || a.name.localeCompare(b.name)
  })
  return { version: 2, categories }
}

/** 平铺标签数组。 */
function flatTags(data) {
  return (data?.categories ?? []).flatMap((category) => category.tags ?? [])
}

/**
 * 读取标签库(归一化;文件缺失时从用例标签播种)。
 * @param root - test-mode 根目录。
 * @returns { version, categories }。
 */
async function loadTagData(root) {
  const raw = await readJson(root, 'tags.json').catch(() => undefined)
  if (raw) {
    const normalized = normalizeTagData(raw)
    // 旧平铺结构({ tags })首次读取时落盘为分类结构,避免重复迁移。
    if (!Array.isArray(raw.categories)) {
      await writeJson(root, 'tags.json', normalized).catch(() => {})
    }
    return normalized
  }
  const ids = await listJsonFiles(root, 'cases')
  const collected = new Set()
  for (const caseId of ids) {
    const item = await readJson(root, `cases/${caseId}.json`).catch(() => undefined)
    for (const tag of item?.tags ?? []) {
      if (typeof tag === 'string' && tag.trim()) collected.add(tag.trim())
    }
  }
  if (collected.size === 0) return normalizeTagData(undefined)
  const seeded = normalizeTagData({ tags: [...collected].sort() })
  await writeJson(root, 'tags.json', seeded).catch(() => {})
  return seeded
}

/**
 * 读取标签名数组(兼容旧调用)。
 * @param root - test-mode 根目录。
 * @returns 平铺标签数组。
 */
async function loadTags(root) {
  return flatTags(await loadTagData(root))
}

/**
 * 资产标签与标签库的差异(软提示,不拒绝保存)。
 * @param root - test-mode 根目录。
 * @param tags - 资产标签数组。
 * @returns 不在标签库中的标签(库为空时不校验)。
 */
async function unknownAssetTags(root, tags) {
  const known = new Set(await loadTags(root))
  if (known.size === 0) return []
  return (Array.isArray(tags) ? tags : []).filter((tag) => typeof tag === 'string' && !known.has(tag))
}

/**
 * 标签库 handler:
 * - GET    /api/tags                    平铺标签 + 分类;
 * - POST   /api/tags { name, category? } 新增标签(分类不存在时自动创建);
 * - PUT    /api/tags/:name              重命名/移动标签;
 * - DELETE /api/tags/:name              删除标签;
 * - POST   /api/tags/categories { name } 新增分类;
 * - DELETE /api/tags/categories/:id?moveTo=id 删除分类(有标签需 moveTo)。
 */
async function handleTags(ctx, req, res, pathname, method) {
  const base = `${ROUTE_ROOT}/api/tags`
  const wsOf = (url) => ({ workspaceId: new URL(url ?? '', 'http://localhost').searchParams.get('workspaceId') })
  const save = async (root, data) => {
    await writeJson(root, 'tags.json', data)
    return data
  }
  const reply = (res, data) => sendJson(res, 200, { ok: true, tags: flatTags(data), categories: data.categories })

  // 分类路由优先于 :name
  if (pathname === `${base}/categories` && method === 'POST') {
    const body = await requestJson(req)
    const root = testModeRoot(ctx, requireWorkspaceId(body))
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) { sendJson(res, 400, { ok: false, message: 'category name is required' }); return }
    const data = await loadTagData(root)
    if (data.categories.some((category) => category.name === name)) {
      sendJson(res, 400, { ok: false, message: `category "${name}" already exists` }); return
    }
    const category = { id: tagCategoryId(name), name, tags: [] }
    data.categories.push(category)
    data.categories = normalizeTagData(data).categories
    await save(root, data)
    reply(res, data)
    return
  }
  const categoryId = pathname.startsWith(`${base}/categories/`) ? pathId(pathname, `${base}/categories`) : undefined
  if (categoryId !== undefined && method === 'DELETE') {
    const root = testModeRoot(ctx, requireWorkspaceId(wsOf(req.url)))
    const params = new URL(req.url ?? '', 'http://localhost').searchParams
    const moveTo = params.get('moveTo') ?? ''
    const data = await loadTagData(root)
    const category = data.categories.find((item) => item.id === categoryId || item.name === categoryId)
    if (!category) { sendJson(res, 404, { ok: false, message: `category "${categoryId}" was not found` }); return }
    if ((category.tags ?? []).length > 0) {
      const target = moveTo ? data.categories.find((item) => item.id === moveTo || item.name === moveTo) : undefined
      if (!target || target.id === category.id) {
        sendJson(res, 400, { ok: false, message: 'category is not empty; pass moveTo=<category id> to move its tags' })
        return
      }
      target.tags = [...new Set([...(target.tags ?? []), ...category.tags])]
    }
    data.categories = data.categories.filter((item) => item.id !== category.id)
    data.categories = normalizeTagData(data).categories
    await save(root, data)
    reply(res, data)
    return
  }

  if (method === 'GET' && pathId(pathname, base) === undefined) {
    const root = testModeRoot(ctx, requireWorkspaceId(wsOf(req.url)))
    reply(res, await loadTagData(root))
    return
  }
  if (method === 'POST' && pathId(pathname, base) === undefined) {
    const body = await requestJson(req)
    const root = testModeRoot(ctx, requireWorkspaceId(body))
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) { sendJson(res, 400, { ok: false, message: 'tag name is required' }); return }
    const categoryName = typeof body.category === 'string' ? body.category.trim() : ''
    const data = await loadTagData(root)
    if (flatTags(data).includes(name)) { sendJson(res, 400, { ok: false, message: `tag "${name}" already exists` }); return }
    let category = categoryName
      ? data.categories.find((item) => item.id === categoryName || item.name === categoryName)
      : undefined
    if (!category && categoryName) {
      category = { id: tagCategoryId(categoryName), name: categoryName, tags: [] }
      data.categories.push(category)
    }
    category = category ?? data.categories.find((item) => item.name === '未分类') ?? data.categories[0]
    category.tags = [...(category.tags ?? []), name].sort()
    data.categories = normalizeTagData(data).categories
    await save(root, data)
    reply(res, data)
    return
  }

  const id = pathId(pathname, base)
  if (id !== undefined && (method === 'PUT' || method === 'DELETE')) {
    const name = decodeURIComponent(id)
    const body = method === 'PUT' ? await requestJson(req) : {}
    const root = testModeRoot(ctx, requireWorkspaceId(method === 'PUT' ? body : wsOf(req.url)))
    const data = await loadTagData(root)
    const owner = data.categories.find((category) => (category.tags ?? []).includes(name))
    if (!owner) { sendJson(res, 404, { ok: false, message: `tag "${name}" was not found` }); return }
    if (method === 'DELETE') {
      owner.tags = owner.tags.filter((tag) => tag !== name)
      await save(root, data)
      reply(res, data)
      return
    }
    const nextName = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : name
    if (nextName !== name && flatTags(data).includes(nextName)) {
      sendJson(res, 400, { ok: false, message: `tag "${nextName}" already exists` }); return
    }
    const categoryKey = typeof body.category === 'string' ? body.category.trim() : ''
    owner.tags = owner.tags.filter((tag) => tag !== name)
    let target = categoryKey
      ? data.categories.find((item) => item.id === categoryKey || item.name === categoryKey)
      : owner
    if (!target && categoryKey) {
      target = { id: tagCategoryId(categoryKey), name: categoryKey, tags: [] }
      data.categories.push(target)
    }
    target = target ?? owner
    target.tags = [...new Set([...(target.tags ?? []), nextName])].sort()
    data.categories = normalizeTagData(data).categories
    await save(root, data)
    reply(res, data)
    return
  }
  sendJson(res, 404, { ok: false, message: `${method} ${pathname} was not found` })
}

/**
 * 数据库参考数据 handler:GET /api/dbdata — 解析 test-mode/dbdata/ 目录
 * (schema.md + <表名>.csv/.md/.xlsx),返回各表字段/行数/样例行。
 */
async function handleDbData(ctx, req, res) {
  const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
  const data = await loadDbDataTables(root)
  sendJson(res, 200, { ok: true, ...data })
}

/**
 * 记录请求的最后执行状态(缺口分析用):在项目文件的请求对象上写
 * lastRun = { pass, status, at }。失败静默(项目文件不存在等不阻塞执行)。
 */
/**
 * 记录 UI 脚本执行结果:更新脚本状态与累计计数;通过时保存通过时的脚本步骤快照
 * (`lastPassed.steps`),便于对照/恢复。执行的截图等过程数据不进报告。
 * @param root - test-mode 根目录。
 * @param scriptId - 脚本 id。
 * @param outcome - { pass, durationMs?, environmentId?, steps? }。
 */
async function updateUiScriptStatus(root, scriptId, outcome) {
  if (!scriptId) return
  const pass = outcome?.pass === true
  const durationMs = Math.max(Number(outcome?.durationMs ?? 0) || 0, 0)
  const environmentId = typeof outcome?.environmentId === 'string' && outcome.environmentId ? outcome.environmentId : undefined
  await mutateJson(root, `ui/scripts/${scriptId}.json`, (current) => {
    if (!current) return current
    const previousStats = current.stats ?? { runs: 0, passed: 0, failed: 0, totalDurationMs: 0 }
    const stats = {
      runs: (previousStats.runs ?? 0) + 1,
      passed: (previousStats.passed ?? 0) + (pass ? 1 : 0),
      failed: (previousStats.failed ?? 0) + (pass ? 0 : 1),
      totalDurationMs: (previousStats.totalDurationMs ?? 0) + durationMs,
    }
    const lastRun = { pass, at: nowIso(), durationMs, ...(environmentId ? { environmentId } : {}) }
    const next = { ...current, lastRun, stats }
    if (pass) {
      next.lastPassed = {
        at: lastRun.at,
        durationMs,
        ...(environmentId ? { environmentId } : {}),
        steps: Array.isArray(current.steps) ? current.steps : [],
      }
    }
    return next
  }).catch(() => {})
}

/**
 * 记录接口执行结果:更新状态与累计计数;通过时把本次请求数据(原始模板,
 * 变量未替换)保存到接口配置的 `lastPassed`,便于复用"通过时的配置"。
 * @param root - test-mode 根目录。
 * @param projectId - 项目 id。
 * @param collectionId - 集合 id。
 * @param requestId - 请求 id。
 * @param outcome - { pass, status, durationMs?, environmentId?, request? }。
 */
async function updateRequestStatus(root, projectId, collectionId, requestId, outcome) {
  if (!projectId || !collectionId || !requestId) return
  const pass = outcome?.pass === true
  const status = outcome?.status
  const durationMs = Math.max(Number(outcome?.durationMs ?? 0) || 0, 0)
  const environmentId = typeof outcome?.environmentId === 'string' && outcome.environmentId ? outcome.environmentId : undefined
  const rawRequest = outcome?.request
  await mutateJson(root, `api/projects/${projectId}.json`, (current) => {
    if (!current) return current
    const collections = (current.collections ?? []).map((collection) => {
      const collectionAliases = [collection.id, collection.name, collection.name ? `col-${collection.name}` : undefined]
      if (!collectionAliases.includes(collectionId)) return collection
      const requests = (collection.requests ?? []).map((request) => {
        const requestAliases = [request.id, request.name, request.name ? `req-${request.name}` : undefined]
        if (!requestAliases.includes(requestId)) return request
        const previousStats = request.stats ?? { runs: 0, passed: 0, failed: 0, totalDurationMs: 0 }
        const stats = {
          runs: (previousStats.runs ?? 0) + 1,
          passed: (previousStats.passed ?? 0) + (pass ? 1 : 0),
          failed: (previousStats.failed ?? 0) + (pass ? 0 : 1),
          totalDurationMs: (previousStats.totalDurationMs ?? 0) + durationMs,
        }
        const lastRun = { pass, status, at: nowIso(), durationMs, ...(environmentId ? { environmentId } : {}) }
        const next = { ...request, lastRun, stats }
        if (pass && rawRequest !== null && typeof rawRequest === 'object') {
          // 只保存请求数据的原始模板(method/url/headers/query/body/assertions/extract),
          // 不保存变量替换后的实际值,避免 token/cookie 等敏感数据落入项目文件。
          next.lastPassed = {
            at: lastRun.at,
            status,
            durationMs,
            ...(environmentId ? { environmentId } : {}),
            request: pickRawRequest(rawRequest),
          }
        }
        return next
      })
      return { ...collection, requests }
    })
    return { ...current, collections }
  }).catch(() => {})
}

/**
 * 用例执行后同步接口状态:遍历步骤的 requestRef,把该步骤结果写入对应接口配置
 * (通过时保存 lastPassed 快照;不写历史)。
 * @param root - test-mode 根目录。
 * @param testCase - 用例对象。
 * @param report - executeCase 的执行结果。
 * @param environmentId - 生效环境 id。
 */
async function updateCaseRequestStatuses(root, testCase, report, environmentId) {
  const projectCache = new Map()
  for (const result of report.results ?? []) {
    const step = testCase.steps?.[result.stepIndex]
    const ref = step?.requestRef
    if (!ref || typeof ref !== 'object' || !ref.projectId || !ref.collectionId) continue
    let project = projectCache.get(ref.projectId)
    if (project === undefined) {
      project = await readJson(root, `api/projects/${ref.projectId}.json`).catch(() => null)
      projectCache.set(ref.projectId, project)
    }
    if (!project) continue
    const collection = (project.collections ?? []).find((item) => [item.id, item.name, item.name ? `col-${item.name}` : undefined].includes(ref.collectionId))
    const requestConfig = (collection?.requests ?? []).find((request) => [request.id, request.name, request.name ? `req-${request.name}` : undefined].includes(ref.requestId))
    await updateRequestStatus(root, ref.projectId, ref.collectionId, ref.requestId ?? result.requestId, {
      pass: result.pass === true,
      status: result.status,
      durationMs: result.durationMs,
      environmentId,
      request: requestConfig,
    })
  }
  for (const result of report.results ?? []) {
    if (result.kind !== 'ui' || !result.scriptId) continue
    await updateUiScriptStatus(root, result.scriptId, {
      pass: result.pass === true,
      durationMs: result.durationMs,
      environmentId,
    })
  }
}

/**
 * 提取请求配置里的原始模板字段(用于 lastPassed 快照)。
 * @param request - 请求对象。
 * @returns 原始请求字段。
 */
function pickRawRequest(request) {
  const picked = {}
  for (const field of ['name', 'method', 'url', 'headers', 'query', 'body', 'assertions', 'extract']) {
    if (request[field] !== undefined) picked[field] = request[field]
  }
  return picked
}

/**
 * 环境变量 handler(环境 = { id, name, variables } )。
 */
async function handleEnvironments(ctx, req, res, pathname, method) {
  const base = `${ROUTE_ROOT}/api/environments`
  // 子路由:POST /api/environments/:id/default — 设为默认环境。
  // 必须在 pathId 之前匹配(带 /default 后缀的路径会被 pathId 拒绝成 undefined)。
  const defaultMatch = /^\/dsh-test-mode\/api\/environments\/([^/]+)\/default$/.exec(pathname)
  if (defaultMatch && method === 'POST') {
    const body = await requestJson(req)
    const root = testModeRoot(ctx, requireWorkspaceId(body))
    const envId = defaultMatch[1]
    const item = await readJson(root, `api/environments/${envId}.json`)
    if (!item) { sendJson(res, 404, { ok: false, message: `environment "${envId}" was not found` }); return }
    await mutateJson(root, 'settings.json', () => ({ defaultEnvironmentId: envId }), {})
    sendJson(res, 200, { ok: true, defaultEnvironmentId: envId })
    return
  }
  const id = pathId(pathname, base)
  if (method === 'GET' && id === undefined) {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const ids = await listJsonFiles(root, 'api/environments')
    const environments = []
    for (const envId of ids) {
      const item = await readJson(root, `api/environments/${envId}.json`)
      // 智能体直接写盘或早期创建的环境文件可能没有 id 字段:以文件名为 id 补齐,
      // 否则前端 env.id 为 undefined,「设为默认」会请求 /environments/undefined/default。
      if (item) environments.push({ id: envId, ...item })
    }
    const defaultEnvironmentId = await readDefaultEnvironmentId(root)
    sendJson(res, 200, { ok: true, environments, defaultEnvironmentId })
    return
  }
  if (method === 'POST' && id === undefined) {
    const body = await requestJson(req)
    const root = testModeRoot(ctx, requireWorkspaceId(body))
    const envId = newId('env')
    const now = nowIso()
    const item = {
      id: envId,
      name: String(body.name ?? '未命名环境'),
      variables: body.variables && typeof body.variables === 'object' ? body.variables : {},
      createdAt: now,
      updatedAt: now,
    }
    await writeJson(root, `api/environments/${envId}.json`, item)
    // 首个环境自动设为默认。
    if (body.setDefault === true || (await readDefaultEnvironmentId(root)) === undefined) {
      await mutateJson(root, 'settings.json', () => ({ defaultEnvironmentId: envId }), {})
    }
    sendJson(res, 200, { ok: true, environment: item, isDefault: (await readDefaultEnvironmentId(root)) === envId })
    return
  }
  if (id !== undefined) {
    if (method === 'GET') {
      const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
      const item = await readJson(root, `api/environments/${id}.json`)
      if (!item) { sendJson(res, 404, { ok: false, message: `environment "${id}" was not found` }); return }
      sendJson(res, 200, { ok: true, environment: { id, ...item } })
      return
    }
    if (method === 'PUT') {
      const body = await requestJson(req)
      const root = testModeRoot(ctx, requireWorkspaceId(body))
      const updated = await mutateJson(root, `api/environments/${id}.json`, (current) => {
        if (!current) throw new Error(`environment "${id}" was not found`)
        const next = { ...current }
        if (typeof body.name === 'string') next.name = body.name
        if (body.variables && typeof body.variables === 'object') next.variables = body.variables
        next.updatedAt = nowIso()
        return next
      })
      sendJson(res, 200, { ok: true, environment: updated })
      return
    }
    if (method === 'DELETE') {
      const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
      await deleteJson(root, `api/environments/${id}.json`)
      // 删除的是默认环境时清除默认引用。
      if ((await readDefaultEnvironmentId(root)) === id) {
        await mutateJson(root, 'settings.json', () => ({}), {})
      }
      sendJson(res, 200, { ok: true })
      return
    }
  }
  sendJson(res, 404, { ok: false, message: `${method} ${pathname} was not found` })
}

/**
 * 按 requestRef 解析项目内请求。
 * @param root - test-mode 根目录。
 * @param ref - { projectId, collectionId, requestId }。
 * @returns { request, baseUrl } 或 null(任一环节缺失)。
 */
async function resolveRequestRef(root, ref) {
  if (!ref || typeof ref !== 'object') return null
  const project = await readJson(root, `api/projects/${ref.projectId}.json`).catch(() => undefined)
  const collection = (project?.collections ?? []).find((item) => (item.id ?? item.name) === ref.collectionId)
  const request = (collection?.requests ?? []).find((item) => (item.id ?? item.name) === ref.requestId)
  if (!request) return null
  return { request, baseUrl: project.baseUrl }
}

/**
 * 加载 UI 元素库映射({ key: selector }),供 UI 脚本步骤解析 element 引用。
 * @param root - test-mode 根目录。
 */
async function loadUiElements(root) {
  const data = await readJson(root, 'ui/elements.json').catch(() => undefined)
  const elements = {}
  for (const element of data?.elements ?? []) {
    if (element?.key && typeof element.selector === 'string') elements[element.key] = element.selector
  }
  return elements
}

/**
 * 统一解析用例步骤引用:requestRef(含 projectId/collectionId/requestId)或
 * uiRef(含 scriptId)。
 * @param root - test-mode 根目录。
 * @param ref - 步骤的 requestRef 或 uiRef。
 * @returns { kind: 'request', request, baseUrl } | { kind: 'ui', script, elements }
 *   | null(任一环节缺失)。
 */
async function resolveCaseRef(root, ref) {
  if (!ref || typeof ref !== 'object') return null
  if (ref.scriptId) {
    const script = await readJson(root, `ui/scripts/${ref.scriptId}.json`).catch(() => undefined)
    if (!script) return null
    return { kind: 'ui', script, elements: await loadUiElements(root) }
  }
  const request = await resolveRequestRef(root, ref)
  if (request === null) return null
  return { kind: 'request', ...request }
}

/**
 * 构造 runUi 回调:执行 UI 脚本并汇总为用例步骤结果。
 * @param ctx - 插件上下文(带 tools 服务)。
 * @param root - test-mode 根目录。
 * @param variables - 环境变量。
 * @param factories - 数据工厂表。
 */
function makeRunUi(ctx, root, variables, factories) {
  return async (script, elements) => {
    try {
      const report = await executeUiScript(ctx, script, elements, variables, factories, { root })
      return {
        ok: report.summary.failed === 0,
        durationMs: report.durationMs,
        error: report.summary.failed > 0 ? `${report.summary.failed} ui step(s) failed` : undefined,
        steps: report.results,
        exports: report.exports,
      }
    } catch (error) {
      return { ok: false, durationMs: 0, error: error instanceof Error ? error.message : String(error) }
    }
  }
}

/**
 * 读取环境变量表。environmentId 缺省或不存在时回退到默认环境
 * (test-mode/settings.json 的 defaultEnvironmentId);无默认时返回空表。
 * @param root - test-mode 根目录。
 * @param environmentId - 环境 id,可选。
 */
async function loadEnvironment(root, environmentId) {
  let id = environmentId
  if (typeof id !== 'string' || !id) {
    const settings = await readJson(root, 'settings.json').catch(() => undefined)
    id = settings?.defaultEnvironmentId
  }
  if (typeof id !== 'string' || !id) return {}
  const environment = await readJson(root, `api/environments/${id}.json`).catch(() => undefined)
  return environment?.variables ?? {}
}

/**
 * 读取默认环境 id(无默认时返回 undefined)。
 * @param root - test-mode 根目录。
 */
async function readDefaultEnvironmentId(root) {
  const settings = await readJson(root, 'settings.json').catch(() => undefined)
  return settings?.defaultEnvironmentId
}

/**
 * 解析实际生效的环境 id:显式传入优先,否则回退默认环境(无默认返回 undefined)。
 * @param root - test-mode 根目录。
 * @param environmentId - 请求携带的环境 id,可选。
 * @returns 生效的环境 id 或 undefined。
 */
async function resolveEnvironmentId(root, environmentId) {
  if (typeof environmentId === 'string' && environmentId) return environmentId
  return readDefaultEnvironmentId(root)
}

/**
 * 读取会话变量缓存(test-mode/session.json 的 { [envId]: { [name]: { value, at } } })。
 * 会话变量 = 上次执行 export 的登录态(如 token/cookie),跨执行复用。
 * @param root - test-mode 根目录。
 * @param environmentId - 生效的环境 id(可能 undefined,此时返回空表)。
 * @returns 变量表(会话优先于环境变量,调用方自行合并)。
 */
async function loadSessionVariables(root, environmentId) {
  if (typeof environmentId !== 'string' || !environmentId) return {}
  const data = await readJson(root, 'session.json').catch(() => undefined)
  const entries = data?.[environmentId] ?? {}
  const variables = {}
  for (const [name, record] of Object.entries(entries)) {
    if (record && record.value !== undefined && record.value !== null) variables[name] = String(record.value)
  }
  return variables
}

/**
 * 把本次执行的 export 变量写入会话缓存(按环境隔离,同名覆盖)。
 * @param root - test-mode 根目录。
 * @param environmentId - 生效的环境 id(undefined 时不写)。
 * @param exports - { [name]: value }。
 */
async function saveSessionExports(root, environmentId, exports) {
  if (typeof environmentId !== 'string' || !environmentId) return
  const entries = Object.entries(exports ?? {}).filter(([, value]) => value !== undefined && value !== null)
  if (entries.length === 0) return
  const at = nowIso()
  await mutateJson(root, 'session.json', (current) => {
    const next = { ...(current ?? {}) }
    const envSession = { ...(next[environmentId] ?? {}) }
    for (const [name, value] of entries) envSession[name] = { value: String(value), at }
    next[environmentId] = envSession
    return next
  }, {})
}

/**
 * 会话 handler:GET /api/session?environmentId= 返回该环境会话变量清单;
 * DELETE /api/session/:environmentId 清除该环境会话。
 */
async function handleSession(ctx, req, res, pathname, method) {
  const base = `${ROUTE_ROOT}/api/session`
  const id = pathId(pathname, base)
  if (method === 'GET' && id === undefined) {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const environmentId = new URL(req.url ?? '', 'http://localhost').searchParams.get('environmentId') ?? ''
    const data = await readJson(root, 'session.json').catch(() => undefined)
    const variables = []
    for (const [envId, envEntries] of Object.entries(data ?? {})) {
      if (typeof environmentId === 'string' && environmentId && envId !== environmentId) continue
      for (const [name, record] of Object.entries(envEntries ?? {})) {
        variables.push({ environmentId: envId, name, value: String(record?.value ?? ''), at: record?.at ?? '' })
      }
    }
    sendJson(res, 200, { ok: true, variables })
    return
  }
  if (id !== undefined && method === 'DELETE') {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const environmentId = decodeURIComponent(id)
    await mutateJson(root, 'session.json', (current) => {
      const next = { ...(current ?? {}) }
      delete next[environmentId]
      return next
    }, {})
    sendJson(res, 200, { ok: true })
    return
  }
  sendJson(res, 404, { ok: false, message: `${method} ${pathname} was not found` })
}

/**
 * 加载用户自定义数据工厂生成器表。
 * 存 `test-mode/datafactory.json`:{ generators: [{ id, key, pattern, ... }] };
 * 返回 `{ [key]: pattern }` 映射,供 substitute 的 `{{factory.<key>}}` 解析。
 * @param root - test-mode 根目录。
 */
async function loadFactories(root) {
  const data = await readJson(root, 'datafactory.json').catch(() => undefined)
  const factories = {}
  for (const generator of data?.generators ?? []) {
    if (generator?.key && typeof generator.pattern === 'string') {
      factories[generator.key] = generator.pattern
    }
  }
  return factories
}

/**
 * 把一次执行追加到历史;detail 为完整请求/响应(供详情页回看)。
 * @param root - test-mode 根目录。
 * @param entry - 摘要字段(kind/name/pass/status/durationMs/error/reportId)。
 * @param detail - 完整执行细节(请求/响应体),可选。
 */
async function recordHistory(root, entry, detail) {
  await appendHistory(root, { id: newId('run'), createdAt: nowIso(), ...entry, ...(detail ? { detail } : {}) })
}

/**
 * 执行 handler:单请求 / 整个集合 / 单个用例 / 测试计划,写历史与报告。
 */
async function handleRun(ctx, req, res, pathname) {
  const body = await requestJson(req)
  const root = testModeRoot(ctx, requireWorkspaceId(body))
  const effectiveEnvironmentId = await resolveEnvironmentId(root, body.environmentId)
  // 变量来源:环境变量(静态配置) + 会话变量(上次执行 export 的登录态,优先)。
  const envVariables = await loadEnvironment(root, body.environmentId)
  const sessionVariables = await loadSessionVariables(root, effectiveEnvironmentId)
  const variables = { ...envVariables, ...sessionVariables }
  const factories = await loadFactories(root)

  if (pathname === `${ROUTE_ROOT}/api/run-request`) {
    const request = body.request
    if (!request || typeof request !== 'object') { sendJson(res, 400, { ok: false, message: 'request is required' }); return }
    const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : ''
    const url = /^https?:\/\//i.test(String(request.url ?? '')) ? request.url : `${String(baseUrl ?? '').replace(/\/+$/, '')}/${String(request.url ?? '').replace(/^\/+/, '')}`
    // 历史记录用变量替换后的实际请求 URL(executeRequest 内部已替换并请求)。
    const resolvedUrl = substitute(url, variables, factories)
    const outcome = await executeRequest({ ...request, url }, variables, factories)
    const history = {
      kind: 'request',
      name: String(request.name ?? request.url ?? 'request'),
      method: String(request.method ?? 'GET').toUpperCase(),
      url: resolvedUrl,
      pass: outcome.ok,
      status: outcome.status,
      durationMs: outcome.durationMs,
      error: outcome.error,
    }
    // 通过的接口不保存测试数据(只更新接口状态);失败保留一条结果记录便于排查。
    if (!outcome.ok) await recordHistory(root, history)
    // 记录接口状态与累计计数;通过时保存本次请求数据到接口配置(lastPassed)。
    await updateRequestStatus(root, body.projectId, body.collectionId, request.id, {
      pass: outcome.ok,
      status: outcome.status,
      durationMs: outcome.durationMs,
      environmentId: effectiveEnvironmentId,
      request,
    })
    // export 变量(如 token)写入会话缓存,供跨执行复用。
    await saveSessionExports(root, effectiveEnvironmentId, outcome.exports)
    sendJson(res, 200, { ok: true, result: outcome, history })
    return
  }

  if (pathname === `${ROUTE_ROOT}/api/run-collection`) {
    const project = await readJson(root, `api/projects/${body.projectId}.json`)
    if (!project) { sendJson(res, 404, { ok: false, message: `project "${body.projectId}" was not found` }); return }
    const collectionId = body.collectionId
    const collection = (project.collections ?? []).find((item) => (item.id ?? item.name) === collectionId)
    if (!collection) { sendJson(res, 404, { ok: false, message: `collection "${collectionId}" was not found` }); return }
    const report = await executeCollection(collection, project.baseUrl, variables, factories)
    for (const item of report.results ?? []) {
      const requestConfig = (collection.requests ?? []).find((request) => [request.id, request.name, request.name ? `req-${request.name}` : undefined].includes(item.requestId))
      await updateRequestStatus(root, project.id, collectionId, item.requestId, {
        pass: item.pass,
        status: item.status,
        durationMs: item.durationMs,
        environmentId: effectiveEnvironmentId,
        request: requestConfig,
      })
    }
    await saveSessionExports(root, effectiveEnvironmentId, report.exports)
    const reportId = newId('report')
    const record = { id: reportId, kind: 'collection', projectId: project.id, collectionId, ...report, createdAt: nowIso() }
    const storedReport = await saveReport(root, record)
    await recordHistory(root, {
      kind: 'collection',
      name: `${project.name} / ${collection.name}`,
      pass: record.summary.failed === 0,
      durationMs: record.durationMs,
      reportId,
    })
    sendJson(res, 200, { ok: true, report: { ...storedReport, results: compactRunResults(record.results), exports: record.exports } })
    return
  }

  if (pathname === `${ROUTE_ROOT}/api/run-case`) {
    const caseId = body.caseId
    const testCase = await readJson(root, `cases/${caseId}.json`)
    if (!testCase) { sendJson(res, 404, { ok: false, message: `case "${caseId}" was not found` }); return }
    const report = await executeCase(
      testCase,
      (ref) => resolveCaseRef(root, ref),
      variables,
      factories,
      makeRunUi(ctx, root, variables, factories),
    )
    await saveSessionExports(root, effectiveEnvironmentId, report.exports)
    await updateCaseRequestStatuses(root, testCase, report, effectiveEnvironmentId)
    const reportId = newId('report')
    const record = { id: reportId, kind: 'case', caseId, ...report, createdAt: nowIso() }
    const storedReport = await saveReport(root, record)
    await recordHistory(root, {
      kind: 'case',
      name: `用例: ${testCase.name}`,
      pass: report.summary.failed === 0,
      durationMs: report.durationMs,
      reportId,
    })
    sendJson(res, 200, { ok: true, report: { ...storedReport, results: compactRunResults(record.results), exports: record.exports } })
    return
  }

  sendJson(res, 404, { ok: false, message: `${pathname} was not found` })
}

/**
 * 统计 handler:接口健康度 + 失败聚合 Top。
 * 数据来源 = history.json 的 request 条目 + 全部报告的逐请求 results。
 */
async function handleStats(ctx, req, res, pathname) {
  const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
  // 接口健康度来自各项目请求配置里的累计执行结果:通过的执行不写历史,只更新状态与计数。
  const rows = []
  for (const projectId of await listJsonFiles(root, 'api/projects')) {
    const project = await readJson(root, `api/projects/${projectId}.json`).catch(() => undefined)
    if (!project) continue
    for (const collection of project.collections ?? []) {
      for (const request of collection.requests ?? []) {
        const stats = request.stats
        const lastRun = request.lastRun
        if (!stats && !lastRun) continue
        const total = stats?.runs ?? (lastRun ? 1 : 0)
        if (total <= 0) continue
        const passed = stats?.passed ?? (lastRun?.pass ? 1 : 0)
        rows.push({
          method: String(request.method ?? 'GET').toUpperCase(),
          url: String(request.url ?? ''),
          total,
          passed,
          totalDurationMs: stats?.totalDurationMs ?? 0,
          lastPass: lastRun?.pass ?? null,
          lastStatus: lastRun?.status ?? null,
          lastAt: lastRun?.at ?? '',
        })
      }
    }
  }
  // 单请求执行历史里只保留失败项(通过不写历史);无项目绑定的失败请求也纳入统计,
  // 与配置计数按 METHOD URL 去重,避免同一接口重复计数。
  const coveredKeys = new Set(rows.map((row) => `${row.method} ${row.url}`))
  for (const entry of await readHistory(root)) {
    if (entry.kind !== 'request' || entry.pass !== false || !entry.method || !entry.url) continue
    const method = String(entry.method).toUpperCase()
    const url = String(entry.url)
    const key = `${method} ${url}`
    if (coveredKeys.has(key)) continue
    rows.push({
      method,
      url,
      total: 1,
      passed: 0,
      totalDurationMs: entry.durationMs ?? 0,
      lastPass: false,
      lastStatus: entry.status ?? null,
      lastAt: entry.createdAt ?? '',
    })
  }
  if (pathname === `${ROUTE_ROOT}/api/stats/interfaces`) {
    const byKey = new Map()
    for (const row of rows) {
      const key = `${row.method} ${row.url}`
      const entry = byKey.get(key) ?? { method: row.method, url: row.url, total: 0, passed: 0, totalDurationMs: 0, lastPass: null, lastStatus: null, lastAt: '' }
      entry.total += row.total
      entry.passed += row.passed
      entry.totalDurationMs += row.totalDurationMs
      if (String(row.lastAt ?? '') >= String(entry.lastAt ?? '')) {
        entry.lastAt = row.lastAt ?? ''
        entry.lastPass = row.lastPass
        entry.lastStatus = row.lastStatus
      }
      byKey.set(key, entry)
    }
    const interfaces = [...byKey.values()].map((entry) => ({
      method: entry.method,
      url: entry.url,
      total: entry.total,
      passed: entry.passed,
      failed: entry.total - entry.passed,
      successRate: entry.total > 0 ? Math.round((entry.passed / entry.total) * 100) : 0,
      avgDurationMs: entry.total > 0 ? Math.round(entry.totalDurationMs / entry.total) : 0,
      lastPass: entry.lastPass,
      lastStatus: entry.lastStatus,
      lastAt: entry.lastAt,
    }))
    interfaces.sort((a, b) => (a.failed !== b.failed ? b.failed - a.failed : b.total - a.total))
    sendJson(res, 200, { ok: true, interfaces: interfaces.slice(0, 60) })
    return
  }
  if (pathname === `${ROUTE_ROOT}/api/stats/failures`) {
    const failedByKey = new Map()
    for (const row of rows) {
      const failed = row.total - row.passed
      if (failed <= 0) continue
      const key = `${row.method} ${row.url}`
      failedByKey.set(key, (failedByKey.get(key) ?? 0) + failed)
    }
    const topFailedRequests = [...failedByKey.entries()].map(([key, count]) => {
      const [method, ...urlParts] = key.split(' ')
      return { method, url: urlParts.join(' '), failCount: count }
    }).sort((a, b) => b.failCount - a.failCount).slice(0, 15)
    // 断言明细已不再保存,失败断言聚合为空(保留字段兼容客户端)。
    sendJson(res, 200, { ok: true, topFailedRequests, topFailedAssertions: [] })
    return
  }
  sendJson(res, 404, { ok: false, message: `${pathname} was not found` })
}

/**
 * 把一份报告渲染为 Markdown(阶段 3 导出)。
 * @param report - 报告对象(kind/summary/results/durationMs/startedAt 等)。
 * @returns Markdown 文本。
 */
export function renderReportMarkdown(report) {
  const summary = report.summary ?? { total: 0, passed: 0, failed: 0 }
  const kindLabel = { request: '单请求', case: '用例', collection: '集合', plan: '计划', ui: 'UI 脚本' }[report.kind] ?? '执行'
  const successRate = (summary.total ?? 0) > 0 ? Math.round(((summary.passed ?? 0) / summary.total) * 100) : 0
  const lines = [
    `# ${report.name ?? '未命名报告'}`,
    '',
    `- 类型:${kindLabel}`,
    `- 开始于:${new Date(report.startedAt ?? report.createdAt ?? '').toLocaleString()}`,
    `- 耗时:${(report.durationMs ?? 0).toFixed(0)}ms`,
    `- 结果:总数 ${summary.total ?? 0},通过 ${summary.passed ?? 0},失败 ${summary.failed ?? 0}${summary.skipped ? `,跳过 ${summary.skipped}` : ''}`,
    `- 通过率:${successRate}%`,
  ]
  const failures = report.failedEntries ?? []
  if (failures.length === 0) {
    lines.push('', '没有失败项。')
    return lines.join('\n')
  }
  lines.push('', '## 失败项', '', '| # | 类型 | 名称 | 方法 | URL | 状态 | 错误 |', '|---|---|---|---|---|---|---|')
  for (const [index, entry] of failures.entries()) {
    lines.push(`| ${index + 1} | ${escapeMd(entry.kind ?? '')} | ${escapeMd(entry.label ?? '')} | ${entry.method ?? ''} | ${escapeMd(entry.url ?? '')} | ${entry.status ?? ''} | ${escapeMd(entry.error ?? '')} |`)
  }
  if (report.failuresTruncated > 0) {
    lines.push('', `另有 ${report.failuresTruncated} 个失败项未列出(超出上限)。`)
  }
  return lines.join('\n')
}

/** 转义 Markdown 表格/文本中的管道符与换行。 */
function escapeMd(text) {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

/**
 * 历史 / 报告 handler。
 */
async function handleHistoryReports(ctx, req, res, pathname, method) {
  const reportsBase = `${ROUTE_ROOT}/api/reports`
  // 固定报告:最新统计(覆盖写)+ 用户保存的历史报告(不可变)。
  if (pathname === `${reportsBase}/latest` && method === 'GET') {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const report = await readLatestReport(root)
    sendJson(res, 200, { ok: true, report })
    return
  }
  if (pathname === `${reportsBase}/latest/refresh` && method === 'POST') {
    const body = await requestJson(req)
    const root = testModeRoot(ctx, requireWorkspaceId(body))
    const report = await refreshLatestReport(root, { trigger: 'agent', environmentId: body.environmentId })
    sendJson(res, 200, { ok: true, report })
    return
  }
  if (pathname === `${reportsBase}/history` && method === 'GET') {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const reports = await listHistoryReports(root)
    sendJson(res, 200, { ok: true, reports })
    return
  }
  if (pathname === `${reportsBase}/history` && method === 'POST') {
    const body = await requestJson(req)
    const root = testModeRoot(ctx, requireWorkspaceId(body))
    const saved = await saveHistoryReport(root, { name: body.name })
    if (!saved.ok) { sendJson(res, 400, { ok: false, message: saved.message }); return }
    sendJson(res, 200, { ok: true, report: saved.report })
    return
  }
  if (pathname.startsWith(`${reportsBase}/history/`)) {
    const historyId = pathId(pathname, `${reportsBase}/history`)
    if (historyId !== undefined && method === 'GET') {
      const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
      const report = await readHistoryReport(root, historyId)
      if (!report) { sendJson(res, 404, { ok: false, message: `report "${historyId}" was not found` }); return }
      sendJson(res, 200, { ok: true, report })
      return
    }
    if (historyId !== undefined && method === 'DELETE') {
      const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
      const deleted = await deleteHistoryReport(root, historyId)
      if (!deleted) { sendJson(res, 404, { ok: false, message: `report "${historyId}" was not found` }); return }
      sendJson(res, 200, { ok: true })
      return
    }
  }
  if (pathname === `${ROUTE_ROOT}/api/history` && method === 'GET') {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const history = await readHistory(root)
    sendJson(res, 200, { ok: true, history })
    return
  }
  const historyBase = `${ROUTE_ROOT}/api/history`
  if (pathname.startsWith(`${historyBase}/`)) {
    const historyId = pathId(pathname, historyBase)
    if (method === 'GET' && historyId !== undefined) {
      const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
      const history = await readHistory(root)
      const entry = history.find((item) => item.id === historyId)
      if (!entry) { sendJson(res, 404, { ok: false, message: `history "${historyId}" was not found` }); return }
      sendJson(res, 200, { ok: true, entry })
      return
    }
  }
  if (pathname === reportsBase && method === 'GET') {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const reports = await listReportSummaries(root)
    sendJson(res, 200, { ok: true, reports })
    return
  }
  const reportId = pathId(pathname, reportsBase)
  // 对比子路由:GET /api/reports/:id/compare — 与同 kind+name 的最近一次报告对比。
  const compareMatch = /^\/dsh-test-mode\/api\/reports\/([^/]+)\/compare$/.exec(pathname)
  if (compareMatch && method === 'GET') {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const currentView = await readReportView(root, compareMatch[1])
    if (!currentView) { sendJson(res, 404, { ok: false, message: `report "${compareMatch[1]}" was not found` }); return }
    const report = currentView.report
    const series = (await listReportSummaries(root)).filter((item) => item.legacy !== true
      && item.kind === report.kind && item.name === report.name
      && item.id !== report.id && String(item.createdAt ?? '') < String(report.createdAt ?? ''))
    series.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    const previousSummary = series[0]
    if (!previousSummary) { sendJson(res, 200, { ok: true, hasPrevious: false }); return }
    const previousView = await readReportView(root, previousSummary.id)
    const previous = previousView?.report ?? previousSummary
    // diff:失败项按 kind+label 匹配;当前失败且上次没有 = 新失败;上次失败当前没有 = 修复。
    const failureKey = (entry) => `${entry.kind ?? ''}:${entry.label ?? entry.name ?? ''}`
    const previousFailures = new Set((previous.failedEntries ?? []).map(failureKey))
    const currentFailures = new Set((report.failedEntries ?? []).map(failureKey))
    const newFailures = (report.failedEntries ?? []).filter((entry) => !previousFailures.has(failureKey(entry)))
    const fixedCount = (previous.failedEntries ?? []).filter((entry) => !currentFailures.has(failureKey(entry))).length
    const sum = (item) => item.summary ?? { total: 0, passed: 0, failed: 0 }
    const diff = {
      totalDelta: (sum(report).total ?? 0) - (sum(previous).total ?? 0),
      passedDelta: (sum(report).passed ?? 0) - (sum(previous).passed ?? 0),
      failedDelta: (sum(report).failed ?? 0) - (sum(previous).failed ?? 0),
      durationDeltaMs: (report.durationMs ?? 0) - (previous.durationMs ?? 0),
      newFailures: newFailures.map((result) => ({ name: result.name ?? result.url, method: result.method, url: result.url, error: result.error })),
      fixedCount,
    }
    sendJson(res, 200, {
      ok: true,
      hasPrevious: true,
      previous: { id: previous.id, name: previous.name, createdAt: previous.createdAt, summary: previous.summary, durationMs: previous.durationMs },
      diff,
    })
    return
  }
  // 导出子路由:GET /api/reports/:id/export?format=md
  const exportMatch = /^\/dsh-test-mode\/api\/reports\/([^/]+)\/export$/.exec(pathname)
  if (exportMatch && method === 'GET') {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const view = await readReportView(root, exportMatch[1])
    if (!view) { sendJson(res, 404, { ok: false, message: `report "${exportMatch[1]}" was not found` }); return }
    const markdown = renderReportMarkdown(view.report)
    try {
      await writeJson(root, `exports/${view.report.id}.json`, { exportedAt: nowIso(), markdown })
    } catch {
      // 落盘失败不影响导出内容返回
    }
    const body = markdown
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
    return
  }
  // 迁移旧报告:裁剪超大正文 + 补侧车索引(有损:断言 actual 只保留预览)。
  if (pathname === `${ROUTE_ROOT}/api/reports/migrate-legacy` && method === 'POST') {
    const body = await requestJson(req)
    const root = testModeRoot(ctx, requireWorkspaceId(body))
    try {
      const result = await migrateLegacyReports(root, {
        minSizeBytes: Number(body.minSizeBytes) > 0 ? Number(body.minSizeBytes) : undefined,
      })
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (reportId !== undefined) {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    if (method === 'GET') {
      const view = await readReportView(root, reportId)
      if (!view) { sendJson(res, 404, { ok: false, message: `report "${reportId}" was not found` }); return }
      sendJson(res, 200, { ok: true, report: view.report, trimmed: view.trimmed === true })
      return
    }
    if (method === 'DELETE') {
      await deleteReport(root, reportId)
      sendJson(res, 200, { ok: true })
      return
    }
  }
  sendJson(res, 404, { ok: false, message: `${method} ${pathname} was not found` })
}

/**
 * OpenAPI 3.x 导入:把 spec JSON 转成 API 项目(集合按 operation tag 分组)。
 * 支持 OpenAPI 3.0 / 3.1 的 paths、servers、tags;每个 operation 生成一个
 * 请求(name = operationId/summary,method/url/parameters/requestBody 保留,
 * 响应断言默认 status 2xx 区间)。不支持的结构(如 YAML 文本、OpenAPI 2.0
 * swagger 字段)会拒绝并说明。
 */
async function handleImportOpenapi(ctx, req, res) {
  const body = await requestJson(req)
  const root = testModeRoot(ctx, requireWorkspaceId(body))
  const spec = body.spec
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    sendJson(res, 400, { ok: false, message: 'spec must be an OpenAPI JSON object' })
    return
  }
  if (spec.swagger && String(spec.swagger).startsWith('2.')) {
    sendJson(res, 400, { ok: false, message: 'OpenAPI 2.0 (Swagger) is not supported; convert to OpenAPI 3.x first' })
    return
  }
  const version = String(spec.openapi ?? '')
  if (!version.startsWith('3.')) {
    sendJson(res, 400, { ok: false, message: 'expected an OpenAPI 3.x document (openapi: "3.x.x"); YAML text is not supported, paste the JSON form' })
    return
  }
  const paths = spec.paths ?? {}
  if (typeof paths !== 'object' || Object.keys(paths).length === 0) {
    sendJson(res, 400, { ok: false, message: 'spec.paths is empty' })
    return
  }
  const baseUrl = Array.isArray(spec.servers) && spec.servers[0]?.url
    ? String(spec.servers[0].url).replace(/\/+$/, '')
    : ''

  // tag → requests;无 tag 的 operation 归入「默认」。
  const groups = new Map()
  for (const [path, item] of Object.entries(paths)) {
    if (!item || typeof item !== 'object') continue
    for (const method of ['get', 'post', 'put', 'patch', 'delete', 'head', 'options']) {
      const operation = item[method]
      if (!operation || typeof operation !== 'object') continue
      const tag = Array.isArray(operation.tags) && operation.tags[0] ? String(operation.tags[0]) : '默认'
      if (!groups.has(tag)) groups.set(tag, [])
      const query = {}
      const headers = {}
      for (const param of operation.parameters ?? []) {
        if (!param || typeof param !== 'object' || !param.name) continue
        if (param.in === 'query') query[String(param.name)] = param.example ?? ''
        else if (param.in === 'header') headers[String(param.name)] = param.example ?? ''
        // path 参数留在 url 里({id} 占位,执行时用户替换)
      }
      const request = {
        id: `req-${newId('').slice(4)}`,
        name: operation.operationId || operation.summary || `${method.toUpperCase()} ${path}`,
        method: method.toUpperCase(),
        url: path,
        ...(Object.keys(headers).length ? { headers } : {}),
        ...(Object.keys(query).length ? { query } : {}),
        assertions: [{ type: 'status', operator: 'ge', expected: 200 }, { type: 'status', operator: 'le', expected: 299 }],
      }
      groups.get(tag).push(request)
    }
  }
  if (groups.size === 0) {
    sendJson(res, 400, { ok: false, message: 'no operations found in spec.paths' })
    return
  }
  const projectName = String(body.name ?? spec.info?.title ?? '导入项目')
  const now = nowIso()
  // 同名项目 = 版本迭代:更新式导入(保留 id/createdAt),diff 出变更写变更清单;
  // 全新导入 = 基线(全部请求打 updatedAt 戳,便于后续请求级增量)。
  let existing = null
  for (const projectId of await listJsonFiles(root, 'api/projects')) {
    const item = await readJson(root, `api/projects/${projectId}.json`).catch(() => undefined)
    if (item?.name === projectName) { existing = { ...item, id: projectId }; break }
  }
  if (existing) {
    const prevFlat = (existing.collections ?? []).flatMap((c) => c.requests ?? [])
    const flatNew = [...groups.values()].flat()
    const { requests, changes } = diffRequests(prevFlat, flatNew, now)
    const byKey = new Map(requests.map((request) => [requestKey(request), request]))
    const collections = [...groups.entries()].map(([name, requestsIn], index) => ({
      id: (existing.collections ?? []).find((c) => c.name === name)?.id ?? `col-${existing.id.slice(5)}-${index}`,
      name,
      requests: requestsIn.map((request) => byKey.get(requestKey(request)) ?? request),
    }))
    const project = {
      ...existing,
      name: projectName,
      baseUrl,
      collections,
      updatedAt: now,
    }
    await writeJson(root, `api/projects/${existing.id}.json`, project)
    if (changes.length > 0) {
      await writeChangelog(root, {
        name: `${projectName} v${String(spec.info?.version ?? '更新')}`,
        version: spec.info?.version,
        source: 'openapi-diff',
        changedRequests: changes.map((change) => ({ ...change, projectId: existing.id })),
      })
    }
    const totalRequests = collections.reduce((sum, c) => sum + c.requests.length, 0)
    sendJson(res, 200, {
      ok: true, project, importedCollections: collections.length, importedRequests: totalRequests,
      diff: changes, updated: true,
    })
    return
  }
  const projectId = newId('proj')
  const collections = [...groups.entries()].map(([name, requests], index) => ({
    id: `col-${projectId.slice(5)}-${index}`,
    name,
    requests: requests.map((request) => ({ ...request, updatedAt: now })),
  }))
  const project = {
    id: projectId,
    name: projectName,
    baseUrl,
    collections,
    createdAt: now,
    updatedAt: now,
  }
  await writeJson(root, `api/projects/${projectId}.json`, project)
  const totalRequests = collections.reduce((sum, c) => sum + c.requests.length, 0)
  sendJson(res, 200, { ok: true, project, importedCollections: collections.length, importedRequests: totalRequests, diff: [], updated: false })
}

/**
 * 变更清单 handler:GET 列表(倒序)、DELETE 单条。
 * 清单由 openapi-diff(重导同名项目)、手动编辑(删接口时)、AI(发布说明)写入,
 * 是增量展开的语义信号(比 mtime 精确)。
 */
async function handleChangelogs(ctx, req, res, pathname, method) {
  const base = `${ROUTE_ROOT}/api/changelogs`
  const id = pathId(pathname, base)
  if (method === 'GET' && id === undefined) {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const ids = await listJsonFiles(root, 'changelogs')
    const items = []
    for (const changelogId of ids) {
      const item = await readJson(root, `changelogs/${changelogId}.json`).catch(() => undefined)
      if (item) items.push(item)
    }
    items.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    sendJson(res, 200, { ok: true, changelogs: items })
    return
  }
  if (id !== undefined && method === 'DELETE') {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    await deleteJson(root, `changelogs/${id}.json`)
    sendJson(res, 200, { ok: true })
    return
  }
  sendJson(res, 404, { ok: false, message: `${method} ${pathname} was not found` })
}

/**
 * 数据工厂 handler:用户自定义生成器,存 `test-mode/datafactory.json` 单文件。
 * 生成器字段:{ id, key, name, pattern, description, createdAt, updatedAt };
 * pattern 是模板,可嵌套 `{{rand.*}}` 内置生成器与其它 `{{factory.<key>}}`,
 * 执行时由 substitute 递归展开。预览 API 直接跑一次展开验证模板。
 */
async function handleDataFactory(ctx, req, res, pathname, method) {
  const base = `${ROUTE_ROOT}/api/datafactory`
  const id = pathId(pathname, base)
  const rootOf = (bodyOrQuery) => testModeRoot(ctx, requireWorkspaceId(bodyOrQuery))

  // 预览:POST /api/datafactory/preview { workspaceId, pattern, count? }
  if (pathname === `${ROUTE_ROOT}/api/datafactory/preview` && method === 'POST') {
    const body = await requestJson(req)
    const root = rootOf(body)
    const factories = await loadFactories(root)
    const pattern = typeof body.pattern === 'string' ? body.pattern : ''
    const count = Math.min(Math.max(Number(body.count ?? 1) || 1, 1), 10)
    const samples = []
    for (let i = 0; i < count; i += 1) {
      samples.push(substitute(pattern, {}, factories))
    }
    sendJson(res, 200, { ok: true, samples })
    return
  }

  // 列表:GET /api/datafactory — 内置生成器(只读)+ 用户自定义生成器。
  if (method === 'GET' && id === undefined) {
    const root = rootOf({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') })
    const data = await readJson(root, 'datafactory.json').catch(() => undefined)
    const custom = data?.generators ?? []
    const customKeys = new Set(custom.map((g) => g.key))
    // 内置条目不重复:用户自定义 key 与内置重名时,自定义优先展示。
    const builtin = BUILTIN_FACTORY_ITEMS
      .filter((item) => !customKeys.has(item.key))
      .map((item) => ({ ...item, builtin: true, createdAt: '', updatedAt: '' }))
    const generators = [
      ...builtin,
      ...custom.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))),
    ]
    sendJson(res, 200, { ok: true, generators })
    return
  }

  // 新建:POST /api/datafactory
  if (method === 'POST' && id === undefined) {
    const body = await requestJson(req)
    const root = rootOf(body)
    const key = String(body.key ?? '').trim()
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      sendJson(res, 400, { ok: false, message: 'key must match /^[a-z][a-z0-9_]*$/ (lowercase start, letters/digits/underscore)' })
      return
    }
    if (key.startsWith('rand.')) {
      sendJson(res, 400, { ok: false, message: 'key cannot start with "rand." (reserved for built-in generators)' })
      return
    }
    const now = nowIso()
    const item = {
      id: newId('gen'),
      key,
      name: String(body.name ?? key),
      pattern: typeof body.pattern === 'string' ? body.pattern : '',
      description: typeof body.description === 'string' ? body.description : '',
      createdAt: now,
      updatedAt: now,
    }
    await mutateJson(root, 'datafactory.json', (current) => {
      const generators = current?.generators ?? []
      if (generators.some((g) => g.key === key)) throw new Error(`generator key "${key}" already exists`)
      return { generators: [...generators, item] }
    }, { generators: [] })
    sendJson(res, 200, { ok: true, generator: item })
    return
  }

  // 单条:GET/PUT/DELETE /api/datafactory/:id
  if (id !== undefined) {
    if (method === 'GET') {
      const root = rootOf({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') })
      const data = await readJson(root, 'datafactory.json').catch(() => undefined)
      const generator = (data?.generators ?? []).find((g) => g.id === id)
      if (!generator) { sendJson(res, 404, { ok: false, message: `generator "${id}" was not found` }); return }
      sendJson(res, 200, { ok: true, generator })
      return
    }
    if (method === 'PUT') {
      const body = await requestJson(req)
      const root = rootOf(body)
      const updated = await mutateJson(root, 'datafactory.json', (current) => {
        const generators = current?.generators ?? []
        const index = generators.findIndex((g) => g.id === id)
        if (index === -1) throw new Error(`generator "${id}" was not found`)
        const next = { ...generators[index] }
        if (typeof body.key === 'string') next.key = body.key
        if (typeof body.name === 'string') next.name = body.name
        if (typeof body.pattern === 'string') next.pattern = body.pattern
        if (typeof body.description === 'string') next.description = body.description
        next.updatedAt = nowIso()
        const rest = [...generators]
        rest[index] = next
        return { generators: rest }
      }, { generators: [] })
      const generator = updated.generators.find((g) => g.id === id)
      sendJson(res, 200, { ok: true, generator })
      return
    }
    if (method === 'DELETE') {
      const root = rootOf({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') })
      await mutateJson(root, 'datafactory.json', (current) => ({
        generators: (current?.generators ?? []).filter((g) => g.id !== id),
      }), { generators: [] })
      sendJson(res, 200, { ok: true })
      return
    }
  }
  sendJson(res, 404, { ok: false, message: `${method} ${pathname} was not found` })
}

/**
 * UI 自动化 handler:脚本(ui/scripts/ 每文件一个)+ 元素库(ui/elements.json
 * 单文件)+ 执行(POST /api/ui/run,Host 半用 Playwright + 系统 Chrome 直接驱动,
 * 不依赖会话里的浏览器工具)+ 页面元素探测(POST /api/ui/probe)。
 *
 * 脚本步骤 kind:open/click/type/press/assert_text/assert_url/assert_title/
 * assert_element/eval/wait/screenshot;定位用 selector 或元素库 key(element)。
 */
async function handleUi(ctx, req, res, pathname, method) {
  const rootOf = (bodyOrQuery) => testModeRoot(ctx, requireWorkspaceId(bodyOrQuery))
  const wsOf = (reqUrl) => ({ workspaceId: new URL(reqUrl ?? '', 'http://localhost').searchParams.get('workspaceId') })

  // 执行:POST /api/ui/run
  if (pathname === `${ROUTE_ROOT}/api/ui/run` && method === 'POST') {
    const body = await requestJson(req)
    const root = rootOf(body)
    const scriptId = body.scriptId
    const script = await readJson(root, `ui/scripts/${scriptId}.json`).catch(() => undefined)
    if (!script) { sendJson(res, 404, { ok: false, message: `ui script "${scriptId}" was not found` }); return }
    // 元素库 → { key: selector } 映射
    const elementsData = await readJson(root, 'ui/elements.json').catch(() => undefined)
    const elements = {}
    for (const element of elementsData?.elements ?? []) {
      if (element?.key && typeof element.selector === 'string') elements[element.key] = element.selector
    }
    const effectiveEnvironmentId = await resolveEnvironmentId(root, body.environmentId)
    const variables = {
      ...(await loadEnvironment(root, body.environmentId)),
      ...(await loadSessionVariables(root, effectiveEnvironmentId)),
    }
    const factories = await loadFactories(root)
    const report = await executeUiScript(
      ctx, script, elements, variables, factories,
      {
        continueOnError: body.continueOnError === true,
        root,
        headless: body.headless === false ? false : undefined,
      },
    )
    await saveSessionExports(root, effectiveEnvironmentId, report.exports)
    // 通过不保存测试数据:不写报告/历史,只更新脚本状态与计数(并把通过时的步骤存入脚本配置);
    // 失败才保存报告(统计 + 失败项)与一条历史记录。
    const uiPass = report.summary.failed === 0
    const reportId = newId('report')
    const record = { id: reportId, kind: 'ui', scriptId, ...report, createdAt: nowIso() }
    const storedReport = uiPass ? compactReport(record) : await saveReport(root, record)
    await updateUiScriptStatus(root, scriptId, { pass: uiPass, durationMs: report.durationMs, environmentId: effectiveEnvironmentId })
    if (!uiPass) {
      await recordHistory(root, {
        kind: 'ui',
        name: `UI: ${script.name}`,
        pass: false,
        durationMs: report.durationMs,
        reportId,
      })
    }
    sendJson(res, 200, { ok: true, report: { ...storedReport, results: compactRunResults(record.results), exports: record.exports } })
    return
  }

  // 页面元素探测:POST /api/ui/probe(服务端 Playwright 打开页面,返回候选交互元素)
  if (pathname === `${ROUTE_ROOT}/api/ui/probe` && method === 'POST') {
    const body = await requestJson(req)
    const url = typeof body.url === 'string' ? body.url.trim() : ''
    if (!url) { sendJson(res, 400, { ok: false, message: 'url is required' }); return }
    try {
      const result = await probeUiPage({
        url,
        headless: body.headless === false ? false : undefined,
        timeoutMs: Number(body.timeoutMs) > 0 ? Number(body.timeoutMs) : undefined,
      })
      sendJson(res, 200, { ok: true, ...result })
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  // 脚本 CRUD:GET/POST /api/ui/scripts、GET/PUT/DELETE /api/ui/scripts/:id
  const scriptsBase = `${ROUTE_ROOT}/api/ui/scripts`
  if (pathname === scriptsBase && method === 'GET') {
    const root = rootOf(wsOf(req.url))
    const ids = await listJsonFiles(root, 'ui/scripts')
    const scripts = []
    for (const scriptId of ids) {
      const item = await readJson(root, `ui/scripts/${scriptId}.json`)
      if (item) scripts.push({ id: scriptId, createdAt: '', updatedAt: '', ...item })
    }
    sendJson(res, 200, { ok: true, scripts: scripts.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))) })
    return
  }
  if (pathname === scriptsBase && method === 'POST') {
    const body = await requestJson(req)
    const root = rootOf(body)
    const scriptId = newId('ui')
    const now = nowIso()
    const item = {
      id: scriptId,
      name: String(body.name ?? '未命名脚本'),
      steps: Array.isArray(body.steps) ? body.steps : [],
      createdAt: now,
      updatedAt: now,
    }
    await writeJson(root, `ui/scripts/${scriptId}.json`, item)
    sendJson(res, 200, { ok: true, script: item })
    return
  }
  // 单条脚本:仅当 pathname 以 /api/ui/scripts/ 开头(避免把 /api/ui/elements 误解析为 scriptId)。
  const scriptId = pathname.startsWith(`${scriptsBase}/`) ? pathId(pathname, scriptsBase) : undefined
  if (scriptId !== undefined) {
    if (method === 'GET') {
      const root = rootOf(wsOf(req.url))
      const item = await readJson(root, `ui/scripts/${scriptId}.json`)
      if (!item) { sendJson(res, 404, { ok: false, message: `ui script "${scriptId}" was not found` }); return }
      sendJson(res, 200, { ok: true, script: { id: scriptId, createdAt: '', updatedAt: '', ...item } })
      return
    }
    if (method === 'PUT') {
      const body = await requestJson(req)
      const root = rootOf(body)
      const updated = await mutateJson(root, `ui/scripts/${scriptId}.json`, (current) => {
        if (!current) throw new Error(`ui script "${scriptId}" was not found`)
        const next = { ...current }
        if (typeof body.name === 'string') next.name = body.name
        if (Array.isArray(body.steps)) next.steps = body.steps
        next.updatedAt = nowIso()
        return next
      })
      sendJson(res, 200, { ok: true, script: updated })
      return
    }
    if (method === 'DELETE') {
      const root = rootOf(wsOf(req.url))
      await deleteJson(root, `ui/scripts/${scriptId}.json`)
      sendJson(res, 200, { ok: true })
      return
    }
  }

  // 元素库 CRUD:GET/POST /api/ui/elements、GET/PUT/DELETE /api/ui/elements/:id
  const elementsBase = `${ROUTE_ROOT}/api/ui/elements`
  if (pathname === elementsBase && method === 'GET') {
    const root = rootOf(wsOf(req.url))
    const data = await readJson(root, 'ui/elements.json').catch(() => undefined)
    sendJson(res, 200, { ok: true, elements: data?.elements ?? [] })
    return
  }
  if (pathname === elementsBase && method === 'POST') {
    const body = await requestJson(req)
    const root = rootOf(body)
    const key = String(body.key ?? '').trim()
    if (!/^[a-z][a-z0-9_-]*$/.test(key)) {
      sendJson(res, 400, { ok: false, message: 'key must match /^[a-z][a-z0-9_-]*$/' })
      return
    }
    if (typeof body.selector !== 'string' || !body.selector.trim()) {
      sendJson(res, 400, { ok: false, message: 'selector is required' })
      return
    }
    const now = nowIso()
    const item = {
      id: newId('el'),
      key,
      selector: body.selector.trim(),
      page: typeof body.page === 'string' ? body.page : '',
      description: typeof body.description === 'string' ? body.description : '',
      createdAt: now,
      updatedAt: now,
    }
    await mutateJson(root, 'ui/elements.json', (current) => {
      const elements = current?.elements ?? []
      if (elements.some((e) => e.key === key)) throw new Error(`element key "${key}" already exists`)
      return { elements: [...elements, item] }
    }, { elements: [] })
    sendJson(res, 200, { ok: true, element: item })
    return
  }
  const elementId = pathId(pathname, elementsBase)
  if (elementId !== undefined) {
    if (method === 'GET') {
      const root = rootOf(wsOf(req.url))
      const data = await readJson(root, 'ui/elements.json').catch(() => undefined)
      const element = (data?.elements ?? []).find((e) => e.id === elementId)
      if (!element) { sendJson(res, 404, { ok: false, message: `element "${elementId}" was not found` }); return }
      sendJson(res, 200, { ok: true, element })
      return
    }
    if (method === 'PUT') {
      const body = await requestJson(req)
      const root = rootOf(body)
      const updated = await mutateJson(root, 'ui/elements.json', (current) => {
        const elements = current?.elements ?? []
        const index = elements.findIndex((e) => e.id === elementId)
        if (index === -1) throw new Error(`element "${elementId}" was not found`)
        const next = { ...elements[index] }
        if (typeof body.key === 'string') next.key = body.key
        if (typeof body.selector === 'string' && body.selector.trim()) next.selector = body.selector.trim()
        if (typeof body.page === 'string') next.page = body.page
        if (typeof body.description === 'string') next.description = body.description
        next.updatedAt = nowIso()
        const rest = [...elements]
        rest[index] = next
        return { elements: rest }
      }, { elements: [] })
      const element = updated.elements.find((e) => e.id === elementId)
      sendJson(res, 200, { ok: true, element })
      return
    }
    if (method === 'DELETE') {
      const root = rootOf(wsOf(req.url))
      await mutateJson(root, 'ui/elements.json', (current) => ({
        elements: (current?.elements ?? []).filter((e) => e.id !== elementId),
      }), { elements: [] })
      sendJson(res, 200, { ok: true })
      return
    }
  }

  sendJson(res, 404, { ok: false, message: `${method} ${pathname} was not found` })
}

/**
 * 处理 /dsh-test-mode/api/* 请求。
 * @param ctx - 插件上下文(测试引擎的运行环境)。
 * @param req - 入站请求。
 * @param res - 出站响应。
 * @param pathname - 请求路径。
 */
/**
 * 测试资产 handler:
 * - GET    /api/assets                列表(支持 kind/module/tag/status 过滤)+ 状态汇总
 * - GET    /api/assets/pending        待测资产(未测试/失败/过期)+ 计数
 * - GET    /api/assets/:id            单个资产
 * - POST   /api/assets                新建资产
 * - PUT    /api/assets/:id            更新资产配置(自动标记过期)
 * - DELETE /api/assets/:id            删除资产
 * - POST   /api/assets/run            执行单个资产(更新状态/统计)
 * - POST   /api/assets/run-batch      批量执行待测资产(智能体分批测试)
 */
async function handleAssets(ctx, req, res, pathname, method) {
  const base = `${ROUTE_ROOT}/api/assets`
  const baseRoot = async (bodyOrQuery) => testModeRoot(ctx, requireWorkspaceId(bodyOrQuery))

  if (pathname === base && method === 'GET') {
    const root = await baseRoot({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') })
    const params = new URL(req.url ?? '', 'http://localhost').searchParams
    const statuses = params.getAll('status').flatMap((value) => value.split(',')).filter(Boolean)
    const tagFilters = [...params.getAll('tag'), ...params.getAll('tags').flatMap((value) => value.split(','))]
      .map((tag) => tag.trim()).filter(Boolean)
    const assets = await queryAssets(root, {
      kind: params.get('kind') ?? undefined,
      module: params.get('module') ?? undefined,
      tags: tagFilters.length > 0 ? tagFilters : undefined,
      statuses,
    })
    const knownTags = new Set(await loadTags(root))
    sendJson(res, 200, {
      ok: true,
      assets: assets.map((asset) => {
        const unknownTags = (asset.tags ?? []).filter((tag) => !knownTags.has(String(tag)))
        return {
          ...asset,
          stale: isAssetStale(asset),
          ...(asset.kind === 'ui' ? { granularity: uiAssetGranularity(asset) } : {}),
          ...(isSecurityAsset(asset) ? { securityWarnings: securityAssetWarnings(asset).warnings } : {}),
          ...(unknownTags.length > 0 && knownTags.size > 0 ? { tagWarnings: unknownTags } : {}),
        }
      }),
      summary: assetSummary(assets),
    })
    return
  }

  if (pathname === `${base}/pending` && method === 'GET') {
    const root = await baseRoot({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') })
    const params = new URL(req.url ?? '', 'http://localhost').searchParams
    const tagFilters = [...params.getAll('tag'), ...params.getAll('tags').flatMap((value) => value.split(','))]
      .map((tag) => tag.trim()).filter(Boolean)
    const result = await pendingAssets(root, {
      kind: params.get('kind') ?? undefined,
      module: params.get('module') ?? undefined,
      tags: tagFilters.length > 0 ? tagFilters : undefined,
    })
    sendJson(res, 200, {
      ok: true,
      assets: result.assets.map((asset) => ({ ...asset, stale: isAssetStale(asset) })),
      counts: result.counts,
    })
    return
  }

  /**
   * 执行单个资产并落盘状态/统计/通过快照。
   * @returns { outcome, asset }。
   */
  const executeAndStore = async (root, asset, body) => {
    const environmentId = await resolveEnvironmentId(root, body.environmentId ?? asset.environmentId)
    const variables = {
      ...(await loadEnvironment(root, body.environmentId ?? asset.environmentId)),
      ...(await loadSessionVariables(root, environmentId)),
    }
    const factories = await loadFactories(root)
    const elements = asset.kind === 'ui' ? await loadUiElements(root) : {}
    const effective = withAssetData(asset, body.data)
    const outcome = await runAsset(effective, { variables, factories, elements, root })
    const stored = await applyAssetOutcome(root, asset, {
      pass: outcome.pass,
      durationMs: outcome.durationMs,
      status: outcome.status,
      environmentId,
      error: outcome.error,
      snapshot: asset.kind === 'ui' ? { steps: asset.steps } : asset.request,
    })
    await saveSessionExports(root, environmentId, outcome.exports ?? {})
    return { outcome, asset: stored }
  }

  if (pathname === `${base}/run` && method === 'POST') {
    const body = await requestJson(req)
    const root = await baseRoot(body)
    const asset = await readAsset(root, body.assetId)
    if (!asset) { sendJson(res, 404, { ok: false, message: `asset "${body.assetId}" was not found` }); return }
    const { outcome, asset: stored } = await executeAndStore(root, asset, body)
    await refreshLatestReport(root, { trigger: 'asset', environmentId: body.environmentId }).catch(() => {})
    sendJson(res, 200, {
      ok: true,
      result: {
        assetId: stored.id, name: stored.name, pass: outcome.pass, status: outcome.status, durationMs: outcome.durationMs,
        error: outcome.error, assertions: outcome.assertions, steps: outcome.steps, extracted: outcome.extracted, exports: outcome.exports,
        ...(stored.kind === 'ui' ? { granularity: uiAssetGranularity(stored) } : {}),
        ...(isSecurityAsset(stored) ? { securityWarnings: securityAssetWarnings(stored).warnings } : {}),
      },
      asset: stored,
    })
    return
  }

  if (pathname === `${base}/run-batch` && method === 'POST') {
    const body = await requestJson(req)
    const root = await baseRoot(body)
    const batchSize = Math.min(Math.max(Number(body.batchSize ?? 20) || 20, 1), 100)
    let candidates
    if (Array.isArray(body.assetIds) && body.assetIds.length > 0) {
      candidates = []
      for (const assetId of body.assetIds) {
        const asset = await readAsset(root, assetId)
        if (asset) candidates.push(asset)
      }
    } else {
      const batchTags = Array.isArray(body.tags)
        ? body.tags.filter((tag) => typeof tag === 'string' && tag.trim())
        : (typeof body.tag === 'string' && body.tag ? [body.tag] : undefined)
      candidates = (await pendingAssets(root, { kind: body.kind, module: body.module, tags: batchTags })).assets
    }
    if (Array.isArray(body.statuses) && body.statuses.length > 0) {
      candidates = candidates.filter((asset) => body.statuses.includes(asset.status) || (body.statuses.includes('stale') && isAssetStale(asset)))
    }
    if (body.kind === 'ui' && (body.type === 'component' || body.type === 'flow')) {
      candidates = candidates.filter((asset) => asset.kind === 'ui' && (asset.type ?? 'flow') === body.type)
    }
    candidates.sort((a, b) => `${a.module ?? ''}${a.name ?? ''}`.localeCompare(`${b.module ?? ''}${b.name ?? ''}`))
    const batch = candidates.slice(0, batchSize)
    const results = []
    for (const asset of batch) {
      try {
        const { outcome, asset: stored } = await executeAndStore(root, asset, body)
        results.push({ assetId: stored.id, name: stored.name, module: stored.module, pass: outcome.pass, status: stored.status, error: outcome.error })
      } catch (error) {
        results.push({ assetId: asset.id, name: asset.name, module: asset.module, pass: false, status: asset.status, error: error instanceof Error ? error.message : String(error) })
      }
    }
    const after = await pendingAssets(root, {
      kind: body.kind,
      module: body.module,
      tags: Array.isArray(body.tags) ? body.tags.filter((tag) => typeof tag === 'string' && tag.trim()) : undefined,
    })
    await refreshLatestReport(root, { trigger: 'batch', environmentId: body.environmentId }).catch(() => {})
    sendJson(res, 200, {
      ok: true,
      batch: { requested: candidates.length, ran: results.length },
      results,
      remaining: after.counts,
    })
    return
  }

  if (pathname === base && method === 'POST') {
    const body = await requestJson(req)
    const root = await baseRoot(body)
    const kind = body.kind === 'ui' ? 'ui' : 'api'
    const now = new Date().toISOString()
    const name = String(body.name ?? '').trim() || (kind === 'api' ? '未命名接口资产' : '未命名 UI 资产')
    const module = String(body.module ?? '').trim() || '未分组'
    const id = `${kind}:${newId('asset').replace(/^asset-/, '')}`
    const asset = await writeAsset(root, {
      id,
      kind,
      ...(kind === 'ui' ? { type: body.type === 'component' ? 'component' : 'flow' } : {}),
      module,
      name,
      tags: Array.isArray(body.tags) ? body.tags.filter((tag) => typeof tag === 'string') : [],
      ...(kind === 'api' ? { request: body.request ?? { method: 'GET', url: '' }, baseUrl: String(body.baseUrl ?? '') } : {}),
      ...(kind === 'ui' ? { steps: Array.isArray(body.steps) ? body.steps : [] } : {}),
      ...(typeof body.environmentId === 'string' && body.environmentId ? { environmentId: body.environmentId } : {}),
      ...(body.security && typeof body.security === 'object' ? { security: body.security } : {}),
      status: 'untested',
    })
    const granularity = asset.kind === 'ui' ? uiAssetGranularity(asset) : undefined
    const securityWarnings = securityAssetWarnings(asset).warnings
    const unknownTags = await unknownAssetTags(root, asset.tags)
    const warnings = [...(granularity?.warnings ?? []), ...securityWarnings,
      ...(unknownTags.length > 0 ? [`标签不在标签库:${unknownTags.join(',')}`] : [])]
    sendJson(res, 200, {
      ok: true,
      asset: { ...asset, ...(granularity ? { granularity } : {}), ...(securityWarnings.length ? { securityWarnings } : {}), ...(unknownTags.length ? { tagWarnings: unknownTags } : {}) },
      ...(warnings.length ? { warnings } : {}),
    })
    return
  }

  // UI 资产粒度检查:GET 返回汇总与逐项指标;POST 生成整改清单到 test-mode/granularity-report.md
  if (pathname === `${base}/granularity` && method === 'GET') {
    const root = await baseRoot({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') })
    const assets = (await listAssets(root)).filter((asset) => asset.kind === 'ui')
    const items = assets.map((asset) => ({ id: asset.id, name: asset.name, module: asset.module, ...uiAssetGranularity(asset) }))
    const summary = {
      total: items.length,
      components: items.filter((item) => item.type === 'component').length,
      flows: items.filter((item) => item.type === 'flow').length,
      warningCount: items.filter((item) => item.warnings.length > 0).length,
    }
    sendJson(res, 200, { ok: true, summary, items })
    return
  }
  if (pathname === `${base}/granularity-report` && method === 'POST') {
    const body = await requestJson(req)
    const root = await baseRoot(body)
    const report = uiGranularityReport(await listAssets(root))
    await writeFile(resolve(root, 'granularity-report.md'), report.markdown)
    sendJson(res, 200, { ok: true, path: 'test-mode/granularity-report.md', summary: report.summary })
    return
  }

  const id = pathId(pathname, base)
  if (id !== undefined) {
    if (method === 'GET') {
      const root = await baseRoot({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') })
      const asset = await readAsset(root, id)
      if (!asset) { sendJson(res, 404, { ok: false, message: `asset "${id}" was not found` }); return }
      sendJson(res, 200, {
        ok: true,
        asset: {
          ...asset,
          stale: isAssetStale(asset),
          ...(asset.kind === 'ui' ? { granularity: uiAssetGranularity(asset) } : {}),
          ...(isSecurityAsset(asset) ? { securityWarnings: securityAssetWarnings(asset).warnings } : {}),
        },
      })
      return
    }
    if (method === 'PUT') {
      const body = await requestJson(req)
      const root = await baseRoot(body)
      const existing = await readAsset(root, id)
      if (!existing) { sendJson(res, 404, { ok: false, message: `asset "${id}" was not found` }); return }
      const next = { ...existing }
      if (typeof body.name === 'string' && body.name.trim()) next.name = body.name.trim()
      if (typeof body.module === 'string' && body.module.trim()) next.module = body.module.trim()
      if (Array.isArray(body.tags)) next.tags = body.tags.filter((tag) => typeof tag === 'string')
      if (existing.kind === 'ui' && Array.isArray(body.steps)) next.steps = body.steps
      if (existing.kind === 'ui' && (body.type === 'component' || body.type === 'flow')) next.type = body.type
      if (existing.kind === 'api' && body.request && typeof body.request === 'object') next.request = body.request
      if (existing.kind === 'api' && typeof body.baseUrl === 'string') next.baseUrl = body.baseUrl
      if (typeof body.environmentId === 'string') next.environmentId = body.environmentId
      if (body.security && typeof body.security === 'object') next.security = body.security
      const saved = await writeAsset(root, next)
      const granularity = saved.kind === 'ui' ? uiAssetGranularity(saved) : undefined
      const securityWarnings = securityAssetWarnings(saved).warnings
      const unknownTags = await unknownAssetTags(root, saved.tags)
      const warnings = [...(granularity?.warnings ?? []), ...securityWarnings,
        ...(unknownTags.length > 0 ? [`标签不在标签库:${unknownTags.join(',')}`] : [])]
      sendJson(res, 200, {
        ok: true,
        asset: { ...saved, stale: isAssetStale(saved), ...(granularity ? { granularity } : {}), ...(securityWarnings.length ? { securityWarnings } : {}), ...(unknownTags.length ? { tagWarnings: unknownTags } : {}) },
        ...(warnings.length ? { warnings } : {}),
      })
      return
    }
    if (method === 'DELETE') {
      const root = await baseRoot({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') })
      await deleteAsset(root, id)
      sendJson(res, 200, { ok: true })
      return
    }
  }

  sendJson(res, 404, { ok: false, message: `${method} ${pathname} was not found` })
}

/**
 * 安全回归脚手架:
 * - POST /api/security/scaffold { workspaceId, assetIds, includeIdor?, apply? }
 *   - 默认 dry-run 返回计划;`apply: true` 才写入安全专用资产与安全回归工作项;
 *   - 只生成资产/工作项文件,不执行攻击,不改动源资产;
 *   - 已存在的资产 id / 工作项名会跳过,可重复调用。
 */
async function handleSecurity(ctx, req, res, pathname, method) {
  const base = `${ROUTE_ROOT}/api/security/scaffold`
  if (pathname !== base) { sendJson(res, 404, { ok: false, message: `${pathname} was not found` }); return }
  if (method !== 'POST') { sendJson(res, 405, { ok: false, message: 'method not allowed' }); return }
  const body = await requestJson(req)
  const root = testModeRoot(ctx, requireWorkspaceId(body))
  const ids = Array.isArray(body.assetIds)
    ? body.assetIds.filter((id) => typeof id === 'string' && id).slice(0, 20)
    : []
  if (ids.length === 0) { sendJson(res, 400, { ok: false, message: 'assetIds is required (1-20 api asset ids)' }); return }
  const sources = []
  for (const id of ids) {
    const asset = await readAsset(root, id)
    if (asset) sources.push(asset)
  }
  if (sources.length === 0) { sendJson(res, 404, { ok: false, message: 'none of the given assets were found' }); return }

  const existingAssets = await listAssets(root)
  const existingCaseNames = new Set()
  for (const caseId of await listJsonFiles(root, 'cases')) {
    const item = await readJson(root, `cases/${caseId}.json`).catch(() => undefined)
    if (item?.name) existingCaseNames.add(item.name)
  }
  const tagsData = await readJson(root, 'tags.json').catch(() => undefined)
  const plan = planSecurityScaffold(sources, {
    existingAssetIds: existingAssets.map((asset) => asset.id),
    existingCaseNames,
    availableTags: Array.isArray(tagsData?.tags) ? tagsData.tags : [],
    includeIdor: body.includeIdor === true,
  })
  const summary = { assets: plan.assets.length, workItems: plan.workItems.length, skipped: plan.skipped.length, warnings: plan.warnings.length }
  if (body.apply !== true) {
    sendJson(res, 200, { ok: true, dryRun: true, summary, plan })
    return
  }
  let assetsCreated = 0
  let workItemsCreated = 0
  for (const asset of plan.assets) {
    await writeAsset(root, asset)
    assetsCreated += 1
  }
  for (const item of plan.workItems) {
    const now = nowIso()
    await writeJson(root, `cases/${item.id}.json`, { ...item, createdAt: now, updatedAt: now })
    workItemsCreated += 1
  }
  sendJson(res, 200, { ok: true, dryRun: false, created: { assets: assetsCreated, workItems: workItemsCreated }, summary, plan })
}

/**
 * 迁移 handler:
 * - POST /api/migrate/assets          旧数据增量迁移为资产(幂等)
 * - POST /api/migrate/archive-legacy  旧 plans/reports/results 归档到 legacy-<时间戳>/ (不删除)
 */
async function handleMigrate(ctx, req, res, pathname, method) {
  if (method !== 'POST') { sendJson(res, 405, { ok: false, message: 'method not allowed' }); return }
  const body = await requestJson(req)
  const root = testModeRoot(ctx, requireWorkspaceId(body))
  if (pathname === `${ROUTE_ROOT}/api/migrate/assets`) {
    // 默认 dry-run;必须显式 apply:true 才写盘。迁移内部会保留已有 assets[]、
    // 自动备份 cases/ 并校验引用数不减少。
    const manifest = await migrateLegacyAssets(root, { apply: body.apply === true })
    sendJson(res, 200, {
      ok: true,
      manifest,
      ...(manifest.dryRun ? { hint: 'dry-run: pass {"apply": true} to write; existing cases[].assets are preserved' } : {}),
    })
    return
  }
  if (pathname === `${ROUTE_ROOT}/api/migrate/archive-legacy`) {
    const bucket = `legacy-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`
    const moved = []
    for (const dir of ['plans', 'reports', 'results']) {
      const from = resolve(root, dir)
      const to = resolve(root, bucket, dir)
      try {
        await stat(from)
      } catch {
        continue
      }
      try {
        await rename(from, to)
        moved.push(dir)
      } catch {
        // 目标已存在等异常时跳过并保留原目录
      }
    }
    sendJson(res, 200, { ok: true, bucket, moved })
    return
  }
  sendJson(res, 404, { ok: false, message: `${pathname} was not found` })
}

async function handleApi(ctx, req, res, pathname) {
  const method = req.method ?? 'GET'

  // 插件测试
  if (pathname === `${ROUTE_ROOT}/api/run` && method === 'POST') {
    let body
    try {
      body = await requestJson(req)
    } catch (error) {
      sendJson(res, 400, { ok: false, message: `request body is not valid JSON: ${error.message}` })
      return
    }
    const suite = body?.suite ?? body
    if (!suite || typeof suite !== 'object' || typeof suite.name !== 'string' || typeof suite.source !== 'string') {
      sendJson(res, 400, { ok: false, message: 'expected { name: string, source: string, assertions?: [...] }' })
      return
    }
    try {
      const report = await runPluginSuite(ctx, suite)
      // 结果落盘(若提供 workspaceId)
      if (typeof body.workspaceId === 'string' && body.workspaceId) {
        try {
          const root = testModeRoot(ctx, body.workspaceId)
          await writeJson(root, `results/${suite.name}-${Date.now()}.json`, report)
        } catch {
          // 落盘失败不影响报告返回
        }
      }
      sendJson(res, 200, { ok: true, report })
    } catch (error) {
      sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  // 用例 / 项目 / 环境 / 计划 / 执行 / 历史报告
  try {
    if (pathname.startsWith(`${ROUTE_ROOT}/api/assets`)) return await handleAssets(ctx, req, res, pathname, method)
    if (pathname.startsWith(`${ROUTE_ROOT}/api/security`)) return await handleSecurity(ctx, req, res, pathname, method)
    if (pathname.startsWith(`${ROUTE_ROOT}/api/migrate`)) return await handleMigrate(ctx, req, res, pathname, method)
    if (pathname === `${ROUTE_ROOT}/api/import/openapi` && method === 'POST') {
      return await handleImportOpenapi(ctx, req, res)
    }
    if (pathname.startsWith(`${ROUTE_ROOT}/api/cases`)) return await handleCases(ctx, req, res, pathname, method)
    if (pathname.startsWith(`${ROUTE_ROOT}/api/projects`)) return await handleProjects(ctx, req, res, pathname, method)
    if (pathname.startsWith(`${ROUTE_ROOT}/api/environments`)) return await handleEnvironments(ctx, req, res, pathname, method)
    if (pathname.startsWith(`${ROUTE_ROOT}/api/tags`)) return await handleTags(ctx, req, res, pathname, method)
    if (pathname.startsWith(`${ROUTE_ROOT}/api/session`)) return await handleSession(ctx, req, res, pathname, method)
    if (pathname === `${ROUTE_ROOT}/api/dbdata`) return await handleDbData(ctx, req, res)
    if (pathname.startsWith(`${ROUTE_ROOT}/api/changelogs`)) return await handleChangelogs(ctx, req, res, pathname, method)
    if (pathname.startsWith(`${ROUTE_ROOT}/api/datafactory`)) return await handleDataFactory(ctx, req, res, pathname, method)
    if (pathname.startsWith(`${ROUTE_ROOT}/api/ui`)) return await handleUi(ctx, req, res, pathname, method)
    if (pathname === `${ROUTE_ROOT}/api/run-request`
      || pathname === `${ROUTE_ROOT}/api/run-collection`
      || pathname === `${ROUTE_ROOT}/api/run-case`) {
      if (method !== 'POST') { sendJson(res, 405, { ok: false, message: 'method not allowed' }); return }
      return await handleRun(ctx, req, res, pathname)
    }
    if (pathname.startsWith(`${ROUTE_ROOT}/api/history`) || pathname.startsWith(`${ROUTE_ROOT}/api/reports`)) {
      return await handleHistoryReports(ctx, req, res, pathname, method)
    }
    if (pathname.startsWith(`${ROUTE_ROOT}/api/stats`)) {
      if (method !== 'GET') { sendJson(res, 405, { ok: false, message: 'method not allowed' }); return }
      return await handleStats(ctx, req, res, pathname)
    }
  } catch (error) {
    sendJson(res, error instanceof Error && error.message.includes('not found') ? 404 : 400, {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    })
    return
  }

  if (pathname === `${ROUTE_ROOT}/api/health` && method === 'GET') {
    sendJson(res, 200, { ok: true, preset: TEST_MODE_PRESET_ID, route: ROUTE_ROOT })
    return
  }
  sendJson(res, 404, { ok: false, message: `${pathname} was not found` })
}

/**
 * 校验 UI 脚本文件结构(步骤 kind 枚举与必填字段)。
 * @param script - 脚本对象。
 * @returns 错误信息字符串;合法时返回 null。
 */
function validateScriptFile(script) {
  if (typeof script !== 'object' || script === null) return 'script must be an object'
  const steps = script.steps
  if (!Array.isArray(steps)) return 'steps must be an array'
  const KINDS = ['open', 'click', 'type', 'press', 'assert_text', 'assert_url', 'assert_title', 'assert_element', 'eval', 'wait', 'screenshot']
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i]
    if (typeof step !== 'object' || step === null) return `steps[${i}] must be an object`
    if (!KINDS.includes(step.kind)) return `steps[${i}].kind must be one of ${KINDS.join('/')}`
    if (step.kind === 'open' && (typeof step.url !== 'string' || !step.url)) return `steps[${i}].url is required for open`
    if (['click', 'type', 'assert_text', 'assert_element'].includes(step.kind) && (typeof step.element !== 'string' || !step.element)) {
      return `steps[${i}].element is required for ${step.kind}`
    }
    if (step.kind === 'type' && typeof step.text !== 'string') return `steps[${i}].text is required for type`
    if (step.kind === 'press' && (typeof step.key !== 'string' || !step.key)) return `steps[${i}].key is required for press`
    if (['assert_text', 'assert_url', 'assert_title'].includes(step.kind) && (typeof step.expect !== 'string' || !step.expect)) {
      return `steps[${i}].expect is required for ${step.kind}`
    }
    if (step.kind === 'eval' && typeof step.expression !== 'string' && typeof step.selector !== 'string') {
      return `steps[${i}].expression is required for eval`
    }
  }
  return null
}

/** 把文件路径规约到 test-mode 相对路径;非 test-mode 文件返回 null。 */
function testModeRelOf(cwd, filePath) {
  const p = String(filePath ?? '')
  const marker = '/test-mode/'
  const idx = p.indexOf(marker)
  if (idx >= 0) return p.slice(idx + marker.length)
  if (typeof cwd === 'string' && cwd) {
    if (p.startsWith('test-mode/')) return p.slice('test-mode/'.length)
    if (p.startsWith(`${cwd}/test-mode/`)) return p.slice(`${cwd}/test-mode/`.length)
  }
  return null
}

/**
 * 校验一个已落盘的 test-mode 文件(智能体用 write/edit 工具写盘后自动调用)。
 * @param cwd - 工作区路径(用于解析相对路径)。
 * @param filePath - 写入的文件路径。
 * @returns null(不相关文件)或 { kind, errors }(errors 为空 = 通过)。
 */
export async function validateTestModeFile(cwd, filePath) {
  const rel = testModeRelOf(cwd, filePath)
  if (rel === null) return null
  if (rel === 'tags.json') {
    let file
    try {
      file = await readJson(resolve(cwd, 'test-mode'), rel)
    } catch {
      return { kind: 'tags', errors: ['tags.json is not valid JSON'] }
    }
    // 新格式 { categories: [{ name, tags }] } 或旧格式 { tags: [] } 都接受。
    if (Array.isArray(file?.categories)) {
      const errors = []
      for (const [index, category] of file.categories.entries()) {
        if (typeof category?.name !== 'string' || !category.name.trim()) {
          errors.push(`categories[${index}].name must be a non-empty string`)
          continue
        }
        if (!Array.isArray(category.tags) || category.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) {
          errors.push(`categories[${index}].tags must be an array of non-empty strings`)
        }
      }
      return { kind: 'tags', errors }
    }
    if (!Array.isArray(file?.tags) || file.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) {
      return { kind: 'tags', errors: ['tags.json must be { "tags": ["a", "b"] } or { "categories": [{ "name": "…", "tags": [] }] } with non-empty string entries'] }
    }
    return { kind: 'tags', errors: [] }
  }
  if (rel.startsWith('dbdata/')) {
    // CSV/MD 轻校验(每行列数一致);xlsx 等二进制跳过。
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase()
    if (ext === '.csv' || ext === '.md') {
      let text
      try {
        text = await readFile(resolve(cwd, 'test-mode', rel), 'utf8')
      } catch {
        return { kind: 'dbdata', errors: [`${rel} is not readable`] }
      }
      const parsed = ext === '.csv' ? parseCsvText(text) : parseMdTableText(text)
      if (parsed && parsed.columns.length > 0) {
        const expected = parsed.columns.length
        const badRow = parsed.rows.findIndex((row) => row.length !== expected)
        if (badRow >= 0) {
          return { kind: 'dbdata', errors: [`${rel} row ${badRow + (ext === '.csv' ? 2 : 3)} has ${parsed.rows[badRow].length} columns, expected ${expected}`] }
        }
      }
    }
    return { kind: 'dbdata', errors: [] }
  }
  const match = /^(cases|api\/projects|ui\/scripts|changelogs)\/([^/]+)\.json$/.exec(rel)
  if (!match) return null
  const [, area] = match
  const root = resolve(cwd, 'test-mode')
  let file
  try {
    file = await readJson(root, rel)
  } catch {
    return { kind: area, errors: [`${rel} is not valid JSON`] }
  }
  if (area === 'changelogs') {
    const errors = []
    const strings = (value, label) => {
      if (value === undefined) return []
      if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return [`changelog.${label} must be an array of strings`]
      return []
    }
    if (typeof file.id !== 'string' || !file.id) errors.push('changelog.id is required')
    if (typeof file.createdAt !== 'string' || Number.isNaN(Date.parse(file.createdAt))) errors.push('changelog.createdAt must be an ISO date string')
    if (file.changedRequests !== undefined) {
      if (!Array.isArray(file.changedRequests)) errors.push('changelog.changedRequests must be an array')
      else {
        for (let i = 0; i < file.changedRequests.length; i += 1) {
          const item = file.changedRequests[i]
          if (!item || typeof item.method !== 'string' || typeof item.url !== 'string') {
            errors.push(`changelog.changedRequests[${i}] must have string method/url`)
          }
          if (item.change !== undefined && !['added', 'modified', 'removed'].includes(item.change)) {
            errors.push(`changelog.changedRequests[${i}].change must be added/modified/removed`)
          }
        }
      }
    }
    for (const field of ['changedCases', 'changedScripts', 'changedElements', 'changedTables', 'modules']) {
      errors.push(...strings(file[field], field))
    }
    return { kind: 'changelog', errors }
  }
  if (area === 'cases') {
    const error = await validateCaseInput(file, root)
    return { kind: 'case', errors: error === null ? [] : [error] }
  }
  if (area === 'api/projects') {
    const error = validateProjectInput(file)
    return { kind: 'project', errors: error === null ? [] : [error] }
  }
  const error = validateScriptFile(file)
  return { kind: 'ui script', errors: error === null ? [] : [error] }
}

/** dsh-test-mode 插件工厂。 */
function createTestModePlugin() {
  return {
    inject: ['webServer', 'workspaceRegistry'],
    apply(ctx) {
      ctx.effect(() => ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_ROOT,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? ROUTE_ROOT, 'http://localhost')
            if (url.pathname.startsWith(`${ROUTE_ROOT}/api`)) await handleApi(ctx, req, res, url.pathname)
            else sendJson(res, 404, { ok: false, message: `${url.pathname} was not found.` })
          } catch (error) {
            if (res.headersSent) {
              res.destroy(error instanceof Error ? error : undefined)
              return
            }
            sendJson(res, 500, {
              ok: false,
              message: error instanceof Error ? error.message : 'dsh-test-mode request failed.',
            })
          }
        },
      }), 'dsh-test-mode: routes')
      // 自动提交开关:默认开启;cordis.yml 配 config.autoCommit: false 关闭。
      // 配置读取失败按开启处理(提交本身失败静默,不影响工具链)。
      let autoCommitEnabled = true
      try {
        autoCommitEnabled = ctx.config?.autoCommit !== false
      } catch {
        autoCommitEnabled = true
      }

      // 文件变化钩子:write/edit 写入 test-mode/ 下的文件后,自动校验结构;
      // 校验失败把报错作为工具失败结果反馈给智能体(block),模型必须按报错
      // 修正后重写。校验通过后自动提交到工作区所在的 git 仓库(仅 test-mode
      // 路径,仓库缺失/无变更时静默跳过)。校验逻辑自身异常不影响工具执行链。
      ctx.effect(() => ctx.on('tools/post-execute', async (exec, _result, next) => {
        try {
          const name = exec?.name
          if (name !== 'write' && name !== 'edit') return next()
          const filePath = exec?.arguments?.file_path
          const cwd = exec?.agent?.session?.header?.cwd
          if (typeof filePath !== 'string' || !filePath || typeof cwd !== 'string' || !cwd) return next()
          const rel = testModeRelOf(cwd, filePath)
          if (rel === null) return next()
          const verdict = await validateTestModeFile(cwd, filePath)
          if (verdict !== null && verdict.errors.length > 0) {
            return {
              kind: 'block',
              feedback: [{
                type: 'text',
                text: `test-mode 自动校验:${name} 已写入 ${filePath},但内容未通过 ${verdict.kind} 结构校验,请按以下报错修正后重新写入:\n- ${verdict.errors.join('\n- ')}`,
              }],
            }
          }
          if (autoCommitEnabled) {
            const outcome = await autoCommitTestMode(cwd, rel)
            if (!outcome.committed && outcome.reason && !outcome.reason.includes('git repo') && !outcome.reason.includes('no staged') && !outcome.reason.includes('outside')) {
              ctx.logger?.warn?.(`dsh-test-mode: auto-commit skipped (${outcome.reason})`)
            }
          }
          return next()
        } catch {
          return next()
        }
      }), 'dsh-test-mode: post-write test-mode file validation + auto-commit')
    },
  }
}

const plugin = createTestModePlugin()

export const inject = plugin.inject
export const apply = plugin.apply
