/**
 * 客户端渲染冒烟测试(资产化模型):jsdom 渲染 4 个视图标签,验证:
 * 1. 视图门控与注册(基础配置 / 资产库 / 用例 / 版本);
 * 2. 资产库:状态徽章、执行、UI 子标签、批量补测按钮;
 * 3. 用例:资产组合展示、执行结果;
 * 4. 版本:待测计数、全量测试后保存版本、删除确认(自研 ConfirmDialog);
 * 5. 基础配置:环境卡片与数据工厂子标签。
 *
 * 运行:node smoke/client-render.mjs
 * (jsdom / react / react-dom 从仓库 node_modules 解析)
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const requireFromHere = createRequire(import.meta.url)
const clientSource = await readFile(resolve(here, '../lib/client.js'), 'utf8')

/**
 * 解析渲染测试依赖(jsdom / react / react-dom / test-utils):优先本包 devDependencies,
 * 回退到环境变量指定的 harness 仓库 node_modules。缺失时给出安装提示。
 * @param candidates - 候选模块说明符(按优先级)。
 * @returns 模块命名空间。
 */
async function loadDependency(candidates) {
  const errors = []
  for (const specifier of candidates) {
    try {
      return await import(specifier)
    } catch (error) {
      errors.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`无法解析测试依赖 ${candidates[0]};先在插件目录执行 npm install(devDependencies 含 jsdom/react/react-dom)。详情:${errors.join(' | ')}`)
}

const { JSDOM } = await loadDependency(['jsdom', process.env.DSH_REPO_NODE_MODULES ? resolve(process.env.DSH_REPO_NODE_MODULES, 'jsdom/lib/api.js') : 'jsdom'])
const reactModule = await loadDependency(['react'])
const reactDomModule = await loadDependency(['react-dom'])
const testUtilsUrl = (() => {
  try {
    return requireFromHere.resolve('react-dom/test-utils')
  } catch {
    return 'react-dom/test-utils'
  }
})()
const react = reactModule.default ?? reactModule
const ReactDOM = reactDomModule.default ?? reactDomModule
void (await import(testUtilsUrl))

let failed = 0
let passed = 0
/**
 * 记录断言结果。
 * @param condition - 断言条件。
 * @param label - 断言描述。
 * @param detail - 失败详情。
 */
function check(condition, label, detail) {
  if (condition) { passed++; console.log(`  PASS ${label}`) }
  else { failed++; console.log(`  FAIL ${label} ${detail ?? ''}`) }
}

// ── 可变 mock 状态 ─────────────────────────────────────────────────────
const state = {
  assets: [
    {
      id: 'api:login', kind: 'api', module: '登录', name: '登录接口', tags: ['冒烟'],
      source: { projectId: 'p1', collectionId: 'col-auth', collectionName: '登录认证' },
      baseUrl: 'http://x',
      request: {
        name: '登录', method: 'POST', url: '/api/login',
        headers: { 'content-type': 'application/json' },
        query: { page: '1' },
        body: '{"user":"{{USER}}"}',
        assertions: [{ type: 'status', operator: 'eq', expected: 200 }, { type: 'json', path: '$.token', operator: 'contains', expected: 'tok-' }],
        extract: [{ name: 'TOKEN', path: '$.token', export: true }],
      },
      status: 'solid', stats: { runs: 1, passed: 1, failed: 0, totalDurationMs: 5 },
      lastRun: { pass: true, at: '2026-01-01T00:00:00Z' },
      lastPassed: { at: '2026-01-01T00:00:00Z', request: { method: 'POST', url: '/api/login-passed' } },
    },
    {
      id: 'api:me', kind: 'api', module: '用户', name: '获取用户', tags: [],
      source: { projectId: 'p1', collectionId: 'col-user', collectionName: '用户接口' },
      baseUrl: 'http://x',
      request: { name: 'me', method: 'GET', url: '/api/me', headers: {}, query: {}, body: '', assertions: [{ type: 'status', operator: 'eq', expected: 200 }], extract: [] },
      status: 'failed', stats: { runs: 1, passed: 0, failed: 1, totalDurationMs: 1 },
      lastRun: { pass: false, at: '2026-01-02T00:00:00Z' },
    },
    {
      id: 'ui:login-flow', kind: 'ui', type: 'flow', module: '登录', name: '登录流程', tags: [],
      steps: [{ kind: 'open', url: 'http://x/login' }],
      status: 'untested',
    },
  ],
  cases: [
    { id: 'case-login', name: '登录用例', module: '登录', tags: ['冒烟'], type: 'functional', priority: 'high', requirement: 'REQ-登录-001', automation: 'auto', result: 'not_run', defects: ['#473'], assets: [{ assetId: 'api:login' }] },
    { id: 'case-e2e', name: '下单e2e', module: '订单', tags: [], type: 'e2e', priority: 'medium', requirement: 'REQ-下单-002', automation: 'partial', result: 'not_run', defects: [], assets: [] },
    { id: 'case-fail', name: '支付失败工作项', module: '支付', tags: [], type: 'functional', priority: 'low', requirement: 'REQ-支付-003', automation: 'manual', result: 'failed', defects: ['#474'], assets: [] },
  ],
  versions: [],
  pending: { total: 2, pending: 1, untested: 1, failed: 0, stale: 0, solid: 1 },
  calls: [],
}
/** 重算待测统计。 */
function recomputePending() {
  const pendingAssets = state.assets.filter((asset) => asset.status !== 'solid')
  state.pending = {
    total: state.assets.length,
    pending: pendingAssets.length,
    untested: pendingAssets.filter((asset) => asset.status === 'untested').length,
    failed: pendingAssets.filter((asset) => asset.status === 'failed').length,
    stale: 0,
    solid: state.assets.filter((asset) => asset.status === 'solid').length,
  }
}
/** 资产汇总。 */
function assetSummary() {
  return { total: state.assets.length, solid: state.pending.solid, failed: state.pending.failed, untested: state.pending.untested, stale: 0 }
}

/** 根据 URL/方法返回 mock 响应。 */
function makeFetchStub() {
  return async (url, init) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) })
    state.calls.push(`${method} ${u}`)
    if (u.includes('/api/assets/pending')) return json({ ok: true, assets: state.assets.filter((asset) => asset.status !== 'solid'), counts: state.pending })
    if (u.includes('/api/assets/run-batch')) {
      const body = JSON.parse(init.body)
      const results = (body.assetIds ?? []).map((assetId) => {
        const asset = state.assets.find((item) => item.id === assetId)
        if (asset) asset.status = 'solid'
        return { assetId, name: asset?.name, pass: true, status: 'solid' }
      })
      recomputePending()
      return json({ ok: true, batch: { requested: results.length, ran: results.length }, results, remaining: state.pending })
    }
    if (u.includes('/api/assets/run') && method === 'POST') {
      const body = JSON.parse(init.body)
      const asset = state.assets.find((item) => item.id === body.assetId)
      if (asset) asset.status = 'solid'
      recomputePending()
      return json({ ok: true, result: { assetId: body.assetId, name: asset?.name, pass: true }, asset })
    }
    if (u.includes('/api/assets?')) return json({ ok: true, assets: state.assets, summary: assetSummary() })
    if (u.includes('/api/assets')) return json({ ok: true, assets: state.assets, summary: assetSummary() })
    if (u.includes('/api/cases/') && u.endsWith('/run')) {
      return json({ ok: true, result: { name: '登录用例', durationMs: 3, summary: { total: 1, passed: 1, failed: 0, skipped: 0 }, results: [{ name: '登录接口', pass: true }], exports: {} } })
    }
    if (u.includes('/api/cases')) return json({ ok: true, cases: state.cases })
    if (u.includes('/api/versions/') && method === 'DELETE') {
      const id = u.split('/api/versions/')[1].split('?')[0]
      const index = state.versions.findIndex((version) => version.id === id)
      if (index >= 0) state.versions.splice(index, 1)
      return json({ ok: true })
    }
    if (u.includes('/compare')) return json({ ok: true, hasPrevious: false })
    if (u.includes('/api/versions') && method === 'POST') {
      if (state.pending.pending > 0) {
        return json({ ok: false, message: `还有 ${state.pending.pending} 个资产未通过或已过期,不能保存版本`, failing: state.assets.filter((asset) => asset.status !== 'solid').map((asset) => ({ id: asset.id, name: asset.name, status: asset.status })) }, 409)
      }
      const version = {
        id: `version-${state.versions.length + 1}`, name: '全量系统测试 1', createdAt: new Date().toISOString(),
        coverage: { assetsTotal: state.assets.length, assetsExecuted: state.assets.length, solid: state.assets.length, failed: 0, untested: 0 },
        summary: { total: state.assets.length, passed: state.assets.length, failed: 0 },
        byModule: [{ module: '登录', total: state.assets.length, passed: state.assets.length, failed: 0 }], failedAssets: [],
      }
      state.versions.unshift(version)
      return json({ ok: true, version })
    }
    if (u.includes('/api/versions')) return json({ ok: true, versions: state.versions })
    if (u.includes('/api/environments')) return json({ ok: true, environments: [{ id: 'env1', name: '测试环境', variables: { BASE_URL: 'http://x' } }], defaultEnvironmentId: 'env1' })
    if (u.includes('/api/tags')) return json({ ok: true, tags: ['冒烟', '登录'] })
    if (u.includes('/api/dbdata')) return json({ ok: true, tables: [], schemaText: '' })
    if (u.includes('/api/datafactory')) return json({ ok: true, generators: [{ id: 'g1', key: 'phone', name: '手机号', pattern: '{{rand.phone}}', builtin: true }] })
    if (u.includes('/api/session')) return json({ ok: true, variables: {} })
    return json({ ok: true })
  }
}

