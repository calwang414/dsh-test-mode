# dsh-test-mode v0.10.1

**修复旧模型迁移覆盖新模型用例 `assets[]` 的数据丢失问题。**

## 修复

- **合并而非覆盖**:迁移只从 legacy `steps[].requestRef/uiRef` 推导引用;
  用例已有 `assets[]` 时原样保留(含 `data`/`skip`),仅追加尚不存在的引用,
  不再把新模型用例清空为 `[]`;
- **默认 dry-run**:`POST /api/migrate/assets` 默认只计算不写盘并返回 hint;
  必须显式 `{"apply": true}` 才写入;
- **写盘前自动备份**:`cases/` 复制到 `backup-assets-migration-<时间戳>/`,
  路径记录在 manifest `backup` 字段;
- **一致性守卫**:写盘前校验所有用例的资产引用总数不减少,写盘后从磁盘复核,
  不一致直接抛错(备份可回滚);manifest 增加 `caseRefsBefore`/`caseRefsAfter`、
  `casesPreserved`、`wouldWrite`;
- 不再对保留的用例写入 `migratedAt`(避免误标"已迁移")。

## 测试

- e2e **269**:新增 dry-run 默认/无写入、apply 后备份存在、引用数与磁盘一致、
  新建新模型用例二次迁移 assets+data 保留、旧 steps 用例正常推导;
- 渲染 **72**、插件 **8**、技能 **32** 全绿。

## 升级

重启 DeepSeek Harness(桌面版完全退出再打开)。历史已被清空的用例不会被自动
恢复;需要时从 `backup-assets-migration-*` 或会话记录手工找回后重新执行。
