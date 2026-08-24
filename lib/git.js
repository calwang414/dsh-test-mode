/**
 * dsh-test-mode git 自动提交:test-mode 数据(用例/项目/计划/变更清单等)经
 * tools/post-execute 校验通过后,自动把变更提交到工作区所在的 git 仓库。
 *
 * 约束:
 * - **只提交 test-mode 路径**:`git commit -- <rel>` 按路径提交,仓库里其它
 *   未提交/已暂存的内容不受影响;
 * - **静默失败**:仓库缺失、test-mode 在仓库外、无实际变更、git 命令失败都
 *   返回 { committed: false },不抛错、不阻塞智能体的工具执行链;
 * - 查找仓库根:从工作区向上找最近的含 .git 的目录。
 * @module @calwang414/dsh-test-mode/git
 */

import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, relative, resolve, sep } from 'node:path'

const execFileAsync = promisify(execFile)

/** git 命令超时(毫秒),避免仓库锁死时拖住工具链。 */
const GIT_TIMEOUT_MS = 15000

/**
 * 从路径向上查找最近的 git 仓库根(含 .git 的目录)。
 * @param start - 起始目录。
 * @returns 仓库根绝对路径;未找到返回 null。
 */
export function findGitRoot(start) {
  let current = resolve(start)
  for (;;) {
    if (existsSync(resolve(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * 自动提交本次写入的 test-mode 文件:只 add + commit 该文件,不扫整个
 * test-mode/ 目录(避免把未提交的坏文件、会话 token(session.json)、报告等
 * 无关内容带进提交)。仓库缺失/无实际变更/git 命令失败时静默返回。
 * @param workspacePath - 工作区路径(test-mode 所在目录)。
 * @param relPath - 本次写入的 test-mode 相对路径(如 cases/a.json)。
 * @returns { committed, reason? } committed=true 表示产生了新提交。
 */
export async function autoCommitTestMode(workspacePath, relPath) {
  try {
    const repoRoot = findGitRoot(workspacePath)
    if (repoRoot === null) return { committed: false, reason: 'workspace is not inside a git repo' }
    const testModePath = resolve(workspacePath, 'test-mode')
    const testModeRel = relative(repoRoot, testModePath)
    if (testModeRel === '' || testModeRel === '..' || testModeRel.startsWith(`..${sep}`)) {
      return { committed: false, reason: 'test-mode is outside the git repo' }
    }
    const fileRel = `${testModeRel}/${String(relPath ?? '').replace(/^\/+/, '')}`
    if (!fileRel.endsWith('.json') && !/\.(csv|md|xlsx)$/i.test(fileRel)) {
      return { committed: false, reason: 'unsupported test-mode file type' }
    }
    const runGit = (args) => execFileAsync('git', args, { cwd: repoRoot, timeout: GIT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 })
    // :(literal) 防路径里的 glob 字符被 git 展开。
    await runGit(['add', '--', `:(literal)${fileRel}`])
    const staged = await runGit(['diff', '--cached', '--name-only', '--', `:(literal)${fileRel}`])
    if (!String(staged ?? '').trim()) return { committed: false, reason: 'no staged test-mode changes' }
    const message = `test-mode: ${String(relPath ?? fileRel).slice(0, 200)} 更新`
    await runGit(['commit', '-m', message, '--', `:(literal)${fileRel}`])
    return { committed: true }
  } catch (error) {
    return { committed: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
