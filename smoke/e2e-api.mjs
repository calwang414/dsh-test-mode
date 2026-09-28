/**
 * 端到端冒烟测试:用例管理 + API 测试 + 执行报告全链路。
 * 运行:node smoke/e2e-api.mjs
 * (需要能解析 @deepseek-ai/cordis 等 peer 依赖;本文件用绝对路径指向 harness 安装)
 *
 * 覆盖:
 * 1. 插件装载(webServer + workspaceRegistry mock);
 * 2. 用例创建/读取/更新/删除;
 * 3. API 项目/环境/集合 CRUD;
 * 4. 单请求执行(本地 mock 服务器,断言 status/json);
 * 5. 集合执行 → 报告生成;
 * 6. 历史与报告读取。
 */

import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Context } from '/Applications/DeepSeek Harness.app/Contents/Resources/resources/harness/node_modules/@deepseek-ai/cordis/lib/index.js'
import { SystemPrompt } from '/Applications/DeepSeek Harness.app/Contents/Resources/resources/harness/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'
import { ToolRuntime } from '/Applications/DeepSeek Harness.app/Contents/Resources/resources/harness/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
import { apply, inject, validateTestModeFile } from '../lib/index.js'

let failed = 0
let passed = 0
function check(condition, label, detail) {
  if (condition) { passed++; console.log(`  PASS ${label}`) }
  else { failed++; console.log(`  FAIL ${label} ${detail ?? ''}`) }
}

// ── mock HTTP 服务器(API 测试目标) ──────────────────────────────────────
let lastLoginBody = ''
let lastMeHeaders = ''
const mock = createServer((req, res) => {
  if (req.url === '/api/login') {
    // 若请求体残留未替换的 {{...}} 模板 → 500,用于验证环境变量确实生效
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      if (raw.includes('{{')) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ code: 500, message: 'unsubstituted template' }))
        return
      }
      lastLoginBody = raw
      res.writeHead(200, { 'content-type': 'application/json', 'x-test-header': 'mock', 'set-cookie': 'sid=abc123; Path=/' })
      res.end(JSON.stringify({ code: 0, token: 'tok-123', user: { id: 7, name: 'alice' } }))
    })
    return
  }
  if (req.url === '/api/me') {
    req.on('data', () => {})
    req.on('end', () => {
      lastMeHeaders = `${req.headers['authorization'] ?? ''}|${req.headers['cookie'] ?? ''}`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, id: 7, name: 'alice' }))
    })
    return
  }
  if (req.url === '/api/error') {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 500, message: 'boom' }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ code: 404 }))
})
await new Promise((resolveListen) => mock.listen(0, '127.0.0.1', resolveListen))
const mockPort = mock.address().port
const baseUrl = `http://127.0.0.1:${mockPort}`

// ── 插件装载(webServer + workspaceRegistry mock) ─────────────────────────
const ctx = new Context()
const prompt = new SystemPrompt(ctx, {})
prompt.start?.()
const tools = new ToolRuntime(ctx)
tools.start?.()
await ctx.fiber.await()

// 临时工作区
const workspacePath = await mkdtemp(join(tmpdir(), 'test-mode-e2e-'))
const workspaceId = 'ws-e2e'

const routes = []
let webserverRequests = 0
ctx.provide('webServer', {
  register: (route) => { routes.push(route); return () => {} },
})
ctx.provide('workspaceRegistry', {
  get: (id) => (id === workspaceId ? { id, path: workspacePath } : undefined),
})
const fiber = ctx.plugin({ apply, inject })
await fiber.await()
const route = routes[0]
check(typeof route === 'object' && route.path === '/dsh-test-mode', 'route registered', JSON.stringify(route))

/** 调用路由 handler 的辅助:返回 { status, body }。 */
async function api(method, pathname, payload, query = {}) {
  const search = new URLSearchParams(query).toString()
  const url = `/dsh-test-mode${pathname}${search ? `?${search}` : ''}`
  let body = null
  if (payload !== undefined) {
    body = JSON.stringify(payload)
  }
  const req = {
    method,
    url,
    [Symbol.asyncIterator]: body === null
      ? async function* () { /* no body */ }
      : async function* () { yield Buffer.from(body) },
  }
  let captured = null
  const res = {
    writeHead: (status, headers) => { captured = { status, headers } },
    end: (chunk) => { captured.body = chunk ? JSON.parse(chunk) : null },
  }
  await route.handler(req, res)
  return captured
}

// ── 1. 用例管理 ──────────────────────────────────────────────────────────
console.log('\n=== 用例管理 ===')
const createdCase = await api('POST', '/api/cases', {
  workspaceId,
  name: '登录功能测试',
  description: '验证登录流程',
  priority: 'high',
  preconditions: '用户已注册',
  steps: [{ action: '输入用户名密码', expected: '登录成功' }],
  tags: ['登录', '冒烟'],
})
check(createdCase.status === 200 && createdCase.body.ok, 'create case', JSON.stringify(createdCase.body))
const caseId = createdCase.body.case.id
check(typeof caseId === 'string' && caseId.startsWith('case-'), 'case id generated', caseId)

const listed = await api('GET', '/api/cases', undefined, { workspaceId })
check(listed.status === 200 && listed.body.cases.length === 1, 'list cases', JSON.stringify(listed.body))

const updated = await api('PUT', `/api/cases/${caseId}`, { workspaceId, name: '登录功能测试(改)', status: 'active' })
check(updated.status === 200 && updated.body.case.name === '登录功能测试(改)' && updated.body.case.status === 'active', 'update case', JSON.stringify(updated.body))

const single = await api('GET', `/api/cases/${caseId}`, undefined, { workspaceId })
check(single.status === 200 && single.body.case.name === '登录功能测试(改)', 'get single case')

// ── 2. API 项目 / 环境 / 集合 CRUD ───────────────────────────────────────
console.log('\n=== API 项目 ===')
const createdProject = await api('POST', '/api/projects', {
  workspaceId,
  name: '用户服务',
  baseUrl,
  collections: [{
    id: 'col-auth',
    name: '认证',
    requests: [
      {
        id: 'req-login',
        name: '登录',
        method: 'POST',
        url: '/api/login',
        headers: [{ key: 'content-type', value: 'application/json' }],
        body: '{"user":"{{USER}}"}',
        assertions: [
          { type: 'status', operator: 'eq', expected: 200 },
          { type: 'json', path: '$.code', operator: 'eq', expected: 0 },
          { type: 'json', path: '$.token', operator: 'contains', expected: 'tok-' },
        ],
        extract: [{ key: 'TOKEN', value: '$.token' }],
      },
      {
        id: 'req-me',
        name: '获取当前用户',
        method: 'GET',
        url: '/api/me',
        headers: [{ key: 'authorization', value: 'Bearer {{TOKEN}}' }],
        assertions: [
          { type: 'status', operator: 'eq', expected: 200 },
          { type: 'json', path: '$.name', operator: 'eq', expected: 'alice' },
        ],
      },
    ],
  }],
})
check(createdProject.status === 200 && createdProject.body.ok, 'create project', JSON.stringify(createdProject.body))
const projectId = createdProject.body.project.id

const createdEnv = await api('POST', '/api/environments', {
  workspaceId,
  name: '测试环境',
  variables: { USER: 'alice', BASE: baseUrl },
})
check(createdEnv.status === 200 && createdEnv.body.ok, 'create environment', JSON.stringify(createdEnv.body))
const envId = createdEnv.body.environment.id
check(createdEnv.body.isDefault === true, 'first environment auto-set as default', JSON.stringify(createdEnv.body.isDefault))
const envList = await api('GET', '/api/environments', undefined, { workspaceId })
check(envList.body.defaultEnvironmentId === envId, 'environments list returns default id', JSON.stringify(envList.body.defaultEnvironmentId))

// 旧环境文件(直接写盘,无 id 字段):GET 以文件名为 id 补齐,设为默认不再 404
await writeFile(join(workspacePath, 'test-mode/api/environments/legacy-env.json'), JSON.stringify({ name: '磁盘旧环境', variables: { A: '1' } }))
const envList2 = await api('GET', '/api/environments', undefined, { workspaceId })
const legacyEnv = envList2.body.environments.find((e) => e.name === '磁盘旧环境')
check(legacyEnv?.id === 'legacy-env', 'environments list derives id from filename', JSON.stringify(legacyEnv?.id))
const setLegacyDefault = await api('POST', `/api/environments/${legacyEnv.id}/default`, { workspaceId })
check(setLegacyDefault.status === 200 && setLegacyDefault.body.ok, 'set-default works for legacy env (no undefined id)', JSON.stringify(setLegacyDefault.body))
check(setLegacyDefault.body.defaultEnvironmentId === 'legacy-env', 'set-default stores derived id', JSON.stringify(setLegacyDefault.body))
// 恢复默认环境为 envId,避免影响后续「默认环境回退」断言
await api('POST', `/api/environments/${envId}/default`, { workspaceId })

// ── 3. 单请求执行(带环境变量) ────────────────────────────────────────────
console.log('\n=== 单请求执行 ===')
// 未指定 environmentId 时回退默认环境(变量 BASE 应替换)
const runWithDefault = await api('POST', '/api/run-request', {
  workspaceId,
  baseUrl,
  request: {
    name: '默认环境回退',
    method: 'GET',
    url: '/api/health?u={{USER}}',
    assertions: [],
  },
})
check(runWithDefault.status === 200 && runWithDefault.body.ok, 'run-request falls back to default env', JSON.stringify(runWithDefault.body))
const runRequest = await api('POST', '/api/run-request', {
  workspaceId,
  environmentId: envId,
  baseUrl,
  projectId,
  collectionId: 'col-auth',
  request: {
    id: 'req-login',
    name: '登录',
    method: 'POST',
    url: '/api/login',
    headers: { 'content-type': 'application/json' },
    body: '{"user":"{{USER}}"}',
    assertions: [
      { type: 'status', operator: 'eq', expected: 200 },
      { type: 'json', path: '$.code', operator: 'eq', expected: 0 },
    ],
    extract: [{ key: 'TOKEN', value: '$.token' }],
  },
})
check(runRequest.status === 200 && runRequest.body.ok, 'run-request ok', JSON.stringify(runRequest.body))
check(runRequest.body.result.ok === true, 'request assertions pass', JSON.stringify(runRequest.body.result.assertions))
check(runRequest.body.result.extracted?.TOKEN === 'tok-123', 'extract variable', JSON.stringify(runRequest.body.result.extracted))

// 失败路径:请求一个 500 的接口
const runFail = await api('POST', '/api/run-request', {
  workspaceId,
  baseUrl,
  request: {
    name: '错误接口',
    method: 'GET',
    url: '/api/error',
    assertions: [{ type: 'status', operator: 'eq', expected: 200 }],
  },
})
check(runFail.status === 200 && runFail.body.result.ok === false, 'run-request failure detected', JSON.stringify(runFail.body.result))

