# dsh-test-mode v0.2.1

## 修复

- **会话模式选择器里看不到「测试模式」**:新版 DSH 的预设改为 **bundle 声明**——由插件包的
  `cordis.patch.yml` 插入一行 `@deepseek-ai/dsh-agent-preset`(携带 `id/name/description/order/plugins`),
  随插件包安装即出现在模式选择器;旧版「运行时写入 `~/.dsh/.agent-presets/<id>/` 文件」的方式
  在新版已不被采纳(且旧文件的 persona 配置仍是 `text`,新版 schema 为 `prefix`/`suffix`,装载失败)。
  - `cordis.patch.yml` 现声明预设行:名称「测试模式」、order 6、16 条会话行;
  - 会话行改用包自身 exports(`@calwang414/dsh-test-mode/preset` 与 `/skill`),不再需要绝对路径占位符;
  - persona 配置迁移到 `prefix` / `suffix`;
  - 移除运行时预设安装代码与 `presets/` 模板,安装包更干净(`files` 不再含 presets)。

## 兼容性

- 需要新版客户端与预设机制:`@deepseek-ai/dsh-client-*` ≥ 0.1.7-rc.2;
- 升级本插件后请重启 dsh;若本地存在旧版写入的 `~/.dsh/.agent-presets/dsh-test-mode/`,可以删除(本版不再使用)。

## 安装

```
dsh plugin --profile web add ./dsh-test-mode
# 或预编译包(本 Release 资产):
dsh plugin --profile web add https://github.com/calwang414/dsh-test-mode/releases/download/v0.2.1/dsh-test-mode-0.2.1.tgz
```
