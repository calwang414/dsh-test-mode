# dsh-test-mode v0.4.1

修复**打开报告页/查看报告时桌面版宿主进程崩溃**（OOM）。

## 根因

- 断言 `json` 的 `actual` 原样保存了完整响应体：一次计划/集合执行可能产生 **数百 MB** 的报告
  （实测单份 477MB，某工作区 556 份共 **17GB**）；
- `GET /api/reports` 逐个读取完整报告 JSON 再返回，`/compare`、`/stats`、增量基线、失败重跑
  同样读取全部报告 —— 打开报告页即把宿主堆（约 1.4GB 上限）打爆，并连带渲染端
  `client loadSnapshot timeout 30s`。

## 修复

- **写入截断**（`lib/reports.js`）：断言 `actual`、`error`、`detail`、`uiSteps`、`diagnostics`、
  `exports` 超长值只保留预览（≤2000 字符；对象/数组记 `{truncated,size,preview}`），新报告不再膨胀；
- **侧车索引** `reports/index/<id>.json`：列表 / 对比 / 统计 / 增量基线 / 失败重跑改为读紧凑索引，
  不再解析完整报告；旧报告无索引时列表只返回 stub（不解析正文）；
- **旧大报告按需裁剪**：单份详情 / 导出超过 8MB 时，在**子进程**（独立大堆）中裁剪并缓存
  `reports/trimmed/<id>.json`，宿主不再解析超大 JSON；返回 `trimmed: true` 供界面提示；
- **新增** `POST /api/reports/migrate-legacy`：批量裁剪旧大报告并补索引（报告页新增「整理旧报告」
  按钮，完成后显示回收空间）；
- 删除报告时同步清理侧车与裁剪缓存；
- 测试：e2e 新增 12 项体积治理回归（截断、列表摘要、旧报告 stub、按需裁剪、迁移），
  合计 **247** 项；渲染 149、插件 8 全绿。

## 兼容性

- 数据与 API 保持兼容（报告字段不变，仅超长值变预览；响应新增 `trimmed` 标记）；
- 已有大报告：打开报告页不再崩溃；点「整理旧报告」可把历史报告压缩到极小体积并回收磁盘；
- 升级后需重启 DeepSeek Harness（桌面版完全退出再打开）。