// ── 模块加载器模拟(只实现 load + factory 的 require("react")) ───────────
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
globalThis.HTMLElement = window.HTMLElement
globalThis.Node = window.Node
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true })
window.fetch = makeFetchStub()
let confirmCalls = 0
window.confirm = () => { confirmCalls++; return true }
window.HTMLElement.prototype.attachEvent = function () { return null }
window.HTMLElement.prototype.detachEvent = function () { return null }

let clientFactory = null
window.__ModuleLoader__ = { load: (def) => { clientFactory = def.factory } }
new Function('window', clientSource)(window)
check(typeof clientFactory === 'function', 'client factory 已注册', '')

const factoryRequire = (name) => {
  if (name === 'react') return react
  throw new Error(`unexpected require: ${name}`)
}
const clientModule = clientFactory(factoryRequire)
check(typeof clientModule.apply === 'function' && clientModule.inject?.includes('slots'), 'client 模块结构正确', '')

// ── slots / 会话探针模拟 ─────────────────────────────────────────────────
const registered = []
const gatedRegistrations = []
const injectCalls = []
const slotsMock = {
  register: (def, component) => {
    const entry = { def, component }
    const bucket = def?.name === 'conversation.view' ? registered : gatedRegistrations
    bucket.push(entry)
    return () => {
      const index = bucket.indexOf(entry)
      if (index >= 0) bucket.splice(index, 1)
    }
  },
  inject: (key, callback) => {
    injectCalls.push(key)
    const disposers = callback()
    const list = Array.isArray(disposers) ? disposers : [disposers]
    return () => { for (const dispose of list) dispose?.() }
  },
}
let projectionPreset = 'dsh-test-mode'
const projectionFace = { getSnapshot: () => projectionPreset, subscribe: () => () => {} }
const sessionsMock = {
  list: {
    getSnapshot: () => ({ current: 's1', byId: { s1: { sessionId: 's1' } } }),
    subscribe: () => () => {},
  },
  binding: (id) => (id === 's1'
    ? { sessionId: 's1', session: { projections: { faceOf: (key) => (key === 'agentPreset' ? projectionFace : undefined) } } }
    : undefined),
}
const ctxMock = {
  slots: slotsMock,
  sessions: sessionsMock,
  effect: (fn) => { fn(); return () => {} },
}
clientModule.apply(ctxMock)
check(injectCalls.includes('conversation.view') && injectCalls.includes('conversation.session.header.utilities'), '注入视图槽与会话头部探针槽', JSON.stringify(injectCalls))
const probeEntry = gatedRegistrations.find((entry) => entry.def.id === 'dsh-test-mode-view-gate')
check(probeEntry !== undefined, '会话头部挂载了视图门控探针', gatedRegistrations.map((entry) => entry.def.id).join(','))

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms))
/** 渲染门控探针,按 agentPreset 注册/注销视图。 */
async function renderProbe(preset) {
  document.body.innerHTML = '<div id="root"></div>'
  const rootEl = document.getElementById('root')
  ReactDOM.render(react.createElement(probeEntry.component, {
    useProjection: (key) => (key === 'agentPreset' ? preset : undefined),
  }), rootEl)
  await sleep(20)
  return rootEl
}
await renderProbe('dsh-test-mode')
check(registered.length === 4, `测试模式会话注册 4 个视图(实际 ${registered.length})`, registered.map((entry) => entry.def.id).join(','))
check(registered.every((entry) => ['dsh-test-mode-environments', 'dsh-test-mode-assets', 'dsh-test-mode-cases', 'dsh-test-mode-versions'].includes(entry.def.id)), '顶层视图为基础配置/资产库/用例/版本', registered.map((entry) => entry.def.id).join(','))
await renderProbe('standard')
check(registered.length === 0, '非测试模式会话注销全部视图', registered.map((entry) => entry.def.id).join(','))
await renderProbe('dsh-test-mode')
check(registered.length === 4, '切回测试模式会话重新注册 4 个视图', registered.map((entry) => entry.def.id).join(','))

