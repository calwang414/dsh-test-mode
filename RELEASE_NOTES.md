# dsh-test-mode v0.1.1

## 修复

- **API 详情页打不开(崩溃)**:请求的 `headers`/`query` 以对象格式(后端执行器格式)保存后,打开详情页时 KeyValueEditor 收到对象直接 `value.map` 崩溃——新增 `kvRows`(对象/数组 → 编辑行)与 `kvObj`(编辑行 → 对象)双向转换,对象格式请求正常打开、编辑后仍以对象格式保存/执行;旧数组格式数据兼容打开;
- 同源的保存路径崩溃修复:`normalizeRequest` 对对象格式 headers 不再 `.filter` 报错(执行请求/保存不再崩);
- 用例编辑器步骤「数据覆盖」的 query/headers 编辑复用同一转换,行为一致。

## 变更

- 无新增功能(0.1.1 为 bugfix 版本)。

## 安装

```
dsh plugin --profile web add ./dsh-test-mode
# 或预编译包(本 Release 资产):
dsh plugin --profile web add https://github.com/calwang414/dsh-test-mode/releases/download/v0.1.1/dsh-test-mode-0.1.1.tgz
```

v0.1.0 的完整能力清单见仓库 README。
