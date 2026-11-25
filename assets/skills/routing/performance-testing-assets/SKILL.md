---
name: performance-testing-assets
description: Route performance testing work in test-mode - define measurable performance objectives, model workloads, and express results as duration assertions on API assets, while keeping heavy load generation external. Use when a work item is type performance.
---

# 性能测试路由

**何时加载**：性能测试工作项（`type: "performance"`）；需要把性能目标转成可重复的资产断言时。

## 本插件的真实能力（先看边界）

- 执行器是串行/分批的 HTTP 与浏览器执行，**不是压测引擎**：能做单次/批量执行的**耗时断言**（`duration` 断言）、稳定性与容量相关的功能验证；
- 真正的并发/吞吐/RPS 压测需要外部工具（k6/JMeter/Gatling 等），本插件不内置、也不要在资产里写 k6 脚本；
- 性能结论必须写清楚测试条件（环境、数据量、并发假设），否则只能算冒烟。

## 推荐加载的内置技能（1~2 个）

| 场景 | 技能 |
|---|---|
| 负载/压力/容量目标设计 | `performance-testing` |
| 负载建模（数据量/流量假设） | `performance-workload-modeling` |
| 结果分析（阈值/回归） | `performance-result-analysis` / `performance-regression-analysis` |

## 执行顺序

1. 明确目标：P95 耗时上限、错误率、数据规模假设；
2. 建设接口资产：真实参数 + `duration` 断言（如 `{ "type": "duration", "operator": "lte", "expected": 800 }`）；
3. 需要前置数据/登录：用资产组合（登录 → 准备 → 测量），变量在资产间流转；
4. 重复执行（`run-batch` 指定 ids）观察稳定性；把结果写入工作项备注/缺陷（异常耗时开缺陷票并附条件）；
5. 需要真实压测：在外部执行，把结论/脚本路径作为证据写入工作项，不要把外部执行伪装成本插件结果。

## 输出要求

- 每条性能断言都有明确阈值与依据；
- 报告/汇报写明环境、数据量、采样次数；
- 识别到瓶颈：开缺陷票，附资产 id、耗时分布与复现条件。
