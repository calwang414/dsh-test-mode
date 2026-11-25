/**
 * 测试模式技能提供者:随测试模式组合装载,向该模式作用域层的技能注册表
 * 注册 bundled 技能与「测试模式专属外部技能」。因为注册发生在预设的 scope
 * 层,只有使用测试模式的会话能看到/加载它们,其他模式不可见。
 *
 * 技能 = 只注入元数据(name/description)、正文按需加载的知识。**测试工作流
 * 不是技能**:它是常驻完整注入的 system-prompt 契约,由 lib/preset.js 整体
 * 注入,不在此注册。
 *
 * 外部技能(开源技能引用)按以下顺序扫描,找到的 `<name>/SKILL.md` 或
 * `<name>.md` 会注册为测试模式专属技能,其他模式不可见:
 *   1. `DSH_TEST_MODE_SKILLS` 环境变量(path.delimiter 分隔的目录列表);
 *   2. `~/.dsh/test-mode-skills`(用户级,推荐放开源技能);
 *   3. `<workspace>/.dsh/test-mode-skills`(工作区级,随仓库共享)。
 * 技能正文可以引用同目录下的附属文件(resourceBase 指向技能所在目录)。
 *
 * 形状对齐官方 `@deepseek-ai/dsh-skill-badge` 的 bundled provider;刻意不
 * 引入 @deepseek-ai 运行时依赖(rank 直接用协议常量,见 dsh-skill 的
 * BUNDLED_SKILL_RANK = 600)。
 * @module @calwang414/dsh-test-mode/skill
 */

import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 提供者名(技能目录里以此分组)。 */
const PROVIDER_NAME = 'dsh-test-mode'

/** bundled 技能可用资源:assets/ 目录(覆盖技能的正文与附属文件)。 */
const ASSET_BASE = {
  kind: 'directory',
  path: fileURLToPath(new URL('../assets/', import.meta.url)),
}

/** 模型与用户都可调用。 */
const INVOCATION = { modelInvocable: true, userInvocable: true }

// dsh-skill 的 BUNDLED_SKILL_RANK 协议常量
const RANK = 600

/** 测试模式专属外部技能目录(用户级)。 */
const USER_SKILL_DIR = join(homedir(), '.dsh', 'test-mode-skills')

/** 测试模式专属外部技能目录(工作区级,相对 workspace cwd)。 */
const WORKSPACE_SKILL_DIR = join('.dsh', 'test-mode-skills')

/** 技能候选清单:name 是技能 id,locator 指向包内正文。 */
const CANDIDATES = [
  {
    name: 'plugin-testing',
    description: 'How to write and run dynamic Cordis plugin tests in test-mode mode: the three-phase contract (pre-load snapshot, scenario assertions, cleanup assertions), suite JSON format, and how to build manifests/plugin.js under the shared test-mode/ directory.',
    invocation: INVOCATION,
    provider: PROVIDER_NAME,
    source: 'bundled',
    resourceBase: ASSET_BASE,
    rank: RANK,
    locator: new URL('../assets/plugin-testing.md', import.meta.url),
  },
]

/**
 * 解析技能 frontmatter(只处理本插件需要的标量字段,忽略 metadata 等嵌套块)。
 * @param text - 文件全文。
 * @returns { data, body };data 为简单键值,body 为去掉 frontmatter 的正文。
 */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { data: {}, body: text }
  const data = {}
  for (const line of match[1].split(/\r?\n/)) {
    const index = line.indexOf(':')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1)
    if (value !== '') data[key] = value
  }
  return { data, body: text.slice(match[0].length) }
}

/** frontmatter 布尔值(接受 true/yes/on/1)。 */
function frontmatterTrue(value) {
  return typeof value === 'string' && ['true', 'yes', 'on', '1'].includes(value.trim().toLowerCase())
}

/** frontmatter 布尔值(接受 false/no/off/0)。 */
function frontmatterFalse(value) {
  return typeof value === 'string' && ['false', 'no', 'off', '0'].includes(value.trim().toLowerCase())
}

/**
 * 读取一个技能文件,返回候选与加载正文所需信息。
 * @param path - SKILL.md 或 <name>.md 路径。
 * @param fallbackName - 缺少 frontmatter name 时使用的名称。
 * @param source - 技能来源标识。
 * @returns 候选对象;解析失败返回 undefined。
 */
