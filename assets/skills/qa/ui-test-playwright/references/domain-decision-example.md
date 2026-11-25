# 领域判定示例

此脱敏合成 fixture 用于校准本 Skill 的分析，不是项目真实执行或业务验收记录；数值和协议仅适用于本示例。

## 输入

项目已锁Playwright1.48，checkout title恒定。P1付款后state=pending但仅断言标题绿灯。P2业务断言toHaveText('paid')在pending模式失败并产trace、CI非0。P3两个context都用同账户/订单，worker互改数据。P4 A/B独立主体和order_id，各读回自己的paid金额20且清理无残留。P5仅写出测试文件没有运行。用REPAIR/EXPECTED_FAILURE/ISOLATION_FAIL/VALID/NOT_RUN逐项，不把trace文件存在或title正常等于验收。

## 逐项预期

| ID | DECISION |
| --- | --- |
| P1 | REPAIR |
| P2 | EXPECTED_FAILURE |
| P3 | ISOLATION_FAIL |
| P4 | VALID |
| P5 | NOT_RUN |

## 核对方法

1. 固定项目Playwright/Node/browser版本、projects/fixtures与配置；沿用真实入口，记录测试ID、commit、worker/project和环境，未兼容配置先诊断不擅自换框架。
2. 优先role/name/testid等稳定语义定位，执行后以auto-retrying assertion核对订单/账务/状态与主体；页面标题/URL只满足相应导航义务，不能替代付款成功。
3. 每worker独立browser context、storage state/账号与业务键，禁止共享会冲突的数据；同浏览器不同context仍须核对服务端账号隔离，teardown逆依赖清理。
4. 用错误业务状态和并行A/B对照验证断言敏感性；失败保留trace/screenshot/日志与非0 runner/CI，retry首失败仍可见。生成资产、实际browser运行与业务验收分别报告。
