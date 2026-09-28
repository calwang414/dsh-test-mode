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

import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runPluginSuite } from './plugin-test.js'
import { BUILTIN_FACTORY_ITEMS, executeCase, executeCollection, executeRequest, substitute } from './api-test.js'
import { executeUiScript } from './ui-test.js'
import { loadDbDataTables, parseCsvText, parseMdTableText } from './dbdata.js'
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
  return rest.includes('/') ? undefined : rest || undefined
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
    const variables = await loadEnvironment(root, body.environmentId)
    const factories = await loadFactories(root)
    const report = await executeCase(
      testCase,
      (ref) => resolveCaseRef(root, ref),
      variables,
      factories,
      makeRunUi(ctx, root, variables, factories),
    )
    const reportId = newId('report')
    const record = { id: reportId, kind: 'case', caseId, ...report, createdAt: nowIso() }
    await writeJson(root, `reports/${reportId}.json`, record)
    await recordHistory(root, {
      kind: 'case',
      name: `用例: ${testCase.name}`,
      pass: report.summary.failed === 0,
      durationMs: report.durationMs,
      reportId,
    })
    sendJson(res, 200, { ok: true, report: record })
    return
  }
  const id = pathId(pathname, base)
  if (method === 'GET' && id === undefined) {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const ids = await listJsonFiles(root, 'cases')
    const cases = []
    for (const caseId of ids) {
      const item = await readJson(root, `cases/${caseId}.json`)
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
    sendJson(res, 200, { ok: true, cases: cases.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))) })
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
      preconditions: typeof body.preconditions === 'string' ? body.preconditions : '',
      steps: Array.isArray(body.steps) ? body.steps : [],
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
        if (typeof body.preconditions === 'string') next.preconditions = body.preconditions
        if (Array.isArray(body.steps)) next.steps = body.steps
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
 * 校验计划输入:entries 结构 + 引用的用例/集合/脚本真实存在。
 * @param body - 请求体。
 * @param root - test-mode 根目录。
 * @returns 错误信息字符串;合法时返回 null。
 */
