/**
 * dsh-test-mode API 测试引擎:执行单个请求或整个集合,生成结构化报告。
 *
 * 能力:
 * - 变量替换:`{{VAR}}` 语法,变量来源按优先级——请求级 variables > 环境变量;
 * - 断言类型:
 *   - `status` — HTTP 状态码比较(eq/ne/gt/ge/lt/le);
 *   - `header` — 响应头包含/相等/正则;
 *   - `body` — 响应体文本包含/相等/正则;
 *   - `json` — JSON 响应体字段路径断言(`$.a.b[0].c`,支持点号路径与数组下标);
 *   - `duration` — 耗时上限(ms);
 * - 每个请求可声明 `extract`(从响应提取变量,供后续请求使用);
 * - 报告:summary(total/passed/failed) + 每个请求的逐条断言结果。
 *
 * 请求执行走 Node 原生 fetch(host 环境),超时由 AbortSignal 控制。
 * @module @calwang414/dsh-test-mode/api-test
 */

/** 单请求超时(毫秒)。 */
const REQUEST_TIMEOUT_MS = 30_000

/**
 * 数据工厂生成器:`{{rand.<type>}}` 语法在执行时动态生成测试数据。
 * 支持类型:phone(手机号)、email、name(中文姓名)、idcard(身份证号)、
 * uuid、timestamp(毫秒时间戳)、timestamp_s(秒)、date(YYYY-MM-DD)、
 * number:min:max(区间整数)、string:length(随机小写字母串)。
 * @module @calwang414/dsh-test-mode/api-test
 */

/** 随机整数 [min, max] 闭区间。 */
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

/** 从数组随机取一项。 */
function pick(list) {
  return list[randInt(0, list.length - 1)]
}

const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜'
const GIVEN = '伟芳娜敏静丽强磊军洋勇艳杰娟涛明超秀兰霞平刚桂英华玉梅红建'

/** 中文姓名(2-3 字)。 */
function randomName() {
  const surname = pick([...SURNAMES])
  const given = pick([...GIVEN]) + (Math.random() < 0.5 ? pick([...GIVEN]) : '')
  return surname + given
}

/** 手机号(1[3-9] 开头 11 位)。 */
function randomPhone() {
  return `1${pick([3, 4, 5, 6, 7, 8, 9])}${String(randInt(0, 999999999)).padStart(9, '0')}`
}

/** 邮箱。 */
function randomEmail() {
  const name = `user${randInt(1000, 99999)}`
  return `${name}@${pick(['example.com', 'test.cn', 'mail.dev', 'sample.io'])}`
}

/** 身份证号(18 位,校验位随机)。 */
function randomIdcard() {
  const region = pick(['110101', '310101', '440101', '330101', '510101'])
  const year = randInt(1960, 2005)
  const month = String(randInt(1, 12)).padStart(2, '0')
  const day = String(randInt(1, 28)).padStart(2, '0')
  const seq = String(randInt(0, 999)).padStart(3, '0')
  const check = pick('0123456789X')
  return `${region}${year}${month}${day}${seq}${check}`
}

/** UUID v4。 */
function randomUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** 随机小写字母串。 */
function randomString(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz'
  let out = ''
  for (let i = 0; i < length; i += 1) out += chars[randInt(0, chars.length - 1)]
  return out
}

/**
 * 内置数据工厂生成器清单:随插件自带的默认生成器,只读展示在数据工厂页面
 * (与用户自定义生成器并列),执行时通过 `{{rand.<key>}}` 引用。
 * 每个条目 { id, key, name, pattern, description, builtin: true },pattern
 * 是可直接用于预览/引用的模板。
 */
export const BUILTIN_FACTORY_ITEMS = [
  { id: 'builtin-phone', key: 'phone', name: '手机号', pattern: '{{rand.phone}}', description: '11 位手机号(1[3-9] 开头)' },
  { id: 'builtin-email', key: 'email', name: '邮箱', pattern: '{{rand.email}}', description: '随机邮箱' },
  { id: 'builtin-name', key: 'name', name: '中文姓名', pattern: '{{rand.name}}', description: '2-3 字随机姓名' },
  { id: 'builtin-idcard', key: 'idcard', name: '身份证号', pattern: '{{rand.idcard}}', description: '18 位身份证号' },
  { id: 'builtin-uuid', key: 'uuid', name: 'UUID', pattern: '{{rand.uuid}}', description: 'UUID v4' },
  { id: 'builtin-timestamp', key: 'timestamp', name: '时间戳', pattern: '{{rand.timestamp}}', description: '毫秒时间戳' },
  { id: 'builtin-timestamp_s', key: 'timestamp_s', name: '时间戳(秒)', pattern: '{{rand.timestamp_s}}', description: '秒级时间戳' },
  { id: 'builtin-date', key: 'date', name: '日期', pattern: '{{rand.date}}', description: 'YYYY-MM-DD' },
  { id: 'builtin-number', key: 'number', name: '数字', pattern: '{{rand.number:1:100}}', description: '区间整数(可改 min:max)' },
  { id: 'builtin-string', key: 'string', name: '随机串', pattern: '{{rand.string:8}}', description: '小写字母串(可改长度)' },
]

