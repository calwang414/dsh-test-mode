/**
 * 旧数据 → 测试资产迁移(增量、非破坏):
 * - `api/projects/*.json` 的每个请求 → `assets/api/<id>.json`(接口资产);
 * - `ui/scripts/*.json` → `assets/ui/<id>.json`(UI 流程资产);
 * - `cases/*.json` 追加 `assets` 引用数组(保留原 `steps`,旧版插件仍可用);
 * - 写入 `migration-assets.json` 清单(计数/告警/时间)。
 *
 * 状态映射:lastRun.pass → solid;lastRun 存在且失败 → failed;无 lastRun → untested。
 * 不迁移 reports/plans/results(属于旧模型的过程数据,后续归档)。
 * @module @calwang414/dsh-test-mode/migrate-assets
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** 把 id/名称压成安全片段。 */
function alias(text, fallback = 'item') {
  const raw = String(text ?? '').trim() || fallback
  return raw.replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 80)
}

/** 读 JSON,不存在返回 undefined。 */
async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 列目录下的 .json 文件名(不含扩展名)。 */
async function listJsonNames(dir) {
  try {
    const names = await readdir(dir)
    return names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
  } catch {
    return []
  }
}

/** 由 lastRun 推导资产状态。 */
function deriveStatus(lastRun) {
  if (!lastRun || typeof lastRun !== 'object') return 'untested'
  return lastRun.pass === true ? 'solid' : 'failed'
}

/**
 * 迁移一个工作区的 test-mode 目录到资产模型。
 * @param root - test-mode 根目录。
 * @param options - { dryRun?: boolean }。
 * @returns 迁移清单 { counts, warnings, written }。
 */
