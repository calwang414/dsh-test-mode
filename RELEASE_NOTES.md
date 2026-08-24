# dsh-test-mode v0.1.0

桌面本地测试平台:在 DeepSeek Harness 对话中提供「测试模式」,覆盖 API 测试、场景用例、UI 自动化、测试计划(全量/增量回归)与执行报告。

## 变更

- **API 测试**:OpenAPI 导入(同名项目更新式导入,自动 diff added/modified/removed 并写变更清单)、单请求/集合执行、mock 测试数据(对齐 dbdata 参考数据)、请求级 updatedAt 变更打标(增量精确到单个接口);
- **场景用例**:业务场景驱动、接口融入步骤(requestRef/step.data 覆盖)、标签库校验;
- **UI 自动化**:脚本 + 元素库(browser_* 驱动),元素变更自动反查受影响脚本进入增量;
- **测试计划**:多选弹窗(搜索/标签/全选)、模板、复制、重跑上次失败、AI 排计划;全量一键(全选全部项目),增量按「变更清单 → 请求级 updatedAt → mtime → 依赖反查」四层信号展开,支持变更模块(标签)声明与 dbdata 表依赖(dependsOn);
- **变更清单 changelogs**:重导 OpenAPI 自动 diff、AI 按发布说明维护,增量预览带来源拆分与缺口提示;
- **报告**:与上次对比/筛选/接口健康度/回归趋势/失败 Top,失败项「本版本已变更」归因徽章;
- **自动提交**:test-mode 文件写盘校验通过后自动 git 提交(仅本次文件,仓库缺失/无变更静默跳过);
- **一键智能生成**:全部 mock/缺口 mock/场景用例/智能绑定接口/排计划/整理标签。

## 安装

```
dsh plugin --profile web add ./dsh-test-mode
# 或预编译包(本 Release 资产):
dsh plugin --profile web add https://github.com/calwang414/dsh-test-mode/releases/download/v0.1.0/dsh-test-mode-0.1.0.tgz
```

安装后重启 dsh,会话模式选择器出现「测试模式」,对话视图新增 基础配置 / 数据工厂 / API 测试 / UI 自动化 / 用例 / 计划 / 报告 7 个标签。