/**
 * 解析 `rand.<type>` 生成器表达式,返回生成值。
 * @param expr - `rand.phone` / `rand.number:1:100` / `rand.string:8` 等。
 * @returns 生成值;无法解析时返回 undefined。
 */
export function resolveRandom(expr) {
  const parts = String(expr).split(':')
  const type = parts[0]
  switch (type) {
    case 'phone': return randomPhone()
    case 'email': return randomEmail()
    case 'name': return randomName()
    case 'idcard': return randomIdcard()
    case 'uuid': return randomUuid()
    case 'timestamp': return String(Date.now())
    case 'timestamp_s': return String(Math.floor(Date.now() / 1000))
    case 'date': {
      const d = new Date()
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    case 'number': {
      const min = Number(parts[1] ?? 1)
      const max = Number(parts[2] ?? 100)
      return String(randInt(Number.isFinite(min) ? min : 1, Number.isFinite(max) ? max : 100))
    }
    case 'string': {
      const length = Number(parts[1] ?? 8)
      return randomString(Number.isFinite(length) && length > 0 ? Math.min(Math.floor(length), 64) : 8)
    }
    default: return undefined
  }
}

/**
 * 用变量表替换字符串中的 `{{VAR}}` 占位符;`{{rand.*}}` 内置数据工厂与
 * `{{factory.<key>}}` 用户自定义生成器优先于变量表(每次执行动态生成)。
 *
 * 用户生成器通过 `factories` 传入:`{ [key]: pattern }`,pattern 可嵌套
 * `{{rand.*}}`、变量与其它 `{{factory.*}}`,递归展开,深度上限防循环。
 * @param text - 原始文本。
 * @param variables - 变量表。
 * @param factories - 用户自定义生成器表(key → 模板)。
 * @param depth - 内部递归深度(调用方不传)。
 * @returns 替换后的文本(非字符串原样返回)。
 */
export function substitute(text, variables, factories = {}, depth = 0) {
  if (typeof text !== 'string') return text
  if (depth > 10) return text
  return text.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_.:]*)\s*\}\}/g, (match, name) => {
    if (name === 'rand' || name.startsWith('rand.')) {
      const value = resolveRandom(name.slice(5))
      if (value !== undefined) return value
    }
    if (name.startsWith('factory.')) {
      const key = name.slice('factory.'.length)
      const pattern = factories?.[key]
      if (typeof pattern === 'string') {
        return substitute(pattern, variables, factories, depth + 1)
      }
    }
    const value = variables?.[name]
    return value === undefined ? match : String(value)
  })
}

/** 递归替换对象/数组里的所有字符串值(携带用户生成器表)。 */
export function substituteDeep(value, variables, factories) {
  if (typeof value === 'string') return substitute(value, variables, factories)
  if (Array.isArray(value)) return value.map((item) => substituteDeep(item, variables, factories))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = substituteDeep(item, variables, factories)
    return out
  }
  return value
}

/**
 * 按点号路径读取 JSON 值(`$.a.b[0].c` 或 `a.b[0].c`)。
 * @param root - JSON 根。
 * @param path - 路径表达式。
 * @returns 命中的值,未命中返回 undefined。
 */
export function jsonPathGet(root, path) {
  const expr = String(path ?? '').replace(/^\$\.?/, '')
  if (!expr) return root
  let current = root
  for (const segment of expr.split('.')) {
    if (current === undefined || current === null) return undefined
    const match = /^([A-Za-z0-9_$-]+)((?:\[\d+\])*)$/.exec(segment)
    if (!match) return undefined
    current = current[match[1]]
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) {
      if (current === undefined || current === null || !Array.isArray(current)) return undefined
      current = current[Number(index[1])]
    }
  }
  return current
}