// ── 4. 集合执行 → 报告 ───────────────────────────────────────────────────
console.log('\n=== 集合执行与报告 ===')
const runCollection = await api('POST', '/api/run-collection', {
  workspaceId,
  environmentId: envId,
  projectId,
  collectionId: 'col-auth',
})
check(runCollection.status === 200 && runCollection.body.ok, 'run-collection ok', JSON.stringify(runCollection.body))
const report = runCollection.body.report
check(report.summary?.total === 2 && report.summary?.passed === 2 && report.summary?.failed === 0, 'report summary all pass', JSON.stringify(report.summary))
check(report.results?.[1]?.pass === true, 'second request used extracted TOKEN', JSON.stringify(report.results?.[1]?.error))
const reportId = report.id

// 集合执行后:项目文件里每个请求记录 lastRun(缺口分析依据)
const projectAfterRun = JSON.parse(await readFile(join(workspacePath, `test-mode/api/projects/${projectId}.json`), 'utf8'))
const authRequests = projectAfterRun.collections.find((c) => c.id === 'col-auth')?.requests ?? []
check(authRequests.every((r) => r.lastRun?.pass === true && typeof r.lastRun.at === 'string'), 'requests record lastRun after collection run', JSON.stringify(authRequests.map((r) => r.lastRun)))
check(authRequests.every((r) => r.lastRun.pass === true), 'lastRun marks pass', JSON.stringify(authRequests.map((r) => r.lastRun?.pass)))

// ── 2.5 会话变量:extract export + header 提取 + cookie jar + 跨执行复用 ──
console.log('\n=== 会话变量与 cookie ===')
// 更新 req-login:extract 增加 export TOKEN + header 提取 SESSION
const projectWithExport = JSON.parse(await readFile(join(workspacePath, `test-mode/api/projects/${projectId}.json`), 'utf8'))
const authCollection = projectWithExport.collections.find((c) => c.id === 'col-auth')
const loginReq = authCollection.requests.find((r) => r.id === 'req-login')
loginReq.extract = [
  { name: 'TOKEN', path: '$.token', export: true },
  { name: 'SESSION', from: 'header', path: 'set-cookie', export: true },
]
const exportPut = await api('PUT', `/api/projects/${projectId}`, { workspaceId, ...projectWithExport })
check(exportPut.status === 200 && exportPut.body.ok, 'project with export extract accepted', JSON.stringify(exportPut.body))

// 集合执行:流内 cookie jar 生效(login set-cookie → me 带 Cookie),export 写会话
lastMeHeaders = ''
await api('POST', '/api/run-collection', { workspaceId, environmentId: envId, projectId, collectionId: 'col-auth' })
check(lastMeHeaders.includes('sid=abc123'), 'cookie jar shares set-cookie within collection run', lastMeHeaders)
const sessionFile = JSON.parse(await readFile(join(workspacePath, 'test-mode/session.json'), 'utf8'))
check(sessionFile[envId]?.TOKEN?.value === 'tok-123', 'export TOKEN written to session', JSON.stringify(sessionFile[envId]?.TOKEN))
check(sessionFile[envId]?.SESSION?.value?.includes('sid=abc123'), 'header extract SESSION written to session', JSON.stringify(sessionFile[envId]?.SESSION))

// 跨执行复用:单独执行 req-me,{{TOKEN}} 从会话解析(不经过集合的流内变量)
lastMeHeaders = ''
const meStandalone = await api('POST', '/api/run-request', {
  workspaceId, environmentId: envId, baseUrl,
  projectId, collectionId: 'col-auth',
  request: {
    id: 'req-me', name: '获取当前用户', method: 'GET', url: '/api/me',
    headers: { authorization: 'Bearer {{TOKEN}}' },
    assertions: [{ type: 'status', operator: 'eq', expected: 200 }],
  },
})
check(meStandalone.status === 200 && meStandalone.body.ok, 'standalone request ok with session token', JSON.stringify(meStandalone.body))
check(lastMeHeaders.includes('Bearer tok-123'), 'session variable reused across executions', lastMeHeaders)

// 会话查询与清除
const sessionList = await api('GET', '/api/session', undefined, { workspaceId, environmentId: envId })
check(sessionList.body.variables.some((v) => v.name === 'TOKEN' && v.environmentId === envId), 'session list returns env-scoped variables', JSON.stringify(sessionList.body.variables))
const sessionClear = await api('DELETE', `/api/session/${encodeURIComponent(envId)}`, undefined, { workspaceId })
check(sessionClear.status === 200 && sessionClear.body.ok, 'clear session', JSON.stringify(sessionClear.body))
const sessionAfterClear = await api('GET', '/api/session', undefined, { workspaceId })
check(!sessionAfterClear.body.variables.some((v) => v.environmentId === envId), 'session cleared', JSON.stringify(sessionAfterClear.body.variables))

const reports = await api('GET', '/api/reports', undefined, { workspaceId })
check(reports.status === 200 && reports.body.reports.some((r) => r.id === reportId), 'list reports', JSON.stringify(reports.body))

const reportDetail = await api('GET', `/api/reports/${reportId}`, undefined, { workspaceId })
check(reportDetail.status === 200 && reportDetail.body.report.results.length === 2, 'report detail', JSON.stringify(reportDetail.body))

// ── 4.3 报告对比 / 统计(一期/二期) ───────────────────────────────────────
console.log('\n=== 报告对比与统计 ===')
// 再跑一次集合生成同 kind+name 的第二份报告,用于 compare(与更早的一份对比)
const secondRun = await api('POST', '/api/run-collection', { workspaceId, environmentId: envId, projectId, collectionId: 'col-auth' })
const secondReportId = secondRun.body.report.id
const compareRes = await api('GET', `/api/reports/${secondReportId}/compare`, undefined, { workspaceId })
check(compareRes.status === 200 && compareRes.body.ok, 'compare ok', JSON.stringify(compareRes.body))
check(compareRes.body.hasPrevious === true && compareRes.body.previous?.id !== secondReportId, 'compare finds previous same-series report', JSON.stringify(compareRes.body.previous?.id))
check(typeof compareRes.body.diff?.failedDelta === 'number' && Array.isArray(compareRes.body.diff?.newFailures), 'compare diff structure', JSON.stringify(compareRes.body.diff))

// 接口健康度:聚合接口成功率/耗时/最近结果
const ifaceStats = await api('GET', '/api/stats/interfaces', undefined, { workspaceId })
check(ifaceStats.status === 200 && ifaceStats.body.ok, 'stats interfaces ok', JSON.stringify(ifaceStats.body))
const loginIface = ifaceStats.body.interfaces.find((i) => i.url.includes('/api/login'))
check(loginIface?.total >= 3 && loginIface?.successRate === 100, 'interface aggregated (login total/rate)', JSON.stringify(loginIface))
check(loginIface?.avgDurationMs >= 0 && loginIface?.lastPass === true, 'interface avg duration and last result', JSON.stringify(loginIface))

// 失败聚合 Top:之前有失败请求(/api/error),应出现在失败接口 Top
const failStats = await api('GET', '/api/stats/failures', undefined, { workspaceId })
check(failStats.status === 200 && failStats.body.ok, 'stats failures ok', JSON.stringify(failStats.body))
check(failStats.body.topFailedRequests?.some((r) => r.url.includes('/api/error')), 'failed request in top failures', JSON.stringify(failStats.body.topFailedRequests))

const history = await api('GET', '/api/history', undefined, { workspaceId })
check(history.status === 200 && history.body.history.length >= 3, 'history entries', JSON.stringify(history.body.history.length))

// 报告删除
const deletedReport = await api('DELETE', `/api/reports/${reportId}`, undefined, { workspaceId })
check(deletedReport.status === 200 && deletedReport.body.ok, 'delete report')

// ── 4.5 Markdown 导出(阶段 3) ────────────────────────────────────────────
console.log('\n=== Markdown 导出 ===')
// 需要一份现存报告:重新跑一次集合生成
const exportCollection = await api('POST', '/api/run-collection', {
  workspaceId,
  environmentId: envId,
  projectId,
  collectionId: 'col-auth',
})
const exportReportId = exportCollection.body.report.id
// 直接调用 api helper 的 GET,但 handler 对 export 返回 text 而非 JSON
// —— 通过原始 handler 调用验证
const exportRes = await (async () => {
  const req = { method: 'GET', url: `/dsh-test-mode/api/reports/${exportReportId}/export?format=md&workspaceId=${workspaceId}`, [Symbol.asyncIterator]: async function* () {} }
  let captured = null
  const res = { writeHead: (s, h) => { captured = { s, h } }, end: (c) => { captured.body = c } }
  await route.handler(req, res)
  return captured
})()
check(exportRes.s === 200, 'export markdown status 200', String(exportRes.s))
check(typeof exportRes.body === 'string' && exportRes.body.startsWith('# '), 'export returns markdown', String(exportRes.body).slice(0, 80))
check(exportRes.body.includes('| # | 名称 |'), 'export has table header', '')
check(exportRes.body.includes('认证'), 'export contains collection name', '')

// ── 5. 用例绑定请求执行(阶段 1:用例↔API 闭环) ──────────────────────────
console.log('\n=== 用例执行(步骤绑定请求) ===')
// 先给用例补上 requestRef 绑定(项目里已有的两个请求)
const boundCase = await api('PUT', `/api/cases/${caseId}`, {
  workspaceId,
  steps: [
    { action: '调用登录接口', expected: '返回 token', requestRef: { projectId, collectionId: 'col-auth', requestId: 'req-login' } },
    { action: '调用用户接口', expected: '返回用户信息', requestRef: { projectId, collectionId: 'col-auth', requestId: 'req-me' } },
    { action: '人工检查页面', expected: '页面正常' }, // 无绑定:跳过
  ],
})
check(boundCase.status === 200 && boundCase.body.ok, 'bind requestRef to case steps', JSON.stringify(boundCase.body))

const caseRun = await api('POST', `/api/cases/${caseId}/run`, { workspaceId, environmentId: envId })
check(caseRun.status === 200 && caseRun.body.ok, 'run-case ok', JSON.stringify(caseRun.body))
const caseReport = caseRun.body.report
check(caseReport.summary?.total === 2 && caseReport.summary?.passed === 2, 'case run executed 2 bound steps', JSON.stringify(caseReport.summary))
check(caseReport.summary?.skipped === 1, 'case run skipped unbound step', JSON.stringify(caseReport.summary))
check(caseReport.results?.[0]?.url?.includes('/api/login'), 'first step hit login API', JSON.stringify(caseReport.results?.[0]))

