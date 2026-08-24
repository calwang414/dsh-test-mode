/**
 * 动态插件测试引擎:在隔离作用域中装载被测插件,按三阶段契约执行断言。
 *
 * 三阶段:
 * 1. **装载前快照**——记录基线:当前 `tools.schemas()` 工具清单、目标事件/服务存在性;
 * 2. **场景断言**——把被测插件源码求值为 Cordis 插件,在 `ctx.extend()` 的子作用域
 *    装载(fiber),逐条断言(工具可见性 / 事件响应 / 服务提供 / 工具执行);
 * 3. **清理断言**——`fiber.dispose()` 后断言世界回到基线:工具消失、探针不再触发、
 *    服务回到 undefined。清理断言由场景自动派生:每个可见工具、每个提供过的服务、
 *    每个响应过的事件都会生成对应的清理断言。
 *
 * 测试环境故意不复制 host-runner 的受限门面:被测插件是用户信任的源码,测试引擎
 * 观察的是真实 Cordis 语义(注册表副作用随 fiber 卸载)。被测插件源码形态与
 * `cordis_define` 的 code.host 一致:`return { apply(ctx) { … }, inject: […] }` 的
 * 函数体;求值环境提供 `console` / `btoa` / `atob` / `TextEncoder` / `TextDecoder`。
 * @module @calwang414/dsh-test-mode/plugin-test
 */

import { createContext, runInContext } from 'node:vm'

/** 工具执行超时(毫秒)。 */
const EXECUTE_TIMEOUT_MS = 15_000

/**
 * 求值被测插件源码(函数体),返回 Cordis 插件对象。
 * @param code - 源码,期望 `return { apply(ctx) { … } }`(或 `function (ctx) {}`)。
 * @param id - 插件 id,用作 vm 文件名与 console 标签。
 * @returns 求值结果(插件对象);源码未 return 时返回 undefined。
 */
export async function evaluatePluginSource(code, id) {
  const sandbox = {
    console: {
      log: (...args) => console.log(`[test-mode:${id}]`, ...args),
      info: (...args) => console.log(`[test-mode:${id}]`, ...args),
      warn: (...args) => console.warn(`[test-mode:${id}]`, ...args),
      error: (...args) => console.error(`[test-mode:${id}]`, ...args),
      debug: (...args) => console.log(`[test-mode:${id}]`, ...args),
    },
    btoa: (value) => Buffer.from(value, 'utf-8').toString('base64'),
    atob: (value) => Buffer.from(value, 'base64').toString('utf-8'),
    TextEncoder,
    TextDecoder,
  }
  createContext(sandbox)
  return runInContext(`(async () => {\n${code}\n})()`, sandbox, {
    filename: `test-mode-${id}.js`,
  })
}

/**
 * 装载前快照:基线工具清单(全局视图)。
 * @param ctx - 测试引擎上下文(其 `tools` 服务提供 schemas)。
 * @returns 当前可见的工具 schema 名称数组(基线)。
 */
export function snapshotToolNames(ctx) {
  const tools = ctx.get('tools')
  if (tools === undefined) return []
  return tools.schemas().map((schema) => schema.name)
}

/**
 * 派生清理断言:场景里出现过的工具、服务各自生成「消失」断言。
 *
 * 只派生注册表级可观察项(工具/服务):事件监听器是否随 fiber 移除是黑盒
 * (外部探针无法区分"插件监听器"与"探针自己"),不做伪验证。事件副作用的
 * 清理验证由套件作者用场景组合完成(dispose 前后触发事件,断言插件暴露的
 * 服务状态未变)。
 * @param suite - 测试套件(含 assertions)。
 * @returns 清理断言数组(与场景断言同构,kind 为 *-gone)。
 */