function compare(operator, actual, expected) {
  switch (operator) {
    case 'eq': return actual === expected
    case 'ne': return actual !== expected
    case 'gt': return actual > expected
    case 'ge': return actual >= expected
    case 'lt': return actual < expected
    case 'le': return actual <= expected
    case 'contains': return String(actual).includes(String(expected))
    case 'regex': {
      try { return new RegExp(String(expected)).test(String(actual)) } catch { return false }
    }
    default: return false
  }
}

/**
 * 执行一条断言。
 * @param assertion - { type, operator?, expected, path?, header? }。
 * @param context - { status, headers, text, json }。
 * @returns { pass, actual, expected }。
 */
function runAssertion(assertion, context) {
  const expected = assertion.expected
  switch (assertion.type) {
    case 'status': {
      const actual = context.status
      return { pass: compare(assertion.operator ?? 'eq', actual, expected), actual, expected }
    }
    case 'header': {
      const name = String(assertion.header ?? '').toLowerCase()
      const actual = context.headers[name] ?? undefined
      return { pass: compare(assertion.operator ?? 'contains', actual ?? '', expected), actual: actual ?? '', expected }
    }
    case 'body': {
      const actual = context.text
      return { pass: compare(assertion.operator ?? 'contains', actual, expected), actual: actual?.slice(0, 200), expected }
    }
    case 'json': {
      const actual = jsonPathGet(context.json, assertion.path)
      return { pass: compare(assertion.operator ?? 'eq', actual, expected), actual, expected, path: assertion.path }
    }
    case 'duration': {
      const actual = context.durationMs
      return { pass: compare('le', actual, expected), actual, expected }
    }
    default:
      return { pass: false, actual: undefined, expected, error: `unknown assertion type: ${assertion.type}` }
  }
}

/**
 * 从响应提取变量。规则 `{ name, path }` 或 `{ key, value }`(键名都接受);
 * `from: 'header'` 时 path 作为响应头名(如 set-cookie);`export: true` 的
 * 变量进入 exports(调用方写入会话缓存,供跨执行复用登录态)。
 * @param json - 响应 JSON。
 * @param extract - 提取规则。
 * @param responseHeaders - 响应头(Headers 实例,header 提取时需要)。
 * @returns { extracted, exports }。
 */
function extractVariables(json, extract, responseHeaders) {
  const out = {}
  const exports = {}
  for (const rule of extract ?? []) {
    const name = rule?.name ?? rule?.key
    const path = rule?.path ?? rule?.value
    if (!name) continue
    let value
    if (rule?.from === 'header') {
      const headerName = String(path ?? '').toLowerCase()
      if (headerName === 'set-cookie' && typeof responseHeaders?.getSetCookie === 'function') {
        const cookies = responseHeaders.getSetCookie()
        value = cookies.length > 0 ? cookies.join('; ') : null
      } else {
        value = responseHeaders?.get(String(path ?? '')) ?? null
      }
    } else {
      value = jsonPathGet(json, path)
    }
    if (value !== undefined && value !== null && value !== '') {
      out[name] = String(value)
      if (rule?.export === true) exports[name] = String(value)
    }
  }
  return { extracted: out, exports }
}

/** 创建一个流内 cookie jar(同一次执行内跨请求共享)。 */
export function cookieJarCreate() {
  return { cookies: new Map() }
}

/** 组装某 host 的 cookie header 值(无 cookie 时返回空串)。 */
function cookieJarHeader(jar, host) {
  const list = jar?.cookies?.get(host) ?? []
  return list.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
}

/** 把一条 set-cookie 存入 jar(按 host 隔离,同名覆盖)。 */
function cookieJarStore(jar, host, setCookieValue) {
  const pair = String(setCookieValue ?? '').split(';')[0].trim()
  const idx = pair.indexOf('=')
  if (idx <= 0) return
  const name = pair.slice(0, idx).trim()
  const value = pair.slice(idx + 1).trim()
  if (!name) return
  const list = (jar.cookies.get(host) ?? []).filter((cookie) => cookie.name !== name)
  list.push({ name, value })
  jar.cookies.set(host, list)
}

/**
 * 执行一个 API 请求。
 * @param request - { method, url, headers, query, body, assertions, extract }。
 * @param variables - 变量表。
 * @param factories - 数据工厂表。
 * @param jar - 可选流内 cookie jar(同一次执行内跨请求共享)。
 * @returns { ok, status, headers, text, json, durationMs, assertions, extracted, exports, error? }。
 */
