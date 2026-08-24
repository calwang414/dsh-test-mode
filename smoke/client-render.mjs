/**
 * 客户端渲染冒烟测试:jsdom 渲染 7 个视图标签,验证:
 * 1. 每个视图都能挂载渲染(不抛错、不空白);
 * 2. 点击「删除」弹出自研 ConfirmDialog(绝不调用 window.confirm);
 * 3. 确认弹窗可取消、可确认(确认走 fetch DELETE)。
 *
 * 运行:node smoke/client-render.mjs
 * (jsdom / react / react-dom 从仓库 node_modules 解析)
 */

import { JSDOM } from '/Users/calwang/dev/code/deepseek-harness/node_modules/jsdom/lib/api.js'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const clientSource = await readFile(resolve(here, '../lib/client.js'), 'utf8')

// react / react-dom(仓库 .pnpm store,直接指到包入口)
const reactPath = '/Users/calwang/dev/code/deepseek-harness/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js'
const reactDomPath = '/Users/calwang/dev/code/deepseek-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/index.js'
const react = (await import(reactPath)).default ?? (await import(reactPath))
const ReactDOM = (await import(reactDomPath)).default ?? (await import(reactDomPath))
const TestUtils = await import('/Users/calwang/dev/code/deepseek-harness/node_modules/.pnpm/react-dom@18.3.1_react@18.3.1/node_modules/react-dom/test-utils.js')

let failed = 0
let passed = 0
function check(condition, label, detail) {
  if (condition) { passed++; console.log(`  PASS ${label}`) }
  else { failed++; console.log(`  FAIL ${label} ${detail ?? ''}`) }
}

// ── 每个视图的 mock 数据(按 URL 后缀返回) ───────────────────────────────
const DATASETS = {
  '/api/cases': { ok: true, cases: [{ id: 'c1', name: '登录用例', description: '', priority: 'high', status: 'active', tags: [], steps: [{ action: 'GET /api/me', expected: 'ok' }] }] },
  '/api/projects': {
    ok: true,
    projects: [{
      id: 'p1', name: '订单服务', baseUrl: 'http://127.0.0.1:9999',
      collections: [
        { id: 'col1', name: '订单接口', requests: [{ id: 'r1', name: '创建订单', method: 'POST', url: '/orders', headers: [], query: [], body: '', assertions: [], extract: [] }] },
        // 旧数据:集合/请求无 id,前端应用 name 兜底
        { name: '无ID集合', requests: [{ name: '无ID请求', method: 'GET', url: '/x', headers: [], query: [], body: '', assertions: [], extract: [] }] },
      ],
    }],
  },
  '/api/plans': { ok: true, plans: [
    { id: 'plan1', name: '回归计划', entries: [{ kind: 'case', caseId: 'c1' }] },
    { id: 'tpl1', name: '全量回归模板', template: true, entries: [{ kind: 'collection', projectId: 'p1', collectionId: 'col1' }] },
  ] },
  '/api/ui/scripts': { ok: true, scripts: [{ id: 's1', name: '登录流程', steps: [] }] },
  '/api/ui/elements': { ok: true, elements: [{ id: 'e1', key: 'login-btn', selector: '#login', page: '/login', description: '' }] },
  '/api/environments': { ok: true, environments: [{ id: 'env1', name: '测试环境', variables: { BASE_URL: 'http://x' } }], defaultEnvironmentId: 'env1' },
  '/api/tags': { ok: true, tags: ['冒烟', '登录'] },
  '/api/dbdata': { ok: true, tables: [{ name: 'users', format: 'csv', columns: ['id', 'name'], rowCount: 2, sample: [['1', 'alice'], ['2', 'bob']] }], schemaText: '# users 表\n' },
  '/api/datafactory': { ok: true, generators: [{ id: 'g1', key: 'username', name: '用户名', pattern: 'user_{{rand.number:100:999}}', builtin: false }, { id: 'g2', key: 'phone', name: '手机号', pattern: '{{rand.phone}}', builtin: true }] },
  '/api/reports': { ok: true, reports: [
    { id: 'rep1', name: '回归报告', kind: 'collection', summary: { total: 2, passed: 2, failed: 0 }, durationMs: 12, createdAt: '2026-01-01T00:00:00Z', results: [] },
    { id: 'rep2', name: '回归报告', kind: 'collection', summary: { total: 2, passed: 1, failed: 1 }, durationMs: 20, createdAt: '2026-01-02T00:00:00Z', results: [
      { id: 'r1', name: '获取用户', method: 'GET', url: 'http://x/api/me', pass: false, status: 500, durationMs: 12, assertions: [{ type: 'status', operator: 'eq', expected: 200, pass: false }] },
    ] },
  ] },
  '/api/changelogs': { ok: true, changelogs: [
    { id: 'chg1', name: 'v1.2 变更', source: 'openapi-diff', createdAt: '2026-01-03T00:00:00Z', changedRequests: [{ method: 'GET', url: '/api/me', change: 'modified' }] },
  ] },
  '/api/stats/interfaces': { ok: true, interfaces: [{ method: 'GET', url: 'http://x/api/me', total: 3, passed: 2, failed: 1, successRate: 67, avgDurationMs: 15, lastPass: false, lastStatus: 500, lastAt: '2026-01-02T00:00:00Z' }] },
  '/api/stats/failures': { ok: true, topFailedRequests: [{ method: 'GET', url: 'http://x/api/me', failCount: 1 }], topFailedAssertions: [{ label: 'status eq 200', failCount: 2 }] },
}