// 步骤级数据覆盖:step.data.body 覆盖请求配置;未提供 data 回退请求配置
const dataCase = await api('POST', '/api/cases', {
  workspaceId,
  name: '数据覆盖用例',
  steps: [
    { action: '登录(覆盖数据)', expected: '成功', requestRef: { projectId, collectionId: 'col-auth', requestId: 'req-login' }, data: { body: '{"user":"data-{{USER}}"}' } },
  ],
})
check(dataCase.status === 200 && dataCase.body.ok, 'case with step data accepted', JSON.stringify(dataCase.body))
await api('POST', `/api/cases/${dataCase.body.case.id}/run`, { workspaceId, environmentId: envId })
check(lastLoginBody.includes('data-alice'), 'step data overrides request body', lastLoginBody)
await api('POST', `/api/cases/${caseId}/run`, { workspaceId, environmentId: envId })
check(lastLoginBody.includes('"user":"alice"') && !lastLoginBody.includes('data-'), 'without step data falls back to request config', lastLoginBody)
// 非法 data 结构被保存校验拒绝
const badDataCase = await api('POST', '/api/cases', {
  workspaceId,
  name: '坏数据用例',
  steps: [{ action: 'a', expected: 'b', requestRef: { projectId, collectionId: 'col-auth', requestId: 'req-login' }, data: { body: 123 } }],
})
check(badDataCase.status === 400 && badDataCase.body.message.includes('data.body'), 'reject invalid step data', JSON.stringify(badDataCase.body))

// ── 6. 测试计划 CRUD + 执行 ─────────────────────────────────────────────
console.log('\n=== 测试计划 ===')
const createdPlan = await api('POST', '/api/plans', {
  workspaceId,
  name: '回归计划',
  entries: [
    { kind: 'case', caseId },
    { kind: 'collection', projectId, collectionId: 'col-auth' },
  ],
})
check(createdPlan.status === 200 && createdPlan.body.ok, 'create plan', JSON.stringify(createdPlan.body))
const planId = createdPlan.body.plan.id

const planList = await api('GET', '/api/plans', undefined, { workspaceId })
check(planList.status === 200 && planList.body.plans.some((p) => p.id === planId), 'list plans', JSON.stringify(planList.body))

const planRun = await api('POST', '/api/run-plan', { workspaceId, planId, environmentId: envId })
check(planRun.status === 200 && planRun.body.ok, 'run-plan ok', JSON.stringify(planRun.body))
const planReport = planRun.body.report
check(planReport.summary?.total === 4 && planReport.summary?.passed === 4, 'plan aggregates case+collection (4 steps)', JSON.stringify(planReport.summary))
check(planReport.results?.some((r) => r.kind === 'case') && planReport.results?.some((r) => r.kind === 'collection'), 'plan report mixes case and collection results', JSON.stringify(planReport.results?.map((r) => r.kind)))

// 计划创建/编辑时可绑定环境;执行时计划自带环境优先(请求体不传环境也生效)
const boundPlan = await api('POST', '/api/plans', {
  workspaceId,
  name: '带环境计划',
  environmentId: envId,
  entries: [{ kind: 'collection', projectId, collectionId: 'col-auth' }],
})
check(boundPlan.status === 200 && boundPlan.body.plan.environmentId === envId, 'create plan with environmentId', JSON.stringify(boundPlan.body))
const boundPlanId = boundPlan.body.plan.id

const rebound = await api('PUT', `/api/plans/${boundPlanId}`, { workspaceId, environmentId: '' })
check(rebound.status === 200 && rebound.body.plan.environmentId === '', 'update plan environmentId (default)', JSON.stringify(rebound.body))
const rebound2 = await api('PUT', `/api/plans/${boundPlanId}`, { workspaceId, environmentId: envId })
check(rebound2.status === 200 && rebound2.body.plan.environmentId === envId, 're-bind plan environmentId', JSON.stringify(rebound2.body))

// 不带 environmentId 执行:计划自带环境生效(mock 对未替换模板返回 500)
const boundPlanRun = await api('POST', '/api/run-plan', { workspaceId, planId: boundPlanId })
check(boundPlanRun.status === 200 && boundPlanRun.body.ok, 'run-plan uses plan-bound env', JSON.stringify(boundPlanRun.body))
check(boundPlanRun.body.report.summary?.total === 2 && boundPlanRun.body.report.summary?.passed === 2, 'plan-bound env variables applied to requests', JSON.stringify(boundPlanRun.body.report.summary))

// ── 6.5 计划高级特性:模板 / 增量 / 失败重跑 ─────────────────────────────
console.log('\n=== 计划高级特性 ===')

// 校验:incremental 的 since 必须是可解析时间
const badIncPlan = await api('POST', '/api/plans', {
  workspaceId, name: '坏增量', entries: [{ kind: 'incremental', since: 'yesterday-ish' }],
})
check(badIncPlan.status === 400 && badIncPlan.body.message.includes('since'), 'reject invalid incremental since', JSON.stringify(badIncPlan.body))

// 模板:创建 / 直接执行被拒 / PUT 取消
const templatePlan = await api('POST', '/api/plans', {
  workspaceId, name: '全量回归模板', template: true, environmentId: envId,
  entries: [{ kind: 'collection', projectId, collectionId: 'col-auth' }],
})
check(templatePlan.status === 200 && templatePlan.body.plan.template === true, 'create template plan', JSON.stringify(templatePlan.body))
const templatePlanId = templatePlan.body.plan.id
const templateRun = await api('POST', '/api/run-plan', { workspaceId, planId: templatePlanId })
check(templateRun.status === 400 && templateRun.body.message.includes('模板'), 'template plan cannot run directly', JSON.stringify(templateRun.body))
const templateOff = await api('PUT', `/api/plans/${templatePlanId}`, { workspaceId, template: false })
check(templateOff.status === 200 && templateOff.body.plan.template === undefined, 'template flag removable via PUT', JSON.stringify(templateOff.body))

// 增量:构造「版本迭代」场景(文件 mtime 判定变更)
const base = Date.now()
const dayMs = 86400000
const sinceIso = new Date(base - dayMs).toISOString()
const yesterday = new Date(base - 2 * dayMs)
// 现有全部用例/项目置为「昨天」:不属于本次迭代
for (const file of await readdir(join(workspacePath, 'test-mode/cases'))) {
  await utimes(join(workspacePath, `test-mode/cases/${file}`), yesterday, yesterday)
}
await utimes(join(workspacePath, `test-mode/api/projects/${projectId}.json`), yesterday, yesterday)
// 会话测试(4.5 节)的 PUT 给 req-login 打上了「今天」的请求级 updatedAt 戳;
// 清掉后该请求回退项目文件时间(昨天),本项目整体属于基线之前。
const projectOnDisk = JSON.parse(await readFile(join(workspacePath, `test-mode/api/projects/${projectId}.json`), 'utf8'))
for (const collection of projectOnDisk.collections ?? []) {
  for (const request of collection.requests ?? []) delete request.updatedAt
}
await writeFile(join(workspacePath, `test-mode/api/projects/${projectId}.json`), JSON.stringify(projectOnDisk, null, 2))
await utimes(join(workspacePath, `test-mode/api/projects/${projectId}.json`), yesterday, yesterday)
// 新项目(今天):重导 OpenAPI → 全部接口视为本版本变更
const incProjectId = 'inc-proj'
await writeFile(
  join(workspacePath, `test-mode/api/projects/${incProjectId}.json`),
  JSON.stringify({
    id: incProjectId,
    name: '增量服务',
    baseUrl,
    collections: [{
      id: 'inc-col',
      name: '增量集合',
      requests: [
        { id: 'inc-get', name: '增量查询', method: 'GET', url: '/api/inc', assertions: [{ type: 'status', operator: 'eq', expected: 200 }] },
        { id: 'inc-post', name: '增量创建', method: 'POST', url: '/api/inc2', assertions: [{ type: 'status', operator: 'eq', expected: 200 }] },
      ],
    }],
  }),
)
// 新用例(今天):变更用例直接纳入
await writeFile(
  join(workspacePath, 'test-mode/cases/inc-new.json'),
  JSON.stringify({ name: '增量新用例', steps: [{ action: '人工验证新页面', expected: '正常' }], tags: ['登录'] }),
)
// 旧用例(昨天)但步骤 requestRef 指向变更接口:作为覆盖用例纳入
await writeFile(
  join(workspacePath, 'test-mode/cases/inc-cover.json'),
  JSON.stringify({
    name: '增量覆盖用例',
    steps: [{ action: '调用增量接口', expected: '成功', requestRef: { projectId: incProjectId, collectionId: 'inc-col', requestId: 'inc-get' } }],
    tags: ['登录'],
  }),
)
await utimes(join(workspacePath, 'test-mode/cases/inc-cover.json'), yesterday, yesterday)
// 旧用例且不覆盖变更接口:不应纳入
await writeFile(
  join(workspacePath, 'test-mode/cases/inc-old.json'),
  JSON.stringify({ name: '无关旧用例', steps: [{ action: '人工检查', expected: '正常' }], tags: ['登录'] }),
)
await utimes(join(workspacePath, 'test-mode/cases/inc-old.json'), yesterday, yesterday)

const incPreview = await api('POST', '/api/plans/incremental-preview', { workspaceId, since: sinceIso })
check(incPreview.status === 200 && incPreview.body.ok, 'incremental preview ok', JSON.stringify(incPreview.body))
check(incPreview.body.changedRequests === 2, 'preview counts changed requests (re-imported project)', JSON.stringify(incPreview.body.changedRequests))
check(incPreview.body.changedCases === 1 && incPreview.body.coveringCases === 1, 'preview counts changed + covering cases', JSON.stringify([incPreview.body.changedCases, incPreview.body.coveringCases]))
check(incPreview.body.gaps?.length === 1 && incPreview.body.gaps[0].method === 'POST' && incPreview.body.gaps[0].path === '/api/inc2', 'preview reports gap interface without covering case', JSON.stringify(incPreview.body.gaps))
check(incPreview.body.entries?.length === 2, 'preview expands to 2 concrete entries', JSON.stringify(incPreview.body.entries))

// 增量计划执行:展开 + 快照 + 结果身份
const incPlan = await api('POST', '/api/plans', {
  workspaceId, name: '增量计划', environmentId: envId,
  entries: [{ kind: 'incremental', since: sinceIso }],
})
check(incPlan.status === 200 && incPlan.body.ok, 'create incremental plan', JSON.stringify(incPlan.body))
const incPlanId = incPlan.body.plan.id
const incRun = await api('POST', '/api/run-plan', { workspaceId, planId: incPlanId })
check(incRun.status === 200 && incRun.body.ok, 'run incremental plan', JSON.stringify(incRun.body))
const incReport = incRun.body.report
check(incReport.entriesSnapshot?.length === 2, 'plan report stores expanded entries snapshot', JSON.stringify(incReport.entriesSnapshot))
check(incReport.results?.some((r) => r.caseId === 'inc-cover'), 'plan report results carry case identity', JSON.stringify(incReport.results?.map((r) => r.caseId)))