export async function executeRequest(request, variables, factories, jar) {
  const started = Date.now()
  const merged = { ...(request.variables ?? {}), ...(variables ?? {}) }
  const method = String(request.method ?? 'GET').toUpperCase()
  const rawUrl = substitute(String(request.url ?? ''), merged, factories)
  const url = new URL(rawUrl)
  for (const [key, value] of Object.entries(substituteDeep(request.query ?? {}, merged, factories))) {
    url.searchParams.set(key, String(value))
  }
  const headers = {}
  for (const [key, value] of Object.entries(substituteDeep(request.headers ?? {}, merged, factories))) {
    headers[String(key).toLowerCase()] = String(value)
  }
  // 流内 cookie jar:未显式配置 cookie header 时自动带上 jar 中该 host 的 cookie。
  if (jar && headers.cookie === undefined) {
    const jarCookie = cookieJarHeader(jar, url.host)
    if (jarCookie) headers.cookie = jarCookie
  }
  let body
  if (request.body !== undefined && request.body !== null && method !== 'GET' && method !== 'HEAD') {
    const rawBody = request.body
    if (typeof rawBody === 'string') body = substitute(rawBody, merged, factories)
    else body = JSON.stringify(substituteDeep(rawBody, merged, factories))
  }
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  let response
  try {
    response = await fetch(url, { method, headers, body, signal: controller.signal, redirect: 'follow' })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
      assertions: [],
    }
  } finally {
    clearTimeout(timeout)
  }
  // set-cookie 自动存入 jar(仅流内共享,跨执行靠 extract export + 会话缓存)。
  if (jar && typeof response.headers.getSetCookie === 'function') {
    for (const setCookie of response.headers.getSetCookie()) cookieJarStore(jar, url.host, setCookie)
  }
  const text = await response.text().catch(() => '')
  const durationMs = Date.now() - started
  let json
  try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
  const context = {
    status: response.status,
    headers: response.headers,
    text,
    json,
    durationMs,
  }
  const assertions = (request.assertions ?? []).map((assertion) => runAssertion(assertion, context))
  const pass = assertions.every((item) => item.pass)
  const { extracted, exports } = extractVariables(json, request.extract, response.headers)
  return {
    ok: pass,
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    text: text.slice(0, 2000),
    json,
    durationMs,
    assertions,
    extracted,
    exports,
    error: pass ? undefined : `${assertions.filter((item) => !item.pass).length} assertion(s) failed`,
  }
}

/**
 * 执行整个集合(项目里的一个 collection),生成报告。
 * @param collection - { name, requests }。
 * @param baseUrl - 项目 baseUrl(请求 url 为相对路径时拼接)。
 * @param variables - 初始变量表(环境变量)。
 * @returns { name, startedAt, finishedAt, durationMs, summary, results }。
 */
export async function executeCollection(collection, baseUrl, variables, factories) {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const state = { ...(variables ?? {}) }
  const jar = cookieJarCreate()
  const results = []
  const exports = {}
  for (const request of collection.requests ?? []) {
    const url = /^https?:\/\//i.test(String(request.url ?? ''))
      ? request.url
      : `${String(baseUrl ?? '').replace(/\/+$/, '')}/${String(request.url ?? '').replace(/^\/+/, '')}`
    const outcome = await executeRequest({ ...request, url }, state, factories, jar)
    for (const [name, value] of Object.entries(outcome.extracted ?? {})) state[name] = value
    for (const [name, value] of Object.entries(outcome.exports ?? {})) exports[name] = value
    results.push({
      requestId: request.id,
      name: request.name,
      method: String(request.method ?? 'GET').toUpperCase(),
      url,
      pass: outcome.ok,
      status: outcome.status,
      durationMs: outcome.durationMs,
      assertions: outcome.assertions,
      error: outcome.error,
    })
  }
  const total = results.length
  const passed = results.filter((item) => item.pass).length
  return {
    name: collection.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary: { total, passed, failed: total - passed },
    results,
    exports,
  }
}

