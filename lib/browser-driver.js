/**
 * dsh-test-mode 浏览器驱动:Playwright(playwright-core)+ 系统 Chrome。
 *
 * 由 UI 自动化执行引擎在 Host 半直接驱动,不依赖会话里的 agent 浏览器工具
 * (`browser_*` / `bsk_*`),因此 UI 用例在任何 profile、任何会话模式下都能执行。
 *
 * 浏览器解析顺序:
 * 1. `DSH_TEST_BROWSER_EXECUTABLE` — 显式可执行文件路径(优先级最高);
 * 2. `DSH_TEST_BROWSER_CHANNEL` — Playwright channel(默认 `chrome`,即系统安装的
 *    Google Chrome;可设为 `msedge` 等);
 * 3. 启动失败时抛出可操作的错误(提示安装 Chrome 或设置上面两个环境变量)。
 *
 * 无浏览器下载:`playwright-core` 不自带浏览器、无安装脚本;默认复用系统 Chrome。
 * 需要无头/有头切换用 `DSH_TEST_BROWSER_HEADFUL=1`(默认无头)。
 * @module @calwang414/dsh-test-mode/browser-driver
 */

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 默认 Playwright channel(系统 Chrome)。 */
const DEFAULT_CHANNEL = 'chrome'
/** 默认视口。 */
const DEFAULT_VIEWPORT = { width: 1280, height: 720 }
/** 动作/导航默认超时(毫秒)。 */
const DEFAULT_ACTION_TIMEOUT_MS = 15_000
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000
/** 诊断信息保留上限(条)。 */
const DIAGNOSTIC_LIMIT = 20

let playwrightModule

/**
 * 懒加载 playwright-core;未安装时给出可操作的错误。
 * @returns playwright-core 模块命名空间。
 */
async function loadPlaywright() {
  if (playwrightModule === undefined) {
    try {
      playwrightModule = await import('playwright-core')
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`playwright-core 未安装,UI 自动化无法执行:${detail}。请重新安装插件(dsh plugin add)以拉取依赖`)
    }
  }
  return playwrightModule
}

/**
 * 解析启动参数:可执行文件路径优先于 channel;无头由 DSH_TEST_BROWSER_HEADFUL 控制。
 * @param overrides - 显式覆盖(来自运行请求)。
 * @returns Playwright launch 参数。
 */
export function resolveLaunchOptions(overrides = {}) {
  const executablePath = overrides.executablePath ?? process.env.DSH_TEST_BROWSER_EXECUTABLE ?? undefined
  const channel = overrides.channel ?? process.env.DSH_TEST_BROWSER_CHANNEL ?? DEFAULT_CHANNEL
  const headless = overrides.headless ?? process.env.DSH_TEST_BROWSER_HEADFUL !== '1'
  return executablePath === undefined ? { channel, headless } : { executablePath, headless }
}

/**
 * 探测 Playwright 是否可用(不启动浏览器)。
 * @returns { available: boolean, version?: string, error?: string }。
 */