let confirmCalls = 0
let deleteCalls = 0
let planPostCalls = 0

function makeFetchStub() {
  return async (url, init) => {
    const u = String(url)
    const method = init?.method ?? 'GET'
    if (method === 'DELETE') deleteCalls++
    if (u.includes('/api/plans') && method === 'POST' && !u.includes('incremental-preview')) planPostCalls++
    if (u.includes('/api/plans/incremental-preview')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, fromChangelog: 1, changedRequests: 2, changedCases: 1, coveringCases: 1, changedScripts: 1, affectedScripts: 1, tableCases: 1, moduleCases: 1, totalEntries: 2, gaps: [{ method: 'POST', url: '/api/x', path: '/api/x' }] }), text: async () => '{}' }
    }
    if (u.includes('/api/datafactory/preview')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, samples: ['13800001234', '13911112222', '13733334444'] }), text: async () => '{}' }
    }
    if (u.includes('/api/tags') && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true, tags: ['冒烟', '登录', '回归'] }), text: async () => '{}' }
    }
    if (u.includes('/compare')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, hasPrevious: true, previous: { id: 'rep1', summary: { total: 2, passed: 2, failed: 0 }, durationMs: 12 }, diff: { failedDelta: 1, durationDeltaMs: 8, newFailures: [{ method: 'GET', url: 'http://x/api/me', error: 'boom' }], fixedCount: 0 } }), text: async () => '{}' }
    }
    if (u.includes('/api/reports/')) {
      const id = u.split('/api/reports/')[1].split('?')[0]
      const report = DATASETS['/api/reports'].reports.find((r) => r.id === id)
      return { ok: true, status: 200, json: async () => ({ ok: true, report }), text: async () => '{}' }
    }
    for (const [suffix, payload] of Object.entries(DATASETS)) {
      if (u.includes(suffix)) {
        return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }
      }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{}' }
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
window.confirm = () => { confirmCalls++; return true }
// react-dom 在 jsdom 中走 input 事件 polyfill 分支,需要 attachEvent/detachEvent stub 避免报错
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

// ── 渲染 + 交互辅助 ──────────────────────────────────────────────────────

const views = [
  { id: 'cases', label: '用例', name: 'CasesView', component: clientModule.views?.find?.() ?? null },
]

// 从模块导出读视图组件(工厂内部没有导出视图,这里直接读取 apply 里的闭包不可行;
// 改为通过 slots.register 捕获注册的组件)。
const registered = []
const slotsMock = {
  register: (def, component) => {
    registered.push({ def, component })
    return () => {}
  },
}
const sessionsMock = {
  list: {
    getSnapshot: () => ({ current: 's1', byId: { s1: { agentPreset: 'dsh-test-mode' } } }),
    subscribe: () => () => {},
  },
}
const ctxMock = {
  slots: slotsMock,
  sessions: sessionsMock,
  effect: (fn) => { fn(); return () => {} },
}
clientModule.apply(ctxMock)
check(registered.length === 7, `注册了 7 个视图(实际 ${registered.length})`,
  registered.map((r) => r.def.id).join(','))

let lastDraft = null
const viewProps = {
  sessionId: 's1',
  useWorkspaces: (selector) => selector({ items: [{ workspaceId: 'ws-1', sessionIds: ['s1'] }] }),
  inputActions: { setDraft: (text) => { lastDraft = text } },
}

