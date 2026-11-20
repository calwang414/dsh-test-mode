/**
 * dsh-test-mode UI 自动化执行引擎:Host 半用 Playwright(playwright-core +
 * 系统 Chrome)直接驱动浏览器,不依赖会话里的 agent 浏览器工具。
 *
 * 步骤模型:
 * - `open` — 打开 URL;
 * - `click` — 点击(Playwright 自动等待可操作性);
 * - `type` — 填充输入框(React/Vue 受控组件原生兼容);`pressEnter: true` 回车;
 * - `press` — 按键;
 * - `assert_text` / `assert_url` / `assert_title` / `assert_element` — 断言
 *   (嵌套定位失败会带 Playwright 的等待超时信息);
 * - `eval` — 执行页面 JS 表达式,`exportAs` 可导出为变量;
 * - `wait` — 等待毫秒;
 * - `screenshot` — 截图存盘(相对路径落在 test-mode 数据根目录下)。
 *
 * 定位支持两种来源:步骤自带的 `selector`,或元素库引用 `element`(key 在
 * 元素库中解析)。selector/url/text/expression 均做变量替换(环境变量 +
 * 数据工厂,见 api-test.js 的 substitute)。
 *
 * 失败步骤默认终止脚本(`continueOnError` 可继续);失败时自动截图并附带
 * console/pageerror/请求失败诊断,写入报告。
 * @module @calwang414/dsh-test-mode/ui-test
 */

import { substitute } from './api-test.js'
import { launchDriver, writeScreenshot } from './browser-driver.js'

/** 单步默认超时(毫秒)。 */
const STEP_TIMEOUT_MS = 30_000
/** 脚本整体超时(毫秒)。 */
const SCRIPT_TIMEOUT_MS = 180_000

/**
 * 解析步骤的定位 selector:优先步骤自带 selector,否则按元素库 key 解析。
 * @param step - 脚本步骤。
 * @param elements - 元素库映射 { key: selector }。
 * @returns CSS selector;无法解析时抛错。
 */
function resolveSelector(step, elements) {
  if (typeof step.selector === 'string' && step.selector.trim()) return step.selector.trim()
  if (typeof step.element === 'string' && step.element.trim()) {
    const selector = elements?.[step.element.trim()]
    if (!selector) throw new Error(`element "${step.element}" is not defined in the element library`)
    return selector
  }
  throw new Error(`step requires a selector or an element reference (step ${step.name ?? 'unnamed'})`)
}

/**
 * 执行一步,返回 { pass, error?, detail?, exportAs? }。
 * @param session - 浏览器会话 { page, diagnostics }。
 * @param step - 步骤定义。
 * @param elements - 元素库映射。
 * @param variables - 变量表(环境变量)。
 * @param factories - 数据工厂表。
 * @param options - { root?, stepTimeoutMs? }。
 */
