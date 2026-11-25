# dsh-test-mode v0.10.0

**提示词优化两阶段完成:修复旧冲突、统一术语,并把常驻提示词从 ~8.3k tokens 降到 ~2.6k。**

## 阶段 1:修冲突与术语统一

- 删除常驻提示词里的旧链路:`run-collection` 写 `reports/`、`/api/ui/run`、`/api/plans`、
  「智能绑定接口」等,统一为资产/工作项/版本 API;
- 术语统一为「测试工作项」(全文不再出现旧「用例」措辞);
- 产物规范替换为**资产 JSON + 工作项 JSON** 示例,删除旧 `api/projects` / `ui/scripts` 示例;
- Persona 更新为「测试资产 + 测试工作项(四类)+ 分批系统测试 + 版本报告」;
- `plugin-testing` 技能同步当前执行模型(资产执行/工作项/版本,不再写单次报告)。

## 阶段 2:常驻/按需分层

- 常驻提示词:13.3k 字 → **4.2k 字**(约 8.3k → 2.6k tokens,−68%),只保留身份、目录、
  资产状态机、工作项字段、分批补测、版本规则、变更清单、技能路由与约束;
- 新增按需技能 `test-mode-workflow`:资产/工作项字段与示例、执行接口表、断言/变量/
  环境/数据工厂、UI 探测与等待、失败归因、保存校验;
- 新增 4 个路由技能:`api-testing-assets`、`ui-e2e-assets`、`performance-testing-assets`、
  `security-testing-assets`,按工作项类型组合内置 QA 技能;
- 删除客户端死代码 prompt:`buildPlanPrompt`、`buildBindRefsPrompt`、`buildSceneCasePrompt`、
  `buildGapMockPrompt`、`buildUiPrompt`、`buildElementsPrompt`、`buildCaseImprovePrompt`、
  `buildTagPromptOne` 及已移除的计划编辑器组件(约 26k 字符);
- 「本接口 mock」提示词改为面向接口资产(`assets/api`),与工作项 `assets[].data` 对齐;
- 新增常驻提示词回归测试:禁止旧链路/旧术语、限制字数、必须引用按需技能。

## 测试

- e2e **258**(含 7 项提示词回归)、渲染 **72**、插件 **8**、技能 **32** 全绿。

## 升级

重启 DeepSeek Harness(桌面版完全退出再打开)。内置技能数量:1 个 plugin-testing +
10 个 QA 技能 + 1 个工作流技能 + 4 个路由技能。