function findAllButtons(container) {
  return [...container.querySelectorAll('button')]
}
function findByText(buttons, text) {
  return buttons.find((b) => b.textContent.trim().includes(text))
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function renderView(component) {
  document.body.innerHTML = '<div id="root"></div>'
  const rootEl = document.getElementById('root')
  ReactDOM.render(react.createElement(component, viewProps), rootEl)
  // 等 useEffect 的 fetch + setState 落定
  await sleep(30)
  return rootEl
}

function assertNoConfirmDialog(rootEl) {
  const text = rootEl.textContent
  return !text.includes('取消') || !text.includes('?')
}


// 每个视图:渲染 → 点删除 → 断言弹窗出现 & confirm 未被调用 → 点取消关闭
const cases = [
  { view: 'dsh-test-mode-cases', triggerText: '删除', dialogMessage: '删除用例「登录用例」?' },
  { view: 'dsh-test-mode-api', triggerText: '删项目', dialogMessage: '删除项目「订单服务」?' },
  { view: 'dsh-test-mode-plans', triggerText: '删除', triggerParentText: '回归计划', dialogMessage: '删除计划「回归计划」?' },
  { view: 'dsh-test-mode-environments', triggerText: '删除', dialogMessage: '删除环境「测试环境」?' },
  { view: 'dsh-test-mode-ui', triggerText: '删除', dialogMessage: '删除脚本「登录流程」?' },
  { view: 'dsh-test-mode-reports', triggerText: '删除', dialogMessage: '删除这份报告?' },
]

/** 查找文本匹配的按钮;指定 parentText 时限定在包含该文本的卡片内(计划页模板卡片先渲染)。 */
function findTrigger(buttons, text, parentText) {
  const matches = buttons.filter((b) => b.textContent.trim().includes(text))
  if (!parentText) return matches[0]
  return matches.find((b) => b.parentElement?.parentElement?.textContent.includes(parentText))
}

for (const item of cases) {
  const entry = registered.find((r) => r.def.id === item.view)
  if (!entry) { check(false, `${item.view} 已注册`, 'view 未注册'); continue }
  const label = item.view.replace('dsh-test-mode-', '')
  let rootEl
  try {
    rootEl = await renderView(entry.component)
  } catch (e) {
    check(false, `${label} 渲染`, e.message)
    continue
  }
  check(rootEl.textContent.length > 0, `${label} 渲染出内容`, '')

  // API 视图:需要先选中项目才会出现「删项目」按钮
  if (item.view === 'dsh-test-mode-api') {
    const projectRow = [...rootEl.querySelectorAll('[role="button"]')].find((el) => el.textContent.includes('订单服务'))
    if (!projectRow) { check(false, `${label} 项目行存在`, '未找到项目行'); continue }
    projectRow.click()
    await sleep(20)
  }

  const buttons = findAllButtons(rootEl)
  const trigger = findTrigger(buttons, item.triggerText, item.triggerParentText)
  if (!trigger) { check(false, `${label} 删除按钮存在`, '未找到触发按钮'); continue }
  confirmCalls = 0
  deleteCalls = 0
  trigger.click()
  await sleep(20)

  const dialogOpen = rootEl.textContent.includes(item.dialogMessage) && rootEl.textContent.includes('取消')
  check(dialogOpen, `${label} 删除弹出自研确认框`, `期望文案「${item.dialogMessage}」`)
  check(confirmCalls === 0, `${label} 未调用 window.confirm`, `confirm 被调了 ${confirmCalls} 次`)
  check(deleteCalls === 0, `${label} 未确认前不发起 DELETE`, `DELETE 已发 ${deleteCalls} 次`)

  // 点取消 → 关闭弹窗
  const cancelBtn = findByText(findAllButtons(rootEl), '取消')
  if (cancelBtn) {
    cancelBtn.click()
    await sleep(20)
    check(!rootEl.textContent.includes(item.dialogMessage), `${label} 取消后弹窗关闭`, '')
  }

  // 再点删除 → 点确认 → 发起 DELETE
  const trigger2 = findTrigger(findAllButtons(rootEl), item.triggerText, item.triggerParentText)
  if (trigger2) {
    trigger2.click()
    await sleep(20)
    const okBtn = [...findAllButtons(rootEl)].filter((b) => b.textContent.trim() === '删除').pop()
    if (okBtn) {
      okBtn.click()
      await sleep(20)
      check(deleteCalls === 1, `${label} 确认后发起 DELETE`, `DELETE 次数 ${deleteCalls}`)
    } else {
      check(false, `${label} 确认按钮存在`, '未找到确认按钮')
    }
  }
}

// API 视图的新建项目/集合:自研 PromptDialog 替代 window.prompt
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-api')
  const rootEl = await renderView(entry.component)
  let promptCalls = 0
  window.prompt = () => { promptCalls++; return 'X' }
  const addProjectBtn = findByText(findAllButtons(rootEl), '+ 项目')
  addProjectBtn.click()
  await sleep(20)
  check(rootEl.textContent.includes('新建项目') && rootEl.textContent.includes('确定'), 'API 新建项目用自研输入框', '')
  check(promptCalls === 0, 'API 新建项目未调用 window.prompt', `prompt 被调了 ${promptCalls} 次`)
}

// 环境选择器:API/用例/UI 三页默认统一为「(默认环境)」
{
  for (const [id, label] of [['dsh-test-mode-api', 'API'], ['dsh-test-mode-cases', '用例'], ['dsh-test-mode-ui', 'UI']]) {
    const entry = registered.find((r) => r.def.id === id)
    const rootEl = await renderView(entry.component)
    const select = [...rootEl.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.textContent.includes('默认环境')))
    check(select !== undefined && select.value === '', `${label} 页 环境默认(默认环境)`, select ? `value=${select.value}` : '无环境下拉')
  }
}