// 自动基线:since 缺省 = 最近一次计划执行时间(此后无变更 → 空展开)
const autoPlan = await api('POST', '/api/plans', {
  workspaceId, name: '自动基线计划', environmentId: envId,
  entries: [{ kind: 'incremental' }],
})
const autoPlanId = autoPlan.body.plan.id
const autoRun = await api('POST', '/api/run-plan', { workspaceId, planId: autoPlanId })
check(autoRun.status === 200 && autoRun.body.report.summary?.total === 0, 'incremental auto baseline = latest plan run time', JSON.stringify(autoRun.body.report.summary))

// 文件钩子:坏 since 的计划文件被拦截,合法增量条目放行
await writeFile(
  join(workspacePath, 'test-mode/plans/bad-inc.json'),
  JSON.stringify({ id: 'bad-inc', name: '坏增量文件', entries: [{ kind: 'incremental', since: 'nope' }] }),
)
const badIncFile = await validateTestModeFile(workspacePath, join(workspacePath, 'test-mode/plans/bad-inc.json'))
check(badIncFile !== null && badIncFile.errors.length > 0, 'file hook rejects invalid incremental plan', JSON.stringify(badIncFile))
await writeFile(
  join(workspacePath, 'test-mode/plans/good-inc.json'),
  JSON.stringify({ id: 'good-inc', name: '好增量文件', entries: [{ kind: 'incremental' }] }),
)
const goodIncFile = await validateTestModeFile(workspacePath, join(workspacePath, 'test-mode/plans/good-inc.json'))
check(goodIncFile !== null && goodIncFile.errors.length === 0, 'file hook accepts incremental plan', JSON.stringify(goodIncFile))

// 失败重跑:只执行上次失败的条目
const failProj = await api('POST', '/api/projects', {
  workspaceId, name: '故障服务', baseUrl,
  collections: [{
    name: '故障',
    requests: [{ name: '故障接口', method: 'GET', url: '/api/error', assertions: [{ type: 'status', operator: 'eq', expected: 200 }] }],
  }],
})
check(failProj.status === 200 && failProj.body.ok, 'create failing project', JSON.stringify(failProj.body))
const failProjId = failProj.body.project.id
const failCase = await api('POST', '/api/cases', {
  workspaceId,
  name: '必败用例',
  steps: [{ action: '调用错误接口', expected: '成功', requestRef: { projectId: failProjId, collectionId: 'col-故障', requestId: 'req-故障接口' } }],
})
check(failCase.status === 200 && failCase.body.ok, 'create failing case', JSON.stringify(failCase.body))
const failCaseId = failCase.body.case.id
const retryPlan = await api('POST', '/api/plans', {
  workspaceId, name: '重跑计划', environmentId: envId,
  entries: [{ kind: 'case', caseId }, { kind: 'case', caseId: failCaseId }],
})
const retryPlanId = retryPlan.body.plan.id
const retryRun1 = await api('POST', '/api/run-plan', { workspaceId, planId: retryPlanId })
check(retryRun1.status === 200 && retryRun1.body.report.summary?.failed === 1, 'plan with failing case reports 1 failure', JSON.stringify(retryRun1.body.report.summary))
const retryRun2 = await api('POST', '/api/run-plan', { workspaceId, planId: retryPlanId, failedOnly: true })
check(retryRun2.status === 200 && retryRun2.body.report.name.includes('失败重跑'), 'failed-only run marks report name', JSON.stringify(retryRun2.body.report.name))
check(retryRun2.body.report.summary?.total === 1 && retryRun2.body.report.summary?.failed === 1, 'failed-only run executes only failed entries', JSON.stringify(retryRun2.body.report.summary))
check(retryRun2.body.report.results?.every((r) => r.caseId === failCaseId), 'failed-only run keeps case identity', JSON.stringify(retryRun2.body.report.results?.map((r) => r.caseId)))
// 全部通过时 failedOnly 拒绝
const allPassPlan = await api('POST', '/api/plans', {
  workspaceId, name: '全通过计划', environmentId: envId,
  entries: [{ kind: 'case', caseId }],
})
const allPassId = allPassPlan.body.plan.id
await api('POST', '/api/run-plan', { workspaceId, planId: allPassId })
const retryEmpty = await api('POST', '/api/run-plan', { workspaceId, planId: allPassId, failedOnly: true })
check(retryEmpty.status === 400 && retryEmpty.body.message.includes('没有失败'), 'failed-only run rejected when nothing failed', JSON.stringify(retryEmpty.body))

// ── 7. 历史详情(完整请求/响应回看) ──────────────────────────────────────
console.log('\n=== 历史详情 ===')
const historyAfter = await api('GET', '/api/history', undefined, { workspaceId })
const requestHistory = historyAfter.body.history.find((h) => h.kind === 'request' && h.detail)
check(requestHistory !== undefined, 'request history carries detail', JSON.stringify(historyAfter.body.history.length))
if (requestHistory) {
  const historyDetail = await api('GET', `/api/history/${requestHistory.id}`, undefined, { workspaceId })
  // 最近一条 request 历史是「默认环境回退」:URL 应已用默认环境变量替换
  check(historyDetail.status === 200 && historyDetail.body.entry.detail?.request?.url?.includes('u=alice'), 'history detail returns resolved request url (default env)', JSON.stringify(historyDetail.body))
  check(historyDetail.body.entry.detail?.response?.status === 404, 'history detail returns response status', JSON.stringify(historyDetail.body.entry.detail))
  // 登录请求的历史也应存在(显式指定环境)
  const loginHistory = historyAfter.body.history.find((h) => h.kind === 'request' && h.url?.includes('/api/login'))
  check(loginHistory !== undefined, 'login request history exists', JSON.stringify(historyAfter.body.history.map((h) => h.url)))
}

// ── 7.5 旧数据兼容:集合/请求无 id 时自动补齐(用户真实数据即无 id) ─────
console.log('\n=== 无 id 集合兼容 ===')
await writeFile(
  join(workspacePath, 'test-mode/api/projects/legacy-raw.json'),
  JSON.stringify({
    id: 'legacy-raw',
    name: '磁盘旧数据',
    baseUrl,
    collections: [{ name: '磁盘集合', requests: [{ name: '磁盘请求', method: 'GET', url: '/api/me' }] }],
  }),
)
const legacyList = await api('GET', '/api/projects', undefined, { workspaceId })
const legacyFromList = legacyList.body.projects.find((p) => p.id === 'legacy-raw')
check(legacyFromList?.collections?.[0]?.id === 'col-磁盘集合', 'GET derives collection id from name', JSON.stringify(legacyFromList?.collections?.[0]?.id))
check(legacyFromList?.collections?.[0]?.requests?.[0]?.id === 'req-磁盘请求', 'GET derives request id from name', legacyFromList?.collections?.[0]?.requests?.[0]?.id)
const legacyRun = await api('POST', '/api/run-collection', { workspaceId, projectId: 'legacy-raw', collectionId: '磁盘集合' })
check(legacyRun.status === 200 && legacyRun.body.ok, 'run-collection resolves legacy collection by name', JSON.stringify(legacyRun.body))
check(legacyRun.body.report.summary?.passed === 1, 'legacy collection executed', JSON.stringify(legacyRun.body.report.summary))

// ── 8. OpenAPI 导入 + 数据工厂 ───────────────────────────────────────────
console.log('\n=== OpenAPI 导入 ===')
const openapiSpec = {
  openapi: '3.0.3',
  info: { title: '订单服务', version: '1.0.0' },
  servers: [{ url: baseUrl }],
  paths: {
    '/api/orders': {
      get: { operationId: 'listOrders', tags: ['订单'], parameters: [{ name: 'page', in: 'query', example: 1 }] },
      post: { operationId: 'createOrder', tags: ['订单'], summary: '创建订单' },
    },
    '/api/orders/{id}': {
      get: { operationId: 'getOrder', tags: ['订单'] },
      delete: { operationId: 'deleteOrder', tags: ['订单'] },
    },
    '/api/health': {
      get: { operationId: 'health', summary: '健康检查' }, // 无 tag → 默认
    },
  },
}
const importResult = await api('POST', '/api/import/openapi', { workspaceId, name: '订单服务', spec: openapiSpec })
check(importResult.status === 200 && importResult.body.ok, 'import openapi ok', JSON.stringify(importResult.body))
check(importResult.body.importedCollections === 2, 'openapi grouped by tag', JSON.stringify(importResult.body.importedCollections))
check(importResult.body.importedRequests === 5, 'openapi imported 5 operations', JSON.stringify(importResult.body.importedRequests))
check(importResult.body.project.baseUrl === baseUrl, 'openapi baseUrl from servers', JSON.stringify(importResult.body.project.baseUrl))

// 拒绝非法 spec
const badImport = await api('POST', '/api/import/openapi', { workspaceId, spec: { swagger: '2.0', paths: {} } })
check(badImport.status === 400, 'openapi 2.0 rejected', JSON.stringify(badImport.body))

// ── 9. 数据工厂({{rand.*}} 动态生成) ────────────────────────────────────
console.log('\n=== 数据工厂 ===')
const randRun = await api('POST', '/api/run-request', {
  workspaceId,
  baseUrl,
  request: {
    name: '数据工厂',
    method: 'GET',
    url: '/api/health',
    assertions: [],
  },
})
// 直接调用 executeRequest 验证 rand 替换(绕开 mock 服务器)
const { executeRequest } = await import('../lib/api-test.js')
const randOutcome = await executeRequest({
  name: 'rand',
  method: 'GET',
  url: `${baseUrl}/api/health?phone={{rand.phone}}&num={{rand.number:1:9}}`,
}, {})
check(randOutcome.ok === true, 'rand request executes', JSON.stringify(randOutcome.error))
const randUrl = randOutcome.text ? '' : randOutcome.error ?? ''
// mock 服务器不回显 query,改为用 resolveRandom 直接断言格式
const { resolveRandom } = await import('../lib/api-test.js')
check(/^1[3-9]\d{9}$/.test(resolveRandom('phone')), 'rand.phone format', resolveRandom('phone'))
check(/^\d+$/.test(resolveRandom('timestamp')), 'rand.timestamp format', resolveRandom('timestamp'))
check(/^[a-z]+$/.test(resolveRandom('string:6')), 'rand.string format', resolveRandom('string:6'))
check(/^\d+$/.test(resolveRandom('number:1:9')) && Number(resolveRandom('number:1:9')) <= 9, 'rand.number bounds', resolveRandom('number:1:9'))

