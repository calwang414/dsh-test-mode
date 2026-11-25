# 领域判定示例

此脱敏合成 fixture 用于校准本 Skill 的分析，不是项目真实执行或业务验收记录；数值和协议仅适用于本示例。

## 输入

契约 v2：REST refund 成功 200，20 元只退一次；GraphQL errors 非空表示该字段失败；清理必须删除退款再删除订单。A-1：refund 200，但 GET order 累计退款仍 0。A-2：同 refund_id 两次 200，GET 累计退款 20，只有一条账务。A-3：GraphQL HTTP 200，data.refund=null 且 errors 非空。A-4：仅提供未知 gRPC 接口名称，没有 proto 或调用结果。逐项 FAIL/PASS/UNKNOWN，并列业务后置条件与清理顺序。

## 逐项预期

| ID | DECISION |
| --- | --- |
| A-1 | FAIL |
| A-2 | PASS |
| A-3 | FAIL |
| A-4 | UNKNOWN |

## 核对方法

1. 按已确认协议选择分支：REST 校验 method/status/schema/幂等；GraphQL 校验 data 与 errors、null 和字段权限；gRPC 校验 status/metadata/deadline/流终止；WebSocket 校验握手、消息 ID/顺序/重连；SOAP 校验 WSDL、namespace 与 Fault。未使用协议不强行覆盖。
2. 将契约检查与跨请求业务后置条件分开：创建/更新→读回→权限视图→重复请求/下游效果；每步保留请求 ID、业务键、版本与证据。
3. 状态码正确但读回余额、状态或关联错误仍为业务失败；响应可能异步时按项目一致性窗口等待，不自定窗口。
4. 数据由隔离命名空间和唯一业务键准备，清理按依赖逆序执行并记录残留；未知授权或真实副作用限制保持 blocked。