// API 树:点击分类只展开该分类的接口清单,可收缩可展开(手风琴)
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-api')
  const rootEl = await renderView(entry.component)
  const rowByText = (text) => [...rootEl.querySelectorAll('[role="button"]')].find((el) => el.textContent.includes(text))

  // 初始:项目行收起,无集合/请求
  check(!rootEl.textContent.includes('订单接口'), 'API 树 初始集合不可见', '')
  rowByText('订单服务').click()
  await sleep(20)
  check(rootEl.textContent.includes('订单接口') && rootEl.textContent.includes('1'), 'API 树 点击项目展开集合列表', '')
  check(!rootEl.textContent.includes('创建订单'), 'API 树 集合默认收起,不显示接口清单', '')

  // 点击分类 → 只显示该分类的接口清单
  rowByText('订单接口').click()
  await sleep(20)
  check(rootEl.textContent.includes('创建订单'), 'API 树 点击分类展开接口清单', '')

  // 再点同一分类 → 收缩
  rowByText('订单接口').click()
  await sleep(20)
  check(!rootEl.textContent.includes('创建订单'), 'API 树 再次点击分类收缩接口清单', '')

  // 再点 → 又展开
  rowByText('订单接口').click()
  await sleep(20)
  check(rootEl.textContent.includes('创建订单'), 'API 树 第三次点击重新展开', '')

  // 点项目收起 → 整棵子树隐藏
  rowByText('订单服务').click()
  await sleep(20)
  check(!rootEl.textContent.includes('订单接口'), 'API 树 点击项目收缩整棵子树', '')
}

// API 树:无 id 集合(旧数据)点击只展开自身,不误展开其他分类
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-api')
  const rootEl = await renderView(entry.component)
  const rowByText = (text) => [...rootEl.querySelectorAll('[role="button"]')].find((el) => el.textContent.includes(text))
  rowByText('订单服务').click()
  await sleep(20)
  rowByText('无ID集合').click()
  await sleep(20)
  check(rootEl.textContent.includes('无ID请求'), 'API 树 无id分类点击只展开自身', '')
  check(!rootEl.textContent.includes('创建订单'), 'API 树 无id分类展开时其他分类保持收起', '')
  rowByText('无ID集合').click()
  await sleep(20)
  check(!rootEl.textContent.includes('无ID请求'), 'API 树 无id分类可收缩', '')
}

// API 请求编辑器:数据工厂按钮单一来源(后端合并列表),内置生成器不重复
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-api')
  const rootEl = await renderView(entry.component)
  const rowByText = (text) => [...rootEl.querySelectorAll('[role="button"]')].find((el) => el.textContent.includes(text))
  rowByText('订单服务').click()
  await sleep(20)
  rowByText('订单接口').click()
  await sleep(20)
  rowByText('创建订单').click()
  await sleep(20)
  const phoneCount = (rootEl.textContent.match(/手机号/g) ?? []).length
  check(phoneCount === 1, 'API 编辑器 内置生成器按钮不重复', `「手机号」出现 ${phoneCount} 次`)
  check(rootEl.textContent.includes('用户名 ✦'), 'API 编辑器 自定义生成器按钮存在', '')
  const phoneBtn = [...rootEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '手机号')
  phoneBtn.click()
  await sleep(20)
  check(rootEl.textContent.includes('{{rand.phone}}'), 'API 编辑器 点击内置生成器插入 token', '')
}