const viewProps = {
  sessionId: 's1',
  useProjection: (key) => (key === 'agentPreset' ? projectionPreset : undefined),
  useWorkspaces: (selector) => selector({ items: [{ workspaceId: 'ws-1', sessionIds: ['s1'] }] }),
  inputActions: { setDraft: () => {} },
}

/** 渲染指定视图,并等待 fetch 落定。 */
async function renderView(viewId) {
  const entry = registered.find((item) => item.def.id === viewId)
  if (!entry) throw new Error(`找不到视图 ${viewId}`)
  document.body.innerHTML = '<div id="root"></div>'
  const rootEl = document.getElementById('root')
  ReactDOM.render(react.createElement(entry.component, viewProps), rootEl)
  await sleep(40)
  return rootEl
}
/** 按文本找按钮。 */
function findButton(rootEl, text) {
  return [...rootEl.querySelectorAll('button')].find((button) => button.textContent.trim().includes(text))
}

// ── 1. 基础配置 ─────────────────────────────────────────────────────────
console.log('\n=== 基础配置 ===')
{
  const rootEl = await renderView('dsh-test-mode-environments')
  check(rootEl.textContent.includes('测试环境'), '默认环境卡片渲染', rootEl.textContent.slice(0, 120))
  const factoryTab = findButton(rootEl, '数据工厂')
  check(factoryTab !== undefined, '基础配置含「数据工厂」子标签', '')
  if (factoryTab) {
    factoryTab.click()
    await sleep(40)
    check(rootEl.textContent.includes('手机号'), '数据工厂子标签渲染生成器', rootEl.textContent.slice(0, 160))
  }
}

