/**
 * 安全回归支持:安全专用资产的识别、软校验与脚手架生成。
 *
 * 安全专用资产不是新的资产类型,仍是 `kind: 'api' | 'ui'`;通过
 * `security: { category, sourceAssetId }` 标记安全语义,并用强负向断言
 * (401/403/404、错误信息不泄露)验证。
 *
 * 脚手架只生成资产与工作项的计划/文件,不执行攻击,也不改动被克隆的源资产。
 * @module @calwang414/dsh-test-mode/security
 */

import { newId } from './store.js'

/** 安全资产识别标签。 */
export const SECURITY_TAGS = ['安全', 'security']

/** 安全脚手架单次最多处理的源资产数。 */
export const SECURITY_SCAFFOLD_LIMIT = 20

/** 安全资产类别文案。 */
const CATEGORY_LABELS = {
  auth: '无凭证',
  'not-found': '不存在ID',
  leak: '错误信息泄露',
  idor: '越权他人资源',
}

/** 把 id/名称压成 ascii 片段。 */
function slug(text) {
  return String(text ?? 'asset').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'asset'
}

/**
 * 是否安全专用资产(按 security 字段、模块或标签识别)。
 * @param asset - 资产对象。
 * @returns true 表示安全资产。
 */
export function isSecurityAsset(asset) {
  if (!asset || typeof asset !== 'object') return false
  if (asset.security && typeof asset.security === 'object') return true
  const tags = Array.isArray(asset.tags) ? asset.tags : []
  if (tags.some((tag) => SECURITY_TAGS.includes(String(tag)))) return true
  return /安全|security/i.test(String(asset.module ?? '')) || /安全|security/i.test(String(asset.name ?? ''))
}

/**
 * 安全资产软校验:只提示,不拒绝保存。
 * @param asset - 资产对象。
 * @returns { warnings, category } warnings 为空表示未发现问题。
 */
export function securityAssetWarnings(asset) {
  const warnings = []
  const category = asset?.security?.category
  if (!isSecurityAsset(asset)) return { warnings, category }
  const request = asset.request ?? {}
  const assertions = Array.isArray(request.assertions) ? request.assertions : []
  if (assertions.length === 0) warnings.push('安全资产没有断言')
  const statusAssertions = assertions.filter((item) => item?.type === 'status')
  const successOnly = statusAssertions.length > 0
    && statusAssertions.every((item) => (item.operator ?? 'eq') === 'eq' && Number(item.expected) >= 200 && Number(item.expected) < 300)
  if (successOnly) warnings.push('状态断言只期望 2xx,安全场景通常应期望 4xx(401/403/404)')
  if (category === 'idor' && String(request.url ?? '').includes('{{OTHER_ID}}')) {
    warnings.push('越权资产需要配置 OTHER_ID(他人资源 id),否则不会命中真实越权场景')
  }
  if (category === 'not-found' && !/\d{3,}|999999/.test(String(request.url ?? ''))) {
    warnings.push('不存在 ID 资产未替换为真实不存在的 id')
  }
  return { warnings, category }
}

/** 克隆并移除认证相关请求头(不区分大小写)。 */
function stripAuthHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return headers
  const drop = new Set(['authorization', 'cookie', 'x-token', 'x-auth-token', 'x-api-key', 'token'])
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !drop.has(key.toLowerCase())))
}

/** 把 URL 中最后一个纯数字路径段替换为指定值。 */
function replaceNumericId(url, value) {
  const text = String(url ?? '')
  const match = /(^|\/)(\d+)(?=\/|$|\?)/g
  let last = null
  for (const found of text.matchAll(match)) last = found
  if (!last) return undefined
  const index = last.index + last[1].length
  return `${text.slice(0, index)}${value}${text.slice(index + last[2].length)}`
}

/** 深拷贝请求配置。 */
function cloneRequest(request) {
  return JSON.parse(JSON.stringify(request ?? {}))
}

/** 生成安全断言:状态 4xx(非 5xx)+ 错误信息不泄露。 */
function negativeAssertions() {
  return [
    { type: 'status', operator: 'ge', expected: 400 },
    { type: 'status', operator: 'lt', expected: 500 },
    { type: 'body', operator: 'not_contains', expected: 'stack' },
    { type: 'body', operator: 'not_contains', expected: 'SQL' },
    { type: 'body', operator: 'not_contains', expected: 'goroutine' },
    { type: 'body', operator: 'not_contains', expected: 'panic' },
  ]
}

/**
 * 为一个接口资产生成安全回归资产与工作项计划(纯函数,不写盘)。
 * @param sources - 源资产数组(通常为接口资产)。
 * @param options - { existingAssetIds?: Set|Array, existingCaseNames?: Set|Array, availableTags?: string[], includeIdor?: boolean }。
 * @returns { assets, workItems, skipped, warnings }。
 */