// 数据工厂页面:小卡片网格 + 点击弹窗详情(编辑/删除在弹窗内,内置只读)
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-datafactory')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  const cards = [...rootEl.querySelectorAll('[role="button"]')].filter((el) => el.textContent.includes('{{') )
  check(cards.length === 2, '数据工厂页 生成器小卡片渲染', `卡片数 ${cards.length}`)
  check(rootEl.textContent.includes('用户名 ✦'), '数据工厂页 自定义卡片带✦标记', '')
  check(!rootEl.textContent.includes('删除生成器'), '数据工厂页 列表本身无删除按钮(在弹窗内)', '')
  // 点击自定义卡片 → 详情弹窗(编辑/删除/示例)
  const customCard = cards.find((el) => el.textContent.includes('用户名'))
  customCard.click()
  await sleep(40)
  check(rootEl.textContent.includes('自定义') && rootEl.textContent.includes('{{factory.username}}'), '数据工厂页 弹窗显示类型与token', '')
  check(rootEl.textContent.includes('13800001234'), '数据工厂页 弹窗含示例预览', '')
  check(!rootEl.textContent.includes('插入到 Body'), '数据工厂页 弹窗无插入按钮', '')
  // 弹窗内点删除 → 确认弹窗 → 确认 → DELETE
  deleteCalls = 0
  const delInDialog = [...rootEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '删除')
  delInDialog.click()
  await sleep(20)
  check(rootEl.textContent.includes('删除生成器「用户名」?'), '数据工厂页 弹窗删除先出确认框', '')
  const okBtn = [...rootEl.querySelectorAll('button')].filter((b) => b.textContent.trim() === '删除').pop()
  okBtn.click()
  await sleep(20)
  check(deleteCalls === 1, '数据工厂页 确认后发起 DELETE', `DELETE 次数 ${deleteCalls}`)
  // 内置卡片 → 弹窗无编辑/删除按钮
  await renderView(entry.component)
  await sleep(30)
  const phoneCard = [...rootEl.querySelectorAll('[role="button"]')].find((el) => el.textContent.includes('手机号') && el.textContent.includes('{{rand.phone}}'))
  phoneCard.click()
  await sleep(40)
  const dialogBtns = [...rootEl.querySelectorAll('button')].map((b) => b.textContent.trim())
  check(rootEl.textContent.includes('内置') && !dialogBtns.includes('编辑') && !dialogBtns.includes('删除'), '数据工厂页 内置卡片弹窗只读', `按钮: ${dialogBtns.join(',')}`)
}


// 基础配置页(原环境页):环境/标签子标签 + 标签管理
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-environments')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  check(rootEl.textContent.includes('基础配置'), '基础配置页 标题', '')
  const tabBtn = [...rootEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '标签')
  check(tabBtn !== undefined, '基础配置页 有标签子标签', '')
  tabBtn.click()
  await sleep(20)
  check(rootEl.textContent.includes('冒烟') && rootEl.textContent.includes('登录'), '基础配置页 标签列表显示', '')
  // 新增标签(Simulate 走 React 合成事件,jsdom 原生 input 事件不可靠)
  const input = [...rootEl.querySelectorAll('input')].find((i) => i.placeholder?.includes('新标签名'))
  TestUtils.Simulate.change(input, { target: { value: '回归' } })
  await sleep(20)
  const addBtn = [...rootEl.querySelectorAll('button')].find((b) => b.textContent.includes('+ 添加'))
  addBtn.click()
  await sleep(20)
  check(rootEl.textContent.includes('回归'), '基础配置页 新增标签', '')
  // 删除标签 → 确认弹窗
  const delBtn = [...rootEl.querySelectorAll('button')].filter((b) => b.textContent.trim() === '×')
  delBtn[0].click()
  await sleep(20)
  check(rootEl.textContent.includes('删除标签'), '基础配置页 删除标签先确认', '')
}

// 用例编辑器:标签 chips 从标签库选择
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-cases')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  const newBtn = [...rootEl.querySelectorAll('button')].find((b) => b.textContent.includes('+ 新建用例'))
  newBtn.click()
  await sleep(20)
  check(rootEl.textContent.includes('冒烟'), '用例编辑器 标签库chips显示', '')
  const chip = [...rootEl.querySelectorAll('[role="button"]')].find((el) => el.textContent.trim() === '冒烟')
  chip.click()
  await sleep(10)
  check(rootEl.textContent.includes('冒烟 ✓'), '用例编辑器 点击chips选中标签', '')
}

// 基础配置页:数据参考子标签(解析的 dbdata 表展示)
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-environments')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  const tabBtn = [...rootEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '数据参考')
  check(tabBtn !== undefined, '基础配置页 有数据参考子标签', '')
  tabBtn.click()
  await sleep(30)
  check(rootEl.textContent.includes('users') && rootEl.textContent.includes('csv'), '数据参考 表列表显示', '')
  check(rootEl.textContent.includes('2 行') && rootEl.textContent.includes('id, name'), '数据参考 行数与字段', '')
  check(rootEl.textContent.includes('alice') && rootEl.textContent.includes('schema.md'), '数据参考 样例与schema', '')
}

// 一键 AI 生成按钮:各页「AI 生成」文字按钮存在,API 页缺口计数正确
{
  // API 页:两个按钮(所有接口 mock / 缺口 mock)
  let entry = registered.find((r) => r.def.id === 'dsh-test-mode-api')
  let rootEl = await renderView(entry.component)
  await sleep(30)
  const aiButtons = [...rootEl.querySelectorAll('button')].filter((b) => b.textContent.includes('AI 生成'))
  check(aiButtons.length === 2, 'API 页 两个 AI 生成按钮', `实际 ${aiButtons.length}`)
  check(aiButtons.some((b) => b.title?.includes('缺口')), 'API 页 缺口 mock 按钮', aiButtons.map((b) => b.title).join('|'))
  // 用例页:AI 生成按钮
  entry = registered.find((r) => r.def.id === 'dsh-test-mode-cases')
  rootEl = await renderView(entry.component)
  await sleep(30)
  check([...rootEl.querySelectorAll('button')].some((b) => b.textContent.includes('AI 生成')), '用例页 AI 生成按钮', '')
  // UI 页:脚本/元素库各有 AI 按钮
  entry = registered.find((r) => r.def.id === 'dsh-test-mode-ui')
  rootEl = await renderView(entry.component)
  await sleep(30)
  check([...rootEl.querySelectorAll('button')].some((b) => b.textContent.includes('AI 生成')), 'UI 页 AI 生成按钮(脚本tab)', '')
  const elTab = [...rootEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '元素库')
  elTab.click()
  await sleep(20)
  check([...rootEl.querySelectorAll('button')].some((b) => b.textContent.includes('AI 生成') && b.title?.includes('元素')), 'UI 页 AI 生成按钮(元素库tab)', '')
}

