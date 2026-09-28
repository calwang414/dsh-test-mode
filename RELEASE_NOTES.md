# dsh-test-mode v0.2.0

适配新版 DSH 客户端契约(客户端包 ≥ 0.1.7-rc.2,`dsh-client-runtime` 已移除)。

## 修复

- **新版 DSH 下插件不可用(视图标签全部消失)**:
  - 客户端清单 `dsh.client.inject` / `peerDependencies` 对齐当前契约,声明服务提供包
    `dsh-client-ui-renderer` / `dsh-client-ui-conversation` / `dsh-client-ui-session` /
    `dsh-client-ui-workspace`,不再声明已移除的 `dsh-client-runtime`;
  - **会话模式判定改用宿主会话投影 `agentPreset`**:该值在新版客户端不再是会话列表字段
    (改为 SessionProjectionMap 投影)。注册前经 `sessions.binding(id).session.projections.faceOf('agentPreset')`
    读取;投影暂时不可读时按注册处理,不再静默什么都不注册;
  - **标签可见性用「会话头部探针」还原**(与 dsh-ui-design 同一做法):`conversation.view`
    名册是全局投影,而标签条由按会话渲染的会话头部绘制——在
    `conversation.session.header.utilities` 挂一个渲染 `null` 的感知条目,它随标签条
    按会话挂载/卸载,在 effect 里读 `agentPreset` 投影后注册/注销本插件视图:
    测试模式会话显示 7 个标签,其他模式会话完全不显示;
  - 视图组件内用标准 prop `useProjection("agentPreset")` 兜底门控:非测试模式会话说
    明占位页,不会在错误模式的工作区创建 `test-mode/` 数据;
  - 客户端运行时依赖收敛为 `["slots"]`(不再硬依赖 `sessions` 服务);
  - 槽位注册经 `ctx.slots.inject('conversation.view', () => ctx.slots.register(...))`,
    随槽位声明折叠/恢复自动回收与重建。
- 渲染回归测试 +2(标准模式不注册 / 非测试模式占位页),e2e manifest 契约断言 +3。

## 兼容性

- 需要新版客户端:`@deepseek-ai/dsh-client-*` ≥ 0.1.7-rc.2(peer 范围已按此约束);
- Host 半(路由、预设安装、自动提交、文件校验钩子)未变,`test-mode/` 数据完全兼容。

## 安装

```
dsh plugin --profile web add ./dsh-test-mode
# 或预编译包(本 Release 资产):
dsh plugin --profile web add https://github.com/calwang414/dsh-test-mode/releases/download/v0.2.0/dsh-test-mode-0.2.0.tgz
```
