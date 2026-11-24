/**
 * 测试资产核心:接口资产 / UI 组件资产 / UI 流程资产。
 *
 * 资产存储:`test-mode/assets/api/<slug>.json`、`test-mode/assets/ui/<slug>.json`;
 * 状态机:`untested` → 首次执行成功 → `solid`(固化);失败 → `failed`;
 * 再次成功 → `solid`。不保存执行过程数据,只保留状态、统计与通过时的配置快照。
 *
 * 用例 = 资产组合:`cases/<id>.json` 的 `assets: [{ assetId, data?, skip? }]`。
 * 版本 = 全量系统测试快照:只有**所有资产均为 solid 且无过期**时才能保存。
 * @module @calwang414/dsh-test-mode/assets
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** 资产状态枚举。 */
export const ASSET_STATUS = { UNTESTED: 'untested', SOLID: 'solid', FAILED: 'failed' }

const ASSET_ROOT = 'assets'
const VERSION_ROOT = 'versions'

/** 安全文件名片段。 */
export function assetSlug(id) {
  return String(id ?? '').replace(/^[a-z]+:/, '').replace(/[^A-Za-z0-9_.-]+/g, '_').slice(0, 160)
}

/** 资产文件路径。 */
function assetPath(root, asset) {
  const dir = asset.kind === 'ui' ? 'ui' : 'api'
  return resolve(root, ASSET_ROOT, dir, `${assetSlug(asset.id)}.json`)
}

/** 读 JSON 文件,失败返回 undefined。 */
async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 列目录下 json 文件名(去扩展名)。 */
async function listJsonNames(dir) {
  try {
    const entries = await readdir(dir)
    return entries.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
  } catch {
    return []
  }
}

/** 原子写 JSON(先写临时文件再改名)。 */
async function writeJsonFile(path, value) {
  await mkdir(resolve(path, '..'), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(value, null, 2))
  await rm(path, { force: true }).catch(() => {})
  const { rename } = await import('node:fs/promises')
  await rename(tmp, path)
}

/**
 * 是否过期:已固化,但配置在上次通过之后被修改过(需要重新测试)。
 * @param asset - 资产对象。
 * @returns true 表示过期。
 */
export function isAssetStale(asset) {
  if (asset?.status !== ASSET_STATUS.SOLID) return false
  const passedAt = Date.parse(String(asset.lastPassed?.at ?? ''))
  const updatedAt = Date.parse(String(asset.updatedAt ?? ''))
  if (Number.isNaN(passedAt)) return true
  if (Number.isNaN(updatedAt)) return false
  return updatedAt > passedAt
}

/**
 * 列出全部资产(接口 + UI)。
 * @param root - test-mode 根目录。
 * @returns 资产数组。
 */
export async function listAssets(root) {
  const assets = []
  for (const kindDir of ['api', 'ui']) {
    const dir = resolve(root, ASSET_ROOT, kindDir)
    for (const name of await listJsonNames(dir)) {
      const asset = await readJsonFile(join(dir, `${name}.json`))
      if (asset?.id) assets.push(asset)
    }
  }
  return assets
}

/**
 * 读单个资产。
 * @param root - test-mode 根目录。
 * @param id - 资产 id。
 * @returns 资产对象或 undefined。
 */
export async function readAsset(root, id) {
  const candidates = [resolve(root, ASSET_ROOT, 'api', `${assetSlug(id)}.json`), resolve(root, ASSET_ROOT, 'ui', `${assetSlug(id)}.json`)]
  for (const path of candidates) {
    const asset = await readJsonFile(path)
    if (asset?.id) return asset
  }
  return undefined
}

/**
 * 写入资产(新增/更新);自动补 createdAt/updatedAt。
 * @param root - test-mode 根目录。
 * @param asset - 资产对象。
 * @returns 落盘后的资产。
 */