// mock 提示词内容:默认环境变量 + 真实接口清单;缺口提示词含缺口清单
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-api')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  lastDraft = null
  const allBtn = [...rootEl.querySelectorAll('button')].find((b) => b.textContent.includes('全部 mock'))
  allBtn.click()
  await sleep(10)
  check(lastDraft !== null && lastDraft.includes('默认环境变量') && lastDraft.includes('BASE_URL'), 'mock 提示词 含默认环境变量', lastDraft ?? '')
  check(lastDraft !== null && lastDraft.includes('创建订单') && lastDraft.includes('无ID请求'), 'mock 提示词 含全部项目真实接口清单', lastDraft ?? '')
  lastDraft = null
  const gapBtn = [...rootEl.querySelectorAll('button')].find((b) => b.textContent.includes('缺口 mock'))
  gapBtn.click()
  await sleep(10)
  check(lastDraft !== null && lastDraft.includes('缺口接口') && lastDraft.includes('从未测试'), '缺口 mock 提示词 含缺口清单', lastDraft ?? '')
}

// 场景用例提示词:业务场景驱动,接口融入用例
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-cases')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  lastDraft = null
  const sceneBtn = [...rootEl.querySelectorAll('button')].find((b) => b.textContent.includes('场景用例'))
  sceneBtn.click()
  await sleep(10)
  check(lastDraft !== null && lastDraft.includes('业务场景') && lastDraft.includes('接口融入用例'), '场景用例提示词 业务场景驱动', lastDraft ?? '')
  check(lastDraft !== null && lastDraft.includes('订单服务'), '场景用例提示词 含可用项目接口概况', lastDraft ?? '')
}

// 单用例 AI 完善:列表卡片编辑按钮旁有 AI 按钮,提示词含用例现状与接口概况
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-cases')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  lastDraft = null
  const improveBtn = [...rootEl.querySelectorAll('button')].find((b) => b.title?.includes('AI 完善该用例'))
  check(improveBtn !== undefined, '用例列表 单用例 AI 完善按钮', '')
  improveBtn.click()
  await sleep(10)
  check(lastDraft !== null && lastDraft.includes('完善测试用例') && lastDraft.includes('登录用例'), '单用例提示词 含用例现状', lastDraft ?? '')
  check(lastDraft !== null && lastDraft.includes('订单服务'), '单用例提示词 含接口概况', lastDraft ?? '')
}

// 用例编辑器:API 绑定步骤显示数据覆盖编辑区(URL/Body/Query/Headers)
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-cases')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  const newBtn = [...rootEl.querySelectorAll('button')].find((b) => b.textContent.includes('+ 新建用例'))
  newBtn.click()
  await sleep(20)
  // 新步骤默认手动;切换到 API 绑定后出现数据覆盖区
  const bindSelect = [...rootEl.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.textContent === 'API 请求'))
  bindSelect.value = 'api'
  bindSelect.dispatchEvent(new window.Event('change', { bubbles: true }))
  await sleep(20)
  check(rootEl.textContent.includes('数据覆盖(可选)'), '用例编辑器 API 步骤显示数据覆盖区', '')
  check([...rootEl.querySelectorAll('textarea')].some((t) => t.placeholder?.includes('Body 覆盖')), '用例编辑器 数据覆盖含 Body 编辑', '')
}

// 报告体系:筛选栏 / 统计 tab / 详情对比条 / 趋势折线
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-reports')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  check([...rootEl.querySelectorAll('input')].some((i) => i.placeholder?.includes('搜索报告名称')), '报告页 筛选搜索栏', '')
  check([...rootEl.querySelectorAll('select')].some((s) => [...s.options].some((o) => o.textContent === '类型:全部')), '报告页 类型筛选', '')
  // 统计 tab:接口健康度 + 失败 Top
  const statsTab = [...rootEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '统计')
  statsTab.click()
  await sleep(30)
  check(rootEl.textContent.includes('接口健康度') && rootEl.textContent.includes('/api/me'), '统计页 接口健康度', '')
  check(rootEl.textContent.includes('失败接口 Top') && rootEl.textContent.includes('失败断言 Top'), '统计页 失败 Top', '')
  // 详情:对比条 + 趋势
  const reportTab = [...rootEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '报告')
  reportTab.click()
  await sleep(20)
  const viewBtn = [...rootEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '查看')
  viewBtn.click()
  await sleep(40)
  check(rootEl.textContent.includes('与上次对比') && rootEl.textContent.includes('新失败'), '报告详情 对比条', '')
  check(rootEl.textContent.includes('回归趋势'), '报告详情 趋势折线', '')
}

