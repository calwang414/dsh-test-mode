# dsh-test-mode v0.3.1

UI 自动化改用**内置 Playwright + 系统 Chrome**执行,不再依赖会话里的浏览器工具
(`browser_*` / `bsk_*`),也不需要额外的浏览器插件。

## 变更

- **新增浏览器驱动层** `lib/browser-driver.js`:`playwright-core`(无浏览器下载、无安装脚本)
  直接驱动系统 Chrome;默认 `channel: 'chrome'`,headless 执行;`DSH_TEST_BROWSER_EXECUTABLE`
  指定可执行文件、`DSH_TEST_BROWSER_CHANNEL=msedge` 换浏览器、`DSH_TEST_BROWSER_HEADFUL=1` 有头调试;
- **UI 自动化执行引擎重写**:open/click/type/press/assert_*/eval/wait/screenshot 步骤语义不变,
  底层改为 Playwright 自动等待与原生输入(React/Vue 受控组件兼容),不再手写页面 JS;
- **失败自动取证**:断言/动作失败自动截图(`test-mode/ui/screenshots/`),并附带 console 错误、
  页面异常、失败请求诊断;报告的 `driver` 字段记录 Playwright/浏览器版本、channel、headless;
- **新增页面元素探测** `POST /api/ui/probe { url }`:服务端 Playwright 打开页面,返回候选交互元素
  (tag/文本/id/name/testid/role/css),AI 生成元素库与脚本不再需要浏览器工具;
- **移除旧驱动**:不再通过 `tools` 服务调用 `browser_*` 工具,UI 自动化在任何 profile 与
  会话模式下都能执行(与 `dsh-cdp-browser` / `browser-skill` 解耦);
- 预设工作流、AI 生成提示词、README 同步更新;新增依赖 `playwright-core@^1.65.1`;
- 测试:在桌面版真实 harness 上 e2e **235** / 渲染 **146** / 插件 **8** 全绿,其中 UI 用例为
  Playwright 真实浏览器执行(本地静态页:导航/输入/点击/断言/截图/导出变量/探测/失败取证)。

## 兼容性

- 需要本机安装 Google Chrome(或用 `DSH_TEST_BROWSER_EXECUTABLE` / `DSH_TEST_BROWSER_CHANNEL` 指定);
- 客户端契约不变(`@deepseek-ai/dsh-client-*` ≥ 0.1.7-rc.2);
- 升级后需重启 DeepSeek Harness(桌面版完全退出再打开)。
