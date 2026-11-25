---
name: test-mode-workflow
description: Detailed reference for test-mode assets and test work items - JSON fields and samples for API/UI component/UI flow assets, work item fields, versions, assertions, environments, session variables, data factory, UI element library/probe, failure attribution, and validation errors. Load it when you need exact shapes, samples, or edge-case rules.
---

# 测试模式详细规范（按需加载）

主契约（常驻）只给规则；本技能给**字段、JSON 示例、接口表与排障细节**。冲突时以常驻契约为准。

## 1. 资产

### 1.1 接口资产 `assets/api/<id>.json`

```json
{
  "id": "api:login",
  "kind": "api",
  "module": "登录",
  "name": "登录获取令牌",
  "tags": ["冒烟"],
  "baseUrl": "http://127.0.0.1:8000",
  "request": {
    "method": "POST",
    "url": "/api/login",
    "headers": { "content-type": "application/json" },
    "query": {},
    "body": "{\"user\":\"{{USER}}\"}",
    "assertions": [
      { "type": "status", "operator": "eq", "expected": 200 },
      { "type": "json", "path": "$.token", "operator": "contains", "expected": "tok-" }
    ],
    "extract": [{ "name": "TOKEN", "path": "$.token", "export": true }]
  }
}
```

- `kind: "api"`；`id` 稳定（建议 `api:<模块>.<场景>`），被工作项引用后不可随意改名；
- `status`：`untested | solid | failed`；`stats`：`runs/passed/failed/totalDurationMs`；`lastRun`/`lastPassed` 由插件写入，不要手改；
- `baseUrl`：请求 `url` 为相对路径时拼接；绝对 URL 直接使用；
- 布尔/数组格式：`headers`/`query` 支持对象或 `[{key,value}]`，保存时统一为对象。

### 1.2 UI 资产 `assets/ui/<id>.json`

```json
{
  "id": "ui:login-form",
  "kind": "ui",
  "type": "component",
  "module": "登录",
  "name": "登录表单校验",
  "tags": ["冒烟"],
  "steps": [
    { "kind": "open", "url": "{{BASE_URL}}/login" },
    { "kind": "type", "element": "login-user", "text": "alice" },
    { "kind": "click", "element": "login-btn" },
    { "kind": "assert_text", "element": "login-result", "expect": "欢迎 alice" }
  ]
}
```

- `type: "component"`：单页面、少量动作 + 断言（锁组件行为）；`type: "flow"`：多步、跨页面业务流程；
- 步骤 `kind`：`open/click/type/press/assert_text/assert_url/assert_title/assert_element/eval/wait/screenshot`；
- 元素优先用元素库 key（`element: "<key>"`），元素库存 `ui/elements.json`：`{ key, selector, page, description }`；
- **粒度约定（软校验）**：`component` 单页面、≤ 6 步、≥ 1 条断言；跨页/步数过多/无断言时 API 返回 `warnings`
  （不拒绝保存，建议拆分或改为 `flow`）；`flow` 应跨页面或步骤较多。整改清单：
  `POST /api/assets/granularity-report` → `test-mode/granularity-report.md`；
- 执行引擎：插件内置 Playwright + 系统 Chrome（headless），**不要用会话浏览器工具**。

## 2. 测试工作项 `cases/<id>.json`

```json
{
  "name": "登录后获取用户信息",
  "type": "functional",
  "priority": "high",
  "requirement": "REQ-登录-001",
  "automation": "auto",
  "result": "not_run",
  "defects": ["#473"],
  "module": "登录",
  "tags": ["登录", "冒烟"],
  "status": "active",
  "assets": [{ "assetId": "api:login" }, { "assetId": "api:me" }]
}
```

- `type`：`functional | e2e | performance | security`（对应视图四个 tab）；
- `priority`：`high | medium | low`；`automation`：`manual | auto | partial`；
- `result`：`not_run | passed | failed | blocked | skipped`（执行后自动回写 passed/failed）；
- `defects`：票号/链接字符串数组，如 `["#473", "https://github.com/…/issues/474"]`；
- `assets[].data`：`{ url?, body?, query?, headers? }`，覆盖接口资产的请求数据；字段可省，未提供回退资产配置；
- 变量流转：资产 `extract` 的变量（无需 `export: true`）在同一工作项内传给后续资产；`export: true` 才写入 `session.json` 跨工作项复用；
- 用例文件 id = 文件名（保存时自动补齐）；`assets` 引用必须真实存在。

## 3. 执行接口

| 接口 | 作用 |
|---|---|
| `GET /api/assets` | 资产列表 + 状态汇总（支持 `kind/module/tag/status`） |
| `GET /api/assets/pending` | 待测资产（untested/failed/stale）+ 计数 |
| `POST /api/assets/run` | 单资产执行，更新状态/统计，不写报告 |
| `POST /api/assets/run-batch` | 批量执行（`assetIds` 或 `filter`，`batchSize`） |
| `POST /api/cases/:id/run` | 按 `assets` 顺序执行工作项，回写 `result` |
| `POST /api/ui/probe` | 打开页面返回可交互元素（生成/修复 UI 资产前必用） |
| `GET/POST /api/versions` | 版本列表 / 保存版本（409 + failing 表示有未通过/过期资产） |
| `POST /api/import/openapi` | 导入 OpenAPI 3.x JSON，生成/更新接口资产来源 |
| `GET /api/dbdata` | 查看参考表与样例 |

## 3.5 安全专用资产

