/**
 * 测试引擎冒烟测试:用真实 Cordis 运行时验证三阶段契约的通过路径与失败路径。
 * 运行:node smoke/smoke-test.mjs
 * (需要本地能解析 @deepseek-ai/cordis 等包;本文件用绝对路径指向 harness 安装)
 */

import { runPluginSuite } from '../lib/plugin-test.js'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
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


// 被测插件:注册一个工具、一个服务、一个事件监听(全部是 ctx 效果,dispose 应清理)
const GOOD_SOURCE = `
return {
  inject: [],
  apply(ctx) {
    ctx.provide('demoGreeter', { greet: (name) => 'hello ' + name })
    ctx.on('demo/ping', () => {})
    const tools = ctx.get('tools')
    if (tools !== undefined) {
      tools.register({
        name: 'demo_greet',
        description: 'Greet a name',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        output: { schema: { type: 'object', properties: { greeting: { type: 'string' } } }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
        execute: async (args) => ({ greeting: 'hello ' + args.name }),
      })
    }
  },
}
`

let failed = 0
let passed = 0

function check(condition, label, detail) {
  if (condition) {
    passed++
    console.log(`  PASS ${label}`)
  } else {
    failed++
    console.log(`  FAIL ${label} ${detail ?? ''}`)
  }
}

async function run(name, source, assertions, expectations) {
  console.log(`\n=== ${name} ===`)
  const ctx = new Context()
  const prompt = new SystemPrompt(ctx, {})
  prompt.start?.()
  const tools = new ToolRuntime(ctx)
  tools.start?.()
  await ctx.fiber.await()
  const report = await runPluginSuite(ctx, { name, source, assertions })
  await ctx.fiber.dispose()
  check(report.phases.load?.pass === true, 'load', report.phases.load?.error ?? '')
  const scenarios = report.phases.scenarios ?? []
  const cleanup = report.phases.cleanup
  for (const entry of expectations.scenarios ?? []) {
    const actual = scenarios.find(s => s.kind === entry.kind && (entry.tool === undefined || s.label === entry.label))
    check(actual?.pass === entry.pass, `scenario ${entry.kind}`, JSON.stringify(actual?.evidence))
  }
  if (expectations.cleanupPass !== undefined) {
    const cleanupAll = cleanup?.assertions?.every(a => a.pass) ?? false
    check(cleanupAll === expectations.cleanupPass, `cleanup ${expectations.cleanupPass ? 'all-pass' : 'has-failures'}`, JSON.stringify(cleanup))
  }
}

// 通过路径:全部断言应该 PASS,清理也应该 PASS。
await run('good-plugin', GOOD_SOURCE, [
  { kind: 'tool.visible', tool: 'demo_greet', expectSchema: { description: 'Greet a name' } },
  { kind: 'service.provided', service: 'demoGreeter', expectMethods: ['greet'] },
  { kind: 'event.responds', event: 'demo/ping', trigger: { type: 'emit', payload: { ok: true } }, expectPayload: { ok: true } },
  { kind: 'tool.execute', tool: 'demo_greet', args: { name: 'world' }, expectResult: { greeting: 'hello world' } },
], {
  cleanupPass: true,
})

// 失败路径:断言故意写错——不存在的工具、错误 schema、不存在的服务、错误结果。
await run('bad-expectations', GOOD_SOURCE, [
  { kind: 'tool.visible', tool: 'does_not_exist' },
  { kind: 'tool.visible', tool: 'demo_greet', expectSchema: { description: 'Wrong description' } },
  { kind: 'service.provided', service: 'noSuchService' },
  { kind: 'tool.execute', tool: 'demo_greet', args: { name: 'world' }, expectResult: { greeting: 'wrong' } },
], {
  scenarios: [
    { kind: 'tool.visible', pass: false },
  ],
  cleanupPass: true,
})

// 事件负路径:触发的事件 payload 与预期不符时应该 FAIL。
await run('wrong-payload', GOOD_SOURCE, [
  { kind: 'event.responds', event: 'demo/ping', trigger: { type: 'emit', payload: { ok: true } }, expectPayload: { ok: false } },
], {
  scenarios: [
    { kind: 'event.responds', pass: false },
  ],
  cleanupPass: true,
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