/**
 * 按用例步骤执行:每个绑定 API 请求的步骤依次执行(requestRef 指向项目
 * 内的请求),未绑定请求的步骤跳过并标记 skipped。变量在同一用例的步骤间
 * 流动(前一步 extract 的变量可供后续步骤使用)。
 *
 * @param testCase - 用例对象,步骤形如 { action, expected, requestRef?, uiRef? }。
 * @param resolveRef - (ref) => Promise<{ kind: 'request', request, baseUrl } |
 *   { kind: 'ui', script, elements } | null>,把 requestRef/uiRef 解析为可
 *   执行步骤;解析失败返回 null。
 * @param variables - 初始变量表(环境变量)。
 * @param factories - 数据工厂表。
 * @param runUi - (script, elements) => Promise<{ ok, durationMs?, error?, steps? }>,
 *   执行 UI 脚本(浏览器驱动由调用方提供);缺省时 ui 步骤失败。
 * @returns { name, startedAt, finishedAt, durationMs, summary, results }。
 *   results 每项: { stepIndex, step, kind?, requestId?/scriptId?, name?,
 *   method?/scriptName?, url?, pass?, status?, durationMs?, assertions?,
 *   uiSteps?, error?, skipped? }。
 */
export async function executeCase(testCase, resolveRef, variables, factories, runUi) {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const state = { ...(variables ?? {}) }
  const jar = cookieJarCreate()
  const exports = {}
  const results = []
  const steps = Array.isArray(testCase.steps) ? testCase.steps : []
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const ref = step?.requestRef ?? step?.uiRef
    const entry = { stepIndex: index, step: { action: step?.action ?? '', expected: step?.expected ?? '' } }
    if (!ref || typeof ref !== 'object') {
      entry.skipped = true
      entry.pass = null
      results.push(entry)
      continue
    }
    let resolved = null
    try {
      resolved = await resolveRef(ref)
    } catch {
      resolved = null
    }
    if (resolved === null) {
      entry.skipped = true
      entry.pass = null
      entry.error = `ref ${JSON.stringify(ref)} could not be resolved`
      results.push(entry)
      continue
    }

    // UI 脚本步骤:通过 runUi 回调执行(浏览器驱动由调用方提供)。
    if (resolved.kind === 'ui') {
      if (typeof runUi !== 'function') {
        entry.pass = false
        entry.error = 'ui step requires the browser runner (dsh-cdp-browser)'
        results.push(entry)
        continue
      }
      const uiOutcome = await runUi(resolved.script, resolved.elements)
      const uiPass = uiOutcome?.ok === true
      for (const [name, value] of Object.entries(uiOutcome?.exports ?? {})) {
        exports[name] = value
        state[name] = value
      }
      results.push({
        ...entry,
        kind: 'ui',
        scriptId: resolved.script?.id,
        scriptName: resolved.script?.name,
        pass: uiPass,
        durationMs: uiOutcome?.durationMs,
        error: uiPass ? undefined : (uiOutcome?.error ?? 'ui script failed'),
        uiSteps: uiOutcome?.steps,
      })
      continue
    }

    // API 请求步骤。
    const { request, baseUrl } = resolved
    // 步骤级数据覆盖(step.data):body/query/headers/url 覆盖请求配置,
    // 未提供的字段回退请求配置(接口测试的参考示例数据)。
    const stepData = (typeof step.data === 'object' && step.data !== null) ? step.data : {}
    const mergedRequest = {
      ...request,
      ...(stepData.url !== undefined ? { url: stepData.url } : {}),
      ...(stepData.body !== undefined ? { body: stepData.body } : {}),
      ...(stepData.query !== undefined ? { query: stepData.query } : {}),
      ...(stepData.headers !== undefined ? { headers: stepData.headers } : {}),
    }
    const url = /^https?:\/\//i.test(String(mergedRequest.url ?? ''))
      ? mergedRequest.url
      : `${String(baseUrl ?? '').replace(/\/+$/, '')}/${String(mergedRequest.url ?? '').replace(/^\/+/, '')}`
    const outcome = await executeRequest({ ...mergedRequest, url }, state, factories, jar)
    for (const [name, value] of Object.entries(outcome.extracted ?? {})) state[name] = value
    for (const [name, value] of Object.entries(outcome.exports ?? {})) exports[name] = value
    results.push({
      ...entry,
      kind: 'request',
      requestId: request.id,
      name: request.name ?? url,
      method: String(request.method ?? 'GET').toUpperCase(),
      url,
      pass: outcome.ok,
      status: outcome.status,
      durationMs: outcome.durationMs,
      assertions: outcome.assertions,
      error: outcome.error,
    })
  }
  const executed = results.filter((item) => !item.skipped)
  const total = executed.length
  const passed = executed.filter((item) => item.pass).length
  return {
    name: testCase.name,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    summary: { total, passed, failed: total - passed, skipped: results.length - total },
    results,
    exports,
  }
}