export async function writeAsset(root, asset, options = {}) {
  const now = new Date().toISOString()
  const previous = await readAsset(root, asset.id)
  const next = {
    ...asset,
    kind: asset.kind === 'ui' ? 'ui' : 'api',
    createdAt: previous?.createdAt ?? asset.createdAt ?? now,
    // touch:false = 只写运行时结果(状态/统计/lastPassed),配置未变,保留原 updatedAt;
    // 否则每次执行都会把 updatedAt 推到 lastPassed.at 之后,资产刚通过就被判为过期。
    updatedAt: options.touch === false ? (previous?.updatedAt ?? asset.updatedAt ?? now) : now,
  }
  await writeJsonFile(assetPath(root, next), next)
  return next
}

/**
 * 删除资产。
 * @param root - test-mode 根目录。
 * @param id - 资产 id。
 */
export async function deleteAsset(root, id) {
  for (const kindDir of ['api', 'ui']) {
    await rm(resolve(root, ASSET_ROOT, kindDir, `${assetSlug(id)}.json`), { force: true })
  }
}

/**
 * 按状态/模块/标签筛选资产。
 * @param root - test-mode 根目录。
 * @param filter - { kind?, module?, tag?, tags?, statuses? }。
 * @returns 资产数组。
 */
export async function queryAssets(root, filter = {}) {
  const assets = await listAssets(root)
  return assets.filter((asset) => {
    if (filter.kind && asset.kind !== filter.kind) return false
    if (filter.module && asset.module !== filter.module) return false
    if (filter.tag && !(asset.tags ?? []).includes(filter.tag)) return false
    if (Array.isArray(filter.tags) && filter.tags.length > 0 && !filter.tags.some((tag) => (asset.tags ?? []).includes(tag))) return false
    if (Array.isArray(filter.statuses) && filter.statuses.length > 0 && !filter.statuses.includes(asset.status)) return false
    return true
  })
}

/**
 * 待测资产:未测试 / 失败 / 过期(solid 但配置已改)。
 * @param root - test-mode 根目录。
 * @param filter - { kind?, module?, tag? }。
 * @returns { assets, counts }。
 */
export async function pendingAssets(root, filter = {}) {
  const assets = await queryAssets(root, filter)
  const pending = assets.filter((asset) => asset.status !== ASSET_STATUS.SOLID || isAssetStale(asset))
  const counts = {
    total: assets.length,
    pending: pending.length,
    untested: pending.filter((asset) => asset.status === ASSET_STATUS.UNTESTED).length,
    failed: pending.filter((asset) => asset.status === ASSET_STATUS.FAILED).length,
    stale: pending.filter((asset) => asset.status === ASSET_STATUS.SOLID).length,
    solid: assets.filter((asset) => asset.status === ASSET_STATUS.SOLID && !isAssetStale(asset)).length,
  }
  return { assets: pending, counts }
}

/** 结果 → 资产状态。 */
export function statusFromPass(pass) {
  return pass === true ? ASSET_STATUS.SOLID : ASSET_STATUS.FAILED
}

/**
 * 把一次执行结果写回资产:状态、统计、lastRun;通过时记录 lastPassed(配置快照)。
 * @param root - test-mode 根目录。
 * @param asset - 资产对象。
 * @param outcome - { pass, durationMs?, environmentId?, status?, snapshot? }。
 * @returns 更新后的资产。
 */
export async function applyAssetOutcome(root, asset, outcome) {
  const now = new Date().toISOString()
  const pass = outcome.pass === true
  const durationMs = Math.max(Number(outcome.durationMs ?? 0) || 0, 0)
  const previousStats = asset.stats ?? { runs: 0, passed: 0, failed: 0, totalDurationMs: 0 }
  const stats = {
    runs: (previousStats.runs ?? 0) + 1,
    passed: (previousStats.passed ?? 0) + (pass ? 1 : 0),
    failed: (previousStats.failed ?? 0) + (pass ? 0 : 1),
    totalDurationMs: (previousStats.totalDurationMs ?? 0) + durationMs,
  }
  const lastRun = {
    pass,
    at: now,
    durationMs,
    ...(typeof outcome.status === 'number' ? { status: outcome.status } : {}),
    ...(outcome.environmentId ? { environmentId: outcome.environmentId } : {}),
    ...(outcome.error ? { error: String(outcome.error).slice(0, 300) } : {}),
  }
  const next = { ...asset, status: statusFromPass(pass), stats, lastRun }
  if (pass) {
    next.lastPassed = {
      at: now,
      durationMs,
      ...(outcome.environmentId ? { environmentId: outcome.environmentId } : {}),
      ...(outcome.snapshot !== undefined ? { snapshot: outcome.snapshot } : {}),
    }
  }
  return writeAsset(root, next, { touch: false })
}