async function runStep(session, step, elements, variables, factories, options) {
  const { page } = session
  const s = (text) => substitute(text, variables, factories)
  const timeout = Math.max(Number(step.timeoutMs ?? options.stepTimeoutMs ?? STEP_TIMEOUT_MS) || STEP_TIMEOUT_MS, 1000)
  const kind = step.kind ?? 'eval'

  switch (kind) {
    case 'open': {
      const url = s(step.url ?? '')
      if (!url) throw new Error('open step requires a url')
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
      return { pass: true, detail: { url: page.url(), status: response?.status() ?? null } }
    }
    case 'click': {
      const selector = s(resolveSelector(step, elements))
      await page.click(selector, { timeout })
      return { pass: true, detail: { selector } }
    }
    case 'type': {
      const selector = s(resolveSelector(step, elements))
      const text = s(String(step.text ?? ''))
      await page.fill(selector, text, { timeout })
      if (step.pressEnter === true) await page.keyboard.press('Enter')
      const value = await page.inputValue(selector).catch(() => null)
      return { pass: true, detail: { selector, value } }
    }
    case 'press': {
      const key = s(String(step.key ?? ''))
      if (!key) throw new Error('press step requires a key')
      await page.keyboard.press(key)
      return { pass: true, detail: { key } }
    }
    case 'assert_text': {
      const hasTarget = (typeof step.selector === 'string' && step.selector.trim()) || (typeof step.element === 'string' && step.element.trim())
      const selector = hasTarget ? s(resolveSelector(step, elements)) : null
      const expect = s(String(step.expect ?? ''))
      const actual = selector === null
        ? await page.locator('body').innerText({ timeout })
        : ((await page.textContent(selector, { timeout })) ?? '')
      const mode = step.mode ?? 'contains'
      const pass = mode === 'equals' ? actual === expect : actual.includes(expect)
      return {
        pass,
        error: pass ? undefined : `expected text ${mode} "${expect}" but got ${JSON.stringify(actual.slice(0, 300))}`,
        detail: { actual: actual.slice(0, 2000) },
      }
    }
    case 'assert_url': {
      const expect = s(String(step.expect ?? ''))
      const waitMs = Math.min(Math.max(Number(step.ms ?? 5000) || 5000, 0), timeout)
      await page.waitForURL((current) => current.href.includes(expect), { timeout: waitMs }).catch(() => {})
      const actual = page.url()
      const pass = actual.includes(expect)
      return { pass, error: pass ? undefined : `expected url to contain "${expect}" but got "${actual}"`, detail: { actual } }
    }
    case 'assert_title': {
      const expect = s(String(step.expect ?? ''))
      const actual = await page.title()
      const pass = actual.includes(expect)
      return { pass, error: pass ? undefined : `expected title to contain "${expect}" but got "${actual}"`, detail: { actual } }
    }
    case 'assert_element': {
      const selector = s(resolveSelector(step, elements))
      const expectPresent = step.present !== false
      if (expectPresent) {
        await page.locator(selector).first().waitFor({ state: 'attached', timeout })
        return { pass: true, detail: { selector, present: true } }
      }
      const count = await page.locator(selector).count()
      const pass = count === 0
      return { pass, error: pass ? undefined : `expected element absent, but found ${count}`, detail: { selector, count } }
    }
    case 'eval': {
      const expression = s(step.expression ?? step.selector ?? '')
      if (!expression) throw new Error('eval step requires an expression')
      let value
      try {
        value = await page.evaluate(expression)
      } catch (error) {
        throw new Error(`page eval failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      const normalized = value === undefined ? null : value
      const detail = { value: normalized }
      // exportAs:把 eval 结果导出为变量(写入会话缓存,供跨执行复用,如浏览器里的 token)。
      if (typeof step.exportAs === 'string' && step.exportAs.trim()) {
        return { pass: true, detail, exportAs: { [step.exportAs.trim()]: normalized } }
      }
      return { pass: true, detail }
    }
    case 'wait': {
      const ms = Math.min(Math.max(Number(step.ms ?? 500) || 500, 0), 10_000)
      await page.waitForTimeout(ms)
      return { pass: true, detail: { ms } }
    }
    case 'screenshot': {
      const target = s(step.path ?? 'ui/screenshots/manual.png')
      const file = await writeScreenshot(page, options.root, target)
      return { pass: true, detail: { path: file } }
    }
    default:
      throw new Error(`unknown ui step kind: ${kind}`)
  }
}

/**
 * 失败取证:截图 + 诊断快照(console/pageerror/请求失败),供报告排查。
 * @param session - 浏览器会话。
 * @param options - { root? }。
 * @param index - 步骤序号。
 * @returns { screenshot?, diagnostics? }。
 */
async function captureFailureEvidence(session, options, index) {
  const evidence = {}
  const { consoleErrors, pageErrors, failedRequests } = session.diagnostics
  if (consoleErrors.length > 0 || pageErrors.length > 0 || failedRequests.length > 0) {
    evidence.diagnostics = {
      consoleErrors: [...consoleErrors],
      pageErrors: [...pageErrors],
      failedRequests: [...failedRequests],
    }
  }
  if (options.root === undefined) return evidence
  try {
    const file = await writeScreenshot(session.page, options.root, `ui/screenshots/fail-${Date.now()}-${index}.png`)
    evidence.screenshot = file
  } catch {
    // 截图失败不掩盖原始步骤错误:页面上可能已经崩溃/关闭。
  }
  return evidence
}

/**
 * 执行整个 UI 脚本。
 * @param ctx - 插件上下文(保留参数以匹配调用点;执行不依赖 ctx 服务)。
 * @param script - { name, steps: [...] }。
 * @param elements - 元素库映射 { key: selector }。
 * @param variables - 变量表。
 * @param factories - 数据工厂表。
 * @param options - { continueOnError?, root?, headless?, viewport?, storageState?, driver? }。
 * @returns { name, startedAt, finishedAt, durationMs, driver, summary, results, exports }。
 */
export async function executeUiScript(ctx, script, elements, variables, factories, options = {}) {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const deadline = started + SCRIPT_TIMEOUT_MS
  const results = []
  const steps = Array.isArray(script.steps) ? script.steps : []
  const ownDriver = options.driver === undefined
  const driver = ownDriver ? await launchDriver({ headless: options.headless }) : options.driver
  const driverInfo = driver.info()
  let session
  try {
    session = await driver.newSession({
      storageState: options.storageState,
      viewport: options.viewport,
    })
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]
      const entry = {
        stepIndex: index,
        kind: step.kind ?? 'eval',
        name: step.name ?? `${step.kind ?? 'eval'} ${index + 1}`,
      }
      if (Date.now() > deadline) {
        entry.pass = false
        entry.error = `ui script timed out after ${SCRIPT_TIMEOUT_MS}ms`
        results.push(entry)
        break
      }
      try {
        const outcome = await runStep(session, step, elements, variables, factories, options)
        Object.assign(entry, outcome)
        // 断言失败是正常返回(pass: false),同样需要截图与诊断取证。
        if (outcome.pass !== true) Object.assign(entry, await captureFailureEvidence(session, options, index))
      } catch (error) {
        entry.pass = false
        entry.error = error instanceof Error ? error.message : String(error)
        Object.assign(entry, await captureFailureEvidence(session, options, index))
      }
      results.push(entry)
      if (!entry.pass && !options.continueOnError) break
    }
  } finally {
    if (session !== undefined) await session.close()
    if (ownDriver) await driver.close()
  }
  const total = results.length
  const passed = results.filter((item) => item.pass).length
  const exports = {}
  for (const item of results) {
    for (const [name, value] of Object.entries(item.exportAs ?? {})) exports[name] = value
  }
  return {
    name: script.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    driver: driverInfo,
    summary: { total, passed, failed: total - passed },
    results,
    exports,
  }
}
