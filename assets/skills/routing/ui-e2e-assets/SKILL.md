---
name: ui-e2e-assets
description: Route UI and e2e testing work in test-mode - write UI component/flow assets with stable element-library selectors, probe pages first, handle waits and flaky steps, compose e2e work items. Use when a work item is type e2e or needs UI assets.
---

# UI / e2e 资产测试路由

**何时加载**：新建/修改 UI 资产（`assets/ui/**`）；e2e 工作项；定位失败、等待不稳、断言不足时。

## 必读约束

- 两类 UI 资产：`component`（单页面、少量动作+断言，锁组件行为）、`flow`（多步跨页，跑业务流程）；
- 组件粒度软校验：component 应单页面、≤6 步、≥1 断言；超限会有 `warnings`，优先拆分或改为 flow（"生成粒度整改清单" 可列出全部待整改项）；
- 执行引擎是插件内置 Playwright + 系统 Chrome；**不要用会话浏览器工具**探测或执行；
- 写步骤前必须 `POST /api/ui/probe {url}` 获取真实可交互元素，禁止猜 selector；
- 元素优先入元素库（`ui/elements.json` 的 key），步骤用 `element: "<key>"`；
- 执行后只更新资产状态（不写报告）；失败返回失败步骤与截图路径。

## 推荐加载的内置技能（1~2 个）

| 场景 | 技能 |
|---|---|
| Playwright 设计/等待/断言/CI | `ui-test-playwright` |
| 选择器稳定性评审 | `ui-test-selector-review` |
| 异步等待/超时评审 | `ui-test-wait-strategy-review` |
| 用例步骤设计 | `test-case-writing` |
| 外部 web 测试方法（若已安装） | `webapp-testing`（Apache-2.0，取侦察/等待方法） |

## 执行顺序

1. 探测页面 → 记录 title、可交互元素（id/testid/name/role/css）；
2. 建元素库条目（稳定定位优先 `[data-testid]` > `id` > label > name/role）；
3. 写最小步骤：open → 动作 → 断言（assert_text/assert_url/assert_element）；
4. 执行验证（`run`）；失败先看截图与失败步骤，定位失败重探，不修改断言凑通过；
5. 多步业务流程用 `flow` 资产；跨接口校验：工作项里把 API 资产与 UI 资产按顺序组合；
6. 需要精确字段/示例时加载 `test-mode-workflow`。

## 输出要求

- 断言可观察且稳定（文本/URL/元素状态，避免依赖动画中间态）；
- 等待优先依赖断言自动等待，固定 sleep 仅在无法避免时使用并注明原因；
- 失败截图/错误信息写入工作项 `defects` 前的归因说明（真实缺陷才开票）。
