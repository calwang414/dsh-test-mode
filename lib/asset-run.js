/**
 * 资产执行:接口资产(api)与 UI 资产(ui component / ui flow)的单次执行。
 * 只返回执行结果;状态/统计的落盘由调用方通过 `applyAssetOutcome` 完成。
 * @module @calwang414/dsh-test-mode/asset-run
 */

import { executeRequest } from './api-test.js'
import { executeUiScript } from './ui-test.js'

/**
 * 接口资产 → 执行请求,返回结果。
 * @param asset - 接口资产。
 * @param options - { variables, factories }。
 */
export async function runApiAsset(asset, options = {}) {
  const baseUrl = String(asset.baseUrl ?? '')
  const rawUrl = String(asset.request?.url ?? '')
  const url = /^https?:\/\//i.test(rawUrl)
    ? rawUrl
    : `${baseUrl.replace(/\/+$/, '')}/${rawUrl.replace(/^\/+/, '')}`
  const outcome = await executeRequest(
    { ...(asset.request ?? {}), url },
    options.variables ?? {},
    options.factories ?? {},
  )
  return {
    pass: outcome.ok === true,
    status: outcome.status,
    durationMs: outcome.durationMs,
    error: outcome.ok === true ? undefined : outcome.error,
    exports: outcome.exports,
    // 即时展示用的断言摘要(不落盘)
    assertions: outcome.assertions,
  }
}

/**
 * UI 资产 → 执行脚本步骤,返回结果。
 * @param asset - UI 资产(component / flow)。
 * @param options - { variables, factories, elements, root }。
 */
export async function runUiAsset(asset, options = {}) {
  const script = { name: asset.name ?? 'ui asset', steps: Array.isArray(asset.steps) ? asset.steps : [] }
  const report = await executeUiScript(
    {},
    script,
    options.elements ?? {},
    options.variables ?? {},
    options.factories ?? {},
    { root: options.root },
  )
  const firstFailure = (report.results ?? []).find((result) => result.pass !== true)
  return {
    pass: report.summary.failed === 0,
    durationMs: report.durationMs,
    error: report.summary.failed === 0 ? undefined : (firstFailure?.error ?? `${report.summary.failed} step(s) failed`),
    exports: report.exports,
    // 即时展示用的步骤摘要(不落盘)
    steps: (report.results ?? []).map((result) => ({ kind: result.kind, name: result.name, pass: result.pass, error: result.error })),
  }
}

/**
 * 执行单个资产(按 kind 分派)。
 * @param asset - 资产对象。
 * @param options - { variables, factories, elements, root }。
 * @returns 执行结果 { pass, durationMs, error?, status?, exports?, ... }。
 */
export async function runAsset(asset, options = {}) {
  return asset.kind === 'ui' ? runUiAsset(asset, options) : runApiAsset(asset, options)
}

/**
 * 用例级数据覆盖 → 生成用于执行的有效资产副本。
 * api 资产支持覆盖 request 的 body/headers/query/url;ui 资产可覆盖变量(忽略)。
 * @param asset - 资产对象。
 * @param data - 用例条目上的 data 覆盖。
 * @returns 有效资产。
 */
export function withAssetData(asset, data) {
  if (!data || typeof data !== 'object' || asset.kind === 'ui') return asset
  const request = { ...(asset.request ?? {}) }
  for (const field of ['url', 'body', 'headers', 'query']) {
    if (data[field] !== undefined) request[field] = data[field]
  }
  return { ...asset, request }
}
