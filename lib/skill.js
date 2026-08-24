/**
 * 测试模式技能提供者:随测试模式组合装载,向该模式作用域层的技能注册表
 * 注册 bundled 技能候选。因为注册发生在预设的 scope 层,只有使用测试模式
 * 的会话能看到/加载它们,其他模式不可见。
 *
 * 技能 = 只注入元数据(name/description)、正文按需加载的知识。**测试工作流
 * 不是技能**:它是常驻完整注入的 system-prompt 契约,由 lib/preset.js 整体
 * 注入,不在此注册。
 *
 * 形状对齐官方 `@deepseek-ai/dsh-skill-badge` 的 bundled provider;刻意不
 * 引入 @deepseek-ai 运行时依赖(rank 直接用协议常量,见 dsh-skill 的
 * BUNDLED_SKILL_RANK = 600),保证插件从任意安装位置(link 或 tarball)都能加载。
 *
 * 后续添加技能:把技能正文放进 assets/(或子目录),在 CANDIDATES 增加一行
 * 注册(name/locator),无需再改其他代码。
 * @module @calwang414/dsh-test-mode/skill
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** 提供者名(技能目录里以此分组)。 */
const PROVIDER_NAME = 'dsh-test-mode'

/** 技能可用资源:assets/ 目录(覆盖技能的正文与附属文件)。 */
const RESOURCE_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
}

/** 模型与用户都可调用。 */
const INVOCATION = { modelInvocable: true, userInvocable: true }

// dsh-skill 的 BUNDLED_SKILL_RANK 协议常量
const RANK = 600

/** 技能候选清单:name 是技能 id,locator 指向包内正文。 */
const CANDIDATES = [
  {
    name: 'plugin-testing',
    description: 'How to write and run dynamic Cordis plugin tests in test-mode mode: the three-phase contract (pre-load snapshot, scenario assertions, cleanup assertions), suite JSON format, and how to build manifests/plugin.js under the shared test-mode/ directory.',
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: RESOURCE_BASE,
    rank: RANK,
    locator: new URL('../assets/plugin-testing.md', import.meta.url),
  },
]

const byName = new Map(CANDIDATES.map((candidate) => [candidate.name, candidate]))

const provider = {
  name: PROVIDER_NAME,
  list: () => CANDIDATES,
  async get(candidate) {
    const known = byName.get(candidate?.name)
    if (!known) throw new Error(`dsh-test-mode: unknown skill candidate ${candidate?.name}`)
    return {
      name: known.name,
      description: known.description,
      invocation: known.invocation,
      provider: known.provider,
      source: known.source,
      resourceBase: known.resourceBase,
      content: await readFile(known.locator, 'utf8'),
    }
  },
}

/** Cordis 插件名。 */
export const name = 'dsh-test-mode-skill'
/** 技能注册表服务。 */
export const inject = ['skills']

/** 注册 bundled 技能提供者到调用方作用域层(测试模式专属)。 */
export function apply(ctx) {
  ctx.effect(() => ctx.skills.registerProvider(() => provider), 'dsh-test-mode: testing-mode skill provider')
}