// ── 2. 资产库 ───────────────────────────────────────────────────────────
console.log('\n=== 资产库 ===')
{
  const rootEl = await renderView('dsh-test-mode-assets')
  check(rootEl.textContent.includes('登录接口') && rootEl.textContent.includes('已固化'), '接口资产显示已固化状态', rootEl.textContent.slice(0, 160))
  check(rootEl.textContent.includes('登录') && rootEl.textContent.includes('未测试'), '树形清单按模块分组并显示状态', rootEl.textContent.slice(0, 160))
  check(rootEl.textContent.includes('Headers') && rootEl.textContent.includes('Query') && rootEl.textContent.includes('断言') && rootEl.textContent.includes('变量提取'), '右侧富编辑器显示 Headers/Query/断言/变量提取', rootEl.textContent.slice(0, 240))
  check(rootEl.textContent.includes('执行 1 次(通过 1 / 失败 0)'), '资产显示累计执行统计', '')
  const curlInput = [...rootEl.querySelectorAll('input')].find((input) => input.value === '/api/login')
  check(curlInput !== undefined, 'URL 配置回显到编辑器', [...rootEl.querySelectorAll('input')].map((input) => input.value).join('|').slice(0, 120))
  const inputValues = [...rootEl.querySelectorAll('input')].map((input) => input.value)
  check(inputValues.includes('tok-') && inputValues.includes('200') && inputValues.includes('$.token'), '断言配置回显到编辑器', inputValues.join('|').slice(0, 160))
  check(findButton(rootEl, '测试待测资产') !== undefined, '显示待测资产批量补测按钮', '')
  const runButton = [...rootEl.querySelectorAll('button')].filter((button) => button.textContent.trim() === '执行')[0]
  check(runButton !== undefined, '资产详情有执行按钮', '')
  if (runButton) {
    runButton.click()
    await sleep(80)
    check(rootEl.textContent.includes('通过'), '执行资产后给出结果提示', rootEl.textContent.slice(-160))
  }
  // 目录折叠:默认只展开当前选中资产所在模块;点击其它模块自动折叠原模块并展开新模块
  const moduleButton = (name) => [...rootEl.querySelectorAll('[data-testid="asset-module"]')].find((el) => el.getAttribute('data-module') === name)
  const collectionButton = (name) => [...rootEl.querySelectorAll('[data-testid="asset-collection"]')].find((el) => el.getAttribute('data-collection') === name)
  check(moduleButton('用户') !== undefined && moduleButton('登录') !== undefined, '树形清单渲染模块目录', '')
  check(moduleButton('登录').textContent.includes('1/1'), '模块目录显示已固化/总数', moduleButton('登录').textContent)
  check(moduleButton('用户').textContent.includes('0/1'), '未固化模块显示 0/1', moduleButton('用户').textContent)
  check(!rootEl.textContent.includes('获取用户'), '未选中的模块默认折叠', rootEl.textContent.slice(0, 160))
  check(collectionButton('登录认证') !== undefined, '选中资产所在模块自动展开集合', '')
  check(collectionButton('登录认证').textContent.includes('1/1'), '集合目录显示已固化/总数', collectionButton('登录认证').textContent)
  moduleButton('用户').click()
  await sleep(30)
  check(rootEl.textContent.includes('获取用户') && !rootEl.textContent.includes('登录接口'), '点击模块展开新目录并自动折叠其它目录', rootEl.textContent.slice(0, 200))
  moduleButton('登录').click()
  await sleep(30)
  check(rootEl.textContent.includes('登录接口') && !rootEl.textContent.includes('获取用户'), '再次切换目录手风琴生效', rootEl.textContent.slice(0, 200))
  const collectionToggle = collectionButton('登录认证')
  if (collectionToggle) {
    collectionToggle.click()
    await sleep(30)
    check(!rootEl.textContent.includes('登录接口'), '集合目录可折叠', rootEl.textContent.slice(0, 200))
    collectionToggle.click()
    await sleep(30)
    check(rootEl.textContent.includes('登录接口'), '集合目录可展开', rootEl.textContent.slice(0, 200))
  }
  // 状态汇总徽章可点击筛选(已固化/过期/失败/未测试)
  const statusChip = (value) => [...rootEl.querySelectorAll('[data-status-filter]')].find((el) => el.getAttribute('data-status-filter') === value)
  check(statusChip('solid') !== undefined && statusChip('failed') !== undefined, '状态汇总徽章可点击', '')
  check(statusChip('solid').textContent.includes('1') && statusChip('failed').textContent.includes('1'), '状态徽章显示当前标签计数', `${statusChip('solid').textContent}|${statusChip('failed').textContent}`)
  statusChip('failed').click()
  await sleep(40)
  check(rootEl.textContent.includes('获取用户') && !rootEl.textContent.includes('登录接口'), '点击「失败」只显示失败资产', rootEl.textContent.slice(0, 200))
  check(rootEl.textContent.includes('筛选出 1 项'), '状态筛选显示命中数量', '')
  statusChip('failed').click()
  await sleep(40)
  check(!rootEl.textContent.includes('筛选出'), '再次点击取消状态筛选', '')
  // 恢复选中已固化的登录接口(筛选后选中项变为失败资产)
  moduleButton('登录').click()
  await sleep(30)
  const loginRow = [...rootEl.querySelectorAll('[data-testid="asset-row"]')].find((el) => el.getAttribute('data-asset-id') === 'api:login')
  loginRow?.click()
  await sleep(30)
  const usePassed = findButton(rootEl, '使用上次通过的数据')
  check(usePassed !== undefined, '已固化接口提供「使用上次通过的数据」', '')
  if (usePassed) {
    usePassed.click()
    await sleep(40)
    const passedInput = [...rootEl.querySelectorAll('input')].find((input) => input.value === '/api/login-passed')
    check(passedInput !== undefined, '通过数据可填回编辑器', '')
  }
  const uiTab = findButton(rootEl, 'UI 流程')
  check(uiTab !== undefined, '含 UI 流程子标签', '')
  if (uiTab) {
    uiTab.click()
    await sleep(40)
    check(rootEl.textContent.includes('登录流程') && rootEl.textContent.includes('未测试'), 'UI 流程资产显示未测试', rootEl.textContent.slice(0, 160))
  }
  const createButton = findButton(rootEl, '+ 新建资产')
  check(createButton !== undefined, '资产库有新建入口', '')
}

