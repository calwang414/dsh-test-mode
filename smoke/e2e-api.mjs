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
import { existsSync, readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * 解析 harness 包根(node_modules 目录):优先 DSH_HARNESS_ROOT,再探测常见安装位置。
 * 桌面版把 harness 打进 app.asar 后 shell 不可读,因此找不到时明确跳过而不是崩溃。
 * @returns node_modules 绝对路径或 null。
 */
function resolveHarnessRoot() {
  const candidates = []
  if (process.env.DSH_HARNESS_ROOT) candidates.push(process.env.DSH_HARNESS_ROOT)
  candidates.push('/Applications/DeepSeek Harness.app/Contents/Resources/resources/harness/node_modules')
  candidates.push(join(here, '../../../node_modules'))
  const npxRoot = join(process.env.HOME ?? '', '.npm/_npx')
  if (existsSync(npxRoot)) {
    for (const dir of readdirSync(npxRoot)) candidates.push(join(npxRoot, dir, 'node_modules'))
  }
  return candidates.find((root) => existsSync(join(root, '@deepseek-ai/cordis/lib/index.js'))) ?? null
}

const HARNESS_ROOT = resolveHarnessRoot()
if (HARNESS_ROOT === null) {
  console.log('SKIP: 未找到 harness 包根;设置 DSH_HARNESS_ROOT=<含 @deepseek-ai/* 的 node_modules> 后重跑')
  process.exit(0)
}
const { Context } = await import(pathToFileURL(join(HARNESS_ROOT, '@deepseek-ai/cordis/lib/index.js')).href)
const { SystemPrompt } = await import(pathToFileURL(join(HARNESS_ROOT, '@deepseek-ai/dsh-system-prompt/lib/index.js')).href)
const { ToolRuntime } = await import(pathToFileURL(join(HARNESS_ROOT, '@deepseek-ai/dsh-tools/lib/index.js')).href)

import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
  if (req.url.startsWith('/api/echo')) {
    req.on('data', () => {})
    req.on('end', () => {
      const parsed = new URL(req.url, 'http://localhost')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ code: 0, query: Object.fromEntries(parsed.searchParams) }))
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
  if (req.url === '/ui/login') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>登录页</title></head><body>
      <h1>登录</h1>
      <input id="username" name="username" placeholder="用户名" />
      <button id="login-btn" data-testid="login-submit">登录</button>
      <button id="reset-btn" type="button">重置</button>
      <div id="result"></div>
      <script>
        document.getElementById('login-btn').addEventListener('click', () => {
          document.getElementById('result').textContent = '欢迎 ' + (document.getElementById('username').value || '访客');
          location.hash = '#done';
        });
        document.getElementById('reset-btn').addEventListener('click', () => { document.getElementById('result').textContent = '' });
      </script>
    </body></html>`)
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

// 通过的接口:不保存测试数据(不写历史),只更新接口状态与累计计数,并把通过时的请求模板存入接口配置。
const historyAfterPass = await api('GET', '/api/history', undefined, { workspaceId })
check(!historyAfterPass.body.history.some((h) => h.kind === 'request' && h.url?.includes('/api/login')), 'passing request not recorded in history', JSON.stringify(historyAfterPass.body.history.map((h) => h.url)))
const projectsAfterPass = await api('GET', '/api/projects', undefined, { workspaceId })
const loginRequestConfig = projectsAfterPass.body.projects
  .find((project) => project.id === projectId)?.collections
  ?.find((collection) => (collection.id ?? collection.name) === 'col-auth')?.requests
  ?.find((request) => request.id === 'req-login')
check(loginRequestConfig?.lastRun?.pass === true && loginRequestConfig?.stats?.passed >= 1, 'passing run updates interface status and counters', JSON.stringify(loginRequestConfig?.lastRun))
check(loginRequestConfig?.lastPassed?.request?.url === '/api/login' && loginRequestConfig?.lastPassed?.request?.method === 'POST', 'passing run stores request template in interface config', JSON.stringify(loginRequestConfig?.lastPassed?.request))
check(loginRequestConfig?.lastPassed?.request?.body === '{"user":"{{USER}}"}' && JSON.stringify(loginRequestConfig?.lastPassed?.request?.headers) === JSON.stringify({ 'content-type': 'application/json' }), 'lastPassed keeps raw template fields', JSON.stringify(loginRequestConfig?.lastPassed?.request))

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
check(reportDetail.status === 200 && reportDetail.body.report.summary?.total === 2, 'report detail summary', JSON.stringify(reportDetail.body.report?.summary))
check(reportDetail.body.report.results === undefined && Array.isArray(reportDetail.body.report.failedEntries), 'report detail stores no process detail (statistics only)', JSON.stringify(Object.keys(reportDetail.body.report ?? {})))

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
check(loginIface?.total >= 1 && loginIface?.successRate === 100, 'interface aggregated from request history (login total/rate)', JSON.stringify(loginIface))
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
check(exportRes.body.includes('- 通过率:'), 'export contains pass rate line', '')
check(exportRes.body.includes('认证'), 'export contains collection name', '')

// ── 4.6 报告体积治理(只存统计 + 失败项;旧报告按需压缩) ──────────────────
console.log('\n=== 报告体积治理 ===')
{
  const { compactReport, saveReport } = await import('../lib/reports.js')
  const reportsRoot = join(workspacePath, 'test-mode')
  const huge = Array.from({ length: 50000 }, (_, i) => ({ id: i, name: `row-${i}`, sqlText: 'SELECT '.repeat(20) }))

  // 1) 存储格式:结果只保留统计 + 失败项,过程明细(断言/响应体)一律丢弃
  const synthetic = {
    id: 'report-synthetic-big', kind: 'collection', name: '大报告', createdAt: new Date().toISOString(),
    durationMs: 1, summary: { total: 2, passed: 1, failed: 1 },
    results: [
      { name: '列表', method: 'POST', url: '/list', pass: true, status: 200, assertions: [{ pass: true, actual: huge, expected: 'x' }] },
      { name: '详情', method: 'GET', url: '/detail', pass: false, status: 500, error: 'boom', assertions: [{ pass: false, type: 'status', expected: 200, actual: huge }] },
    ],
  }
  const stored = compactReport(synthetic)
  check(stored.results === undefined && !('entriesSnapshot' in stored), 'compactReport drops process detail', JSON.stringify(Object.keys(stored)))
  check(stored.failedEntries?.length === 1 && stored.failedEntries[0].label === '详情', 'compactReport keeps failure entries', JSON.stringify(stored.failedEntries))
  check(JSON.stringify(stored).length < 5000, 'compactReport body is tiny even with huge actuals', String(JSON.stringify(stored).length))
  await saveReport(reportsRoot, synthetic)
  const syntheticStat = await stat(join(reportsRoot, 'reports', 'report-synthetic-big.json'))
  check(syntheticStat.size < 10000, 'report body on disk stays tiny', String(syntheticStat.size))

  // 2) 列表:摘要即可,不含明细
  const listed = await api('GET', '/api/reports', undefined, { workspaceId })
  const savedSummary = listed.body.reports.find((r) => r.id === 'report-synthetic-big')
  check(savedSummary !== undefined && savedSummary.results === undefined, 'report list returns summaries', JSON.stringify(Object.keys(savedSummary ?? {})))
  check(savedSummary?.summary?.failed === 1 && savedSummary?.failedCount === 1, 'report summary and failed count exposed', JSON.stringify(savedSummary))

  // 3) 旧报告(旧格式、体积大):列表给 stub 不解析正文;单份详情按需压缩
  const legacyId = 'report-legacy-huge'
  const legacyBody = {
    id: legacyId, kind: 'collection', name: '旧大报告', createdAt: new Date().toISOString(),
    durationMs: 1, summary: { total: 1, passed: 1, failed: 0 },
    results: [{ name: '列表', method: 'POST', url: '/list', pass: true, status: 200, assertions: [{ pass: true, actual: huge, expected: 'x' }] }],
  }
  await writeFile(join(reportsRoot, 'reports', `${legacyId}.json`), JSON.stringify(legacyBody))
  const listedLegacy = await api('GET', '/api/reports', undefined, { workspaceId })
  const legacySummary = listedLegacy.body.reports.find((r) => r.id === legacyId)
  check(legacySummary?.legacy === true && String(legacySummary?.name ?? '').includes('旧报告'), 'legacy report listed as stub without parsing body', JSON.stringify(legacySummary))
  check(JSON.stringify(listedLegacy.body).length < 200000, 'reports list payload bounded with legacy stubs', String(JSON.stringify(listedLegacy.body).length))
  const legacyView = await api('GET', `/api/reports/${legacyId}`, undefined, { workspaceId })
  check(legacyView.status === 200 && legacyView.body.trimmed === true, 'legacy report detail compacted on demand', JSON.stringify({ status: legacyView.status, trimmed: legacyView.body.trimmed }))
  check(legacyView.body.report.results === undefined && JSON.stringify(legacyView.body.report).length < 200000, 'compacted detail payload bounded', String(JSON.stringify(legacyView.body.report ?? {}).length))

  // 4) 整理旧报告:压缩正文 + 回收空间
  const migrated = await api('POST', '/api/reports/migrate-legacy', { workspaceId })
  check(migrated.status === 200 && migrated.body.ok && migrated.body.trimmed >= 1, 'migrate legacy reports', JSON.stringify(migrated.body))
  const legacyStatAfter = await stat(join(reportsRoot, 'reports', `${legacyId}.json`))
  check(legacyStatAfter.size < 10000, 'legacy report body shrinks after migration', String(legacyStatAfter.size))
  const listedAfterMigrate = await api('GET', '/api/reports', undefined, { workspaceId })
  const migratedSummary = listedAfterMigrate.body.reports.find((r) => r.id === legacyId)
  check(migratedSummary?.legacy !== true && migratedSummary?.name === '旧大报告', 'migrated report gains proper summary', JSON.stringify(migratedSummary))
}

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

// 测试工作项字段:类型/优先级/关联需求/自动化状态/结果/关联缺陷
const workItemUpdate = await api('PUT', `/api/cases/${caseId}`, {
  workspaceId, type: 'e2e', priority: 'high', requirement: 'REQ-登录-001',
  automation: 'auto', result: 'not_run', defects: ['#473', 'https://github.com/calwang414/go-vue3/issues/474'],
})
check(workItemUpdate.status === 200 && workItemUpdate.body.case.type === 'e2e' && workItemUpdate.body.case.requirement === 'REQ-登录-001', 'update case work item fields', JSON.stringify(workItemUpdate.body.case?.type))
const workItemGet = await api('GET', `/api/cases/${caseId}`, undefined, { workspaceId })
check(workItemGet.body.case?.automation === 'auto' && workItemGet.body.case?.result === 'not_run' && workItemGet.body.case?.defects?.length === 2, 'case returns work item fields', JSON.stringify({ automation: workItemGet.body.case?.automation, defects: workItemGet.body.case?.defects }))
const badType = await api('PUT', `/api/cases/${caseId}`, { workspaceId, type: 'smoke' })
check(badType.status === 400 && badType.body.message.includes('invalid type'), 'reject invalid work item type', JSON.stringify(badType.body))
const badResult = await api('PUT', `/api/cases/${caseId}`, { workspaceId, result: 'ok' })
check(badResult.status === 400 && badResult.body.message.includes('invalid result'), 'reject invalid work item result', JSON.stringify(badResult.body))
const badDefects = await api('PUT', `/api/cases/${caseId}`, { workspaceId, defects: [1] })
check(badDefects.status === 400 && badDefects.body.message.includes('defects[0]'), 'reject invalid defect refs', JSON.stringify(badDefects.body))
const defaultItem = await api('POST', '/api/cases', { workspaceId, name: '默认工作项' })
check(defaultItem.body.case?.type === 'functional' && defaultItem.body.case?.automation === 'manual' && defaultItem.body.case?.result === 'not_run', 'new work item defaults', JSON.stringify({ type: defaultItem.body.case?.type, automation: defaultItem.body.case?.automation, result: defaultItem.body.case?.result }))
await api('DELETE', `/api/cases/${defaultItem.body.case.id}`, undefined, { workspaceId })

const caseRun = await api('POST', `/api/cases/${caseId}/run`, { workspaceId, environmentId: envId })
check(caseRun.status === 200 && caseRun.body.ok, 'run-case ok', JSON.stringify(caseRun.body))
const caseReport = caseRun.body.result
check(caseRun.body.mode === 'legacy', 'legacy case runs in legacy mode', JSON.stringify(caseRun.body.mode))
check(caseReport.summary?.total === 2 && caseReport.summary?.passed === 2, 'case run executed 2 bound steps', JSON.stringify(caseReport.summary))
check(caseReport.summary?.skipped === 1, 'case run skipped unbound step', JSON.stringify(caseReport.summary))
check(caseReport.results?.[0]?.url?.includes('/api/login'), 'first step hit login API', JSON.stringify(caseReport.results?.[0]))
const caseAfterRun = await api('GET', `/api/cases/${caseId}`, undefined, { workspaceId })
check(caseAfterRun.body.case?.result === 'passed' && typeof caseAfterRun.body.case?.resultAt === 'string', 'case run writes work item result', JSON.stringify({ result: caseAfterRun.body.case?.result }))
const caseRunReports = await api('GET', '/api/reports', undefined, { workspaceId })
check(!caseRunReports.body.reports.some((report) => report.kind === 'case'), 'case run saves no report (execution only)', JSON.stringify(caseRunReports.body.reports.map((report) => report.kind)))

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

// ── 7. 历史详情(完整请求/响应回看) ──────────────────────────────────────
console.log('\n=== 历史详情 ===')
const historyAfter = await api('GET', '/api/history', undefined, { workspaceId })
const requestHistory = historyAfter.body.history.find((h) => h.kind === 'request')
check(requestHistory !== undefined && requestHistory.detail === undefined, 'request history stores result only (no process detail)', JSON.stringify(requestHistory))
if (requestHistory) {
  const historyDetail = await api('GET', `/api/history/${requestHistory.id}`, undefined, { workspaceId })
  check(historyDetail.status === 200 && historyDetail.body.entry.detail === undefined, 'history detail returns result without process detail', JSON.stringify(Object.keys(historyDetail.body.entry ?? {})))
  check(typeof historyDetail.body.entry?.url === 'string' && typeof historyDetail.body.entry?.pass === 'boolean', 'history entry keeps resolved url and result', JSON.stringify(historyDetail.body.entry))
  const requestHistoryEntries = historyAfter.body.history.filter((h) => h.kind === 'request')
  check(requestHistoryEntries.length > 0 && requestHistoryEntries.every((h) => h.pass === false), 'history records failed requests only', JSON.stringify(requestHistoryEntries.map((h) => [h.url, h.pass])))
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

// ── 10. UI 自动化(脚本/元素 CRUD + Playwright 执行) ────────────────────
console.log('\n=== UI 自动化 ===')
const uiPage = `${baseUrl}/ui/login`
// 元素库 CRUD
const uiEl = await api('POST', '/api/ui/elements', { workspaceId, key: 'login-btn', selector: '[data-testid="login-submit"]', page: '/ui/login', description: '登录按钮' })
check(uiEl.status === 200 && uiEl.body.ok, 'create ui element', JSON.stringify(uiEl.body))
const uiElId = uiEl.body.element.id
await api('POST', '/api/ui/elements', { workspaceId, key: 'login-user', selector: '#username', page: '/ui/login', description: '用户名' })
await api('POST', '/api/ui/elements', { workspaceId, key: 'login-result', selector: '#result', page: '/ui/login', description: '结果区' })
const uiElTemp = await api('POST', '/api/ui/elements', { workspaceId, key: 'tmp-del', selector: '#tmp-del', page: '/ui/login', description: '临时元素' })
const uiElList = await api('GET', '/api/ui/elements', undefined, { workspaceId })
check(uiElList.status === 200 && uiElList.body.elements.length === 4, 'list ui elements', JSON.stringify(uiElList.body.elements.length))
const uiElBad = await api('POST', '/api/ui/elements', { workspaceId, key: 'Bad Key', selector: '#x' })
check(uiElBad.status === 400, 'invalid element key rejected', JSON.stringify(uiElBad.body))

// 脚本 CRUD
const uiScript = await api('POST', '/api/ui/scripts', { workspaceId, name: '登录流程', steps: [
  { kind: 'open', url: uiPage, name: '打开登录页' },
  { kind: 'assert_title', expect: '登录页' },
  { kind: 'type', element: 'login-user', text: 'alice' },
  { kind: 'click', element: 'login-btn' },
  { kind: 'assert_text', element: 'login-result', expect: '欢迎 alice' },
  { kind: 'assert_url', expect: '#done' },
  { kind: 'assert_element', element: 'login-result' },
  { kind: 'eval', expression: 'document.title', exportAs: 'UI_PAGE_TITLE' },
  { kind: 'screenshot', path: 'ui/screenshots/e2e-login.png' },
] })
check(uiScript.status === 200 && uiScript.body.ok, 'create ui script', JSON.stringify(uiScript.body))
const uiScriptId = uiScript.body.script.id
const uiScriptList = await api('GET', '/api/ui/scripts', undefined, { workspaceId })
check(uiScriptList.status === 200 && uiScriptList.body.scripts.length === 1, 'list ui scripts', JSON.stringify(uiScriptList.body))

// 执行:Host 半 Playwright + 系统 Chrome 真实驱动
const uiRun = await api('POST', '/api/ui/run', { workspaceId, scriptId: uiScriptId })
check(uiRun.status === 200 && uiRun.body.ok, 'ui run api ok', JSON.stringify(uiRun.body))
check(uiRun.body.report.summary?.total === 9 && uiRun.body.report.summary?.failed === 0, 'ui run passes all steps (playwright)', JSON.stringify(uiRun.body.report.summary))
check(uiRun.body.report.driver?.engine === 'playwright' && typeof uiRun.body.report.driver?.version === 'string', 'ui report records playwright driver', JSON.stringify(uiRun.body.report.driver))
check(uiRun.body.report.exports?.UI_PAGE_TITLE === '登录页', 'ui eval exportAs produces export', JSON.stringify(uiRun.body.report.exports))
check(uiRun.body.report.kind === 'ui', 'ui report kind', uiRun.body.report.kind)
const uiShots = await readdir(join(workspacePath, 'test-mode', 'ui', 'screenshots')).catch(() => [])
check(uiShots.includes('e2e-login.png'), 'ui screenshot written under test-mode root', JSON.stringify(uiShots))
// 通过:不保存测试数据(不写报告/历史),只更新脚本状态/计数并通过脚本配置保存通过时的步骤。
const uiPassReportId = uiRun.body.report.id
const uiScriptsAfterPass = await api('GET', '/api/ui/scripts', undefined, { workspaceId })
const loginScriptConfig = uiScriptsAfterPass.body.scripts.find((script) => script.id === uiScriptId)
check(loginScriptConfig?.lastRun?.pass === true && loginScriptConfig?.stats?.passed >= 1, 'passing ui run updates script status and counters', JSON.stringify(loginScriptConfig?.lastRun))
check(Array.isArray(loginScriptConfig?.lastPassed?.steps) && loginScriptConfig.lastPassed.steps.length === 9, 'passing ui run stores step snapshot in script config', JSON.stringify(loginScriptConfig?.lastPassed?.steps?.length))
const reportsAfterUiPass = await api('GET', '/api/reports', undefined, { workspaceId })
check(!reportsAfterUiPass.body.reports.some((report) => report.id === uiPassReportId), 'passing ui run saves no report', JSON.stringify(reportsAfterUiPass.body.reports.map((report) => report.id)))
const historyAfterUiPass = await api('GET', '/api/history', undefined, { workspaceId })
check(!historyAfterUiPass.body.history.some((entry) => entry.kind === 'ui'), 'passing ui run writes no history', JSON.stringify(historyAfterUiPass.body.history.map((entry) => entry.kind)))

// 失败路径:断言不匹配 → 报告失败 + 自动截图
const uiFailScript = await api('POST', '/api/ui/scripts', { workspaceId, name: '断言失败', steps: [
  { kind: 'open', url: uiPage },
  { kind: 'assert_text', element: 'login-result', expect: '不会出现的文案' },
] })
const uiFailRun = await api('POST', '/api/ui/run', { workspaceId, scriptId: uiFailScript.body.script.id })
check(uiFailRun.status === 200 && uiFailRun.body.report.summary?.failed === 1, 'ui assertion failure reported', JSON.stringify(uiFailRun.body.report.summary))
const uiFailStep = uiFailRun.body.report.results?.[1]
check(typeof uiFailStep?.error === 'string' && uiFailStep.error.includes('expected text'), 'ui failure carries assertion detail in response', JSON.stringify(uiFailStep))
check(uiFailRun.body.report.failedEntries?.[0]?.error?.includes('expected text'), 'ui failure recorded as failed entry (statistics only)', JSON.stringify(uiFailRun.body.report.failedEntries))
const uiReportId = uiFailRun.body.report.id
const reportsAfterUiFail = await api('GET', '/api/reports', undefined, { workspaceId })
check(reportsAfterUiFail.body.reports.some((report) => report.id === uiReportId && report.kind === 'ui'), 'failing ui run saves report', JSON.stringify(reportsAfterUiFail.body.reports.map((report) => report.kind)))
const historyAfterUiFail = await api('GET', '/api/history', undefined, { workspaceId })
check(historyAfterUiFail.body.history.some((entry) => entry.kind === 'ui' && entry.pass === false), 'failing ui run writes failure history', JSON.stringify(historyAfterUiFail.body.history.filter((entry) => entry.kind === 'ui')))
const uiScriptsAfterFail = await api('GET', '/api/ui/scripts', undefined, { workspaceId })
const failScriptConfig = uiScriptsAfterFail.body.scripts.find((script) => script.id === uiFailScript.body.script.id)
check(failScriptConfig?.lastRun?.pass === false && failScriptConfig?.stats?.failed >= 1, 'failing ui run updates script status and counters', JSON.stringify(failScriptConfig?.lastRun))

// 页面元素探测(POST /api/ui/probe):AI 生成元素库/脚本用,不再依赖会话浏览器工具
const uiProbe = await api('POST', '/api/ui/probe', { url: uiPage })
check(uiProbe.status === 200 && uiProbe.body.ok, 'ui probe ok', JSON.stringify(uiProbe.body))
check(uiProbe.body.title === '登录页', 'ui probe returns title', JSON.stringify(uiProbe.body.title))
check(uiProbe.body.elements?.some((item) => item.testId === 'login-submit') && uiProbe.body.elements?.some((item) => item.id === 'username'), 'ui probe returns interactive elements', JSON.stringify((uiProbe.body.elements ?? []).slice(0, 3)))

// 报告可查(报告 tab 可见 UI 报告)
const uiReports = await api('GET', '/api/reports', undefined, { workspaceId })
check(uiReports.body.reports.some((r) => r.kind === 'ui'), 'ui report in reports list (failures only)', JSON.stringify(uiReports.body.reports.map((r) => r.kind)))

// 引擎直调:真实 Playwright 通过/失败路径
const { executeUiScript } = await import('../lib/ui-test.js')
const uiElements = { 'login-user': '#username', 'login-btn': '[data-testid="login-submit"]', 'login-result': '#result' }
const engineReport = await executeUiScript({}, {
  name: '引擎直调',
  steps: [
    { kind: 'open', url: uiPage },
    { kind: 'type', element: 'login-user', text: 'bob' },
    { kind: 'click', element: 'login-btn' },
    { kind: 'assert_text', element: 'login-result', expect: '欢迎 bob' },
    { kind: 'eval', expression: 'document.title', exportAs: 'ENGINE_TITLE' },
  ],
}, uiElements, {}, {})
check(engineReport.summary?.passed === 5 && engineReport.summary?.failed === 0, 'ui engine pass path (playwright)', JSON.stringify(engineReport.summary))
check(engineReport.driver?.engine === 'playwright', 'ui engine reports driver info', JSON.stringify(engineReport.driver))
check(engineReport.exports?.ENGINE_TITLE === '登录页', 'ui engine exportAs', JSON.stringify(engineReport.exports))
const engineFail = await executeUiScript({}, {
  name: '引擎失败',
  steps: [
    { kind: 'open', url: uiPage },
    { kind: 'click', selector: '#not-exist', timeoutMs: 1500 },
  ],
}, {}, {}, {})
const engineFailStep = engineFail.results?.[1]
check(engineFail.summary?.failed === 1, 'ui engine failure path', JSON.stringify(engineFail.summary))
check(typeof engineFailStep?.error === 'string' && /Timeout|waiting/i.test(engineFailStep.error), 'ui engine failure carries playwright timeout detail', JSON.stringify(engineFailStep?.error))

// 脚本/元素删除
const uiElDel = await api('DELETE', `/api/ui/elements/${uiElTemp.body.element.id}`, undefined, { workspaceId })
check(uiElDel.status === 200 && uiElDel.body.ok, 'delete ui element', JSON.stringify(uiElDel.body))
const uiScriptDel = await api('DELETE', `/api/ui/scripts/${uiScriptId}`, undefined, { workspaceId })
check(uiScriptDel.status === 200 && uiScriptDel.body.ok, 'delete ui script', JSON.stringify(uiScriptDel.body))

// ── 10b. 混合用例(API 步骤 + UI 步骤,闭环验证) ──────────────────────────
console.log('\n=== 混合用例(API + UI) ===')
// 重新建一个 UI 脚本和一个混合用例
const mixUiScript = await api('POST', '/api/ui/scripts', { workspaceId, name: 'UI 登录', steps: [
  { kind: 'open', url: uiPage },
  { kind: 'type', element: 'login-user', text: 'bob' },
  { kind: 'click', element: 'login-btn' },
  { kind: 'assert_text', element: 'login-result', expect: '欢迎 bob' },
] })
const mixUiScriptId = mixUiScript.body.script.id
const mixCase = await api('POST', '/api/cases', { workspaceId, name: '端到端登录', steps: [
  { action: 'UI 打开登录页并点击', expected: '页面可用', uiRef: { scriptId: mixUiScriptId } },
  { action: 'API 登录', expected: '返回 token', requestRef: { projectId, collectionId: 'col-auth', requestId: 'req-login' } },
  { action: '手工检查', expected: '无' }, // 跳过
] })
check(mixCase.status === 200 && mixCase.body.ok, 'create mixed case', JSON.stringify(mixCase.body))
const mixCaseId = mixCase.body.case.id

// 执行:UI 步骤真实通过(Playwright),API 步骤真实请求,手工步骤跳过
const mixRun = await api('POST', `/api/cases/${mixCaseId}/run`, { workspaceId, environmentId: envId })
check(mixRun.status === 200 && mixRun.body.ok, 'mixed case run ok', JSON.stringify(mixRun.body))
check(mixRun.body.result.results?.[0]?.kind === 'ui', 'first step is ui kind', JSON.stringify(mixRun.body.result.results?.[0]))
check(mixRun.body.result.results?.[0]?.pass === true, 'ui step passes with playwright', JSON.stringify(mixRun.body.result.results?.[0]?.error))
check(mixRun.body.result.results?.[1]?.kind === 'request' && mixRun.body.result.results?.[1]?.status === 200, 'api step passes after ui', JSON.stringify(mixRun.body.result.results?.[1]))
check(mixRun.body.result.summary?.skipped === 1, 'manual step skipped', JSON.stringify(mixRun.body.result.summary))

// 引擎混合路径:executeCase + 真实 executeUiScript 验证顺序与结果
const { executeCase } = await import('../lib/api-test.js')
const mixedReport = await executeCase(
  { name: '端到端', steps: [
    { action: 'UI', uiRef: { scriptId: 's1' } },
    { action: 'API', requestRef: { projectId: 'p1', collectionId: 'c1', requestId: 'r1' } },
  ] },
  async (ref) => {
    if (ref.scriptId) {
      return { kind: 'ui', script: { id: 's1', name: 'UI 登录', steps: [{ kind: 'open', url: uiPage }] }, elements: {} }
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
    const report = await executeUiScript({}, script, elements, {}, {})
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
await writeFile(join(workspacePath, 'test-mode/cases/hook-raw.json'), 'not json')
const rawVerdict = await validateTestModeFile(workspacePath, join(workspacePath, 'test-mode/cases/hook-raw.json'))
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

// ── 5.9 迭代增量:请求级打戳 / OpenAPI diff 变更清单 / dependsOn ──
console.log('\n=== 迭代增量(请求级 + 变更清单 + 依赖) ===')
const nowMs = Date.now()
const dayMs = 24 * 60 * 60 * 1000
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
check(JSON.stringify(stampLogin.body) === JSON.stringify(stampMe.body) || stampLogin.body !== '{"only":"me"}', 'unchanged request content not modified by stamping', JSON.stringify(stampLogin.body))

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

// 4) 变更清单文件钩子:坏结构拒绝,好结构放行
await writeFile(join(workspacePath, 'test-mode/changelogs/bad-cl.json'), JSON.stringify({ id: 'bad-cl', createdAt: 'nope', changedRequests: [{ method: 1 }] }))
const badCl = await validateTestModeFile(workspacePath, join(workspacePath, 'test-mode/changelogs/bad-cl.json'))
check(badCl !== null && badCl.errors.length > 0, 'file hook rejects invalid changelog', JSON.stringify(badCl))
await writeFile(join(workspacePath, 'test-mode/changelogs/good-cl.json'), JSON.stringify({ id: 'good-cl', createdAt: new Date().toISOString(), changedRequests: [{ method: 'GET', url: '/api/x', change: 'added' }], modules: ['登录'] }))
const goodCl = await validateTestModeFile(workspacePath, join(workspacePath, 'test-mode/changelogs/good-cl.json'))
check(goodCl !== null && goodCl.errors.length === 0, 'file hook accepts valid changelog', JSON.stringify(goodCl))

// 6) dependsOn 依赖声明校验
const badDepends = await api('POST', '/api/cases', { workspaceId, name: '坏依赖用例', dependsOn: [1], steps: [{ action: 'a', expected: 'b' }] })
check(badDepends.status === 400 && badDepends.body.message.includes('dependsOn'), 'reject invalid dependsOn', JSON.stringify(badDepends.body))
const dependsCase = await api('POST', '/api/cases', { workspaceId, name: '依赖表用例', dependsOn: ['users'], steps: [{ action: '核对用户数据', expected: '正常' }] })
check(dependsCase.status === 200 && dependsCase.body.ok, 'create case with dependsOn', JSON.stringify(dependsCase.body))

// 7) 模块标签用例
const moduleCase = await api('POST', '/api/cases', { workspaceId, name: '模块声明用例', tags: ['登录'], steps: [{ action: '登录冒烟', expected: 'ok' }] })

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
check(clientBundleSource.includes('conversation.session.header.utilities'), '会话头部挂载视图门控探针(按会话判定标签可见性)', '')
check(clientBundleSource.includes('useProjection("agentPreset")'), '门控读宿主投影 agentPreset', '')
check(clientBundleSource.includes('const inject = ["slots"]'), '客户端只依赖 slots 服务(不再硬依赖 sessions)', '')

// ── 5.12 预设 prompt 段:不得引用未注册的 {{variable}}(运行时只注册 provider/model) ──
console.log('\n=== 预设 prompt 段占位符 ===')
{
  const captured = []
  const presetCtx = {
    effect: (fn) => { fn(); return () => {} },
    on: () => () => {},
    logger: { warn: () => {} },
    systemPrompt: {
      section: (definition) => { captured.push(definition); return () => {} },
    },
  }
  const { apply: applyPreset } = await import('../lib/preset.js')
  applyPreset(presetCtx)
  const sections = captured.filter((item) => item?.name === 'dsh-test-mode.workflow')
  check(sections.length === 1, '预设注册了 workflow 段', JSON.stringify(captured.map((s) => s?.name)))
  const workflowText = typeof sections[0]?.text === 'function' ? sections[0].text() : String(sections[0]?.text ?? '')
  const placeholders = [...workflowText.matchAll(/\{\{[^}]*\}\}/g)].map((match) => match[0])
  check(placeholders.length === 0, 'workflow 段不含未注册的 {{variable}} 占位符', placeholders.join(','))
  check(workflowText.includes('test-mode/'), 'workflow 段仍指明共享项目目录', '')
  // 补丁里的 prompt 文本(如 persona prefix/suffix)同样只能引用已注册变量
  const patchSource = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const patchTokens = [...patchSource.matchAll(/\{\{[^}]*\}\}/g)].map((match) => match[0])
  check(patchTokens.every((token) => token === '{{model}}'), '补丁内 prompt 占位符仅使用已注册的 {{model}}', patchTokens.join(','))

  // 常驻提示词瘦身回归:不得残留旧链路/旧术语,且必须引用按需技能。
  const presetSource = await readFile(new URL('../lib/preset.js', import.meta.url), 'utf8')
  const presetLines = presetSource.split('\n').filter((line) => line.trim().startsWith('"')).join('\n')
  for (const stale of ['run-collection', '/api/ui/run', '/api/plans', '智能绑定接口']) {
    check(!presetLines.includes(stale), `常驻提示词不含旧链路/旧术语:${stale}`, '')
  }
  check(!presetLines.includes('用例'), '常驻提示词统一使用「测试工作项」', '')
  check(presetLines.includes('test-mode-workflow') && presetLines.includes('api-testing-assets'), '常驻提示词引用按需技能(workflow/routing)', '')
  check(presetLines.length < 6000, '常驻提示词保持精简(<6000 字)', `${presetLines.length}`)
}

// ── 5.13 测试资产与版本(资产化模型) ──────────────────────────────────
console.log('\n=== 测试资产与版本 ===')
// 迁移:旧项目/用例 → 资产(幂等)
// 迁移默认 dry-run:只算计划不写盘,返回 hint;必须显式 apply:true。
const migratedDry = await api('POST', '/api/migrate/assets', { workspaceId })
check(migratedDry.status === 200 && migratedDry.body.manifest.dryRun === true && migratedDry.body.manifest.counts.apiAssets >= 1, 'migrate dry-run by default', JSON.stringify(migratedDry.body.manifest?.counts))
check(typeof migratedDry.body.hint === 'string' && migratedDry.body.hint.includes('apply'), 'dry-run returns apply hint', migratedDry.body.hint)
const assetsDirBefore = await readdir(join(workspacePath, 'test-mode/assets/api')).catch(() => [])
check(assetsDirBefore.length === 0, 'dry-run writes no asset files', JSON.stringify(assetsDirBefore))

// 旧格式用例带 step.data:迁移必须保留数据覆盖(同一资产两次不同 data 也要按顺序保留)。
const legacyDataCase = await api('POST', '/api/cases', {
  workspaceId, name: '旧格式数据覆盖用例',
  steps: [
    { action: '登录 A', expected: '成功', requestRef: { projectId, collectionId: 'col-auth', requestId: 'req-login' }, data: { body: '{"user":"A-{{USER}}"}' } },
    { action: '登录 B', expected: '成功', requestRef: { projectId, collectionId: 'col-auth', requestId: 'req-login' }, data: { body: '{"user":"B-{{USER}}"}' } },
  ],
})
check(legacyDataCase.status === 200, 'create legacy steps case with data', JSON.stringify(legacyDataCase.body.message))

// 创建一个旧格式用例(steps + requestRef),验证迁移会推导出资产引用。
const legacyStepsCase = await api('POST', '/api/cases', {
  workspaceId, name: '旧格式步骤用例',
  steps: [{ action: '调用登录接口', expected: '成功', requestRef: { projectId, collectionId: 'col-auth', requestId: 'req-login' } }],
})
check(legacyStepsCase.status === 200, 'create legacy steps case for migration', JSON.stringify(legacyStepsCase.body.message))

const migrated = await api('POST', '/api/migrate/assets', { workspaceId, apply: true })
const migrateManifest = migrated.body.manifest
check(migrated.status === 200 && migrateManifest.dryRun === false && migrateManifest.counts.apiAssets >= 1, 'migrate applies with explicit apply:true', JSON.stringify(migrateManifest?.counts))
check(typeof migrateManifest.backup === 'string' && migrateManifest.backup.startsWith('backup-assets-migration-'), 'migration records automatic backup', String(migrateManifest.backup))
const backupFiles = await readdir(join(workspacePath, 'test-mode', migrateManifest.backup, 'cases')).catch(() => [])
check(backupFiles.length > 0, 'migration backup contains case files', String(backupFiles.length))

// 引用数一致性:manifest 的 caseAssetRefs 必须等于磁盘上所有用例 assets 引用数之和。
const sumCaseRefs = async () => {
  let total = 0
  for (const name of await readdir(join(workspacePath, 'test-mode/cases'))) {
    if (!name.endsWith('.json')) continue
    let item
    try {
      item = JSON.parse(await readFile(join(workspacePath, 'test-mode/cases', name), 'utf8'))
    } catch {
      continue // 文件钩子测试留下的非 JSON 夹具不参与统计
    }
    total += (Array.isArray(item.assets) ? item.assets : []).filter((entry) => entry && typeof entry.assetId === 'string').length
  }
  return total
}
const legacyAfterMigrate = await api('GET', `/api/cases/${legacyStepsCase.body.case.id}`, undefined, { workspaceId })
check(legacyAfterMigrate.body.case.assets?.length >= 1, 'legacy steps become asset refs', JSON.stringify(legacyAfterMigrate.body.case.assets))
const dataAfterMigrate = await api('GET', `/api/cases/${legacyDataCase.body.case.id}`, undefined, { workspaceId })
const migratedEntries = dataAfterMigrate.body.case.assets ?? []
check(migratedEntries.length === 2 && migratedEntries[0]?.data?.body === '{"user":"A-{{USER}}"}' && migratedEntries[1]?.data?.body === '{"user":"B-{{USER}}"}', 'migration keeps step.data in order', JSON.stringify(migratedEntries))
await api('POST', `/api/cases/${legacyDataCase.body.case.id}/run`, { workspaceId, environmentId: envId })
check(lastLoginBody.includes('B-'), 'migrated case applies step.data at run time', lastLoginBody.slice(0, 120))
const refsOnDisk = await sumCaseRefs()
check(refsOnDisk > 0 && refsOnDisk === migrateManifest.counts.caseAssetRefs, 'migration ref counts match disk', `${refsOnDisk} vs ${migrateManifest.counts.caseAssetRefs}`)

// 已迁移但丢掉 data 的存量用例:执行器从 legacy steps 唯一 data 只读回退。
const fallbackCase = await api('POST', '/api/cases', {
  workspaceId, name: '存量丢数据用例',
  steps: [{ action: '登录回退', expected: '成功', requestRef: { projectId, collectionId: 'col-auth', requestId: 'req-login' }, data: { body: '{"user":"FALLBACK-{{USER}}"}' } }],
})
const migratedLoginAsset = (await api('GET', '/api/assets', undefined, { workspaceId })).body.assets
  .find((asset) => asset.source?.requestId === 'req-login')
check(migratedLoginAsset !== undefined, 'find migrated login asset', '')
await api('PUT', `/api/cases/${fallbackCase.body.case.id}`, {
  workspaceId, assets: [{ assetId: migratedLoginAsset.id }],
  steps: [{ action: '登录回退', expected: '成功', requestRef: { projectId, collectionId: 'col-auth', requestId: 'req-login' }, data: { body: '{"user":"FALLBACK-{{USER}}"}' } }],
})
await api('POST', `/api/cases/${fallbackCase.body.case.id}/run`, { workspaceId, environmentId: envId })
check(lastLoginBody.includes('FALLBACK-'), 'runtime fallback applies unique legacy step data', lastLoginBody.slice(0, 120))
// 歧义(同一请求两条不同 data)不回退,避免选错数据。
const ambiguousCase = await api('POST', '/api/cases', {
  workspaceId, name: '歧义数据用例',
  steps: [
    { action: 'X', expected: '成功', requestRef: { projectId, collectionId: 'col-auth', requestId: 'req-login' }, data: { body: '{"user":"X-{{USER}}"}' } },
    { action: 'Y', expected: '成功', requestRef: { projectId, collectionId: 'col-auth', requestId: 'req-login' }, data: { body: '{"user":"Y-{{USER}}"}' } },
  ],
})
await api('PUT', `/api/cases/${ambiguousCase.body.case.id}`, {
  workspaceId, assets: [{ assetId: migratedLoginAsset.id }],
  steps: [
    { action: 'X', expected: '成功', requestRef: { projectId, collectionId: 'col-auth', requestId: 'req-login' }, data: { body: '{"user":"X-{{USER}}"}' } },
    { action: 'Y', expected: '成功', requestRef: { projectId, collectionId: 'col-auth', requestId: 'req-login' }, data: { body: '{"user":"Y-{{USER}}"}' } },
  ],
})
await api('POST', `/api/cases/${ambiguousCase.body.case.id}/run`, { workspaceId, environmentId: envId })
check(!lastLoginBody.includes('X-') && !lastLoginBody.includes('Y-'), 'ambiguous legacy data does not fall back', lastLoginBody.slice(0, 120))

// 已使用新 assets[] 的用例绝不能被迁移清空(本次 bug 的回归测试)。
const firstMigratedAsset = (await api('GET', '/api/assets', undefined, { workspaceId })).body.assets[0]
const preservedCase = await api('POST', '/api/cases', {
  workspaceId, name: '保留资产用例', type: 'e2e', priority: 'high', automation: 'auto', result: 'not_run',
  assets: [{ assetId: firstMigratedAsset.id, data: { body: '{"preserved":true}' } }],
})
check(preservedCase.status === 200 && preservedCase.body.case.assets.length === 1, 'create new-model case with assets', JSON.stringify(preservedCase.body.message))
const rerunApply = await api('POST', '/api/migrate/assets', { workspaceId, apply: true })
check(rerunApply.body.manifest.counts.caseRefsBefore === rerunApply.body.manifest.counts.caseAssetRefs, 're-migration does not shrink refs', JSON.stringify(rerunApply.body.manifest.counts))
const preservedAfter = await api('GET', `/api/cases/${preservedCase.body.case.id}`, undefined, { workspaceId })
check(preservedAfter.body.case.assets?.length === 1 && preservedAfter.body.case.assets[0].data?.body === '{"preserved":true}', 'existing case assets preserved by re-migration', JSON.stringify(preservedAfter.body.case.assets))
const rerunDry = await api('POST', '/api/migrate/assets', { workspaceId })
check(rerunDry.body.manifest.dryRun === true && rerunDry.body.manifest.counts.caseRefsBefore === rerunDry.body.manifest.counts.caseAssetRefs, 'migrate is idempotent (dry-run)', JSON.stringify(rerunDry.body.manifest.counts))
const assetList = await api('GET', '/api/assets', undefined, { workspaceId })
check(assetList.status === 200 && assetList.body.assets.length >= 1, 'list assets', JSON.stringify(assetList.body.summary))
check(typeof assetList.body.summary?.untested === 'number', 'asset summary exposed', JSON.stringify(assetList.body.summary))
const pendingList = await api('GET', '/api/assets/pending', undefined, { workspaceId })
check(pendingList.status === 200 && pendingList.body.counts.pending >= 1, 'pending assets query', JSON.stringify(pendingList.body.counts))

// UI 资产粒度软校验:组件跨页/步骤过多/无断言 → warnings(不拒绝保存)
const uiComponentAsset = await api('POST', '/api/assets', {
  workspaceId, kind: 'ui', type: 'component', module: '资产测试', name: '超粒度组件',
  steps: [
    { kind: 'open', url: '/login' }, { kind: 'click', element: 'login-btn' },
    { kind: 'open', url: '/home' }, { kind: 'click', element: 'nav-a' },
    { kind: 'click', element: 'nav-b' }, { kind: 'click', element: 'nav-c' }, { kind: 'click', element: 'nav-d' },
  ],
})
const uiWarnings = uiComponentAsset.body.warnings ?? []
check(uiComponentAsset.status === 200 && uiWarnings.some((item) => item.includes('步骤')) && uiWarnings.some((item) => item.includes('页面')) && uiWarnings.some((item) => item.includes('断言')), 'UI component granularity warnings', JSON.stringify(uiWarnings))
const uiAssetId = uiComponentAsset.body.asset.id
const uiAssetsList = await api('GET', '/api/assets', undefined, { workspaceId, kind: 'ui' })
const uiRow = uiAssetsList.body.assets.find((asset) => asset.id === uiAssetId)
check(uiRow?.granularity?.type === 'component' && uiRow.granularity.pages === 2 && uiRow.granularity.warnings.length >= 3, 'asset list exposes UI granularity', JSON.stringify(uiRow?.granularity))
const granularitySummary = await api('GET', '/api/assets/granularity', undefined, { workspaceId })
check(granularitySummary.status === 200 && granularitySummary.body.summary.warningCount >= 1 && granularitySummary.body.items.some((item) => item.id === uiAssetId), 'granularity summary endpoint', JSON.stringify(granularitySummary.body.summary))
const granularityReport = await api('POST', '/api/assets/granularity-report', { workspaceId })
check(granularityReport.status === 200 && granularityReport.body.path === 'test-mode/granularity-report.md' && granularityReport.body.summary.warningCount >= 1, 'granularity report generated', JSON.stringify(granularityReport.body))
const granularityText = await readFile(join(workspacePath, 'test-mode/granularity-report.md'), 'utf8')
check(granularityText.includes('UI 资产粒度整改清单') && granularityText.includes('超粒度组件'), 'granularity report contains component', '')
await api('DELETE', `/api/assets/${uiAssetId}`, undefined, { workspaceId })

// 创建资产:首次通过即固化
const assetCreate = await api('POST', '/api/assets', { workspaceId, kind: 'api', module: '资产测试', name: '健康检查', baseUrl, request: { method: 'GET', url: '/api/me', assertions: [{ type: 'status', operator: 'eq', expected: 200 }] } })
check(assetCreate.status === 200 && assetCreate.body.asset.status === 'untested', 'create api asset', JSON.stringify(assetCreate.body.asset?.id))
const assetId = assetCreate.body.asset.id
const assetRun = await api('POST', '/api/assets/run', { workspaceId, assetId })
check(assetRun.status === 200 && assetRun.body.result.pass === true, 'run api asset passes', JSON.stringify(assetRun.body.result))
check(assetRun.body.asset.status === 'solid' && assetRun.body.asset.stats?.passed === 1, 'asset solid after first pass', JSON.stringify({ status: assetRun.body.asset.status, stats: assetRun.body.asset.stats }))
const freshAsset = await api('GET', `/api/assets/${assetId}`, undefined, { workspaceId })
check(freshAsset.body.asset?.stale !== true && freshAsset.body.asset?.status === 'solid', 'freshly passed asset is not stale', JSON.stringify({ stale: freshAsset.body.asset?.stale, updatedAt: freshAsset.body.asset?.updatedAt, passedAt: freshAsset.body.asset?.lastPassed?.at }))

// extract 变量在用例资产间传递(不要求 export:true)
const extractAsset = await api('POST', '/api/assets', {
  workspaceId, kind: 'api', module: '资产测试', name: '提取令牌', baseUrl,
  request: { method: 'POST', url: '/api/login', headers: { 'content-type': 'application/json' }, body: '{}', assertions: [{ type: 'status', operator: 'eq', expected: 200 }], extract: [{ name: 'TOKEN', path: '$.token' }] },
})
const useAsset = await api('POST', '/api/assets', {
  workspaceId, kind: 'api', module: '资产测试', name: '使用令牌', baseUrl,
  request: { method: 'GET', url: '/api/echo?token={{TOKEN}}', assertions: [{ type: 'json', path: '$.query.token', operator: 'eq', expected: 'tok-123' }] },
})
const extractCase = await api('POST', '/api/cases', {
  workspaceId, name: '令牌链路', module: '资产测试', tags: ['冒烟'],
  assets: [{ assetId: extractAsset.body.asset.id }, { assetId: useAsset.body.asset.id }],
})
check(extractCase.status === 200 && extractCase.body.ok, 'create case with asset chain', JSON.stringify(extractCase.body.message))
const extractRun = await api('POST', `/api/cases/${extractCase.body.case.id}/run`, { workspaceId })
check(extractRun.status === 200 && extractRun.body.result?.summary?.passed === 2, 'case assets propagate extract variables (no export required)', JSON.stringify(extractRun.body.result?.results?.map((item) => [item.name, item.pass, item.error])))

// 失败 → failed
const failingAsset = await api('POST', '/api/assets', { workspaceId, kind: 'api', module: '资产测试', name: '错误接口', baseUrl, request: { method: 'GET', url: '/api/error', assertions: [{ type: 'status', operator: 'eq', expected: 200 }] } })
const failingRun = await api('POST', '/api/assets/run', { workspaceId, assetId: failingAsset.body.asset.id })
check(failingRun.body.result.pass === false && failingRun.body.asset.status === 'failed', 'asset failed status on failure', JSON.stringify(failingRun.body.asset.status))

// 版本保存:存在未通过资产时拒绝并列出清单
const versionBlocked = await api('POST', '/api/versions', { workspaceId })
check(versionBlocked.status === 409 && Array.isArray(versionBlocked.body.failing) && versionBlocked.body.failing.length > 0, 'version save blocked when assets not solid', JSON.stringify(versionBlocked.body.message))

// 批量执行:只处理待测资产,并按 batchSize 分批
await api('PUT', `/api/assets/${failingAsset.body.asset.id}`, { workspaceId, request: { method: 'GET', url: '/api/me', assertions: [{ type: 'status', operator: 'eq', expected: 200 }] } })
const batchRun = await api('POST', '/api/assets/run-batch', { workspaceId, module: '资产测试', batchSize: 1 })
check(batchRun.status === 200 && batchRun.body.batch.ran <= 1, 'batch run respects batchSize', JSON.stringify(batchRun.body.batch))
await api('POST', '/api/assets/run-batch', { workspaceId, module: '资产测试', batchSize: 5 })
const moduleAssets = await api('GET', '/api/assets', undefined, { workspaceId, module: '资产测试' })
check(moduleAssets.body.assets.every((asset) => asset.status === 'solid'), 'batch run solidifies pending assets', JSON.stringify(moduleAssets.body.assets.map((asset) => [asset.name, asset.status])))

// 清理遗留(未迁移测试的)资产后保存版本:必须全部通过
const allAssets = await api('GET', '/api/assets', undefined, { workspaceId })
for (const asset of allAssets.body.assets) {
  if (asset.module !== '资产测试') await api('DELETE', `/api/assets/${asset.id}`, undefined, { workspaceId })
}
const versionSaved = await api('POST', '/api/versions', { workspaceId, name: 'e2e 全量版本' })
check(versionSaved.status === 200 && versionSaved.body.version?.coverage?.assetsTotal === moduleAssets.body.assets.length, 'save version when all assets solid', JSON.stringify(versionSaved.body.version?.coverage))
const versionId = versionSaved.body.version.id
const versionsList = await api('GET', '/api/versions', undefined, { workspaceId })
check(versionsList.status === 200 && versionsList.body.versions.some((version) => version.id === versionId), 'list versions', JSON.stringify(versionsList.body.versions.map((version) => version.id)))
const versionDetail = await api('GET', `/api/versions/${versionId}`, undefined, { workspaceId })
check(versionDetail.status === 200 && versionDetail.body.version.id === versionId, 'version detail', '')
const versionCompare = await api('GET', `/api/versions/${versionId}/compare`, undefined, { workspaceId })
check(versionCompare.status === 200 && versionCompare.body.hasPrevious === false, 'version compare without previous', JSON.stringify(versionCompare.body))

// 配置变更 → 过期 → 保存版本被拒;重跑后恢复
await api('PUT', `/api/assets/${assetId}`, { workspaceId, name: '健康检查(改)' })
const staleAssets = await api('GET', '/api/assets', undefined, { workspaceId })
check(staleAssets.body.assets.some((asset) => asset.id === assetId && asset.stale === true), 'asset updated after pass becomes stale', JSON.stringify(staleAssets.body.assets.find((asset) => asset.id === assetId)?.stale))
const versionBlockedStale = await api('POST', '/api/versions', { workspaceId })
check(versionBlockedStale.status === 409, 'version save blocked by stale assets', JSON.stringify(versionBlockedStale.body.message))
const rerunStale = await api('POST', '/api/assets/run', { workspaceId, assetId })
check(rerunStale.body.asset.status === 'solid', 'rerun clears stale state', JSON.stringify({ status: rerunStale.body.asset.status }))
const versionSaved2 = await api('POST', '/api/versions', { workspaceId, name: 'e2e 全量版本 2' })
check(versionSaved2.status === 200, 'save version after rerun', JSON.stringify(versionSaved2.body.message))
const versionCompare2 = await api('GET', `/api/versions/${versionSaved2.body.version.id}/compare`, undefined, { workspaceId })
check(versionCompare2.status === 200 && versionCompare2.body.hasPrevious === true, 'version compare with previous', JSON.stringify(versionCompare2.body.previous?.id))
const deletedVersion = await api('DELETE', `/api/versions/${versionSaved2.body.version.id}`, undefined, { workspaceId })
check(deletedVersion.status === 200, 'delete version', '')

// ── 安全回归:安全资产软校验 / 脚手架 / 版本安全门禁 ──────────────────
const secSource = await api('POST', '/api/assets', {
  workspaceId, kind: 'api', module: '资产测试', name: '安全脚手架源', baseUrl,
  request: { method: 'GET', url: '/api/orders/123', assertions: [{ type: 'status', operator: 'eq', expected: 200 }] },
})
check(secSource.status === 200, 'create security scaffold source', JSON.stringify(secSource.body.message))
const secDry = await api('POST', '/api/security/scaffold', { workspaceId, assetIds: [secSource.body.asset.id] })
check(secDry.status === 200 && secDry.body.dryRun === true && secDry.body.summary.assets >= 3 && secDry.body.summary.workItems === 1, 'security scaffold dry-run plan', JSON.stringify(secDry.body.summary))
const secApply = await api('POST', '/api/security/scaffold', { workspaceId, assetIds: [secSource.body.asset.id], apply: true })
check(secApply.status === 200 && secApply.body.created?.assets >= 3 && secApply.body.created?.workItems === 1, 'security scaffold applies', JSON.stringify(secApply.body.created))
const secWorkItemId = secApply.body.plan.workItems[0]?.id
const secWorkItem = await api('GET', `/api/cases/${secWorkItemId}`, undefined, { workspaceId })
check(secWorkItem.body.case?.type === 'security' && secWorkItem.body.case.assets.length >= 3, 'security regression work item generated', JSON.stringify({ type: secWorkItem.body.case?.type, assets: secWorkItem.body.case?.assets?.length }))
const secRun = await api('POST', `/api/cases/${secWorkItemId}/run`, { workspaceId })
check(secRun.status === 200 && secRun.body.result.summary.failed === 0, 'security regression assets pass (4xx, no leak)', JSON.stringify(secRun.body.result?.results?.map((item) => [item.name, item.pass, item.error])))
const secRunCase = await api('GET', `/api/cases/${secWorkItemId}`, undefined, { workspaceId })
check(secRunCase.body.case.result === 'passed', 'security work item result passed', secRunCase.body.case.result)
const secDryAgain = await api('POST', '/api/security/scaffold', { workspaceId, assetIds: [secSource.body.asset.id] })
check(secDryAgain.body.summary.assets === 0 && secDryAgain.body.summary.skipped >= 1, 'security scaffold is idempotent', JSON.stringify(secDryAgain.body.summary))

// 安全资产软校验:期望 2xx 时提示
const badSecurityAsset = await api('POST', '/api/assets', {
  workspaceId, kind: 'api', module: '安全', name: '错误安全资产', baseUrl,
  security: { category: 'auth' },
  request: { method: 'GET', url: '/api/me', assertions: [{ type: 'status', operator: 'eq', expected: 200 }] },
})
check((badSecurityAsset.body.warnings ?? []).some((item) => item.includes('2xx')), 'security asset warns on 2xx-only assertion', JSON.stringify(badSecurityAsset.body.warnings))

// 断言操作符:not_contains / in
const notContainsAsset = await api('POST', '/api/assets', {
  workspaceId, kind: 'api', module: '资产测试', name: 'not_contains 断言', baseUrl,
  request: { method: 'GET', url: '/api/error', assertions: [{ type: 'status', operator: 'eq', expected: 500 }, { type: 'body', operator: 'not_contains', expected: 'boom' }] },
})
const notContainsRun = await api('POST', '/api/assets/run', { workspaceId, assetId: notContainsAsset.body.asset.id })
check(notContainsRun.body.result.pass === false, 'not_contains assertion fails when body contains value', JSON.stringify(notContainsRun.body.result?.assertions))
const inAsset = await api('POST', '/api/assets', {
  workspaceId, kind: 'api', module: '资产测试', name: 'in 断言', baseUrl,
  request: { method: 'GET', url: '/api/me', assertions: [{ type: 'status', operator: 'in', expected: [200, 201] }] },
})
const inRun = await api('POST', '/api/assets/run', { workspaceId, assetId: inAsset.body.asset.id })
check(inRun.body.result.pass === true, 'in assertion passes for listed status', JSON.stringify(inRun.body.result?.assertions))

// 版本安全门禁:安全类工作项未通过时拒绝保存
const pendingSecurityItem = await api('POST', '/api/cases', { workspaceId, name: '未通过安全项', type: 'security', priority: 'high', automation: 'auto', result: 'not_run', assets: [] })
const securityGateBlocked = await api('POST', '/api/versions', { workspaceId, name: '安全门禁版本', requireSecurity: true })
check(securityGateBlocked.status === 409 && (securityGateBlocked.body.code === 'security' || securityGateBlocked.body.message.includes('安全')), 'version security gate blocks failing security items', JSON.stringify(securityGateBlocked.body))

// 清理安全脚手架数据
for (const item of secApply.body.plan.assets) await api('DELETE', `/api/assets/${item.id}`, undefined, { workspaceId })
await api('DELETE', `/api/cases/${secWorkItemId}`, undefined, { workspaceId })
await api('DELETE', `/api/assets/${secSource.body.asset.id}`, undefined, { workspaceId })
await api('DELETE', `/api/assets/${badSecurityAsset.body.asset.id}`, undefined, { workspaceId })
await api('DELETE', `/api/assets/${notContainsAsset.body.asset.id}`, undefined, { workspaceId })
await api('DELETE', `/api/assets/${inAsset.body.asset.id}`, undefined, { workspaceId })
await api('DELETE', `/api/cases/${pendingSecurityItem.body.case.id}`, undefined, { workspaceId })

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
