# dsh-test-mode v0.9.0

**内置 10 个开源测试技能(随包发布,无需每次下载)。**

## 新增

- 从 [awesome-qa-skills](https://github.com/naodeng/awesome-qa-skills)(commit `ef02142`)内置 10 个中文技能:
  `test-case-writing`、`test-case-reviewer`、`equivalence-partitioning`、
  `boundary-value-testing`、`api-testing`、`api-negative-testing`、
  `ui-test-playwright`、`ui-test-selector-review`、`api-security-testing`、
  `performance-testing`;
- 随包注册在测试模式预设作用域 → 仅测试模式会话可见,其他模式不可见;
- 内置技能与外部目录技能统一由 `lib/skill.js` 发现;按名称去重时内置优先;
- 保留上游正文、prompts/references 等附属资源(`resourceBase` 指向技能目录),
  省略 `evals/` 以减小包体积;
- **许可证**:这 10 个技能为 PolyForm Noncommercial 1.0.0,不随本插件 MIT 许可;
  许可证全文与来源见 `assets/skills/qa/LICENSE-PolyForm-Noncommercial-1.0.0.txt`
  与 `assets/skills/qa/NOTICE.md`;
- 预设/README 增加「按工作项类型选择技能」的映射(功能/接口/e2e/性能/安全);
- 技能冒烟测试扩展到 **26 项**(内置 10 个可见、正文加载、resourceBase、许可证文件)。

## 测试

- e2e **251**、渲染 **72**、插件 **8**、技能 **26** 全绿。

## 升级

重启 DeepSeek Harness(桌面版完全退出再打开)。内置技能无需安装/下载,可直接
用 skill 工具按名称加载;更多开源技能仍可放到 `~/.dsh/test-mode-skills/`。