// ── 9b. 数据工厂用户自定义生成器(阶段 4) ────────────────────────────────
console.log('\n=== 自定义数据工厂 ===')
const createdGen = await api('POST', '/api/datafactory', {
  workspaceId,
  key: 'username',
  name: '用户名',
  pattern: 'user_{{rand.number:1000:9999}}',
  description: '测试用户名',
})
check(createdGen.status === 200 && createdGen.body.ok, 'create generator', JSON.stringify(createdGen.body))
check(createdGen.body.generator.key === 'username', 'generator key saved', createdGen.body.generator.key)

// key 冲突拒绝
const dupGen = await api('POST', '/api/datafactory', { workspaceId, key: 'username', name: 'x', pattern: 'y' })
check(dupGen.status === 400, 'duplicate key rejected', JSON.stringify(dupGen.body))

// 非法 key 拒绝
const badKey = await api('POST', '/api/datafactory', { workspaceId, key: 'UPPER case', name: 'x', pattern: 'y' })
check(badKey.status === 400, 'invalid key rejected', JSON.stringify(badKey.body))

// rand. 前缀保留
const reservedKey = await api('POST', '/api/datafactory', { workspaceId, key: 'rand.custom', name: 'x', pattern: 'y' })
check(reservedKey.status === 400, 'reserved rand. key rejected', JSON.stringify(reservedKey.body))

// 嵌套工厂生成器
const nestedGen = await api('POST', '/api/datafactory', {
  workspaceId,
  key: 'contact',
  name: '联系人',
  pattern: '{{factory.username}}@example.com',
})
check(nestedGen.status === 200, 'create nested generator', JSON.stringify(nestedGen.body))

// 列表:内置(10)+ 自定义(2)= 12,内置带 builtin 标记
const genList = await api('GET', '/api/datafactory', undefined, { workspaceId })
check(genList.status === 200 && genList.body.generators.length === 12, 'list generators (10 builtin + 2 custom)', JSON.stringify(genList.body.generators.length))
check(genList.body.generators.filter((g) => g.builtin).length === 10, 'list includes 10 builtin generators', JSON.stringify(genList.body.generators.filter((g) => g.builtin).map((g) => g.key)))

// 预览
const preview = await api('POST', '/api/datafactory/preview', { workspaceId, pattern: '{{factory.username}}', count: 3 })
check(preview.status === 200 && preview.body.samples.length === 3, 'preview samples', JSON.stringify(preview.body))
check(preview.body.samples.every((s) => /^user_\d{4}$/.test(s)), 'preview expands pattern', JSON.stringify(preview.body.samples))

// 执行链集成:请求/集合里 {{factory.xxx}} 生效
const factoryRun = await api('POST', '/api/run-request', {
  workspaceId,
  baseUrl,
  request: {
    name: '工厂请求',
    method: 'GET',
    url: '/api/health?user={{factory.username}}&contact={{factory.contact}}',
    assertions: [],
  },
})
check(factoryRun.status === 200 && factoryRun.body.ok, 'factory tokens execute in request', JSON.stringify(factoryRun.body))

// 更新生成器
const genUpdate = await api('PUT', `/api/datafactory/${createdGen.body.generator.id}`, {
  workspaceId,
  name: '用户名(改)',
  pattern: 'user_{{rand.string:6}}',
})
check(genUpdate.status === 200 && genUpdate.body.generator.name === '用户名(改)', 'update generator', JSON.stringify(genUpdate.body))

// 删除
const genDelete = await api('DELETE', `/api/datafactory/${createdGen.body.generator.id}`, undefined, { workspaceId })
check(genDelete.status === 200 && genDelete.body.ok, 'delete generator', JSON.stringify(genDelete.body))
const genListAfter = await api('GET', '/api/datafactory', undefined, { workspaceId })
check(genListAfter.body.generators.filter((g) => !g.builtin).length === 1, 'custom generator gone after delete (builtins remain)', JSON.stringify(genListAfter.body.generators.filter((g) => !g.builtin).length))

// ── 10. UI 自动化(脚本/元素 CRUD + 执行) ────────────────────────────────
console.log('\n=== UI 自动化 ===')
// 元素库 CRUD
const uiEl = await api('POST', '/api/ui/elements', { workspaceId, key: 'login-btn', selector: '#login-btn', page: '/login', description: '登录按钮' })
check(uiEl.status === 200 && uiEl.body.ok, 'create ui element', JSON.stringify(uiEl.body))
const uiElId = uiEl.body.element.id
const uiElList = await api('GET', '/api/ui/elements', undefined, { workspaceId })
check(uiElList.status === 200 && uiElList.body.elements.length === 1, 'list ui elements', JSON.stringify(uiElList.body))
const uiElBad = await api('POST', '/api/ui/elements', { workspaceId, key: 'Bad Key', selector: '#x' })
check(uiElBad.status === 400, 'invalid element key rejected', JSON.stringify(uiElBad.body))

// 脚本 CRUD
const uiScript = await api('POST', '/api/ui/scripts', { workspaceId, name: '登录流程', steps: [
  { kind: 'open', url: 'https://example.com/login' },
  { kind: 'type', element: 'login-btn', text: '{{factory.username}}' },
  { kind: 'click', element: 'login-btn' },
  { kind: 'assert_text', element: 'login-btn', expect: '登录' },
] })
check(uiScript.status === 200 && uiScript.body.ok, 'create ui script', JSON.stringify(uiScript.body))
const uiScriptId = uiScript.body.script.id
const uiScriptList = await api('GET', '/api/ui/scripts', undefined, { workspaceId })
check(uiScriptList.status === 200 && uiScriptList.body.scripts.length === 1, 'list ui scripts', JSON.stringify(uiScriptList.body))

// 执行:e2e 环境无 browser 工具,第一步(open)应失败并停止,报告落盘
const uiRun = await api('POST', '/api/ui/run', { workspaceId, scriptId: uiScriptId })
check(uiRun.status === 200 && uiRun.body.ok, 'ui run api ok', JSON.stringify(uiRun.body))
check(uiRun.body.report.summary?.total === 1, 'ui run stops at first failing step', JSON.stringify(uiRun.body.report.summary))
check(uiRun.body.report.results?.[0]?.pass === false, 'ui step fails without browser tools', JSON.stringify(uiRun.body.report.results?.[0]))
check(uiRun.body.report.kind === 'ui', 'ui report kind', uiRun.body.report.kind)
const uiReportId = uiRun.body.report.id

// 报告可查(报告 tab 可见 UI 报告)
const uiReports = await api('GET', '/api/reports', undefined, { workspaceId })
check(uiReports.body.reports.some((r) => r.id === uiReportId && r.kind === 'ui'), 'ui report in reports list', JSON.stringify(uiReports.body.reports.map((r) => r.kind)))

// 引擎通过路径(直接调 executeUiScript + mock tools)
const { executeUiScript } = await import('../lib/ui-test.js')
let mockPage = { href: 'https://example.com/login', title: '登录页' }
const mockTools = {
  execute: async ({ name, arguments: args }) => {
    if (name === 'browser_navigate') { mockPage.href = args.url; mockPage.title = '新页面'; return { isError: false, value: { ok: true } } }
    if (name === 'browser_eval') {
      const expr = args.expression
      if (expr.includes('HTMLInputElement.prototype')) return { isError: false, value: { ok: true, value: 'u123' } }
      if (expr.includes('MouseEvent')) return { isError: false, value: { ok: true, x: 1, y: 2 } }
      if (expr.includes('el.textContent')) return { isError: false, value: '登录' }
      if (expr === 'location.href') return { isError: false, value: mockPage.href }
      if (expr === 'document.title') return { isError: false, value: mockPage.title }
      return { isError: false, value: expr }
    }
    return { isError: true, content: [{ type: 'text', text: 'no tool ' + name }] }
  },
}
const mockCtx = { get: (n) => (n === 'tools' ? mockTools : undefined) }
const mockReport = await executeUiScript(mockCtx, {
  name: '登录流程',
  steps: [
    { kind: 'open', url: 'https://example.com/login' },
    { kind: 'assert_title', expect: '新页面' },
    { kind: 'type', element: 'login-btn', text: '{{factory.username}}' },
    { kind: 'click', element: 'login-btn' },
    { kind: 'assert_text', element: 'login-btn', expect: '登录' },
    { kind: 'eval', expression: "localStorage.getItem('token')", exportAs: 'UI_TOKEN' },
  ],
}, { 'login-btn': '#login-btn' }, {}, { username: 'user123' })
check(mockReport.summary?.passed === 6 && mockReport.summary?.failed === 0, 'ui engine pass path (mock tools)', JSON.stringify(mockReport.summary))
check(mockReport.exports?.UI_TOKEN !== undefined, 'ui eval exportAs produces export', JSON.stringify(mockReport.exports))

// 脚本/元素删除
const uiElDel = await api('DELETE', `/api/ui/elements/${uiElId}`, undefined, { workspaceId })
check(uiElDel.status === 200 && uiElDel.body.ok, 'delete ui element', JSON.stringify(uiElDel.body))
const uiScriptDel = await api('DELETE', `/api/ui/scripts/${uiScriptId}`, undefined, { workspaceId })
check(uiScriptDel.status === 200 && uiScriptDel.body.ok, 'delete ui script', JSON.stringify(uiScriptDel.body))

// ── 10b. 混合用例(API 步骤 + UI 步骤,闭环验证) ──────────────────────────
console.log('\n=== 混合用例(API + UI) ===')
// 重新建一个 UI 脚本和一个混合用例
const mixUiScript = await api('POST', '/api/ui/scripts', { workspaceId, name: 'UI 登录', steps: [
  { kind: 'open', url: 'https://example.com/login' },
  { kind: 'click', element: 'login-btn' },
] })
const mixUiScriptId = mixUiScript.body.script.id
const mixCase = await api('POST', '/api/cases', { workspaceId, name: '端到端登录', steps: [
  { action: 'UI 打开登录页并点击', expected: '页面可用', uiRef: { scriptId: mixUiScriptId } },
  { action: 'API 登录', expected: '返回 token', requestRef: { projectId, collectionId: 'col-auth', requestId: 'req-login' } },
  { action: '手工检查', expected: '无' }, // 跳过
] })
check(mixCase.status === 200 && mixCase.body.ok, 'create mixed case', JSON.stringify(mixCase.body))
const mixCaseId = mixCase.body.case.id

