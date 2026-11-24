# dsh-test-mode v0.6.3

**修复两个使用中发现的插件 bug（GoVue 工作区 bug 票 #473 / #474）。**

## 修复

- **#473 用例 assets 模型不传递 extract 变量**
  - `runApiAsset` 现在返回 `extracted`（未标记 `export:true` 的提取变量）；
  - 用例按 `assets` 顺序执行时，把每个资产的 extract 变量合并进后续资产的变量表；
  - 只有 `export:true` 的变量照旧写入会话缓存（`session.json`），行为不变；
  - 单资产执行响应也带 `extracted`，便于即时查看。
- **#474 刚通过的资产被误判为过期（stale），阻塞版本保存**
  - 根因：`writeAsset` 每次落盘都把 `updatedAt` 更新为当前时间，可能比执行时写入的
    `lastPassed.at` 晚 1ms，导致 `updatedAt > lastPassed.at` 命中过期；
  - 修复：`writeAsset` 新增 `touch` 选项；执行结果（状态/统计/lastPassed）落盘时
    `touch:false`，保留配置的 `updatedAt`；只有编辑资产配置才更新时间戳；
  - 过期语义恢复为「配置在上次通过后被修改」，刚通过不会过期，版本保存不再被误挡。

## 测试

- e2e **244** 全绿（新增：extract 变量在用例资产间传递、刚通过资产非过期）；
- 渲染 **47**、插件 **8** 全绿。

## 升级

重启 DeepSeek Harness（桌面版完全退出再打开）后生效；已存在的 stale 资产重跑一次即可恢复。