export async function migrateLegacyAssets(root, options = {}) {
  const dryRun = options.dryRun === true
  const caseDir = resolve(root, 'cases')
  const projectDir = resolve(root, 'api/projects')
  const scriptDir = resolve(root, 'ui/scripts')
  const assetsRoot = resolve(root, 'assets')
  const warnings = []
  const written = []
  const refToAsset = new Map()

  // ── 1. 接口资产 ────────────────────────────────────────────────────────
  const apiAssets = []
  for (const projectName of await listJsonNames(projectDir)) {
    const project = await readJsonFile(join(projectDir, `${projectName}.json`))
    if (!project) continue
    const projectId = project.id ?? projectName
    for (const collection of project.collections ?? []) {
      const collectionId = collection.id ?? (collection.name ? `col-${collection.name}` : 'col')
      for (const request of collection.requests ?? []) {
        const requestId = request.id ?? (request.name ? `req-${request.name}` : 'req')
        const assetId = `api:${alias(projectId)}.${alias(collectionId)}.${alias(requestId)}`
        const lastRun = request.lastRun ?? null
        const asset = {
          id: assetId,
          kind: 'api',
          module: project.name ?? projectId,
          name: request.name ?? request.url ?? requestId,
          tags: [collection.name, project.name].filter((tag) => typeof tag === 'string' && tag),
          source: { projectId, collectionId, requestId, projectName: project.name, collectionName: collection.name },
          request: {
            method: request.method ?? 'GET',
            url: request.url ?? '',
            ...(request.headers !== undefined ? { headers: request.headers } : {}),
            ...(request.query !== undefined ? { query: request.query } : {}),
            ...(request.body !== undefined ? { body: request.body } : {}),
            ...(request.assertions !== undefined ? { assertions: request.assertions } : {}),
            ...(request.extract !== undefined ? { extract: request.extract } : {}),
          },
          baseUrl: project.baseUrl ?? '',
          status: deriveStatus(lastRun),
          stats: request.stats,
          lastRun: lastRun ?? undefined,
          lastPassed: request.lastPassed,
          migratedAt: new Date().toISOString(),
        }
        apiAssets.push(asset)
        refToAsset.set(`${projectId}|${collectionId}|${requestId}`, assetId)
        // 兼容 steps 里可能出现的别名(名称形式)
        refToAsset.set(`${projectId}|${collection.name}|${request.name}`, assetId)
      }
    }
  }

  // ── 2. UI 流程资产 ────────────────────────────────────────────────────
  const uiAssets = []
  for (const scriptName of await listJsonNames(scriptDir)) {
    const script = await readJsonFile(join(scriptDir, `${scriptName}.json`))
    if (!script) continue
    const scriptId = script.id ?? scriptName
    const lastRun = script.lastRun ?? null
    const asset = {
      id: `ui:${alias(scriptId)}`,
      kind: 'ui',
      type: 'flow',
      module: script.module ?? 'UI',
      name: script.name ?? scriptId,
      tags: Array.isArray(script.tags) ? script.tags : [],
      steps: Array.isArray(script.steps) ? script.steps : [],
      status: deriveStatus(lastRun),
      stats: script.stats,
      lastRun: lastRun ?? undefined,
      lastPassed: script.lastPassed,
      migratedAt: new Date().toISOString(),
    }
    uiAssets.push(asset)
    refToAsset.set(`script|${scriptId}`, asset.id)
  }

  // ── 3. 写资产文件(已存在时保留其状态/统计,不覆盖运行时结果) ─────────
  const writeAsset = async (asset) => {
    const dir = asset.kind === 'api' ? join(assetsRoot, 'api') : join(assetsRoot, 'ui')
    const path = join(dir, `${asset.id.replace(/^[a-z]+:/, '')}.json`)
    if (!dryRun) {
      await mkdir(dir, { recursive: true })
      const existing = await readJsonFile(path)
      if (existing) {
        const merged = {
          ...asset,
          status: existing.status ?? asset.status,
          stats: existing.stats ?? asset.stats,
          lastRun: existing.lastRun ?? asset.lastRun,
          lastPassed: existing.lastPassed ?? asset.lastPassed,
          createdAt: existing.createdAt ?? asset.migratedAt,
        }
        await writeFile(path, JSON.stringify(merged, null, 2))
      } else {
        await writeFile(path, JSON.stringify({ ...asset, createdAt: asset.migratedAt }, null, 2))
      }
    }
    written.push(path)
  }
  for (const asset of apiAssets) await writeAsset(asset)
  for (const asset of uiAssets) await writeAsset(asset)

  // ── 4. 用例:追加资产引用(保留原 steps) ────────────────────────────
  let casesUpdated = 0
  let caseRefs = 0
  const caseWarnings = []
  for (const caseName of await listJsonNames(caseDir)) {
    const path = join(caseDir, `${caseName}.json`)
    const testCase = await readJsonFile(path)
    if (!testCase) continue
    const assets = []
    for (const [index, step] of (testCase.steps ?? []).entries()) {
      const ref = step?.requestRef
      const uiRef = step?.uiRef
      if (ref && typeof ref === 'object') {
        const key = `${ref.projectId}|${ref.collectionId}|${ref.requestId}`
        const assetId = refToAsset.get(key)
        if (assetId) assets.push({ assetId })
        else caseWarnings.push(`case ${caseName} step ${index}: requestRef 未找到对应资产(${key})`)
      } else if (uiRef && typeof uiRef === 'object' && uiRef.scriptId) {
        const assetId = refToAsset.get(`script|${uiRef.scriptId}`)
        if (assetId) assets.push({ assetId })
        else caseWarnings.push(`case ${caseName} step ${index}: uiRef 未找到对应资产(${uiRef.scriptId})`)
      }
    }
    if (assets.length === 0) {
      caseWarnings.push(`case ${caseName}: 没有可迁移的资产引用(纯手工/描述性用例)`)
      continue
    }
    const next = { ...testCase, assets, migratedAt: new Date().toISOString() }
    if (!dryRun) await writeFile(path, JSON.stringify(next, null, 2))
    casesUpdated += 1
    caseRefs += assets.length
  }

  const manifest = {
    migratedAt: new Date().toISOString(),
    root,
    dryRun,
    counts: {
      apiAssets: apiAssets.length,
      uiAssets: uiAssets.length,
      casesUpdated,
      caseAssetRefs: caseRefs,
    },
    warnings: [...warnings, ...caseWarnings].slice(0, 500),
  }
  if (!dryRun) {
    await writeFile(resolve(root, 'migration-assets.json'), JSON.stringify(manifest, null, 2))
  }
  return manifest
}

/** 递归统计目录文件数/字节(备份统计用)。 */
export async function dirStats(path) {
  let files = 0
  let bytes = 0
  const walk = async (dir) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const child = join(dir, entry.name)
      if (entry.isDirectory()) await walk(child)
      else {
        files += 1
        try {
          bytes += (await stat(child)).size
        } catch {
          // 忽略瞬时文件
        }
      }
    }
  }
  await walk(path)
  return { files, bytes }
}