// ── 3. 测试工作项(功能/e2e/性能/安全) ────────────────────────────────────
console.log('\n=== 测试工作项 ===')
{
  const rootEl = await renderView('dsh-test-mode-cases')
  check(rootEl.textContent.includes('测试工作项'), '工作项视图标题', rootEl.textContent.slice(0, 120))
  check(['功能测试', 'e2e测试', '性能测试', '安全测试'].every((label) => findButton(rootEl, label) !== undefined), '工作项包含四类测试 tab', '')
  // 紧凑卡片:默认只显示标题/优先级/结果/关联缺陷(2 行)
  const card = () => [...rootEl.querySelectorAll('[data-testid="work-item-card"]')].find((el) => el.textContent.includes('登录用例'))
  check(card() !== undefined, '工作项以紧凑卡片展示', '')
  check(rootEl.textContent.includes('优先级 高') && rootEl.textContent.includes('结果:未执行') && rootEl.textContent.includes('#473'), '紧凑卡片显示标题/优先级/结果/关联缺陷', rootEl.textContent.slice(0, 240))
  check(rootEl.textContent.includes('需求: REQ-登录-001'), '紧凑卡片显示需求摘要', rootEl.textContent.slice(0, 240))
  check([...rootEl.querySelectorAll('button')].every((button) => button.textContent.trim() !== '执行'), '紧凑卡片默认不显示操作按钮', '')
  check(!rootEl.textContent.includes('下单e2e'), '其它类型的工作项不在当前 tab 显示', '')
  // 快速筛选:结果 / 优先级
  const chip = (group, value) => [...rootEl.querySelectorAll(`[data-filter-group="${group}"]`)].find((el) => el.getAttribute('data-filter-value') === value)
  check(chip('result', 'failed') !== undefined && chip('priority', 'high') !== undefined, '筛选栏有结果/优先级快捷按钮', '')
  check(rootEl.textContent.includes('支付失败工作项'), '功能测试下显示全部工作项', '')
  chip('result', 'failed').click()
  await sleep(30)
  check(rootEl.textContent.includes('支付失败工作项') && !rootEl.textContent.includes('登录用例'), '按执行结果筛选(失败)', rootEl.textContent.slice(0, 200))
  check(rootEl.textContent.includes('筛选出 1 项'), '筛选后显示命中数量', '')
  chip('result', '').click()
  await sleep(30)
  chip('priority', 'high').click()
  await sleep(30)
  check(rootEl.textContent.includes('登录用例') && !rootEl.textContent.includes('支付失败工作项'), '按优先级筛选(高)', rootEl.textContent.slice(0, 200))
  chip('priority', '').click()
  await sleep(30)
  check(rootEl.textContent.includes('登录用例') && rootEl.textContent.includes('支付失败工作项'), '清空筛选恢复全部', '')
  const e2eTab = findButton(rootEl, 'e2e测试')
  if (e2eTab) {
    e2eTab.click()
    await sleep(30)
    check(rootEl.textContent.includes('下单e2e') && !rootEl.textContent.includes('登录用例'), '切换 e2e 测试 tab 只显示 e2e 工作项', rootEl.textContent.slice(0, 200))
  }
  const funcTab = findButton(rootEl, '功能测试')
  if (funcTab) { funcTab.click(); await sleep(30) }
  // 点击卡片展开详情
  card()?.click()
  await sleep(30)
  check(rootEl.textContent.includes('关联需求:') && rootEl.textContent.includes('关联缺陷:') && rootEl.textContent.includes('自动化状态:'), '点击卡片展开详情', rootEl.textContent.slice(0, 300))
  check(rootEl.textContent.includes('1 个资产'), '展开后显示资产组合', '')
  const runButton = [...rootEl.querySelectorAll('button')].find((button) => button.textContent.trim() === '执行')
  check(runButton !== undefined, '展开后显示执行/编辑/删除按钮', '')
  if (runButton) {
    runButton.click()
    await sleep(60)
    check(rootEl.textContent.includes('工作项执行') && rootEl.textContent.includes('1/1 通过'), '执行工作项显示通过结果', rootEl.textContent.slice(-200))
  }
  check(findButton(rootEl, '+ 新建工作项') !== undefined, '工作项页有新建入口', '')
  findButton(rootEl, '+ 新建工作项')?.click()
  await sleep(30)
  check(rootEl.textContent.includes('新建工作项') && rootEl.textContent.includes('关联需求'), '新建工作项编辑器含标题/需求字段', rootEl.textContent.slice(0, 200))
  check(rootEl.textContent.includes('关联缺陷') && rootEl.textContent.includes('自动化状态'), '新建工作项编辑器含自动化状态/关联缺陷', '')
}

