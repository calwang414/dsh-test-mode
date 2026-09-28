# dsh-test-mode v0.1.2

## 修复

- **新版 DSH 下插件不可用(视图标签全部消失)**:客户端清单 `dsh.client.inject` / `peerDependencies` 仍在声明 `@deepseek-ai/dsh-client-runtime`,而该包在新版客户端已被移除(运行时成为基线,不得再声明)——客户端行无法组装,7 个视图标签不再注册。现已改为只声明 `@deepseek-ai/dsh-client-ui-conversation`(与应用内当前模板一致);
- 槽位注册改为当前契约的 `ctx.slots.inject('conversation.view', () => ctx.slots.register(...))`,注册随槽位声明折叠/恢复自动回收与重建;
- 会话清单访问容错:`ctx.sessions.list` 缺失时退化为常驻注册(视图仍可用),不再让整个客户端半加载失败;
- 新增 manifest 契约回归测试(禁止再次声明已移除的基线包)。

## 兼容性

- 需要新版客户端(客户端包 ≥ 0.1.2-rc.1 / 已移除 `dsh-client-runtime` 的版本);
- Host 半(路由、预设安装、自动提交、校验钩子)接口未变,数据目录 `test-mode/` 与既有数据完全兼容。

## 安装

```
dsh plugin --profile web add ./dsh-test-mode
# 或预编译包(本 Release 资产):
dsh plugin --profile web add https://github.com/calwang414/dsh-test-mode/releases/download/v0.1.2/dsh-test-mode-0.1.2.tgz
```
