# dsh-test-mode v0.8.0

**测试模式专属技能:可引用开源技能,且只在测试模式会话可见。**

## 新增

- **技能发现(测试模式专属)**:`lib/skill.js` 在预设作用域注册技能,扫描:
  - `DSH_TEST_MODE_SKILLS` 环境变量(路径分隔符分隔的目录);
  - `~/.dsh/test-mode-skills`(用户级);
  - `<workspace>/.dsh/test-mode-skills`(工作区级);
  - 支持 `<name>/SKILL.md` 目录包与 `<name>.md` 平铺文件,YAML frontmatter 解析
    name/description/user-invocable/disable-model-invocation;
  - 技能注册在测试模式预设作用域 → **其他模式会话不可见**;
- 外部技能正文按需加载,修改后重新读取;`resourceBase` 指向技能目录,可引用附属文件;
- bundled 技能 `plugin-testing` 同步修正为加载时去掉 frontmatter;
- 预设/README 增加技能说明:开源技能只取方法,执行仍用本插件资产/工作项模型;
- 新增 `smoke/skill.mjs` 技能冒烟测试(12 项)。

## 测试

- e2e **251**、渲染 **72**、插件 **8**、技能 **12** 全绿。

## 升级

重启 DeepSeek Harness(桌面版完全退出再打开)。之后把开源技能目录放进
`~/.dsh/test-mode-skills/` 即可在测试模式会话中加载。
