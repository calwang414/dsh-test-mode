/**
 * dsh-test-mode UI 自动化执行引擎:通过 tools 服务的 execute 调用 cdp-browser
 * 插件注册的 browser_* 工具,按脚本步骤顺序驱动受控 Chrome。
 *
 * 步骤模型:
 * - `open` — browser_navigate 到 URL;
 * - `click` — 用 browser_eval 按 CSS selector 定位并派发真实鼠标事件;
 * - `type` — 用 browser_eval 按 CSS selector 定位并原生 setter 输入(React 兼容);
 * - `press` — browser_press 按键;
 * - `assert_text` / `assert_url` / `assert_title` / `assert_element` — 断言;
 * - `eval` — 直接执行页面 JS 表达式;
 * - `wait` — 等待毫秒;
 * - `screenshot` — browser_screenshot 存盘。
 *
 * 定位支持两种来源:步骤自带的 `selector`,或元素库引用 `element`(key 在
 * 元素库中解析)。selector/url/text/expression 均做变量替换(环境变量 +
 * 数据工厂,见 api-test.js 的 substitute)。
 *
 * 每个工具调用走 ctx.tools.execute(真实执行管线,带 signal 取消);
 * 失败步骤默认终止脚本,`continueOnError` 可继续并记录失败。
 * @module @calwang414/dsh-test-mode/ui-test
 */

import { substitute } from './api-test.js'

/** 单步工具调用超时(毫秒)。 */
const STEP_TIMEOUT_MS = 30_000
/** 脚本整体超时(毫秒)。 */
const SCRIPT_TIMEOUT_MS = 120_000

/** 点击定位 + 派发真实鼠标事件的页面 JS(返回命中的坐标)。 */
const CLICK_JS = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, err: 'selector not found: ' + ${JSON.stringify(selector)} };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = el.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
  el.dispatchEvent(new MouseEvent('mousedown', opts));
  el.dispatchEvent(new MouseEvent('mouseup', opts));
  el.dispatchEvent(new MouseEvent('click', opts));
  return { ok: true, x, y };
})()`

/** 输入定位 + 原生 setter 的页面 JS(React 受控输入兼容)。 */
const TYPE_JS = (selector, text) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { ok: false, err: 'selector not found: ' + ${JSON.stringify(selector)} };
  el.focus();
  const tag = el.tagName.toLowerCase();
  const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : tag === 'input' ? HTMLInputElement.prototype : null;
  if (proto) {
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    setter.call(el, ${JSON.stringify(text)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: el.value };
  }
  if (el.isContentEditable) {
    el.textContent = ${JSON.stringify(text)};
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(text)} }));
    return { ok: true, value: el.textContent };
  }
  return { ok: false, err: 'element is not an input field' };
})()`

