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

import { cp, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
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
 *
 * 安全约束:
 * - **默认 dry-run**,必须显式传 `{ apply: true }`(或 `{ dryRun: false }`)才写盘;
 * - 已存在 `cases[].assets` 的用例**绝不覆盖**:保留原数组,只追加 legacy steps
 *   推导出且尚不存在的引用;
 * - 写盘前自动备份 `cases/` 到 `backup-assets-migration-<时间戳>/`,路径写入 manifest;
 * - 写盘前校验用例资产引用总数不减少,写盘后再校验一致,不一致直接抛错。
 * @param root - test-mode 根目录。
 * @param options - { apply?: boolean, dryRun?: boolean }。
 * @returns 迁移清单 { counts, warnings, backup?, verify? }。
 */
export async function migrateLegacyAssets(root, options = {}) {
  const apply = options.apply === true || options.dryRun === false
  const dryRun = !apply
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

  // ── 4. 测试工作项:合并资产引用(绝不覆盖已有 assets) ────────────────
  // 只从 legacy steps[].requestRef / uiRef 推导;已存在的 assets(含 data/skip)
  // 原样保留,并只追加尚不存在的引用。
  const caseNames = await listJsonNames(caseDir)
  const plannedWrites = []
  let casesUpdated = 0
  let casesPreserved = 0
  let refsBefore = 0
  let refsAfter = 0
  const caseWarnings = []
  for (const caseName of caseNames) {
    const path = join(caseDir, `${caseName}.json`)
    const testCase = await readJsonFile(path)
    if (!testCase) continue
    const existingAssets = (Array.isArray(testCase.assets) ? testCase.assets : [])
      .filter((entry) => entry && typeof entry.assetId === 'string')
    refsBefore += existingAssets.length

    const derived = []
    for (const [index, step] of (testCase.steps ?? []).entries()) {
      const ref = step?.requestRef
      const uiRef = step?.uiRef
      if (ref && typeof ref === 'object') {
        const key = `${ref.projectId}|${ref.collectionId}|${ref.requestId}`
        const assetId = refToAsset.get(key)
        if (assetId) derived.push({ assetId })
        else caseWarnings.push(`case ${caseName} step ${index}: requestRef 未找到对应资产(${key})`)
      } else if (uiRef && typeof uiRef === 'object' && uiRef.scriptId) {
        const assetId = refToAsset.get(`script|${uiRef.scriptId}`)
        if (assetId) derived.push({ assetId })
        else caseWarnings.push(`case ${caseName} step ${index}: uiRef 未找到对应资产(${uiRef.scriptId})`)
      }
    }

    const known = new Set(existingAssets.map((entry) => entry.assetId))
    const appended = existingAssets.length > 0 ? derived.filter((entry) => !known.has(entry.assetId)) : derived
    const assets = [...existingAssets, ...appended]
    refsAfter += assets.length
    if (existingAssets.length > 0) casesPreserved += 1
    else if (assets.length === 0) caseWarnings.push(`case ${caseName}: 没有可迁移的资产引用(纯手工/描述性用例)`)

    // 旧用例 → 测试工作项字段补齐;类型按是否含 UI 资产/UI 步骤推断。
    const uiAssetIds = new Set(uiAssets.map((asset) => asset.id))
    const hasUi = assets.some((entry) => uiAssetIds.has(entry.assetId) || String(entry.assetId).startsWith('ui:'))
      || (testCase.steps ?? []).some((step) => step?.uiRef)
    const defaults = {
      type: testCase.type ?? (hasUi ? 'e2e' : 'functional'),
      automation: testCase.automation ?? (assets.length > 0 ? 'auto' : 'manual'),
      result: testCase.result ?? 'not_run',
      requirement: typeof testCase.requirement === 'string' ? testCase.requirement : '',
      defects: Array.isArray(testCase.defects) ? testCase.defects : [],
    }
    const assetsChanged = JSON.stringify(assets) !== JSON.stringify(existingAssets)
    const fieldsMissing = testCase.type === undefined || testCase.automation === undefined
      || testCase.result === undefined || testCase.requirement === undefined || testCase.defects === undefined
    if (assetsChanged || fieldsMissing) {
      plannedWrites.push({
        path,
        caseName,
        next: { ...testCase, ...defaults, assets },
      })
      casesUpdated += 1
    }
  }

  // 一致性守卫:迁移不得减少任何用例的资产引用。
  if (refsAfter < refsBefore) {
    throw new Error(`migration aborted: case asset refs would shrink (${refsBefore} -> ${refsAfter}); no files were written`)
  }

  let backup
  if (!dryRun && plannedWrites.length > 0) {
    // 写盘前备份 cases/(记录到 manifest,可手工回滚)。
    const stamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)
    const backupDir = join(root, `backup-assets-migration-${stamp}`)
    await mkdir(backupDir, { recursive: true })
    if (await stat(caseDir).then(() => true).catch(() => false)) {
      await cp(caseDir, join(backupDir, 'cases'), { recursive: true, force: true })
    }
    backup = `backup-assets-migration-${stamp}`
    for (const item of plannedWrites) {
      await writeFile(item.path, JSON.stringify(item.next, null, 2))
    }
    // 写盘后复核:磁盘上的真实引用数必须等于计划值。
    let onDisk = 0
    for (const caseName of await listJsonNames(caseDir)) {
      const testCase = await readJsonFile(join(caseDir, `${caseName}.json`))
      if (Array.isArray(testCase?.assets)) onDisk += testCase.assets.filter((entry) => entry && typeof entry.assetId === 'string').length
    }
    if (onDisk !== refsAfter) {
      throw new Error(`migration verification failed: case asset refs on disk ${onDisk} != expected ${refsAfter}; backup at ${backup}`)
    }
  }

  const manifest = {
    migratedAt: new Date().toISOString(),
    root,
    dryRun,
    counts: {
      apiAssets: apiAssets.length,
      uiAssets: uiAssets.length,
      casesUpdated,
      casesPreserved,
      caseRefsBefore: refsBefore,
      caseAssetRefs: refsAfter,
    },
    wouldWrite: plannedWrites.length,
    warnings: [...warnings, ...caseWarnings].slice(0, 500),
    ...(backup ? { backup } : {}),
  }
  if (!dryRun) {
    manifest.archive = await archiveLegacyDirs(root)
    await writeFile(resolve(root, 'migration-assets.json'), JSON.stringify(manifest, null, 2))
  }
  return manifest
}

/**
 * 把旧模型的过程数据目录(plans/reports/results)移到 `legacy-<时间戳>/`,
 * 不删除、可手工找回;重复调用幂等(已归档则跳过)。
 * @param root - test-mode 根目录。
 * @param options - { dryRun?: boolean }。
 * @returns { bucket, moved }。
 */
export async function archiveLegacyDirs(root, options = {}) {
  const dryRun = options.dryRun === true
  let bucket = `legacy-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`
  const existingBuckets = (await readdir(root).catch(() => [])).filter((name) => name.startsWith('legacy-'))
  if (existingBuckets.length > 0) {
    const newest = existingBuckets.sort().at(-1)
    // 复用已有归档目录,避免每次迁移都新建
    if (newest) bucket = newest
  }
  const moved = []
  for (const dir of ['plans', 'reports', 'results']) {
    const from = resolve(root, dir)
    try {
      await stat(from)
    } catch {
      continue
    }
    const to = resolve(root, bucket, dir)
    if (!dryRun) {
      await mkdir(resolve(root, bucket), { recursive: true })
      try {
        await rename(from, to)
      } catch {
        continue
      }
    }
    moved.push(dir)
  }
  return { bucket, moved }
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