// API 详情页:AI 生成 · 本接口 mock 按钮必须能把提示词填入输入框
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-api')
  const rootEl = await renderView(entry.component)
  const rowByText = (text) => [...rootEl.querySelectorAll('[role="button"]')].find((el) => el.textContent.includes(text))
  rowByText('订单服务').click()
  await sleep(20)
  rowByText('订单接口').click()
  await sleep(20)
  rowByText('创建订单').click()
  await sleep(20)
  lastDraft = null
  const mockBtn = findAllButtons(rootEl).find((b) => b.textContent.includes('本接口 mock'))
  check(mockBtn !== undefined, 'API 详情页 本接口 mock 按钮存在', '')
  mockBtn.click()
  await sleep(20)
  check(lastDraft !== null && lastDraft.includes('测试数据') && lastDraft.includes('创建订单'), 'API 详情页 AI 按钮填入输入框(含接口名)', lastDraft ?? '')
}

// ── 计划模块:AI 排计划 / 模板 / 多选弹窗 / 增量 / 复制 / 推荐补入 ──────
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-plans')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  const btns = () => findAllButtons(rootEl)
  check(findByText(btns(), 'AI 生成 · 排计划') !== undefined, '计划页 AI 排计划按钮', '')
  check(findByText(btns(), '重跑上次失败') !== undefined, '计划页 重跑上次失败按钮', '')
  check(findByText(btns(), '复制') !== undefined, '计划页 复制按钮', '')
  check(findByText(btns(), '刷新') !== undefined, '计划页 刷新按钮', '')
  check(rootEl.textContent.includes('模板(1)') && rootEl.textContent.includes('全量回归模板'), '计划页 模板区', '')
  check(findByText(btns(), '从模板新建') !== undefined, '计划页 从模板新建按钮', '')
  check(rootEl.textContent.includes('1 用例'), '计划页 条目摘要(1 用例)', '')
  // AI 排计划:意图输入 → draft 填充
  lastDraft = null
  findByText(btns(), 'AI 生成 · 排计划').click()
  await sleep(20)
  check(rootEl.textContent.includes('AI 排计划'), 'AI 排计划 弹出意图输入', '')
  const intentInput = [...rootEl.querySelectorAll('input')].pop()
  TestUtils.Simulate.change(intentInput, { target: { value: '增量:本次迭代涉及订单模块' } })
  await sleep(10)
  findByText(btns(), '确定').click()
  await sleep(20)
  check(lastDraft !== null && lastDraft.includes('创建测试计划') && lastDraft.includes('incremental') && lastDraft.includes('订单模块'), 'AI 排计划 draft 含意图与条目规范', lastDraft ?? '')
}

// 计划编辑器:四个添加弹窗 + 推荐补入 + 模板开关
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-plans')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  findByText(findAllButtons(rootEl), '+ 新建计划').click()
  await sleep(40) // 等推荐补入的 failures 拉取
  const btns = () => findAllButtons(rootEl)
  check(findByText(btns(), '+ 用例…') !== undefined, '计划编辑器 用例多选按钮', '')
  check(findByText(btns(), '+ 集合…') !== undefined, '计划编辑器 集合多选按钮', '')
  check(findByText(btns(), '+ UI 脚本…') !== undefined, '计划编辑器 UI 脚本按钮', '')
  check(findByText(btns(), '+ 增量变更…') !== undefined, '计划编辑器 增量按钮', '')
  check(rootEl.textContent.includes('存为模板'), '计划编辑器 模板开关', '')
  // 智能推荐:失败接口 /api/me 被 c1 覆盖
  check(rootEl.textContent.includes('建议补入') && rootEl.textContent.includes('登录用例'), '计划编辑器 推荐补入(失败接口覆盖用例)', '')
  // 用例多选弹窗:搜索 + 全选 + 添加
  findByText(btns(), '+ 用例…').click()
  await sleep(20)
  check([...rootEl.querySelectorAll('input')].some((i) => i.placeholder?.includes('搜索名称/描述/标签')), '用例弹窗 搜索框', '')
  check(findByText(btns(), '全选当前') !== undefined, '用例弹窗 全选按钮', '')
  findByText(btns(), '全选当前').click()
  await sleep(10)
  findByText(btns(), '添加 1 个').click()
  await sleep(20)
  check(rootEl.textContent.includes('登录用例'), '计划编辑器 添加用例条目', '')
  // 集合弹窗:一键全量
  findByText(btns(), '+ 集合…').click()
  await sleep(20)
  check(findByText(btns(), '全选全部项目(全量)') !== undefined, '集合弹窗 一键全量按钮', '')
  findByText(btns(), '全选全部项目(全量)').click()
  await sleep(20)
  check(rootEl.textContent.includes('订单服务 / 订单接口'), '计划编辑器 添加集合条目', '')
  // UI 脚本弹窗
  findByText(btns(), '+ UI 脚本…').click()
  await sleep(20)
  check(rootEl.textContent.includes('登录流程'), 'UI 弹窗 脚本列表', '')
  const scriptCheckbox = [...rootEl.querySelectorAll('input[type="checkbox"]')].pop()
  scriptCheckbox.click()
  await sleep(10)
  findByText(btns(), '添加 1 个').click()
  await sleep(20)
  check(rootEl.textContent.includes('登录流程') && rootEl.textContent.includes('UI'), '计划编辑器 添加 UI 条目', '')
}

