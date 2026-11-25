/**
 * 技能提供者冒烟测试:
 * 1. bundled 技能 `plugin-testing` 可列出,正文去掉 frontmatter;
 * 2. `DSH_TEST_MODE_SKILLS` 目录中的 `<name>/SKILL.md` 目录包与 `<name>.md`
 *    平铺文件会被注册为测试模式专属技能;
 * 3. 工作区 `.dsh/test-mode-skills` 中的技能可被发现;
 * 4. frontmatter 的 user-invocable / disable-model-invocation 生效。
 *
 * 运行:node smoke/skill.mjs
 */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, internals } from '../lib/skill.js'

let passed = 0
let failed = 0
/**
 * 记录断言结果。
 * @param fn - 断言函数。
 * @param label - 断言描述。
 */
async function check(fn, label) {
  try {
    await fn()
    passed += 1
    console.log(`  PASS ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${label} ${error instanceof Error ? error.message : String(error)}`)
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-test-mode-skill-'))
const workspace = join(root, 'workspace')
const packDir = join(root, 'skills')
const userWorkspaceSkill = join(workspace, '.dsh', 'test-mode-skills')
await mkdir(join(packDir, 'api-testing'), { recursive: true })
await mkdir(join(workspace, '.dsh', 'test-mode-skills'), { recursive: true })
await writeFile(join(packDir, 'api-testing', 'SKILL.md'), `---\nname: api-testing\ndescription: Test HTTP APIs with negative and boundary cases.\n---\n\n# API Testing\n\nDesign cases first.\n`)
await writeFile(join(packDir, 'flat-skill.md'), `---\nname: flat-skill\ndescription: A flat markdown skill.\n---\nFlat body.\n`)
await mkdir(join(userWorkspaceSkill, 'security'), { recursive: true })
await writeFile(join(userWorkspaceSkill, 'security', 'SKILL.md'), `---\nname: security-testing\ndescription: Security checks for APIs.\ndisable-model-invocation: true\nuser-invocable: false\n---\nSecurity body.\n`)

process.env.DSH_TEST_MODE_SKILLS = packDir

// 捕获注册到 ctx.skills 的 provider
const registered = []
const ctx = {
  skills: { registerProvider: (factory) => { registered.push(factory()); return () => {} } },
  effect: (fn) => { fn(); return () => {} },
}
apply(ctx)

await check(() => assert.equal(typeof registered[0]?.list, 'function'), '技能 provider 注册到 ctx.skills')
const provider = registered[0]

const candidates = await provider.list({ cwd: workspace })
const names = candidates.map((item) => item.name)
await check(() => assert.ok(names.includes('plugin-testing')), 'bundled 技能 plugin-testing 可见')
await check(() => assert.ok(names.includes('api-testing')), '外部目录包 <name>/SKILL.md 可见')
await check(() => assert.ok(names.includes('flat-skill')), '外部平铺 <name>.md 可见')
await check(() => assert.ok(names.includes('security-testing')), '工作区 .dsh/test-mode-skills 可见')

const security = candidates.find((item) => item.name === 'security-testing')
await check(() => assert.equal(security.invocation.modelInvocable, false), 'disable-model-invocation 生效')
await check(() => assert.equal(security.invocation.userInvocable, false), 'user-invocable=false 生效')

const bundled = await provider.get(candidates.find((item) => item.name === 'plugin-testing'))
await check(() => assert.ok(!bundled.content.startsWith('---')), 'bundled 正文去掉 frontmatter')
await check(() => assert.ok(bundled.content.includes('Dynamic Cordis Plugin Testing')), 'bundled 正文内容正确')
const api = await provider.get(candidates.find((item) => item.name === 'api-testing'))
await check(() => assert.ok(api.content.includes('Design cases first')), '外部技能正文加载正确')
await check(() => assert.equal(api.resourceBase?.kind, 'directory'), '外部技能 resourceBase 指向技能目录')

const { parseFrontmatter } = internals
await check(() => assert.equal(parseFrontmatter('---\nname: x\ndescription: "y"\n---\nbody').data.description, 'y'), 'frontmatter 解析引号值')

// 清理
process.env.DSH_TEST_MODE_SKILLS = ''
await rm(root, { recursive: true, force: true })

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