/** 文本断言页面 JS:返回元素 textContent(不存在返回 null)。 */
const TEXT_JS = (selector) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  return el ? el.textContent : null;
})()`

/** 元素存在性页面 JS。 */
const EXISTS_JS = (selector) => `(() => {
  return !!document.querySelector(${JSON.stringify(selector)});
})()`

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
 * 执行一步,返回 { pass, error?, detail? }。
 * @param ctx - 插件上下文(带 tools 服务)。
 * @param step - 步骤定义。
 * @param elements - 元素库映射。
 * @param variables - 变量表(环境变量)。
 * @param factories - 数据工厂表。
 * @param signal - 取消信号。
 */
async function runStep(ctx, step, elements, variables, factories, signal) {
  const tools = ctx.get('tools')
  if (tools === undefined) throw new Error('tools service is not available; UI automation requires the dsh-cdp-browser plugin to be active')

  const exec = async (name, args) => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), STEP_TIMEOUT_MS)
    const abortParent = () => controller.abort()
    signal?.addEventListener('abort', abortParent, { once: true })
    try {
      const result = await tools.execute({
        callId: `ui-${name}`,
        name,
        arguments: args,
        signal: controller.signal,
      })
      return result
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abortParent)
    }
  }

  const s = (text) => substitute(text, variables, factories)
  const kind = step.kind ?? 'eval'

  switch (kind) {
    case 'open': {
      const url = s(step.url ?? '')
      if (!url) throw new Error('open step requires a url')
      const outcome = await exec('browser_navigate', { url })
      const ok = outcome?.isError !== true
      return { pass: ok, detail: ok ? { url } : { url, error: outcome?.content?.[0]?.text } }
    }
    case 'click': {
      const selector = s(resolveSelector(step, elements))
      const outcome = await exec('browser_eval', { expression: CLICK_JS(selector) })
      const value = outcome?.value
      if (outcome?.isError) return { pass: false, error: String(outcome.content?.[0]?.text ?? outcome.value ?? 'eval failed') }
      const ok = value?.ok === true
      return { pass: ok, error: ok ? undefined : (value?.err ?? 'click failed'), detail: ok ? { x: value.x, y: value.y } : undefined }
    }
    case 'type': {
      const selector = s(resolveSelector(step, elements))
      const text = s(String(step.text ?? ''))
      const outcome = await exec('browser_eval', { expression: TYPE_JS(selector, text) })
      const value = outcome?.value
      if (outcome?.isError) return { pass: false, error: String(outcome.content?.[0]?.text ?? outcome.value ?? 'eval failed') }
      const ok = value?.ok === true
      return { pass: ok, error: ok ? undefined : (value?.err ?? 'type failed'), detail: ok ? { value: value.value } : undefined }
    }
    case 'press': {
      const key = s(String(step.key ?? ''))
      if (!key) throw new Error('press step requires a key')
      const outcome = await exec('browser_press', { key })
      return { pass: outcome?.isError !== true, error: outcome?.isError ? String(outcome.content?.[0]?.text ?? 'press failed') : undefined }
    }
    case 'assert_text': {
      const selector = s(resolveSelector(step, elements))
      const expect = s(String(step.expect ?? ''))
      const outcome = await exec('browser_eval', { expression: TEXT_JS(selector) })
      if (outcome?.isError) return { pass: false, error: String(outcome.content?.[0]?.text ?? 'eval failed') }
      const actual = outcome?.value ?? null
      const mode = step.mode ?? 'contains'
      const pass = mode === 'equals' ? actual === expect : (typeof actual === 'string' && actual.includes(expect))
      return { pass, error: pass ? undefined : `expected text ${mode} "${expect}" but got ${JSON.stringify(actual)}`, detail: { actual } }
    }
    case 'assert_url': {
      const expect = s(String(step.expect ?? ''))
      const outcome = await exec('browser_eval', { expression: 'location.href' })
      if (outcome?.isError) return { pass: false, error: String(outcome.content?.[0]?.text ?? 'eval failed') }
      const actual = String(outcome?.value ?? '')
      const pass = actual.includes(expect)
      return { pass, error: pass ? undefined : `expected url to contain "${expect}" but got "${actual}"`, detail: { actual } }
    }
    case 'assert_title': {
      const expect = s(String(step.expect ?? ''))
      const outcome = await exec('browser_eval', { expression: 'document.title' })
      if (outcome?.isError) return { pass: false, error: String(outcome.content?.[0]?.text ?? 'eval failed') }
      const actual = String(outcome?.value ?? '')
      const pass = actual.includes(expect)
      return { pass, error: pass ? undefined : `expected title to contain "${expect}" but got "${actual}"`, detail: { actual } }
    }
    case 'assert_element': {
      const selector = s(resolveSelector(step, elements))
      const expectPresent = step.present !== false
      const outcome = await exec('browser_eval', { expression: EXISTS_JS(selector) })
      if (outcome?.isError) return { pass: false, error: String(outcome.content?.[0]?.text ?? 'eval failed') }
      const present = outcome?.value === true
      const pass = present === expectPresent
      return { pass, error: pass ? undefined : `expected element ${expectPresent ? 'present' : 'absent'} but ${present ? 'found' : 'missing'}` }
    }
    case 'eval': {
      const expression = s(step.expression ?? step.selector ?? '')
      if (!expression) throw new Error('eval step requires an expression')
      const outcome = await exec('browser_eval', { expression })
      if (outcome?.isError) return { pass: false, error: String(outcome.content?.[0]?.text ?? 'eval failed') }
      const value = outcome?.value
      // exportAs:把 eval 结果导出为变量(写入会话缓存,供跨执行复用,如浏览器里的 token)。
      if (typeof step.exportAs === 'string' && step.exportAs.trim()) {
        return { pass: true, detail: { value }, exportAs: { [step.exportAs.trim()]: value } }
      }
      return { pass: true, detail: { value } }
    }
    case 'wait': {
      const ms = Math.min(Math.max(Number(step.ms ?? 500) || 500, 0), 10_000)
      await new Promise((resolve) => setTimeout(resolve, ms))
      return { pass: true, detail: { ms } }
    }
    case 'screenshot': {
      const path = s(step.path ?? 'ui-screenshot.png')
      const outcome = await exec('browser_screenshot', { path })
      const ok = outcome?.isError !== true
      return { pass: ok, error: ok ? undefined : String(outcome?.content?.[0]?.text ?? 'screenshot failed'), detail: { path } }
    }
    default:
      throw new Error(`unknown ui step kind: ${kind}`)
  }
}

/**
 * 执行整个 UI 脚本。
 * @param ctx - 插件上下文。
 * @param script - { name, steps: [...] }。
 * @param elements - 元素库映射 { key: selector }。
 * @param variables - 变量表。
 * @param factories - 数据工厂表。
 * @param options - { continueOnError? }。
 * @returns { name, startedAt, finishedAt, durationMs, summary, results }。
 */
export async function executeUiScript(ctx, script, elements, variables, factories, options = {}) {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), SCRIPT_TIMEOUT_MS)
  const results = []
  const steps = Array.isArray(script.steps) ? script.steps : []
  try {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]
      const entry = {
        stepIndex: index,
        kind: step.kind ?? 'eval',
        name: step.name ?? `${step.kind ?? 'eval'} ${index + 1}`,
      }
      try {
        const outcome = await runStep(ctx, step, elements, variables, factories, controller.signal)
        Object.assign(entry, outcome)
      } catch (error) {
        entry.pass = false
        entry.error = error instanceof Error ? error.message : String(error)
      }
      results.push(entry)
      if (!entry.pass && !options.continueOnError) break
    }
  } finally {
    clearTimeout(timeout)
  }
  const executed = results
  const total = executed.length
  const passed = executed.filter((item) => item.pass).length
  const exports = {}
  for (const item of results) {
    for (const [name, value] of Object.entries(item.exportAs ?? {})) exports[name] = value
  }
  return {
    name: script.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary: { total, passed, failed: total - passed },
    results,
    exports,
  }
}