// 增量变更弹窗:基线 + 预览 + 缺口 + 添加条目
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-plans')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  findByText(findAllButtons(rootEl), '+ 新建计划').click()
  await sleep(20)
  const btns = () => findAllButtons(rootEl)
  findByText(btns(), '+ 增量变更…').click()
  await sleep(30) // 等基线 reports 拉取
  check(rootEl.textContent.includes('增量变更(版本迭代)'), '增量弹窗 标题', '')
  check([...rootEl.querySelectorAll('input')].some((i) => i.type === 'datetime-local'), '增量弹窗 基线时间输入', '')
  findByText(btns(), '预览展开结果').click()
  await sleep(30)
  check(rootEl.textContent.includes('变更接口 2'), '增量弹窗 预览计数', '')
  check(rootEl.textContent.includes('暂无用例覆盖') && rootEl.textContent.includes('POST /api/x'), '增量弹窗 缺口提示', '')
  findByText(btns(), '添加增量条目').click()
  await sleep(20)
  check(rootEl.textContent.includes('增量') && rootEl.textContent.includes('执行时展开'), '计划编辑器 增量条目', '')
}

// 从模板新建 + 复制计划
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-plans')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  findByText(findAllButtons(rootEl), '从模板新建').click()
  await sleep(20)
  const editorNameInput = [...rootEl.querySelectorAll('input')].find((i) => i.value === '全量回归模板')
  check(rootEl.textContent.includes('从模板新建') && editorNameInput !== undefined, '从模板新建 打开编辑器并预填', editorNameInput ? '' : '名称未预填')
  findByText(findAllButtons(rootEl), '← 返回列表').click()
  await sleep(20)
  planPostCalls = 0
  findByText(findAllButtons(rootEl), '复制').click()
  await sleep(20)
  check(planPostCalls === 1, '复制计划 发起 POST /api/plans', `POST 次数 ${planPostCalls}`)
}

// 迭代增量:增量弹窗模块声明 + 来源拆分
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-plans')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  findByText(findAllButtons(rootEl), '+ 新建计划').click()
  await sleep(20)
  const btns = () => findAllButtons(rootEl)
  findByText(btns(), '+ 增量变更…').click()
  await sleep(30)
  check([...rootEl.querySelectorAll('button')].some((b) => b.textContent.trim() === '冒烟'), '增量弹窗 模块标签 chips', '')
  const moduleChip = [...rootEl.querySelectorAll('button')].find((b) => b.textContent.trim() === '登录')
  moduleChip.click()
  await sleep(10)
  findByText(btns(), '预览展开结果').click()
  await sleep(30)
  check(rootEl.textContent.includes('来源:变更清单'), '增量弹窗 来源拆分(变更清单)', '')
  check(rootEl.textContent.includes('UI 脚本 1/1'), '增量弹窗 预览含 UI 脚本计数', '')
  findByText(btns(), '添加增量条目').click()
  await sleep(20)
  check(rootEl.textContent.includes('模块:登录'), '计划编辑器 增量条目含模块声明', '')
}

// 用例页:AI 生成 · 智能绑定接口(存量 prose 用例补 requestRef)
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-cases')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  lastDraft = null
  const bindBtn = findAllButtons(rootEl).find((b) => b.textContent.includes('智能绑定接口'))
  check(bindBtn !== undefined, '用例页 智能绑定按钮存在', '')
  bindBtn.click()
  await sleep(20)
  check(lastDraft !== null && lastDraft.includes('requestRef') && lastDraft.includes('订单服务'), '智能绑定 draft 含绑定要求与接口概况', lastDraft ?? '')
}

// 报告详情:迭代归因徽章(失败接口出现在变更清单 → 「本版本已变更」)
{
  const entry = registered.find((r) => r.def.id === 'dsh-test-mode-reports')
  const rootEl = await renderView(entry.component)
  await sleep(30)
  const viewButtons = [...rootEl.querySelectorAll('button')].filter((b) => b.textContent.trim() === '查看')
  viewButtons[viewButtons.length - 1].click() // 列表尾部的 rep2(有失败结果)
  await sleep(40)
  check(rootEl.textContent.includes('本版本已变更'), '报告详情 失败项归因徽章(本版本已变更)', rootEl.textContent.slice(0, 200))
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
