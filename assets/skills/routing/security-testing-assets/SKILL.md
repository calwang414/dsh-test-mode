---
name: security-testing-assets
description: Route security testing work in test-mode - enumerate auth/authz/input/error-leak cases, express them as API assets with explicit 4xx/error assertions, and link confirmed defects to work items. Use when a work item is type security.
---

# 安全测试路由

**何时加载**：安全测试工作项（`type: "security"`）；需要把安全场景转成可重复、可断言的接口资产时。

## 必读约束

- 只做**可验证的安全用例**：鉴权缺失/越权/输入边界/错误信息泄露/敏感数据暴露；不做未经授权的扫描或攻击；
- 每个安全用例必须有明确期望（4xx、错误码、不包含敏感字段、无堆栈信息）；
- 不回显/不落盘 token、cookie、密钥；请求里的凭据用环境变量/会话变量；
- 真实漏洞：只开缺陷票（附请求/响应证据），不在工作项里写利用链。

## 推荐加载的内置技能（1~2 个）

| 场景 | 技能 |
|---|---|
| API 安全测试设计 | `api-security-testing` |
| 通用安全测试/OWASP | `security-testing` |
| 认证/会话 | `authentication-testing` / `session-security-testing` |
| 授权/越权 | `authorization-testing` |
| 秘密泄露评审 | `secrets-exposure-review` |

## 覆盖清单（按接口挑）

1. **鉴权缺失**：不带 token / 过期 token / 伪造 token → 401/403；
2. **越权**：普通用户访问他人资源/管理接口 → 403 或 404；
3. **输入边界**：超长、特殊字符、类型错乱、越界数值 → 400 且不 500；
4. **错误泄露**：错误响应不包含堆栈、SQL、内部路径、其它用户数据；
5. **敏感数据**：响应不回显密码/token/secret；
6. **方法/参数**：未声明方法、重复参数、批量赋值（mass assignment）不越权。

## 脚手架（快速铺开）

- `POST /api/security/scaffold { assetIds, apply? }`：对选中接口资产生成安全专用资产
  （无凭证、不存在 ID、错误信息不泄露；`includeIdor: true` 追加越权模板）与一个安全回归工作项；
  默认 dry-run，确认后 `apply: true` 写入；可重复调用（已存在的会跳过）；
- 越权资产需配置 `OTHER_ID`；生成后逐个执行验证，失败先区分「真漏洞」与「断言/凭据过期」。

## 执行顺序

1. 准备多套身份（匿名/普通/管理员）的会话变量；
2. 每个场景一个资产（或同一工作项的数据覆盖），断言明确 4xx 且错误体不含敏感信息；
3. 执行验证；失败先区分「接口确实未防护」= 缺陷，还是「断言/凭据过期」= 测试自身问题；
4. 开票：标题含接口+场景、附请求/响应证据、关联工作项 `defects`。