// 执行:无 browser 工具时 UI 步骤应失败(而非被跳过),API 步骤不执行(失败即停)
const mixRun = await api('POST', `/api/cases/${mixCaseId}/run`, { workspaceId, environmentId: envId })
check(mixRun.status === 200 && mixRun.body.ok, 'mixed case run ok', JSON.stringify(mixRun.body))
check(mixRun.body.report.results?.[0]?.kind === 'ui', 'first step is ui kind', JSON.stringify(mixRun.body.report.results?.[0]))
check(mixRun.body.report.results?.[0]?.pass === false, 'ui step fails without browser', JSON.stringify(mixRun.body.report.results?.[0]?.error))
check(mixRun.body.report.summary?.skipped === 1, 'manual step skipped', JSON.stringify(mixRun.body.report.summary))

// 引擎通过路径:mock tools + 直接 executeCase(验证 UI/API 混合顺序与结果)
const { executeCase } = await import('../lib/api-test.js')
let mixPage = { href: 'https://example.com/login' }
const mixTools = {
  execute: async ({ name, arguments: args }) => {
    if (name === 'browser_navigate') { mixPage.href = args.url; return { isError: false, value: { ok: true } } }
    if (name === 'browser_eval') {
      const expr = args.expression
      if (expr.includes('MouseEvent')) return { isError: false, value: { ok: true, x: 1, y: 2 } }
      if (expr === 'location.href') return { isError: false, value: mixPage.href }
      return { isError: false, value: expr }
    }
    return { isError: true, content: [{ type: 'text', text: 'no tool ' + name }] }
  },
}
const mixCtx = { get: (n) => (n === 'tools' ? mixTools : undefined) }
// 复用前面项目里的请求解析器逻辑:直接构造 resolveRef 模拟
const mixedReport = await executeCase(
  { name: '端到端', steps: [
    { action: 'UI', uiRef: { scriptId: 's1' } },
    { action: 'API', requestRef: { projectId: 'p1', collectionId: 'c1', requestId: 'r1' } },
  ] },
  async (ref) => {
    if (ref.scriptId) {
      return { kind: 'ui', script: { id: 's1', name: 'UI 登录', steps: [{ kind: 'open', url: 'https://example.com/login' }] }, elements: {} }
    }
    return {
      kind: 'request',
      request: { id: 'r1', name: '登录', method: 'POST', url: `${baseUrl}/api/login`, assertions: [{ type: 'status', operator: 'eq', expected: 200 }] },
      baseUrl,
    }
  },
  {},
  {},
  async (script, elements) => {
    // runUi 用 mock tools 执行
    const { executeUiScript } = await import('../lib/ui-test.js')
    const report = await executeUiScript(mixCtx, script, elements, {}, {})
    return { ok: report.summary.failed === 0, durationMs: report.durationMs, error: report.summary.failed ? 'ui failed' : undefined, steps: report.results }
  },
)
check(mixedReport.summary?.total === 2 && mixedReport.summary?.passed === 2, 'mixed case engine pass path', JSON.stringify(mixedReport.summary))
check(mixedReport.results?.[0]?.kind === 'ui' && mixedReport.results?.[0]?.scriptName === 'UI 登录', 'mixed first step ui', JSON.stringify(mixedReport.results?.[0]))
check(mixedReport.results?.[1]?.kind === 'request' && mixedReport.results?.[1]?.status === 200, 'mixed second step api', JSON.stringify(mixedReport.results?.[1]))

// 清理
const mixCaseDel = await api('DELETE', `/api/cases/${mixCaseId}`, undefined, { workspaceId })
check(mixCaseDel.status === 200, 'delete mixed case')
const mixUiDel = await api('DELETE', `/api/ui/scripts/${mixUiScriptId}`, undefined, { workspaceId })
check(mixUiDel.status === 200, 'delete mix ui script')

// ── 11. 用例删除 ─────────────────────────────────────────────────────────
// 清理本文件新增的用例(直接写盘的增量用例 + API 创建的失败用例),保持「删除后列表为空」断言有效
for (const name of ['inc-new', 'inc-cover', 'inc-old']) {
  await rm(join(workspacePath, `test-mode/cases/${name}.json`), { force: true })
}
if (failCase?.body?.case?.id) {
  await api('DELETE', `/api/cases/${failCase.body.case.id}`, undefined, { workspaceId })
}
const deletedCase = await api('DELETE', `/api/cases/${caseId}`, undefined, { workspaceId })
check(deletedCase.status === 200 && deletedCase.body.ok, 'delete case')
// 一并删除数据覆盖测试用例,保持"删除后列表为空"断言有效
if (dataCase?.body?.case?.id) {
  await api('DELETE', `/api/cases/${dataCase.body.case.id}`, undefined, { workspaceId })
}
const listedAfter = await api('GET', '/api/cases', undefined, { workspaceId })
check(listedAfter.body.cases.length === 0, 'case gone after delete')

// ── 5.5 保存校验:结构/枚举/引用非法时拒绝,报错含具体位置 ───────────────
console.log('\n=== 保存校验 ===')
const badPriority = await api('POST', '/api/cases', { workspaceId, name: '非法用例', priority: 'urgent', steps: [{ action: 'a', expected: 'b' }] })
check(badPriority.status === 400 && !badPriority.body.ok, 'reject invalid priority', JSON.stringify(badPriority.body))
const badStep = await api('POST', '/api/cases', { workspaceId, name: '非法用例2', steps: [{ expected: 'b' }] })
check(badStep.status === 400 && badStep.body.message.includes('steps[0].action'), 'reject step without action', JSON.stringify(badStep.body))
const badRef = await api('POST', '/api/cases', { workspaceId, name: '非法用例3', steps: [{ action: 'a', expected: 'b', requestRef: { projectId: 'nope', collectionId: 'nope', requestId: 'nope' } }] })
check(badRef.status === 400 && badRef.body.message.includes('missing resource'), 'reject fabricated requestRef', JSON.stringify(badRef.body))
const badMethod = await api('POST', '/api/projects', { workspaceId, name: '非法项目', collections: [{ name: 'c', requests: [{ name: 'r', method: 'FETCH', url: '/x' }] }] })
check(badMethod.status === 400 && badMethod.body.message.includes('.method'), 'reject invalid http method', JSON.stringify(badMethod.body))
const badAssertion = await api('POST', '/api/projects', { workspaceId, name: '非法项目2', collections: [{ name: 'c', requests: [{ name: 'r', method: 'GET', url: '/x', assertions: [{ type: 'status', operator: 'eq' }] }] }] })
check(badAssertion.status === 400 && badAssertion.body.message.includes('.expected'), 'reject assertion without expected', JSON.stringify(badAssertion.body))
const badPlan = await api('POST', '/api/plans', { workspaceId, name: '非法计划', entries: [{ kind: 'case', caseId: 'case-ghost' }] })
check(badPlan.status === 400 && badPlan.body.message.includes('missing case'), 'reject plan referencing missing case', JSON.stringify(badPlan.body))
const goodCase = await api('POST', '/api/cases', { workspaceId, name: '合法校验用例', priority: 'medium', status: 'draft', steps: [{ action: '检查', expected: '正常' }], tags: ['登录'] })
check(goodCase.status === 200 && goodCase.body.ok, 'valid case still accepted', JSON.stringify(goodCase.body))

// ── 5.6 文件写入钩子:write/edit 写 test-mode 文件后自动校验并反馈 ─────────
console.log('\n=== 文件写入自动校验 ===')
// validateTestModeFile 单元:坏用例 / 好用例 / 坏脚本 / 非相关文件 / 坏 JSON
await writeFile(join(workspacePath, 'test-mode/cases/hook-bad.json'), JSON.stringify({ name: '坏用例', steps: [{ expected: 'x' }] }))
const badVerdict = await validateTestModeFile(workspacePath, join(workspacePath, 'test-mode/cases/hook-bad.json'))
check(badVerdict !== null && badVerdict.errors.some((e) => e.includes('steps[0].action')), 'validate file rejects step without action', JSON.stringify(badVerdict))
await writeFile(join(workspacePath, 'test-mode/cases/hook-good.json'), JSON.stringify({ name: '好用例', steps: [{ action: 'a', expected: 'b' }] }))
const goodVerdict = await validateTestModeFile(workspacePath, join(workspacePath, 'test-mode/cases/hook-good.json'))
check(goodVerdict !== null && goodVerdict.errors.length === 0, 'validate file accepts valid case', JSON.stringify(goodVerdict))
await writeFile(join(workspacePath, 'test-mode/ui/scripts/hook-script.json'), JSON.stringify({ name: '坏脚本', steps: [{ kind: 'open' }] }))
const scriptVerdict = await validateTestModeFile(workspacePath, join(workspacePath, 'test-mode/ui/scripts/hook-script.json'))
check(scriptVerdict !== null && scriptVerdict.errors.some((e) => e.includes('url is required')), 'validate file rejects script missing url', JSON.stringify(scriptVerdict))
const unrelatedVerdict = await validateTestModeFile(workspacePath, join(workspacePath, 'notes.txt'))
check(unrelatedVerdict === null, 'validate file ignores unrelated paths', JSON.stringify(unrelatedVerdict))
await writeFile(join(workspacePath, 'test-mode/plans/hook-raw.json'), 'not json')
const rawVerdict = await validateTestModeFile(workspacePath, join(workspacePath, 'test-mode/plans/hook-raw.json'))
check(rawVerdict !== null && rawVerdict.errors.some((e) => e.includes('not valid JSON')), 'validate file reports invalid JSON', JSON.stringify(rawVerdict))

// tools/post-execute 集成:坏文件 block 反馈,好文件/非 test-mode 放行(waterfall 触发)
const execMock = (name, filePath) => ({ name, arguments: { file_path: filePath }, agent: { session: { header: { cwd: workspacePath } } } })
const nextDefault = async () => ({ kind: 'accept' })
const blocked = await ctx.waterfall('tools/post-execute', execMock('write', join(workspacePath, 'test-mode/cases/hook-bad.json')), { ok: true }, nextDefault)
check(blocked?.kind === 'block' && blocked.feedback?.[0]?.text?.includes('test-mode 自动校验') && blocked.feedback[0].text.includes('steps[0].action'), 'post-execute blocks invalid test-mode write', JSON.stringify(blocked))
const accepted = await ctx.waterfall('tools/post-execute', execMock('write', join(workspacePath, 'test-mode/cases/hook-good.json')), { ok: true }, nextDefault)
check(accepted?.kind === 'accept', 'post-execute accepts valid test-mode write', JSON.stringify(accepted))
const ignored = await ctx.waterfall('tools/post-execute', execMock('edit', join(workspacePath, 'notes.txt')), { ok: true }, nextDefault)
check(ignored?.kind === 'accept', 'post-execute ignores non-test-mode files', JSON.stringify(ignored))
const relAccepted = await ctx.waterfall('tools/post-execute', execMock('write', 'test-mode/cases/hook-good.json'), { ok: true }, nextDefault)
check(relAccepted?.kind === 'accept', 'post-execute resolves workspace-relative path', JSON.stringify(relAccepted))