export function planSecurityScaffold(sources, options = {}) {
  const existingAssetIds = new Set(options.existingAssetIds ?? [])
  const existingCaseNames = new Set(options.existingCaseNames ?? [])
  const availableTags = new Set(options.availableTags ?? [])
  const assets = []
  const workItems = []
  const skipped = []
  const warnings = []
  let sourcesUsed = 0
  for (const source of sources ?? []) {
    if (sourcesUsed >= SECURITY_SCAFFOLD_LIMIT) break
    if (!source || source.kind !== 'api' || !source.request?.url) {
      skipped.push({ sourceId: source?.id, reason: '不是接口资产或缺少 URL' })
      continue
    }
    sourcesUsed += 1
    const base = source.baseUrl ?? ''
    const request = cloneRequest(source.request)
    const variants = []

    // 1) 无凭证访问:去掉认证头,期望 4xx
    variants.push({
      suffix: 'auth-missing',
      category: 'auth',
      name: `安全-${source.name ?? source.id}-无凭证`,
      request: { ...cloneRequest(request), headers: stripAuthHeaders(request.headers), assertions: negativeAssertions() },
    })
    // 2) 不存在 ID:仅当 URL 有数字路径段时可安全替换
    const notFoundUrl = replaceNumericId(request.url, '999999')
    if (notFoundUrl) {
      variants.push({
        suffix: 'not-found',
        category: 'not-found',
        name: `安全-${source.name ?? source.id}-不存在ID`,
        request: { ...cloneRequest(request), url: notFoundUrl, assertions: negativeAssertions() },
      })
    }
    // 3) 错误信息泄露:使用原请求,断言错误信息不泄露内部细节
    variants.push({
      suffix: 'leak',
      category: 'leak',
      name: `安全-${source.name ?? source.id}-错误信息不泄露`,
      request: {
        ...cloneRequest(request),
        assertions: [
          { type: 'body', operator: 'not_contains', expected: 'stack' },
          { type: 'body', operator: 'not_contains', expected: 'SQL' },
          { type: 'body', operator: 'not_contains', expected: 'goroutine' },
          { type: 'body', operator: 'not_contains', expected: 'panic' },
        ],
      },
    })
    // 4) 越权(IDOR):替换为他人资源占位符,需人工配置 OTHER_ID
    if (options.includeIdor === true) {
      const idorUrl = replaceNumericId(request.url, '{{OTHER_ID}}')
      if (idorUrl) {
        variants.push({
          suffix: 'idor',
          category: 'idor',
          name: `安全-${source.name ?? source.id}-越权他人资源(需配置 OTHER_ID)`,
          request: { ...cloneRequest(request), url: idorUrl, assertions: negativeAssertions() },
        })
        warnings.push(`越权资产 ${source.name ?? source.id} 需要配置 OTHER_ID 后才有意义`)
      }
    }

    const usedIds = []
    for (const variant of variants) {
      const id = `api:security.${slug(source.id)}.${variant.suffix}`
      if (existingAssetIds.has(id)) {
        skipped.push({ assetId: id, reason: '资产已存在' })
        continue
      }
      assets.push({
        id,
        kind: 'api',
        module: '安全',
        name: variant.name,
        tags: ['安全', '回归', ...(availableTags.has('安全回归') ? ['安全回归'] : [])].filter((tag, index, list) => list.indexOf(tag) === index),
        baseUrl: base,
        request: variant.request,
        status: 'untested',
        security: { category: variant.category, sourceAssetId: source.id },
      })
      usedIds.push(id)
    }

    const itemName = `安全回归-${source.module ?? '未分组'}-${source.name ?? source.id}`
    if (usedIds.length === 0) {
      skipped.push({ sourceId: source.id, reason: '没有新增安全资产' })
      continue
    }
    if (existingCaseNames.has(itemName)) {
      skipped.push({ sourceId: source.id, reason: '安全回归工作项已存在' })
      continue
    }
    workItems.push({
      id: newId('case'),
      name: itemName,
      type: 'security',
      priority: 'high',
      automation: 'auto',
      result: 'not_run',
      requirement: typeof source.requirement === 'string' ? source.requirement : '',
      defects: [],
      module: source.module ?? '安全',
      tags: availableTags.has('安全') ? ['安全'] : [],
      status: 'active',
      assets: usedIds.map((assetId) => ({ assetId })),
    })
  }
  return { assets, workItems, skipped, warnings }
}

/**
 * 版本保存前的安全门禁:安全类工作项必须全部通过。
 * @param cases - 工作项数组。
 * @returns { items, total, passed, failing } failing 为未通过的安全工作项。
 */
export function securityGate(cases) {
  const items = (cases ?? []).filter((testCase) => testCase?.type === 'security'
    || (Array.isArray(testCase?.tags) && testCase.tags.some((tag) => SECURITY_TAGS.includes(String(tag)))))
  const failing = items.filter((testCase) => testCase.result !== 'passed')
  return {
    total: items.length,
    passed: items.length - failing.length,
    failing: failing.map((testCase) => ({ id: testCase.id, name: testCase.name, result: testCase.result ?? 'not_run' })),
  }
}