- 仍是 api/ui 资产,用 `security: { category: 'auth'|'not-found'|'leak'|'idor', sourceAssetId }` 标记;
  `module` 或 `tags` 含「安全/security」也会被识别;
- 断言期望 4xx(401/403/404)、错误体不泄露(stack/SQL/goroutine/panic);期望 2xx 会收到软提示;
- 脚手架:`POST /api/security/scaffold { assetIds, includeIdor?, apply? }`(默认 dry-run),
  生成无凭证、不存在 ID、错误信息泄露(可选越权)资产 + 一个安全回归工作项;
- 越权资产需配置 `OTHER_ID`;只用于授权的测试环境,不执行扫描/攻击。

## 3.6 标签

- 标签库：`test-mode/tags.json` 按分类管理 `{ categories: [{ id, name, tags }] }`（默认 测试类型/功能模块/未分类；旧 `{ tags: [] }` 自动迁移为分类）；基础配置 → 标签可增删分类/标签；工作项 tags 必须来自库，资产 tags 库外只给软提示；
- 分类 API：`POST /api/tags/categories {name}`、`DELETE /api/tags/categories/:id?moveTo=<id>`；标签移动：`PUT /api/tags/:name {name?, category?}`；
- 查询/执行过滤：`GET /api/assets?tags=a,b`、`GET /api/cases?tag=a`、`POST /api/assets/run-batch { tags }`；
- 界面：资产库与工作项都有标签快捷筛选 chips；资产详情会提示库外标签。

## 4. 断言与变量

- 断言类型：`status`（状态码）、`header`（响应头）、`body`（响应文本）、`json`（`$.a.b[0].c`）、`duration`（耗时上限）；
- 操作符：`eq/ne/gt/gte/lt/lte/contains/not_contains/matches/exists`（按类型支持）；
- `extract`：`{ name, path, from?: 'json'|'header', export?: boolean }`；
- 会话变量：`session.json` 按环境缓存 export 的变量，执行前合并（优先于环境变量）；
- 数据工厂：内置 `{{rand.phone|email|name|idcard|uuid|timestamp|date|number:min:max|string:length}}`；自定义 `{{factory.<key>}}`（基础配置 → 数据工厂）。

## 5. 环境与标签

- 环境：`api/environments/<id>.json`，`{ name, variables }`；默认环境存 `settings.json`；
- 标签库：`tags.json`，工作项 `tags` 只能是库内标签，否则保存 400；
- dbdata：`schema.md` + `<表>.csv|md|xlsx`，生成 mock / 断言数据前先读；不要臆造表中不存在的记录。

## 6. UI 资产编写要点

1. 先 `POST /api/ui/probe {url}` 探测元素，再写步骤；不要凭空猜 selector；
2. 定位优先级：`[data-testid]` > `id` > label 关联 > name/role；避免纯文本/位置依赖；
3. 等待：优先依赖后续断言（自动等待），必要时 `wait` 指定选择器/时长，避免固定 sleep；
4. 失败：插件返回失败步骤与截图路径；定位失败先重探再修，不修改断言凑通过；
5. 截图步骤 `screenshot` 会把文件写到 `test-mode/ui/screenshots/`。

## 7. 失败归因与版本

1. 资产失败时先看 `lastRun.error` 与断言 actual；
2. 若所在模块在 `changelogs/` 中：先确认期望是否过期（更新断言），不要当缺陷；
3. UI 定位失败：`/api/ui/probe` 重探 → 更新元素库/步骤；
4. 以上都不是 → 真缺陷：开缺陷票，把票号写入相关工作项 `defects`；
5. 修复后只重跑失败/过期资产（`run-batch` 指定 ids），全部 solid 后再 `POST /api/versions`。

## 7.5 报告（只存统计）

- 执行资产/工作项/批量后自动覆盖写 `reports/latest.json`（`GET /api/reports/latest`；
  也可 `POST /api/reports/latest/refresh` 手动刷新）；永远只有一份最新统计；
- 需要留档时 `POST /api/reports/history {name}` 保存当前快照（允许带失败，记录当时状态）；
  `GET /api/reports/history` 列表，`GET/DELETE /api/reports/history/:id`；
- 报告只存：覆盖率、通过率、按模块/按类型统计、失败资产名 + 错误摘要（最多 50 条、200 字），
  以及测试工作项明细（名称/类型/结果/需求/标签/资产名/断言数）；
  **不要写请求体/响应体/步骤明细/截图**；
- 版本与历史报告是两种语义：`POST /api/versions` 仍是全绿发布快照（所有资产 solid 且无过期），
  历史报告可随时保存。

## 8. 保存与校验

- 用 write/edit 写 `test-mode/` 文件，插件自动校验并反馈具体位置；
- API 保存时字段缺失、枚举非法、引用不存在 → 400，按报文位置修正；
- 工作项/资产 id 以文件名为准，不要自造引用。

## 9. 迁移兼容

- 旧用例迁移会把 `steps[].data` 保留到对应 `assets[].data`（同一资产重复步骤按顺序各保留一条）；
- 对已经迁移掉 data 的存量用例，执行时只读回退：若 legacy `steps` 中该请求引用的 data 唯一则使用，
  多条不同 data（歧义）不回退；不修改文件。

## 10. 禁用行为

- 不创建 `plans/`；不写旧 `reports/`；不恢复 `legacy-*/`；
- 不把 pytest/k6/Postman/其他执行栈引入本插件；外部技能只提供方法；
- 不把密钥/token 明文写进资产或工作项文件（用环境变量/会话变量）。