// ── 5.7 标签库:自动种子 / 增删 / 用例打标校验 ────────────────────────────
console.log('\n=== 标签库 ===')
const tagSeed = await api('GET', '/api/tags', undefined, { workspaceId })
check(Array.isArray(tagSeed.body.tags) && tagSeed.body.tags.includes('登录'), 'tags seeded from existing cases', JSON.stringify(tagSeed.body.tags))
const tagAdd = await api('POST', '/api/tags', { workspaceId, name: '回归' })
check(tagAdd.status === 200 && tagAdd.body.tags.includes('回归'), 'add tag', JSON.stringify(tagAdd.body))
const tagDup = await api('POST', '/api/tags', { workspaceId, name: '回归' })
check(tagDup.status === 400 && tagDup.body.message.includes('already exists'), 'reject duplicate tag', JSON.stringify(tagDup.body))
const tagOut = await api('POST', '/api/cases', { workspaceId, name: '库外标签用例', steps: [{ action: 'a', expected: 'b' }], tags: ['不存在的标签'] })
check(tagOut.status === 400 && tagOut.body.message.includes('tag library'), 'reject out-of-library tag', JSON.stringify(tagOut.body))
const tagIn = await api('POST', '/api/cases', { workspaceId, name: '库内标签用例', steps: [{ action: 'a', expected: 'b' }], tags: ['登录', '回归'] })
check(tagIn.status === 200 && tagIn.body.ok, 'accept in-library tags', JSON.stringify(tagIn.body))
const tagDel = await api('DELETE', `/api/tags/${encodeURIComponent('回归')}`, undefined, { workspaceId })
check(tagDel.status === 200 && !tagDel.body.tags.includes('回归'), 'delete tag', JSON.stringify(tagDel.body))
const tagsFile = JSON.parse(await readFile(join(workspacePath, 'test-mode/tags.json'), 'utf8'))
check(Array.isArray(tagsFile.tags) && tagsFile.tags.includes('登录'), 'tags.json persisted', JSON.stringify(tagsFile.tags))
// 直接写坏 tags.json 会被文件校验拦截
await writeFile(join(workspacePath, 'test-mode/tags.json'), JSON.stringify({ tags: [1] }))
const badTagsVerdict = await validateTestModeFile(workspacePath, join(workspacePath, 'test-mode/tags.json'))
check(badTagsVerdict !== null && badTagsVerdict.errors.length > 0, 'validate file rejects bad tags.json', JSON.stringify(badTagsVerdict))
await writeFile(join(workspacePath, 'test-mode/tags.json'), JSON.stringify({ tags: ['登录', '冒烟'] }))

// ── 5.8 数据库参考数据(dbdata:导出文件解析,不直连数据库) ────────────────
console.log('\n=== 数据库参考数据 ===')
await mkdir(join(workspacePath, 'test-mode/dbdata'), { recursive: true })
await writeFile(join(workspacePath, 'test-mode/dbdata/users.csv'), 'id,name,email\n1,alice,alice@test.com\n2,bob,bob@test.com\n')
await writeFile(join(workspacePath, 'test-mode/dbdata/plugins.md'), '| id | name |\n| --- | --- |\n| 1 | 订单插件 |\n| 2 | 支付插件 |\n')
await writeFile(join(workspacePath, 'test-mode/dbdata/quoted.csv'), 'a,b\n"x,1","y""z"\n')
await writeFile(join(workspacePath, 'test-mode/dbdata/schema.md'), '# 表结构\n- users(id bigint, name text, email text)\n')
const dbdata = await api('GET', '/api/dbdata', undefined, { workspaceId })
check(dbdata.status === 200 && dbdata.body.ok, 'dbdata ok', JSON.stringify(dbdata.body))
const usersTable = dbdata.body.tables.find((t) => t.name === 'users')
check(usersTable?.format === 'csv' && usersTable.rowCount === 2 && usersTable.columns.join(',') === 'id,name,email', 'dbdata parses csv', JSON.stringify(usersTable))
const pluginsTable = dbdata.body.tables.find((t) => t.name === 'plugins')
check(pluginsTable?.format === 'md' && pluginsTable.rowCount === 2, 'dbdata parses markdown table', JSON.stringify(pluginsTable))
const quotedTable = dbdata.body.tables.find((t) => t.name === 'quoted')
check(quotedTable?.rowCount === 1 && quotedTable.sample?.[0]?.[0] === 'x,1' && quotedTable.sample[0][1] === 'y"z', 'dbdata parses quoted csv', JSON.stringify(quotedTable?.sample))
check(dbdata.body.schemaText.includes('users'), 'dbdata returns schema.md', '')
// 坏 CSV(列数不一致) → 文件写入钩子拦截
await writeFile(join(workspacePath, 'test-mode/dbdata/bad.csv'), 'a,b\n1,2,3\n')
const badCsv = await validateTestModeFile(workspacePath, join(workspacePath, 'test-mode/dbdata/bad.csv'))
check(badCsv !== null && badCsv.errors.some((e) => e.includes('columns')), 'validate file rejects ragged csv', JSON.stringify(badCsv))
// 好 CSV → 放行
const goodCsv = await validateTestModeFile(workspacePath, join(workspacePath, 'test-mode/dbdata/users.csv'))
check(goodCsv !== null && goodCsv.errors.length === 0, 'validate file accepts csv', JSON.stringify(goodCsv))

// ── 5.9 迭代增量:请求级打戳 / OpenAPI diff 变更清单 / 元素反查 / dependsOn / 模块 ──
console.log('\n=== 迭代增量(请求级 + 变更清单 + 依赖反查) ===')
const nowMs = Date.now()
const sinceOld = new Date(nowMs - 7 * dayMs).toISOString() // 一周前:覆盖全部变更
const ancient = new Date(nowMs - 10 * dayMs) // 十天内无变更:用于「排除」夹具

// 1) PUT 打戳:只改 req-me,req-login 不受影响
const meProject = await api('GET', `/api/projects/${projectId}`, undefined, { workspaceId })
const stampPut = await api('PUT', `/api/projects/${projectId}`, {
  workspaceId,
  name: meProject.body.project.name,
  baseUrl: meProject.body.project.baseUrl,
  collections: meProject.body.project.collections.map((c) => ({
    ...c,
    requests: c.requests.map((r) => (r.id === 'req-me' ? { ...r, body: '{"only":"me"}' } : r)),
  })),
})
check(stampPut.status === 200 && stampPut.body.ok, 'project PUT with modified request ok', JSON.stringify(stampPut.body))
const stampCheck = await api('GET', `/api/projects/${projectId}`, undefined, { workspaceId })
const stampCol = stampCheck.body.project.collections.find((c) => (c.id ?? c.name) === 'col-auth')
const stampMe = stampCol.requests.find((r) => (r.id ?? r.name) === 'req-me')
const stampLogin = stampCol.requests.find((r) => (r.id ?? r.name) === 'req-login')
check(typeof stampMe.updatedAt === 'string', 'request-level updatedAt stamped on modified request', JSON.stringify(stampMe.updatedAt))
check(stampLogin.updatedAt === undefined, 'unchanged request keeps no updatedAt', JSON.stringify(stampLogin.updatedAt))

// 2) OpenAPI diff:同名项目更新式导入,产出 added/modified/removed 变更清单
const specV2 = {
  openapi: '3.0.3',
  info: { title: '订单服务', version: '2.0.0' },
  servers: [{ url: baseUrl }],
  paths: {
    '/api/orders': {
      get: { operationId: 'listOrders', tags: ['订单'] }, // modified(parameters 移除)
      post: { operationId: 'createOrder', tags: ['订单'], parameters: [{ name: 'trace', in: 'query', example: '1' }] }, // modified(query 增加)
    },
    '/api/orders/{id}': { get: { operationId: 'getOrder', tags: ['订单'] } }, // 不变
    '/api/health': { get: { operationId: 'health' } }, // 不变
    '/api/export': { get: { operationId: 'exportOrders', tags: ['订单'] } }, // added
    // DELETE /api/orders/{id} 已移除
  },
}
const importV2 = await api('POST', '/api/import/openapi', { workspaceId, name: '订单服务', spec: specV2 })
check(importV2.status === 200 && importV2.body.updated === true, 'same-name import updates project in place', JSON.stringify(importV2.body.updated))
check(importV2.body.project.id === importResult.body.project.id, 'update import keeps project id', JSON.stringify(importV2.body.project.id))
const diffChanges = importV2.body.diff ?? []
const diffLabel = diffChanges.map((c) => `${c.change} ${c.method} ${c.url}`).sort().join('|')
check(diffLabel.includes('added GET /api/export') && diffLabel.includes('modified POST /api/orders') && diffLabel.includes('removed DELETE /api/orders/{id}'), 'openapi diff reports added/modified/removed', diffLabel)
const changelogList = await api('GET', '/api/changelogs', undefined, { workspaceId })
check(changelogList.status === 200 && changelogList.body.changelogs?.some((c) => c.source === 'openapi-diff' && (c.changedRequests?.length ?? 0) >= 3), 'changelog persisted with diff entries', JSON.stringify(changelogList.body.changelogs?.map((c) => c.source)))

// 3) 变更清单进入增量展开(removed 仅计数,不产生覆盖/缺口)
const diffPreview = await api('POST', '/api/plans/incremental-preview', { workspaceId, since: sinceOld })
check(diffPreview.status === 200 && diffPreview.body.fromChangelog >= 1, 'incremental preview consumes changelogs', JSON.stringify(diffPreview.body.fromChangelog))
check(diffPreview.body.changedRequests >= 3, 'incremental merges changelog requests', JSON.stringify(diffPreview.body.changedRequests))
check(!diffPreview.body.gaps.some((g) => g.url.includes('/api/orders') && g.change === 'removed'), 'removed requests excluded from gaps', JSON.stringify(diffPreview.body.gaps))

// 4) 变更清单文件钩子:坏结构拒绝,好结构放行
await writeFile(join(workspacePath, 'test-mode/changelogs/bad-cl.json'), JSON.stringify({ id: 'bad-cl', createdAt: 'nope', changedRequests: [{ method: 1 }] }))
const badCl = await validateTestModeFile(workspacePath, join(workspacePath, 'test-mode/changelogs/bad-cl.json'))
check(badCl !== null && badCl.errors.length > 0, 'file hook rejects invalid changelog', JSON.stringify(badCl))
await writeFile(join(workspacePath, 'test-mode/changelogs/good-cl.json'), JSON.stringify({ id: 'good-cl', createdAt: new Date().toISOString(), changedRequests: [{ method: 'GET', url: '/api/x', change: 'added' }], modules: ['登录'] }))
const goodCl = await validateTestModeFile(workspacePath, join(workspacePath, 'test-mode/changelogs/good-cl.json'))
check(goodCl !== null && goodCl.errors.length === 0, 'file hook accepts valid changelog', JSON.stringify(goodCl))