/**
 * 保存版本:要求所有资产均为 solid 且无过期。
 * @param root - test-mode 根目录。
 * @param options - { name?, environmentId? }。
 * @returns { ok: true, version } 或 { ok: false, code, message, failing }。
 */
export async function saveVersion(root, options = {}) {
  const assets = await listAssets(root)
  if (assets.length === 0) return { ok: false, code: 'empty', message: '还没有任何资产,无法保存版本' }
  const failing = assets.filter((asset) => asset.status !== ASSET_STATUS.SOLID || isAssetStale(asset))
    .map((asset) => ({ id: asset.id, name: asset.name, kind: asset.kind, status: asset.status, stale: isAssetStale(asset) }))
  if (failing.length > 0) {
    return { ok: false, code: 'incomplete', message: `还有 ${failing.length} 个资产未通过或已过期,不能保存版本`, failing }
  }
  const versions = await listVersions(root)
  const previous = versions[0]
  const now = new Date().toISOString()
  const byModule = new Map()
  for (const asset of assets) {
    const moduleName = asset.module ?? '未分组'
    const entry = byModule.get(moduleName) ?? { module: moduleName, total: 0, passed: 0, failed: 0 }
    entry.total += 1
    entry.passed += 1
    byModule.set(moduleName, entry)
  }
  const version = {
    id: `version-${now.replace(/[^0-9]/g, '').slice(0, 14)}`,
    name: String(options.name ?? '').trim() || `全量系统测试 ${new Date(now).toLocaleString()}`,
    createdAt: now,
    environmentId: options.environmentId,
    coverage: { assetsTotal: assets.length, assetsExecuted: assets.length, solid: assets.length, failed: 0, untested: 0 },
    summary: { total: assets.length, passed: assets.length, failed: 0 },
    byModule: [...byModule.values()],
    failedAssets: [],
    previousVersionId: previous?.id,
    durationMs: 0,
  }
  await writeJsonFile(resolve(root, VERSION_ROOT, `${version.id}.json`), version)
  return { ok: true, version }
}

/**
 * 列出版本(按时间倒序)。
 * @param root - test-mode 根目录。
 * @returns 版本数组。
 */
export async function listVersions(root) {
  const dir = resolve(root, VERSION_ROOT)
  const versions = []
  for (const name of await listJsonNames(dir)) {
    const version = await readJsonFile(join(dir, `${name}.json`))
    if (version?.id) versions.push(version)
  }
  return versions.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
}

/**
 * 读取单个版本。
 * @param root - test-mode 根目录。
 * @param id - 版本 id。
 */
export async function readVersion(root, id) {
  return readJsonFile(resolve(root, VERSION_ROOT, `${assetSlug(id)}.json`))
}

/**
 * 删除版本(由用户手工触发)。
 * @param root - test-mode 根目录。
 * @param id - 版本 id。
 */
export async function deleteVersion(root, id) {
  await rm(resolve(root, VERSION_ROOT, `${assetSlug(id)}.json`), { force: true })
}

/** 资产统计汇总(资产库页头)。 */
export function assetSummary(assets) {
  const counts = { total: assets.length, untested: 0, solid: 0, failed: 0, stale: 0 }
  for (const asset of assets) {
    if (asset.status === ASSET_STATUS.SOLID) {
      if (isAssetStale(asset)) counts.stale += 1
      else counts.solid += 1
    } else if (asset.status === ASSET_STATUS.FAILED) counts.failed += 1
    else counts.untested += 1
  }
  return counts
}