export async function playwrightAvailable() {
  try {
    const playwright = await loadPlaywright()
    return { available: true, version: playwright.version ?? undefined }
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 启动浏览器驱动实例。
 * @param overrides - { headless?, channel?, executablePath? }。
 * @returns { browser, info, newSession, close }。
 */
export async function launchDriver(overrides = {}) {
  const { chromium } = await loadPlaywright()
  const options = resolveLaunchOptions(overrides)
  let browser
  try {
    browser = await chromium.launch({ ...options, timeout: DEFAULT_NAVIGATION_TIMEOUT_MS })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const target = options.executablePath ?? `channel=${options.channel}`
    const guide = options.executablePath === undefined
      ? `请确认已安装 Google Chrome(或设置 DSH_TEST_BROWSER_EXECUTABLE 指向浏览器可执行文件、DSH_TEST_BROWSER_CHANNEL=msedge)`
      : `请确认 DSH_TEST_BROWSER_EXECUTABLE 指向可执行的 Chrome/Chromium`
    throw new Error(`无法启动浏览器(${target}):${detail}。${guide}`)
  }
  return {
    browser,
    /** 驱动信息(报告里记录,便于复现)。 */
    info: () => ({
      engine: 'playwright',
      version: browser.version(),
      channel: options.channel ?? null,
      executablePath: options.executablePath ?? null,
      headless: options.headless === true,
    }),
    /**
     * 新建一个隔离会话(独立 browserContext + 页面)。
     * @param sessionOptions - { storageState?, viewport? }。
     */
    async newSession(sessionOptions = {}) {
      const context = await browser.newContext({
        viewport: sessionOptions.viewport ?? DEFAULT_VIEWPORT,
        storageState: sessionOptions.storageState ?? undefined,
      })
      const page = await context.newPage()
      page.setDefaultTimeout(DEFAULT_ACTION_TIMEOUT_MS)
      page.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT_MS)
      const diagnostics = { consoleErrors: [], pageErrors: [], failedRequests: [] }
      const push = (bucket, value) => {
        if (bucket.length >= DIAGNOSTIC_LIMIT) return
        bucket.push(String(value).slice(0, 500))
      }
      page.on('console', (message) => {
        if (message.type() === 'error') push(diagnostics.consoleErrors, message.text())
      })
      page.on('pageerror', (error) => push(diagnostics.pageErrors, error instanceof Error ? error.message : String(error)))
      page.on('requestfailed', (request) => {
        push(diagnostics.failedRequests, `${request.method()} ${request.url().slice(0, 300)} ${request.failure()?.errorText ?? ''}`.trim())
      })
      return {
        page,
        context,
        diagnostics,
        close: async () => {
          await context.close().catch(() => {})
        },
      }
    },
    close: async () => {
      await browser.close().catch(() => {})
    },
  }
}

/**
 * 把截图路径落到磁盘(相对路径按 root 解析),返回写入的绝对路径。
 * @param root - test-mode 数据根目录(可为 undefined,则按当前工作目录)。
 * @param target - 目标路径。
 * @returns 写入的绝对路径。
 */
export async function writeScreenshot(page, root, target) {
  const { isAbsolute, join } = await import('node:path')
  const file = isAbsolute(target) ? target : join(root ?? process.cwd(), target)
  await mkdir(dirname(file), { recursive: true })
  await page.screenshot({ path: file })
  return file
}

/**
 * 探测页面可交互元素:打开 URL → 返回候选元素(供 AI 生成元素库/脚本使用)。
 * @param options - { url, headless?, timeoutMs?, maxElements? }。
 * @returns { url, title, elements }。
 */
export async function probeUiPage(options) {
  const { url, headless, timeoutMs = 20_000, maxElements = 200 } = options
  const driver = await launchDriver({ headless })
  const session = await driver.newSession()
  try {
    const { page } = session
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
    // SPA 首屏通常在 DOMContentLoaded 之后渲染,留一个短暂的稳定窗口。
    await page.waitForTimeout(300)
    const elements = await page.evaluate((limit) => {
      const selectorOf = (element) => {
        const testId = element.getAttribute('data-testid')
        if (testId) return `[data-testid="${testId}"]`
        if (element.id) return `#${CSS.escape(element.id)}`
        const name = element.getAttribute('name')
        if (name) return `${element.tagName.toLowerCase()}[name="${name}"]`
        const parts = []
        let node = element
        let depth = 0
        while (node !== null && node !== document.body && depth < 4) {
          const parent = node.parentElement
          if (parent === null) break
          const index = Array.prototype.indexOf.call(parent.children, node) + 1
          parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${index})`)
          node = parent
          depth += 1
        }
        return parts.length === 0 ? element.tagName.toLowerCase() : `body > ${parts.join(' > ')}`
      }
      const visible = (element) => {
        const style = window.getComputedStyle(element)
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
        const rect = element.getBoundingClientRect()
        return rect.width > 0 && rect.height > 0
      }
      const nodes = [...document.querySelectorAll(
        'a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [data-testid], [contenteditable="true"]',
      )]
      const seen = new Set()
      const out = []
      for (const element of nodes) {
        if (out.length >= limit) break
        if (!visible(element)) continue
        const css = selectorOf(element)
        if (seen.has(css)) continue
        seen.add(css)
        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
        out.push({
          tag: element.tagName.toLowerCase(),
          text,
          id: element.id || undefined,
          name: element.getAttribute('name') || undefined,
          testId: element.getAttribute('data-testid') || undefined,
          role: element.getAttribute('role') || undefined,
          type: element.getAttribute('type') || undefined,
          placeholder: element.getAttribute('placeholder') || undefined,
          ariaLabel: element.getAttribute('aria-label') || undefined,
          css,
        })
      }
      return out
    }, maxElements)
    return { url: page.url(), title: await page.title(), elements }
  } finally {
    await session.close()
    await driver.close()
  }
}