// ── 4. 版本 ─────────────────────────────────────────────────────────────
console.log('\n=== 版本 ===')
{
  const rootEl = await renderView('dsh-test-mode-versions')
  check(rootEl.textContent.includes('待测资产 2') && rootEl.textContent.includes('版本'), '版本页显示待测资产计数', rootEl.textContent.slice(0, 160))
  const saveButton = findButton(rootEl, '保存为版本')
  check(saveButton !== undefined, '版本页有「保存为版本」按钮(由服务端校验)', JSON.stringify(saveButton?.disabled))
  const runButton = findButton(rootEl, '发起全量系统测试')
  check(runButton !== undefined, '版本页有全量测试入口', '')
  if (runButton) {
    runButton.click()
    await sleep(200)
    check(rootEl.textContent.includes('全量测试完成'), '全量测试批量执行并给出完成提示', rootEl.textContent.slice(-200))
    check(state.pending.pending === 0, '全量测试后没有待测资产', JSON.stringify(state.pending))
  }
  const saveAfter = findButton(rootEl, '保存为版本')
  if (saveAfter) {
    saveAfter.click()
    await sleep(80)
    check(rootEl.textContent.includes('版本已保存') && rootEl.textContent.includes('全量系统测试 1'), '保存版本成功并出现在列表', rootEl.textContent.slice(-200))
  }
  const deleteButton = [...rootEl.querySelectorAll('button')].filter((button) => button.textContent.trim() === '删除')[0]
  check(deleteButton !== undefined, '版本卡片有删除按钮', '')
  if (deleteButton) {
    deleteButton.click()
    await sleep(30)
    check(rootEl.textContent.includes('删除版本「全量系统测试 1」?'), '删除版本弹出自研 ConfirmDialog', rootEl.textContent.slice(-200))
    check(confirmCalls === 0, '删除不调用 window.confirm', String(confirmCalls))
    const cancelButton = [...rootEl.querySelectorAll('button')].find((button) => button.textContent.trim() === '取消')
    cancelButton.click()
    await sleep(20)
    check(state.versions.length === 1, '取消删除后版本仍存在', String(state.versions.length))
  }
}

// ── 5. 版本保存前置校验(失败清单) ───────────────────────────────────────
console.log('\n=== 版本保存校验 ===')
{
  state.assets.push({
    id: 'api:broken', kind: 'api', module: '登录', name: '坏接口', tags: [],
    request: { method: 'GET', url: '/api/broken' }, baseUrl: 'http://x', status: 'failed',
  })
  state.assets.find((asset) => asset.id === 'ui:login-flow').status = 'untested'
  recomputePending()
  const rootEl = await renderView('dsh-test-mode-versions')
  const saveButton = findButton(rootEl, '保存为版本')
  if (saveButton) {
    saveButton.click()
    await sleep(80)
    check(rootEl.textContent.includes('还不能保存版本') && rootEl.textContent.includes('坏接口'), '保存版本被拒并列出失败资产', rootEl.textContent.slice(-220))
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
