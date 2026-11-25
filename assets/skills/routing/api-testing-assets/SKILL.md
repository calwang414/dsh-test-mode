---
name: api-testing-assets
description: Route API testing work in test-mode - how to turn HTTP endpoints into API assets, write assertions for positive/negative/boundary cases, compose functional work items, and which built-in QA skills to load. Use when a work item is type functional/e2e with API assets.
---

# 接口资产测试路由

**何时加载**：接口资产（`assets/api/**`）的新建/修改/补测；功能测试里以接口为主的工作项；需要设计正/负向、边界、schema 断言时。

## 必读约束（与常驻契约一致）

- 资产是唯一沉淀载体：接口 → `assets/api/<id>.json`；不要新建 `api/projects/*` 或旧脚本；
- 执行只更新资产状态/统计（`POST /api/assets/run`、`run-batch`），不写报告；通过即 `solid`，失败 `failed`，配置改动后 `stale`；
- 工作项（`cases/*.json`）只引用 `assetId`，通过 `assets[].data` 覆盖请求数据；变量在资产间流转（extract 即可传递）；
- 保存/执行前先读现有资产，`assetId`、模块、标签必须真实存在；断言必须能失败（禁止 `status < 500` 这类空断言凑通过）。

## 推荐加载的内置技能（1~2 个）

| 场景 | 技能 |
|---|---|
| 接口用例设计（REST/GraphQL） | `api-testing` |
| 负向/错误码/拒绝场景 | `api-negative-testing` |
| 输入等价类 | `equivalence-partitioning` |
| 边界值（长度/数值/时间） | `boundary-value-testing` |
| 工作项质量评审 | `test-case-reviewer` |

（若用户安装了其他接口技能，也可按目录名加载；只取方法，不引入 pytest/Postman/rest-assured 等执行栈。）

## 执行顺序

1. 确认目标：接口 URL/method/baseUrl、所需环境变量（登录态等）；
2. 先跑一条最小资产（status 断言）验证连通，再补断言（json 字段、错误码、schema 关键字段）；
3. 正/负/边界各建独立资产或同一工作项的数据覆盖（`assets[].data`），负向必须能稳定拿到 4xx；
4. 需要登录态：先执行登录资产拿 token（extract 到 `TOKEN`），后续资产用 `{{TOKEN}}`；
5. 执行验证（`run` 或 `run-batch`），失败先归因；全部通过后把工作项 `result` 置 passed；
6. 需要精确字段/示例时加载 `test-mode-workflow`。

## 输出要求

- 资产命名：`<模块>-<场景>`（如「订单-创建-缺参数」）；
- 每个负向资产至少一个明确的错误断言（status/错误码/错误信息）；
- 失败证据：`lastRun.error` + 断言 actual/expected；
- 真实缺陷：开票并把票号写入工作项 `defects`。