// 5) 元素→脚本反查:变更元素的引用脚本纳入增量,无关脚本不纳入
for (const file of await readdir(join(workspacePath, 'test-mode/ui/scripts'))) {
  await utimes(join(workspacePath, `test-mode/ui/scripts/${file}`), ancient, ancient)
}
await writeFile(join(workspacePath, 'test-mode/ui/elements.json'), JSON.stringify({ elements: [
  { id: 'el1', key: 'login-btn', selector: '#login', updatedAt: new Date(nowMs).toISOString() },
  { id: 'el2', key: 'old-btn', selector: '#old', updatedAt: ancient.toISOString() },
] }))
await writeFile(join(workspacePath, 'test-mode/ui/scripts/affected.json'), JSON.stringify({ id: 'affected', name: '受影响的脚本', steps: [{ kind: 'click', element: 'login-btn' }] }))
await writeFile(join(workspacePath, 'test-mode/ui/scripts/untouched.json'), JSON.stringify({ id: 'untouched', name: '不受影响的脚本', steps: [{ kind: 'click', element: 'old-btn' }] }))
await utimes(join(workspacePath, 'test-mode/ui/scripts/untouched.json'), ancient, ancient)
const uiPreview = await api('POST', '/api/plans/incremental-preview', { workspaceId, since: sinceOld })
check(uiPreview.body.affectedScripts >= 1, 'incremental counts element-affected scripts', JSON.stringify(uiPreview.body.affectedScripts))
check(uiPreview.body.entries.some((e) => e.kind === 'ui' && e.scriptId === 'affected'), 'element-affected script included as ui entry', JSON.stringify(uiPreview.body.entries))
check(!uiPreview.body.entries.some((e) => e.kind === 'ui' && e.scriptId === 'untouched'), 'unaffected script excluded from incremental', JSON.stringify(uiPreview.body.entries))

// 6) dependsOn 表依赖:dbdata 表变更 → 声明依赖的用例纳入
const badDepends = await api('POST', '/api/cases', { workspaceId, name: '坏依赖用例', dependsOn: [1], steps: [{ action: 'a', expected: 'b' }] })
check(badDepends.status === 400 && badDepends.body.message.includes('dependsOn'), 'reject invalid dependsOn', JSON.stringify(badDepends.body))
const dependsCase = await api('POST', '/api/cases', { workspaceId, name: '依赖表用例', dependsOn: ['users'], steps: [{ action: '核对用户数据', expected: '正常' }] })
check(dependsCase.status === 200 && dependsCase.body.ok, 'create case with dependsOn', JSON.stringify(dependsCase.body))
const tablePreview = await api('POST', '/api/plans/incremental-preview', { workspaceId, since: sinceOld })
check(tablePreview.body.tableCases >= 1 && tablePreview.body.entries.some((e) => e.caseId === dependsCase.body.case.id), 'dependsOn table change pulls case into incremental', JSON.stringify([tablePreview.body.tableCases, dependsCase.body.case.id]))

// 7) 模块声明:增量条目 modules → 按标签命中用例
const moduleCase = await api('POST', '/api/cases', { workspaceId, name: '模块声明用例', tags: ['登录'], steps: [{ action: '登录冒烟', expected: 'ok' }] })
const badModules = await api('POST', '/api/plans', { workspaceId, name: '坏模块计划', entries: [{ kind: 'incremental', modules: [1] }] })
check(badModules.status === 400 && badModules.body.message.includes('modules'), 'reject invalid incremental modules', JSON.stringify(badModules.body))
const modulePreview = await api('POST', '/api/plans/incremental-preview', { workspaceId, since: sinceOld, modules: ['登录'] })
check(modulePreview.body.moduleCases >= 1 && modulePreview.body.entries.some((e) => e.caseId === moduleCase.body.case.id), 'incremental modules expand tagged cases', JSON.stringify(modulePreview.body.moduleCases))

// ── 5.10 自动提交:test-mode 写盘校验通过后自动 git commit ─────────────────
console.log('\n=== 自动提交 ===')
const gitWs = join(tmpdir(), `test-mode-git-ws-${Date.now()}`)
await mkdir(join(gitWs, 'test-mode', 'cases'), { recursive: true })
const git = (args) => execFileSync('git', args, { cwd: gitWs, encoding: 'utf8' })
git(['init', '-q'])
git(['config', 'user.email', 'test@local'])
git(['config', 'user.name', 'test'])
await writeFile(join(gitWs, 'notes.txt'), 'v1\n')
git(['add', '.'])
git(['commit', '-q', '-m', 'init'])
// 仓库里另有两类无关内容:未提交的修改 + 已暂存的其它文件(都不应被自动提交带走)
await writeFile(join(gitWs, 'notes.txt'), 'v2\n')
await writeFile(join(gitWs, 'other.txt'), 'staged\n')
git(['add', 'other.txt'])

const gitExecMock = (name, filePath) => ({ name, arguments: { file_path: filePath }, agent: { session: { header: { cwd: gitWs } } } })
// 合法 test-mode 写入 → 放行 + 产生提交,且提交只含 test-mode 路径
await writeFile(join(gitWs, 'test-mode/cases/auto-ok.json'), JSON.stringify({ name: '自动提交用例', steps: [{ action: 'a', expected: 'b' }], tags: [], status: 'active' }))
const autoAccepted = await ctx.waterfall('tools/post-execute', gitExecMock('write', join(gitWs, 'test-mode/cases/auto-ok.json')), { ok: true }, nextDefault)
check(autoAccepted?.kind === 'accept', 'auto-commit hook accepts valid write', JSON.stringify(autoAccepted))
const lastCommit = git(['log', '-1', '--format=%s'])
check(lastCommit.startsWith('test-mode: '), 'auto-commit created a commit', lastCommit.trim())
const commitFiles = git(['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').filter(Boolean)
check(commitFiles.length === 1 && commitFiles[0] === 'test-mode/cases/auto-ok.json', 'auto-commit contains only the test-mode path', commitFiles.join(','))
const statusAfterCommit = git(['status', '--porcelain'])
check(statusAfterCommit.includes('other.txt'), 'unrelated staged file left untouched', statusAfterCommit.trim())
check(!statusAfterCommit.includes('test-mode'), 'test-mode changes fully committed', statusAfterCommit.trim())
// 非法 test-mode 写入 → block,不产生提交
const headBeforeBad = git(['rev-parse', 'HEAD'])
await writeFile(join(gitWs, 'test-mode/cases/auto-bad.json'), JSON.stringify({ name: 'x', steps: [{ expected: 'b' }] }))
const autoBlocked = await ctx.waterfall('tools/post-execute', gitExecMock('write', join(gitWs, 'test-mode/cases/auto-bad.json')), { ok: true }, nextDefault)
check(autoBlocked?.kind === 'block', 'auto-commit hook blocks invalid write', JSON.stringify(autoBlocked))
check(git(['rev-parse', 'HEAD']) === headBeforeBad, 'invalid write produces no commit', '')
// 非 test-mode 写入 → 放行且不提交
await writeFile(join(gitWs, 'notes.txt'), 'v3\n')
const autoIgnored = await ctx.waterfall('tools/post-execute', gitExecMock('edit', join(gitWs, 'notes.txt')), { ok: true }, nextDefault)
check(autoIgnored?.kind === 'accept', 'auto-commit hook ignores non-test-mode write', JSON.stringify(autoIgnored))
check(git(['rev-parse', 'HEAD']) === headBeforeBad, 'non-test-mode write produces no commit', '')
// 无变更的重复写入 → 不产生空提交;且被拦截的坏文件不会被下一次提交扫走
await writeFile(join(gitWs, 'test-mode/cases/auto-ok.json'), JSON.stringify({ name: '自动提交用例', steps: [{ action: 'a', expected: 'b' }], tags: [], status: 'active' }))
const headBeforeNoop = git(['rev-parse', 'HEAD'])
await ctx.waterfall('tools/post-execute', gitExecMock('write', join(gitWs, 'test-mode/cases/auto-ok.json')), { ok: true }, nextDefault)
check(git(['rev-parse', 'HEAD']) === headBeforeNoop, 'identical rewrite produces no empty commit', '')
const statusAfterNoop = git(['status', '--porcelain'])
check(statusAfterNoop.includes('auto-bad.json'), 'blocked invalid file never swept into commits', statusAfterNoop.trim())
await rm(gitWs, { recursive: true, force: true })

// ── 5.11 客户端 manifest 契约:基线包不得声明(新版 DSH 删除了 client-runtime) ──
console.log('\n=== 客户端 manifest 契约 ===')
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const clientInject = pkg.dsh?.client?.inject ?? []
check(Array.isArray(clientInject) && clientInject.includes('@deepseek-ai/dsh-client-ui-conversation'), 'client.inject 声明会话视图所属包', JSON.stringify(clientInject))
check(!clientInject.includes('@deepseek-ai/dsh-client-runtime'), 'client.inject 不再声明已移除的基线包 dsh-client-runtime', JSON.stringify(clientInject))
check(['@deepseek-ai/dsh-client-ui-renderer', '@deepseek-ai/dsh-client-ui-session', '@deepseek-ai/dsh-client-ui-workspace'].every((name) => clientInject.includes(name)), 'client.inject 声明服务提供包(renderer/session/workspace)', JSON.stringify(clientInject))
check(Object.values(pkg.peerDependencies ?? {}).filter((range) => String(range).includes('dsh-client')).every((range) => String(range).includes('0.1.7-rc.2')), '客户端 peer 范围对齐当前契约(>=0.1.7-rc.2)', JSON.stringify(pkg.peerDependencies))
check(!Object.keys(pkg.peerDependencies ?? {}).includes('@deepseek-ai/dsh-client-runtime'), 'peerDependencies 不再声明已移除的基线包', JSON.stringify(Object.keys(pkg.peerDependencies ?? {})))
const clientBundleSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
check(clientBundleSource.includes('slots.inject("conversation.view"'), '客户端注册经 slots.inject 绑定槽位声明', '')
check(clientBundleSource.includes('projections?.faceOf?.("agentPreset")'), '会话模式按宿主投影 agentPreset 判定', '')
check(clientBundleSource.includes('useProjection?.("agentPreset")'), '组件内门控使用 useProjection 投影', '')

// ── 6. 落盘检查 ──────────────────────────────────────────────────────────
const diskFiles = await readdir(join(workspacePath, 'test-mode'), { recursive: true })
console.log('\n=== 落盘 ===')
console.log('  files:', diskFiles.filter((f) => typeof f === 'string').join(', '))

// 清理
await fiber.dispose()
await ctx.fiber.dispose()
mock.close()
await rm(workspacePath, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
