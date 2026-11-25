# dsh-test-mode v0.12.0

**安全回归支持:安全专用资产脚手架 + 软校验 + 可选版本安全门禁。**

## 新增

- **安全专用资产**:仍是 api/ui 资产,用 `security: { category, sourceAssetId }` 标记
  (无凭证/不存在ID/错误泄露/越权);`module`/`tags` 含「安全」也会被识别;
- **脚手架 `POST /api/security/scaffold`**(默认 dry-run,`apply: true` 才写):
  对选中接口资产生成安全资产(去掉认证头 → 期望 4xx;数字 id → 999999 → 4xx 非 5xx;
  错误体不含 stack/SQL/goroutine/panic;可选 `includeIdor` 生成越权模板)以及一个
  安全回归工作项(type=security, priority=high);已存在则跳过,可重复调用;
- **安全软校验**:安全资产期望 2xx、无断言、越权未配置 OTHER_ID 等会返回 `warnings`
  (不拒绝保存);资产列表/详情/执行结果都带 `securityWarnings`;
- **版本安全门禁(可选)**:`POST /api/versions { requireSecurity: true }` 要求安全类工作项
  全部 `result=passed`,否则 409 返回未通过列表;
- **断言操作符扩展**:`not_contains`、`in`、`not_in`、`matches`(regex 别名),编辑器同步;
- **界面**:接口资产详情「生成安全回归」按钮(dry-run 确认 → 写入)、安全提示横幅、
  资产树 ⚠ 标记、版本页「要求安全测试通过」开关;
- 预设/技能(`test-mode-workflow`、`security-testing-assets`)/README 同步。

## 测试

- e2e **291**(脚手架 dry-run/apply/幂等、安全 4xx 断言、not_contains/in、软校验、安全门禁);
  渲染 **83**(安全提示、脚手架确认、版本门禁开关);插件 **8**、技能 **32** 全绿。

## 升级

重启 DeepSeek Harness(桌面版完全退出再打开)。生成安全资产不会自动执行;
生成后需逐个执行验证,越权模板要配置 `OTHER_ID`。