async function readSkillCandidate(path, fallbackName, source) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  const { data, body } = parseFrontmatter(text)
  const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : fallbackName
  if (!name) return undefined
  const description = typeof data.description === 'string' && data.description.trim()
    ? data.description.trim()
    : `${name} (test-mode external skill)`
  return {
    name,
    description,
    invocation: {
      modelInvocable: !frontmatterTrue(data['disable-model-invocation']),
      userInvocable: !frontmatterFalse(data['user-invocable']),
    },
    provider: PROVIDER_NAME,
    source,
    resourceBase: { kind: 'directory', path: dirname(path) },
    rank: RANK,
    locator: { path, name, source },
    content: body.trim(),
  }
}

/**
 * 扫描一个目录:支持 `<name>/SKILL.md` 目录包与 `<name>.md` 平铺文件。
 * @param dir - 技能目录。
 * @param source - 来源标识。
 * @returns 候选数组。
 */
async function scanSkillDir(dir, source) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      const candidate = await readSkillCandidate(join(dir, entry.name, 'SKILL.md'), entry.name, source)
      if (candidate) candidates.push(candidate)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const candidate = await readSkillCandidate(join(dir, entry.name), entry.name.slice(0, -3), source)
      if (candidate) candidates.push(candidate)
    }
  }
  return candidates
}

/** 解析环境变量里的目录列表。 */
function envSkillDirs() {
  const raw = process.env.DSH_TEST_MODE_SKILLS
  if (typeof raw !== 'string' || !raw.trim()) return []
  return raw.split(delimiter).map((item) => item.trim()).filter(Boolean)
}

/**
 * 发现测试模式专属外部技能(用户级 + 工作区级 + 环境变量目录)。
 * @param cwd - 当前 workspace 根目录(可选)。
 * @returns { [name]: candidate } 映射。
 */
async function discoverExternalSkills(cwd) {
  const roots = [
    ...envSkillDirs().map((dir) => ({ dir, source: 'custom' })),
    { dir: USER_SKILL_DIR, source: 'user-dsh' },
  ]
  if (typeof cwd === 'string' && cwd) roots.push({ dir: join(cwd, WORKSPACE_SKILL_DIR), source: 'project-dsh' })
  const found = new Map()
  for (const root of roots) {
    for (const candidate of await scanSkillDir(root.dir, root.source)) {
      if (!found.has(candidate.name)) found.set(candidate.name, candidate)
    }
  }
  return found
}

/**
 * 解析 bundled 技能正文(去掉 frontmatter)。
 * @param candidate - bundled 候选。
 * @returns { content }。
 */
async function readBundledContent(candidate) {
  const text = await readFile(candidate.locator, 'utf8')
  return parseFrontmatter(text).body.trim()
}

const provider = {
  name: PROVIDER_NAME,
  /**
   * 列出技能候选:bundled 技能 + 测试模式专属外部技能。
   * @param options - { cwd } 当前工作区根目录。
   * @returns 候选数组。
   */
  async list(options = {}) {
    const external = await discoverExternalSkills(options.cwd)
    return [...CANDIDATES, ...external.values()]
  },
  /**
   * 加载技能正文。
   * @param candidate - list() 返回的候选。
   * @returns 技能定义(含正文)。
   */
  async get(candidate) {
    if (candidate?.provider !== PROVIDER_NAME) {
      throw new Error(`dsh-test-mode: unknown skill provider for ${String(candidate?.name)}`)
    }
    if (candidate.locator && typeof candidate.locator === 'object' && typeof candidate.locator.path === 'string') {
      // 外部技能:每次加载重新读取正文,修改后无需缓存失效。
      const text = await readFile(candidate.locator.path, 'utf8')
      return { ...candidate, content: parseFrontmatter(text).body.trim(), locator: candidate.locator }
    }
    const bundled = CANDIDATES.find((item) => item.name === candidate.name)
    if (!bundled) throw new Error(`dsh-test-mode: unknown skill candidate ${String(candidate?.name)}`)
    return {
      ...bundled,
      content: await readBundledContent(bundled),
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

/** 测试导出:技能扫描与解析(便于测试)。 */
export const internals = { parseFrontmatter, scanSkillDir, discoverExternalSkills, CANDIDATES }
