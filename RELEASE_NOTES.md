# dsh-test-mode v0.2.4

修复**本轮运行失败:unknown prompt variable "{{cwd}}" in section "dsh-test-mode.workflow"**。

## 修复

新版 harness 的 system-prompt 段只注册 `provider` / `model` 两个插值变量(`cwd` 不再是段级变量,
内置 standard 预设的 persona 也只用 `{{model}}`)。本插件的预设文本仍引用 `{{cwd}}`,导致每次
运行在提示词装配阶段失败。改动:

- `lib/preset.js` 的「测试工作流」段文本:去掉 4 处 `{{cwd}}`,改为「工作区根目录下的 `test-mode/`」表述;
- `cordis.patch.yml` 的 persona `suffix`:去掉 `{{cwd}}`(改为 "the session workspace root"),保留已注册的 `{{model}}`;
- 新增回归测试:e2e 校验 workflow 段文本与补丁内 prompt 占位符只允许已注册变量(+4 项)。

## 验证

- 用桌面版 App `app.asar` 解出的真实 harness(**0.2.1-rc.5**)跑三套:e2e **223** / 渲染 **146** / 插件 **8** 全绿;
- 用真实 `SystemPrompt.assemble()` 装配本插件段:段已注册、无占位符、装配无异常。

## 兼容性

- 需要 `@deepseek-ai/dsh-client-*` ≥ 0.1.7-rc.2(桌面版 0.2.1-rc.x 已验证);
- 升级后需重启 DeepSeek Harness(桌面版完全退出再打开)。