async function validatePlanInput(body, root) {
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) return 'plan name is required'
  const entries = body.entries
  if (entries === undefined) return null
  if (!Array.isArray(entries)) return 'entries must be an array'
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    if (typeof entry !== 'object' || entry === null) return `entries[${i}] must be an object`
    if (entry.kind === 'case') {
      if (typeof entry.caseId !== 'string' || !entry.caseId) return `entries[${i}].caseId is required`
      const testCase = await readJson(root, `cases/${entry.caseId}.json`).catch(() => undefined)
      if (!testCase) return `entries[${i}] references a missing case "${entry.caseId}"`
    } else if (entry.kind === 'collection') {
      if (typeof entry.projectId !== 'string' || !entry.projectId || typeof entry.collectionId !== 'string' || !entry.collectionId) {
        return `entries[${i}] collection entry must have string projectId/collectionId`
      }
      const project = await readJson(root, `api/projects/${entry.projectId}.json`).catch(() => undefined)
      const collection = (project?.collections ?? []).find((item) => (item.id ?? item.name) === entry.collectionId)
      if (!collection) return `entries[${i}] references a missing collection "${entry.collectionId}" in project "${entry.projectId}"`
    } else if (entry.kind === 'ui') {
      if (typeof entry.scriptId !== 'string' || !entry.scriptId) return `entries[${i}].scriptId is required`
      const script = await readJson(root, `ui/scripts/${entry.scriptId}.json`).catch(() => undefined)
      if (!script) return `entries[${i}] references a missing ui script "${entry.scriptId}"`
    } else if (entry.kind === 'incremental') {
      // 增量条目:执行时按文件变更时间展开(自 since 以来变更的接口/用例)。
      // since 缺省/为空 = 自动取最近一次计划执行时间;提供则必须是可解析的时间。
      if (entry.since !== undefined && entry.since !== '' && Number.isNaN(Date.parse(entry.since))) {
        return `entries[${i}].since must be an ISO date string`
      }
      // modules:声明的变更模块(标签),展开时按标签命中用例。
      if (entry.modules !== undefined && (!Array.isArray(entry.modules) || entry.modules.some((item) => typeof item !== 'string'))) {
        return `entries[${i}].modules must be an array of tag names`
      }
    } else {
      return `entries[${i}].kind must be case/collection/ui/incremental`
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
  const shape = (request) => {
    const { id, updatedAt, lastRun, ...rest } = request ?? {}
    return JSON.stringify(rest)
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
 * 展开增量条目:收集自 since 以来变更的接口/用例/UI 脚本,以及它们的依赖面。
 *
 * 变更信号(按精确度排序,合并去重):
 * 1. **变更清单** changelogs/*.json(createdAt ≥ since):openapi-diff 自动记录或
 *    AI 按发布说明维护,带 change 类型(added/modified/removed)与模块声明;
 * 2. **请求级 updatedAt**(保存/导入时 diff 打标):精确到单个接口;
 * 3. **文件 mtime**(重导 OpenAPI、AI 增改用例/脚本):项目文件变更 = 其中
 *    无 updatedAt 的旧请求全部变更;用例/脚本/元素库/dbdata 文件变更直接纳入;
 * 4. **覆盖/依赖反查**:变更接口的覆盖用例(步骤 requestRef/data.url/"METHOD
 *    /path");变更元素的引用脚本(脚本步骤 element key);变更表的依赖用例
 *    (用例 dependsOn);声明的变更模块(增量条目 modules + 清单 modules →
 *    按标签命中用例)。
 * @param root - test-mode 根目录。
 * @param since - ISO 基线时间;缺省/空 = 最近一次计划执行时间(无则全量收集)。
 * @param modules - 声明的变更模块(标签),可空数组。
 * @returns { entries, meta } 展开后的具体条目 + 统计信息。
 */
async function expandIncremental(root, since, modules = []) {
  let sinceMs
  if (typeof since === 'string' && since && !Number.isNaN(Date.parse(since))) {
    sinceMs = Date.parse(since)
  } else {
    // 自动基线:最近一次计划执行报告的 createdAt。
    const reportIds = await listJsonFiles(root, 'reports')
    let latest = 0
    for (const reportId of reportIds) {
      const item = await readJson(root, `reports/${reportId}.json`).catch(() => undefined)
      if (item?.kind === 'plan') {
        const at = Date.parse(String(item.createdAt ?? ''))
        if (!Number.isNaN(at) && at > latest) latest = at
      }
    }
    sinceMs = latest || 0
  }
  const sinceIso = sinceMs === 0 ? '' : new Date(sinceMs).toISOString()
  const mtimeMs = async (rel) => {
    const absolute = resolve(root, rel)
    const info = await stat(absolute).catch(() => null)
    return info ? info.mtimeMs : 0
  }

  // 0) 变更清单(语义信号,createdAt ≥ since)。
  const changelogIds = await listJsonFiles(root, 'changelogs')
  const changelogs = []
  for (const changelogId of changelogIds) {
    const item = await readJson(root, `changelogs/${changelogId}.json`).catch(() => undefined)
    if (item && Date.parse(String(item.createdAt ?? '')) >= sinceMs) changelogs.push(item)
  }
  const clRequests = changelogs.flatMap((item) =>
    (item.changedRequests ?? []).filter((r) => r && typeof r.method === 'string' && typeof r.url === 'string')
      .map((r) => ({ ...r, change: r.change ?? 'modified' })))
  const clCases = [...new Set(changelogs.flatMap((item) => item.changedCases ?? []))]
  const clScripts = [...new Set(changelogs.flatMap((item) => item.changedScripts ?? []))]
  const clElements = [...new Set(changelogs.flatMap((item) => item.changedElements ?? []))]
  const clTables = [...new Set(changelogs.flatMap((item) => item.changedTables ?? []))]
  const clModules = [...new Set(changelogs.flatMap((item) => item.modules ?? []))]
  const allModules = [...new Set([...(modules ?? []), ...clModules])]

  // 1) 变更的接口:请求级 updatedAt ≥ since;旧请求(无 updatedAt)回退项目
  //    文件 mtime;变更清单的 added/modified/removed 合并进来。
  const projectIds = await listJsonFiles(root, 'api/projects')
  const projectsById = new Map()
  const requestChanges = new Map() // `${METHOD} ${path}` → 变更描述
  for (const projectId of projectIds) {
    const project = await readJson(root, `api/projects/${projectId}.json`).catch(() => undefined)
    if (!project) continue
    projectsById.set(projectId, project)
    const fileChanged = (await mtimeMs(`api/projects/${projectId}.json`)) >= sinceMs
    for (const collection of project.collections ?? []) {
      for (const request of collection.requests ?? []) {
        const path = normalizeInterfacePath(request.url)
        if (!path) continue
        const stamped = typeof request.updatedAt === 'string' && Date.parse(request.updatedAt) >= sinceMs
        const legacyChanged = fileChanged && typeof request.updatedAt !== 'string'
        if (!stamped && !legacyChanged) continue
        requestChanges.set(`${String(request.method ?? 'GET').toUpperCase()} ${path}`, {
          projectId,
          projectName: project.name ?? projectId,
          collectionName: collection.name ?? '',
          requestName: request.name ?? request.url ?? '',
          method: String(request.method ?? 'GET').toUpperCase(),
          url: request.url ?? '',
          path,
          change: 'modified',
        })
      }
    }
  }
  for (const change of clRequests) {
    const path = normalizeInterfacePath(change.url)
    if (!path) continue
    const key = `${String(change.method ?? 'GET').toUpperCase()} ${path}`
    const project = projectsById.get(change.projectId)
    const existing = requestChanges.get(key)
    requestChanges.set(key, {
      projectId: change.projectId ?? '',
      projectName: existing?.projectName ?? project?.name ?? '',
      collectionName: existing?.collectionName ?? '',
      requestName: existing?.requestName ?? '',
      method: String(change.method ?? 'GET').toUpperCase(),
      url: String(change.url ?? ''),
      path,
      change: String(change.change ?? 'modified'),
    })
  }
  const changedRequests = [...requestChanges.values()]
  const changedPathKeys = new Set(changedRequests
    .filter((r) => r.change !== 'removed')
    .map((r) => `${r.method} ${r.path}`))

  // 2) 变更的用例:mtime + 清单;依赖变更表的用例(dependsOn)。
  const caseIds = await listJsonFiles(root, 'cases')
  const changedCases = []
  const caseById = new Map()
  for (const caseId of caseIds) {
    const testCase = await readJson(root, `cases/${caseId}.json`).catch(() => undefined)
    if (!testCase) continue
    caseById.set(caseId, testCase)
    if ((await mtimeMs(`cases/${caseId}.json`)) >= sinceMs || clCases.includes(caseId)) changedCases.push(caseId)
  }
  const changedTables = []
  for (const table of await listDbDataFiles(root)) {
    const info = await stat(resolve(root, 'dbdata', table.file)).catch(() => null)
    if (info && info.mtimeMs >= sinceMs) changedTables.push(table.name)
  }
  const allTables = [...new Set([...changedTables, ...clTables])]
  const tableCases = []
  for (const [caseId, testCase] of caseById) {
    const depends = (testCase.dependsOn ?? []).filter((table) => allTables.includes(table))
    if (depends.length > 0) tableCases.push(caseId)
  }

  // 3) 覆盖变更接口的用例(所有用例按步骤匹配 method+path)。
  const coveringCases = []
  const coveredBy = new Map() // pathKey → [caseId...]
  for (const [caseId, testCase] of caseById) {
    for (const step of testCase.steps ?? []) {
      const keys = await stepInterfaceKeys(root, step)
      const hit = keys.some((key) => changedPathKeys.has(`${key.method} ${key.path}`))
      if (hit) {
        coveringCases.push(caseId)
        for (const key of keys) {
          if (!changedPathKeys.has(`${key.method} ${key.path}`)) continue
          const list = coveredBy.get(`${key.method} ${key.path}`) ?? []
          list.push(caseId)
          coveredBy.set(`${key.method} ${key.path}`, list)
        }
        break
      }
    }
  }

  // 4) UI 脚本:变更脚本(mtime/清单)+ 引用变更元素的脚本。
  const scriptIds = await listJsonFiles(root, 'ui/scripts')
  const scriptsById = new Map()
  for (const scriptId of scriptIds) {
    const script = await readJson(root, `ui/scripts/${scriptId}.json`).catch(() => undefined)
    if (script) scriptsById.set(scriptId, script)
  }
  const changedScripts = []
  for (const scriptId of scriptIds) {
    if (clScripts.includes(scriptId) || (await mtimeMs(`ui/scripts/${scriptId}.json`)) >= sinceMs) changedScripts.push(scriptId)
  }
  const elementsData = await readJson(root, 'ui/elements.json').catch(() => undefined)
  const elements = elementsData?.elements ?? []
  const elementsFileChanged = (await mtimeMs('ui/elements.json')) >= sinceMs
  const changedElementKeys = new Set(clElements)
  for (const element of elements) {
    const stamped = typeof element.updatedAt === 'string' && Date.parse(element.updatedAt) >= sinceMs
    if (stamped || (elementsFileChanged && typeof element.updatedAt !== 'string')) changedElementKeys.add(element.key)
  }
  const affectedScripts = []
  for (const [scriptId, script] of scriptsById) {
    const refs = new Set((script.steps ?? []).map((step) => step?.element).filter(Boolean))
    if (refs.size > 0 && [...refs].some((key) => changedElementKeys.has(key))) affectedScripts.push(scriptId)
  }

  // 5) 声明的变更模块 → 按标签命中用例。
  const moduleCases = []
  if (allModules.length > 0) {
    for (const [caseId, testCase] of caseById) {
      if ((testCase.tags ?? []).some((tag) => allModules.includes(tag))) moduleCases.push(caseId)
    }
  }

  // 6) 缺口:变更(added/modified)但没有用例覆盖的接口;removed 仅计数。
  const gaps = changedRequests
    .filter((request) => request.change !== 'removed' && (coveredBy.get(`${request.method} ${request.path}`) ?? []).length === 0)
    .map((request) => ({ ...request, coveringCaseIds: coveredBy.get(`${request.method} ${request.path}`) ?? [] }))

  // 7) 汇总条目:用例(changed + covering + table + module)与 UI 脚本(changed + affected)。
  const caseSet = new Set([...changedCases, ...coveringCases, ...tableCases, ...moduleCases])
  const scriptSet = new Set([...changedScripts, ...affectedScripts])
  const caseNames = new Map([...caseById].map(([id, testCase]) => [id, testCase.name ?? id]))
  const scriptNames = new Map([...scriptsById].map(([id, script]) => [id, script.name ?? id]))
  const caseEntries = [...caseSet]
    .sort((a, b) => String(caseNames.get(a) ?? '').localeCompare(String(caseNames.get(b) ?? ''), 'zh'))
    .map((caseId) => ({ kind: 'case', caseId }))
  const scriptEntries = [...scriptSet]
    .sort((a, b) => String(scriptNames.get(a) ?? '').localeCompare(String(scriptNames.get(b) ?? ''), 'zh'))
    .map((scriptId) => ({ kind: 'ui', scriptId }))
  return {
    entries: [...caseEntries, ...scriptEntries],
    meta: {
      since: sinceIso,
      fromChangelog: changelogs.length,
      changedRequests: changedRequests.length,
      changedCases: changedCases.length,
      coveringCases: coveringCases.length,
      changedScripts: changedScripts.length,
      affectedScripts: affectedScripts.length,
      tableCases: tableCases.length,
      moduleCases: moduleCases.length,
      modules: allModules,
      gaps,
      totalEntries: caseSet.size + scriptSet.size,
    },
  }
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

/**
 * 读取用例标签库(test-mode/tags.json 的 { tags: string[] })。
 * 首次使用(文件不存在)时从现有用例自动收集标签作为种子并落盘,
 * 让存量用例的标签直接进入受控列表,后续保存校验严格按库执行。
 * @param root - test-mode 根目录。
 * @returns 标签名数组(已排序去重)。
 */
async function loadTags(root) {
  const data = await readJson(root, 'tags.json').catch(() => undefined)
  if (data && Array.isArray(data.tags)) return data.tags
  const ids = await listJsonFiles(root, 'cases')
  const collected = new Set()
  for (const caseId of ids) {
    const item = await readJson(root, `cases/${caseId}.json`).catch(() => undefined)
    for (const tag of item?.tags ?? []) {
      if (typeof tag === 'string' && tag.trim()) collected.add(tag.trim())
    }
  }
  const tags = [...collected].sort()
  // 只有收集到标签才写盘:空库不固化,等用户添加或后续用例出现再种子。
  if (tags.length > 0) await writeJson(root, 'tags.json', { tags })
  return tags
}

/**
 * 用例标签 handler:标签库 = test-mode/tags.json 的字符串数组。
 * 智能体(及前端)给用例打标时必须使用库内标签;库为空时不校验。
 */
async function handleTags(ctx, req, res, pathname, method) {
  const base = `${ROUTE_ROOT}/api/tags`
  const id = pathId(pathname, base)
  if (method === 'GET' && id === undefined) {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const tags = await loadTags(root)
    sendJson(res, 200, { ok: true, tags })
    return
  }
  if (method === 'POST' && id === undefined) {
    const body = await requestJson(req)
    const root = testModeRoot(ctx, requireWorkspaceId(body))
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name) { sendJson(res, 400, { ok: false, message: 'tag name is required' }); return }
    const tags = await loadTags(root)
    if (tags.includes(name)) { sendJson(res, 400, { ok: false, message: `tag "${name}" already exists` }); return }
    const next = [...tags, name].sort()
    await writeJson(root, 'tags.json', { tags: next })
    sendJson(res, 200, { ok: true, tags: next })
    return
  }
  if (id !== undefined && method === 'DELETE') {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const name = decodeURIComponent(id)
    const updated = await mutateJson(root, 'tags.json', (current) => ({
      tags: (current?.tags ?? []).filter((tag) => tag !== name),
    }), { tags: [] })
    sendJson(res, 200, { ok: true, tags: updated.tags })
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
async function updateRequestStatus(root, projectId, collectionId, requestId, pass, status) {
  if (!projectId || !collectionId || !requestId) return
  await mutateJson(root, `api/projects/${projectId}.json`, (current) => {
    if (!current) return current
    const collections = (current.collections ?? []).map((collection) => {
      if ((collection.id ?? collection.name) !== collectionId) return collection
      const requests = (collection.requests ?? []).map((request) => {
        if ((request.id ?? request.name) !== requestId) return request
        return { ...request, lastRun: { pass: pass === true, status, at: nowIso() } }
      })
      return { ...collection, requests }
    })
    return { ...current, collections }
  }).catch(() => {})
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
      const report = await executeUiScript(ctx, script, elements, variables, factories)
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
    await recordHistory(root, history, {
      request: { method: history.method, url: resolvedUrl, headers: request.headers ?? {}, body: request.body },
      response: {
        status: outcome.status,
        headers: outcome.headers,
        text: outcome.text,
      },
      assertions: outcome.assertions,
    })
    // 记录接口最后执行状态(缺口 mock 分析依据)。
    await updateRequestStatus(root, body.projectId, body.collectionId, request.id, outcome.ok, outcome.status)
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
      await updateRequestStatus(root, project.id, collectionId, item.requestId, item.pass, item.status)
    }
    await saveSessionExports(root, effectiveEnvironmentId, report.exports)
    const reportId = newId('report')
    const record = { id: reportId, kind: 'collection', projectId: project.id, collectionId, ...report, createdAt: nowIso() }
    await writeJson(root, `reports/${reportId}.json`, record)
    await recordHistory(root, {
      kind: 'collection',
      name: `${project.name} / ${collection.name}`,
      pass: record.summary.failed === 0,
      durationMs: record.durationMs,
      reportId,
    })
    sendJson(res, 200, { ok: true, report: record })
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
    const reportId = newId('report')
    const record = { id: reportId, kind: 'case', caseId, ...report, createdAt: nowIso() }
    await writeJson(root, `reports/${reportId}.json`, record)
    await recordHistory(root, {
      kind: 'case',
      name: `用例: ${testCase.name}`,
      pass: report.summary.failed === 0,
      durationMs: report.durationMs,
      reportId,
    })
    sendJson(res, 200, { ok: true, report: record })
    return
  }

  if (pathname === `${ROUTE_ROOT}/api/run-plan`) {
    const plan = await readJson(root, `plans/${body.planId}.json`)
    if (!plan) { sendJson(res, 404, { ok: false, message: `plan "${body.planId}" was not found` }); return }
    // 计划自带环境优先;未绑定则回退请求携带的环境(两者都缺时由 loadEnvironment 兜底默认环境)。
    // 变量同样合并会话缓存(登录态跨执行复用)。
    const planEnvId = (typeof plan.environmentId === 'string' && plan.environmentId) ? plan.environmentId : undefined
    const planEffectiveEnvId = planEnvId ?? effectiveEnvironmentId
    const planVariables = planEnvId
      ? { ...(await loadEnvironment(root, planEnvId)), ...(await loadSessionVariables(root, planEnvId)) }
      : variables
    // 1) 展开条目:incremental 按文件变更时间展开为具体用例;template 计划不可执行。
    if (plan.template === true) { sendJson(res, 400, { ok: false, message: '模板计划不能直接执行,请先「从模板新建」' }); return }
    let entries = []
    for (const entry of plan.entries ?? []) {
      if (entry.kind === 'incremental') {
        const expanded = await expandIncremental(root, entry.since, entry.modules)
        entries.push(...expanded.entries)
      } else {
        entries.push(entry)
      }
    }
    // 2) 失败重跑模式:只执行上次报告中失败的条目(快照优先,旧报告按名称回退)。
    if (body.failedOnly === true) {
      const reportIds = await listJsonFiles(root, 'reports')
      let latestReport = null
      for (const reportId of reportIds) {
        const item = await readJson(root, `reports/${reportId}.json`).catch(() => undefined)
        if (item?.kind === 'plan' && item.planId === plan.id) {
          if (!latestReport || String(item.createdAt ?? '') > String(latestReport.createdAt ?? '')) latestReport = item
        }
      }
      if (!latestReport) { sendJson(res, 400, { ok: false, message: '该计划还没有执行记录,无法重跑失败' }); return }
      const snapshot = latestReport.entriesSnapshot ?? latestReport.planEntries ?? null
      const failedKeys = new Set()
      for (const result of latestReport.results ?? []) {
        if (result.pass === false) {
          const identity = result.caseId ?? result.projectId ?? result.scriptId
          if (identity) failedKeys.add(`${result.kind}:${identity}`)
        }
      }
      let failedEntries = null
      if (snapshot && failedKeys.size > 0) {
        failedEntries = snapshot.filter((entry) => {
          const identity = entry.kind === 'case' ? entry.caseId : entry.kind === 'collection' ? entry.projectId : entry.scriptId
          return identity && failedKeys.has(`${entry.kind}:${identity}`)
        })
      }
      if (!failedEntries) { sendJson(res, 400, { ok: false, message: '上次执行没有失败条目(或旧报告缺少条目快照,请重新执行一次)' }); return }
      entries = failedEntries
    }
    const startedAt = new Date().toISOString()
    const started = Date.now()
    const allResults = []
    const planExports = {}
    let total = 0
    let passed = 0
    // 元素库映射(供 ui 条目解析 element 引用)。
    const elementsData = await readJson(root, 'ui/elements.json').catch(() => undefined)
    const elements = {}
    for (const element of elementsData?.elements ?? []) {
      if (element?.key && typeof element.selector === 'string') elements[element.key] = element.selector
    }
    for (const entry of entries) {
      if (entry.kind === 'case') {
        const testCase = await readJson(root, `cases/${entry.caseId}.json`).catch(() => undefined)
        if (!testCase) continue
        const report = await executeCase(
          testCase,
          (ref) => resolveCaseRef(root, ref),
          planVariables,
          factories,
          makeRunUi(ctx, root, planVariables, factories),
        )
        total += report.summary.total
        passed += report.summary.passed
        for (const [name, value] of Object.entries(report.exports ?? {})) planExports[name] = value
        allResults.push(...report.results.map((item) => ({
          ...item, kind: 'case', stepKind: item.kind, caseId: entry.caseId, caseName: testCase.name,
        })))
      } else if (entry.kind === 'collection') {
        const project = await readJson(root, `api/projects/${entry.projectId}.json`).catch(() => undefined)
        const collection = (project?.collections ?? []).find((item) => (item.id ?? item.name) === entry.collectionId)
        if (!project || !collection) continue
        const report = await executeCollection(collection, project.baseUrl, planVariables, factories)
        total += report.summary.total
        passed += report.summary.passed
        for (const [name, value] of Object.entries(report.exports ?? {})) planExports[name] = value
        allResults.push(...report.results.map((item) => ({
          ...item, kind: 'collection', stepKind: item.kind, projectId: entry.projectId, collectionId: entry.collectionId,
          collectionName: `${project.name} / ${collection.name}`,
        })))
      } else if (entry.kind === 'ui') {
        const script = await readJson(root, `ui/scripts/${entry.scriptId}.json`).catch(() => undefined)
        if (!script) continue
        const report = await executeUiScript(ctx, script, elements, planVariables, factories)
        total += report.summary.total
        passed += report.summary.passed
        for (const [name, value] of Object.entries(report.exports ?? {})) planExports[name] = value
        allResults.push(...report.results.map((item) => ({
          ...item, kind: 'ui', stepKind: item.kind, scriptId: entry.scriptId, scriptName: script.name,
        })))
      }
    }
    const record = {
      id: newId('report'),
      kind: 'plan',
      planId: plan.id,
      name: `计划: ${plan.name}${body.failedOnly === true ? '(失败重跑)' : ''}`,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      summary: { total, passed, failed: total - passed },
      results: allResults,
      entriesSnapshot: entries,
      failedOnly: body.failedOnly === true,
      createdAt: nowIso(),
    }
    // 计划执行产生的 export 变量(如登录 token)写入会话,供后续执行复用。
    await saveSessionExports(root, planEffectiveEnvId, planExports)
    await writeJson(root, `reports/${record.id}.json`, record)
    await recordHistory(root, {
      kind: 'plan',
      name: `计划: ${plan.name}`,
      pass: record.summary.failed === 0,
      durationMs: record.durationMs,
      reportId: record.id,
    })
    sendJson(res, 200, { ok: true, report: record })
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
  const rows = []
  const history = await readHistory(root)
  for (const entry of history) {
    if (entry.kind === 'request' && entry.method && entry.url) {
      rows.push({
        method: String(entry.method).toUpperCase(),
        url: String(entry.url),
        pass: entry.pass === true,
        durationMs: entry.durationMs ?? 0,
        createdAt: entry.createdAt ?? '',
        status: entry.status,
      })
    }
  }
  const ids = await listJsonFiles(root, 'reports')
  for (const reportId of ids) {
    const item = await readJson(root, `reports/${reportId}.json`).catch(() => undefined)
    if (!item) continue
    for (const result of item.results ?? []) {
      if (result.method && result.url) {
        rows.push({
          method: String(result.method).toUpperCase(),
          url: String(result.url),
          pass: result.pass === true,
          durationMs: result.durationMs ?? 0,
          createdAt: item.createdAt ?? '',
          status: result.status,
          failedAssertions: (result.assertions ?? []).filter((assertion) => assertion.pass === false),
        })
      }
    }
  }
  if (pathname === `${ROUTE_ROOT}/api/stats/interfaces`) {
    const byKey = new Map()
    for (const row of rows) {
      const key = `${row.method} ${row.url}`
      const entry = byKey.get(key) ?? { method: row.method, url: row.url, total: 0, passed: 0, durations: [], lastPass: null, lastStatus: null, lastAt: '' }
      entry.total += 1
      if (row.pass) entry.passed += 1
      entry.durations.push(row.durationMs)
      if (String(row.createdAt ?? '') >= String(entry.lastAt ?? '')) {
        entry.lastAt = row.createdAt ?? ''
        entry.lastPass = row.pass
        entry.lastStatus = row.status ?? null
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
      avgDurationMs: entry.durations.length > 0 ? Math.round(entry.durations.reduce((a, b) => a + b, 0) / entry.durations.length) : 0,
      lastPass: entry.lastPass,
      lastStatus: entry.lastStatus,
      lastAt: entry.lastAt,
    }))
    interfaces.sort((a, b) => (a.failed !== b.failed ? b.failed - a.failed : b.total - a.total))
    sendJson(res, 200, { ok: true, interfaces: interfaces.slice(0, 60) })
    return
  }
  if (pathname === `${ROUTE_ROOT}/api/stats/failures`) {
    const requestCount = new Map()
    const assertionCount = new Map()
    for (const row of rows) {
      if (!row.pass) {
        const key = `${row.method} ${row.url}`
        requestCount.set(key, (requestCount.get(key) ?? 0) + 1)
      }
      for (const assertion of row.failedAssertions ?? []) {
        const label = `${assertion.type ?? '?'}${assertion.path ? ` ${assertion.path}` : ''} ${assertion.operator ?? ''} ${JSON.stringify(assertion.expected)}`
        assertionCount.set(label, (assertionCount.get(label) ?? 0) + 1)
      }
    }
    const topFailedRequests = [...requestCount.entries()].map(([key, count]) => {
      const [method, ...urlParts] = key.split(' ')
      return { method, url: urlParts.join(' '), failCount: count }
    }).sort((a, b) => b.failCount - a.failCount).slice(0, 15)
    const topFailedAssertions = [...assertionCount.entries()]
      .map(([label, count]) => ({ label, failCount: count }))
      .sort((a, b) => b.failCount - a.failCount).slice(0, 15)
    sendJson(res, 200, { ok: true, topFailedRequests, topFailedAssertions })
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
  const kindLabel = { request: '单请求', case: '用例', collection: '集合', plan: '计划' }[report.kind] ?? '执行'
  const lines = [
    `# ${report.name ?? '未命名报告'}`,
    '',
    `- 类型:${kindLabel}`,
    `- 开始于:${new Date(report.startedAt ?? report.createdAt ?? '').toLocaleString()}`,
    `- 耗时:${(report.durationMs ?? 0).toFixed(0)}ms`,
    `- 结果:总数 ${summary.total ?? 0},通过 ${summary.passed ?? 0},失败 ${summary.failed ?? 0}${summary.skipped ? `,跳过 ${summary.skipped}` : ''}`,
    '',
    '| # | 名称 | 方法 | URL | 结果 | 状态 | 耗时 |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const [index, result] of (report.results ?? []).entries()) {
    const pass = result.skipped ? '跳过' : (result.pass ? '✅ PASS' : '❌ FAIL')
    lines.push(
      `| ${index + 1} | ${escapeMd(result.name ?? result.step?.action ?? '')} | ${result.method ?? ''} | ${escapeMd(result.url ?? '')} | ${pass} | ${result.status ?? ''} | ${(result.durationMs ?? 0).toFixed(0)}ms |`,
    )
  }
  const failures = (report.results ?? []).filter((r) => r.pass === false)
  if (failures.length > 0) {
    lines.push('', '## 失败详情', '')
    for (const result of failures) {
      lines.push(`### ${escapeMd(result.name ?? '请求')}`)
      lines.push('')
      if (result.error) lines.push(`- 错误:${escapeMd(result.error)}`)
      for (const assertion of result.assertions ?? []) {
        if (assertion.pass) continue
        lines.push(
          `- ❌ ${assertion.type ?? ''}${assertion.path ? ` \`${assertion.path}\`` : ''} ${assertion.operator ?? ''} ${JSON.stringify(assertion.expected)} → 实际 ${JSON.stringify(assertion.actual)}`,
        )
      }
      lines.push('')
    }
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
  const reportsBase = `${ROUTE_ROOT}/api/reports`
  if (pathname === reportsBase && method === 'GET') {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const ids = await listJsonFiles(root, 'reports')
    const reports = []
    for (const reportId of ids) {
      const item = await readJson(root, `reports/${reportId}.json`)
      if (item) reports.push(item)
    }
    sendJson(res, 200, { ok: true, reports: reports.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''))) })
    return
  }
  const reportId = pathId(pathname, reportsBase)
  // 对比子路由:GET /api/reports/:id/compare — 与同 kind+name 的最近一次报告对比。
  const compareMatch = /^\/dsh-test-mode\/api\/reports\/([^/]+)\/compare$/.exec(pathname)
  if (compareMatch && method === 'GET') {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const report = await readJson(root, `reports/${compareMatch[1]}.json`)
    if (!report) { sendJson(res, 404, { ok: false, message: `report "${compareMatch[1]}" was not found` }); return }
    const ids = await listJsonFiles(root, 'reports')
    const series = []
    for (const rid of ids) {
      const item = await readJson(root, `reports/${rid}.json`)
      if (item && item.kind === report.kind && item.name === report.name
        && item.id !== report.id && String(item.createdAt ?? '') < String(report.createdAt ?? '')) {
        series.push(item)
      }
    }
    series.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
    const previous = series[0]
    if (!previous) { sendJson(res, 200, { ok: true, hasPrevious: false }); return }
    // diff:按 method+url 匹配请求;当前失败且上次非失败 = 新失败;上次失败当前通过 = 修复。
    const keyOf = (result) => `${String(result.method ?? '').toUpperCase()} ${result.url ?? result.name ?? ''}`
    const prevPass = new Map((previous.results ?? []).map((result) => [keyOf(result), result.pass === true]))
    const newFailures = (report.results ?? []).filter((result) => result.pass === false && prevPass.get(keyOf(result)) !== false)
    const fixedCount = (previous.results ?? []).filter((result) => result.pass === false
      && (report.results ?? []).some((current) => keyOf(current) === keyOf(result) && current.pass === true)).length
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
    const report = await readJson(root, `reports/${exportMatch[1]}.json`)
    if (!report) { sendJson(res, 404, { ok: false, message: `report "${exportMatch[1]}" was not found` }); return }
    const markdown = renderReportMarkdown(report)
    try {
      await writeJson(root, `exports/${report.id}.json`, { exportedAt: nowIso(), markdown })
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
  if (reportId !== undefined) {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    if (method === 'GET') {
      const item = await readJson(root, `reports/${reportId}.json`)
      if (!item) { sendJson(res, 404, { ok: false, message: `report "${reportId}" was not found` }); return }
      sendJson(res, 200, { ok: true, report: item })
      return
    }
    if (method === 'DELETE') {
      await deleteJson(root, `reports/${reportId}.json`)
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
 * 测试计划 handler:计划 = 一批用例 + 集合,一键执行。
 * 实体存 `test-mode/plans/<id>.json`:{ id, name, environmentId?, entries: [{ kind: 'case',
 * caseId } | { kind: 'collection', projectId, collectionId }], createdAt,
 * updatedAt }。environmentId 在创建/编辑计划时绑定,执行计划时优先使用;
 * 为空或缺失时回退默认环境。
 */
async function handlePlans(ctx, req, res, pathname, method) {
  const base = `${ROUTE_ROOT}/api/plans`
  // 增量预览:展开增量条目但不落盘,供计划编辑器「预览」展示。
  if (pathname === `${base}/incremental-preview` && method === 'POST') {
    const body = await requestJson(req)
    const root = testModeRoot(ctx, requireWorkspaceId(body))
    const since = typeof body.since === 'string' ? body.since : ''
    if (since && Number.isNaN(Date.parse(since))) { sendJson(res, 400, { ok: false, message: 'since must be an ISO date string' }); return }
    if (body.modules !== undefined && (!Array.isArray(body.modules) || body.modules.some((item) => typeof item !== 'string'))) {
      sendJson(res, 400, { ok: false, message: 'modules must be an array of tag names' })
      return
    }
    const expanded = await expandIncremental(root, since, body.modules ?? [])
    sendJson(res, 200, { ok: true, ...expanded.meta, entries: expanded.entries })
    return
  }
  const id = pathId(pathname, base)
  if (method === 'GET' && id === undefined) {
    const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
    const ids = await listJsonFiles(root, 'plans')
    const plans = []
    for (const planId of ids) {
      const item = await readJson(root, `plans/${planId}.json`)
      if (item) plans.push(item)
    }
    sendJson(res, 200, { ok: true, plans: plans.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''))) })
    return
  }
  if (method === 'POST' && id === undefined) {
    const body = await requestJson(req)
    const root = testModeRoot(ctx, requireWorkspaceId(body))
    const validation = await validatePlanInput(body, root)
    if (validation !== null) { sendJson(res, 400, { ok: false, message: validation }); return }
    const planId = newId('plan')
    const now = nowIso()
    const item = {
      id: planId,
      name: String(body.name ?? '未命名计划'),
      entries: Array.isArray(body.entries) ? body.entries : [],
      ...(typeof body.environmentId === 'string' ? { environmentId: body.environmentId } : {}),
      ...(body.template === true ? { template: true } : {}),
      createdAt: now,
      updatedAt: now,
    }
    await writeJson(root, `plans/${planId}.json`, item)
    sendJson(res, 200, { ok: true, plan: item })
    return
  }
  if (id !== undefined) {
    if (method === 'GET') {
      const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
      const item = await readJson(root, `plans/${id}.json`)
      if (!item) { sendJson(res, 404, { ok: false, message: `plan "${id}" was not found` }); return }
      sendJson(res, 200, { ok: true, plan: item })
      return
    }
    if (method === 'PUT') {
      const body = await requestJson(req)
      const root = testModeRoot(ctx, requireWorkspaceId(body))
      const validation = await validatePlanInput(body, root)
      if (validation !== null) { sendJson(res, 400, { ok: false, message: validation }); return }
      const updated = await mutateJson(root, `plans/${id}.json`, (current) => {
        if (!current) throw new Error(`plan "${id}" was not found`)
        const next = { ...current }
        if (typeof body.name === 'string') next.name = body.name
        if (Array.isArray(body.entries)) next.entries = body.entries
        if (typeof body.environmentId === 'string') next.environmentId = body.environmentId
        if (body.template === true) next.template = true
        else if (body.template === false) delete next.template
        next.updatedAt = nowIso()
        return next
      })
      sendJson(res, 200, { ok: true, plan: updated })
      return
    }
    if (method === 'DELETE') {
      const root = testModeRoot(ctx, requireWorkspaceId({ workspaceId: new URL(req.url ?? '', 'http://localhost').searchParams.get('workspaceId') }))
      await deleteJson(root, `plans/${id}.json`)
      sendJson(res, 200, { ok: true })
      return
    }
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
 * 单文件)+ 执行(POST /api/ui/run,通过 tools 服务调用 cdp-browser 的
 * browser_* 工具驱动受控 Chrome)。
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
      { continueOnError: body.continueOnError === true },
    )
    await saveSessionExports(root, effectiveEnvironmentId, report.exports)
    const reportId = newId('report')
    const record = { id: reportId, kind: 'ui', scriptId, ...report, createdAt: nowIso() }
    await writeJson(root, `reports/${reportId}.json`, record)
    await recordHistory(root, {
      kind: 'ui',
      name: `UI: ${script.name}`,
      pass: report.summary.failed === 0,
      durationMs: report.durationMs,
      reportId,
    })
    sendJson(res, 200, { ok: true, report: record })
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
    if (pathname.startsWith(`${ROUTE_ROOT}/api/plans`)) return await handlePlans(ctx, req, res, pathname, method)
    if (pathname.startsWith(`${ROUTE_ROOT}/api/datafactory`)) return await handleDataFactory(ctx, req, res, pathname, method)
    if (pathname.startsWith(`${ROUTE_ROOT}/api/ui`)) return await handleUi(ctx, req, res, pathname, method)
    if (pathname === `${ROUTE_ROOT}/api/run-request`
      || pathname === `${ROUTE_ROOT}/api/run-collection`
      || pathname === `${ROUTE_ROOT}/api/run-case`
      || pathname === `${ROUTE_ROOT}/api/run-plan`) {
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
    if (!Array.isArray(file?.tags) || file.tags.some((tag) => typeof tag !== 'string' || !tag.trim())) {
      return { kind: 'tags', errors: ['tags.json must be { "tags": ["a", "b"] } with non-empty string entries'] }
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
  const match = /^(cases|api\/projects|plans|ui\/scripts|changelogs)\/([^/]+)\.json$/.exec(rel)
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
  if (area === 'plans') {
    const error = await validatePlanInput(file, root)
    return { kind: 'plan', errors: error === null ? [] : [error] }
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