export function deriveCleanupAssertions(suite) {
  const tools = new Set()
  const services = new Set()
  for (const assertion of suite.assertions ?? []) {
    if (assertion.kind === 'tool.visible' && assertion.tool) tools.add(assertion.tool)
    if (assertion.kind === 'service.provided' && assertion.service) services.add(assertion.service)
  }
  const cleanup = []
  for (const tool of tools) cleanup.push({ kind: 'tool.gone', tool })
  for (const service of services) cleanup.push({ kind: 'service.gone', service })
  return cleanup
}

/**
 * 执行一次工具调用,返回结构化的结果或错误。
 * @param ctx - 测试引擎上下文。
 * @param name - 工具名。
 * @param args - 参数(JSON 可序列化)。
 * @returns { ok, result? | error? , toolMissing? }
 */
async function executeTool(ctx, name, args) {
  const tools = ctx.get('tools')
  if (tools === undefined) return { ok: false, error: 'tools service is not available' }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), EXECUTE_TIMEOUT_MS)
  try {
    const result = await tools.execute({
      callId: `test-mode-${name}`,
      name,
      arguments: args,
      signal: controller.signal,
    })
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * 断言一个工具是否出现在当前可见 schemas 中。
 * @param ctx - 测试引擎上下文。
 * @param tool - 工具名。
 * @returns { present, schema? }
 */
function toolPresent(ctx, tool) {
  const tools = ctx.get('tools')
  if (tools === undefined) return { present: false }
  const schema = tools.schemas().find((entry) => entry.name === tool)
  return { present: schema !== undefined, schema }
}

/**
 * 判断实际 schema 是否包含期望字段(浅层:期望字段存在且 JSON 相等)。
 * @param actual - 实际 schema 对象。
 * @param expectSchema - 期望字段子集。
 * @returns 是否匹配。
 */
function schemaMatches(actual, expectSchema) {
  if (expectSchema === undefined) return true
  if (actual === undefined) return false
  for (const [key, value] of Object.entries(expectSchema)) {
    if (JSON.stringify(actual[key]) !== JSON.stringify(value)) return false
  }
  return true
}

/**
 * 运行一条场景断言,返回 pass/fail + 证据。
 * @param ctx - 测试引擎上下文(fiber 已装载)。
 * @param assertion - 断言条目。
 */
async function runAssertion(ctx, assertion) {
  switch (assertion.kind) {
    case 'tool.visible': {
      const { present, schema } = toolPresent(ctx, assertion.tool)
      const matched = schemaMatches(schema, assertion.expectSchema)
      return {
        pass: present && matched,
        evidence: { present, schema, expected: assertion.expectSchema },
      }
    }
    case 'tool.gone': {
      const { present } = toolPresent(ctx, assertion.tool)
      return { pass: !present, evidence: { present } }
    }
    case 'service.provided': {
      const service = ctx.get(assertion.service)
      const methods = assertion.expectMethods ?? []
      const hasMethods = methods.every((method) => service !== undefined && typeof service[method] === 'function')
      return { pass: service !== undefined && hasMethods, evidence: { present: service !== undefined, hasMethods } }
    }
    case 'service.gone': {
      const present = ctx.get(assertion.service) !== undefined
      return { pass: !present, evidence: { present } }
    }
    case 'event.responds': {
      // 探针验证事件通路与 payload:触发后探针应收到且 payload 匹配。
      // 注意:这验证的是事件能到达作用域内监听器,不是"插件注册了监听器"
      // (插件监听器是黑盒,探针无法区分)。插件对事件的业务响应要用
      // 组合断言验证(如触发事件后断言插件暴露的服务状态变化)。
      const received = []
      const disposer = ctx.on(assertion.event, (payload) => received.push(payload))
      try {
        if (assertion.trigger?.type === 'emit') {
          ctx.emit(assertion.event, assertion.trigger.payload)
        }
        // 同步事件立即触发;异步事件给一个微任务窗口。
        await Promise.resolve()
        const hit = received.length > 0
        const matched = hit && JSON.stringify(received[received.length - 1]) === JSON.stringify(assertion.expectPayload)
        return { pass: hit && matched, evidence: { received, expected: assertion.expectPayload } }
      } finally {
        disposer()
      }
    }
    case 'tool.execute': {
      const outcome = await executeTool(ctx, assertion.tool, assertion.args)
      if (assertion.expectError !== undefined) {
        const matched = outcome.ok === false && String(outcome.error).includes(String(assertion.expectError))
        return { pass: matched, evidence: outcome }
      }
      if (!outcome.ok) return { pass: false, evidence: outcome }
      // tools.execute 返回 { isError, content, value } 包装,真实返回值在 value。
      const actual = outcome.result?.value
      const expected = assertion.expectResult
      if (expected === undefined) return { pass: true, evidence: { result: actual } }
      // 结果可含额外字段:期望字段逐一比对。
      let matched = true
      for (const [key, value] of Object.entries(expected)) {
        if (JSON.stringify(actual?.[key]) !== JSON.stringify(value)) { matched = false; break }
      }
      return { pass: matched, evidence: { result: actual, expected } }
    }
    default:
      return { pass: false, evidence: { error: `unknown assertion kind: ${assertion.kind}` } }
  }
}

/**
 * 运行整个测试套件:快照 → 场景 → 清理,返回结构化报告。
 * @param ctx - 测试引擎上下文(真实运行环境;装载/断言在同一作用域链)。
 * @param suite - 测试套件:{ name, source, assertions: [...] }。
 * @returns 三阶段报告(JSON 可序列化)。
 */
export async function runPluginSuite(ctx, suite) {
  const report = {
    name: suite.name,
    timestamp: new Date().toISOString(),
    phases: {},
    summary: { total: 0, passed: 0, failed: 0 },
  }

  // 阶段 1:装载前快照
  const baseline = snapshotToolNames(ctx)
  report.phases.preload = { baselineToolCount: baseline.length }

  // 装载被测插件到隔离作用域
  const child = ctx.extend()
  let fiber
  try {
    const plugin = await evaluatePluginSource(suite.source, suite.name)
    if (plugin === undefined || (typeof plugin !== 'function' && (typeof plugin !== 'object' || typeof plugin.apply !== 'function'))) {
      report.phases.load = { pass: false, error: 'source did not return a plugin (expected return { apply(ctx) { … } })' }
      report.summary.total = 1
      report.summary.failed = 1
      return report
    }
    fiber = child.plugin(plugin)
    await fiber.await()
  } catch (error) {
    report.phases.load = { pass: false, error: error instanceof Error ? error.message : String(error) }
    report.summary.total = 1
    report.summary.failed = 1
    return report
  }
  report.phases.load = { pass: true }

  // 阶段 2:场景断言——跑在被测插件自己的 ctx 上(其 provide 的服务只对
  // fiber.ctx 及其子可见,父 ctx 读不到;tools 是全局注册表,任意 ctx 可见)。
  const scenarios = []
  for (const assertion of suite.assertions ?? []) {
    const outcome = await runAssertion(fiber.ctx, assertion)
    scenarios.push({ kind: assertion.kind, ...outcome, label: assertion.label })
  }
  report.phases.scenarios = scenarios

  // 阶段 3:清理断言(先 dispose,再核对基线)
  try {
    await fiber.dispose()
  } catch (error) {
    report.phases.cleanup = { disposed: false, error: error instanceof Error ? error.message : String(error) }
    report.summary.total = 1
    report.summary.failed = 1
    return report
  }

  const cleanup = deriveCleanupAssertions(suite)
  const cleanupResults = []
  for (const assertion of cleanup) {
    const outcome = await runAssertion(ctx, assertion)
    cleanupResults.push({ kind: assertion.kind, ...outcome })
  }
  report.phases.cleanup = { disposed: true, assertions: cleanupResults }

  // 汇总
  const all = [...scenarios, ...cleanupResults]
  report.summary.total = all.length
  report.summary.passed = all.filter((entry) => entry.pass).length
  report.summary.failed = report.summary.total - report.summary.passed
  return report
}
