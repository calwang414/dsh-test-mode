# dsh-test-mode v0.7.0

**测试用例升级为「测试工作项」:按功能测试 / e2e测试 / 性能测试 / 安全测试四个标签页组织,补齐工作项字段。**

## 变更

- **视图改名**:顶层「用例」→「测试工作项」,内部四个标签页:
  功能测试(functional)、e2e测试(e2e)、性能测试(performance)、安全测试(security);
- **工作项字段**:
  - 标题(name)、优先级(high/medium/low)、关联需求(requirement:编号/链接/描述);
  - 自动化状态(automation: manual/auto/partial)、结果(result: not_run/passed/failed/blocked/skipped);
  - 关联缺陷(defects:票号或链接数组,如 #473);
  - 保留资产组合(assets)、模块、标签、状态;
- **执行回写**:执行工作项后自动把 `result` 更新为 passed/failed 并记录 `resultAt`;
  手工工作项可直接编辑结果;
- **校验**:type/automation/result 非法枚举、defects 非字符串、requirement 非字符串均返回 400;
- **迁移**:旧用例自动补齐工作项字段,并按是否含 UI 资产/UI 步骤推断 e2e 类型;
  已对 GoVue(88→96 个工作项)与 dsh-test(28 个)执行补写;
- 界面:标签页切换与计数、工作项卡片展示优先级/自动化/结果/需求/缺陷、编辑器补齐字段。

## 测试

- e2e **251** 全绿(新增工作项字段校验、非法枚举、结果回写、默认值);渲染 **58** 全绿
  (四标签页、字段展示、编辑器字段);插件 **8** 全绿。

## 升级

重启 DeepSeek Harness(桌面版完全退出再打开)。
