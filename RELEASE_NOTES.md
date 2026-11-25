# dsh-test-mode v0.15.0

**固定报告看板:只存统计;最新报告覆盖写,历史报告按需保存。**

## 新增

- **最新报告 `reports/latest.json`**:执行资产/工作项/批量后自动刷新(智能体只覆盖这一份),
  只存覆盖率、通过率、按模块/按类型统计、失败资产名+错误摘要(最多 50 条、错误 200 字);
  不存请求/响应/步骤明细/截图;
- **历史报告 `reports/history/`**:用户「保存为历史报告」时生成不可变快照,
  允许带失败保存(记录当时状态);支持列表、查看、删除;
- **报告看板**:覆盖率/通过率/通过/失败/过期未测 KPI、按类型、按模块进度条、
  失败摘要、历史报告列表与覆盖率/通过率趋势图;
- **API**:
  - `GET /api/reports/latest`、`POST /api/reports/latest/refresh`;
  - `POST /api/reports/history {name}`、`GET /api/reports/history`、
    `GET/DELETE /api/reports/history/:id`;
  - 旧 `/api/reports` 列表自动排除 `latest` 与 `history/`;
- **版本语义保留**:`POST /api/versions` 仍是全绿发布快照(所有资产 solid 且无过期),
  与「随时可存的历史报告」并存;
- 预设、`test-mode-workflow` 技能、README 同步报告边界(禁止写入大体积明细)。

## 测试

- e2e **312**(最新报告统计/小文件/无请求响应、失败摘要、执行自动刷新、带失败保存历史、
  历史列表/读取/删除、旧报告列表排除);
- 渲染 **103**(报告看板 KPI/模块/失败/历史/趋势、刷新统计、保存确认);
- 插件 **8**、技能 **32** 全绿。

## 升级

重启 DeepSeek Harness(桌面版完全退出再打开)。旧的 `reports/report-*.json` 大报告不再被看板使用,
可在确认新看板后清理。
